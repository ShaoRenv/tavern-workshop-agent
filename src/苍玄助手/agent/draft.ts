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
import { nowMs, uid, type DraftChange, type DraftKind, type WbBackup } from '../core/types.ts';
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


/* ============================ 写回前自动备份（P5-2） ============================ */

/**
 * 备份原因：记录页直接显示这两个文案。
 */
export const BACKUP_REASON_APPLY = '写回前自动备份';
export const BACKUP_REASON_ROLLBACK = '回滚前自动备份';

/**
 * 备份钩子。
 *
 * ⚠️ 为什么不直接依赖 store / storage：
 *   `agent/draft.ts` 是可单测的纯逻辑层。备份要落进 `RootData.wb_backups`（那是 store 的地盘），
 *   直接 import 会让 agent 层依赖 store + storage，单测就得先起 pinia + 宿主编译。
 *   所以这里只认一个**注入式接口**：谁装配谁把它接上（界面 / runner 装配时注入真实实现）。
 *   没注入就退化成「不备份 + 一条 warning」—— 见 applyBackup。
 */
export interface BackupSink {
  /**
   * 对某本世界书打一份快照。
   *
   * `entries` 是**写回之前**从宿主读到的**原始**条目（含 `extra`），
   * **不是**合并草稿之后的结果 —— 备份的意义是「写坏之前长什么样」。
   *
   * 实现方要负责限量（例如每本只留最近 3 份），契约不管保留策略。
   * 允许异步（要落 store / 落盘），但**失败不能抛**（见 applyBackup 的 try/catch）。
   */
  snapshot(world: string, entries: WbEntry[], reason: string): void | Promise<void>;
}

/**
 * 打一份备份。**失败绝不影响写回**（备份是兜底，不是门禁），
 * 但必须出一声 + 记一条 warning —— 静默没有兜底 = 假安全感。
 *
 * @returns { ok, warning? } —— ok=false 时 warning 是人话，调用方塞进 ApplyReport.warnings
 */
