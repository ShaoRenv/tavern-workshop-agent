/**
 * 苍玄助手 · 全部数据模型（唯一真源）
 *
 * 约定：
 *  - 这就是持久化结构，storage.ts 只读写这份结构，UI 只读它
 *  - 每条都有默认值（.default() / 对象块用 .prefault({})），老数据缺字段能自动补，不炸
 *  - v4 起预设**只有一种**：items（消息条目 + 特殊层）+ tools/skills + use_global_caps；
 *    老数据的 kind('plain'|'agent') / system / messages 由 migratePresetItems 迁进 items
 *  - 会话：v2 起是**多会话**（sessions + active_session_id），单数 session 只做兼容读取
 */
import { z } from 'zod';
// 只借类型：工具覆盖项的**唯一契约**在 ports.ts（那边不带运行时校验）
import type { ToolOverrideMap } from './ports.ts';

/* ============================ 设置 ============================ */

export const ApiRouteSchema = z.enum(['custom', 'tavern']);
export type ApiRoute = z.infer<typeof ApiRouteSchema>;

export const ApiSettingsSchema = z.object({
  /** custom = 自己填的接口（能发原生 tools）；tavern = 走酒馆 */
  route: ApiRouteSchema.default('tavern'),
  url: z.string().default(''),
  key: z.string().default(''),
  model: z.string().default(''),
  stream: z.boolean().default(false),
  /** 多模态：开着模型才看得见自己生的图 */
  send_images: z.boolean().default(false),
  timeout_sec: z.number().int().positive().default(60),
});
export type ApiSettings = z.infer<typeof ApiSettingsSchema>;

export const GenSettingsSchema = z.object({
  image_concurrency: z.number().int().positive().default(4),
  retry: z.number().int().min(0).default(2),
  max_rounds: z.number().int().positive().default(12),
});
export type GenSettings = z.infer<typeof GenSettingsSchema>;

/* ============================ 插件 ============================ */

/**
 * 生图插件的来源。现在只有 NovelAI；以后加 OpenAI 兼容 / SD WebUI 就在这里加枚举值，
 * 大部分字段（prompt / negative / 张数 / 尺寸）是共用的。
 */
export const ImageSourceSchema = z.enum(['novelai']);
export type ImageSource = z.infer<typeof ImageSourceSchema>;

export const IMAGE_SOURCE_LABELS: Record<ImageSource, string> = { novelai: 'NovelAI' };

/**
 * NovelAI 的「站点」：
 *  - official = 直接打官网接口（浏览器里大概率被 CORS 挡，挡了就换 proxy）
 *  - proxy    = 自填地址的反代 / 中转（协议 + 主机 + 端口，不必带路径）
 */
export const NaiSiteSchema = z.enum(['official', 'proxy']);
export type NaiSite = z.infer<typeof NaiSiteSchema>;

/**
 * 生图插件（`data.plugins.image`）。
 *
 * 这份配置是**插件自己的设置**，跟工具页的 tool_overrides 分开：
 *  - 工具页改的是「模型看到的说明 / 参数默认值 / 超时」
 *  - 这里改的是「这台机器怎么连生图接口、默认出什么画」
 * 工具 gen_image 每次调用都读这里的值组装请求（见 plugins/image/nai.ts）。
 */
