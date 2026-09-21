/**
 * 数据层 → 界面层的适配。**契约别改**，App.vue 直接依赖。
 *
 * 这里的职责只有一个：把 core/portrait.ts、core/worldbook.ts、agent/registry.ts 的真实结构
 * 翻译成 components/ui_types.ts 里的 UiRole / UiWorld / UiEntry / UiTool。
 * 任何一步失败（比如不在酒馆里）就返回空数组，不要抛。
 *
 * 铁律（App.vue 在 onMounted 里直接调，抛了整个面板白屏）：
 *  - 每个函数内部 try/catch，失败一律返回空数组 / {ok:false} + console.warn
 *  - loadEntries 只回 uid/name/group，**不把 content 带进界面模型**（正文交给 Agent 按需读）
 */
import type { ApiSettings } from './types.ts';
import type { UiEntry, UiRole, UiTool, UiWorld } from '../components/ui_types.ts';
import type { SettingsSchema, WbEntry } from './ports.ts';
import { collectCharacters, describePortraitResult, readPortraitMetaFromFile, type RoleSource } from './portrait.ts';
import { createWorldbookPort } from './worldbook.ts';
import { hostFn, isPlainRecord } from './storage.ts';

/** 角色来源标签：设计稿里的「内置 / 工坊 / 状态栏」 */
const SOURCE_LABELS: Record<RoleSource, string> = {
  statusbar_builtin: '内置',
  workshop: '工坊',
  statusbar_manual: '状态栏',
  manual: '手动',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 角色来源：内置 / 创意工坊 / 状态栏自建，合并后按名字去重 */
export async function loadRoles(): Promise<UiRole[]> {
  try {
    const { characters, warnings } = collectCharacters();
    for (const warning of warnings) console.warn('[苍玄助手] ' + warning);

    return characters.map((role) => ({
      // 图库只有名字，没有酒馆角色卡 id，用名字当 key
      id: role.name,
      name: role.name,
      source: SOURCE_LABELS[role.source] ?? '未知',
      has_image: !!role.imageUrl,
      // 有没有元数据得真去下载解析才知道，这里不猜：有图 → undefined（界面不显示标签），
      // 没图 → false（一定没有元数据，界面正好提示「无元数据」并给「传图」按钮）
      has_meta: role.imageUrl ? undefined : false,
    }));
  } catch (error) {
    console.warn('[苍玄助手] 读取角色图库失败，返回空列表', error);
    return [];
  }
}

/** 全部世界书 + 哪些是当前启用的 */
export async function loadWorlds(): Promise<UiWorld[]> {
  try {
    const port = createWorldbookPort();
    const [all, current] = await Promise.all([port.list(), port.current()]);
    const currentSet = new Set(current);
    return all.map((name) => ({ name, current: currentSet.has(name) }));
  } catch (error) {
    console.warn('[苍玄助手] 读取世界书名失败，返回空列表', error);
    return [];
  }
}

/**
 * 从条目名 / 条目自带的 group 推断分组名。
 *
 * - 世界里那种分隔条目 `====角色设定====` 只当分组标题，本身不进列表，返回 '角色设定'
 * - 普通条目返回 null
 */
function separatorGroup(name: string): string | null {
  const matched = /^={2,}\s*(.+?)\s*={2,}/.exec(name);
  return matched ? matched[1].trim() : null;
}

/** 条目自带的 group（旧版 / TavernHelper 会放在 extra 里） */
function ownGroup(entry: WbEntry): string {
  const extra = isPlainRecord(entry.extra) ? entry.extra : null;
  return extra ? asTrimmed(extra.group) : '';
}

/** 勾选的世界书里所有条目（带分组名，分组名空串归「其它」） */
export async function loadEntries(worlds: string[]): Promise<UiEntry[]> {
  try {
    const picked = Array.isArray(worlds) ? worlds.filter((name) => typeof name === 'string' && name.trim() !== '') : [];
    if (picked.length === 0) return [];

    const port = createWorldbookPort();
    const result: UiEntry[] = [];
    const seenUids = new Set<string>();

    for (const world of picked) {
      let entries: WbEntry[];
      try {
        entries = await port.readAll(world);
      } catch (error) {
        // 单本世界书读不到（被删了 / 没绑定）不影响其他世界书
        console.warn('[苍玄助手] 读取世界书条目失败：' + world, error);
        continue;
      }

      let group = '';
      for (const entry of entries) {
        const name = asTrimmed(entry.name);
        const title = separatorGroup(name);
        if (title !== null) {
          group = title;
          continue; // 分隔条目只提供组名，不当条目
        }

        const uid = asTrimmed(entry.uid);
        if (!uid || seenUids.has(uid)) continue; // 多本世界书之间去重，避免界面 key 撞车
        seenUids.add(uid);

        // 只带 uid/name/group，content 留在数据层
        result.push({ uid, name, group: ownGroup(entry) || group });
      }
    }

    return result;
  } catch (error) {
    console.warn('[苍玄助手] 读取条目失败，返回空列表', error);
    return [];
  }
}

/**
 * 工具注册表（`registry.catalog()`）→ 设置页 / 工具详情页要用的行。
 *
 * 全字段透传：详情页要拿内置的 model_description / parameters / timeout_ms / readonly
 * 才能跟覆盖项比对（内核没给就保持 undefined，界面明说「还没暴露」，不自己编一份文案）。
 */
export interface ToolCatalogLike {
  name: string;
  title?: string;
  desc?: string;
  group?: string;
  /** 分组显示名（内核直接给，界面不自己翻） */
  group_label?: string;
  default_on?: boolean;
  user_initiated_only?: boolean;
  /** 内核清单里没有这个工具 */
  missing?: boolean;
  /** 内置默认的「进模型的那段说明」（工具页编辑的就是它） */
  model_description?: string;
  /** 参数 JSON Schema（详情页逐个渲染参数说明 / 默认值） */
  parameters?: Record<string, unknown>;
  timeout_ms?: number;
  readonly?: boolean;
  source?: 'builtin' | 'external';
  origin?: string;
  /** 工具自己的声明式设置（阶段 4）；内核没给就保持 undefined */
  settings?: SettingsSchema;
}

export function toUiTools(rows: ToolCatalogLike[]): UiTool[] {
  return rows.map((r) => {
    // 老 5 个键一直在（老界面的形状不变）；其余字段只有内核真给了才带上，
    // 没给就保持键缺席（读出来同样是 undefined，界面据此标「还没暴露」）。
    const tool: UiTool = {
      name: r.name,
      title: r.title,
      desc: r.desc,
      group: r.group,
      default_on: r.default_on,
    };
    if (r.group_label !== undefined) tool.group_label = r.group_label;
    if (r.user_initiated_only !== undefined) tool.user_initiated_only = r.user_initiated_only;
    if (r.missing !== undefined) tool.missing = r.missing;
    if (r.model_description !== undefined) tool.model_description = r.model_description;
    if (r.parameters !== undefined) tool.parameters = r.parameters;
    if (r.timeout_ms !== undefined) tool.timeout_ms = r.timeout_ms;
    if (r.readonly !== undefined) tool.readonly = r.readonly;
    if (r.source !== undefined) tool.source = r.source;
    if (r.origin !== undefined) tool.origin = r.origin;
    if (r.settings !== undefined) tool.settings = r.settings;
    return tool;
  });
}

/* ============================ 模型列表 ============================ */

/** 把各种形状的模型列表统一成 string[]（OpenAI `{data:[{id}]}`、纯数组、字符串数组都认） */
function normalizeModelList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : isPlainRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : isPlainRecord(raw) && Array.isArray(raw.models)
        ? raw.models
        : [];

  const models: string[] = [];
  for (const item of list) {
    const id =
      typeof item === 'string'
        ? item.trim()
        : isPlainRecord(item)
          ? asTrimmed(item.id ?? item.name ?? item.model)
          : '';
    if (id && !models.includes(id)) models.push(id);
  }
  return models;
}

