/**
 * 苍玄助手 · 持久化层（storage）
 *
 * 职责：
 *  1) 把 `window.TavernHelper` 的全局接口收在一处（薄封装），测试时可以注入假实现；
 *  2) 用酒馆助手「**脚本变量**」保存整棵 RootData（key = types.ts 的 GLOBAL_KEY）；
 *     脚本卸载 / 关闭，数据就跟着没，不在酒馆里留残留。**不碰 window.localStorage**。
 *     script_id 解析链：globalThis.__CX_SCRIPT_ID__（面板脚本注入）→ getScriptId() → 省略；
 *  3) 读的时候**逐块恢复**：某个块坏了就用该块的默认值并 console.warn，
 *     数组块还能逐条兜底（丢掉坏条目、留下好条目），**绝不整体清空**；
 *  4) 写的时候先 zod 校验（顺带修复坏块）再落盘，写失败抛错；另提供防抖保存；
 *  5) 数据是**多会话 + 事件日志 + 合并后的预设**（v4）：读出来的数据一定 version=4、
 *     sessions 至少一条、active_session_id 指得上、tool_overrides 是对象、会话带 events 数组、
 *     预设是 items 形状（没有 kind/system/messages）；
 *     v1 老数据（只有单数 session）由 migrateRootData 包成一条，v2 老数据补覆盖项/事件，
 *     v3 老预设（kind + system/messages）迁进 items，一条记录都不丢。
 *     单数 session 只做兼容读取，落盘时写成空壳，避免聊天记录存两份。
 *
 * 对 store 的接口（lead 约定）：
 *  - `loadData(): unknown`：读出并逐块恢复，永远返回一个尽量合法的结构
 *  - `saveData(data: unknown): void`：校验后写回，失败抛错（store catch 后 warn）
 *
 * ⚠️ 关于「没有数据时返回什么」：约定的说法是「没有就返回 {}」，但实测 zod v4 里
 * `XxxSchema.default({})` 这种写法**不会**把内层字段的 default 填满
 * （`RootDataSchema.parse({})` 会得到 `api: {}`、`gen: {}`、`session: {}`），
 * 于是 store 再 parse 一次也补不出 `gen.image_concurrency` 这类字段。
 * 所以这里没有数据时返回的是**各块都填满 default 的默认 RootData**（是 {} 的超集，
 * store 直接 parse 也安全）。已在汇报里把这个 types.ts 的坑报给 lead。
 *
 * 设计约定：
 *  - 这里只碰 types.ts 的数据结构，不引入任何新依赖
 *  - portrait.ts / worldbook.ts 需要宿主接口时都从这里取，避免各处直接摸全局
 *  - 假实现注入方式：setHostBridge({ getVariables: () => ({...}), ... })
 */
import {
  DATA_VERSION,
  DEFAULT_SESSION_TITLE,
  GLOBAL_KEY,
  RootDataSchema,
  makeSession,
  migratePresetItems,
  sessionTitle,
  type RootData,
  type Session,
} from './types.ts';
import type { ZodType } from 'zod';

/* ============================ 宿主接口薄封装 ============================ */

/** 宿主接口的统一签名；参数与返回值都按酒馆助手的原始约定 */
export type HostFn = (...args: any[]) => any;

/** 可注入的宿主接口表：key 就是酒馆助手接口名 */
export type HostBridge = Record<string, HostFn | undefined>;

let injectedBridge: HostBridge | null = null;

/** 注入假实现（测试用）；传 null 恢复成读真实全局 */
export function setHostBridge(bridge: HostBridge | null): void {
  injectedBridge = bridge;
}

/** 取当前注入的宿主接口表；没注入过返回 null */
export function getHostBridge(): HostBridge | null {
  return injectedBridge;
}

/**
 * 按名字取宿主接口。
 *
 * 查找顺序：注入的假实现 → window.TavernHelper[name] → 全局同名函数。
 * 找不到返回 null（调用方自己决定是抛错还是降级），不做任何缓存，
 * 这样界面运行时接口晚一点就绪也能拿到。
 */