async function applyBackup(
  sink: BackupSink | null | undefined,
  world: string,
  entries: WbEntry[],
  reason: string,
): Promise<{ ok: boolean; warning?: string }> {
  if (!sink || typeof sink.snapshot !== 'function') {
    const warning = world + '：没有接入备份钩子，本次写回**没有兜底**（' + reason + '）';
    console.warn('[苍玄助手] ' + warning);
    return { ok: false, warning };
  }
  try {
    await sink.snapshot(world, entries, reason);
    return { ok: true };
  } catch (error) {
    const warning = world + '：备份失败，本次写回**没有兜底**（' + reason + '）—— ' + errorText(error);
    console.warn('[苍玄助手] ' + warning, error);
    return { ok: false, warning };
  }
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
  /** 备份钩子（P5-2）：装配时注入；没注入就退化成「不备份 + warning」 */
  private backupSink: BackupSink | null = null;

  constructor(seed: DraftChange[] = [], backupSink: BackupSink | null = null) {
    for (const item of seed) this.items.push(normalizeChange(item));
    this.backupSink = backupSink;
  }

  /**
   * 接上备份钩子（P5-2）。幂等，可以重复接。
   *
   * 为什么单独开一个 setter 而不是只走构造函数：草稿仓在早期就被创建（store 初始化时），
   * 而备份要写进 `RootData.wb_backups`，那时 store 可能还没装配好。
   * 所以允许晚接 —— 早接晚接都不影响「apply 一定在写回前调它」。
   */
  setBackupSink(sink: BackupSink | null): void {
    this.backupSink = sink;
  }

  /** 当前有没有接备份钩子（界面可据此提示「这次写回没有兜底」） */
  hasBackupSink(): boolean {
    return !!this.backupSink && typeof this.backupSink.snapshot === 'function';
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
   * 落地：按世界书分组 → readAll → **备份** → 套用草稿 → writeAll。
   * 只有成功写回的世界书才把对应草稿摘掉；失败的留在仓里，用户可以重试。
   *
   * ⚠️ 备份必须打在 `writeAll` **之前**，而且交出去的是 `readAll` 读到的**原始 entries**
   * （含 extra）——不是合并后的结果。备份的意义是「写坏之前长什么样」，
   * 合并后的已经是新状态，拿它当备份等于没备。
   *
   * ⚠️ 备份失败**不中断**写回（它是兜底不是门禁），但会 warn + 记进 warnings ——
   * 「这次没有兜底」这件事必须让用户看得到。
   */
  async apply(wb: WorldbookPort, options: { world?: string } = {}): Promise<ApplyReport> {
    const targets = options.world ? [options.world] : unique(this.items.map(item => item.world));
    const worlds: ApplyWorldResult[] = [];
    const warnings: string[] = [];
    const backedUp: string[] = [];
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

        // ---- 写回前备份（P5-2）：**原始 entries**，不是 merged ----
        const backup = await applyBackup(this.backupSink, world, entries, BACKUP_REASON_APPLY);
        if (backup.ok) backedUp.push(world);
        else if (backup.warning) warnings.push(backup.warning);

        const merged = applyChangesToEntries(entries, changes);
        warnings.push(...merged.warnings.map(text => world + '：' + text));
        await wb.writeAll(world, merged.entries);

        // ---- 写后回读校验（B3）：`writeAll` 不抛 ≠ 写成功 ----
        // 适配层形状对不上时 ST 会安静地写个空的（阶段 5 那次就是 0 条落盘、零报错）。
        const verify = await verifyWrite(wb, world, merged.entries);
        if (!verify.ok) {
          const detail = verify.error ?? verify.problems.join('；');
          warnings.push(world + '：**写回后回读对不上** —— ' + detail + '（草稿已保留，请核对后再试）');
        }

        // ⚠️ 校验没过时**不摘草稿**：那样用户还有得救（草稿仓里留着，改完能重试）。
        // 摘了就等于「界面说成功、数据没写进去、草稿也没了」—— 最坏的一种组合。
        if (verify.ok) {
          for (const change of changes) doneIds.add(change.id);
        }
        worlds.push({ world, ok: verify.ok, applied: changes.length, total: changes.length, verify });
      } catch (error) {
        worlds.push({ world, ok: false, applied: 0, total: changes.length, error: errorText(error) });
      }
    }
    this.items = this.items.filter(item => !doneIds.has(item.id));
    const applied = worlds.reduce((sum, item) => sum + (item.ok ? item.applied : 0), 0);
    // ⚠️ 回读没过的也算 failed（B3）：`writeAll` 没抛错但数据没落盘时，
    // 旧口径会把它算成 applied —— 那正是「界面显示成功、实际 0 条」的来源。
    const failed = worlds.reduce((sum, item) => sum + (item.ok ? 0 : item.total), 0);
    return { ok: failed === 0, applied, failed, worlds, warnings, backed_up: backedUp, remain: this.items.slice() };
  }

  /**
   * 用一份备份**整本写回**（回滚）。
   *
   * ⚠️ **回滚前必须先对当前状态再备一次**（P5-1 契约的硬要求）：
   *   回滚本身也是一次写入。不作这一层备份的话，用户点错一次回滚就再也回不到回滚之前了 ——
   *   那是「不可撤销」叠「不可撤销」，比不提供回滚还糟（给了假的安心感）。
   *   所以：先 readAll 当前 → snapshot(reason='回滚前自动备份') → 再 writeAll(备份里的 entries)。
   *
   * @returns 回滚结果；ok=false 时 error 是人话。**不抛**。
   */
  async rollback(wb: WorldbookPort, backup: Pick<WbBackup, 'world' | 'entries'>): Promise<RollbackResult> {
    const world = typeof backup?.world === 'string' ? backup.world : '';
    if (!world) return { ok: false, error: '这份备份没记世界书名，没法回滚' };
    const entries = Array.isArray(backup.entries) ? (backup.entries as WbEntry[]) : [];

    try {
      // ① 先读当前状态，并且**再备一次** —— 这是「回滚也可撤销」的唯一保证
      const current = await wb.readAll(world);
      const safety = await applyBackup(this.backupSink, world, current, BACKUP_REASON_ROLLBACK);
      const warnings: string[] = [];
      if (!safety.ok && safety.warning) warnings.push(safety.warning);

      // ② 把备份里的整本 entries 写回去
      await wb.writeAll(world, entries);

      // ③ 回读校验（B3）：阶段 5 那次「界面说换回去 4 条、实际 0 条」就发生在这里。
      const verify = await verifyWrite(wb, world, entries);
      if (!verify.ok) {
        const detail = verify.error ?? verify.problems.join('；');
        warnings.push(world + '：**回滚后回读对不上** —— ' + detail);
      }

      return {
        ok: verify.ok,
        world,
        // restored 报**真的读回来**的条数，不是「我以为写进去的」条数
        restored: verify.actual,
        backed_up_before_rollback: safety.ok,
        verify,
        warnings,
        error: verify.ok ? undefined : (verify.error ?? verify.problems.join('；')),
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }
}
export interface ApplyWorldResult {
  world: string;
  ok: boolean;
  applied: number;
  total: number;
  error?: string;
  /**
   * 写回之后**回读校验**的结果（B3）。
   *
   * `undefined` = 没校验（不该发生，除非回读本身抛了）；
   * `ok: false` = **写进去的和读回来的对不上** —— 这是「界面在撒谎」的唯一解药。
   */
  verify?: VerifyResult;
}

/**
 * 回读校验的结果（B3）。
 *
 * ─────────────────────────── 为什么非要有这个 ───────────────────────────
 *
 * 阶段 5 那份报告里最刺眼的一句（`reports/阶段5-世界书读写全坏-真机发现.md` §7.3）：
 *
 * > 「`rollback()`/`writeAll` 只看有没有抛错，不看写进去的能不能读回来 ——
 * >   这次界面显示『换回去 4 条』而实际 0 条，就是**界面在替底层撒谎**。」
 *
 * `writeAll` 不抛 ≠ 写成功。适配层形状对不上时，ST 会**安安静静地写个空的**
 * （那次就是把数组传给了期望 `{ entries }` 的 `saveWorldInfo`，0 条落盘、零报错）。
 * 所以唯一可信的验收方式是：**写完再读一次，比对**。
 */
export interface VerifyResult {
  ok: boolean;
  /** 期望的条目数（写进去的那份） */
  expected: number;
  /** 回读到的条目数 */
  actual: number;
  /** 对不上时的逐条差异，人话（ok=true 时为空） */
  problems: string[];
  /** 回读本身失败时的人话（此时 actual 记 0） */
  error?: string;
}

/**
 * 写回后回读校验（B3）：读一次，和刚写进去的比。
 *
 * 比三件事（按「用户会先注意到哪个」排）：
 *   ① **条目数** —— 0 条落盘是那次事故的形态，最该先报；
 *   ② **uid 集合** —— 少一条 / 多一条都说明写歪了；
 *   ③ **正文** —— 条数对但内容是旧的是另一种形态（缓存没失效时会这样）。
 *
 * ⚠️ 只比**我们真的写过的东西**（uid / content），不逐字段全比：
 * 宿主可能给条目补默认字段、或把 `extra` 里的东西挪个位置 —— 那些不算失败。
 * 拿「字段全等」当判据会天天误报，最后没人看这条警告（比没有更糟）。
 *
 * **不抛**：回读失败是一种结果（`ok:false` + error），不是异常。
 */
export async function verifyWrite(wb: WorldbookPort, world: string, expected: WbEntry[]): Promise<VerifyResult> {
  const want = Array.isArray(expected) ? expected : [];
  let actual: WbEntry[];
  try {
    actual = await wb.readAll(world);
  } catch (error) {
    return { ok: false, expected: want.length, actual: 0, problems: [], error: errorText(error) };
  }

  const problems: string[] = [];
  if (actual.length !== want.length) {
    problems.push('条目数对不上：写进去 ' + want.length + ' 条，读回来 ' + actual.length + ' 条');
  }

  // uid 集合：用 Map 保留「读回来那份」的引用，方便下面比正文
  const byUid = new Map(actual.map(entry => [entry.uid, entry]));
  const missing = want.filter(entry => !byUid.has(entry.uid)).map(entry => entry.uid);
  if (missing.length) {
    problems.push('这些条目写进去了却读不到：' + missing.slice(0, 5).join('、') + (missing.length > 5 ? ' 等 ' + missing.length + ' 条' : ''));
  }

  // 正文：只在两边都有这条时比（uid 已经缺了的上面报过了，别重复报）
  const changed: string[] = [];
  for (const entry of want) {
    const got = byUid.get(entry.uid);
    if (!got) continue;
    if (got.content !== entry.content) changed.push(entry.uid);
  }
  if (changed.length) {
    problems.push(
      '这些条目读回来的正文和写进去的不一样（可能是旧内容）：' +
        changed.slice(0, 5).join('、') +
        (changed.length > 5 ? ' 等 ' + changed.length + ' 条' : ''),
    );
  }

  return { ok: problems.length === 0, expected: want.length, actual: actual.length, problems };
}

export interface ApplyReport {
  ok: boolean;
  applied: number;
  failed: number;
  worlds: ApplyWorldResult[];
  warnings: string[];
  /**
   * 这次写回**真的备了份**的世界书（P5-2）。
   *
   * 记录页据此显示「本次已自动备份 3 本」；界面上更该显示的是**差集** ——
   * 如果 warnings 里有「没有兜底」，说明这本没备上，那比「备份了」更需要让人看见。
   */
  backed_up: string[];
  /** 还没落地的草稿 */
  remain: DraftChange[];
}

/** 回滚一份备份的结果（P5-2） */
export interface RollbackResult {
  ok: boolean;
  world?: string;
  /** 回滚回去的条目数 */
  restored?: number;
  /**
   * 回滚前有没有成功对当前状态再备一次。
   *
   * ⚠️ false 表示「这次回滚不可撤销」—— 界面必须显示出来，不能让用户以为还能回头。
   */
  backed_up_before_rollback?: boolean;
  /**
   * 回滚后回读校验的结果（B3）。
   *
   * ⚠️ `restored` 现在报的是**回读到的**条数，不是「以为写进去的」条数 ——
   * 阶段 5 那次界面显示「换回去 4 条」而实际 0 条，就是因为旧代码报的是后者。
   */
  verify?: VerifyResult;
  warnings?: string[];
  error?: string;
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
      // ⚠️ edit **不只改正文**（B15-B19 修的 bug）：`wb_write` 一次 update 可以同时改
      // 「正文 + 蓝绿灯 + 顺序」，而 kind='edit' 原来只把 content 换掉 ——
      // 属性那半静默丢了（草稿弹窗显示要改，落地后没改）。
      // 所以 edit = 换正文 **加上** payload 里出现的属性字段。
      next[index] = applyMetaFields({ ...next[index], content: change.after }, payload);
      continue;
    }
    if (change.kind === 'meta') {
      next[index] = applyMetaFields(next[index], payload);
      continue;
    }
    warnings.push('未知草稿类型：' + String(change.kind));
  }
  return { entries: next, warnings };
}

