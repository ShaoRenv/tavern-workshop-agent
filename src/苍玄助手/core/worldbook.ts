/**
 * 苍玄助手 · 世界书数据层（worldbook）
 *
 * 实现 ports.ts 的 WorldbookPort，把酒馆助手世界书接口的字段差异抹平：
 *
 *  - 读：TavernHelper 的 WorldbookEntry 与旧版 ST 扁平形态都归一化成 `ports.WbEntry`；
 *    原始条目**整条快照**进 extra（一个字段都不丢）；
 *  - 写：`fromWbEntry` 先把 extra 里的原始字段铺开，再把归一化字段**按原形态**
 *    合并回去 —— 一个字段都不丢（strategy 里的 keys_secondary / scan_depth、
 *    position 的对象形态、name/comment 双写法、旧版 key/keysecondary 都保留）；
 *  - search：只返回 uid + 片段 + 命中次数，**不返回全文**（省 token）。
 *
 * 归一化对应关系（TavernHelper 原始结构 → WbEntry）：
 *   uid(number)                  → uid: String(uid)
 *   strategy.type                → strategy: 'constant'|'selective'|'vectorized'
 *   strategy.keys                → keys: string[]（RegExp 取 source）
 *   strategy.keys_secondary      → keys_secondary: { logic, keys }
 *   strategy.scan_depth          → scan_depth: number | 'same_as_global'
 *   position / depth / order     → position / depth / order（原值，不解释）
 *   其余全部                     → extra（写回时合并）
 *
 * 宿主接口全部走 storage.ts 的 hostFn，测试可以 setHostBridge 注入假实现。
 */
import type { WbEntry, WbSearchHit, WorldbookPort, WorldbookScope } from './ports.ts';
import { hostFn, isPlainRecord } from './storage.ts';

/* ============================ 取值小工具 ============================ */

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** 关键词可能是字符串，也可能是 RegExp（TavernHelper 允许），统一成字符串 */
function keyToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof RegExp) return value.source;
  if (value === undefined || value === null) return '';
  return String(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(keyToString).filter(item => item !== '');
}

const SECONDARY_LOGICS = ['and_any', 'and_all', 'not_all', 'not_any'] as const;
type SecondaryLogic = (typeof SECONDARY_LOGICS)[number];

function asSecondaryLogic(value: unknown): SecondaryLogic {
  return SECONDARY_LOGICS.includes(value as SecondaryLogic) ? (value as SecondaryLogic) : 'and_any';
}

/** 旧版 ST 的 selectiveLogic 是数字，这里按 ST 的常量表换算 */
function secondaryLogicFromNumber(value: unknown): SecondaryLogic {
  switch (asNumber(value, 0)) {
    case 1:
      return 'not_all';
    case 2:
      return 'not_any';
    case 3:
      return 'and_all';
    default:
      return 'and_any';
  }
}

const STRATEGIES = ['constant', 'selective', 'vectorized'] as const;
type Strategy = (typeof STRATEGIES)[number];

function asStrategy(value: unknown): Strategy | null {
  return STRATEGIES.includes(value as Strategy) ? (value as Strategy) : null;
}

/* ============================ 归一化（读） ============================ */

/**
 * 把一条原始世界书条目归一化成 WbEntry。
 *
 * 兼容两种形态：
 *  - TavernHelper：`{ uid, name, enabled, strategy:{type,keys,keys_secondary,scan_depth}, position:{...}, content }`
 *  - 旧版 ST 扁平：`{ uid, comment, key, keysecondary, selectiveLogic, constant, position: 0, depth, order, content }`
 *
 * `extra` 是原始对象的**完整快照**（连 uid/name/content 也留着当写法记号），
 * 写回时先铺开它、再按原形态盖上新值，所以一个字段都不会丢。
 */