/** 直连 `{url}/models`（酒馆助手没有 getModelList 时的兜底） */
async function fetchModelsDirect(url: string, key: string, timeoutSec: unknown): Promise<string[]> {
  const endpoint = url.replace(/\/+$/, '') + '/models';
  const seconds = Math.min(Math.max(Number(timeoutSec) || 30, 5), 30);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), seconds * 1000);

  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = 'Bearer ' + key;
    const response = await fetch(endpoint, { method: 'GET', headers, signal: controller?.signal ?? undefined });
    if (!response.ok) {
      console.warn('[苍玄助手] 获取模型列表失败：HTTP ' + response.status);
      return [];
    }
    return normalizeModelList(await response.json());
  } catch (error) {
    console.warn('[苍玄助手] 获取模型列表失败', error);
    return [];
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 连接并获取模型列表。
 *
 * - 填了接口地址（自己填的接口）→ 优先用酒馆助手的 getModelList（走酒馆后端，不怕跨域），
 *   拿不到再直连 `{url}/models`（Bearer key）
 * - 走酒馆默认接口又没填地址 → 列表拿不到，返回空数组，模型名手填
 *
 * 任何失败都返回空数组（不抛）。
 */
export async function fetchModels(api: ApiSettings): Promise<string[]> {
  try {
    const url = asTrimmed(api?.url);
    const key = typeof api?.key === 'string' ? api.key : '';
    if (!url) {
      console.info('[苍玄助手] 没填接口地址，取不到模型列表，请手填模型名');
      return [];
    }

    const getModelList = hostFn('getModelList');
    if (getModelList) {
      try {
        const models = normalizeModelList(await getModelList({ apiurl: url, key }));
        if (models.length > 0) return models;
      } catch (error) {
        console.warn('[苍玄助手] getModelList 失败，改直连接口', error);
      }
    }

    return await fetchModelsDirect(url, key, api?.timeout_sec);
  } catch (error) {
    console.warn('[苍玄助手] 获取模型列表失败', error);
    return [];
  }
}

/** 手动传一张立绘：读文件 → 解析元数据 → 返回给界面显示 */
export async function parsePortraitFile(file: File): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    const result = await readPortraitMetaFromFile(file);
    if (!result.ok) {
      return { ok: false, text: '', error: result.error || '读取文件失败' };
    }

    const text = (result.extracted?.text ?? '').trim();
    if (!text) {
      // 图读到了，但没有可用的提示词字段（例如图床把元数据剥了）
      return { ok: false, text: '', error: describePortraitResult(result) };
    }

    return { ok: true, text };
  } catch (error) {
    console.warn('[苍玄助手] 解析上传的立绘失败', error);
    return { ok: false, text: '', error: errorText(error) };
  }
}
