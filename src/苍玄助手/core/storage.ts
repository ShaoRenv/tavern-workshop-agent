/**
 * 苍玄助手 · 持久化层（storage）
 *
 * 职责：
 *  1) 宿主接口一律转发 core/host.ts 的**唯一一条** provider chain（本文件不再自己实现链），
 *     测试用 setHostBridge 注入假实现；
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
  migratePluginSwitch,
  migratePresetItems,
  sessionTitle,
  type RootData,
  type Session,
} from './types.ts';
import type { ZodType } from 'zod';
import { getHostBridge as getInjectedBridge, hostFn, setHostBridge as setInjectedBridge } from './host.ts';
import type { HostProviderTable } from './host.ts';
import { dataScope as nativeDataScope, declareNativeKey } from './native.ts';

/*
 * ⚠️ P4-10b（**冷启动读不到数据**的根因）——
 *
 * ST 原生变量**不能枚举**（只有按 key 的 get/set）。core/native.ts 的
 * getVariables 是按一张「已知键清单」逐个 get 拼出来的，所以**那张清单必须有内容**，
 * 否则冷启动（刚刷新）时清单为空 → 返回 {} → 上层读不到 GLOBAL_KEY → 用默认值
 * → 紧接着写回默认值 → **用户数据被覆盖**。
 *
 * 所以这里在**模块加载时**就把「我们要读哪个键」声明出去（静态事实，冷启动即成立），
 * 而不是等运行期「写过什么」再记（那是运行期副产品，冷启动必然为空）。
 *
 * 层次：native.ts 不认识任何业务键名，键由 storage 注入 —— 依赖方向仍是 storage → native。
 */
declareNativeKey('global', GLOBAL_KEY);
declareNativeKey('local', GLOBAL_KEY);

/* ============================ 宿主接口：转发 core/host.ts 的唯一一条链 ============================ */

/**
 * 宿主接口薄封装 —— **这里不再自己实现解析链**，一律转发 core/host.ts。
 *
 * 审计出来的三条平行链（storage.ts 的 hostFn / transport.ts 的 globalFunction /
 * macros.ts 的裸读 globalThis）已经收敛成 core/host.ts 里的**一条** provider chain。
 * 保留下面这几个名字，只是为了让既有调用点（portrait / worldbook / adapters /
 * plugins.host）与既有测试的 import 不用改。
 *
 * 解析顺序见 host.ts：注入的假实现 → 注册的原生适配器 → TavernHelper[name] → globalThis[name]。
 * 晚绑定：每次调用重新走一遍整条链，不做任何缓存。
 */

/** 可注入的宿主接口表：key 就是酒馆助手接口名 */
export type HostBridge = HostProviderTable;

export { hostFn, hasHostFn } from './host.ts';
export type { HostFn, HostProviderTable } from './host.ts';

/** 注入假实现（测试用）；传 null 恢复成读真实宿主 */
export function setHostBridge(bridge: HostBridge | null): void {
  setInjectedBridge(bridge);
}

/** 取当前注入的宿主接口表；没注入过返回 null */
export function getHostBridge(): HostBridge | null {
  return getInjectedBridge();
}

/** 普通对象判断（排除数组与 null） */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ============================ 变量作用域 ============================ */

/**
 * 酒馆助手的变量作用域参数。
 *
 * ⚠️ P4-10 起**不只 script 一种**：扩展形态没有脚本，必须用 global 才读得回来
 * （详见 core/native.ts 的 dataScope 注释与下面的 resolveDataScope）。
 * script 这一档**原样保留** —— 老用户的数据就在脚本作用域里，删档等于搬家搬丢。
 */