export function toWbEntry(raw: unknown): WbEntry {
  const record = isPlainRecord(raw) ? raw : {};
  const strategyObject = isPlainRecord(record.strategy) ? record.strategy : null;
  const positionObject = isPlainRecord(record.position) ? record.position : null;

  // --- strategy：TavernHelper 的 type → 我们的 strategy；旧版 constant 布尔兜底 ---
  const strategy = asStrategy(strategyObject?.type) ?? (asBoolean(record.constant, false) ? 'constant' : 'selective');

  // --- keys：优先 strategy.keys，其次旧版 keys / key ---
  const keysSource = strategyObject ? strategyObject.keys : record.keys !== undefined ? record.keys : record.key;

  // --- keys_secondary：优先 strategy.keys_secondary，其次旧版 keysecondary + selectiveLogic ---
  const secondaryObject = strategyObject && isPlainRecord(strategyObject.keys_secondary) ? strategyObject.keys_secondary : null;
  const keysSecondary = secondaryObject
    ? { logic: asSecondaryLogic(secondaryObject.logic), keys: toStringList(secondaryObject.keys) }
    : { logic: secondaryLogicFromNumber(record.selectiveLogic), keys: toStringList(record.keysecondary) };

  // --- scan_depth：'same_as_global' 或数字 ---
  const rawScanDepth = strategyObject?.scan_depth ?? record.scanDepth;
  const scanDepth: number | 'same_as_global' =
    rawScanDepth === 'same_as_global' ? 'same_as_global' : asNumber(rawScanDepth, 0);

  // --- 位置：对象形态的原值留在 extra.position，写回时合并 ---
  const position = typeof record.position === 'number' ? record.position : 0;
  const depth = positionObject ? asNumber(positionObject.depth, 0) : asNumber(record.depth, 0);
  const order = positionObject ? asNumber(positionObject.order, 0) : asNumber(record.order, 0);

  const uid = record.uid === undefined || record.uid === null ? '' : String(record.uid);

  // 整条原始条目原样留下：既是「不丢字段」的底稿，也是「原本用哪种写法」的记号
  // （uid 是数字还是字符串、标题叫 name 还是 comment、有没有 key/keysecondary…）
  const extra: Record<string, unknown> = { ...record };

  return {
    uid,
    name: asString(record.name ?? record.comment),
    content: asString(record.content),
    enabled: asBoolean(record.enabled, true),
    strategy,
    keys: toStringList(keysSource),
    keys_secondary: keysSecondary,
    scan_depth: scanDepth,
    position,
    depth,
    order,
    extra,
  };
}

/* ============================ 反归一化（写） ============================ */

/**
 * 把 WbEntry 还原成写回酒馆的样子。
 *
 * 规则：extra 里记着这条条目原本长什么样，所以
 *  1) 用 extra 铺开（原始字段一个不少）；
 *  2) 再把归一化字段**按原本的形态**盖回去：
 *     - 原本有 `comment` 就写 comment，有 `name` 就写 name（都有就都写）
 *     - 原本是 strategy 对象 → 写 strategy（并保留 keys_secondary / scan_depth 的其他细节）
 *     - 原本是旧版扁平字段 → 写 key / keysecondary / selectiveLogic / constant / scanDepth
 *     - 原本 position 是对象 → 合并 depth/order；是数字 → 写数字，同时补 depth/order
 *
 * 对草稿新建的条目（extra 为空）会生成一份标准的 TavernHelper 结构。
 */
