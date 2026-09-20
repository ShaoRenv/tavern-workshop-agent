/**
 * 世界书源解析 —— 从源世界书条目中拆出区块、势力树与可勾选角色。
 *
 * 本模块是**纯逻辑**：只做文本解析，不依赖酒馆助手全局（getWorldbook/getVariables 等），
 * 也不发起任何网络请求。因此它既能跑在酒馆里，也能被 `node --test` 直接测试。
 *
 * 数据形态（实测自「我的苍玄界，才不会这么跌宕起伏！」）：
 * - 条目形如 `{ uid, comment, content, disable, key, ... }`，其中 comment 是标题、content 是正文。
 * - 区块靠 `====角色设定====_开始` / `====角色设定====_结束` 这类分隔条目划分，
 *   部分分隔条目带 ` [mvu_plot]` 后缀。
 * - 势力概览是一棵「分类 → 势力」的缩进树。
 * - 全角色蓝灯精简是一份 `**名字**｜一句话简介` 的名单。
 */

/** 世界书条目（只取解析所需的最小字段，不从 @types 导入） */
export interface WorldbookEntryLike {
  /** 对应世界书条目的 comment */
  name: string;
  content: string;
  enabled?: boolean;
  keys?: string[];
}

/** 一个 `====区块====` 及其包含的条目 */
export interface WorldbookSection {
  /** 去掉 `====` 与 `_开始/_结束` 后的区块名，如 "角色设定" */
  title: string;
  entries: WorldbookEntryLike[];
  /** 区块起始分隔条目在输入数组中的下标；松散分组为 -1 */
  startIndex: number;
}

/** 势力概览中的一个势力 */
export interface Faction {
  /** "上三门" / "下四宗" / "魔道六门" / "非宗门势力" / "边地" / "秘境" */
  category: string;
  /** "天剑宗" */
  name: string;
  /** "西境断剑山脉剑道圣地" */
  description: string;
  /** "剑道专修,一剑破万法" */
  core: string;
  /** ["剑临城","小寒山·月微居","祖师祠堂"] */
  locations: string[];
  /** ["欧阳诚","沈慕微","江念","冷小凝"] */
  members: string[];
}

/** 一个可勾选的角色候选 */
export interface CharacterCandidate {
  name: string;
  source: 'section' | 'faction' | 'lite-list';
  /** 命中的世界书条目，找不到为 null */
  entry: WorldbookEntryLike | null;
}

/** `collectCharacterCandidates` 的可选行为 */
export interface CollectCharacterOptions {
  /** 是否把「全角色蓝灯精简」名单也纳入候选，默认 true */
  includeLiteList?: boolean;
}

// ============================================================
// 区块拆分
// ============================================================

/** 区块分隔条目：`====角色设定====_开始`、`====世界观====_结束 [mvu_plot]` */
const SECTION_MARKER_PATTERN = /^=+\s*(.*?)\s*=+\s*(_开始|_结束)/;

interface SectionMarker {
  title: string;
  kind: 'start' | 'end';
}

/** 解析区块分隔条目；不是分隔条目则返回 null */
function parseSectionMarker(name: string): SectionMarker | null {
  const match = (name ?? '').match(SECTION_MARKER_PATTERN);
  if (!match) return null;
  const title = match[1].trim();
  if (!title) return null;
  return { title, kind: match[2] === '_开始' ? 'start' : 'end' };
}

/**
 * 按 `====区块====` 分隔符把条目分组。
 *
 * 规则：
 * - 分隔条目本身是分隔符，**不作为内容条目**返回。
 * - 条目归属于"当前最内层未闭合的区块"，因此嵌套区块不会重复计数。
 * - 结束条目优先闭合最近的同名区块；找不到同名时闭合最近打开的区块；
 *   完全没有打开的区块时忽略。这样即使源数据里区块首尾错位（本项目的
 *   「地标势力与常驻人物」就晚于「世界观」才结束）也能安全收尾。
 * - 文件结束时仍未闭合的区块会被强制收尾，不会丢条目。
 * - 不在任何区块内的条目归入 title 为 `''` 的分组（没有这类条目时该分组不出现）。
 *
 * 返回结果按区块起始下标升序排列，便于界面按原文顺序展示。
 */