export function hostFn(name: string): HostFn | null {
  const injected = injectedBridge?.[name];
  if (typeof injected === 'function') return injected;

  const scope = typeof globalThis === 'undefined' ? null : (globalThis as Record<string, any>);
  if (!scope) return null;

  const helper = scope.TavernHelper;
  if (helper && typeof helper[name] === 'function') {
    return (...args: any[]) => helper[name](...args);
  }
  if (typeof scope[name] === 'function') {
    return (...args: any[]) => scope[name](...args);
  }
  return null;
}

/** 宿主接口在不在（界面可用来显示「未连接」） */
export function hasHostFn(name: string): boolean {
  return hostFn(name) !== null;
}

/** 普通对象判断（排除数组与 null） */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ============================ 变量作用域：脚本变量 ============================ */

/** 酒馆助手的变量作用域参数；数据一律放脚本变量 */
export interface VariableScope {
  type: 'script';
  /** 省略 = 当前脚本（脚本内调用时可以直接省） */
  script_id?: string;
}

/**
 * 解析当前脚本 id。
 *
 * 顺序：面板脚本注入的 `globalThis.__CX_SCRIPT_ID__` → 酒馆助手的 `getScriptId()` → undefined（省略）。
 * 每次调用都重新解析，不缓存：万一注入晚于首次读取也能跟上。
 */
export function resolveScriptId(): string | undefined {
  const injected = (globalThis as Record<string, unknown>).__CX_SCRIPT_ID__;
  if (typeof injected === 'string' && injected.trim() !== '') return injected.trim();

  const getScriptId = hostFn('getScriptId');
  if (getScriptId) {
    try {
      const id = getScriptId();
      if (typeof id === 'string' && id.trim() !== '') return id.trim();
    } catch (error) {
      console.warn('[苍玄助手] getScriptId 失败，改用脚本内默认作用域', error);
    }
  }
  return undefined;
}

/** 所有 getVariables / insertOrAssignVariables / replaceVariables / updateVariablesWith 都用它 */
export function scriptScope(): VariableScope {
  const script_id = resolveScriptId();
  return script_id === undefined ? { type: 'script' } : { type: 'script', script_id };
}

/* ============================ 多会话迁移（v1 → v2） ============================ */

export interface MigrateResult {
  data: RootData;
  warnings: string[];
  /** 是否真的把 v1 的单会话搬进了 sessions */
  migrated: boolean;
}

/**
 * 老数据里有没有「用过」的痕迹；空会话不值得迁移，直接给个新的「新对话」。
 * 只要求这几个字段：v1/v2 的单数 session（LegacySession）也传得进来。
 */
function hasLegacyTrace(session: Pick<Session, 'turns' | 'preset_id' | 'round' | 'started_at' | 'running'>): boolean {
  return session.turns.length > 0 || session.preset_id !== '' || session.round > 0 || session.started_at > 0 || session.running;
}

/**
 * 会话时间兜底：缺就用第一条 / 最后一条 turn 的时间，实在没有就 0。
 * 故意**不取当前时间**，这样迁移是纯函数、可重复、可单测。
 */
function sessionTimes(session: Session): { created_at: number; updated_at: number } {
  const first = session.turns[0]?.at ?? 0;
  const last = session.turns[session.turns.length - 1]?.at ?? 0;
  const created = session.created_at > 0 ? session.created_at : session.started_at > 0 ? session.started_at : first;
  const updated = session.updated_at > 0 ? session.updated_at : last > 0 ? last : created;
  return { created_at: created, updated_at: updated };
}

/** 单条会话归一化：补 id / 标题 / 时间 / events（不改入参） */
function normalizeSession(session: Session, fallbackId: string): Session {
  const id = session.id.trim() !== '' ? session.id : fallbackId;
  // v2 老数据没有 events：补空数组（仅追加流从这里开始），不是坏数据、不报警
  const events = Array.isArray(session.events) ? session.events : [];
  return { ...session, id, title: sessionTitle(session), events, ...sessionTimes(session) };
}

/** 空壳：v1 的单数 session 字段落盘时写它，避免同一份聊天记录存两份 */
function legacyShell(): Session {
  return makeSession({ id: 'sess-shell' });
}