export const GenImageConfigSchema = z.object({
  /** 插件总开关：关着 = gen_image 直接报「插件没启用」，一个请求都不发 */
  enabled: z.boolean().default(false),
  source: ImageSourceSchema.default('novelai'),
  /** API Key（NovelAI 用 pst- 开头那种永久 token） */
  api_key: z.string().default(''),
  site: NaiSiteSchema.default('official'),
  /** site='proxy' 时的地址 */
  site_url: z.string().default(''),
  model: z.string().default('nai-diffusion-4-5-full'),
  sampler: z.string().default('k_euler_ancestral'),
  schedule: z.string().default('karras'),
  steps: z.number().int().min(1).max(50).default(28),
  width: z.number().int().min(64).max(2048).default(832),
  height: z.number().int().min(64).max(2048).default(1216),
  /** 0 = 每次随机 */
  seed: z.number().int().min(0).default(0),
  guidance: z.number().min(0).max(20).default(5),
  guidance_rescale: z.number().min(0).max(1).default(0),
  smea: z.boolean().default(false),
  smea_dyn: z.boolean().default(false),
  /** 多样性：每张的差异更大（NAI 的 variety+） */
  variety: z.boolean().default(true),
  decrisp: z.boolean().default(false),
  /** 透明背景（只有 v4.5+ 认） */
  straight_alpha: z.boolean().default(false),
  /** 追加官方质量词 best quality, amazing quality…（NAI 的 qualityToggle） */
  quality: z.boolean().default(true),
  /** 负面质量预设（NAI 的 ucPreset） */
  uc_preset: z.enum(['heavy', 'light', 'human', 'none']).default('heavy'),
  /** 固定正面提示词：拼在模型给的 prompt 前面 */
  prompt: z.string().default(''),
  /** 后置固定正面：拼在最后（画风、镜头、质量词之类） */
  prompt_end: z.string().default(''),
  /** 固定负面：拼在负面质量预设后面 */
  negative: z.string().default(''),
  /** 一次最多出几张（成本上限；模型那边一次调用能要几张就由它封顶） */
  max_count: z.number().int().min(1).max(4).default(1),
});
export type GenImageConfig = z.infer<typeof GenImageConfigSchema>;

/** 插件配置表：插件 id → 配置。现在只有生图一个（image）。 */
export const PluginsSchema = z.object({
  image: GenImageConfigSchema.prefault({}),
});
export type Plugins = z.infer<typeof PluginsSchema>;

/* ============================ 预设 ============================ */

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** 什么条件下才把这一条发给模型 */
export const TriggerModeSchema = z.enum([
  'always',
  'has_worldbook',
  'has_portrait',
  'has_image',
  'first_round',
  'not_first_round',
]);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

export const TRIGGER_LABELS: Record<TriggerMode, string> = {
  always: '永远发',
  has_worldbook: '选了世界书才发',
  has_portrait: '选了角色才发',
  has_image: '有图才发',
  first_round: '只第一轮发',
  not_first_round: '第二轮起才发',
};

/** 这条预设产什么，只影响界面 */
export const PresetOutputSchema = z.enum(['none', 'json', 'worldbook']);
export type PresetOutput = z.infer<typeof PresetOutputSchema>;

/**
 * 普通消息条目：content 照旧走宏渲染。
 * `type` 是判别键 —— v4 起 items 里会混特殊层，必须能分辨（老数据没有它，由迁移补上）。
 */
export const PresetMessageSchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  name: z.string().default(''),
  role: MessageRoleSchema.default('system'),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
  trigger: TriggerModeSchema.default('always'),
  trigger_words: z.string().default(''),
});
export type PresetMessage = z.infer<typeof PresetMessageSchema>;

/**
 * 特殊层：**没有正文**，运行时展开成真正的消息。
 *  - context → 把当前会话历史原生展开（复用 agent/loop.ts 的 turnsToMessages）
 *  - user    → 展开成一条 role:'user' 的消息，内容就是 {{用户需求}} 的取值
 */
export const SpecialKindSchema = z.enum(['context', 'user']);
export type SpecialKind = z.infer<typeof SpecialKindSchema>;

export const SPECIAL_KIND_LABELS: Record<SpecialKind, string> = {
  context: '上下文',
  user: '用户需求',
};

export const SPECIAL_KIND_HINTS: Record<SpecialKind, string> = {
  context: '当前会话历史按原角色（user / assistant / tool）原生插在这个位置',
  user: '展开成一条 user 消息，内容就是本轮的用户需求',
};

export const PresetSpecialSchema = z.object({
  type: z.literal('special'),
  id: z.string(),
  name: z.string().default(''),
  kind: SpecialKindSchema,
  enabled: z.boolean().default(true),
});
export type PresetSpecial = z.infer<typeof PresetSpecialSchema>;