export function splitWorldbookSections(entries: WorldbookEntryLike[]): WorldbookSection[] {
  const sections: WorldbookSection[] = [];
  const loose: WorldbookEntryLike[] = [];
  /** 尚未闭合的区块，栈顶为最内层 */
  const open: WorldbookSection[] = [];

  /** 从栈顶一路闭合到 target（含），保证最内层先出栈 */
  const closeFrom = (target: number): void => {
    for (let i = open.length - 1; i >= target; i--) sections.push(open[i]);
    open.length = target;
  };

  entries.forEach((entry, index) => {
    const marker = parseSectionMarker(entry.name);
    if (!marker) {
      const innermost = open[open.length - 1];
      if (innermost) innermost.entries.push(entry);
      else loose.push(entry);
      return;
    }

    if (marker.kind === 'start') {
      open.push({ title: marker.title, entries: [], startIndex: index });
      return;
    }

    // 结束标记
    let target = -1;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].title === marker.title) {
        target = i;
        break;
      }
    }
    if (target < 0 && open.length > 0) target = open.length - 1;
    if (target >= 0) closeFrom(target);
  });

  // 文件结束时仍未闭合的区块，一并收尾
  if (open.length > 0) closeFrom(0);

  sections.sort((a, b) => a.startIndex - b.startIndex);
  if (loose.length > 0) sections.push({ title: '', entries: loose, startIndex: -1 });
  return sections;
}

// ============================================================
// 势力概览
// ============================================================

/** 缩进的势力条目行：`  - 天剑宗: 西境断剑山脉剑道圣地 | 核心: ...` */
const FACTION_LINE_PATTERN = /^\s*-\s*(.+?)\s*[:：]\s*(.*)$/;
/** 任意 `键: 值` 行 */
const KEY_VALUE_PATTERN = /^(\s*)([^:：]+?)\s*[:：]\s*(.*)$/;
/** `---` 之类的分隔线 */
const SEPARATOR_PATTERN = /^-{2,}$/;

/** 势力条目自身支持的字段名（用于区分"字段行"与"子块名行"） */
const FACTION_FIELD_KEYS = new Set(['核心', '地点', '人物', '势力']);

/** 把 `剑临城,小寒山·月微居` 拆成数组 */
function splitList(value: string): string[] {
  return value
    .split(/[,，、]/)
    .map(item => item.trim())
    .filter(item => item !== '');
}

/** 把 `核心: xxx` 这类字段写入势力对象 */
function applyFactionField(faction: Faction, key: string, value: string): void {
  if (key === '核心') faction.core = value;
  else if (key === '地点') faction.locations = splitList(value);
  else if (key === '人物' || key === '势力') faction.members = splitList(value);
}

/**
 * 解析势力概览条目正文，得到势力列表。
 *
 * 支持两种实测形态：
 * 1. 势力概览（`  - 天剑宗: 描述 | 核心: ... | 地点: ... | 人物: ...`）
 *    —— 无缩进的 `分类:` 行作为 category，`- 名字: ...` 行作为势力。
 * 2. 区域概览（`苍玄界区域:` → `  中州腹地:` → `    势力: ...` / `    地点: ...`）
 *    —— 缩进的 `名字:` 行作为子块，其下缩进更深的 `键: 值` 行作为字段。
 *    其中 `势力` 字段归入 members，`路线` 等接口未定义的字段忽略。
 *
 * 缺 `人物:` 段（如「东海海域」）或字段为空时，对应数组为空数组，不会抛异常。
 */
export function parseFactionOverview(content: string): Faction[] {
  const factions: Faction[] = [];
  if (!content) return factions;

  let category = '';
  let current: Faction | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (SEPARATOR_PATTERN.test(trimmed)) continue;

    // ① `- 名字: 描述 | 核心: ...` 形态
    const factionLine = line.match(FACTION_LINE_PATTERN);
    if (factionLine) {
      const name = factionLine[1].trim();
      if (!name) continue;
      current = { category, name, description: '', core: '', locations: [], members: [] };
      factions.push(current);

      const segments = factionLine[2]
        .split('|')
        .map(segment => segment.trim())
        .filter(segment => segment !== '');
      if (segments.length > 0) current.description = segments[0];
      for (let i = 1; i < segments.length; i++) {
        const field = segments[i].match(KEY_VALUE_PATTERN);
        if (field) applyFactionField(current, field[2].trim(), field[3].trim());
      }
      continue;
    }

    // ② `键: 值` 形态（分类行 / 子块名行 / 字段行）
    const keyValue = line.match(KEY_VALUE_PATTERN);
    if (!keyValue) continue;
    const indent = keyValue[1].length;
    const key = keyValue[2].trim();
    const value = keyValue[3].trim();
    if (!key) continue;

    if (indent === 0 && value === '') {
      // 无缩进的 `分类:`
      category = key;
      current = null;
      continue;
    }

    if (value === '') {
      if (FACTION_FIELD_KEYS.has(key)) {
        // 已知字段但值为空：保持字段为空，不误判成新势力
        if (current) applyFactionField(current, key, value);
        continue;
      }
      // 缩进的 `子块名:`（区域概览形态）
      current = { category, name: key, description: '', core: '', locations: [], members: [] };
      factions.push(current);
      continue;
    }

    if (current) applyFactionField(current, key, value);
  }

  return factions;
}

