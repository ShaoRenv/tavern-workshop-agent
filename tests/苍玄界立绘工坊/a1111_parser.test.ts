/**
 * A1111 (Stable Diffusion WebUI) parameters 文本块解析测试。
 *
 * 覆盖：完整 正向 + Negative prompt: + 参数行、缺负向、缺参数行、空文本、
 * 多行负向、CRLF、参数键归一化与数值转换、内嵌 JSON，以及与提取器的复用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseA1111Meta, extractEmbeddedJson } from '../../src/苍玄界立绘工坊/core/a1111_parser.ts';
import { buildImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';
import { extractFields, createDefaultExtractRule } from '../../src/苍玄界立绘工坊/core/extractor.ts';

const FULL = [
  'masterpiece, best quality, 1girl, silver hair',
  'Negative prompt: lowres, bad anatomy, bad hands',
  'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567, Size: 832x1216, Model hash: abc123, Model: animagineXL, Denoising strength: 0.7, Clip skip: 2',
].join('\n');

/** 取参数对象，避免每个测试重复断言类型 */
const paramsOf = (document: Record<string, unknown>): Record<string, unknown> =>
  document.params as Record<string, unknown>;

test('完整 parameters：正向 / 负向 / 参数行都能解析', () => {
  const meta = parseA1111Meta({ parameters: FULL });
  assert.ok(meta, '应能解析出 A1111 元数据');

  const doc = meta!.document;
  assert.equal(doc.prompt, 'masterpiece, best quality, 1girl, silver hair');
  assert.equal(doc.uc, 'lowres, bad anatomy, bad hands');
  assert.equal(doc.negative_prompt, doc.uc, 'uc 与 negative_prompt 应一致，便于跨格式复用');
  assert.equal(doc.raw_parameters, FULL, '原始文本应完整保留，便于界面回显');
});

test('参数行键名归一化（小写 + 空格转下划线）且数值被转换', () => {
  const doc = parseA1111Meta({ parameters: FULL })!.document;

  assert.deepEqual(paramsOf(doc), {
    steps: 28,
    sampler: 'DPM++ 2M Karras',
    cfg_scale: 7,
    seed: 1234567,
    size: '832x1216',
    model_hash: 'abc123',
    model: 'animagineXL',
    denoising_strength: 0.7,
    clip_skip: 2,
  });

  // 参数同时被摊平到 document 顶层，默认提取规则的 json:steps 等路径可直接命中
  assert.equal(doc.steps, 28);
  assert.equal(doc.cfg_scale, 7);
  assert.equal(doc.size, '832x1216');
});

test('负数值与带小数点数值都能正确转换', () => {
  const doc = parseA1111Meta({
    parameters: 'pos\nNegative prompt: neg\nSteps: 20, Denoising strength: -0.5, Seed: -1, CFG scale: -3',
  })!.document;
  const params = paramsOf(doc);
  assert.equal(params.seed, -1);
  assert.equal(params.denoising_strength, -0.5);
  assert.equal(params.cfg_scale, -3);
});

test('多行负向提示词整体拼接，不丢失行', () => {
  const doc = parseA1111Meta({
    parameters: 'pos line 1\npos line 2\nNegative prompt: neg line 1\nneg line 2\nSteps: 30, Sampler: Euler a',
  })!.document;
  assert.equal(doc.prompt, 'pos line 1\npos line 2');
  assert.equal(doc.uc, 'neg line 1\nneg line 2');
  assert.equal(paramsOf(doc).steps, 30);
});

test('只有正向、没有负向：uc 为空串而不是 undefined', () => {
  const meta = parseA1111Meta({ parameters: 'masterpiece, 1girl' });
  assert.ok(meta);
  const doc = meta!.document;
  assert.equal(doc.prompt, 'masterpiece, 1girl');
  assert.equal(doc.uc, '');
  assert.equal(doc.negative_prompt, '');
  assert.deepEqual(paramsOf(doc), {});
});

test('参数行缺失：仍能解析出提示词，params 为空对象', () => {
  const doc = parseA1111Meta({ parameters: 'pos\nNegative prompt: neg' })!.document;
  assert.equal(doc.prompt, 'pos');
  assert.equal(doc.uc, 'neg');
  assert.deepEqual(paramsOf(doc), {});
});

test('空文本 / 纯空白 / 缺少 parameters 块都返回 null', () => {
  assert.equal(parseA1111Meta({ parameters: '' }), null);
  assert.equal(parseA1111Meta({ parameters: '   ' }), null);
  assert.equal(parseA1111Meta({ parameters: '\n\t\n' }), null);
  assert.equal(parseA1111Meta({}), null);
  assert.equal(parseA1111Meta({ Comment: '{"uc":"x"}' }), null);
});

test('只有参数行、没有任何提示词时返回 null', () => {
  assert.equal(parseA1111Meta({ parameters: 'Steps: 20, Sampler: Euler a' }), null);
});

test('只有负向提示词时返回文档，prompt 为空串', () => {
  const meta = parseA1111Meta({ parameters: 'Negative prompt: bad hands' });
  assert.ok(meta, '有负向内容时不应判为无法解析');
  assert.equal(meta!.document.prompt, '');
  assert.equal(meta!.document.uc, 'bad hands');
});

