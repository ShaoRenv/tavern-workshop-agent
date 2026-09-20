/**
 * 世界书源解析测试 —— 使用真实的「我的苍玄界，才不会这么跌宕起伏！」世界书作为 fixture。
 *
 * 覆盖：区块拆分（含嵌套与首尾错位）、势力概览解析、区域概览解析、
 * 精简名单解析、角色索引、候选汇总，以及各类畸形输入下的容错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  splitWorldbookSections,
  parseFactionOverview,
  buildCharacterIndex,
  parseLiteCharacterList,
  collectCharacterCandidates,
  type Faction,
  type WorldbookEntryLike,
} from '../../src/苍玄界立绘工坊/core/worldbook_source.ts';

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', '苍玄界世界书.json');

/** 原始条目结构（只取解析用得到的字段） */
interface RawEntry {
  comment?: string;
  content?: string;
  disable?: boolean;
  key?: string[];
}

const rawData = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as {
  entries: Record<string, RawEntry>;
};

/** 按界面约定的方式把世界书 entries 对象转成数组 */
const SOURCE_ENTRIES: WorldbookEntryLike[] = Object.keys(rawData.entries).map(key => {
  const entry = rawData.entries[key];
  return {
    name: entry.comment ?? '',
    content: entry.content ?? '',
    enabled: !entry.disable,
    keys: entry.key ?? [],
  };
});

/** 按下标取原始条目（下标即对象键的顺序） */
const rawEntryAt = (index: number): RawEntry => rawData.entries[Object.keys(rawData.entries)[index]];

/** 便于断言的查找工具 */
const factionByName = (factions: Faction[], name: string): Faction | undefined =>
  factions.find(faction => faction.name === name);

// ============================================================
// 条目总览
// ============================================================

test('源世界书共 219 个条目', () => {
  assert.equal(SOURCE_ENTRIES.length, 219, `实际 ${SOURCE_ENTRIES.length}`);
  assert.equal(rawEntryAt(0).comment, '====核心规则====_开始');
});

// ============================================================
// 区块拆分
// ============================================================

test('能分出「角色设定」区块，且包含江念与沈慕微', () => {
  const sections = splitWorldbookSections(SOURCE_ENTRIES);
  const characterSection = sections.find(section => section.title === '角色设定');
  assert.ok(characterSection, '应存在「角色设定」区块');

  const names = characterSection!.entries.map(entry => entry.name);
  assert.ok(names.includes('江念'), '角色设定应包含江念');
  assert.ok(names.includes('沈慕微'), '角色设定应包含沈慕微');
  assert.ok(names.includes('雪照宁'), '角色设定应包含雪照宁');

  // 下标 6 是开始分隔条目，7~27 是内容条目
  assert.equal(characterSection!.startIndex, 6);
  assert.equal(characterSection!.entries.length, 21, `实际 ${characterSection!.entries.length}`);
});

test('区块分隔条目本身不作为内容条目返回', () => {
  const sections = splitWorldbookSections(SOURCE_ENTRIES);
  for (const section of sections) {
    for (const entry of section.entries) {
      assert.doesNotMatch(entry.name, /^=+.*=+_/, `${entry.name} 不应是分隔条目`);
    }
  }
});

test('能分出核心规则 / 世界观 / 变量设定等区块', () => {
  const titles = splitWorldbookSections(SOURCE_ENTRIES).map(section => section.title);
  for (const expected of ['核心规则', '角色设定', '世界观', '世界基础规则', '地标势力与常驻人物', '变量设定']) {
    assert.ok(titles.includes(expected), `应包含区块 ${expected}，实际 ${titles.join('/')}`);
  }
});

test('区块首尾错位（地标势力晚于世界观结束）时不抛异常且条目不丢', () => {
  const sections = splitWorldbookSections(SOURCE_ENTRIES);
  // 世界观 在下标 29 开始、110 结束，而 地标势力与常驻人物 直到 129 才结束
  const worldSection = sections.find(section => section.title === '世界观');
  const landmarkSection = sections.find(section => section.title === '地标势力与常驻人物');
  assert.ok(worldSection, '应存在「世界观」区块');
  assert.ok(landmarkSection, '应存在「地标势力与常驻人物」区块');
  assert.ok(landmarkSection!.entries.length > 0, '地标势力分区不应为空');

  // 所有条目要么在某个区块里、要么在松散分组里，总数守恒
  const total = sections.reduce((sum, section) => sum + section.entries.length, 0);
  const markerCount = SOURCE_ENTRIES.filter(entry => /=+.*=+_(开始|结束)/.test(entry.name)).length;
  assert.equal(total, SOURCE_ENTRIES.length - markerCount, '条目总数应守恒（仅排除分隔条目）');
});

test('不在任何区块内的条目归入 title 为空的松散分组', () => {
  const sections = splitWorldbookSections(SOURCE_ENTRIES);
  const loose = sections.find(section => section.title === '');
  assert.ok(loose, '应存在松散分组');
  const names = loose!.entries.map(entry => entry.name);
  assert.ok(names.includes('苍玄界势力概览'), '势力概览属于松散分组');
  assert.ok(names.includes('全角色蓝灯精简'), '蓝灯精简属于松散分组');
  assert.equal(loose!.startIndex, -1);
});

