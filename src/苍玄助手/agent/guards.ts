/**
 * 三个守卫（横切策略，工具本身不认识它们）+ 观察记录：
 *
 *  - observe-guard：entry_edit / entry_meta / entry_delete 之前必须先读过该条目
 *      · 没读过        → code:'NOT_OBSERVED'，文案照 DSH
 *      · 读过但版本变了 → code:'STALE'
 *      · wb_read / wb_search 成功后 record 观察（版本取**草稿视图**算出来的）
 *  - prune-guard  ：detail 超过 8192 就标记 pruned（**不改 detail 本体**，原文留给会话日志）；
 *                   真正给模型看的那份由 loop 调 pruneForModel() 修剪。
 *  - repeat-guard ：(工具名, 规范化参数 JSON) 计数，第 3/5/8 次往 contexts 里塞建议，绝不阻断。
 *
 * createToolGuards() 是默认装配：给了 port（草稿视图最好）就带 observe-guard，
 * 否则只装 prune + repeat。registry.guards() / loop 默认都走这里。
 */
import type {
  ObservationLog,
  ToolContext,
  ToolContextNote,
  ToolGuard,
  ToolResult,
  WbEntry,
  WorldbookPort,
} from '../core/ports.ts';
import { entryVersion } from './wb_view.ts';

/* ============================ 观察记录 ============================ */

function observationKey(world: string, uid: string): string {
  return world + '\u0000' + uid;
}

export function createObservationLog(): ObservationLog {
  const seen = new Map<string, string>();
  return {
    record(world, uid, version) {
      if (!world || !uid) return;
      seen.set(observationKey(world, uid), version);
    },
    seen(world, uid) {
      return seen.get(observationKey(world, uid));
    },
    clear() {
      seen.clear();
    },
  };
}

/* ============================ 小工具 ============================ */

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asInt(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(raw) ? Math.trunc(raw) : fallback;
}

/** 目标世界书：参数优先；没写就看本轮是不是只勾了一本 */
function targetWorld(ctx: ToolContext, asked: unknown): string {
  const name = asText(asked).trim();
  if (name) return name;
  const allowed = (ctx?.worlds ?? []).map(item => asText(item).trim()).filter(Boolean);
  return allowed.length === 1 ? allowed[0] : '';
}

/** 规范化 JSON：对象键排序、丢掉 undefined，保证同参数同键 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => stableStringify(item)).join(',') + ']';
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(object[key])).join(',') + '}';
}

/* ============================ prune ============================ */

export const PRUNE_LIMIT = 8192;
export const PRUNE_HEAD = 4096;
export const PRUNE_TAIL = 1024;
export const PRUNE_MARKER = '\n\n[... 中间已修剪 ...]\n\n';

/** 给模型看的那份文本：超长就留头 4096 + 尾 1024 */
export function pruneForModel(text: string): string {
  const value = String(text ?? '');
  if (value.length <= PRUNE_LIMIT) return value;
  return value.slice(0, PRUNE_HEAD) + PRUNE_MARKER + value.slice(value.length - PRUNE_TAIL);
}

/**
 * prune-guard：只标记，不改 detail。
 * detail 是「会话日志里的原文」，UI / 记录页 / 导出读的都是它；
 * 模型看到的是 loop 里 pruneForModel() 之后的版本。
 */
export function createPruneGuard(): ToolGuard {
  return {
    name: 'prune-guard',
    after(_input, result) {
      const detail = typeof result.detail === 'string' ? result.detail : '';
      if (detail.length <= PRUNE_LIMIT) return result;
      return { ...result, pruned: { original_chars: detail.length, kept_chars: pruneForModel(detail).length } };
    },
  };
}

/* ============================ repeat ============================ */

/** 第几次命中时给建议 */
export const REPEAT_HINT_AT = [3, 5, 8];

export interface RepeatGuard extends ToolGuard {
  /** 新用户消息时清零 */
  reset(): void;
  /** 某个 (工具名, 参数) 组合已经跑过几次（测试用） */
  countOf(name: string, args: Record<string, unknown>): number;
}

export function createRepeatGuard(): RepeatGuard {
  const counts = new Map<string, number>();
  const keyOf = (name: string, args: Record<string, unknown>): string => name + '\u0000' + stableStringify(args ?? {});
  return {
    name: 'repeat-guard',
    reset() {
      counts.clear();
    },
    countOf(name, args) {
      return counts.get(keyOf(name, args)) ?? 0;
    },
    after(input, result) {
      const key = keyOf(input.name, input.args ?? {});
      const times = (counts.get(key) ?? 0) + 1;
      counts.set(key, times);
      if (!REPEAT_HINT_AT.includes(times)) return result;
      const note: ToolContextNote = {
        source: 'repeat-guard',
        summary: '第 ' + times + ' 次用同样的参数调 ' + input.name,
        text:
          '你已经第 ' +
          times +
          ' 次用同样的参数调 ' +
          input.name +
          ' 了。看你上次的结果，换个方法，或者直接收工（submit）。',
      };
      return { ...result, contexts: [...(result.contexts ?? []), note] };
    },
  };
}

/* ============================ observe ============================ */

const WRITE_TOOLS = ['entry_edit', 'entry_meta', 'entry_delete'];

async function readEntry(port: WorldbookPort | undefined, world: string, uid: string): Promise<WbEntry | undefined> {
  if (!port) return undefined;
  try {
    const found = await port.readByUid(world, [uid]);
    return found[0];
  } catch {
    return undefined;
  }
}

