/**
 * 草稿层：所有写操作先落草稿，不上真数据。
 *
 * 流程：
 *   工具 run() → ctx.drafts.addChange(...) → 界面展示 diff（逐行 + / -）
 *   用户确认 → DraftStore.apply(wb) → WorldbookPort.writeAll 才真正写回酒馆世界书
 *
 * 关于 ports.ts 的 DraftSink：它只有 add(world, uid, kind, before, after, label)，没有 payload。
 * 所以这里同时提供两种接法：
 *   1) 首选 addChange(change)：带结构化 payload，草稿信息最全；
 *   2) 兼容 add()：create 把条目字段 JSON 塞进 before、after 放正文；meta 把新字段 JSON 塞进 after。
 * 两种接法落进 DraftStore 后形状一致，apply() 只认 payload。
 */
import { nowMs, uid, type DraftChange, type DraftKind } from '../core/types.ts';
import type { WbEntry, WorldbookPort } from '../core/ports.ts';

/* ============================ diff ============================ */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  /** 原文行号（1 起） */
  old_line?: number;
  /** 新文行号（1 起） */
  new_line?: number;
}

export interface DiffStat {
  add: number;
  del: number;
}

/** 行数太大时不做精确 LCS，直接整段替换，避免卡死界面 */
const LCS_MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (normalized === '') return [];
  return normalized.split('\n');
}

function coarseDiff(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (let i = 0; i < a.length; i++) out.push({ type: 'del', text: a[i], old_line: i + 1 });
  for (let j = 0; j < b.length; j++) out.push({ type: 'add', text: b[j], new_line: j + 1 });
  return out;
}

/** 逐行 LCS diff；返回完整序列（含未改动的行） */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > LCS_MAX_CELLS) return coarseDiff(a, b);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + (j + 1)] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], old_line: i + 1, new_line: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      out.push({ type: 'del', text: a[i], old_line: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', text: b[j], new_line: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i], old_line: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j], new_line: j + 1 });
    j++;
  }
  return out;
}

/** 只留改动（±）行，工具卡里就显示这个 */
export function changedLines(diff: DiffLine[]): DiffLine[] {
  return diff.filter(line => line.type !== 'same');
}

/** 只留改动附近 context 行，diff 弹窗用 */
export function compactDiff(diff: DiffLine[], context = 2): DiffLine[] {
  const keep = new Set<number>();
  diff.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k++) keep.add(k);
  });
  const out = diff.filter((_, index) => keep.has(index));
  if (out.length < diff.length && out.some(line => line.type !== 'same')) {
    return [{ type: 'same', text: '…', old_line: 0, new_line: 0 }, ...out];
  }
  return out;
}

export function diffStat(diff: DiffLine[]): DiffStat {
  let add = 0;
  let del = 0;
  for (const line of diff) {
    if (line.type === 'add') add++;
    else if (line.type === 'del') del++;
  }
  return { add, del };
}

/** 转成纯文本 diff：'+ xxx' / '- xxx' / '  xxx' */
export function formatDiff(diff: DiffLine[], options: { only_changed?: boolean; context?: number } = {}): string {
  const lines = options.only_changed
    ? changedLines(diff)
    : options.context !== undefined
      ? compactDiff(diff, options.context)
      : diff;
  return lines
    .map(line => {
      const prefix = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ';
      return prefix + line.text;
    })
    .join('\n');
}

/** 草稿卡上一行摘要，如 '+2 -1' */
export function formatStat(stat: DiffStat): string {
  const parts: string[] = [];
  if (stat.add) parts.push('+' + stat.add);
  if (stat.del) parts.push('-' + stat.del);
  return parts.length ? parts.join(' ') : '无变化';
}

/* ============================ 载荷编解码 ============================ */

/** meta 字段 → 逐行文本，方便走同一套 diff */
export function encodeMetaFields(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .map(key => key + ': ' + JSON.stringify(fields[key]))
    .join('\n');
}

function decodeJsonObject(raw: string): Record<string, unknown> {
  const text = String(raw ?? '').trim();
  if (!text || text[0] !== '{') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* 不是 JSON 就当没有 */
  }
  return {};
}