test('CRLF 换行同样能解析', () => {
  const doc = parseA1111Meta({
    parameters: 'pos\r\nNegative prompt: neg\r\nSteps: 1, Sampler: Euler a',
  })!.document;
  assert.equal(doc.prompt, 'pos');
  assert.equal(doc.uc, 'neg');
  assert.equal(paramsOf(doc).steps, 1);
  assert.equal(paramsOf(doc).sampler, 'Euler a');
});

test('提示词正文里的 “Steps: 5” 不会被误判成参数行', () => {
  const doc = parseA1111Meta({
    parameters: 'a picture with Steps: 5 written on it\nNegative prompt: n',
  })!.document;
  assert.deepEqual(paramsOf(doc), {}, '参数行必须行首匹配');
  assert.equal(doc.prompt, 'a picture with Steps: 5 written on it');
});

test('小写 negative prompt: 同样被识别为负向段（大小写不敏感）', () => {
  // 回归：早期实现区分大小写，小写形态会被当成正文并污染正向提示词
  const doc = parseA1111Meta({
    parameters: 'pos\nnegative prompt: bad\nSteps: 1, Sampler: x',
  })!.document;
  assert.equal(doc.uc, 'bad');
  assert.equal(doc.prompt, 'pos');
});

test('参数行不必以 Steps: 开头也能被识别', () => {
  // 回归：早期实现要求行首为 Steps:，否则参数行会被并进负向段
  const doc = parseA1111Meta({
    parameters: 'a cat\nNegative prompt: blurry\nSampler: Euler a, Steps: 20',
  })!.document;
  assert.equal(doc.uc, 'blurry');
  assert.equal(paramsOf(doc).sampler, 'Euler a');
  assert.equal(paramsOf(doc).steps, 20);
});

test('参数值内含引号与逗号时不会被切碎（Lora hashes）', () => {
  // 回归：早期用前瞻正则切分，会把 "a: 1, b: 2" 切成两个字段
  const doc = parseA1111Meta({
    parameters: 'a cat\nNegative prompt: x\nSteps: 20, Lora hashes: "lora_a: 11ab, lora_b: 22cd", Model: sd_xl',
  })!.document;
  const params = paramsOf(doc);
  assert.equal(params.lora_hashes, '"lora_a: 11ab, lora_b: 22cd"');
  assert.equal(params.model, 'sd_xl');
});

test('参数行里的同名键不会覆盖提示词正文', () => {
  const doc = parseA1111Meta({
    parameters: 'a cat\nNegative prompt: b\nSteps: 20, Prompt: evil',
  })!.document;
  assert.equal(doc.prompt, 'a cat');
});

test('参数行之后的尾部内容不进入提示词（A1111 中参数行恒为末行）', () => {
  const doc = parseA1111Meta({
    parameters: 'pos\nNegative prompt: neg\nSteps: 20, Sampler: Euler a\ntrailing note',
  })!.document;
  assert.equal(doc.prompt, 'pos');
  assert.equal(doc.uc, 'neg');
  assert.equal(paramsOf(doc).steps, 20);
});

test('extractEmbeddedJson 能取出内嵌 JSON', () => {
  assert.deepEqual(extractEmbeddedJson('pos, blah {"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
  assert.equal(extractEmbeddedJson('完全没有 JSON'), null);
  assert.equal(extractEmbeddedJson('{坏 JSON}'), null, '坏 JSON 应返回 null 而不是抛异常');
  // 回归：早期用贪婪正则，参数里有多个花括号组时整体失败
  assert.deepEqual(extractEmbeddedJson('steps: 20 {"a": 1} then {"b": 2}'), { b: 2 }, '应取最后一个可用组');
});

test('A1111 元数据经 buildImageMeta 后可被默认提取规则复用', () => {
  const meta = buildImageMeta([{ type: 'tEXt', keyword: 'parameters', text: FULL }]);
  assert.equal(meta.format, 'a1111');
  assert.equal(meta.label, 'Stable Diffusion WebUI (A1111)');

  const result = extractFields(meta, createDefaultExtractRule());
  const byId = Object.fromEntries(result.fields.map(field => [field.id, field]));
  assert.equal(byId['prompt'].value, 'masterpiece, best quality, 1girl, silver hair');
  assert.equal(byId['prompt'].matchedPath, 'json:prompt');
  assert.equal(byId['uc'].value, 'lowres, bad anatomy, bad hands');
  assert.equal(byId['uc'].matchedPath, 'json:uc');
  // A1111 没有角色 DNA 概念，应优雅降级为 missing
  assert.deepEqual(result.missing, ['角色DNA（char_caption）']);
});

test('启用「生图参数」字段后可从 A1111 的 json:params 命中', () => {
  const meta = buildImageMeta([{ type: 'tEXt', keyword: 'parameters', text: FULL }]);
  const rule = createDefaultExtractRule();
  rule.fields.find(field => field.id === 'params')!.enabled = true;

  const field = extractFields(meta, rule).fields.find(item => item.id === 'params')!;
  assert.equal(field.matchedPath, 'json:params');
  assert.match(field.value, /"steps":28/);
  assert.match(field.value, /"sampler":"DPM\+\+ 2M Karras"/);
});
