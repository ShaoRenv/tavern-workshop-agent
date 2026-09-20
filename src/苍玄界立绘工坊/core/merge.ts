/**
 * 把 LLM 产出的角色数据合并进两个绘图插件的既有格式。
 *
 * 两个插件格式差异很大（见下方 adapter），因此用适配器隔离：
 * - 智绘姬 (st-chatu8): characters 是以 `[苍玄界]<名>` 为键的对象，outfits 是独立对象表并通过 owner 关联
 * - 小白x: characters 是扁平数组，外观集中在单个 appearance 字段，outfits 内联，必须有 id
 */
import { isPlainObject } from './json_util.ts';

export type MergeTarget = 'zhihatsuki' | 'xiaobaix';
export type ConflictPolicy = 'overwrite' | 'skip' | 'rename';

export interface MergeOptions {
  target: MergeTarget;
  conflict: ConflictPolicy;
  /** 智能姬的角色键前缀，默认 `[苍玄界]` */
  key_prefix?: string;
  /** 注入时间戳，便于测试 */
  now?: () => number;
  /** 注入随机串，便于测试 */
  random?: () => string;
}

export interface RenamedPair {
  from: string;
  to: string;
}

export interface MergeOutcome {
  document: Record<string, unknown>;
  added: string[];
  updated: string[];
  skipped: string[];
  renamed: RenamedPair[];
  warnings: string[];
}

const DEFAULT_PREFIX = '[苍玄界]';

/** 生成小白x 所需的角色 id：char-<时间戳>-<随机> */
export function createXiaobaixId(now: () => number, random: () => string): string {
  return `char-${now()}-${random()}`;
}