/* ============================ 草稿仓 ============================ */

export interface DraftDiff {
  change: DraftChange;
  lines: DiffLine[];
  stat: DiffStat;
  text: string;
}

function normalizeChange(change: Partial<DraftChange> & { kind: DraftKind }, fallbackSessionId = ''): DraftChange {
  return {
    id: typeof change.id === 'string' && change.id ? change.id : uid('draft'),
    session_id: typeof change.session_id === 'string' && change.session_id ? change.session_id : fallbackSessionId,
    kind: change.kind,
    world: typeof change.world === 'string' ? change.world : '',
    uid: typeof change.uid === 'string' ? change.uid : '',
    label: typeof change.label === 'string' ? change.label : '',
    before: typeof change.before === 'string' ? change.before : '',
    after: typeof change.after === 'string' ? change.after : '',
    payload: change.payload && typeof change.payload === 'object' ? change.payload : {},
    at: typeof change.at === 'number' && change.at ? change.at : nowMs(),
  };
}

/**
 * 草稿仓。界面把它当唯一草稿源：
 *   store.addChange(...)  工具写入
 *   store.diffs()         渲染 diff 弹窗
 *   await store.apply(wb) 用户点「全部保存」后落地
 */
export class DraftStore {
  private items: DraftChange[] = [];
  private seq = 0;
  /** 当前会话（v3）：写入口没给 session_id 就用它盖上 */
  private sessionId = '';

  constructor(seed: DraftChange[] = []) {
    for (const item of seed) this.items.push(normalizeChange(item));
  }

  /** runner 每轮开工前调一次：把当前会话 id 盖上，草稿才归属正确 */
  setSessionId(id: string): void {
    this.sessionId = typeof id === 'string' ? id : '';
  }

  sessionIdOf(): string {
    return this.sessionId;
  }

  /** 结构化写入（首选） */
  addChange(change: Partial<DraftChange> & { kind: DraftKind }): DraftChange {
    const next = normalizeChange(change, this.sessionId);
    this.items.push(next);
    this.seq++;
    return next;
  }

  /**
   * ports.ts DraftSink 的最小接口。
   * create：before = 条目字段 JSON，after = 正文
   * meta：before = 旧字段 JSON，after = 新字段 JSON
   * edit / delete：before = 旧正文，after = 新正文
   */
  add(
    world: string,
    entryUid: string,
    kind: 'create' | 'edit' | 'delete' | 'meta',
    before: string,
    after: string,
    label: string,
  ): DraftChange {
    if (kind === 'create') {
      const payload = decodeJsonObject(before);
      return this.addChange({
        kind,
        world,
        uid: entryUid,
        label: label || String(payload.name ?? ''),
        before: '',
        after,
        payload,
      });
    }
    if (kind === 'meta') {
      const oldFields = decodeJsonObject(before);
      const newFields = decodeJsonObject(after);
      return this.addChange({
        kind,
        world,
        uid: entryUid,
        label,
        before: encodeMetaFields(oldFields),
        after: encodeMetaFields(newFields),
        payload: newFields,
      });
    }
    return this.addChange({ kind, world, uid: entryUid, label, before, after, payload: {} });
  }

  list(): DraftChange[] {
    return this.items.slice();
  }

  get(id: string): DraftChange | undefined {
    return this.items.find(item => item.id === id);
  }

  count(): number {
    return this.items.length;
  }

  /** 本轮第几次写入，界面可用来给卡片编号 */
  seqNo(): number {
    return this.seq;
  }

  clear(): void {
    this.items = [];
  }

  remove(id: string): boolean {
    const next = this.items.filter(item => item.id !== id);
    const removed = next.length !== this.items.length;
    this.items = next;
    return removed;
  }

  removeWorld(world: string): number {
    const before = this.items.length;
    this.items = this.items.filter(item => item.world !== world);
    return before - this.items.length;
  }

  ofWorld(world: string): DraftChange[] {
    return this.items.filter(item => item.world === world);
  }