export interface VariableScope {
  /** script = 酒馆助手的脚本变量；global = 酒馆全局变量（跨会话）；chat = 当前聊天 */
  type: 'script' | 'global' | 'chat';
  /** 仅 type='script' 用；省略 = 当前脚本（脚本内调用时可以直接省） */
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

/**
 * 所有 getVariables / insertOrAssignVariables / replaceVariables / updateVariablesWith 都用它。
 *
 * ⚠️ 保留原样（脚本形态仍要用，见 P4-10 的结论）。
 * **扩展形态请用 resolveDataScope()** —— 它会在没有脚本时自动切到 global，
 * 而本函数在扩展形态会返回一个必然抛错的裸 script 作用域（那正是 P4-10 的 bug 源）。
 */
export function scriptScope(): VariableScope {
  const script_id = resolveScriptId();
  return script_id === undefined ? { type: 'script' } : { type: 'script', script_id };
}

/* ==================== 数据作用域：读与写**必须**共用同一个 ==================== */

/**
 * 当前该用哪个作用域存整棵 RootData。
 *
 * ⚠️ **读和写都调它**，而且同一次会话内结果被缓存（见 dataScopeCache）——
 * 「读在 A 作用域、写在 B 作用域」正是 P4-10 那个数据丢失 bug 的病根。
 *
 * 分流规则（由 core/native.ts 的 dataScope 定，那边有完整的取舍说明）：
 *   - 脚本形态（能拿到 script_id）→ { type: 'script', script_id }  ← 老数据原地不动
 *   - 扩展形态（没有脚本这层）    → { type: 'global' }              ← 跨刷新、跨会话
 *
 * 为什么缓存：作用域必须在**一次会话里稳定**。若中途从 script 漂到 global，
 * 就会出现「读在 A、写在 B」的错位 —— 哪怕只漂一次也会丢数据。
 * 缓存的是**已确定的**作用域；第一次调用时若还判不准（宿主没就绪），
 * 返回一个临时值但**不写缓存**，等下一次判准了再定下来。
 */
let dataScopeCache: VariableScope | null = null;

/** 测试用：清掉作用域缓存（也用于「换聊天 / 重载」后强制重新判定） */
export function resetDataScope(): void {
  dataScopeCache = null;
}

export function resolveDataScope(): VariableScope {
  if (dataScopeCache) return dataScopeCache;

  const scope = nativeDataScope() as VariableScope;
  // 脚本形态 / 扩展形态都能**确定**下来的才缓存。
  // 判不准的情形（宿主的 getScriptId 晚就绪）不缓存，下次再判。
  if (scope.type === 'global' || (scope.type === 'script' && scope.script_id)) {
    dataScopeCache = scope;
  }
  return scope;
}

/**
 * 数据存在哪儿（人话）。界面上说明 / 排查问题时用；不会抛。
 */
export function describeStorageScope(): string {
  try {
    const scope = resolveDataScope();
    if (scope.type === 'script') return '脚本变量' + (scope.script_id ? '（' + scope.script_id + '）' : '');
    if (scope.type === 'global') return '酒馆全局变量（跨会话）';
    return '当前聊天变量';
  } catch {
    return '未知';
  }
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
 * v4 → v5（插件化，本次）：
 *  9) 插件开关搬家：plugins.<id>.enabled → plugin_state.<id>.enabled（老值照搬，缺省 false）。
 *     之后插件自己的设置里不再有 enabled（开关是底座的）。幂等：v5 数据再跑一遍不动它。
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

  // ---- v4 → v5：插件开关搬家（plugins.<id>.enabled → plugin_state.<id>.enabled） ----
  // 老数据里只有生图一个插件；别的插件没有历史开关，缺省交给 manifest.defaultEnabled。
  const pluginState: Record<string, { enabled?: boolean } | undefined> = isPlainRecord(
    (data as unknown as Record<string, unknown>).plugin_state,
  )
    ? { ...((data as unknown as Record<string, unknown>).plugin_state as Record<string, { enabled?: boolean }>) }
    : {};
  const oldImageConfig = isPlainRecord(data.plugins?.image) ? (data.plugins.image as unknown as Record<string, unknown>) : null;
  if (oldImageConfig && 'enabled' in oldImageConfig) {
    if (!isPlainRecord(pluginState.image)) {
      pluginState.image = { enabled: oldImageConfig.enabled === true };
    }
    migrated = true;
  }

  if (data.version < DATA_VERSION) migrated = true;