/** 预设本体的一条：普通消息 or 特殊层 */
export const PresetItemSchema = z.union([PresetMessageSchema, PresetSpecialSchema]);
export type PresetItem = z.infer<typeof PresetItemSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 老预设形状（v3 及以前）→ v4 的 items。**幂等、确定性**（不生成随机 id）。
 *
 * 规则（reports/苍玄助手-预设与上下文.md 六 + 迁移口径修正）：
 *  - `kind:'agent'` → items = [{type:'message', role:'system', content: 原 system}]
 *  - 其余 → items = 原 messages 逐条补上 `type:'message'`
 *  - 非 agent 预设上残留的非空 `system` 也补进 items（老数据一个字都不丢）
 *  - 能力口径（两种老 kind 必须分开，都写 false 会把纯 JSON 预设变成 Agent）：
 *      老 `kind:'agent'`  → `use_global_caps = false`（跟随「能力」页全局；全局默认有工具，它还是 Agent）
 *      老 `kind:'plain'`  → `use_global_caps = true` + `tools = []`（不跟随全局，自己一条工具都没有）
 *
 * 放在 PresetSchema 的 z.preprocess 里，所以**所有读入口**都走它
 * （loadData / recoverRootData 逐块恢复 / importAll 整份 parse），
 * storage.ts 的 v3→v4 迁移再用同一个函数兜一遍。
 */
export function migratePresetItems(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  const hasLegacyKeys = 'kind' in raw || 'system' in raw || 'messages' in raw;
  const itemsGiven = Array.isArray(raw.items);
  if (itemsGiven && !hasLegacyKeys && typeof raw.use_global_caps === 'boolean') return raw; // 已是新形状

  const presetId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'preset';
  const source = itemsGiven ? (raw.items as unknown[]) : legacyItems(raw, presetId);

  const out: Record<string, unknown> = { ...raw };
  delete out.kind;
  delete out.system;
  delete out.messages;
  out.items = source.map((item, index) => toPresetItem(item, index, presetId));
  if (typeof raw.use_global_caps !== 'boolean') {
    if (!hasLegacyKeys) {
      // 已经是新形状（items 齐了）、只是缺这个开关：按 schema 默认，跟随全局
      out.use_global_caps = false;
    } else {
      // 老 kind 决定口径：只有 agent 跟随全局；plain（含没有 kind 的老数据）不跟随全局。
      out.use_global_caps = raw.kind !== 'agent';
      // 老 plain 走的从来是普通 LLM 路径，工具没生效过；显式清空，
      // 免得迁移后「自己勾了工具」按新口径把它变成 Agent。
      if (out.use_global_caps) out.tools = [];
    }
  }
  return out;
}

/** 老字段（kind / system / messages）→ items 数组 */
function legacyItems(raw: Record<string, unknown>, presetId: string): unknown[] {
  const items: unknown[] = [];
  const system = typeof raw.system === 'string' ? raw.system : '';

  if (raw.kind === 'agent') {
    if (system.trim() !== '') {
      items.push({ type: 'message', id: presetId + '-system', name: '系统提示词', role: 'system', content: system });
    }
  } else if (system.trim() !== '') {
    // 理论上是脏数据（老 plain 预设不用 system），但既然有内容就不丢
    items.push({ type: 'message', id: presetId + '-system', name: '系统提示词', role: 'system', content: system });
  }

  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  for (const message of messages) items.push(message);
  return items;
}

/**
 * 单条老消息 → {type:'message', ...}。
 *
 * 只有**完全没有 type** 的（v3 及以前的消息条目）才补 `type:'message'`；
 * 给了 type 的一律原样交给 schema 判（写歪了要报错，不能被悄悄掰成消息）。
 */
function toPresetItem(raw: unknown, index: number, presetId: string): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.type !== undefined) return raw;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : presetId + '-item-' + String(index + 1);
  return { ...raw, type: 'message', id };
}

/**
 * 预设（v4）：**只有一种**，是不是 agent 由**解析后的工具集**决定
 * （见下面的 resolveCaps / isAgentPreset）。
 *  - items：消息条目 + 特殊层的序列，`content` 走宏渲染
 *  - use_global_caps：false = 跟随「能力」页的全局设置（默认）；true = 只用自己勾的工具 / 技能
 *  - tools / skills：只在 use_global_caps = true 时生效
 */
const PresetCoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  builtin: z.boolean().default(false),
  output: PresetOutputSchema.default('none'),
  items: z.array(PresetItemSchema).default([]),
  use_global_caps: z.boolean().default(false),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  max_rounds: z.number().int().positive().default(12),
});

