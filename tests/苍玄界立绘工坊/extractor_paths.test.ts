/**
 * 提取器多路径与渲染测试（自定义规则，不依赖真实 PNG 文件）。
 *
 * 覆盖：json: / chunk: 前缀、候选路径回落、[*] 通配多角色拼接、显式下标、
 * header/footer/field_template 渲染、全部未命中时的 missing 与 text。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFields,
  renderExtract,
  resolvePath,
  createDefaultExtractRule,
  type ExtractField,
  type ExtractRule,
} from '../../src/苍玄界立绘工坊/core/extractor.ts';
import type { ImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';

const META: ImageMeta = {
  format: 'novelai-v4',
  label: 'NovelAI V4',
  document: {
    v4_prompt: {
      caption: {
        char_captions: [
          { char_caption: 'girl with silver hair' },
          { char_caption: 'black cat companion' },
        ],
      },
    },
    prompt: 'floating immortal cave dwelling, full scene prompt',
    uc: 'lowres, bad hands',
    params: { steps: 28, seed: 1234567 },
    zero: 0,
    flag: false,
    blank: '   ',
    emptyString: '',
  },
  chunks: {
    Description: '块里的中文提示词',
    Empty: '   ',
    Source: 'NovelAI Diffusion V4',
  },
};

/** 构造只关心 fields 的测试规则 */
function makeRule(fields: ExtractField[], overrides: Partial<ExtractRule> = {}): ExtractRule {
  return {
    id: 'test-rule',
    name: '测试规则',
    builtin: false,
    field_template: '【{{label}}】\n{{value}}',
    header: '',
    footer: '',
    fields,
    ...overrides,
  };
}

/** 取一个字段的提取结果 */
const fieldOf = (rule: ExtractRule, meta: ImageMeta = META) => extractFields(meta, rule).fields[0];

// ============================================================
// 路径解析
// ============================================================

test('resolvePath 只认 json: 与 chunk: 前缀', () => {
  assert.equal(resolvePath(META, 'json:prompt'), 'floating immortal cave dwelling, full scene prompt');
  assert.equal(resolvePath(META, 'chunk:Description'), '块里的中文提示词');
  assert.equal(resolvePath(META, 'chunk:Source'), 'NovelAI Diffusion V4');
  // 无冒号 / 空路径 / 未知 scheme / 空前缀都取不到值
  assert.equal(resolvePath(META, 'json'), undefined);
  assert.equal(resolvePath(META, ''), undefined);
  assert.equal(resolvePath(META, 'xml:prompt'), undefined);
  assert.equal(resolvePath(META, 'json:'), undefined);
  assert.equal(resolvePath(META, 'chunk:不存在的块'), undefined);
});

// ============================================================
// 候选路径回落
// ============================================================

test('第一个候选路径不命中时回落到第二个', () => {
  const rule = makeRule([
    { id: 'cc', label: '角色DNA', enabled: true, paths: ['json:char_captions', 'json:v4_prompt.caption.char_captions[*].char_caption'] },
  ]);
  const field = fieldOf(rule);
  assert.equal(field.matchedPath, 'json:v4_prompt.caption.char_captions[*].char_caption');
  assert.equal(field.value, 'girl with silver hair, black cat companion');
});

test('第一个候选路径命中即停，不再看后续路径', () => {
  const rule = makeRule([
    { id: 'p', label: '提示词', enabled: true, paths: ['json:prompt', 'chunk:Description'] },
  ]);
  const field = fieldOf(rule);
  assert.equal(field.matchedPath, 'json:prompt');
  assert.equal(field.value, 'floating immortal cave dwelling, full scene prompt');
});

test('候选路径命中但只有空白（或空串）时继续回落', () => {
  const rule = makeRule([
    { id: 'b', label: '空白回落', enabled: true, paths: ['json:blank', 'chunk:Empty', 'chunk:Description'] },
    { id: 'e', label: '空串回落', enabled: true, paths: ['json:emptyString', 'json:uc'] },
  ]);
  const result = extractFields(META, rule);
  assert.equal(result.fields[0].matchedPath, 'chunk:Description');
  assert.equal(result.fields[0].value, '块里的中文提示词');
  assert.equal(result.fields[1].matchedPath, 'json:uc');
});

test('[*] 通配符命中多个 char_caption 时按 ", " 拼接（V4 多角色图）', () => {
  const rule = makeRule([
    { id: 'cc', label: '角色DNA', enabled: true, paths: ['json:v4_prompt.caption.char_captions[*].char_caption'] },
  ]);
  const field = fieldOf(rule);
  assert.equal(field.value, 'girl with silver hair, black cat companion');
});

