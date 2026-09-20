/**
 * 合并测试 —— 使用两个绘图插件的真实导出文件作为既有文档基准。
 *
 * 验证：智绘姬的对象表结构、小白x 的数组结构与 id 生成、三种冲突策略、以及容错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mergeCharacterDocuments,
  createEmptyDocument,
  nextAvailableKey,
} from '../../src/苍玄界立绘工坊/core/merge.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));

const ZHIHATSUKI_FIXTURE = 'st-chatu8-角色-全部.json';
const XIAOBAIX_FIXTURE = '小白x角色提示词.json';

test('两个真实 fixture 的结构符合预期', () => {
  const zhi = readFixture(ZHIHATSUKI_FIXTURE);
  assert.ok(zhi.characters && zhi.outfits, '智绘姬应有 characters 与 outfits 两个对象表');
  assert.ok(Object.keys(zhi.characters).length >= 4);

  const xiao = readFixture(XIAOBAIX_FIXTURE);
  assert.equal(xiao.type, 'novel-draw-characters');
  assert.equal(xiao.version, 3);
  assert.ok(Array.isArray(xiao.characters));
  assert.ok(xiao.characters.length >= 170);
});

test('智绘姬：合并进真实文档时保留既有角色并新增', () => {
  const existing = readFixture(ZHIHATSUKI_FIXTURE);
  const beforeCount = Object.keys(existing.characters).length;

  const outcome = mergeCharacterDocuments(
    existing,
    { characters: { 新角色甲: { nameCN: '新角色甲', nameEN: 'xin jiao se jia' } } },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );

  const characters = outcome.document.characters as Record<string, unknown>;
  assert.equal(Object.keys(characters).length, beforeCount + 1);
  assert.ok('[苍玄界]新角色甲' in characters, '应按前缀生成键');
  assert.deepEqual(outcome.added, ['新角色甲']);
  assert.ok(Object.keys(existing.characters).length === beforeCount, '不应修改传入的原对象');
});

test('智绘姬：outfits 独立表按 owner 关联合并', () => {
  const outcome = mergeCharacterDocuments(
    createEmptyDocument('zhihatsuki'),
    {
      characters: { 潮听澜: { nameCN: '朝听澜', nameEN: 'chao tinglan', outfits: ['[苍玄界]海潮轻甲短打套装'] } },
      outfits: { 海潮轻甲短打套装: { nameCN: '海潮轻甲短打套装', owner: 'chao tinglan' } },
    },
    { target: 'zhihatsuki', conflict: 'overwrite' },
  );

  const outfits = outcome.document.outfits as Record<string, any>;
  assert.ok('[苍玄界]海潮轻甲短打套装' in outfits);
  assert.equal(outfits['[苍玄界]海潮轻甲短打套装'].owner, 'chao tinglan');
});

test('智绘姬：三种冲突策略行为正确', () => {
  const existing = { characters: { '[苍玄界]江念': { nameCN: '江念', nameEN: 'old' } }, outfits: {} };
  const incoming = { characters: { 江念: { nameCN: '江念', nameEN: 'new' } } };

  const overwrite = mergeCharacterDocuments(existing, incoming, { target: 'zhihatsuki', conflict: 'overwrite' });
  assert.equal((overwrite.document.characters as any)['[苍玄界]江念'].nameEN, 'new');
  assert.deepEqual(overwrite.updated, ['江念']);
  assert.deepEqual(overwrite.added, []);

  const skip = mergeCharacterDocuments(existing, incoming, { target: 'zhihatsuki', conflict: 'skip' });
  assert.equal((skip.document.characters as any)['[苍玄界]江念'].nameEN, 'old');
  assert.deepEqual(skip.skipped, ['江念']);

  const rename = mergeCharacterDocuments(existing, incoming, { target: 'zhihatsuki', conflict: 'rename' });
  assert.ok('[苍玄界]江念(2)' in (rename.document.characters as any));
  assert.deepEqual(rename.renamed, [{ from: '[苍玄界]江念', to: '[苍玄界]江念(2)' }]);
});

test('小白x：合并进真实文档时为新增角色自动生成 id 且不入侵既有 id', () => {
  const existing = readFixture(XIAOBAIX_FIXTURE);
  const beforeIds = new Set(existing.characters.map((item: any) => item.id));

  const outcome = mergeCharacterDocuments(
    existing,
    { characters: [{ name: '新角色乙', type: 'girl', appearance: 'black hair', outfits: [] }] },
    {
      target: 'xiaobaix',
      conflict: 'overwrite',
      now: () => 1700000000000,
      random: () => 'abcd',
    },
  );

  const characters = outcome.document.characters as any[];
  assert.equal(characters.length, existing.characters.length + 1);

  const created = characters.find(item => item.name === '新角色乙');
  assert.equal(created.id, 'char-1700000000000-abcd');
  assert.match(created.id, /^char-\d+-[a-z0-9]+$/);
  assert.equal(beforeIds.has(created.id), false, '不得与既有 id 冲突');

  // 既有角色保持不变
  for (const original of existing.characters) {
    const kept = characters.find((item: any) => item.id === original.id);
    assert.deepEqual(kept, original);
  }
});

test('小白x：id 重复时会重新生成', () => {
  let counter = 0;
  const outcome = mergeCharacterDocuments(
    { type: 'novel-draw-characters', version: 3, characters: [{ id: 'char-1-x', name: '已有的' }] },
    { characters: [{ id: 'char-1-x', name: '新的' }] },
    { target: 'xiaobaix', conflict: 'overwrite', now: () => 1, random: () => 'x' + counter++ },
  );
  const characters = outcome.document.characters as any[];
  assert.equal(characters.length, 2);
  assert.notEqual(characters[0].id, characters[1].id);
});

test('小白x：overwrite 时保留原有 id 以不破坏插件引用', () => {
  const existing = { type: 'novel-draw-characters', version: 3, characters: [{ id: 'char-keep-me', name: '沈慕微', appearance: 'old' }] };
  const outcome = mergeCharacterDocuments(existing, { characters: [{ name: '沈慕微', appearance: 'new' }] }, {
    target: 'xiaobaix',
    conflict: 'overwrite',
  });
  const characters = outcome.document.characters as any[];
  assert.equal(characters.length, 1);
  assert.equal(characters[0].id, 'char-keep-me');
  assert.equal(characters[0].appearance, 'new');
});

test('小白x：rename 策略追加新条目而非覆盖', () => {
  const existing = { type: 'novel-draw-characters', version: 3, characters: [{ id: 'id-1', name: '江念', appearance: 'old' }] };
  const outcome = mergeCharacterDocuments(existing, { characters: [{ name: '江念', appearance: 'new' }] }, {
    target: 'xiaobaix',
    conflict: 'rename',
    now: () => 1,
    random: () => 'z',
  });
  const characters = outcome.document.characters as any[];
  assert.equal(characters.length, 2);
  assert.equal(characters[0].appearance, 'old', '原条目应保留');
  assert.equal(characters[1].name, '江念(2)');
});

test('容错：产出结构异常时给出 warning 而不抛异常', () => {
  for (const bad of [null, undefined, 42, 'string', { characters: 'not-an-object' }, { characters: [1, 2, null] }]) {
    const outcome = mergeCharacterDocuments(createEmptyDocument('zhihatsuki'), bad, {
      target: 'zhihatsuki',
      conflict: 'overwrite',
    });
    assert.ok(Array.isArray(outcome.warnings));
    assert.equal(outcome.added.length, 0);
  }

  const missingName = mergeCharacterDocuments({ characters: {} }, { characters: [{ appearance: 'x' }] }, {
    target: 'xiaobaix',
    conflict: 'overwrite',
  });
  assert.ok(missingName.warnings.some(w => w.includes('缺少 name')));
});

test('传入 existing 为空对象时自动建立骨架', () => {
  const zhi = mergeCharacterDocuments({}, { characters: { 甲: { nameCN: '甲' } } }, { target: 'zhihatsuki', conflict: 'overwrite' });
  assert.ok(zhi.document.outfits, '应自动补出 outfits 表');

  const xiao = mergeCharacterDocuments({}, { characters: [{ name: '乙' }] }, { target: 'xiaobaix', conflict: 'overwrite' });
  assert.equal((xiao.document as any).type, 'novel-draw-characters');
  assert.equal((xiao.document as any).version, 3);
});

test('nextAvailableKey 生成递增且不冲突的键', () => {
  const taken = new Set(['a', 'a(2)', 'a(3)']);
  assert.equal(nextAvailableKey('a', taken), 'a(4)');
  assert.equal(nextAvailableKey('b', taken), 'b');
});