export const PresetSchema = z.preprocess(migratePresetItems, PresetCoreSchema);
export type Preset = z.infer<typeof PresetCoreSchema>;

/* ============================ 技能 ============================ */

export const SkillFileSchema = z.object({
  name: z.string(),
  content: z.string().default(''),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 一句话描述：只有这句会进系统提示词 */
  summary: z.string().default(''),
  /** 正文：模型调 skill() 时才读 */
  body: z.string().default(''),
  files: z.array(SkillFileSchema).default([]),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
});
export type Skill = z.infer<typeof SkillSchema>;

/* ============================ 两级能力启用 ============================ */

/**
 * 解析预设能力时要问的「全局那一侧」（就是「能力」页那份默认设置）。
 *  - tools：全局工具，只看 `default_on`（结构兼容 ToolDef，直接传 ToolDef[] 也行）
 *  - skills：全局技能，只看 `enabled`
 */
export interface GlobalCaps {
  tools: readonly { name: string; default_on: boolean }[];
  skills: readonly Skill[];
}

/**
 * 两级能力启用（**唯一入口**，纯函数；runner 与界面共用同一份口径）。
 *
 *  - `use_global_caps = false`（默认）：跟随「能力」页的全局设置 ——
 *    工具走 `ToolDef.default_on`，技能走 `skill.enabled`
 *  - `use_global_caps = true`：只用这个预设自己的 tools / skills
 *    （技能仍然要与 `skill.enabled` 取交集：用户关掉的技能不发）
 *
 * 返回的 tools 是**工具名**，直接喂 runAgentLoop 的 enabled_tools。
 */
export function resolveCaps(
  preset: Pick<Preset, 'use_global_caps' | 'tools' | 'skills'> | null | undefined,
  global: GlobalCaps,
): { tools: string[]; skills: Skill[] } {
  if (!preset) return { tools: [], skills: [] };
  if (preset.use_global_caps) {
    const wanted = new Set(preset.skills ?? []);
    return {
      tools: (preset.tools ?? []).slice(),
      skills: global.skills.filter(skill => wanted.has(skill.id) && skill.enabled),
    };
  }
  return {
    tools: global.tools.filter(tool => tool.default_on).map(tool => tool.name),
    skills: global.skills.filter(skill => skill.enabled),
  };
}

/**
 * 这个预设走不走 Agent 路径（v4 起**没有 kind**）。
 *
 * 判据是**解析后的工具集非空**，而不是「预设自己勾了几个工具」：
 * 跟随全局的预设自己 tools=[]，但全局默认有工具，它照样是 Agent；
 * 「单独启用预设能力」且一条工具都没勾的，才是普通对话。
 *
 * 普通 = 只把预设的消息序列发出去，不跑工具循环（系统段也不追加）。
 */
export function isAgentPreset(
  preset: Pick<Preset, 'use_global_caps' | 'tools' | 'skills'> | null | undefined,
  global: GlobalCaps,
): boolean {
  return resolveCaps(preset, global).tools.length > 0;
}

/* ============================ 工具 ============================ */

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  ok: z.boolean().default(true),
  /** 一行摘要，给折叠状态看 */
  brief: z.string().default(''),
  /** 完整结果，展开时看 */
  detail: z.string().default(''),
  /** 生图这类要在对话里出图的，存 dataURL */
  images: z.array(z.string()).default([]),
  at: z.number().default(0),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/* ============================ 工具页覆盖项 ============================ */

/**
 * 用户在工具页改过的东西。**类型契约在 core/ports.ts**（ToolOverride / ToolOverrideMap），
 * 这里只补一份 zod schema 做持久化校验；字段全可选，没改的用内置默认。
 *
 * 两边形状必须一致：store 的 setToolOverride 用 ports 的类型收参、写这里的数据，
 * 谁改歪了 tsc 会直接报出来。
 */