  // 老插件设置里残留的 enabled 去掉（开关已经搬到 plugin_state）
  const plugins = isPlainRecord(data.plugins)
    ? { ...(data.plugins as unknown as Record<string, unknown>) }
    : {};
  if (isPlainRecord(plugins.image) && 'enabled' in (plugins.image as Record<string, unknown>)) {
    const next = { ...(plugins.image as Record<string, unknown>) };
    delete next.enabled;
    plugins.image = next;
  }

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
      plugins: plugins as typeof data.plugins,
      plugin_state: pluginState,
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
  'plugin_state',
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
  // ⚠️ 新块必须登记在这张表里：不在表里的键会在「逐块恢复」时被丢掉 =
  // 刷新一次世界书备份就全没了（跟当初「冷启动读不到数据」是同一类坑）。
  'wb_backups',
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

  // v4 → v5 的插件开关搬家必须在 parse 之前（schema 会把老字段当未知键丢掉）
  const lifted = migratePluginSwitch(raw) as Record<string, unknown>;
  if (!isPlainRecord(lifted)) {
    const message = `脚本变量 ${GLOBAL_KEY} 不是对象，已整体回退为默认值`;
    warnings.push(message);
    console.warn('[苍玄助手] ' + message);
    return finalizeRecovered(fallback, warnings);
  }

