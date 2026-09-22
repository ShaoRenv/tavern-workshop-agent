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
import type { SettingsField, SettingsSchema, ToolDef } from '../core/ports.ts';
import type {
  PluginId,
  PluginMacro,
  PluginManifest,
  PluginPresetRef,
  PluginSkillRef,
  PluginStateHost,
  PluginStatus,
} from './types.ts';
import { BUILTIN_MANIFESTS } from './builtin/index.ts';
import { evaluatePluginCapabilities } from '../core/capability.ts';
import { hostFn } from '../core/host.ts';

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

/* ==================== 能力闸：缺必需能力的插件**不注册**（P0-C） ==================== */

/**
 * 一个插件被能力闸挡下来的记录。
 *
 * `reason` 是**人话**，可以直接显示在插件列表行 / 设置页上 —— 这是本任务的
 * 核心验收项：能力缺失时插件被跳过，且原因不是「加载失败」这种没有信息量的文案。
 */
export interface PluginSkip {
  id: PluginId;
  /** 列表里显示的名字（插件自己的 name） */
  name: string;
  /** 一句话人话原因，如「缺少必需能力：读世界书（getWorldbook）」 */
  reason: string;
  /** 逐条明细（缺哪个能力、ST 原生对应是什么），可多行 */
  detail: string;
  /** 缺失且必需的能力名 */
  missing: string[];
}

/**
 * 让已启用插件过一遍**能力闸**。
 *
 * 口径（与 core/capability.ts 的 evaluatePluginCapabilities 同源）：
 *   - 插件在 manifest.contributes.requires 里声明自己需要哪些能力；
 *   - **required 的缺失 → 该插件被跳过**（页面 / 工具 / 宏 / 技能 / 预设全都不出）；
 *   - 只缺可选能力 → 照常装载（降级由能力自己的 degrade 负责）。
 *
 * ⚠️ 这个函数**故意不缓存**探测结果：ST 上下文是晚就绪的（实测 APP_READY
 * 556ms~24050ms），缓存住会把「启动时还没就绪」永久固化成「不可用」。
 * 探测本身很便宜（就是几次属性查找）。
 *
 * ⚠️ 探测**绝不抛**：任何异常都当成「不可用」，否则界面挂载会白屏。
 */
/*
 * ⚠️ 宿主未就绪时**不拦**（P4-7 的 requires 撞上本闸时暴露出来的洞）。
 *
 * 「宿主整个不存在」与「宿主在、但这台机器缺某个能力」是**两件完全不同的事**：
 *   - 后者：真缺，该拦 —— 用户能在设置页看到「缺能力」并知道缺什么；
 *   - 前者：不是「缺」，是「**还没接上**」。单测里 setHostBridge 随时注入；
 *     真机上扩展 activate 早于 getContext 就绪（实测 APP_READY 556ms~24050ms）。
 *
 * 把前者也拦掉会出两种事故：
 *   1. 单测环境所有宿主相关插件集体消失（worldbook 的 7 个工具全没 → 一片红）；
 *   2. **真机上插件被永久判死** —— 恰恰违反本底座到处贯彻的「晚绑定」原则：
 *      能力晚就绪不要紧，运行时再拿；而不是启动时探一次没有就一辈子不装载。
 *
 * 判据用 hostFn('getVariables')（= provider chain 四层里任意一层能给出宿主变量接口）。
 * 全都没有 ⇒ 这台机器上根本还没有宿主 ⇒ 放行，交给运行时。
 * 有宿主之后再缺具体能力 ⇒ 正常拦。
 */
function hostIsPresent(): boolean {
  try {
    return typeof hostFn('getVariables') === 'function';
  } catch {
    // 连探测链都拿不到 = 没有宿主，按「未就绪」放行
    return false;
  }
}
export function pluginCapabilitySkips(state: PluginStateHost): PluginSkip[] {
  const out: PluginSkip[] = [];
  // 宿主压根还没接上（单测 / 扩展还没 activate）→ 不拦，交给运行时按晚绑定去拿。
  if (!hostIsPresent()) return out;

  // ⚠️ 这里必须走 enabledPlugins（只看开关），**不能**走 loadablePlugins ——
  // loadablePlugins 靠本函数的结论做过滤，改回去就是无限递归。
  for (const manifest of enabledPlugins(state)) {
    let verdict: ReturnType<typeof evaluatePluginCapabilities>;
    try {
      verdict = evaluatePluginCapabilities(manifest.contributes.requires);
    } catch (error) {
      // 探测本身崩了 = 这个插件不可信，直接跳过（不能让一个插件的探测拖垮整张表）
      out.push({
        id: manifest.id,
        name: manifest.name,
        reason: '能力探测失败，已跳过该插件：' + (error instanceof Error ? error.message : String(error)),
        detail: '',
        missing: [],
      });
      continue;
    }
    if (verdict.ok) continue;
    out.push({
      id: manifest.id,
      name: manifest.name,
      reason: verdict.reason,
      detail: verdict.detail,
      missing: verdict.missingRequired.map(status => status.name),
    });
  }
  return out;
}

