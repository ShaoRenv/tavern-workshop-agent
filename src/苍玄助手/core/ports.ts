/**
 * 层与层之间的契约。谁实现谁负责，别的层只认这里的签名。
 * 目的：数据层 / Agent 内核 / UI 可以并行写，互不踩。
 */
import type { ApiSettings } from './types.ts';

/* ==================== 世界书 ==================== */

/** 归一化后的条目；TavernHelper 那边的字段差异由 data-layer 抹平 */
export interface WbEntry {
  /** 我方统一 string；TavernHelper 那边 uid 是 number */
  uid: string;
  name: string;
  content: string;
  enabled: boolean;
  /** 激活策略：constant=蓝灯(常驻) / selective=绿灯(关键词) / vectorized=向量化 */
  strategy: 'constant' | 'selective' | 'vectorized';
  /** 主要关键词（绿灯用） */
  keys: string[];
  keys_secondary: { logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'; keys: string[] };
  /** 扫描深度；'same_as_global' = 跟随全局 */
  scan_depth: number | 'same_as_global';
  /** 插入位置 / 顺序 / 深度等原值，透传不解释 */
  position: number;
  order: number;
  depth: number;
  /** 其余字段原样带着，写回时**必须**合并回去，一个都不许丢 */
  extra?: Record<string, unknown>;
}

export interface WbSearchHit {
  world: string;
  uid: string;
  name: string;
  /** 命中位置前后一小段 */
  snippet: string;
  /** 命中次数 */
  hits: number;
}

export interface WorldbookPort {
  /** 全部世界书名 */
  list(): Promise<string[]>;
  /** 酒馆当前启用的（角色卡 + 全局） */
  current(): Promise<string[]>;
  /**
   * 每本世界书的**绑定范围**：它从哪儿被启用。
   *
   * 为什么单开一个方法：模型看 `wb_list` 时要能分清「这本是全局的」「这本绑在当前角色卡上」
   * 「这本压根没启用」—— 只有名字它没法判断该不该动、动了会影响谁。
   * 三态互斥，判定顺序：全局 > 角色卡 > 未启用（酒馆里同一本可能同时挂全局和角色卡，
   * 这时按「全局」说，因为它的影响面更大）。
   */
  scopes(): Promise<WorldbookScope[]>;
  readAll(world: string): Promise<WbEntry[]>;
  readByUid(world: string, uids: string[]): Promise<WbEntry[]>;
  /** 关键词搜索，只返回摘要，不返回全文 */
  search(worlds: string[], keyword: string, limit: number): Promise<WbSearchHit[]>;
  createWorldbook(name: string): Promise<void>;
  deleteWorldbook(name: string): Promise<void>;
  /** 全量写回某本世界书 */
  writeAll(world: string, entries: WbEntry[]): Promise<void>;
}

/**
 * 一本世界书的绑定范围（给模型看的「它从哪儿生效」）。
 *
 *  - `global`   全局世界书：所有聊天都生效；
 *  - `character` 绑在当前角色卡上；
 *  - `chat`     绑在当前聊天上；
 *  - `none`     没启用（用户没挂它，但条目还在，可以被加进范围）。
 */
export type WorldbookScopeKind = 'global' | 'character' | 'chat' | 'none';

export interface WorldbookScope {
  name: string;
  kind: WorldbookScopeKind;
  /** 人话标签：全局 / 当前角色卡 / 当前聊天 / 未启用 */
  label: string;
}

/* ==================== LLM ==================== */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** dataURL 或 http(s) 地址，多模态 */
  images?: string[];
  /** role=tool 时必填 */
  tool_call_id?: string;
  /** role=assistant 时带上它发起的调用 */
  tool_calls?: LlmToolCall[];
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** 只有原生通道才用；文本通道忽略 */
  tools?: ToolSpec[];
  settings: ApiSettings;
  signal?: AbortSignal;
  /** 流式增量回调 */
  onDelta?: (text: string) => void;
}

export interface LlmReply {
  text: string;
  tool_calls: LlmToolCall[];
  /** 'native' = 模型发了真 tool_calls；'text' = 从文本里抠出来的 */
  via: 'native' | 'text';
}

export type ToolSupport = 'yes' | 'no' | 'unknown';

export interface LlmPort {
  chat(req: LlmRequest): Promise<LlmReply>;
  /** 上次试过 tools 没，结果记在这 */
  supportsTools(): ToolSupport;
  markToolsUnsupported(): void;
}

/* ==================== 工具执行器 ==================== */