/**
 * 把 payload 里**出现过的**属性字段盖到条目上（没出现的一律原样保留）。
 *
 * 抽出来是因为 `edit` 与 `meta` 两种草稿都要用它：
 *  - `edit`：换了正文，顺带改属性（B15-B19 之后 wb_write 的 update 会一次带多个字段）；
 *  - `meta`：只改属性，不碰正文。
 * 「只改填了的字段」这条语义在**一个地方**实现，两处不会走偏。
 */
function applyMetaFields(entry: WbEntry, payload: Record<string, unknown>): WbEntry {
  return {
    ...entry,
    name: 'name' in payload ? payloadText(payload, 'name') : entry.name,
    strategy:
      'strategy' in payload || 'constant' in payload ? payloadStrategy(payload, entry.strategy) : entry.strategy,
    keys: 'keys' in payload ? payloadKeys(payload) : entry.keys,
    keys_secondary:
      'keys_secondary' in payload ? payloadSecondary(payload, entry.keys_secondary) : entry.keys_secondary,
    scan_depth: 'scan_depth' in payload ? payloadScanDepth(payload, entry.scan_depth) : entry.scan_depth,
    enabled: 'enabled' in payload ? payloadBool(payload, 'enabled', entry.enabled) : entry.enabled,
    position: 'position' in payload ? payloadNumber(payload, 'position', entry.position) : entry.position,
    depth: 'depth' in payload ? payloadNumber(payload, 'depth', entry.depth) : entry.depth,
    order: 'order' in payload ? payloadNumber(payload, 'order', entry.order) : entry.order,
  };
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