export function fromWbEntry(entry: WbEntry): Record<string, unknown> {
  const extra = isPlainRecord(entry.extra) ? entry.extra : {};
  const out: Record<string, unknown> = { ...extra };

  // 先清掉归一化字段的旧值，避免 extra 里的陈旧值覆盖新值
  delete out.uid;
  delete out.name;
  delete out.comment;
  delete out.content;
  delete out.enabled;
  delete out.strategy;
  delete out.keys;
  delete out.key;
  delete out.constant;
  delete out.keys_secondary;
  delete out.keysecondary;
  delete out.selectiveLogic;
  delete out.scan_depth;
  delete out.scanDepth;
  delete out.position;
  delete out.depth;
  delete out.order;

  // --- uid：**只有 uid 为空才算新建**，交给酒馆分配；
  //     非空就原样带上（原来是数字保持数字，数字字符串转数字，其他字符串原样保留）---
  if (entry.uid !== '') {
    const rawUid = extra.uid;
    const keepRawNumber = typeof rawUid === 'number' && String(rawUid) === entry.uid;
    out.uid = keepRawNumber ? rawUid : /^\d+$/.test(entry.uid) ? Number(entry.uid) : entry.uid;
  }

  // --- 标题：name / comment 双写法都保持，而且**谁也不许覆盖谁** ---
  // 原始同时有 name 和 comment 时，comment 是另一个独立字段（两个值可能不同），
  // 原样留着；只有「原始只有 comment」时，comment 才是标题、需要跟着改名走。
  const hasName = 'name' in extra;
  const hasComment = 'comment' in extra;
  if (hasName) {
    out.name = entry.name;
    if (hasComment) out.comment = extra.comment;
  } else if (hasComment) {
    out.comment = entry.name;
  } else {
    out.name = entry.name;
  }

  out.content = entry.content;
  out.enabled = entry.enabled;

  // --- 激活策略 / 关键词 ---
  const extraStrategy = isPlainRecord(extra.strategy) ? extra.strategy : null;
  if (extraStrategy) {
    out.strategy = {
      ...extraStrategy,
      type: entry.strategy,
      keys: entry.keys,
      keys_secondary: { ...(isPlainRecord(extraStrategy.keys_secondary) ? extraStrategy.keys_secondary : {}), logic: entry.keys_secondary.logic, keys: entry.keys_secondary.keys },
      scan_depth: entry.scan_depth,
    };
    if ('constant' in extra) out.constant = entry.strategy === 'constant';
  } else if ('key' in extra || 'keys' in extra || 'constant' in extra || 'keysecondary' in extra) {
    // 旧版扁平形态
    if ('key' in extra) out.key = entry.keys;
    if ('keys' in extra) out.keys = entry.keys;
    if ('keysecondary' in extra) out.keysecondary = entry.keys_secondary.keys;
    if ('selectiveLogic' in extra) out.selectiveLogic = logicToNumber(entry.keys_secondary.logic);
    if ('constant' in extra) out.constant = entry.strategy === 'constant';
    if ('scanDepth' in extra) out.scanDepth = entry.scan_depth === 'same_as_global' ? 0 : entry.scan_depth;
  } else {
    // 全新条目：给一份标准 TavernHelper 结构
    out.strategy = {
      type: entry.strategy,
      keys: entry.keys,
      keys_secondary: { logic: entry.keys_secondary.logic, keys: entry.keys_secondary.keys },
      scan_depth: entry.scan_depth,
    };
  }

  // --- 插入位置 / 深度 / 顺序 ---
  const extraPosition = isPlainRecord(extra.position) ? extra.position : null;
  if (extraPosition) {
    out.position = { ...extraPosition, depth: entry.depth, order: entry.order };
  } else if ('position' in extra || 'depth' in extra || 'order' in extra) {
    if ('position' in extra) out.position = entry.position;
    if ('depth' in extra || 'position' in extra) out.depth = entry.depth;
    if ('order' in extra || 'position' in extra) out.order = entry.order;
  } else {
    out.position = { type: 'before_character_definition', role: 'system', depth: entry.depth, order: entry.order };
  }

  return out;
}

/** 我们这边的 logic → 旧版 ST 的 selectiveLogic 数字 */
function logicToNumber(logic: SecondaryLogic): number {
  switch (logic) {
    case 'not_all':
      return 1;
    case 'not_any':
      return 2;
    case 'and_all':
      return 3;
    default:
      return 0;
  }
}

/** 草稿层新建条目用：给一份字段齐全的 WbEntry（partial 里给了什么就用什么） */
export function makeWbEntry(partial: Partial<WbEntry> & { name: string }): WbEntry {
  const base: WbEntry = {
    uid: '',
    name: partial.name,
    content: '',
    enabled: true,
    strategy: 'selective',
    keys: [],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
    position: 0,
    depth: 4,
    order: 100,
  };
  return { ...base, ...partial, name: partial.name };
}

/* ============================ 搜索 ============================ */