export interface ToolContext {
  /** 本轮允许动的世界书 */
  worlds: string[];
  /**
   * 世界书读写端口。
   *
   * 阶段 3 从「构造工具时注入」改成「跑一轮时注入」：
   * 插件 manifest 的 `contributes.tools` 是**静态** ToolDef[]，模块加载时拿不到宿主端口，
   * 所以端口跟 genImage / askUser 一样走 ctx —— 这也是未来外部插件唯一可行的形态
   * （外部插件更不可能在加载时拿到宿主对象）。
   */
  wb: WorldbookPort;
  drafts: DraftSink;
  skills: { id: string; name: string; summary: string; body: string }[];
  /** 生图用 */
  genImage?: (prompt: string, negative: string) => Promise<string[]>;
  /** 问用户；返回用户的回答，空串表示没答 */
  askUser?: (question: string) => Promise<string>;
  /**
   * 插件自己的设置（`plugins.<plugin_id>`），按插件 id 索引。
   *
   * 插件工具是**静态**的，加载时读不到「用户当前怎么配的」；跟 wb / genImage 一样，
   * 每轮由组装方塞进 ctx。插件从 `ctx.plugin_config?.['自己的id']` 取，取不到就按默认值走。
   */
  plugin_config?: Record<string, unknown>;
  /** 观察记录：哪些条目被读过、读到的是哪一版（observe-guard 用） */
  observations?: ObservationLog;
  /** 工具页的覆盖项：组装 specs 时套上去 */
  tool_overrides?: ToolOverrideMap;
}

/** 失败分类。守卫和 UI 都按它分流，别再靠文案猜。 */
export type ToolErrorCode =
  | 'SCOPE_DENIED'
  | 'NOT_FOUND'
  | 'NOT_OBSERVED'
  | 'STALE'
  | 'INVALID_ARGS'
  | 'TOOL_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN_TOOL';

/**
 * 给模型的额外上下文。**不替换** detail：循环会把它当成一条带来源的合成消息追加进去，
 * 工具结果本身保持原样，审计和回放都成立。
 */
export interface ToolContextNote {
  /** 谁加的：'observe-guard' / 'repeat-guard' / 'prune-guard' … */
  source: string;
  /** 一句话摘要 */
  summary: string;
  /** 正文 */
  text: string;
}

export interface ToolResult {
  ok: boolean;
  /** 一行摘要，折叠时显示 */
  brief: string;
  /** 完整结果，给模型看也给人看 */
  detail: string;
  /** 失败分类（ok=false 时给） */
  code?: ToolErrorCode;
  /** 附加给模型的上下文，不替换 detail */
  contexts?: ToolContextNote[];
  /** 结果被修剪过：原文留在会话日志里，按 tool call id 可查 */
  pruned?: { original_chars: number; kept_chars: number };
  /** 要在对话里出图的 */
  images?: string[];
}

