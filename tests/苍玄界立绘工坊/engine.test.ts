/**
 * LLM 引擎测试 —— 注入假的生成函数，因此完全不烧 token，也不需要真实模型。
 *
 * 覆盖：分批、重试、整批失败后降级为逐角色、断点续跑、中止、世界书的文本与 JSON 两种产出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkRoles,
  buildPortraitUserInput,
  runPortraitBatches,
  buildWorldbookUserInput,
  extractWorldbookText,
  runWorldbookBatches,
  type GenerateRequest,
  type JobRole,
} from '../../src/苍玄界立绘工坊/llm/engine.ts';
import { createBuiltinTemplates, createBuiltinLlmPresets, createBuiltinWorldbookPresets } from '../../src/苍玄界立绘工坊/llm/presets_builtin.ts';

const zhiTemplate = createBuiltinTemplates().find(t => t.target === 'zhihatsuki')!;
const zhiPreset = createBuiltinLlmPresets().find(p => p.target === 'zhihatsuki')!;
const xiaoTemplate = createBuiltinTemplates().find(t => t.target === 'xiaobaix')!;
const xiaoPreset = createBuiltinLlmPresets().find(p => p.target === 'xiaobaix')!;
const wbPreset = createBuiltinWorldbookPresets()[0];

// 注意：metaText 刻意不含【】，否则会让 namesIn 重复计数（那只是测试助手的问题）
const role = (name: string): JobRole => ({ name, metaText: '角色DNA: ' + name + ' black hair', imageUrl: 'https://x/' + name + '.png' });

/** 从 user_input 里解析出本批角色名 */
function namesIn(request: GenerateRequest): string[] {
  return [...request.userInput.matchAll(/===== 角色：(.+?) =====/g)].map(m => m[1]);
}

/** 假生成器：为请求中的每个角色返回一条智绘姬格式的角色 */
function fakeZhiGenerate(): (request: GenerateRequest) => Promise<string> {
  return async request => {
    const characters: Record<string, unknown> = {};
    for (const name of namesIn(request)) {
      characters['[苍玄界]' + name] = { nameCN: name, nameEN: 'pinyin ' + name, appearance: 'ok' };
    }
    return JSON.stringify({ characters, outfits: {} });
  };
}

test('chunkRoles 按批大小切分', () => {
  const roles = ['a', 'b', 'c', 'd', 'e'].map(role);
  assert.deepEqual(chunkRoles(roles, 2).map(b => b.length), [2, 2, 1]);
  assert.deepEqual(chunkRoles(roles, 10).map(b => b.length), [5]);
  assert.deepEqual(chunkRoles([], 3), []);
  assert.deepEqual(chunkRoles(roles, 0).map(b => b.length), [1, 1, 1, 1, 1], '批大小非法时退化为逐个');
});

test('buildPortraitUserInput 含指令、格式说明、模板与待处理角色', () => {
  const input = buildPortraitUserInput([role('江念')], zhiPreset, zhiTemplate);
  assert.ok(input.includes(zhiPreset.instruction));
  assert.ok(input.includes(zhiTemplate.schema_note));
  assert.ok(input.includes(zhiTemplate.skeleton));
  assert.ok(input.includes('===== 角色：江念 ====='));
  assert.ok(input.includes('black hair'));
});

test('分批跑通并把结果合并进文档', async () => {
  const preset = { ...zhiPreset, batch_size: 2, max_retries: 0 };
  const progress: number[] = [];
  const result = await runPortraitBatches({
    roles: ['甲', '乙', '丙'].map(role),
    preset,
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: { characters: {}, outfits: {} },
    generate: fakeZhiGenerate(),
    onProgress: p => progress.push(p.completed),
  });

  assert.equal(result.batchCount, 2);
  assert.deepEqual(result.added.sort(), ['丙', '乙', '甲'].sort());
  assert.equal(result.failures.length, 0);
  assert.equal(Object.keys((result.document.characters as any)).length, 3);
  assert.deepEqual(progress, [2, 3], '进度应逐批上报');
  assert.equal(result.aborted, false);
});