export const ToolOverrideSchema = z.object({
  /** 覆盖「进模型的那段说明」 */
  description: z.string().optional(),
  /** 覆盖参数 schema 里某个参数的 description（键 = 参数名） */
  param_descriptions: z.record(z.string(), z.string()).optional(),
  /** 覆盖参数默认值（键 = 参数名；写进 schema 的 default） */
  param_defaults: z.record(z.string(), z.unknown()).optional(),
  /** 单次调用超时（毫秒） */
  timeout_ms: z.number().int().positive().optional(),
  /** 工具专属配置（生图 API 之类），由工具自己解释 */
  config: z.record(z.string(), z.unknown()).optional(),
  /** 界面上标「已改过」用的时间戳 */
  edited_at: z.number().optional(),
});

/**
 * 工具名 → 覆盖项（RootData.tool_overrides 的运行时 schema）。
 *
 * 输出类型显式声明成 ports.ts 的 `ToolOverrideMap`：RootData['tool_overrides']
 * 拿到的就是契约类型，应用层不会看到第二份定义。
 */
export const ToolOverrideMapSchema = z
  .record(z.string(), ToolOverrideSchema.optional())
  .prefault({}) as unknown as z.ZodType<ToolOverrideMap>;

/* ============================ 会话事件日志 ============================ */

export const SessionEventTypeSchema = z.enum(['user', 'assistant', 'tool', 'draft', 'apply', 'artifact', 'notice']);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

/** 事件类型的兜底文案：title 拿不到时用它，保证永远非空 */
export const EVENT_TYPE_TITLES: Record<SessionEventType, string> = {
  user: '用户消息',
  assistant: '助手回复',
  tool: '工具调用',
  draft: '草稿改动',
  apply: '应用草稿',
  artifact: '产物',
  notice: '提示',
};

/**
 * 会话事件：**仅追加**的权威流（记录页 / 回放 / 导出用）。
 *
 * 和 turns 的关系（v3）：
 *  - turns 继续保留并**双写**：现有 UI 与测试都读 turns，它的读路径不动
 *  - events 是新增的权威流：一个轮次可以派生出多条事件（助手正文 + 它发起的每个工具）
 *  - 仅追加：同一个 ref 可能有多条（upsert 重写轮次时会再追加一条），读取时**后写的算数**
 *  - 流式增量不逐条入日志（会爆），轮次定稿时由 appendTurn / upsertTurn 补权威事件
 *  - 旧数据没有 events → 空数组补上，不报错
 *
 * 字段形状是 Lead 定死的契约（UI 按它收紧渲染）：
 *   { id, at, type, title, text?, tool?, ok?, ref?, raw? }
 */
