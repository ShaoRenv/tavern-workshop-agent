/**
 * 世界书源解析边界测试 —— 区块嵌套/错位、势力同名、重复角色名、候选来源优先级。
 *
 * 现有 worldbook_source.test.ts 覆盖真实世界书主路径，这里补充人工构造的极端结构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitWorldbookSections,
  parseFactionOverview,
  buildCharacterIndex,
  collectCharacterCandidates,
  type CharacterCandidate,
  type WorldbookEntryLike,
} from '../../src/苍玄界立绘工坊/core/worldbook_source.ts';

const entry = (name: string, content = ''): WorldbookEntryLike => ({ name, content });

/** 候选名列表 */
const namesOf = (candidates: CharacterCandidate[]): string[] => candidates.map(item => item.name);

// ============================================================
// 区块嵌套与错位
// ============================================================

test('嵌套区块：内层独立成区，外层条目不受影响，按开始下标排序', () => {
  const entries = [
    entry('====A====_开始'),
    entry('a1'),
    entry('====B====_开始'),
    entry('b1'),
    entry('====B====_结束'),
    entry('a2'),
    entry('====A====_结束'),
    entry('尾部'),
  ];
  const sections = splitWorldbookSections(entries);
  assert.deepEqual(sections.map(section => section.title), ['A', 'B', '']);
  assert.deepEqual(sections[0].entries.map(item => item.name), ['a1', 'a2']);
  assert.deepEqual(sections[1].entries.map(item => item.name), ['b1']);
  assert.equal(sections[0].startIndex, 0);
  assert.equal(sections[1].startIndex, 2, '内层区块保留自己的开始下标');
  assert.deepEqual(sections[2].entries.map(item => item.name), ['尾部']);
  assert.equal(sections[2].startIndex, -1);
});

test('结束标记只匹配到外层时，内层区块被一并闭合且条目不丢', () => {
  const entries = [
    entry('====A====_开始'),
    entry('a1'),
    entry('====B====_开始'),
    entry('b1'),
    entry('====A====_结束'),
    entry('after'),
  ];
  const sections = splitWorldbookSections(entries);
  assert.deepEqual(sections.map(section => section.title), ['A', 'B', '']);
  assert.deepEqual(sections[0].entries.map(item => item.name), ['a1']);
  assert.deepEqual(sections[1].entries.map(item => item.name), ['b1'], '被错位闭合的内层内容不应丢失');
  assert.deepEqual(sections[2].entries.map(item => item.name), ['after']);

  const total = sections.reduce((sum, section) => sum + section.entries.length, 0);
  assert.equal(total, 3, '所有内容条目都应保留');
});

test('文件结束时未闭合的嵌套区块全部强制收尾', () => {
  const sections = splitWorldbookSections([
    entry('====A====_开始'),
    entry('a1'),
    entry('====B====_开始'),
    entry('b1'),
  ]);
  assert.deepEqual(sections.map(section => section.title), ['A', 'B']);
  assert.equal(sections.reduce((sum, section) => sum + section.entries.length, 0), 2);
});

test('分隔条目标题两侧的空白会被去掉', () => {
  const sections = splitWorldbookSections([
    entry('====  角色设定  ====_开始'),
    entry('江念'),
    entry('====角色设定====_结束'),
  ]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, '角色设定');
  assert.deepEqual(sections[0].entries.map(item => item.name), ['江念']);
});

test('没有标题的分隔条目不被识别（已知边界，见报告）', () => {
  // 正则要求标题非空，因此 "========_开始" 会被当成普通条目，甚至进入角色索引
  const entries = [entry('========_开始'), entry('x')];
  const sections = splitWorldbookSections(entries);
  assert.deepEqual(sections.map(section => section.title), ['']);
  assert.equal(buildCharacterIndex(entries).has('========_开始'), true);
});

// ============================================================
// 角色索引
// ============================================================