/** 被能力闸挡下来的插件 id 集合（内部用得快查） */
function skippedIds(state: PluginStateHost): Set<PluginId> {
  return new Set(pluginCapabilitySkips(state).map(skip => skip.id));
}

/**
 * **真正装载**的插件：开着 + 过了能力闸。
 *
 * 全底座的「已启用插件给了什么」都必须走这个函数，而不是 pluginEnabled 那套 ——
 * 否则缺能力的插件还是会往页面 / 工具 / 宏里塞东西，就回到「跑起来炸半路」了。
 * enabledPlugins 保留原语义（只看开关），给「插件管理页列表」这类需要
 * 显示「它开着但不可用」的界面用。
 */
export function loadablePlugins(state: PluginStateHost): PluginManifest[] {
  const blocked = skippedIds(state);
  return enabledPlugins(state).filter(manifest => !blocked.has(manifest.id));
}

/**
 * 插件状态标签（能力口径）。
 *
 * 优先级：未启用 > 缺必需能力（能力闸拦下）> 插件自己说的（缺配置 / 出错）> 已启用。
 * 与 pluginStatus 的区别：这个会**现探能力**，代价是几次属性查找，
 * 换来的是「插件列表能直接显示『它开着但这台机器跑不了』」。
 */
export function pluginStatusWithCapabilities(
  state: PluginStateHost,
  id: PluginId,
  config: unknown,
): PluginStatus {
  if (!pluginEnabled(state, id)) return { label: '未启用', kind: '' };
  const skip = pluginCapabilitySkips(state).find(item => item.id === id);
  if (skip) return { label: '缺能力', kind: 'dang' };
  return pluginStatus(state, id, config);
}

/* ============================ 页面 ============================ */