// ============================================================
// 角色索引与候选汇总
// ============================================================

/**
 * 建立 角色名 -> 条目 的索引（按 comment）。
 *
 * - 同名条目保留第一个。
 * - 区块分隔条目（`====X====_开始/_结束`）不是角色，跳过。
 * - comment 为空的条目跳过。
 */
export function buildCharacterIndex(entries: WorldbookEntryLike[]): Map<string, WorldbookEntryLike> {
  const index = new Map<string, WorldbookEntryLike>();
  for (const entry of entries) {
    const name = (entry.name ?? '').trim();
    if (!name) continue;
    if (parseSectionMarker(name)) continue;
    if (index.has(name)) continue;
    index.set(name, entry);
  }
  return index;
}

/** 精简名单的一行：`**诗疏影**｜上古云梦蝶仙分身，……` */
const LITE_NAME_PATTERN = /\*\*(.+?)\*\*\s*[｜|]/g;

/**
 * 解析「全角色蓝灯精简」条目，抽出角色名列表。
 *
 * 实测每行形如 `**诗疏影**｜上古云梦蝶仙分身，常作读书文修。女，……`，
 * 这里只取 `**名字**` 部分，并按出现顺序去重。
 */
export function parseLiteCharacterList(content: string): string[] {
  const names: string[] = [];
  if (!content) return names;

  const seen = new Set<string>();
  for (const match of content.matchAll(LITE_NAME_PATTERN)) {
    const name = match[1].replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 汇总所有可勾选角色：区块角色 ∪ 势力人物 ∪ 精简名单，并关联到实际条目。
 *
 * - 区块角色：取区块名中含「角色」的区块（本项目即「角色设定」）内的条目名。
 * - 势力人物：解析「势力概览」条目里各势力的 `人物` 列表。
 * - 精简名单：解析「蓝灯精简」条目（可用 `includeLiteList: false` 关闭）。
 *
 * 同名角色按 区块 > 势力 > 精简名单 的顺序保留第一个；
 * 每个候选都会在 角色名 -> 条目 索引里查出对应条目，查不到则为 null。
 */
export function collectCharacterCandidates(
  entries: WorldbookEntryLike[],
  options: CollectCharacterOptions = {},
): CharacterCandidate[] {
  const includeLiteList = options.includeLiteList ?? true;
  const index = buildCharacterIndex(entries);
  const result: CharacterCandidate[] = [];
  const seen = new Set<string>();

  const push = (name: string, source: CharacterCandidate['source']): void => {
    const clean = (name ?? '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    result.push({ name: clean, source, entry: index.get(clean) ?? null });
  };

  // ① 角色区块
  for (const section of splitWorldbookSections(entries)) {
    if (!section.title.includes('角色')) continue;
    for (const entry of section.entries) {
      const name = (entry.name ?? '').trim();
      if (name) push(name, 'section');
    }
  }

  // ② 势力概览里的人物
  const overview = entries.find(entry => (entry.name ?? '').includes('势力概览'));
  if (overview) {
    for (const faction of parseFactionOverview(overview.content)) {
      for (const member of faction.members) push(member, 'faction');
    }
  }

  // ③ 全角色蓝灯精简名单
  if (includeLiteList) {
    const lite = entries.find(entry => (entry.name ?? '').includes('蓝灯精简'));
    if (lite) {
      for (const name of parseLiteCharacterList(lite.content)) push(name, 'lite-list');
    }
  }

  return result;
}