// ============================================================
// 势力概览
// ============================================================

test('parseFactionOverview 从下标 172 条目解出 18 个势力', () => {
  const factions = parseFactionOverview(rawEntryAt(172).content ?? '');
  assert.equal(factions.length, 18, `实际 ${factions.length}`);
});

test('天剑宗：分类、描述、核心、地点、人物都正确', () => {
  const factions = parseFactionOverview(rawEntryAt(172).content ?? '');
  const tianjian = factionByName(factions, '天剑宗');
  assert.ok(tianjian, '应解出天剑宗');
  assert.equal(tianjian!.category, '上三门');
  assert.equal(tianjian!.description, '西境断剑山脉剑道圣地');
  assert.equal(tianjian!.core, '剑道专修,一剑破万法');
  assert.deepEqual(tianjian!.locations, ['剑临城', '小寒山·月微居', '祖师祠堂']);
  for (const member of ['欧阳诚', '沈慕微', '江念', '冷小凝']) {
    assert.ok(tianjian!.members.includes(member), `天剑宗人物应含 ${member}`);
  }
});

test('没有「人物:」段的势力（东海海域）members 为空数组且不报错', () => {
  const factions = parseFactionOverview(rawEntryAt(172).content ?? '');
  const eastSea = factionByName(factions, '东海海域');
  assert.ok(eastSea, '应解出东海海域');
  assert.deepEqual(eastSea!.members, []);
  assert.equal(eastSea!.category, '非宗门势力');
  assert.deepEqual(eastSea!.locations, ['潮音港', '鲛珠礁市', '归墟潮眼']);
});

test('势力概览的分类划分正确', () => {
  const factions = parseFactionOverview(rawEntryAt(172).content ?? '');
  const categoriesOf = (category: string): string[] =>
    factions.filter(faction => faction.category === category).map(faction => faction.name);

  assert.deepEqual(categoriesOf('上三门'), ['天剑宗', '玄清宗', '太虚观']);
  assert.deepEqual(categoriesOf('下四宗'), ['丹霞谷', '万器山', '阵道阁', '御兽宗']);
  assert.deepEqual(categoriesOf('魔道六门'), ['魔道六门']);
  assert.deepEqual(categoriesOf('边地'), ['赤铃沙海']);
  assert.deepEqual(categoriesOf('秘境'), ['上古剑道秘境']);
  assert.equal(categoriesOf('非宗门势力').length, 8);
});

test('parseFactionOverview 也支持区域概览的缩进子块结构', () => {
  const regions = parseFactionOverview(rawEntryAt(173).content ?? '');
  assert.equal(regions.length, 7, `实际 ${regions.length}`);

  const central = factionByName(regions, '中州腹地');
  assert.ok(central, '应解出中州腹地');
  assert.equal(central!.category, '苍玄界区域');
  // 区域概览里的「势力」字段归入 members
  for (const name of ['玄清宗', '承安皇朝', '散修联盟', '桃李书院']) {
    assert.ok(central!.members.includes(name), `中州腹地应含势力 ${name}`);
  }
  assert.ok(central!.locations.includes('清平镇'));
});

// ============================================================
// 精简名单
// ============================================================

test('parseLiteCharacterList 从下标 174 条目解出至少 100 个角色', () => {
  const names = parseLiteCharacterList(rawEntryAt(174).content ?? '');
  assert.ok(names.length >= 100, `实际 ${names.length}`);
  assert.equal(names.length, 104, `实际 ${names.length}`);
  assert.ok(names.includes('诗疏影'));
  assert.ok(names.includes('今长乐'));
  // 不应把 markdown 星号或竖线残留带进名字
  for (const name of names) {
    assert.doesNotMatch(name, /[*｜|]/, `名字 ${name} 不应含标记字符`);
  }
});

test('parseLiteCharacterList 对重复名字去重', () => {
  const names = parseLiteCharacterList('**甲**｜说明一\n**乙**｜说明二\n**甲**｜说明三');
  assert.deepEqual(names, ['甲', '乙']);
});

// ============================================================
// 角色索引
// ============================================================

test('buildCharacterIndex 能按 comment 命中角色条目', () => {
  const index = buildCharacterIndex(SOURCE_ENTRIES);
  const jiangnian = index.get('江念');
  assert.ok(jiangnian, '应命中江念');
  assert.ok(jiangnian!.content.includes('江念'), '条目正文应含角色名');
});

test('buildCharacterIndex 跳过区块分隔条目，同名保留第一个', () => {
  const index = buildCharacterIndex(SOURCE_ENTRIES);
  assert.equal(index.has('====角色设定====_开始'), false, '分隔条目不应进索引');

  const duplicated: WorldbookEntryLike[] = [
    { name: '甲', content: '第一个' },
    { name: '甲', content: '第二个' },
  ];
  assert.equal(buildCharacterIndex(duplicated).get('甲')?.content, '第一个');
});