/** 已启用插件贡献的页面（带 owner，便于调试与「它加了什么」） */
export function pluginPages(state: PluginStateHost): PageEntry[] {
  const out: PageEntry[] = [];
  for (const manifest of loadablePlugins(state)) {
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

/* ==================== 运行时注册（MCP：跑起来才知道有什么工具） ==================== */

/**
 * 运行时注册的一条来源。
 *
 * 为什么必须有这条通道：`manifest.contributes.tools` 是**静态声明**，
 * 而 MCP 要 `initialize` + `tools/list` 之后才知道远端有什么工具 ——
 * 静态清单撑不住（设计自查 B1）。所以分两条：
 *   - 静态：manifest.contributes.tools（内置插件的工具）
 *   - 运行时：本函数（MCP 拉到什么就是什么）
 *
 * 底座**不认识「MCP」这个词**：它只知道「有个插件运行时注册了一批工具，来源标签是这个」。
 */
export interface RuntimeToolSource {
  plugin: PluginId;
  /** 界面上的来源标签，如 `MCP · 我的服务器`；留空则用插件名 */
  label: string;
  tools: ToolDef[];
}

const runtimeSources = new Map<PluginId, RuntimeToolSource>();

/** 注册结果：成功哪些、拒绝哪些（拒绝要带人话原因，不静默丢） */
export interface RuntimeRegisterReport {
  registered: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/** 全部内置插件**静态**声明的工具名（运行时注册不许撞它们） */
function staticToolNames(): Set<string> {
  const names = new Set<string>();
  for (const manifest of PLUGIN_MANIFESTS) {
    for (const def of manifest.contributes.tools ?? []) names.add(def.name);
  }
  return names;
}

/**
 * 运行时注册 / 覆盖某个插件的工具集（原子：整批换掉上一次的）。
 *
 * 口径：
 *   - **整批替换** —— 重连后远端工具可能变了，绝不能把上一批残留下来；
 *   - 名字空 / 同批重名 / 撞上静态声明的工具 → **拒绝并给出原因**（不静默成功）；
 *   - 幂等：同一个插件重复注册就是换新的一批；
 *   - 插件被关掉 / 能力闸拦下时，这批工具**自动不生效**（pluginToolDefs 只取 loadablePlugins）——
 *     所以断开时**不必须**手动注销，但断开时调 unregisterRuntimeTools 更干净。
 */
export function registerRuntimeTools(
  plugin: PluginId,
  tools: ToolDef[],
  label = '',
): RuntimeRegisterReport {
  const registered: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const staticNames = staticToolNames();
  const clean: ToolDef[] = [];

  for (const def of Array.isArray(tools) ? tools : []) {
    const name = typeof def?.name === 'string' ? def.name.trim() : '';
    if (!name) {
      rejected.push({ name: '', reason: '这个远端工具没有名字，没法进工具表' });
      continue;
    }
    if (clean.some(item => item.name === name)) {
      rejected.push({ name, reason: '同一次注册里有两个同名工具' });
      continue;
    }
    if (staticNames.has(name)) {
      rejected.push({ name, reason: '这个名字已被内置插件的工具占用（静态声明优先）' });
      continue;
    }
    clean.push(def);
    registered.push(name);
  }

  runtimeSources.set(plugin, { plugin, label, tools: clean });
  return { registered, rejected };
}

/** 撤销某个插件的运行时工具（断开 / 卸载时调；关插件时不需要，loadablePlugins 已经挡住） */
export function unregisterRuntimeTools(plugin: PluginId): void {
  runtimeSources.delete(plugin);
}

/** 某个插件当前运行时注册的工具（不管开关） */
export function runtimeToolsOf(plugin: PluginId): ToolDef[] {
  return runtimeSources.get(plugin)?.tools ?? [];
}

/** 某个插件当前运行时注册的工具名（界面 / 调试用） */
export function runtimeToolNames(plugin: PluginId): string[] {
  return runtimeToolsOf(plugin).map(def => def.name);
}

/* ============================ 工具 ============================ */

/** 已启用插件的工具定义（**活的**：关插件就没有） */
export function pluginToolDefs(state: PluginStateHost): ToolDef[] {
  const out: ToolDef[] = [];
  for (const manifest of loadablePlugins(state)) {
    for (const def of manifest.contributes.tools ?? []) out.push(def);
    // 运行时注册的工具（MCP）：插件装载着才进来 —— 关插件 / 被能力闸拦下即消失
    for (const def of runtimeToolsOf(manifest.id)) out.push(def);
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
  for (const manifest of loadablePlugins(state)) {
    const live = [...(manifest.contributes.tools ?? []), ...runtimeToolsOf(manifest.id)];
    for (const def of live) {
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
  // ⚠️ 运行时注册的工具**必须**在这里能归属：落回 'base' 的话，
  //    run/runner.ts 的 liveToolDefs 会把它当底座工具，关掉插件后照样发给模型。
  for (const [plugin, source] of runtimeSources) {
    if (source.tools.some(def => def.name === name)) return plugin;
  }
  return 'base';
}

/** 工具来源标签（界面上必须可见：底座 / 某个插件的名字 / MCP · 服务器名） */
export function toolOwnerLabel(name: string): string {
  const owner = toolOwner(name);
  if (owner === 'base') return '底座';
  const source = runtimeSources.get(owner);
  if (source && source.tools.some(def => def.name === name)) {
    return source.label.trim() !== '' ? source.label : pluginManifest(owner).name;
  }
  return pluginManifest(owner).name;
}

/* ============================ 宏 / 技能 / 预设 / 设置 ============================ */

/** 已启用插件贡献的宏（关插件即消失 → 渲染退回空串） */
export function pluginMacros(state: PluginStateHost): PluginMacro[] {
  const out: PluginMacro[] = [];
  for (const manifest of loadablePlugins(state)) {
    for (const macro of manifest.contributes.macros ?? []) out.push(macro);
  }
  return out;
}

/** 已启用插件贡献的技能 */
export function pluginSkills(state: PluginStateHost): PluginSkillRef[] {
  const out: PluginSkillRef[] = [];
  for (const manifest of loadablePlugins(state)) {
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
  for (const manifest of loadablePlugins(state)) {
    for (const preset of manifest.contributes.presets ?? []) out.push(preset);
  }
  return out;
}

/**
 * 某个插件的设置声明（阶段 4 声明式表单用）。
 *
 * ⚠️ **不依赖开关**：插件关着的时候用户也要能进去把 Key 填好再打开。
 * 这也意味着「声明了却没人消费的字段」会直接变成一个点不动的死控件 ——
 * 所以声明前先确认插件真的读它（苍玄助手那三个字段就是反例，见 config.ts 的说明）。
 */
export function pluginSettings(id: PluginId): SettingsSchema {
  return pluginManifest(id).contributes.settings ?? { fields: [] };
}

/** 只要字段清单（大部分调用方不关心分块） */
export function pluginSettingFields(id: PluginId): SettingsField[] {
  return pluginSettings(id).fields;
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