test('重试：前两次失败，第三次成功', async () => {
  let calls = 0;
  const generate = async (request: GenerateRequest) => {
    calls += 1;
    if (calls < 3) throw new Error('模拟网络抖动');
    return fakeZhiGenerate()(request);
  };

  const result = await runPortraitBatches({
    roles: [role('江念')],
    preset: { ...zhiPreset, batch_size: 1, max_retries: 2 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: {},
    generate,
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.added, ['江念']);
  assert.equal(result.failures.length, 0);
});

test('产出不是合法 JSON 时会重试，最终记录失败而不是崩溃', async () => {
  let calls = 0;
  const result = await runPortraitBatches({
    roles: [role('坏角色')],
    preset: { ...zhiPreset, batch_size: 1, max_retries: 1 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: {},
    generate: async () => {
      calls += 1;
      return '完全不是 JSON 的回复';
    },
  });

  assert.equal(calls, 2, '应尝试 max_retries + 1 次');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, '坏角色');
  assert.deepEqual(result.added, []);
});

test('整批失败时降级为逐角色处理，好角色仍能保存', async () => {
  // 首批（含两个角色）始终失败；单角色请求才成功 → 验证降级逻辑
  const generate = async (request: GenerateRequest) => {
    const names = namesIn(request);
    if (names.length > 1) throw new Error('批次过大');
    return fakeZhiGenerate()(request);
  };

  const result = await runPortraitBatches({
    roles: [role('甲'), role('乙')],
    preset: { ...zhiPreset, batch_size: 2, max_retries: 0 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: {},
    generate,
  });

  assert.deepEqual([...result.added].sort(), ['甲', '乙'].sort());
  assert.equal(result.failures.length, 0);
  assert.ok(result.logs.some(l => l.includes('降级为逐角色')));
});

test('断点续跑：skipNames 中的角色不重复处理', async () => {
  const seen: string[] = [];
  const generate = async (request: GenerateRequest) => {
    seen.push(...namesIn(request));
    return fakeZhiGenerate()(request);
  };

  const result = await runPortraitBatches({
    roles: ['甲', '乙', '丙'].map(role),
    preset: { ...zhiPreset, batch_size: 5, max_retries: 0 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: {},
    generate,
    skipNames: ['乙'],
  });

  assert.deepEqual(seen.sort(), ['丙', '甲'].sort());
  assert.deepEqual(result.added.sort(), ['丙', '甲'].sort());
});

test('中止信号能提前结束且不抛异常', async () => {
  const signal = { aborted: false };
  const generate = async (request: GenerateRequest) => {
    signal.aborted = true; // 第一批之后就中止
    return fakeZhiGenerate()(request);
  };

  const result = await runPortraitBatches({
    roles: ['甲', '乙', '丙', '丁'].map(role),
    preset: { ...zhiPreset, batch_size: 1, max_retries: 0 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: {},
    generate,
    signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.batchCount, 1);
});

test('小白x 目标格式：新增角色带自动 id', async () => {
  const generate = async (request: GenerateRequest) => {
    const characters = namesIn(request).map(name => ({ id: '', name, type: 'girl', appearance: 'x', outfits: [] }));
    return JSON.stringify({ characters });
  };

  const result = await runPortraitBatches({
    roles: [role('沈慕微')],
    preset: { ...xiaoPreset, batch_size: 1, max_retries: 0 },
    template: xiaoTemplate,
    target: 'xiaobaix',
    existingDocument: {},
    generate,
  });

  const characters = result.document.characters as any[];
  assert.equal(characters.length, 1);
  assert.match(characters[0].id, /^char-\d+-[a-z0-9]+$/);
});

test('世界书：文本模式逐批拼接', async () => {
  const generate = async (request: GenerateRequest) =>
    namesIn(request).map(name => '**' + name + '**｜某势力弟子。女，18岁，炼气三层。').join('\n');

  const result = await runWorldbookBatches({
    characters: [{ name: '甲', content: '设定甲' }, { name: '乙', content: '设定乙' }, { name: '丙', content: '设定丙' }],
    preset: { ...wbPreset, batch_size: 2, max_retries: 0 },
    generate,
  });

  assert.equal(result.batchCount, 2);
  assert.ok(result.text.includes('**甲**'));
  assert.ok(result.text.includes('**丙**'));
  assert.deepEqual(result.completedNames, ['甲', '乙', '丙']);
  assert.equal(result.failures.length, 0);
});

test('世界书：JSON 模式按路径取文本', async () => {
  const generate = async () => JSON.stringify({ result: '甲：说明文字' });
  const result = await runWorldbookBatches({
    characters: [{ name: '甲', content: 'x' }],
    preset: {
      ...wbPreset,
      output_mode: 'json',
      output_json_path: 'result',
      reply_extract: { ...wbPreset.reply_extract, mode: 'whole' },
      batch_size: 1,
    },
    generate,
  });
  assert.equal(result.text, '甲：说明文字');
});

test('世界书：失败批次被记录，且断点续跑不重复处理', async () => {
  let failFirst = true;
  const generate = async (request: GenerateRequest) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('失败');
    }
    return namesIn(request).join('、');
  };

  const failed = await runWorldbookBatches({
    characters: [{ name: '甲', content: 'x' }],
    preset: { ...wbPreset, batch_size: 1, max_retries: 0 },
    generate,
  });
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.failures[0].name, '甲');

  const resumed = await runWorldbookBatches({
    characters: [{ name: '甲', content: 'x' }, { name: '乙', content: 'y' }],
    preset: { ...wbPreset, batch_size: 1, max_retries: 0 },
    generate,
    skipNames: ['甲'],
    initialText: '**甲**｜已有内容',
  });
  assert.ok(resumed.text.startsWith('**甲**｜已有内容'), '应保留此前的产出');
  assert.ok(resumed.text.includes('乙'));
  assert.deepEqual(resumed.completedNames, ['乙']);
});

test('buildWorldbookUserInput 含格式规范与容错说明', () => {
  const input = buildWorldbookUserInput([{ name: '甲', content: '设定' }], wbPreset);
  assert.ok(input.includes(wbPreset.field_spec));
  assert.ok(input.includes(wbPreset.tolerance_note));
  assert.ok(input.includes('===== 角色：甲 ====='));
});

test('extractWorldbookText 文本模式下原样返回', () => {
  assert.equal(extractWorldbookText('  **甲**｜内容  ', wbPreset), '**甲**｜内容');
});