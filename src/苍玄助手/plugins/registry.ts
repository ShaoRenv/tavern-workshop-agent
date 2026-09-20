/**
 * 插件注册表 + 聚合。
 *
 * 这一版（阶段 1）只装三个内置插件：苍玄助手（原立绘）/ 世界书 / 生图。
 * MCP 在第 5 阶段加进来（它的工具要运行时注册，静态表装不下）。
 *
 * 聚合口径：**插件开关在 plugin_state（底座拥有），插件设置在自己那段 plugins.<id>（插件拥有）**。
 * 所有「已启用的插件给了什么」都从这份表现算，不缓存 —— 关插件立刻消失，没有第二个真相源。
 */
import { mergePages, tabbarPages, type PageEntry } from '../core/pages.ts';
import type { PluginId, PluginManifest, PluginStateHost, PluginStatus, PluginToolRef } from './types.ts';

/** 世界书那 6 个默认给的工具（顺序 = manifest 声明顺序；entry_meta 是按需的，不在这里） */
const WB_TOOLS: PluginToolRef[] = [
  { name: 'wb_list' },
  { name: 'wb_search' },
  { name: 'wb_read' },
  { name: 'entry_create' },
  { name: 'entry_edit' },
  { name: 'entry_delete' },
];

/** 一个工具引用是不是「默认给」（缺省就是给） */
function toolDefaultOn(ref: PluginToolRef): boolean {
  return ref.defaultOn !== false;
}
export const PLUGIN_MANIFESTS: PluginManifest[] = [
  {
    id: 'cangxuan',
    name: '苍玄助手',
    desc: '苍玄界专用：立绘页 + 图片提示词宏 + 角色卡图片工具。（页面在第 3 阶段去掉，宏与工具留着）',
    version: '0.1',
    apiVersion: 1,
    builtin: true,
    defaultEnabled: true,
    contributes: {
      pages: [{ id: 'portraits', title: '立绘', order: 10, inTabbar: true }],
      tools: [],
    },
  },
  {
    id: 'worldbook',
    name: '世界书',
    desc: '读写酒馆世界书：列 / 搜 / 读 / 建 / 改 / 删 / 改属性（7 个工具 + 一个页面）。',
    version: '0.1',
    apiVersion: 1,
    builtin: true,
    defaultEnabled: true,
    contributes: {
      pages: [{ id: 'worldbook', title: '世界书', order: 20, inTabbar: true }],
      tools: [...WB_TOOLS, { name: 'entry_meta', defaultOn: false }],
    },
  },
  {
    id: 'image',
    name: '生图',
    desc: '接 NovelAI 生图：模型调 gen_image 画图，图直接进对话。',
    version: '0.1',
    apiVersion: 1,
    builtin: true,
    defaultEnabled: false,
    contributes: { tools: [{ name: 'gen_image' }] },
    status: config => {
      const bag = (config ?? {}) as Record<string, unknown>;
      const key = typeof bag.api_key === 'string' ? bag.api_key.trim() : '';
      const site = typeof bag.site === 'string' ? bag.site : 'official';
      const siteUrl = typeof bag.site_url === 'string' ? bag.site_url.trim() : '';
      if (!key) return { label: '缺 API Key', kind: 'warn' };
      if (site === 'proxy' && !siteUrl) return { label: '缺反代地址', kind: 'warn' };
      return { label: '已启用', kind: 'ok' };
    },
  },
];

/** 按 id 取插件清单；没有就抛（配错 id 是代码错，不该静默） */
export function pluginManifest(id: PluginId): PluginManifest {
  const hit = PLUGIN_MANIFESTS.find(item => item.id === id);
  if (!hit) throw new Error('没有这个插件：' + id);
  return hit;
}

/** 插件开着吗：plugin_state 里有就听它的，没有就用 manifest.defaultEnabled */
export function pluginEnabled(state: PluginStateHost, id: PluginId): boolean {
  const hit = state.plugin_state?.[id];
  if (hit && typeof hit.enabled === 'boolean') return hit.enabled;
  return pluginManifest(id).defaultEnabled;
}

/** 已启用的插件（列表顺序 = 声明顺序） */
export function enabledPlugins(state: PluginStateHost): PluginManifest[] {
  return PLUGIN_MANIFESTS.filter(manifest => pluginEnabled(state, manifest.id));
}

/** 已启用插件贡献的页面（带 owner，便于调试与「它加了什么」） */
export function pluginPages(state: PluginStateHost): PageEntry[] {
  const out: PageEntry[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const page of manifest.contributes.pages ?? []) {
      out.push({ id: page.id, title: page.title, order: page.order, inTabbar: page.inTabbar !== false, owner: manifest.id });
    }
  }
  return out;
}

/** 全部页面（核心页 + 插件页），已按 order 排好 */
export function allPages(state: PluginStateHost): PageEntry[] {
  return mergePages(pluginPages(state));
}

/** 能上顶栏的页面 */
export function availablePages(state: PluginStateHost): PageEntry[] {
  return tabbarPages(allPages(state));
}


/**
 * 已启用插件**默认进全局能力**的工具名（按声明顺序，去重）。
 *
 * 注意这跟「插件注册了哪些工具」不是一回事：世界书注册 7 个、默认给 6 个（entry_meta 按需）。
 * 全局能力 = DEFAULT_ON_TOOLS ∪ 这里 —— 默认状态下应该**恰好等于** DEFAULT_ON_TOOLS（有测试钉住）。
 */
export function pluginTools(state: PluginStateHost): string[] {
  return collectTools(state, true);
}

/** 已启用插件**注册的全部**工具名（界面 / 归属用，含按需工具） */
export function pluginAllTools(state: PluginStateHost): string[] {
  return collectTools(state, false);
}

function collectTools(state: PluginStateHost, onlyDefault: boolean): string[] {
  const out: string[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const ref of manifest.contributes.tools ?? []) {
      if (onlyDefault && !toolDefaultOn(ref)) continue;
      if (!out.includes(ref.name)) out.push(ref.name);
    }
  }
  return out;
}

/**
 * 工具归谁：插件 id，或 'base'（底座注册表里的工具）。
 *
 * 认**全部**已声明工具（不管插件开没开、也不管是不是按需工具）：归属是静态事实，
 * 关着的时候界面还要靠它标「来源已停用」。
 */
export function toolOwner(name: string): PluginId | 'base' {
  for (const manifest of PLUGIN_MANIFESTS) {
    if ((manifest.contributes.tools ?? []).some(ref => ref.name === name)) return manifest.id;
  }
  return 'base';
}

/** 工具来源标签（界面上必须可见：底座 / 某个插件的名字） */
export function toolOwnerLabel(name: string): string {
  const owner = toolOwner(name);
  return owner === 'base' ? '底座' : pluginManifest(owner).name;
}

/**
 * 插件状态标签。
 * 优先级：未启用 > 插件自己说的（缺配置 / 出错）> 已启用。
 */
export function pluginStatus(state: PluginStateHost, id: PluginId, config: unknown): PluginStatus {
  if (!pluginEnabled(state, id)) return { label: '未启用', kind: '' };
  const manifest = pluginManifest(id);
  return manifest.status ? manifest.status(config) : { label: '已启用', kind: 'ok' };
}