  const out: Record<string, unknown> = {};
  for (const key of BLOCK_KEYS) {
    out[key] = recoverBlock(key, lifted[key], warnings);
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

/**
 * 上一次读盘的结果。P4-10 的**保护**靠它（比修作用域更重要的一条）。
 *
 * 历史事故：读失败时只 console.warn 一句就返回 null → store 用默认值启动 →
 * 紧接着的 save 把**默认值**写回去 → 用户数据被静默覆盖。
 * 「刷新一次，设置全没」就是这么来的。
 *
 * 现在读的结果记在这里，写路径据此决定**要不要拦**：
 *   - 'ok'        读到了真数据（哪怕是个老版本）→ 照常允许写
 *   - 'empty'     读通了，但存储里确实**没有**我们的 key（全新用户）→ 允许写
 *   - 'failed'    读**失败**（接口缺失 / 抛错 / 拿到非对象）→ **拦住**用默认值覆盖
 *   - null        还没读过（此时写是允许的：调用方可能只是直接 set 数据，没有读的过程）
 */
type LoadOutcome = 'ok' | 'empty' | 'failed';
let lastLoadOutcome: LoadOutcome | null = null;

/** 上一次读盘的结果（界面 / 测试可以据此显示「存储读取失败」） */
export function getLastLoadOutcome(): LoadOutcome | null {
  return lastLoadOutcome;
}

/** 测试 / 重载用：把读盘结果清回「还没读过」 */
export function resetLoadOutcome(): void {
  lastLoadOutcome = null;
  failedLoadSnapshot = null;
}

/**
 * 从**数据作用域**读出原始内容；读不到返回 null（由调用方兜底）。
 *
 * ⚠️ P4-10 修的是这里：以前无条件用 scriptScope()，扩展形态下那个作用域会抛
 * 「未指定 script_id」。现在用 resolveDataScope() —— 扩展形态自动落到 global，
 * **读得回来**。写路径用的是同一个 resolveDataScope()，读写不再错位。
 *
 * 读的结果会记进 lastLoadOutcome，供写路径的「不许覆盖」保护使用。
 */
export function readStoredRootData(): unknown {
  // ⚠️ **先声明我们固定要读的键**（P4-10b）。ST 原生的变量接口**不能枚举**
  // （只有按 key 的 get/set），所以原生适配器的「读整表」= 按一张**已知键清单**逐个 get。
  // 那张清单如果只记「本进程写过什么」，**冷启动（刚刷新页面）时就是空的** →
  // getVariables 返回 {} → 上层以为没数据 → 用默认值 → 紧接着写回默认值 → **用户数据被覆盖**。
  // 真机上就是这么丢的：改完立刻读是对的，刷新后就没了。
  //
  // 在这里声明而不是在模块顶层：适配器表可能在 storage.ts 被 import 之前就建好了
  // （扩展 activate 注册适配器 → 之后才 mount 界面），而 declaredSeeds 是模块级累积的，
  // 所以在这里补声明一定来得及；模块顶层声明则依赖 import 顺序，靠不住。
  //
  // 两个作用域都声明：适配器按 scope 的**类型**决定去 variables.local 还是 .global 读，
  // 而 resolveDataScope() 在脚本形态给 script / 扩展形态给 global —— 两条路都要能读到。
  declareNativeKey('global', GLOBAL_KEY);
  declareNativeKey('local', GLOBAL_KEY);

  const getVariables = hostFn('getVariables');
  if (!getVariables) {
    lastLoadOutcome = 'failed';
    rememberFailedLoadDefault();
    console.warn('[苍玄助手] 找不到 getVariables（不在酒馆环境？），本次使用默认数据');
    return null;
  }

  const scope = resolveDataScope();
  try {
    const table = getVariables(scope);
    if (!isPlainRecord(table)) {
      // 拿到的不是对象：这台机器的作用域语义不对 —— 这是**读失败**，不是「没数据」
      lastLoadOutcome = 'failed';
      rememberFailedLoadDefault();
      console.warn('[苍玄助手] 读取数据作用域 ' + describeStorageScope() + ' 返回的不是对象，按读失败处理');
      return null;
    }
    const raw = table[GLOBAL_KEY];

    // ⚠️ 「读不到」和「没有数据」是**两件事**，这里必须分开（P4-10b 事故的最后一环）：
    //
    // 原生变量接口**根本列不出键**（实测：Object.keys 只有那七个方法名，
    // {...variables.global} 是 {}）。所以「按已知键逐个读」读不到时，可能是
    // 「存储里确实没有」，也可能是「我压根不知道有哪些键、没读到它」。
    // 后一种**绝不能**当成前者 —— 那正是「默认值覆盖用户数据」这条静默丢失的入口。
    //
    // 适配器用 _canEnumerateVariables() 告诉我们它到底能不能枚举：
    //   不能枚举 + 没读到我们的 key → 'failed'（拦住写入，等用户真的改过再放行）
    //   能枚举   + 没读到我们的 key → 'empty'（真的没有，可以安全初始化）
    const canEnumerate = hostFn('_canEnumerateVariables');
    const enumerable = typeof canEnumerate === 'function' ? canEnumerate() === true : true;
    if (raw === undefined && !enumerable) {
      lastLoadOutcome = 'failed';
      rememberFailedLoadDefault();
      console.warn(
        '[苍玄助手] 读数据作用域 ' + describeStorageScope() + ' 没读到 ' + GLOBAL_KEY +
          '，而这台机器的变量接口**不能枚举键** —— 分不清「没有数据」还是「没读到」，' +
          '按读失败处理；为避免覆盖用户数据，在用户真正改动之前不会写回存储',
      );
      return null;
    }

    // 读**通了**，但里面没有我们的 key = 全新用户（或空存储）→ 'empty'，允许写。
    // 这与「读失败」必须分开：前者可以放心写默认值，后者写了就是覆盖用户数据。
    lastLoadOutcome = raw === undefined ? 'empty' : 'ok';
    return raw;
  } catch (error) {
    lastLoadOutcome = 'failed';
    rememberFailedLoadDefault();
    console.warn(
      '[苍玄助手] 读取数据作用域 ' + describeStorageScope() + ' 失败，本次使用默认数据；' +
        '为避免覆盖用户数据，在用户真正改动之前不会写回存储',
      error,
    );
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

/** 这台机器有没有任何一个可用的变量写入接口（环境级判断，与数据无关） */
function hasWriteInterface(): boolean {
  return !!(hostFn('insertOrAssignVariables') || hostFn('replaceVariables') || hostFn('updateVariablesWith'));
}

/**
 * 真正落盘：写进**数据作用域**表。
 *
 * 优先 `insertOrAssignVariables`（只动我们那一个 key，别的变量不受影响），
 * 退而求其次用 `replaceVariables` / `updateVariablesWith`（读出整表再合并写回）。
 *
 * ⚠️ 三个分支用的是**同一个** resolveDataScope() 结果（读出来存进 `scope` 变量），
 * 这一点是有意的：读写作用域一旦不一致，就是 P4-10 那个数据丢失 bug。
 *
 * @returns 是否写成功；没有任何可用接口时返回 false
 */
function writeRawRootData(payload: unknown): boolean {
  const scope = resolveDataScope();
  try {
    const insertOrAssign = hostFn('insertOrAssignVariables');
    if (insertOrAssign) {
      insertOrAssign({ [GLOBAL_KEY]: payload }, scope);
      return true;
    }

    const getVariables = hostFn('getVariables');

    const replace = hostFn('replaceVariables');
    if (replace && getVariables) {
      const table = getVariables(scope);
      const next = isPlainRecord(table) ? { ...table, [GLOBAL_KEY]: payload } : { [GLOBAL_KEY]: payload };
      replace(next, scope);
      return true;
    }

    const updateWith = hostFn('updateVariablesWith');
    if (updateWith) {
      updateWith(
        (table: Record<string, unknown>) => (isPlainRecord(table) ? { ...table, [GLOBAL_KEY]: payload } : { [GLOBAL_KEY]: payload }),
        scope,
      );
      return true;
    }
  } catch (error) {
    console.warn('[苍玄助手] 写入数据作用域 ' + describeStorageScope() + ' 失败', error);
    return false;
  }

  return false;
}

/* -------------------- 读失败时的「不许覆盖」保护（P4-10 第 4 条）-------------------- */

/**
 * 用户是否已经**真的动过**数据。
 *
 * 读失败后的保护要靠它区分两种情况：
 *   - 用户还没动过 → 这次 save 写的是**默认值** → 必须拦住（否则覆盖用户数据）；
 *   - 用户已经改过 → 写的是**用户的新数据** → 必须放行（否则用户的改动存不进去）。
 *
 * 为什么用这个标志、而不是「是不是第一次 save」或者「data 是否等于默认值」：
 *   - 「第一次 save 就拦」会连用户的真实改动一起拦掉 —— 那是把数据丢失换成「存不进去」，同样坏；
 *   - 「比较 data 与默认值」不可靠：用户可能恰好把某项改回默认值，或者默认值随版本变化，
 *     这个判据会**误判**，而误判的代价是数据丢失。
 * 显式标志由调用方（store / 界面）在「用户操作导致数据变化」时置位，语义明确、不猜。
 */
let userTouchedData = false;

/**
 * 声明「用户已经动过数据」—— 之后 saveData 不再受「读失败保护」拦截。
 *
 * 调用时机：任何**由用户操作触发**的数据变更（改设置、切页签、发消息…）。
 * store 的 save() 就是这条路。
 */
export function markUserTouchedData(): void {
  userTouchedData = true;
}

/** 用户是否已动过数据（测试 / 界面用） */
export function hasUserTouchedData(): boolean {
  return userTouchedData;
}

/** 测试 / 重载用：复位「用户动过数据」标志 */
export function resetUserTouchedData(): void {
  userTouchedData = false;
}

/* -------------------- 保护：读失败后的「不许用默认值覆盖」 -------------------- */

/**
 * 读失败时，我们手上那份「凭空来的默认数据」的指纹。
 *
 * 读失败 → recoverRootData(null) 给出一份各块填满 default 的 RootData。
 * 把它的 JSON 存下来：若调用方之后写的内容**和它一模一样**，说明用户还没动过任何东西，
 * 此时写盘就是「用默认值覆盖用户数据」，必须拦。
 * 若内容**不一样**，说明确实有东西变了（用户改了设置 / 代码改了数据），放行。
 */
let failedLoadSnapshot: string | null = null;

/** 读失败时记下「默认数据」的指纹（由 readStoredRootData 调） */
function rememberFailedLoadDefault(): void {
  try {
    failedLoadSnapshot = JSON.stringify(recoverRootData(null).data);
  } catch {
    // 连默认值都算不出来：那就不设指纹，宁可多放行一次也不误拦用户数据
    failedLoadSnapshot = null;
  }
}

/**
 * 该不该拦住这次写？（三条判据，**必须同时成立**）
 *
 *   1. 上一次读盘**失败**（lastLoadOutcome === 'failed'）
 *      —— 读成功 / 存储本来就空 / 还没读过，都不是「可能覆盖」的场景，放行；
 *   2. 用户还没显式声明动过数据（markUserTouchedData 未调）；
 *   3. 这次要写的内容**恰好等于**失败读产生的那份默认数据
 *      —— 内容不同就说明确实变了，放行（否则用户的改动会永远存不进去，
 *         那是把「数据丢失」换成「存不进去」，一样是坏结果）。
 *
 * 为什么第 3 条用的是「与**本次失败读产生的快照**比对」而不是「与 schema 默认值比对」：
 * 前者是这次具体事故的精确指纹，不受版本升级 / 默认值调整影响；
 * 后者会因为默认值随版本变化而误判，而误判的代价是数据丢失。
 */
export function shouldBlockWrite(data?: unknown): boolean {
  if (lastLoadOutcome !== 'failed') return false;
  if (userTouchedData) return false;
  if (failedLoadSnapshot === null) return true; // 没有指纹可比 → 保守拦住（读失败 + 没动过）
  if (data === undefined) return true;
  try {
    return JSON.stringify(recoverRootData(data).data) === failedLoadSnapshot;
  } catch {
    // 比不出来 → 保守：拦住（读失败 + 没动过，写下去大概率是覆盖）
    return true;
  }
}


/**
 * 给 store 用的写入口：先过「读失败保护」，再校验（坏块顺带修复），最后写回。
 *
 * @param force 显式跳过「读失败保护」（导入数据 / 用户手动恢复这类场景用）。
 *              默认 false —— **默认必须是安全的**，要绕过得写出来。
 * @throws 被保护拦下、或写不进去时抛错（store 会 catch 并 warn）
 */
export function saveData(data: unknown, force = false): void {
  // 顺序有意如此：**先判「有没有写入接口」**（环境级硬错，信息量最大），再判「读失败保护」。
  // 反过来的话，纯环境缺接口的场景会先撞上保护，用户看到的是一句「已阻止写入」，
  // 而真正的原因（这台机器根本没有写入接口）被盖住了 —— 报错要指向根因。
  if (!hasWriteInterface()) {
    throw new Error(
      '保存失败：没有可用的变量写入接口（insertOrAssignVariables / replaceVariables / updateVariablesWith），' +
        '当前作用域 ' + describeStorageScope(),
    );
  }

  if (!force && shouldBlockWrite(data)) {
    const message =
      '已阻止写入：这次启动**没能读到**原有数据（作用域 ' +
      describeStorageScope() +
      ' 读取失败），而用户尚未改动过任何东西。' +
      '若此时写盘，就会用默认值覆盖掉存储里的真实数据。' +
      '请先检查宿主变量接口；确认要覆盖可显式传 force=true。';
    console.warn('[苍玄助手] ' + message);
    throw new Error(message);
  }

  const { data: safe, warnings } = recoverRootData(data);
  if (warnings.length > 0) {
    console.warn('[苍玄助手] 保存前修复了 ' + warnings.length + ' 处数据问题');
  }
  const written = writeRawRootData(toPlainJson(safe));
  if (!written) {
    throw new Error(
      '保存失败：没有可用的变量写入接口（insertOrAssignVariables / replaceVariables / updateVariablesWith），' +
        '或作用域 ' + describeStorageScope() + ' 写入被宿主拒绝',
    );
  }
}

/**
 * 强类型 + 布尔返回版本：不抛错，失败返回 false（界面内部用）。
 *
 * ⚠️ 被「读失败保护」拦下时，除了返回 false，还会打一条**说清原因**的 warn ——
 * 拦截本身是一个「用户数据现在存不进去」的事件，**不能静默**：
 * 静默拦截和静默覆盖一样坏，只是方向相反。
 */
export function saveRootData(data: RootData, force = false): boolean {
  try {
    saveData(data, force);
    return true;
  } catch (error) {
    const blocked = !force && shouldBlockWrite(data);
    if (blocked) {
      console.warn(
        '[苍玄助手] 这次保存被**拦下**了（不是没写成功，是主动拒绝写）：' +
          '启动时读数据失败，为避免用默认值覆盖你原有的数据，在你有实际改动前不会写回。' +
          '你刚才的改动尚未保存 —— 请检查宿主变量接口后重试。',
        error,
      );
    } else {
      console.warn('[苍玄助手] saveRootData 失败', error);
    }
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

    // 老导出文件（v4）也要先搬家再 parse，不然开关同样会被 schema 吃掉
    const result = RootDataSchema.safeParse(migratePluginSwitch(parsed));
    if (!result.success) {
      return { ok: false, error: '数据结构不对：' + firstIssueMessage(result.error) };
    }

    // 老文件（v1、只有 session）也在这里被包成 sessions 的一条
    return { ok: true, data: migrateRootData(result.data).data };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}