// ============================================================
// 候选汇总
// ============================================================

test('collectCharacterCandidates 能关联到实际条目', () => {
  const candidates = collectCharacterCandidates(SOURCE_ENTRIES);
  const jiangnian = candidates.find(candidate => candidate.name === '江念');
  assert.ok(jiangnian, '应包含江念');
  assert.ok(jiangnian!.entry, '江念应关联到实际条目');
  assert.ok(jiangnian!.entry!.content.includes('江念'));
  assert.equal(jiangnian!.source, 'section', '江念来自角色设定区块');
});

test('collectCharacterCandidates 汇总三类来源且名字唯一', () => {
  const candidates = collectCharacterCandidates(SOURCE_ENTRIES);
  const names = candidates.map(candidate => candidate.name);
  assert.equal(new Set(names).size, names.length, '候选名应唯一');

  const sources = new Set(candidates.map(candidate => candidate.source));
  assert.ok(sources.has('section'), '应含区块角色');
  assert.ok(sources.has('faction'), '应含势力人物');
  assert.ok(sources.has('lite-list'), '应含精简名单角色');

  // 区块角色 + 势力人物 + 精简名单规模
  assert.ok(candidates.length >= 104, `实际 ${candidates.length}`);
});

test('collectCharacterCandidates 可用 includeLiteList 关闭精简名单', () => {
  const withLite = collectCharacterCandidates(SOURCE_ENTRIES);
  const withoutLite = collectCharacterCandidates(SOURCE_ENTRIES, { includeLiteList: false });

  const hasName = (list: typeof withLite, name: string): boolean =>
    list.some(candidate => candidate.name === name);

  // 诗疏影 只出现在精简名单里
  assert.ok(hasName(withLite, '诗疏影'), '默认应包含精简名单角色');
  assert.equal(hasName(withoutLite, '诗疏影'), false, '关闭后不应包含诗疏影');
  assert.ok(hasName(withoutLite, '江念'), '关闭后仍应保留区块角色');
});

test('collectCharacterCandidates 对查不到条目的势力人物返回 entry 为 null', () => {
  const entries: WorldbookEntryLike[] = [
    { name: '====角色设定====_开始', content: '' },
    { name: '甲', content: '甲' },
    { name: '====角色设定====_结束', content: '' },
    { name: '苍玄界势力概览', content: '上三门:\n  - 某某宗: 描述 | 人物: 甲,查无此人' },
  ];
  const candidates = collectCharacterCandidates(entries, { includeLiteList: false });
  const missing = candidates.find(candidate => candidate.name === '查无此人');
  assert.ok(missing, '应保留查不到条目的候选项');
  assert.equal(missing!.entry, null, '查不到条目时 entry 应为 null');
  assert.equal(missing!.source, 'faction');
});

// ============================================================
// 容错
// ============================================================

test('各种畸形输入都不抛异常', () => {
  assert.deepEqual(splitWorldbookSections([]), []);
  assert.deepEqual(parseFactionOverview(''), []);
  assert.deepEqual(parseLiteCharacterList(''), []);
  assert.deepEqual(collectCharacterCandidates([]), []);
  assert.equal(buildCharacterIndex([]).size, 0);

  // 空名、缺字段
  const broken: WorldbookEntryLike[] = [
    { name: '', content: '' },
    { name: '只有名字', content: '' },
    { name: '====没有结束的区块====_开始', content: '内容' },
  ];
  assert.doesNotThrow(() => splitWorldbookSections(broken));
  assert.doesNotThrow(() => buildCharacterIndex(broken));
  assert.doesNotThrow(() => collectCharacterCandidates(broken));

  // 未闭合的区块应被强制收尾，条目不能丢
  const unclosed = splitWorldbookSections(broken);
  const total = unclosed.reduce((sum, section) => sum + section.entries.length, 0);
  assert.equal(total, 2, '未闭合区块的条目应被收尾保留');
});

test('势力概览的畸形输入：只有分类、缺冒号、游离文本', () => {
  assert.deepEqual(parseFactionOverview('上三门:'), []);
  assert.deepEqual(parseFactionOverview('---\n随便一段没有冒号的文字\n---'), []);
  assert.doesNotThrow(() => parseFactionOverview('上三门:\n  - 无描述宗门:\n  - 只有冒号:'));
  assert.doesNotThrow(() => parseFactionOverview('苍玄界区域:\n  某区域:\n    势力:\n    地点: 甲,乙'));

  // 已知字段名为空值时不应被误判成新势力
  const factions = parseFactionOverview('上三门:\n  - 天剑宗: 描述 | 人物:');
  assert.equal(factions.length, 1);
  assert.deepEqual(factions[0].members, []);
});

test('精简名单的畸形输入：没有竖线、空名、非字符串内容', () => {
  assert.deepEqual(parseLiteCharacterList('没有星号的一行'), []);
  assert.deepEqual(parseLiteCharacterList('**甲**没有分隔符'), []);
  assert.deepEqual(parseLiteCharacterList('****｜空名字'), []);
  assert.doesNotThrow(() => parseLiteCharacterList('**甲**｜说明'));
});
