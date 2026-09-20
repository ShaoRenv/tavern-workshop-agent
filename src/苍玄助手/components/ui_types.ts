/**
 * 界面层自己的视图模型。
 *
 * 这些类型只在「数据层/内核 → App.vue → 视图」这条线上流通，不写进持久化结构；
 * 真源仍然是 core/types.ts 的 RootData / core/ports.ts 的 ToolOverride。
 *
 * 会话（记录）相关取数用 core/types.ts 的官方实现：pickActiveSession / toSessionMeta / sessionTitle。
 */
import type { ToolOverride, ToolOverrideMap } from '../core/ports.ts';
import type { RootData, TabId, Turn } from '../core/types.ts';

/** 立绘页的角色行 */
export interface UiRole {
  /** Tavern 角色 id 或名字，当 key 用 */
  id: string;
  name: string;
  /** 来源标签，例如「状态栏」「工坊」「内置」 */
  source?: string;
  /** 已经有立绘了吗 */
  has_image?: boolean;
  /** 元数据齐不齐；false 时标「无元数据」 */
  has_meta?: boolean;
}

/** 世界书页的世界书行 */
export interface UiWorld {
  name: string;
  /** 酒馆当前启用（角色卡 + 全局） */
  current?: boolean;
}

/** 世界书页的条目行 */
export interface UiEntry {
  uid: string;
  name: string;
  /** 分组名（设计稿里那些 ====角色设定==== 的组）；空串算「其它」 */
  group?: string;
}

/**
 * 工具行；来自 agent 内核的 ToolCatalogRow。
 * model_description / parameters / timeout_ms 是详情页要用的内置默认值，
 * 内核没给的时候界面明说「还没暴露」，不自己复制一份文案。
 */
export interface UiTool {
  name: string;
  title?: string;
  desc?: string;
  group?: string;
  /** 分组显示名：内核直接给，界面不自己翻 */
  group_label?: string;
  default_on?: boolean;
  user_initiated_only?: boolean;
  /** 内核清单里没有这个工具 */
  missing?: boolean;
  /** 内置默认的「进模型的那段说明」（工具页编辑的就是它） */
  model_description?: string;
  /** 参数 JSON Schema（渲染逐个参数的说明 / 默认值） */
  parameters?: Record<string, unknown>;
  /** 内置的单次超时（毫秒） */
  timeout_ms?: number;
  readonly?: boolean;
  source?: 'builtin' | 'external';
  origin?: string;
}

/** 详情页要渲染的一个参数 */
export interface UiToolParam {
  name: string;
  type: string;
  description: string;
  default_value: unknown;
  has_default: boolean;
  required: boolean;
}

/**
 * 会话事件（data-layer 的 SessionEvent，形状已定死）：
 * { id, at, type, title(非空), text?, tool?, ok?, ref?, raw? }
 */
export interface UiSessionEvent {
  id: string;
  at: number;
  type: 'user' | 'assistant' | 'tool' | 'draft' | 'apply' | 'artifact' | 'notice';
  title: string;
  text?: string;
  tool?: string;
  ok?: boolean;
  ref?: string;
  raw?: string;
}

/** 药丸分段器的一项 */
export interface SegItem {
  value: string;
  label: string;
}

/** 页签显示名；顺序由 core/types.ts 的 TAB_IDS 决定（立绘 / 世界书 / 对话 / 能力 / 记录 / 设置） */
export const TAB_LABELS: Record<TabId, string> = {
  portraits: '立绘',
  worldbook: '世界书',
  chat: '对话',
  capability: '能力',
  records: '记录',
  settings: '设置',
};

/** 分组显示名：内核给什么用什么（不再自己兜底，免得跟内核不同步） */
export function toolGroupLabel(tool: UiTool): string {
  return tool.group_label || tool.group || '';
}

/** 从参数 JSON Schema 里抠出要渲染的参数列表 */
export function toolParamList(schema?: Record<string, unknown>): UiToolParam[] {
  if (!schema || typeof schema !== 'object') return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return [];
  const rawRequired = (schema as { required?: unknown }).required;
  const required = new Set(Array.isArray(rawRequired) ? rawRequired.map(String) : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const type = typeof spec.type === 'string' ? spec.type : Array.isArray(spec.type) ? spec.type.join('|') : 'any';
    return {
      name,
      type,
      description: typeof spec.description === 'string' ? spec.description : '',
      default_value: spec.default,
      has_default: Object.prototype.hasOwnProperty.call(spec, 'default'),
      required: required.has(name),
    };
  });
}

/** 工具页的覆盖项（RootData.tool_overrides）：只读，写路径统一走 App.vue → store.setToolOverride */
export function readToolOverrides(root: RootData): ToolOverrideMap {
  const data = root as RootData & { tool_overrides?: ToolOverrideMap };
  const map = data.tool_overrides;
  return map && typeof map === 'object' ? map : {};
}

export function readToolOverride(root: RootData, name: string): ToolOverride | undefined {
  return readToolOverrides(root)[name];
}

/** 有没有真的改过东西（edited_at 不算） */
export function overrideEdited(override?: ToolOverride): boolean {
  if (!override) return false;
  if (typeof override.description === 'string') return true;
  if (override.timeout_ms !== undefined) return true;
  if (override.param_descriptions && Object.keys(override.param_descriptions).length) return true;
  if (override.param_defaults && Object.keys(override.param_defaults).length) return true;
  if (override.config && Object.keys(override.config).length) return true;
  return false;
}

/** 值 → 输入框里的文本（对象 / 数组转成 JSON） */
export function valueToText(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 输入框文本 → 值；解析不出来就 ok:false */
export function textToValue(text: string, type: string): { ok: boolean; value?: unknown } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false };
  if (type === 'string') return { ok: true, value: text };
  if (type === 'number' || type === 'integer') {
    const num = Number(trimmed);
    return Number.isFinite(num) ? { ok: true, value: num } : { ok: false };
  }
  if (type === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true };
    if (trimmed === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

/** 事件类型 → 时间线上的小标签 */
export const EVENT_LABELS: Record<UiSessionEvent['type'], string> = {
  user: '用户',
  assistant: '苍玄',
  tool: '工具',
  draft: '草稿',
  apply: '保存',
  artifact: '产物',
  notice: '提示',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type as UiSessionEvent['type']] ?? type;
}

/** 内核还没给 events 时的时间线兜底：把 turns 摊平成同样的事件形状 */
export function turnsToTimeline(turns: Turn[], assistantName = '苍玄'): UiSessionEvent[] {
  const out: UiSessionEvent[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ id: turn.id, at: turn.at, type: 'user', title: '用户', text: turn.text || '' });
      continue;
    }
    if (turn.role === 'assistant' && (turn.text || turn.images.length)) {
      out.push({ id: turn.id, at: turn.at, type: 'assistant', title: assistantName, text: turn.text || '' });
    }
    for (const call of turn.calls) {
      out.push({
        id: turn.id + '_' + call.id,
        at: call.at,
        type: 'tool',
        title: call.name,
        text: [call.brief, call.detail].filter(part => !!part).join('\n'),
        tool: call.name,
        ok: call.ok,
      });
    }
  }
  return out;
}

/** 06-13 12:34 这种短时间 */
export function timeLabel(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 正文 / 文件的字数：1.4k / 640 这种 */
export function sizeLabel(text: string): string {
  const n = text ? text.length : 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