/**
 * 迁移 + 归一化，**纯函数**（recoverRootData / importAll 都调它）。
 *
 * v1 → v2（会话）：
 *  1) 有 session 没 sessions → 把 session 包成 sessions 的一条，active_session_id 指向它；
 *     老会话是空的（没 turns / 没预设痕迹）就建个「新对话」
 *  2) 混合形态（sessions 有内容、version 还是 1、单数 session 也有痕迹）→ 并进去，不丢
 * v2 → v3：
 *  3) 缺 tool_overrides → 补 {}（不报错、幂等；老数据原样读出）
 *  4) Session.events 缺失 → 补空数组（旧数据一律补空，仅追加流从这以后开始）
 *  5) 草稿归属会话：drafts 里 session_id 为空的老草稿 → 盖上当前会话 id
 * v3 → v4（预设合并，本次）：
 *  6) 老预设（kind + system/messages）→ items[]；能力口径按老 kind 分开：
 *     老 agent → use_global_caps=false（跟随「能力」页全局），
 *     老 plain → use_global_caps=true + tools=[]（不跟随全局，自己一条工具都没有）。
 *     形状归一化在 schema 层（PresetSchema 的 z.preprocess → migratePresetItems），
 *     这里按版本再兜一遍：所有读入口都过它，老预设一条都不丢，且幂等。
 * 通用：
 *  7) 每条会话补齐 id / 标题 / 时间；sessions 为空补一条「新对话」；active 指不上修到第一条
 *  8) version 提到 DATA_VERSION；单数 session 写成空壳（真数据只在 sessions 里）
 *
 * 幂等：对已经迁移过的数据再跑一次，结果完全一致、migrated=false、无警告。
 */
export function migrateRootData(data: RootData): MigrateResult {
  const warnings: string[] = [];
  let migrated = false;

  const source: Session[] = Array.isArray(data.sessions) ? data.sessions.slice() : [];
  const legacy = data.session;
  const legacyTrace = hasLegacyTrace(legacy);
  const legacyId = legacy.id.trim();
  // v1 才是「单数 session」时代；v2 之后单数 session 只是兼容字段，
  // 所以「老数据里没会话 → 建新对话」的警告只属于 v1 迁移，不再对 v2 乱报。
  const singleSessionEra = data.version < 2;

  if (source.length === 0 && (singleSessionEra || legacyTrace)) {
    if (legacyTrace) {
      const wrapped = normalizeSession(makeSession({ ...legacy, id: legacyId || 'sess-legacy' }), 'sess-legacy');
      source.push(wrapped);
      migrated = true;
      warnings.push('检测到 v1 单会话数据，已迁移成会话「' + sessionTitle(wrapped) + '」');
    } else {
      source.push(makeSession({ id: 'sess-default', title: DEFAULT_SESSION_TITLE }));
      migrated = true;
      warnings.push('老数据里没有会话内容，已建一个空白会话');
    }
  } else if (singleSessionEra && legacyTrace && !source.some(session => session.id === legacyId)) {
    // 边角形态：既有 sessions 又残留单数 session，合并而不是丢掉
    const wrapped = normalizeSession(makeSession({ ...legacy, id: legacyId || 'sess-legacy' }), 'sess-legacy');
    source.push(wrapped);
    migrated = true;
    warnings.push('检测到残留的单会话数据，已并入会话列表');
  }

  const sessions = source.map((session, index) => normalizeSession(session, 'sess-' + String(index + 1)));

  if (sessions.length === 0) {
    // 干净数据里 sessions 为空不算「坏」，只是还没建会话：静默补一条，
    // 免得每次读盘都刷一条警告（v1 的迁移事件在上面的分支里已经报过了）。
    sessions.push(makeSession({ id: 'sess-default', title: DEFAULT_SESSION_TITLE }));
  }

  const activeSessionId = sessions.some(session => session.id === data.active_session_id)
    ? data.active_session_id
    : sessions[0].id;

  // ---- v2 → v3：覆盖项、事件、草稿归属 ----
  const toolOverrides = isPlainRecord(data.tool_overrides) ? data.tool_overrides : {};
  const drafts = (Array.isArray(data.drafts) ? data.drafts : []).map(draft =>
    // 老草稿没归属：认到当前会话上，runner 才能按会话取草稿
    draft.session_id === '' ? { ...draft, session_id: activeSessionId } : draft,
  );

  // ---- v3 → v4：预设合并（去 kind；system / messages → items） ----
  // schema 层已经归一化过一遍，这里按版本再兜一遍：老数据（<4）走同一条路，
  // 新数据是 identity（migratePresetItems 认出已是新形状就原样返回）。
  const presets = (Array.isArray(data.presets) ? data.presets : []).map(
    preset => migratePresetItems(preset) as typeof preset,
  );

  if (data.version < DATA_VERSION) migrated = true;

  return {
    data: {
      ...data,
      version: DATA_VERSION,
      sessions,
      active_session_id: activeSessionId,
      session: legacyShell(),
      tool_overrides: toolOverrides,
      drafts,
      presets,
    },
    warnings,
    migrated,
  };
}