export const SessionEventSchema = z.object({
  id: z.string().default(''),
  /** 毫秒时间戳 */
  at: z.number().default(0),
  type: SessionEventTypeSchema,
  /** 一行主文案；**必须非空**，由生成端（makeEvent / 双写）从 type 兜底 */
  title: z.string().default(''),
  /** 正文 / 详情，可空 */
  text: z.string().optional(),
  /** type='tool' 时的工具名 */
  tool: z.string().optional(),
  /** tool / draft / apply 是否成功 */
  ok: z.boolean().optional(),
  /** 关联的 turn / call / draft / artifact id */
  ref: z.string().optional(),
  /** 预览被截断时的完整原文 */
  raw: z.string().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/* ============================ 会话 ============================ */

export const TurnRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type TurnRole = z.infer<typeof TurnRoleSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  role: TurnRoleSchema,
  text: z.string().default(''),
  images: z.array(z.string()).default([]),
  calls: z.array(ToolCallSchema).default([]),
  at: z.number().default(0),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionSchema = z.object({
  /** 会话 id：列表选中、active_session_id 指向它 */
  id: z.string().default(''),
  /** 列表页显示的标题；空串时由首条用户消息推出来（sessionTitle()） */
  title: z.string().default(''),
  /** 创建时间（毫秒） */
  created_at: z.number().default(0),
  /** 最后活动时间（毫秒） */
  updated_at: z.number().default(0),
  /** 'agent' | 'chat'，界面上那个开关 */
  mode: z.enum(['agent', 'chat']).default('agent'),
  preset_id: z.string().default(''),
  /**
   * 轮次（v1 就在的字段）。UI / 测试都读它，**读路径不动**；
   * v3 起同时把权威事件写进 events（双写）。
   */
  turns: z.array(TurnSchema).default([]),
  /** v3：仅追加的事件日志（权威流，记录页/导出用）；旧数据缺就补空数组 */
  events: z.array(SessionEventSchema).default([]),
  /** 跑没跑完 */
  running: z.boolean().default(false),
  round: z.number().int().min(0).default(0),
  started_at: z.number().default(0),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * v1 / v2 落盘时的单数 session 形状（**没有** v3 的 events）。
 *
 * 根上的 `session` 只是兼容读取 + 空壳落盘用的，不需要跟着 Session 长新字段；
 * 保持老形状，老文件读回来还是老样子。
 */
export const LegacySessionSchema = SessionSchema.omit({ events: true });
export type LegacySession = z.infer<typeof LegacySessionSchema>;

/* ============================ 会话事件：纯函数 helper ============================ */

/** 事件的一行主文案：自己有 title 就用，没有就从 type 兜底（保证非空） */
export function eventTitle(event: Pick<SessionEvent, 'type' | 'title'>): string {
  const own = (event.title ?? '').trim();
  return own !== '' ? own : (EVENT_TYPE_TITLES[event.type] ?? '事件');
}

/** 标题太长就截断 */
function clipTitle(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 从一段文本里取一行主文案（第一行非空内容，最多 40 字）；没有就用 fallback */
export function eventTitleFromText(text: string, fallback: string): string {
  const first =
    String(text ?? '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line !== '') ?? '';
  return first === '' ? fallback : clipTitle(first);
}

/** 工具结果太长时 text 里留的预览长度（完整原文进 raw） */
export const EVENT_PREVIEW_CHARS = 400;

function previewOf(text: string): { text: string; raw?: string } {
  return text.length <= EVENT_PREVIEW_CHARS ? { text } : { text: text.slice(0, EVENT_PREVIEW_CHARS) + '…', raw: text };
}

/** 造一条事件：id / 时间戳自动补，title 拿不到就从 type 兜底生成 */
export function makeEvent(type: SessionEventType, partial: Partial<SessionEvent> = {}): SessionEvent {
  const event = SessionEventSchema.parse({ id: uid('ev'), at: Date.now(), type, ...partial });
  return { ...event, title: eventTitle(event) };
}

/** 纯函数：往事件列表末尾追加一条（返回新数组，**不改入参**） */
export function appendEvent(events: SessionEvent[], event: SessionEvent): SessionEvent[] {
  return [...events, event];
}

/** 纯函数：批量追加（空数组返回原引用，不改入参） */
export function appendEvents(events: SessionEvent[], more: SessionEvent[]): SessionEvent[] {
  return more.length === 0 ? events : [...events, ...more];
}

/**
 * 纯函数：把一个轮次派生成事件（turns → events 的**双写桥**）。
 *
 * - user / assistant 轮次 → 一条同名事件：title 取首行、text 是整段正文、ref = turn.id
 * - role='tool' 的轮次 → 一条 'tool' 事件（正文就是工具结果）
 * - 轮次里每个工具调用 → 一条 'tool' 事件：title = `名字 · 摘要`，text = 结果预览，
 *   结果太长时完整原文进 raw，tool / ok / ref（call id）都写上
 *
 * 事件 id 用 `轮次id:序号`（**确定性**）：同一个轮次反复派生得到同样的 id，
 * 记录页按 id 去重 / 折叠就能扛住 upsert 重写。图片只留在 turns 里，事件不带图。
 */
export function eventsForTurn(turn: Turn): SessionEvent[] {
  const events: SessionEvent[] = [];
  const base = turn.id !== '' ? turn.id : 'turn';
  const at = turn.at > 0 ? turn.at : 0;

  const add = (partial: Partial<SessionEvent> & { type: SessionEventType }): void => {
    const index = events.length;
    const event = SessionEventSchema.parse({ id: base + ':' + String(index), at, ...partial });
    events.push({ ...event, title: eventTitle(event) });
  };

  if (turn.role === 'user' || turn.role === 'assistant') {
    const fallback = turn.role === 'user' ? EVENT_TYPE_TITLES.user : EVENT_TYPE_TITLES.assistant;
    add({ type: turn.role, title: eventTitleFromText(turn.text, fallback), text: turn.text, ref: turn.id });
  } else {
    add({ type: 'tool', title: eventTitleFromText(turn.text, EVENT_TYPE_TITLES.tool), text: turn.text, ref: turn.id });
  }

  for (const call of turn.calls) {
    const brief = call.brief.trim();
    const detail = previewOf(call.detail);
    const title = call.name + (brief === '' ? '' : ' · ' + brief) + (call.ok ? '' : '（失败）');
    add({
      type: 'tool',
      title: clipTitle(title, 60),
      text: detail.text,
      tool: call.name,
      ok: call.ok,
      ref: call.id !== '' ? call.id : turn.id,
      ...(detail.raw === undefined ? {} : { raw: detail.raw }),
    });
  }

  return events;
}

/** 新会话的默认标题 */
export const DEFAULT_SESSION_TITLE = '新对话';

/** 造一个字段齐全的会话（storage 的迁移、store 的新建都走它） */
export function makeSession(partial: Partial<Session> = {}): Session {
  return SessionSchema.parse({ title: DEFAULT_SESSION_TITLE, ...partial });
}

/** 拿一段文字当标题：取第一行非空内容，最多 24 字 */
export function titleFromText(text: string): string {
  const first =
    String(text ?? '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line !== '') ?? '';
  if (!first) return DEFAULT_SESSION_TITLE;
  return first.length > 24 ? first.slice(0, 24) + '…' : first;
}

/** 会话标题：自己有 title 就用，没有就从首条用户消息现推 */
export function sessionTitle(session: Session): string {
  const own = (session.title ?? '').trim();
  if (own !== '') return own;
  const firstUser = session.turns.find(turn => turn.role === 'user' && turn.text.trim() !== '');
  return firstUser ? titleFromText(firstUser.text) : DEFAULT_SESSION_TITLE;
}

/** 会话元信息：聊天记录管理页列表用的轻量视图（轮数由 turns.length 算） */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /** 轮数 = turns.length */
  turns: number;
  preset_id: string;
  mode: Session['mode'];
  running: boolean;
}

export function toSessionMeta(session: Session): SessionMeta {
  return {
    id: session.id,
    title: sessionTitle(session),
    created_at: session.created_at,
    updated_at: session.updated_at,
    turns: session.turns.length,
    preset_id: session.preset_id,
    mode: session.mode,
    running: session.running,
  };
}

/**
 * 挑当前会话（纯函数）：按 active_session_id 找 → 退回第一条 → 再没有就现造一个空会话。
 *
 * 「现造」是为了让调用方永远拿到一个对象；正常情况下 storage 的迁移/归一化
 * 已经保证 sessions 至少有一条，所以走不到最后那一步。
 */
export function pickActiveSession(root: Pick<RootData, 'sessions' | 'active_session_id'>): Session {
  return root.sessions.find(session => session.id === root.active_session_id) ?? root.sessions[0] ?? makeSession({ id: 'sess-default' });
}

/* ============================ 草稿 ============================ */

export const DraftKindSchema = z.enum(['create', 'edit', 'delete', 'meta', 'worldbook']);
export type DraftKind = z.infer<typeof DraftKindSchema>;

export const DraftChangeSchema = z.object({
  id: z.string(),
  /** 这条草稿属于哪个会话（v3）；空串 = 还没归属，写入口会盖当前会话 */
  session_id: z.string().default(''),
  kind: DraftKindSchema,
  /** 目标世界书 */
  world: z.string().default(''),
  /** 条目 uid；新建时为 '' */
  uid: z.string().default(''),
  /** 条目名，列表里显示用 */
  label: z.string().default(''),
  before: z.string().default(''),
  after: z.string().default(''),
  /** 结构化载荷：meta / create 用 */
  payload: z.record(z.string(), z.unknown()).default({}),
  at: z.number().default(0),
});
export type DraftChange = z.infer<typeof DraftChangeSchema>;

/* ============================ 产物 ============================ */

export const ArtifactSchema = z.object({
  id: z.string(),
  kind: z.enum(['json', 'worldbook']).default('json'),
  /** 显示名 / 文件名 */
  name: z.string().default(''),
  data: z.string().default(''),
  at: z.number().default(0),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/* ============================ 选择（要喂给模型的数据） ============================ */

export const SelectionSchema = z.object({
  character_ids: z.array(z.string()).default([]),
  worldbook_names: z.array(z.string()).default([]),
  entry_uid: z.array(z.string()).default([]),
  demand: z.string().default(''),
});
export type Selection = z.infer<typeof SelectionSchema>;

/* ============================ 根 ============================ */

/**
 * 页签 id（顺序 = 顶栏顺序）。
 * UI 去重归位后：原「技能」页扩容成「能力」页（工具库 + 技能库），id 由 skills 改名 capability。
 */
export const TAB_IDS = ['portraits', 'worldbook', 'chat', 'capability', 'records', 'settings'] as const;
export type TabId = (typeof TAB_IDS)[number];

/**
 * 历史页签名 → 现页签名。
 *
 * 老数据里存过的 `active_tab: 'skills'` 读出来要自动落到 `'capability'`：
 * 迁移放在 schema 层（z.preprocess），所以**所有读入口**都走它 ——
 * loadData / recoverRootData 的逐块恢复 / importAll 的整份 parse。
 * 不改 DATA_VERSION：只是页签名变了，数据结构没变。
 */
export const TAB_ID_ALIASES: Record<string, TabId> = { skills: 'capability' };

/** 把历史页签名兜底成现页签名；不是老名字就原样返回（交给 enum 去校验合法性） */
export function migrateTabId(value: unknown): unknown {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(TAB_ID_ALIASES, value)) {
    return TAB_ID_ALIASES[value];
  }
  return value;
}

/**
 * 数据版本：
 *  1 = 单会话（只有 session）
 *  2 = 多会话（sessions + active_session_id）
 *  3 = 多会话 + 工具覆盖项（tool_overrides）+ 会话事件日志（Session.events）
 *  4 = 预设合并：去 kind，messages/system → items（消息 + 特殊层）+ use_global_caps
 */
export const DATA_VERSION = 4;

export const RootDataSchema = z.object({
  version: z.number().int().default(DATA_VERSION),
  /** 老数据的 'skills' 由 migrateTabId 兜底成 'capability'（见 TAB_ID_ALIASES） */
  active_tab: z.preprocess(migrateTabId, z.enum(TAB_IDS).default('portraits')),
  api: ApiSettingsSchema.prefault({}),
  gen: GenSettingsSchema.prefault({}),
  /** 插件页：插件自己的设置（生图插件是第一个 → `data.plugins.image`） */
  plugins: PluginsSchema.prefault({}),
  presets: z.array(PresetSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  active_preset_id: z.string().default(''),
  selection: SelectionSchema.prefault({}),
  /**
   * 工具页的覆盖项（v3）：工具名 → 用户改过的字段。
   * 唯一的写入口是 stores/app.ts 的 setToolOverride / resetToolOverride。
   */
  tool_overrides: ToolOverrideMapSchema,
  /** 多会话：真正的聊天记录都在这（v2 起唯一真源） */
  sessions: z.array(SessionSchema).default([]),
  /** 当前会话 id，指向 sessions 里的一条 */
  active_session_id: z.string().default(''),
  /**
   * ⚠️ v1 遗留字段：**只为了兼容读取**老数据（迁移时把它包成 sessions 的一条），
   * 新代码一律只认 sessions。storage 落盘时会把它写成空壳，
   * 这样同一份聊天记录不会在变量里存两份（turns 里可能有 dataURL 大图）。
   *
   * 用 LegacySessionSchema：它保持 v1/v2 的老形状，**不跟着 Session 长新字段**
   * （v3 的 events 不回灌到这个空壳里）。
   */
  session: LegacySessionSchema.prefault({}),
  drafts: z.array(DraftChangeSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
});
export type RootData = z.infer<typeof RootDataSchema>;

export const GLOBAL_KEY = 'cx_assistant_v1';

/* ============================ 小工具 ============================ */

export function uid(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export function nowMs(): number {
  return Date.now();
}

export function roleLabel(role: MessageRole): string {
  if (role === 'system') return 'SYST';
  if (role === 'assistant') return 'AI';
  return 'USER';
}