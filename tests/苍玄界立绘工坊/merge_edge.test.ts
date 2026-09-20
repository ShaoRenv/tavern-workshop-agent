/**
 * 合并边界测试 —— 智绘姬数组/对象表容错、自定义 key_prefix、
 * outfits 与角色的策略独立性、小白x 的 id 生成与重名处理。
 *
 * 注意：小白x 的 id 生成依赖注入的 random()，这里统一使用递增序列，
 * 避免随机函数恒定导致的 id 反复冲突（该风险见报告）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeCharacterDocuments,
  createEmptyDocument,
  nextAvailableKey,
} from '../../src/苍玄界立绘工坊/core/merge.ts';

/** 递增随机串：保证每次生成的 id 都不同，避免死循环 */
const seqRandom = (prefix = 'r'): (() => string) => {
  let index = 0;
  return () => prefix + index++;
};

// ============================================================
// 智绘姬
// ============================================================

test('智绘姬：characters 传数组时按 name / nameCN 取名，绝不用数组下标', () => {
  // 回归：数组模式下 keyHint 是 "0"/"1"，早期实现把它当角色名，产出 [苍玄界]0、[苍玄界]1
  const outcome = mergeCharacterDocuments(
    createEmptyDocument('zhihatsuki'),
    { characters: [{ name: '甲' }, { nameCN: '乙' }] },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(outcome.document.characters as object), ['[苍玄界]甲', '[苍玄界]乙']);
  assert.deepEqual(outcome.added, ['甲', '乙']);
});