export interface ObserveGuard extends ToolGuard {
  observations: ObservationLog;
  /** 手工记一条（测试/界面回放用） */
  record(world: string, entry: WbEntry): void;
}

export function createObserveGuard(
  port?: WorldbookPort,
  observations: ObservationLog = createObservationLog(),
): ObserveGuard {
  const logFor = (ctx: ToolContext): ObservationLog => ctx?.observations ?? observations;

  /** wb_read 成功后到底读了哪些条目 */
  const readTargets = async (input: {
    args: Record<string, unknown>;
    ctx: ToolContext;
  }): Promise<{ world: string; uids: string[] } | null> => {
    const world = targetWorld(input.ctx, input.args.world);
    if (!world || !port) return null;
    const single = asText(input.args.uid).trim();
    const many = Array.isArray(input.args.uids) ? input.args.uids.map(item => asText(item).trim()).filter(Boolean) : [];
    if (single) return { world, uids: [single] };
    if (many.length) return { world, uids: many };
    // 分页读：和 wb_read 的默认一致，只记这一页
    const offset = Math.max(0, asInt(input.args.offset, 0));
    const limit = Math.min(30, Math.max(1, asInt(input.args.limit, 5)));
    const entries = await port.readAll(world);
    return { world, uids: entries.slice(offset, offset + limit).map(entry => entry.uid) };
  };

  const recordRead = async (
    input: { args: Record<string, unknown>; ctx: ToolContext },
    result: ToolResult,
  ): Promise<ToolResult> => {
    if (!result.ok || !port) return result;
    const log = logFor(input.ctx);
    const target = await readTargets(input);
    if (target) {
      for (const uid of target.uids) {
        const entry = await readEntry(port, target.world, uid);
        if (entry) log.record(target.world, uid, entryVersion(entry));
      }
    }
    return result;
  };

  const recordSearch = async (
    input: { args: Record<string, unknown>; ctx: ToolContext },
    result: ToolResult,
  ): Promise<ToolResult> => {
    if (!result.ok || !port) return result;
    const keyword = asText(input.args.keyword).trim();
    if (!keyword) return result;
    const log = logFor(input.ctx);
    const asked = Array.isArray(input.args.worlds)
      ? input.args.worlds.map(item => asText(item).trim()).filter(Boolean)
      : [];
    const allowed = (input.ctx?.worlds ?? []).map(item => asText(item).trim()).filter(Boolean);
    const worlds = asked.length ? asked : allowed;
    if (!worlds.length) return result;
    const limit = Math.min(100, Math.max(1, asInt(input.args.limit, 20)));
    const hits = await port.search(worlds, keyword, limit);
    const byWorld = new Map<string, Set<string>>();
    for (const hit of hits) {
      const set = byWorld.get(hit.world) ?? new Set<string>();
      set.add(hit.uid);
      byWorld.set(hit.world, set);
    }
    for (const [world, uids] of byWorld) {
      const entries = await port.readAll(world);
      for (const entry of entries) {
        if (uids.has(entry.uid)) log.record(world, entry.uid, entryVersion(entry));
      }
    }
    return result;
  };

  return {
    name: 'observe-guard',
    observations,
    record(world, entry) {
      observations.record(world, entry.uid, entryVersion(entry));
    },
    async before(input) {
      if (!WRITE_TOOLS.includes(input.name)) return null;
      const uid = asText(input.args.uid).trim();
      const world = targetWorld(input.ctx, input.args.world);
      if (!uid || !world) return null; // 参数不全/范围不明，交给工具自己报错
      const log = logFor(input.ctx);
      const seenVersion = log.seen(world, uid);
      const entry = await readEntry(port, world, uid);
      if (seenVersion === undefined) {
        // 条目本身不存在就交给工具报 NOT_FOUND，别把「没读过」和「没有这条」混一起
        if (!entry) return null;
        const title = entry.name || uid;
        return {
          ok: false,
          code: 'NOT_OBSERVED',
          brief: '改之前要先读：' + title,
          detail: 'cannot modify "' + title + '": entry has not been read — wb_read it, then retry',
        };
      }
      if (entry && entryVersion(entry) !== seenVersion) {
        const title = entry.name || uid;
        return {
          ok: false,
          code: 'STALE',
          brief: '条目在读过之后变了：' + title,
          detail: '条目在读过之后变了，重新 wb_read 再改。',
        };
      }
      return null;
    },
    async after(input, result) {
      if (input.name === 'wb_read') return recordRead(input, result);
      if (input.name === 'wb_search') return recordSearch(input, result);
      return result;
    },
  };
}

/* ============================ 默认装配 ============================ */

export interface ToolGuardSet {
  /** 按顺序跑的守卫：observe（有 port 才有）→ prune → repeat */
  guards: ToolGuard[];
  observations: ObservationLog;
  repeat: RepeatGuard;
  prune: ToolGuard;
  observe?: ObserveGuard;
  /** 新用户消息时清零（重复计数 + 观察记录） */
  reset(): void;
}

export function createToolGuards(options: { port?: WorldbookPort; observations?: ObservationLog } = {}): ToolGuardSet {
  const observations = options.observations ?? createObservationLog();
  const repeat = createRepeatGuard();
  const prune = createPruneGuard();
  const observe = options.port ? createObserveGuard(options.port, observations) : undefined;
  const guards: ToolGuard[] = [];
  if (observe) guards.push(observe);
  guards.push(prune, repeat);
  return {
    guards,
    observations,
    repeat,
    prune,
    ...(observe ? { observe } : {}),
    reset() {
      repeat.reset();
      observations.clear();
    },
  };
}