/* ============================ 逐块恢复 ============================ */

/** RootData 的顶层块；顺序与 types.ts 一致 */
const BLOCK_KEYS = [
  'version',
  'active_tab',
  'api',
  'gen',
  'plugins',
  'presets',
  'skills',
  'active_preset_id',
  'selection',
  'tool_overrides',
  'sessions',
  'active_session_id',
  'session',
  'drafts',
  'artifacts',
] as const;
type BlockKey = (typeof BLOCK_KEYS)[number];

export interface RecoverResult {
  data: RootData;
  /** 恢复过程中发现的问题（界面可以拿去提示用户） */
  warnings: string[];
}

function blockSchema(key: BlockKey): ZodType {
  const shape = RootDataSchema.shape as unknown as Record<BlockKey, ZodType>;
  return shape[key];
}

function firstIssueMessage(error: unknown): string {
  const issues = (error as { issues?: { message?: string; path?: unknown[] }[] } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return '未知校验错误';
  const issue = issues[0];
  const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') + ': ' : '';
  return path + (issue.message ?? '校验失败');
}

/** 剥掉 `.default()` 这类外壳，拿到里面的真实 schema（数组块的 `.element` 在外壳里面） */
function unwrapSchema(schema: ZodType): ZodType {
  const unwrap = (schema as unknown as { unwrap?: () => ZodType }).unwrap;
  if (typeof unwrap !== 'function') return schema;
  try {
    return unwrap.call(schema);
  } catch {
    return schema;
  }
}

/**
 * 取某一块的默认值。
 *
 * zod v4 里 `schema.default({})` 的默认值不会再跑一遍内层 parse，所以
 * `safeParse(undefined)` 拿到的对象块可能是空壳（例如 `gen: {}`）。
 * 这里对对象结果**再 parse 一次**，让内层字段的 default 真正填满。
 */
function blockDefault(schema: ZodType, fallback: unknown): unknown {
  const first = schema.safeParse(undefined);
  let value: unknown = first.success ? first.data : fallback;
  if (isPlainRecord(value)) {
    const second = schema.safeParse(value);
    if (second.success) value = second.data;
  }
  return value;
}

/** 一份各块都填满 default 的默认数据 */
export function defaultRootData(): RootData {
  const out: Record<string, unknown> = {};
  for (const key of BLOCK_KEYS) {
    out[key] = blockDefault(blockSchema(key), undefined);
  }
  return out as RootData;
}

/**
 * 恢复单个块。
 *
 * - 整块合法：直接用 zod 解析结果（老数据缺字段由 default 自动补）
 * - 数组块：逐条校验，合法条目保留、非法条目丢掉并警告（比整块清空安全）
 * - 其余块：用该块的默认值兜底并警告
 */
function recoverBlock(key: BlockKey, value: unknown, warnings: string[]): unknown {
  const schema = blockSchema(key);
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const element = (unwrapSchema(schema) as unknown as { element?: ZodType }).element;
  if (Array.isArray(value) && element) {
    const kept: unknown[] = [];
    let dropped = 0;
    for (const item of value) {
      const one = element.safeParse(item);
      if (one.success) kept.push(one.data);
      else dropped += 1;
    }
    const message = `存储块 ${key} 有 ${dropped} 条数据不合法（已丢弃），保留 ${kept.length} 条`;
    warnings.push(message);
    console.warn('[苍玄助手] ' + message);
    return kept;
  }

  // 记录块（z.record，例如 tool_overrides）：逐条兜底，坏键丢掉、好键保留，
  // 和数组块一个道理——不能因为一个键写歪了就把整张表清空。
  const valueSchema = (unwrapSchema(schema) as unknown as { valueType?: ZodType }).valueType;
  if (isPlainRecord(value) && valueSchema) {
    const kept: Record<string, unknown> = {};
    let dropped = 0;
    for (const [itemKey, item] of Object.entries(value)) {
      const one = unwrapSchema(valueSchema).safeParse(item);
      if (one.success) kept[itemKey] = one.data;
      else dropped += 1;
    }
    const message = `存储块 ${key} 有 ${dropped} 项数据不合法（已丢弃），保留 ${Object.keys(kept).length} 项`;
    warnings.push(message);
    console.warn('[苍玄助手] ' + message);
    return kept;
  }

  const message = `存储块 ${key} 校验失败，已用默认值恢复：${firstIssueMessage(parsed.error)}`;
  warnings.push(message);
  console.warn('[苍玄助手] ' + message, value);
  return blockDefault(schema, undefined);
}

/**
 * 把任意读出来的内容恢复成完整 RootData。
 *
 * 纯函数、不碰宿主、不抛异常：坏数据永远不会把整份配置清空。
 */
export function recoverRootData(raw: unknown): RecoverResult {
  const warnings: string[] = [];
  const fallback = defaultRootData();

  if (raw === null || raw === undefined) return finalizeRecovered(fallback, warnings);

  if (!isPlainRecord(raw)) {
    const message = `脚本变量 ${GLOBAL_KEY} 不是对象，已整体回退为默认值`;
    warnings.push(message);
    console.warn('[苍玄助手] ' + message);
    return finalizeRecovered(fallback, warnings);
  }

  const out: Record<string, unknown> = {};
  for (const key of BLOCK_KEYS) {
    out[key] = recoverBlock(key, raw[key], warnings);
  }

  return finalizeRecovered(out as RootData, warnings);
}

/**
 * 恢复收尾：报告版本差异 → 跑多会话迁移 / 归一化。
 *
 * 所有出口都走它，所以「没有任何数据」这条路径也会得到一个合法结构
 * （sessions 至少一条、active_session_id 指得上）。
 */
function finalizeRecovered(recovered: RootData, warnings: string[]): RecoverResult {
  // 只有**比当前版本新**的数据才在这里报（可能读不懂）；老数据一律交给
  // migrateRootData 的迁移警告，免得每次读 v1/v2 文件都刷一句版本不一致。
  if (typeof recovered.version === 'number' && recovered.version > DATA_VERSION) {
    const message = `数据版本 ${recovered.version} 与当前版本 ${DATA_VERSION} 不一致，已按当前版本读取`;
    warnings.push(message);
    console.warn('[苍玄助手] ' + message);
  }

  const migration = migrateRootData(recovered);
  for (const warning of migration.warnings) console.warn('[苍玄助手] ' + warning);
  warnings.push(...migration.warnings);

  return { data: migration.data, warnings };
}

/* ============================ 读 ============================ */

/** 从酒馆助手**脚本变量**读出原始内容；读不到返回 null（由调用方兜底） */
export function readStoredRootData(): unknown {
  const getVariables = hostFn('getVariables');
  if (!getVariables) {
    console.warn('[苍玄助手] 找不到 getVariables（不在酒馆环境？），本次使用默认数据');
    return null;
  }
  try {
    const table = getVariables(scriptScope());
    if (!isPlainRecord(table)) return null;
    return table[GLOBAL_KEY];
  } catch (error) {
    console.warn('[苍玄助手] 读取脚本变量失败，本次使用默认数据', error);
    return null;
  }
}

/**
 * 给 store 用的读入口：读出 → 逐块恢复。
 *
 * 返回的对象各块都合法（坏块已换默认值 + console.warn），
 * store 直接 `RootDataSchema.parse(loadData())` 即可。
 */
export function loadData(): unknown {
  return recoverRootData(readStoredRootData()).data;
}

/** 强类型版本：界面内部用 */
export function loadRootData(): RootData {
  return loadData() as RootData;
}

/* ============================ 写 ============================ */

/** 转成纯 JSON 值（去掉 undefined / 类实例，保证能存进酒馆变量） */
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 真正落盘：写进**脚本变量**表。
 *
 * 优先 `insertOrAssignVariables`（只动我们那一个 key，别的变量不受影响），
 * 退而求其次用 `replaceVariables` / `updateVariablesWith`（读出整表再合并写回）。
 *
 * @returns 是否写成功；没有任何可用接口时返回 false
 */
function writeRawRootData(payload: unknown): boolean {
  try {
    const insertOrAssign = hostFn('insertOrAssignVariables');
    if (insertOrAssign) {
      insertOrAssign({ [GLOBAL_KEY]: payload }, scriptScope());
      return true;
    }

    const getVariables = hostFn('getVariables');

    const replace = hostFn('replaceVariables');
    if (replace && getVariables) {
      const table = getVariables(scriptScope());
      const next = isPlainRecord(table) ? { ...table, [GLOBAL_KEY]: payload } : { [GLOBAL_KEY]: payload };
      replace(next, scriptScope());
      return true;
    }

    const updateWith = hostFn('updateVariablesWith');
    if (updateWith) {
      updateWith(
        (table: Record<string, unknown>) => (isPlainRecord(table) ? { ...table, [GLOBAL_KEY]: payload } : { [GLOBAL_KEY]: payload }),
        scriptScope(),
      );
      return true;
    }
  } catch (error) {
    console.warn('[苍玄助手] 写入脚本变量失败', error);
    return false;
  }

  return false;
}

/**
 * 给 store 用的写入口：先校验（坏块顺带修复），再写回脚本变量。
 *
 * @throws 写不进去时抛错（store 会 catch 并 warn），校验失败的块不会抛而是被修复
 */
export function saveData(data: unknown): void {
  const { data: safe, warnings } = recoverRootData(data);
  if (warnings.length > 0) {
    console.warn('[苍玄助手] 保存前修复了 ' + warnings.length + ' 处数据问题');
  }
  const written = writeRawRootData(toPlainJson(safe));
  if (!written) throw new Error('保存失败：没有可用的酒馆助手脚本变量接口（insertOrAssignVariables / replaceVariables / updateVariablesWith）');
}

/** 强类型 + 布尔返回版本：不抛错，失败返回 false（界面内部用） */
export function saveRootData(data: RootData): boolean {
  try {
    saveData(data);
    return true;
  } catch (error) {
    console.warn('[苍玄助手] saveRootData 失败', error);
    return false;
  }
}

/* ============================ 防抖保存 ============================ */

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: RootData | null = null;

/** 防抖保存：多次调用只写最后一次；真正落盘前依然会校验 */
export function saveRootDataDebounced(data: RootData, delayMs = 400): void {
  pendingData = data;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, Math.max(0, delayMs));
}