test('智绘姬：数组条目既无 name 也无 nameCN 时才跳过并给出 warning', () => {
  const outcome = mergeCharacterDocuments(
    createEmptyDocument('zhihatsuki'),
    { characters: [{ prompt: 'x' }] },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(outcome.added, []);
  assert.ok(outcome.warnings.some(w => w.includes('缺少可用名称')));
});

test('智绘姬：不裹 characters 而直接传对象表也能合并', () => {
  const outcome = mergeCharacterDocuments(
    { characters: {}, outfits: {} },
    { 甲: { nameCN: '甲' } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.ok('[苍玄界]甲' in (outcome.document.characters as object));
  assert.deepEqual(outcome.added, ['甲']);
});

test('智绘姬：键去掉前缀后为空时回退到 nameCN', () => {
  const outcome = mergeCharacterDocuments(
    { characters: {}, outfits: {} },
    { characters: { '[苍玄界]': { nameCN: '无名' } } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(outcome.document.characters as object), ['[苍玄界]无名']);
  assert.deepEqual(outcome.added, ['无名']);
});

test('智绘姬：传入键带 (2) 这类序号后缀时归一化掉后缀', () => {
  const outcome = mergeCharacterDocuments(
    { characters: {}, outfits: {} },
    { characters: { '乙(3)': { nameCN: '乙' } } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(outcome.document.characters as object), ['[苍玄界]乙']);
  assert.deepEqual(outcome.added, ['乙']);
});

test('智绘姬：自定义 key_prefix 同时作用于角色键与服装键', () => {
  const outcome = mergeCharacterDocuments(
    { characters: { '[测试]甲': { nameCN: '甲', from: 'existing' } }, outfits: {} },
    {
      characters: { 甲: { nameCN: '甲', from: 'incoming' }, 乙: { nameCN: '乙' } },
      outfits: { 衣: { nameCN: '衣' } },
    },
    { target: 'zhihatsuki', conflict: 'overwrite', key_prefix: '[测试]' },
  );
  const characters = outcome.document.characters as Record<string, { from?: string }>;
  assert.equal(characters['[测试]甲'].from, 'incoming', '自定义前缀下应识别为同名冲突并覆盖');
  assert.ok('[测试]乙' in characters);
  assert.deepEqual(outcome.updated, ['甲']);
  assert.deepEqual(outcome.added, ['乙']);
  assert.ok('[测试]衣' in (outcome.document.outfits as object), '服装键也应使用自定义前缀');
});

test('智绘姬：outfits 传数组时按 nameCN / name 建立键', () => {
  const outcome = mergeCharacterDocuments(
    { characters: {}, outfits: {} },
    { characters: {}, outfits: [{ nameCN: '衣一', owner: 'a' }, { name: '衣二' }, '坏数据', null] },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(outcome.document.outfits as object), ['[苍玄界]衣一', '[苍玄界]衣二']);
});

test('智绘姬：rename 只改角色键，服装按覆盖处理（两者策略独立）', () => {
  const outcome = mergeCharacterDocuments(
    { characters: { '[苍玄界]江念': { id: 'c1' } }, outfits: { '[苍玄界]旧衣': { owner: 'old' } } },
    { characters: { 江念: { id: 'c2' } }, outfits: { 旧衣: { owner: 'new' }, 新衣: { owner: 'n' } } },
    { target: 'zhihatsuki', conflict: 'rename' },
  );
  const characters = outcome.document.characters as Record<string, unknown>;
  assert.deepEqual(Object.keys(characters), ['[苍玄界]江念', '[苍玄界]江念(2)']);
  assert.deepEqual(outcome.renamed, [{ from: '[苍玄界]江念', to: '[苍玄界]江念(2)' }]);

  const outfits = outcome.document.outfits as Record<string, { owner: string }>;
  assert.equal(outfits['[苍玄界]旧衣'].owner, 'new', '服装不参与改名，走覆盖');
  assert.ok('[苍玄界]新衣' in outfits);
  assert.deepEqual(outcome.warnings, []);
});

test('智绘姬：skip 时角色与服装都跳过，服装跳过会记录 warning', () => {
  const outcome = mergeCharacterDocuments(
    { characters: { '[苍玄界]江念': { v: 'old' } }, outfits: { '[苍玄界]旧衣': { owner: 'old' } } },
    { characters: { 江念: { v: 'new' } }, outfits: { 旧衣: { owner: 'new' } } },
    { target: 'zhihatsuki', conflict: 'skip' },
  );
  assert.deepEqual(outcome.skipped, ['江念']);
  assert.equal((outcome.document.characters as Record<string, { v: string }>)['[苍玄界]江念'].v, 'old');
  assert.equal((outcome.document.outfits as Record<string, { owner: string }>)['[苍玄界]旧衣'].owner, 'old');
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /服装已存在/);
});

test('智绘姬：同一次产出里的非对象条目跳过并记录 warning', () => {
  const outcome = mergeCharacterDocuments(
    { characters: {}, outfits: {} },
    { characters: { 甲: 5, 乙: { nameCN: '乙' } } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(outcome.document.characters as object), ['[苍玄界]乙']);
  assert.ok(outcome.warnings.some(warning => warning.includes('跳过非对象角色条目')));
});

// ============================================================
// 小白x
// ============================================================

test('小白x：characters 传对象表时按 name 取值，忽略外层键', () => {
  const outcome = mergeCharacterDocuments(
    { type: 'novel-draw-characters', version: 3, characters: [] },
    { characters: { 任意的键: { name: '甲' }, 另一个键: { name: '乙' } } },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  assert.deepEqual((outcome.document.characters as Array<{ name: string }>).map(item => item.name), ['甲', '乙']);
  assert.deepEqual(outcome.added, ['甲', '乙']);
});

test('小白x：不裹 characters 而直接传顶层数组也能合并', () => {
  const outcome = mergeCharacterDocuments(
    { characters: [] },
    [{ name: '甲' }],
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  assert.deepEqual((outcome.document.characters as Array<{ name: string }>).map(item => item.name), ['甲']);
});

test('小白x：缺少 name / 非对象条目都给出 warning 并跳过', () => {
  const outcome = mergeCharacterDocuments(
    { characters: [] },
    { characters: [{ name: '  ' }, { nameCN: '只有中文名' }, '字符串', 42, { name: '合法' }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  assert.deepEqual(outcome.added, ['合法']);
  assert.equal(outcome.warnings.length, 4);
  assert.ok(outcome.warnings.some(warning => warning.includes('缺少 name')));
  assert.ok(outcome.warnings.some(warning => warning.includes('跳过非对象角色条目')));
});

test('小白x：已有 id 且不冲突时原样保留', () => {
  const outcome = mergeCharacterDocuments(
    { characters: [] },
    { characters: [{ id: 'char-fixed-1', name: '甲' }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  assert.equal((outcome.document.characters as Array<{ id: string }>)[0].id, 'char-fixed-1');
});

test('小白x：id 缺失或非字符串时重新生成，且不与既有 id 冲突', () => {
  const outcome = mergeCharacterDocuments(
    { type: 'novel-draw-characters', version: 3, characters: [{ id: 'char-1-r0', name: '占位' }] },
    { characters: [{ name: '甲' }, { id: 42, name: '乙' }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  const characters = outcome.document.characters as Array<{ id: string; name: string }>;
  assert.equal(characters.length, 3);
  for (const item of characters.filter(entry => entry.name !== '占位')) {
    assert.match(item.id, /^char-1-r[0-9]+$/);
  }
  assert.equal(new Set(characters.map(item => item.id)).size, characters.length);
});

test('小白x：rename 时跳过已占用的序号', () => {
  const outcome = mergeCharacterDocuments(
    { characters: [{ id: '1', name: '甲' }, { id: '2', name: '甲(2)' }] },
    { characters: [{ name: '甲' }] },
    { target: 'xiaobaix', conflict: 'rename', now: () => 1, random: seqRandom() },
  );
  assert.deepEqual((outcome.document.characters as Array<{ name: string }>).map(item => item.name), ['甲', '甲(2)', '甲(3)']);
  assert.deepEqual(outcome.renamed, [{ from: '甲', to: '甲(3)' }]);
  assert.deepEqual(outcome.added, ['甲(3)']);
});

test('小白x：skip 时保留原条目并计入 skipped', () => {
  const outcome = mergeCharacterDocuments(
    { type: 'novel-draw-characters', version: 3, characters: [{ id: 'k', name: '甲', v: 1 }] },
    { characters: { a: { name: '甲', v: 2 }, b: { name: '乙' } } },
    { target: 'xiaobaix', conflict: 'skip', now: () => 1, random: seqRandom() },
  );
  const characters = outcome.document.characters as Array<{ name: string; v?: number }>;
  assert.equal(characters.length, 2);
  assert.equal(characters[0].v, 1);
  assert.deepEqual(outcome.skipped, ['甲']);
  assert.deepEqual(outcome.added, ['乙']);
});

test('小白x：同一次产出里的重复角色名会先去重，只登记一次且不重复计数', () => {
  // 回归：早期实现会先 push 后 push，产出 2 条、added 与 updated 同时记录同一个名字，
  // 导致界面汇总出现"新增 2、覆盖 1"这种与实际不符的数字。
  const outcome = mergeCharacterDocuments(
    { characters: [] },
    { characters: [{ id: 'x', name: '甲', v: 1 }, { id: 'y', name: '甲', v: 2 }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  const characters = outcome.document.characters as Array<{ id: string; v: number }>;
  assert.equal(characters.length, 1, '重复角色应只产出 1 条');
  assert.equal(characters[0].v, 2, '以后一条为准');
  assert.deepEqual(outcome.added, ['甲']);
  assert.deepEqual(outcome.updated, [], '不应同时记成新增与覆盖');
  assert.ok(outcome.warnings.some(w => w.includes('重复角色')));
});

test('小白x：rename 后同一批内不会自增出重复名字', () => {
  const outcome = mergeCharacterDocuments(
    { characters: [] },
    { characters: [{ name: '甲' }, { name: '甲' }] },
    { target: 'xiaobaix', conflict: 'rename', now: () => 1, random: seqRandom() },
  );
  assert.deepEqual((outcome.document.characters as Array<{ name: string }>).map(item => item.name), ['甲']);
  assert.deepEqual(outcome.renamed, []);
  assert.deepEqual(outcome.added, ['甲']);
});

// ============================================================
// 骨架与容错
// ============================================================

test('合并结果保留无关顶层字段，小白x 的 type/version 被强制为插件格式', () => {
  const zhi = mergeCharacterDocuments(
    { title: 'T', characters: {}, outfits: {}, extra: 1 },
    { characters: { 甲: {} } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );
  assert.deepEqual(Object.keys(zhi.document).sort(), ['characters', 'extra', 'outfits', 'title']);

  const xiao = mergeCharacterDocuments(
    { title: 'T', type: 'old', version: 1, characters: [] },
    { characters: [{ name: '甲' }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: seqRandom() },
  );
  assert.equal(xiao.document.type, 'novel-draw-characters');
  assert.equal(xiao.document.version, 3);
  assert.equal(xiao.document.title, 'T');
});

test('existing 非对象（null / undefined / 字符串 / 数字 / 布尔）时自动建骨架', () => {
  for (const bad of [null, undefined, 'x', 42, true]) {
    const zhi = mergeCharacterDocuments(bad, { characters: { 甲: {} } }, { target: 'zhihatsuki', conflict: 'overwrite' });
    assert.deepEqual(Object.keys(zhi.document).sort(), ['characters', 'outfits']);

    const xiao = mergeCharacterDocuments(bad, { characters: [{ name: '乙' }] }, {
      target: 'xiaobaix',
      conflict: 'overwrite',
      now: () => 1,
      random: seqRandom(),
    });
    assert.equal(xiao.document.type, 'novel-draw-characters');
    assert.equal((xiao.document.characters as unknown[]).length, 1);
  }
});

test('characters 为 null / 标量时给出 warning 而不是抛异常', () => {
  for (const bad of [null, 42, 'x']) {
    const outcome = mergeCharacterDocuments(createEmptyDocument('zhihatsuki'), { characters: bad }, {
      target: 'zhihatsuki',
      conflict: 'overwrite',
    });
    assert.deepEqual(outcome.added, []);
    assert.ok(outcome.warnings.some(warning => warning.includes('未能从产出中识别出 characters 结构')));
  }
});

test('合并不会修改传入的 existing / incoming 对象', () => {
  const existing = { characters: { '[苍玄界]甲': { v: 1 } }, outfits: { '[苍玄界]衣': { owner: 'a' } } };
  const incoming = { characters: { 甲: { v: 2 } }, outfits: { 衣: { owner: 'b' } } };
  const existingSnapshot = JSON.stringify(existing);
  const incomingSnapshot = JSON.stringify(incoming);

  mergeCharacterDocuments(existing, incoming, { target: 'zhihatsuki', conflict: 'overwrite' });

  assert.equal(JSON.stringify(existing), existingSnapshot);
  assert.equal(JSON.stringify(incoming), incomingSnapshot);
});

test('createEmptyDocument 给出两种插件的骨架', () => {
  assert.deepEqual(createEmptyDocument('zhihatsuki'), { characters: {}, outfits: {} });
  assert.deepEqual(createEmptyDocument('xiaobaix'), { type: 'novel-draw-characters', version: 3, characters: [] });
});

test('nextAvailableKey 在序号耗尽后回退到时间戳形态且不冲突', () => {
  const taken = new Set(['a']);
  for (let index = 2; index < 1000; index++) taken.add('a(' + index + ')');

  const key = nextAvailableKey('a', taken);
  assert.match(key, /^a\([0-9]+\)$/);
  assert.equal(taken.has(key), false);
  assert.notEqual(key, 'a(2)');
});
