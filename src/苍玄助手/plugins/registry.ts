/**
 * 插件注册表 + 聚合。
 *
 * 阶段 3 起：**manifest 不再写死在这里**，而是各个插件目录自己的 `manifest.ts`，
 * 由 `plugins/builtin/index.ts` 汇总成本文件的 PLUGIN_MANIFESTS。
 * 这样内置插件与未来外部插件**同形**：一个自包含目录 + 一份 manifest。
 *
 * 聚合口径：**插件开关在 plugin_state（底座拥有），插件设置在自己那段 plugins.<id>（插件拥有）**。
 * 所有「已启用的插件给了什么」都从这份表现算，不缓存 —— 关插件立刻消失，没有第二个真相源。
 */
import { mergePages, tabbarPages, type PageEntry } from '../core/pages.ts';
import type { ToolDef } from '../core/ports.ts';
import type {
  PluginId,
  PluginMacro,
  PluginManifest,
  PluginPresetRef,
  PluginSettingField,
  PluginSkillRef,
  PluginStateHost,
  PluginStatus,
} from './types.ts';
import { BUILTIN_MANIFESTS } from './builtin/index.ts';

/** 全部插件清单（内置目录汇总；阶段 6 外部装载也并进这里） */
export const PLUGIN_MANIFESTS: PluginManifest[] = BUILTIN_MANIFESTS;

/** 一个工具是不是「默认给」（ToolDef.default_on） */
function toolDefaultOn(def: ToolDef): boolean {
  return def.default_on !== false;
}

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

/* ============================ 页面 ============================ */

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

/* ============================ 工具 ============================ */

/** 已启用插件的工具定义（**活的**：关插件就没有） */
export function pluginToolDefs(state: PluginStateHost): ToolDef[] {
  const out: ToolDef[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const def of manifest.contributes.tools ?? []) out.push(def);
  }
  return out;
}

/**
 * 已启用插件**默认进全局能力**的工具名（按声明顺序，去重）。
 *
 * 注意这跟「插件注册了哪些工具」不是一回事：世界书注册 7 个、默认给 6 个（entry_meta 按需）。
 * 全局能力 = DEFAULT_ON_TOOLS ∪ 这里 —— 默认状态下应该**恰好等于** DEFAULT_ON_TOOLS（有测试钉住）。
 */
export function pluginTools(state: PluginStateHost): string[] {
  return collectToolNames(state, true);
}

/** 已启用插件**注册的全部**工具名（界面 / 归属用，含按需工具） */
export function pluginAllTools(state: PluginStateHost): string[] {
  return collectToolNames(state, false);
}

function collectToolNames(state: PluginStateHost, onlyDefault: boolean): string[] {
  const out: string[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const def of manifest.contributes.tools ?? []) {
      if (onlyDefault && !toolDefaultOn(def)) continue;
      if (!out.includes(def.name)) out.push(def.name);
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
    if ((manifest.contributes.tools ?? []).some(def => def.name === name)) return manifest.id;
  }
  return 'base';
}

/** 工具来源标签（界面上必须可见：底座 / 某个插件的名字） */
export function toolOwnerLabel(name: string): string {
  const owner = toolOwner(name);
  return owner === 'base' ? '底座' : pluginManifest(owner).name;
}

/* ============================ 宏 / 技能 / 预设 / 设置 ============================ */

/** 已启用插件贡献的宏（关插件即消失 → 渲染退回空串） */
export function pluginMacros(state: PluginStateHost): PluginMacro[] {
  const out: PluginMacro[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const macro of manifest.contributes.macros ?? []) out.push(macro);
  }
  return out;
}

/** 已启用插件贡献的技能 */
export function pluginSkills(state: PluginStateHost): PluginSkillRef[] {
  const out: PluginSkillRef[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const skill of manifest.contributes.skills ?? []) out.push(skill);
  }
  return out;
}

/**
 * 已启用插件贡献的预设入口。
 *
 * ⚠️ 与其它贡献语义不同：预设是**入口**，导入后归用户所有 ——
 * 关掉插件不回收用户已经用上的预设，所以这里只用于「导入时列出来供选」。
 */
export function pluginPresets(state: PluginStateHost): PluginPresetRef[] {
  const out: PluginPresetRef[] = [];
  for (const manifest of enabledPlugins(state)) {
    for (const preset of manifest.contributes.presets ?? []) out.push(preset);
  }
  return out;
}

/** 某个插件的设置字段（阶段 4 声明式表单用；不依赖开关，配置界面总要看得到） */
export function pluginSettingFields(id: PluginId): PluginSettingField[] {
  return pluginManifest(id).contributes.settings ?? [];
}

/* ============================ 状态 ============================ */

/**
 * 插件状态标签。
 * 优先级：未启用 > 插件自己说的（缺配置 / 出错）> 已启用。
 */
export function pluginStatus(state: PluginStateHost, id: PluginId, config: unknown): PluginStatus {
  if (!pluginEnabled(state, id)) return { label: '未启用', kind: '' };
  const manifest = pluginManifest(id);
  return manifest.status ? manifest.status(config) : { label: '已启用', kind: 'ok' };
}