/** 立刻落盘挂起的保存；没有挂起的返回 false */
export function flushSave(): boolean {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingData === null) return false;
  const data = pendingData;
  pendingData = null;
  return saveRootData(data);
}

/** 丢掉挂起的保存（例如界面卸载且用户已放弃修改） */
export function cancelPendingSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingData = null;
}

/** 有没有还没落盘的改动 */
export function hasPendingSave(): boolean {
  return pendingData !== null;
}
/* ============================ 导入 / 导出 ============================ */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 导出整份配置为 JSON 文本（工具 → 导入/导出用）。
 *
 * @param includeKey 是否带上 api.key；false 时把 key 置空，方便把配置分享给别人
 * @param data 要导出的数据；不传就读当前脚本变量里的（读出时已逐块恢复）
 */
export function exportAll(includeKey: boolean, data?: RootData): string {
  const source = data === undefined ? loadRootData() : recoverRootData(data).data;
  const safe = toPlainJson(source);
  if (!includeKey) safe.api.key = '';
  return JSON.stringify(safe, null, 2);
}

/**
 * 从 JSON 文本导入整份配置。
 *
 * JSON.parse → RootDataSchema.parse → 多会话迁移（导 v1 老文件进来也不会丢聊天记录）；
 * 坏了返回 {ok:false, error}，**绝不抛**。
 * 只返回数据、不落盘：调用方看过之后再 saveData(data)。
 */
export function importAll(text: string): { ok: boolean; data?: RootData; error?: string } {
  try {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (raw === '') return { ok: false, error: '导入内容为空' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: '不是合法的 JSON：' + errorText(error) };
    }

    const result = RootDataSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: '数据结构不对：' + firstIssueMessage(result.error) };
    }

    // 老文件（v1、只有 session）也在这里被包成 sessions 的一条
    return { ok: true, data: migrateRootData(result.data).data };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