test('[*] 只命中一个元素时返回原字符串而不是数组', () => {
  const single: ImageMeta = {
    ...META,
    document: { v4_prompt: { caption: { char_captions: [{ char_caption: 'solo character' }] } } },
  };
  const rule = makeRule([
    { id: 'cc', label: '角色DNA', enabled: true, paths: ['json:v4_prompt.caption.char_captions[*].char_caption'] },
  ]);
  assert.equal(fieldOf(rule, single).value, 'solo character');
});

test('显式下标路径取单个元素', () => {
  const rule = makeRule([
    { id: 'c0', label: '第一个', enabled: true, paths: ['json:v4_prompt.caption.char_captions[0].char_caption'] },
    { id: 'c1', label: '第二个', enabled: true, paths: ['json:v4_prompt.caption.char_captions[1].char_caption'] },
  ]);
  const result = extractFields(META, rule);
  assert.equal(result.fields[0].value, 'girl with silver hair');
  assert.equal(result.fields[1].value, 'black cat companion');
});

test('chunk: 前缀直接取 PNG 原始文本块', () => {
  const rule = makeRule([{ id: 'd', label: '描述块', enabled: true, paths: ['chunk:Description'] }]);
  const field = fieldOf(rule);
  assert.equal(field.matchedPath, 'chunk:Description');
  assert.equal(field.value, '块里的中文提示词');
});

test('深层路径不存在时不抛异常，标记为未命中', () => {
  const rule = makeRule([
    { id: 'deep', label: '深层', enabled: true, paths: ['json:v4_prompt.caption.不存在.更不存在', 'json:char_captions'] },
  ]);
  const field = fieldOf(rule);
  assert.equal(field.value, '');
  assert.equal(field.matchedPath, '');
});

// ============================================================
// 未命中与 missing
// ============================================================

test('全部字段未命中时 text 为空串，missing 列出所有启用字段标签', () => {
  const rule = makeRule([
    { id: 'a', label: '甲', enabled: true, paths: ['json:不存在'] },
    { id: 'b', label: '乙', enabled: true, paths: ['chunk:不存在'] },
    { id: 'c', label: '丙', enabled: true, paths: [] },
  ]);
  const result = extractFields(META, rule);
  assert.equal(result.text, '');
  assert.deepEqual(result.missing, ['甲', '乙', '丙']);
  assert.deepEqual(
    result.fields.map(field => [field.id, field.value, field.matchedPath]),
    [['a', '', ''], ['b', '', ''], ['c', '', '']],
  );
});

test('禁用的字段既不进入结果也不计入 missing', () => {
  const rule = makeRule([
    { id: 'on', label: '启用', enabled: true, paths: ['json:prompt'] },
    { id: 'off', label: '禁用', enabled: false, paths: ['json:不存在'] },
  ]);
  const result = extractFields(META, rule);
  assert.deepEqual(result.fields.map(field => field.id), ['on']);
  assert.deepEqual(result.missing, []);
});

test('数值 0 与布尔 false 视为命中', () => {
  const rule = makeRule([
    { id: 'z', label: '零', enabled: true, paths: ['json:zero'] },
    { id: 'f', label: '假', enabled: true, paths: ['json:flag'] },
  ]);
  const result = extractFields(META, rule);
  assert.equal(result.fields[0].value, '0');
  assert.equal(result.fields[0].matchedPath, 'json:zero');
  assert.equal(result.fields[1].value, 'false');
  assert.deepEqual(result.missing, []);
});

// ============================================================
// 渲染
// ============================================================

test('header / field_template / footer 按顺序用空行拼接', () => {
  const rule = makeRule(
    [
      { id: 'a', label: '甲', enabled: true, paths: ['json:prompt'] },
      { id: 'b', label: '乙', enabled: true, paths: ['json:uc'] },
    ],
    { header: '== 元数据开始 ==', footer: '== 元数据结束 ==' },
  );
  const result = extractFields(META, rule);
  assert.equal(
    result.text,
    '== 元数据开始 ==\n\n【甲】\nfloating immortal cave dwelling, full scene prompt\n\n【乙】\nlowres, bad hands\n\n== 元数据结束 ==',
  );
});

test('没有任何字段命中时，header 与 footer 也不输出', () => {
  const rule = makeRule(
    [{ id: 'a', label: '甲', enabled: true, paths: ['json:不存在'] }],
    { header: 'HEAD', footer: 'FOOT' },
  );
  const result = extractFields(META, rule);
  assert.equal(result.text, '');
});