test('buildCharacterIndex 跳过带 [mvu_plot] 后缀的分隔条目', () => {
  const index = buildCharacterIndex([
    entry('====世界观====_结束 [mvu_plot]'),
    entry('甲', '甲的正文'),
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.has('====世界观====_结束 [mvu_plot]'), false);
  assert.equal(index.get('甲')?.content, '甲的正文');
});

test('buildCharacterIndex 跳过空名条目', () => {
  const index = buildCharacterIndex([entry(''), entry('   '), entry('甲')]);
  assert.equal(index.size, 1);
  assert.equal(index.has('甲'), true);
});

// ============================================================
// 势力概览
// ============================================================

test('不同分类下的同名势力各自独立记录', () => {
  const factions = parseFactionOverview('上三门:\n  - 同名宗: 甲 | 人物: 甲\n下四宗:\n  - 同名宗: 乙 | 人物: 乙');
  assert.equal(factions.length, 2);
  assert.deepEqual(factions.map(item => item.category), ['上三门', '下四宗']);
  assert.deepEqual(factions.map(item => item.name), ['同名宗', '同名宗']);
  assert.deepEqual(factions.map(item => item.description), ['甲', '乙']);
});

test('全角冒号 / 全角逗号 / 顿号都能识别', () => {
  const factions = parseFactionOverview('上三门：\n  - 天剑宗：描述 | 核心：剑 | 地点：甲，乙 | 人物：丙、丁');
  assert.equal(factions.length, 1);
  assert.equal(factions[0].name, '天剑宗');
  assert.equal(factions[0].description, '描述');
  assert.equal(factions[0].core, '剑');
  assert.deepEqual(factions[0].locations, ['甲', '乙']);
  assert.deepEqual(factions[0].members, ['丙', '丁']);
});

test('只有分类、没有势力条目时返回空数组', () => {
  assert.deepEqual(parseFactionOverview('上三门:'), []);
  assert.deepEqual(parseFactionOverview('上三门:\n---'), []);
});

test('势力行没有描述时 description 为空串', () => {
  const factions = parseFactionOverview('上三门:\n  - 无名宗:');
  assert.equal(factions.length, 1);
  assert.equal(factions[0].name, '无名宗');
  assert.equal(factions[0].description, '');
  assert.deepEqual(factions[0].members, []);
});

test('区域概览：子块没有任何字段行时字段为空数组', () => {
  const regions = parseFactionOverview('苍玄界区域:\n  空区域:');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].name, '空区域');
  assert.equal(regions[0].category, '苍玄界区域');
  assert.deepEqual(regions[0].locations, []);
  assert.deepEqual(regions[0].members, []);
});

test('已知字段但值为空时归入当前势力，不误判为新势力', () => {
  const factions = parseFactionOverview('上三门:\n  - 天剑宗: 描述 | 人物:\n    地点:');
  assert.equal(factions.length, 1);
  assert.equal(factions[0].name, '天剑宗');
  assert.deepEqual(factions[0].members, []);
});

// ============================================================
// 候选汇总
// ============================================================

test('标题含「角色」的多个区块都被纳入候选', () => {
  const entries = [
    entry('====角色设定====_开始'),
    entry('甲'),
    entry('====角色设定====_结束'),
    entry('====角色关系====_开始'),
    entry('乙'),
    entry('====角色关系====_结束'),
  ];
  const candidates = collectCharacterCandidates(entries, { includeLiteList: false });
  assert.deepEqual(namesOf(candidates), ['甲', '乙']);
  assert.deepEqual(candidates.map(item => item.source), ['section', 'section']);
});

test('角色设定内嵌子区块的条目不会成为候选（当前行为，见报告）', () => {
  // 内嵌区块标题「内嵌」不含「角色」，因此它被当成独立区块，其条目被漏掉
  const entries = [
    entry('====角色设定====_开始'),
    entry('甲'),
    entry('====内嵌====_开始'),
    entry('乙'),
    entry('====内嵌====_结束'),
    entry('丙'),
    entry('====角色设定====_结束'),
  ];
  assert.deepEqual(namesOf(collectCharacterCandidates(entries, { includeLiteList: false })), ['甲', '丙']);
});

test('同名角色只保留一个候选，区块来源优先于势力来源', () => {
  const entries = [
    entry('====角色设定====_开始'),
    entry('甲', '甲的正文'),
    entry('====角色设定====_结束'),
    entry('苍玄界势力概览', '上三门:\n  - 某某宗: 描述 | 人物: 甲,乙'),
  ];
  const candidates = collectCharacterCandidates(entries, { includeLiteList: false });
  assert.deepEqual(namesOf(candidates), ['甲', '乙']);

  const jia = candidates[0];
  assert.equal(jia.source, 'section');
  assert.equal(jia.entry?.content, '甲的正文');

  const yi = candidates[1];
  assert.equal(yi.source, 'faction');
  assert.equal(yi.entry, null, '势力人物查不到同名条目时 entry 为 null');
});

test('同一区块内重复角色名只产生一个候选', () => {
  const entries = [
    entry('====角色设定====_开始'),
    entry('甲'),
    entry('甲'),
    entry(''),
    entry('  '),
    entry('====角色设定====_结束'),
  ];
  assert.deepEqual(namesOf(collectCharacterCandidates(entries, { includeLiteList: false })), ['甲']);
});

test('势力概览存在多个同义条目时只取第一个条目的人物', () => {
  const entries = [
    entry('势力概览', '上三门:\n  - 第一个宗: 描述 | 人物: 甲'),
    entry('苍玄界势力概览', '上三门:\n  - 第二个宗: 描述 | 人物: 乙'),
  ];
  assert.deepEqual(namesOf(collectCharacterCandidates(entries, { includeLiteList: false })), ['甲']);
});

test('精简名单角色能关联到同名角色条目', () => {
  const entries = [
    entry('全角色蓝灯精简', '**甲**｜一句话简介'),
    entry('甲', '甲的正文'),
  ];
  const candidates = collectCharacterCandidates(entries);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'lite-list');
  assert.equal(candidates[0].entry?.content, '甲的正文');
});