function defaultRandom(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** 创建一个空的目标文档骨架 */
export function createEmptyDocument(target: MergeTarget): Record<string, unknown> {
  if (target === 'xiaobaix') {
    return { type: 'novel-draw-characters', version: 3, characters: [] };
  }
  return { characters: {}, outfits: {} };
}

/** 若 base 已被占用，返回带序号后缀的可用名 */
export function nextAvailableKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}(${index})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}(${Date.now()})`;
}

/** 智能姬：从角色对象里取角色名（键去掉前缀与序号后缀） */
function zhihatsukiDisplayName(key: string, prefix: string): string {
  const withoutPrefix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return withoutPrefix.replace(/\(\d+\)$/, '');
}

/** 智能姬：把角色名变成键 */
function zhihatsukiKey(name: string, prefix: string): string {
  return `${prefix}${name}`;
}

/** 小白x：从角色对象里取角色名 */
function xiaobaixDisplayName(value: Record<string, unknown>): string {
  return typeof value.name === 'string' ? value.name.trim() : '';
}

export interface NormalizedCharacter {
  name: string;
  key: string;
  value: Record<string, unknown>;
}

/**
 * 把任意形态的 incoming 文档归一化成角色列表，便于统一合并。
 *
 * 容错：incoming 可能是 `{characters: {...}}`、`{characters: [...]}`、直接是数组或直接是对象表。
 */
export function normalizeIncomingCharacters(
  incoming: unknown,
  options: { target: MergeTarget; key_prefix: string; warnings: string[] },
): NormalizedCharacter[] {
  const { target, key_prefix } = options;
  const charactersRaw = isPlainObject(incoming) && 'characters' in incoming ? incoming.characters : incoming;

  const result: NormalizedCharacter[] = [];
  const byName = new Map<string, number>();

  /**
   * @param keyHint 对象表模式下的键；数组模式下是下标（仅作占位，不能当角色名）
   * @param fromObjectTable keyHint 是否真的是角色名
   */
  const pushValue = (keyHint: string, value: unknown, fromObjectTable: boolean) => {
    if (!isPlainObject(value)) {
      options.warnings.push(`跳过非对象角色条目: ${keyHint}`);
      return;
    }

    let name: string;
    let key: string;

    if (target === 'xiaobaix') {
      name = xiaobaixDisplayName(value);
      if (!name) {
        options.warnings.push(`小白x 角色缺少 name，已跳过: ${keyHint}`);
        return;
      }
      key = name;
    } else {
      // 数组模式下的 keyHint 是 "0"/"1" 这类下标，绝不能当成角色名（旧实现会产出 [苍玄界]0）
      const fromKey = fromObjectTable ? zhihatsukiDisplayName(keyHint, key_prefix) : '';
      name = fromKey || String(value.nameCN ?? value.name ?? '').trim();
      if (!name) {
        options.warnings.push(`智绘姬 角色缺少可用名称，已跳过: ${keyHint}`);
        return;
      }
      key = fromObjectTable ? keyHint : zhihatsukiKey(name, key_prefix);
    }

    // 同一批回复里出现同名条目时以后一条为准，但只记一次，避免 added/updated 重复计数
    const existingIndex = byName.get(name);
    if (existingIndex !== undefined) {
      options.warnings.push(`产出中出现重复角色「${name}」，以后一条为准`);
      result[existingIndex] = { name, key, value };
      return;
    }

    byName.set(name, result.length);
    result.push({ name, key, value });
  };

  if (Array.isArray(charactersRaw)) {
    charactersRaw.forEach(value => pushValue('', value, false));
  } else if (isPlainObject(charactersRaw)) {
    for (const [key, value] of Object.entries(charactersRaw)) pushValue(key, value, true);
  } else {
    options.warnings.push('未能从产出中识别出 characters 结构');
  }

  return result;
}

/** 归一化 outfits（智绘姬独立表 / 小白x 内联在角色里） */
function normalizeOutfits(incoming: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainObject(incoming)) return {};
  const raw = 'outfits' in incoming ? incoming.outfits : incoming;
  const result: Record<string, Record<string, unknown>> = {};

  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (isPlainObject(value)) result[key] = value;
    }
  } else if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isPlainObject(value)) continue;
      const key = String(value.nameCN ?? value.name ?? '').trim();
      if (key) result[key] = value;
    }
  }
  return result;
}

/**
 * 合并角色数据。
 *
 * @param existing 既有插件文档；传空对象表示从零开始
 * @param incoming LLM 产出（形态可容错）
 */
export function mergeCharacterDocuments(
  existing: unknown,
  incoming: unknown,
  options: MergeOptions,
): MergeOutcome {
  const key_prefix = options.key_prefix ?? DEFAULT_PREFIX;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? defaultRandom;

  const warnings: string[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const renamed: RenamedPair[] = [];

  const baseDocument = isPlainObject(existing) ? { ...existing } : createEmptyDocument(options.target);
  const incomingCharacters = normalizeIncomingCharacters(incoming, { target: options.target, key_prefix, warnings });
  const incomingOutfits = normalizeOutfits(incoming);

  if (options.target === 'zhihatsuki') {
    const characters = isPlainObject(baseDocument.characters) ? { ...baseDocument.characters } : {};
    const outfits = isPlainObject(baseDocument.outfits) ? { ...baseDocument.outfits } : {};
    const taken = new Set(Object.keys(characters));
    /** rename 时 旧键 → 新键，供服装键同步迁移 */
    const renameMap = new Map<string, string>();

    for (const item of incomingCharacters) {
      let key = zhihatsukiKey(item.name, key_prefix);
      const exists = key in characters;

      if (exists && options.conflict === 'skip') {
        skipped.push(item.name);
        continue;
      }
      if (exists && options.conflict === 'rename') {
        const renamedKey = nextAvailableKey(key, taken);
        renamed.push({ from: key, to: renamedKey });
        renameMap.set(key, renamedKey);
        key = renamedKey;
      }

      // overwrite 用浅合并：保留插件私有字段以及 incoming 未提供的既有字段
      const previous = characters[key];
      characters[key] = isPlainObject(previous) ? { ...previous, ...item.value } : { ...item.value };
      taken.add(key);
      if (exists) updated.push(item.name);
      else added.push(item.name);
    }

    // 服装合并：同名服装跟随角色的冲突策略，并同步 rename 后的键
    for (const [rawKey, value] of Object.entries(incomingOutfits)) {
      const prefixed = rawKey.startsWith(key_prefix) ? rawKey : `${key_prefix}${rawKey}`;
      // 角色被 rename 成新键时，其服装也必须挂到新键上，否则新外观会串到旧角色身上
      const key = renameMap.get(prefixed) ?? prefixed;
      const exists = key in outfits;
      if (exists && options.conflict === 'skip') {
        warnings.push(`服装已存在，按策略跳过: ${key}`);
        continue;
      }
      const previous = outfits[key];
      outfits[key] = isPlainObject(previous) ? { ...previous, ...value } : { ...value };
    }

    return { document: { ...baseDocument, characters, outfits }, added, updated, skipped, renamed, warnings };
  }

  // 小白x
  const characters = Array.isArray(baseDocument.characters) ? [...baseDocument.characters] : [];
  const protectedIds = new Set(
    characters.filter(isPlainObject).map(item => String(item.id ?? '')).filter(id => id !== ''),
  );

  for (const item of incomingCharacters) {
    const value: Record<string, unknown> = { ...item.value };
    // id 必须是非空字符串；插件要求角色有 id，空串/数字都属于隐性坏数据
    if (typeof value.id !== 'string' || value.id === '') value.id = createXiaobaixId(now, random);
    // 历史上这里是无上限的 while，注入确定性的 id 源时会死循环冻结主线程；加循环上限保险
    for (let guard = 0; guard < 1000 && protectedIds.has(String(value.id)); guard++) {
      value.id = createXiaobaixId(now, random);
    }
    if (protectedIds.has(String(value.id))) value.id = createXiaobaixId(now, () => String(Date.now()));
    protectedIds.add(String(value.id));

    const existingIndex = characters.findIndex(entry => isPlainObject(entry) && xiaobaixDisplayName(entry) === item.name);
    if (existingIndex >= 0) {
      if (options.conflict === 'skip') {
        skipped.push(item.name);
        continue;
      }
      if (options.conflict === 'rename') {
        const usedNames = new Set(
          characters.filter(isPlainObject).map(entry => xiaobaixDisplayName(entry)).filter(name => name !== ''),
        );
        const newName = nextAvailableKey(item.name, usedNames);
        renamed.push({ from: item.name, to: newName });
        value.name = newName;
        characters.push(value);
        added.push(newName);
        continue;
      }
      // overwrite 时保留原有 id（插件按 id 建引用），并浅合并以保留未提供的字段
      const previous = characters[existingIndex] as Record<string, unknown>;
      const keptId = typeof previous.id === 'string' && previous.id !== '' ? previous.id : value.id;
      characters[existingIndex] = { ...previous, ...value, id: keptId };
      updated.push(item.name);
      continue;
    }

    characters.push(value);
    added.push(item.name);
  }

  return {
    document: { ...baseDocument, type: 'novel-draw-characters', version: 3, characters },
    added,
    updated,
    skipped,
    renamed,
    warnings,
  };
}