test('header / footer 仅空白时被丢弃', () => {
  const rule = makeRule(
    [{ id: 'a', label: '甲', enabled: true, paths: ['json:prompt'] }],
    { header: '   ', footer: '\t' },
  );
  assert.equal(extractFields(META, rule).text, '【甲】\nfloating immortal cave dwelling, full scene prompt');
});

test('renderExtract 直接调用：无值字段被过滤，全空返回空串', () => {
  const rule = makeRule([], { header: 'HEAD', footer: 'FOOT' });
  assert.equal(renderExtract([], rule), '');
  assert.equal(renderExtract([{ id: 'x', label: 'X', value: '', matchedPath: '' }], rule), '');
  assert.equal(
    renderExtract([{ id: 'x', label: 'X', value: 'V', matchedPath: 'json:x' }], rule),
    'HEAD\n\n【X】\nV\n\nFOOT',
  );
});

test('字段模板支持任意占位符组合，值里的 {{label}} 字面量不会被二次替换', () => {
  const tricky: ImageMeta = {
    ...META,
    document: { ...META.document, tricky: 'has {{label}} inside' },
  };
  const rule = makeRule(
    [{ id: 't', label: 'LBL', enabled: true, paths: ['json:tricky'] }],
    { field_template: '【{{label}}】：{{value}} — {{label}}' },
  );
  const field = fieldOf(rule, tricky);
  assert.equal(field.value, 'has {{label}} inside');
  assert.equal(extractFields(tricky, rule).text, '【LBL】：has {{label}} inside — LBL');
});

test('标签文本原样保留在结果里，便于界面展示', () => {
  const rule = makeRule([{ id: 'x', label: '角色DNA（char_caption）', enabled: true, paths: ['json:prompt'] }]);
  assert.equal(fieldOf(rule).label, '角色DNA（char_caption）');
});

// ============================================================
// 默认规则
// ============================================================

test('默认规则的字段与候选路径覆盖 NovelAI / A1111 / ComfyUI 三种来源', () => {
  const rule = createDefaultExtractRule();
  const byId = Object.fromEntries(rule.fields.map(field => [field.id, field]));

  assert.deepEqual(byId['char_caption'].paths, [
    'json:char_captions',
    'json:positive_texts',
    'json:v4_prompt.caption.char_captions[*].char_caption',
  ]);
  assert.deepEqual(byId['prompt'].paths, ['json:prompt', 'chunk:Description']);
  assert.deepEqual(byId['uc'].paths, ['json:uc', 'json:negative_prompt', 'json:v4_negative_prompt.caption.base_caption']);
  assert.deepEqual(byId['base_caption'].paths, ['json:v4_prompt.caption.base_caption']);
  assert.deepEqual(byId['params'].paths, ['json:params', 'chunk:Source']);

  assert.equal(byId['base_caption'].enabled, false, 'base_caption 默认关闭');
  assert.equal(byId['params'].enabled, false, '生图参数默认关闭');
  assert.equal(rule.field_template, '【{{label}}】\n{{value}}');
  assert.equal(rule.header, '');
  assert.equal(rule.footer, '');
});

test('默认规则优先命中扁平化的 char_captions', () => {
  const flat: ImageMeta = { ...META, document: { ...META.document, char_captions: ['扁平化角色 DNA'] } };
  const field = extractFields(flat, createDefaultExtractRule()).fields.find(item => item.id === 'char_caption')!;
  assert.equal(field.matchedPath, 'json:char_captions');
  assert.equal(field.value, '扁平化角色 DNA');
});

test('默认规则在缺少 uc 时回落到 v4_negative_prompt.base_caption', () => {
  const noUc: ImageMeta = {
    ...META,
    document: { v4_negative_prompt: { caption: { base_caption: 'V4 负向基础描述' } } },
  };
  const field = extractFields(noUc, createDefaultExtractRule()).fields.find(item => item.id === 'uc')!;
  assert.equal(field.matchedPath, 'json:v4_negative_prompt.caption.base_caption');
  assert.equal(field.value, 'V4 负向基础描述');
});

test('默认规则启用 base_caption 后能取到 V4 基础描述', () => {
  const withBase: ImageMeta = {
    ...META,
    document: {
      ...META.document,
      v4_prompt: {
        caption: {
          base_caption: 'floating immortal cave dwelling, fantasy style',
          char_captions: (META.document.v4_prompt as any).caption.char_captions,
        },
      },
    },
  };
  const rule = createDefaultExtractRule();
  rule.fields.find(field => field.id === 'base_caption')!.enabled = true;
  const field = extractFields(withBase, rule).fields.find(item => item.id === 'base_caption')!;
  assert.equal(field.matchedPath, 'json:v4_prompt.caption.base_caption');
  assert.equal(field.value, 'floating immortal cave dwelling, fantasy style');
});