/** 取命中位置前后一小段；不返回全文（token 预算关键） */
export function buildSnippet(content: string, keyword: string, radius = 36): string {
  if (!content) return '';
  const haystack = content.toLowerCase();
  const needle = keyword.toLowerCase();
  const index = needle ? haystack.indexOf(needle) : -1;
  if (index < 0) {
    return content.length > radius * 2 ? content.slice(0, radius * 2) + '…' : content;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + keyword.length + radius);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

/** 单条命中的次数（大小写不敏感） */
export function countHits(text: string, keyword: string): number {
  if (!keyword || !text) return 0;
  const haystack = text.toLowerCase();
  const needle = keyword.toLowerCase();
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 纯函数版搜索：给一组条目，返回只带 uid + 片段的命中结果。
 * 命中标题时片段取正文开头，命中正文时取命中位置前后一小段。
 */
export function searchInEntries(world: string, entries: WbEntry[], keyword: string, limit: number): WbSearchHit[] {
  const trimmed = keyword.trim();
  if (!trimmed || limit <= 0) return [];

  const hits: WbSearchHit[] = [];
  for (const entry of entries) {
    const nameHits = countHits(entry.name, trimmed);
    const contentHits = countHits(entry.content, trimmed);
    const total = nameHits + contentHits;
    if (total === 0) continue;
    hits.push({
      world,
      uid: entry.uid,
      name: entry.name,
      snippet: contentHits > 0 ? buildSnippet(entry.content, trimmed) : buildSnippet(entry.content, ''),
      hits: total,
    });
  }
  return hits.slice(0, limit);
}

/* ============================ WorldbookPort 实现 ============================ */

/** 需要的宿主接口缺失时抛出的错误 */
export class MissingHostApiError extends Error {
  constructor(name: string) {
    super('酒馆助手缺少 ' + name + ' 接口，无法操作世界书');
    this.name = 'MissingHostApiError';
  }
}

function requireHostFn(name: string): (...args: any[]) => any {
  const fn = hostFn(name);
  if (!fn) throw new MissingHostApiError(name);
  return fn;
}

/**
 * 真机实现：全部通过酒馆助手接口读写。
 *
 * 注意：方法内部是**每次调用时才取接口**，所以单例可以先建好，
 * 之后 setHostBridge 注入假实现依然生效。
 */
export class TavernWorldbookPort implements WorldbookPort {
  /** 全部世界书名 */
  async list(): Promise<string[]> {
    const getNames = hostFn('getWorldbookNames');
    if (!getNames) return [];
    try {
      const names = getNames();
      return Array.isArray(names) ? names.map(item => String(item)) : [];
    } catch (error) {
      console.warn('[苍玄助手] 获取世界书名失败', error);
      return [];
    }
  }

  /** 酒馆当前启用的世界书：全局启用 + 当前角色卡 / 聊天绑定，按顺序去重 */
  async current(): Promise<string[]> {
    const result: string[] = [];
    const seen = new Set<string>();

    const push = (value: unknown): void => {
      const name = asString(value).trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      result.push(name);
    };

    try {
      const getGlobal = hostFn('getGlobalWorldbookNames');
      if (getGlobal) {
        const names = getGlobal();
        if (Array.isArray(names)) names.forEach(push);
      }
    } catch (error) {
      console.warn('[苍玄助手] 获取全局世界书失败', error);
    }

    try {
      const getChar = hostFn('getCharWorldbookNames');
      if (getChar) {
        const bound = getChar('current');
        if (isPlainRecord(bound)) {
          push(bound.primary);
          if (Array.isArray(bound.additional)) bound.additional.forEach(push);
        }
      }
    } catch (error) {
      console.warn('[苍玄助手] 获取角色卡世界书失败', error);
    }

    try {
      const getChat = hostFn('getChatWorldbookName');
      if (getChat) push(getChat('current'));
    } catch (error) {
      console.warn('[苍玄助手] 获取聊天世界书失败', error);
    }

    return result;
  }

  /**
   * 每本世界书的绑定范围（全局 / 当前角色卡 / 当前聊天 / 未启用）。
   *
   * 三态判定顺序：全局 > 角色卡 > 聊天 > 未启用。同一本同时挂多处时按影响面最大的说，
   * 免得模型以为「只是当前角色卡用的」而不敢改一本全局书。
   * 任何一步拿不到就跳过 —— 宁可标「未启用」也不要抛（列表工具不该因为一个接口缺失就废掉）。
   */
  async scopes(): Promise<WorldbookScope[]> {
    const globals = new Set<string>();
    const characters = new Set<string>();
    const chats = new Set<string>();

    try {
      const getGlobal = hostFn('getGlobalWorldbookNames');
      const names = getGlobal ? getGlobal() : null;
      if (Array.isArray(names)) names.forEach(value => {
        const name = asString(value).trim();
        if (name) globals.add(name);
      });
    } catch (error) {
      console.warn('[苍玄助手] 读全局世界书失败', error);
    }

    try {
      const getChar = hostFn('getCharWorldbookNames');
      const bound = getChar ? getChar('current') : null;
      if (isPlainRecord(bound)) {
        const primary = asString(bound.primary).trim();
        if (primary) characters.add(primary);
        if (Array.isArray(bound.additional)) bound.additional.forEach(value => {
          const name = asString(value).trim();
          if (name) characters.add(name);
        });
      }
    } catch (error) {
      console.warn('[苍玄助手] 读角色卡世界书失败', error);
    }

    try {
      const getChat = hostFn('getChatWorldbookName');
      const name = asString(getChat ? getChat('current') : '').trim();
      if (name) chats.add(name);
    } catch (error) {
      console.warn('[苍玄助手] 读聊天世界书失败', error);
    }

    const all = await this.list();
    return all.map(name => {
      if (globals.has(name)) return { name, kind: 'global' as const, label: '全局' };
      if (characters.has(name)) return { name, kind: 'character' as const, label: '当前角色卡' };
      if (chats.has(name)) return { name, kind: 'chat' as const, label: '当前聊天' };
      return { name, kind: 'none' as const, label: '未启用' };
    });
  }

  /** 读整本世界书，归一化成 WbEntry[] */
  async readAll(world: string): Promise<WbEntry[]> {
    const name = asString(world).trim();
    if (!name) return [];
    const getWorldbook = requireHostFn('getWorldbook');
    const raw = await getWorldbook(name);
    if (!Array.isArray(raw)) return [];
    return raw.map(toWbEntry);
  }

  /** 按 uid 读指定条目 */
  async readByUid(world: string, uids: string[]): Promise<WbEntry[]> {
    const wanted = new Set(uids.map(item => String(item)));
    if (wanted.size === 0) return [];
    const all = await this.readAll(world);
    return all.filter(entry => wanted.has(entry.uid));
  }

  /** 关键词搜索：只返回 uid + 片段，不返回全文 */
  async search(worlds: string[], keyword: string, limit: number): Promise<WbSearchHit[]> {
    const trimmed = keyword.trim();
    if (!trimmed || limit <= 0) return [];

    const hits: WbSearchHit[] = [];
    for (const world of worlds) {
      if (hits.length >= limit) break;
      let entries: WbEntry[];
      try {
        entries = await this.readAll(world);
      } catch (error) {
        console.warn('[苍玄助手] 搜索时读取世界书失败：' + world, error);
        continue;
      }
      hits.push(...searchInEntries(world, entries, trimmed, limit - hits.length));
    }
    return hits.slice(0, limit);
  }

  /** 新建世界书；同名已存在时直接报错，**绝不覆盖** */
  async createWorldbook(name: string): Promise<void> {
    const target = asString(name).trim();
    if (!target) throw new Error('世界书名称不能为空');

    const exists = (await this.list()).includes(target);
    if (exists) throw new Error('世界书已存在，换个名字：' + target);

    const create = hostFn('createWorldbook');
    if (create) {
      await create(target, []);
      return;
    }
    const createOrReplace = requireHostFn('createOrReplaceWorldbook');
    const created = await createOrReplace(target, []);
    if (created === false) throw new Error('世界书已存在，换个名字：' + target);
  }

  /** 删除世界书；不存在时静默返回 */
  async deleteWorldbook(name: string): Promise<void> {
    const target = asString(name).trim();
    if (!target) return;
    const remove = requireHostFn('deleteWorldbook');
    const removed = await remove(target);
    if (removed === false) console.warn('[苍玄助手] 世界书不存在或删除失败：' + target);
  }

  /** 全量写回某本世界书；extra 里的原始字段会合并回去，不丢字段 */
  async writeAll(world: string, entries: WbEntry[]): Promise<void> {
    const target = asString(world).trim();
    if (!target) throw new Error('世界书名称不能为空');
    const replace = requireHostFn('replaceWorldbook');
    const payload = entries.map(entry => fromWbEntry(entry));
    await replace(target, payload, { render: 'debounced' });
  }
}

/** 建一个 WorldbookPort（界面 / Agent 内核用） */
export function createWorldbookPort(): WorldbookPort {
  return new TavernWorldbookPort();
}