  /** 每处改动的 diff（逐行 +/-） */
  diffs(): DraftDiff[] {
    return this.items.map(change => {
      const lines = change.kind === 'delete' ? lineDiff(change.before, '') : lineDiff(change.before, change.after);
      return { change, lines, stat: diffStat(lines), text: formatDiff(lines, { only_changed: true }) };
    });
  }

  /** 一处改动的摘要，如 '潮听澜 · +2 -1' */
  summary(): string[] {
    return this.diffs().map(item => (item.change.label ? item.change.label + ' · ' : '') + formatStat(item.stat));
  }

  /**
   * 落地：按世界书分组 → readAll → 套用草稿 → writeAll。
   * 只有成功写回的世界书才把对应草稿摘掉；失败的留在仓里，用户可以重试。
   */
  async apply(wb: WorldbookPort, options: { world?: string } = {}): Promise<ApplyReport> {
    const targets = options.world ? [options.world] : unique(this.items.map(item => item.world));
    const worlds: ApplyWorldResult[] = [];
    const warnings: string[] = [];
    const doneIds = new Set<string>();
    for (const world of targets) {
      const changes = this.items.filter(item => item.world === world);
      if (!changes.length) continue;
      if (!world) {
        worlds.push({ world, ok: false, applied: 0, total: changes.length, error: '草稿没有指定世界书名' });
        continue;
      }
      try {
        const entries = await wb.readAll(world);
        const merged = applyChangesToEntries(entries, changes);
        warnings.push(...merged.warnings.map(text => world + '：' + text));
        await wb.writeAll(world, merged.entries);
        for (const change of changes) doneIds.add(change.id);
        worlds.push({ world, ok: true, applied: changes.length, total: changes.length });
      } catch (error) {
        worlds.push({ world, ok: false, applied: 0, total: changes.length, error: errorText(error) });
      }
    }
    this.items = this.items.filter(item => !doneIds.has(item.id));
    const applied = worlds.reduce((sum, item) => sum + item.applied, 0);
    const failed = worlds.reduce((sum, item) => sum + (item.ok ? 0 : item.total), 0);
    return { ok: failed === 0, applied, failed, worlds, warnings, remain: this.items.slice() };
  }
}

export interface ApplyWorldResult {
  world: string;
  ok: boolean;
  applied: number;
  total: number;
  error?: string;
}

export interface ApplyReport {
  ok: boolean;
  applied: number;
  failed: number;
  worlds: ApplyWorldResult[];
  warnings: string[];
  /** 还没落地的草稿 */
  remain: DraftChange[];
}

export function createDraftStore(seed: DraftChange[] = []): DraftStore {
  return new DraftStore(seed);
}