export interface ToolDef {
  name: string;
  /** 分组，设置页里按组显示 */
  group: 'knowledge' | 'write' | 'skill' | 'image' | 'flow' | 'external';
  title: string;
  /** 给人看的一句话 */
  desc: string;
  /**
   * 进模型的那段说明。**这就是工具页里能编辑的那段提示词**，
   * 注册表组装 specs 时会用 ToolOverride.description 覆盖它。
   */
  model_description: string;
  parameters: Record<string, unknown>;
  /** 默认开不开 */
  default_on: boolean;
  /** true = 描述里会写「仅当用户明确要求时才用」 */
  user_initiated_only?: boolean;
  /** 单次调用预算（毫秒）；不设 = 不限制。写在工具自己的定义上，跟 DSH 一个路子 */
  timeoutMs?: number;
  /** 只读工具（守卫可以用它挡掉写语义） */
  readonly?: boolean;
  /** 来源：内置 / 外部导入 */
  source?: 'builtin' | 'external';
  /** 外部工具的来源地址（显示与更新用） */
  origin?: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/* ==================== 工具流水线（pre → execute → post） ==================== */

/**
 * 工具是「能力」，横切逻辑是「守卫」：
 *   before（按注册顺序）→ def.run → after（按注册顺序）
 * before 返回一个 ToolResult 就短路（不再执行 def.run），
 * 用来做范围门禁、必须先读、只读模式、预算这类东西。
 * 守卫不认识具体工具，只认 name / args / ctx。
 */
export interface ToolExecInput {
  name: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** 第几轮（1 起） */
  round: number;
}

export interface ToolGuard {
  name: string;
  before?(input: ToolExecInput): Promise<ToolResult | null> | ToolResult | null;
  after?(input: ToolExecInput, result: ToolResult): Promise<ToolResult> | ToolResult;
}

/* ==================== 观察记录（改写前必须先读 + 版本 CAS） ==================== */

/** 模型本轮读过哪些条目、读到的是哪一版。key = world + '\u0000' + uid */
export interface ObservationLog {
  /** 记下模型读到的版本（含草稿造成的版本） */
  record(world: string, uid: string, version: string): void;
  /** 读过就返回当时那版；没读过返回 undefined */
  seen(world: string, uid: string): string | undefined;
  clear(): void;
}

/* ==================== 工具页：按工具覆盖提示词 / 参数 / 配置 ==================== */

/** 用户在工具页改过的东西。全部可选，没改的字段用内置默认。 */
export interface ToolOverride {
  /** 覆盖「进模型的那段说明」 */
  description?: string;
  /** 覆盖参数 schema 里某个参数的 description（键 = 参数名） */
  param_descriptions?: Record<string, string>;
  /** 覆盖参数默认值（键 = 参数名；写进 schema 的 default） */
  param_defaults?: Record<string, unknown>;
  /** 单次调用超时（毫秒） */
  timeout_ms?: number;
  /** 工具专属配置（生图 API 之类），由工具自己解释 */
  config?: Record<string, unknown>;
  /** 界面上标「已改过」用的时间戳 */
  edited_at?: number;
}

/** 工具名 → 覆盖项 */
export type ToolOverrideMap = Record<string, ToolOverride | undefined>;

/* ==================== 工具专属设置（声明式表单；内置与外部工具通用） ==================== */

/**
 * 工具详情页第 5 块「这个工具自己的设置」里能出现的控件。
 * 外部工具**不许自带 HTML/JS 渲染**（沙箱里没有 DOM），只能声明字段，宿主负责画。
 */
export type ToolFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'code' | 'button';

export interface ToolSettingsField {
  /** 存进 ToolOverride.config 的键名 */
  key: string;
  label: string;
  type: ToolFieldType;
  /** 控件下面的小字说明 */
  hint?: string;
  placeholder?: string;
  /** 默认值；用户改了就以 config 为准 */
  default?: unknown;
  /** type='select' 的选项 */
  options?: { value: string; label: string }[];
  /** type='number' 的范围 */
  min?: number;
  max?: number;
  step?: number;
  /** type='button'：点一下让工具跑一次名为 action 的动作 */
  action?: string;
}

/* ==================== 外部导入工具 ==================== */

/**
 * 外部工具能要的东西。**装之前会按这张表弹给用户确认。**
 * 注意：'net' 只是声明（Worker 里的 fetch 拦不住）；真正强制得住的是
 * wb:* / llm:* / vars —— 那些在沙箱里根本不存在，只能由宿主代做。
 */
export type ExternalToolPermission =
  | 'wb:read'
  | 'wb:write'
  | 'llm:call'
  | 'llm:image'
  | 'vars'
  | 'ui:toast'
  | 'net'
  | 'dom';

/** 外部工具代码 export default 出来的东西 */
export interface ExternalToolManifest {
  /** 工具名：必须唯一，装了之后模型就是靠它调用的，改名等于换工具 */
  name: string;
  /** 给人看的名字 */
  title: string;
  /** 进模型的那段说明（之后可以在工具页里改） */
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
  /** 一行给人看的说明 */
  desc?: string;
  /** 声明要哪些能力；没声明的宿主一律不提供 */
  permissions: ExternalToolPermission[];
  /** 工具详情页第 5 块的声明式表单 */
  settings?: ToolSettingsField[];
  /** 单次调用预算（毫秒） */
  timeoutMs?: number;
}

/**
 * 外部工具的装载方式。
 * workshop 是给以后接「创意工坊」留的：订阅一份清单，按 id + 版本 + hash 拉代码，
 * 人工审核过的版本把 hash 记在清单里，本地 hash 对不上就标「与审核版本不一致」。
 */
export type ExternalToolSource =
  | { kind: 'url'; url: string; hash: string; fetched_at: number }
  | { kind: 'inline'; code: string; saved_at: number }
  | { kind: 'workshop'; id: string; version: string; url: string; hash: string; reviewed?: boolean; fetched_at: number };

/** 真正存进 RootData 的外部工具 */
export interface ExternalToolRecord {
  manifest: ExternalToolManifest;
  source: ExternalToolSource;
  /** 装的时候用户确认过哪些权限 */
  granted: ExternalToolPermission[];
  enabled: boolean;
  /**
   * 'full'（默认）= 直接 import 进我们的 iframe，和我们自己的脚本同权。
   * 'isolated' = 单独一个 sandboxed iframe + meta CSP 跑，能力走 postMessage 代做；
   *              **只有这一档能真正禁网**（CSP 是浏览器执行的，脚本绕不过）。
   */
  trust: 'full' | 'isolated';
  installed_at: number;
}

/* ==================== 草稿 ==================== */

export interface DraftSink {
  add(world: string, uid: string, kind: 'create' | 'edit' | 'delete' | 'meta', before: string, after: string, label: string): void;
  count(): number;
}