/* ============================ 套用算法 ============================ */

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function payloadNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function payloadBool(payload: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = payload[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(item => item.trim() !== '');
  if (typeof value === 'string') {
    return value
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function payloadKeys(payload: Record<string, unknown>): string[] {
  return toStringArray(payload.keys);
}

/** 蓝绿灯：优先 strategy 枚举，其次吃 constant: boolean 简写 */
function payloadStrategy(payload: Record<string, unknown>, fallback: WbEntry['strategy']): WbEntry['strategy'] {
  const value = payload.strategy;
  if (value === 'constant' || value === 'selective' || value === 'vectorized') return value;
  if (typeof payload.constant === 'boolean') return payload.constant ? 'constant' : 'selective';
  return fallback;
}

const SECONDARY_LOGIC = ['and_any', 'and_all', 'not_all', 'not_any'] as const;

function payloadSecondary(
  payload: Record<string, unknown>,
  fallback: WbEntry['keys_secondary'],
): WbEntry['keys_secondary'] {
  const raw = payload.keys_secondary;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const object = raw as Record<string, unknown>;
    const logic = SECONDARY_LOGIC.find(item => item === object.logic);
    return { logic: logic ?? fallback.logic, keys: toStringArray(object.keys) };
  }
  const keys = toStringArray(raw);
  if (keys.length) return { logic: 'and_any', keys };
  return { logic: fallback.logic, keys: fallback.keys.slice() };
}

function payloadScanDepth(payload: Record<string, unknown>, fallback: WbEntry['scan_depth']): WbEntry['scan_depth'] {
  const value = payload.scan_depth;
  if (value === 'same_as_global') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Math.trunc(Number(value));
  return fallback;
}

export function entryFromPayload(payload: Record<string, unknown>, entryUid: string): WbEntry {
  return {
    uid: entryUid || payloadText(payload, 'uid') || uid('entry'),
    name: payloadText(payload, 'name'),
    content: payloadText(payload, 'content'),
    enabled: payloadBool(payload, 'enabled', true),
    strategy: payloadStrategy(payload, 'selective'),
    keys: payloadKeys(payload),
    keys_secondary: payloadSecondary(payload, { logic: 'and_any', keys: [] }),
    scan_depth: payloadScanDepth(payload, 'same_as_global'),
    position: payloadNumber(payload, 'position', 0),
    depth: payloadNumber(payload, 'depth', 4),
    order: payloadNumber(payload, 'order', 100),
    extra: payload.extra && typeof payload.extra === 'object' ? (payload.extra as Record<string, unknown>) : undefined,
  };
}

export interface MergeResult {
  entries: WbEntry[];
  warnings: string[];
}

/** 把草稿套到条目数组上（纯函数，方便单测） */
export function applyChangesToEntries(entries: WbEntry[], changes: DraftChange[]): MergeResult {
  const next: WbEntry[] = entries.map(entry => ({
    ...entry,
    keys: entry.keys.slice(),
    keys_secondary: { logic: entry.keys_secondary.logic, keys: entry.keys_secondary.keys.slice() },
    extra: entry.extra ? { ...entry.extra } : entry.extra,
  }));
  const warnings: string[] = [];
  for (const change of changes) {
    const payload = (change.payload ?? {}) as Record<string, unknown>;
    if (change.kind === 'create') {
      const entry = entryFromPayload(
        { ...payload, content: change.after || payloadText(payload, 'content') },
        change.uid,
      );
      if (next.some(item => item.uid === entry.uid)) {
        entry.uid = uid('entry');
        warnings.push('新建条目 uid 撞车，已换新 uid');
      }
      next.push(entry);
      continue;
    }
    const index = next.findIndex(item => item.uid === change.uid);
    if (index < 0) {
      warnings.push('找不到 uid ' + change.uid + '，这条改动被跳过');
      continue;
    }
    if (change.kind === 'delete') {
      next.splice(index, 1);
      continue;
    }
    if (change.kind === 'edit') {
      next[index] = { ...next[index], content: change.after };
      continue;
    }
    if (change.kind === 'meta') {
      const current = next[index];
      next[index] = {
        ...current,
        name: 'name' in payload ? payloadText(payload, 'name') : current.name,
        strategy:
          'strategy' in payload || 'constant' in payload
            ? payloadStrategy(payload, current.strategy)
            : current.strategy,
        keys: 'keys' in payload ? payloadKeys(payload) : current.keys,
        keys_secondary:
          'keys_secondary' in payload ? payloadSecondary(payload, current.keys_secondary) : current.keys_secondary,
        scan_depth: 'scan_depth' in payload ? payloadScanDepth(payload, current.scan_depth) : current.scan_depth,
        enabled: 'enabled' in payload ? payloadBool(payload, 'enabled', current.enabled) : current.enabled,
        position: 'position' in payload ? payloadNumber(payload, 'position', current.position) : current.position,
        depth: 'depth' in payload ? payloadNumber(payload, 'depth', current.depth) : current.depth,
        order: 'order' in payload ? payloadNumber(payload, 'order', current.order) : current.order,
      };
      continue;
    }
    warnings.push('未知草稿类型：' + String(change.kind));
  }
  return { entries: next, warnings };
}

/** 草稿卡一行文案 */
export function describeChange(change: DraftChange): string {
  const kindLabel: Record<string, string> = {
    create: '新建',
    edit: '修改',
    delete: '删除',
    meta: '属性',
    worldbook: '世界书',
  };
  return (kindLabel[change.kind] ?? change.kind) + ' · ' + (change.label || change.uid || change.world || '(未命名)');
}
