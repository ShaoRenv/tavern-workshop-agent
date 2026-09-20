/**
 * 插件契约（第 1 阶段定死）。
 *
 * 底座只承诺这三件事：
 *   1. 插件往四张注册表里贡献东西（页面 / 工具 / 技能 / 宏；本阶段只用到 页面 + 工具）；
 *   2. 插件只拿得到底座给的 host，**插件之间不许互相 import**；
 *   3. 贡献的东西必须「关掉即消失」（关插件 → 页面没了、工具不给模型）。
 *
 * 字段是**故意留少**的：阶段 3 起才加 skills / presets / macros，阶段 4 起才加 settings。
 * 没实现的东西不预埋 —— 预埋的字段没人知道自己该填什么。
 */

/** 插件 id：cangxuan / worldbook / image / mcp */
export type PluginId = string;

/** 插件状态标签（列表行 / 插件管理页共用一份口径） */
export interface PluginStatus {
  label: string;
  /** 给 .cx-tag 的类名：'' | 'ok' | 'warn' | 'dang' */
  kind: '' | 'ok' | 'warn' | 'dang';
}

/**
 * 插件贡献的页面 = 顶栏的一格。
 *
 * id 跟**老页签 id 一致**（portraits / worldbook）→ 老数据零迁移。
 * 页面组件在阶段 3 之前由 App.vue 的一张静态表按 id 提供，所以这里不带 component。
 */
export interface PluginPage {
  id: string;
  /** 顶栏显示名 */
  title: string;
  /** 排序：核心页 30/40/50/90，插件页排在自己该在的位置（阶段 1 要与老顺序逐格一致） */
  order: number;
  /** false = 不上顶栏，从插件管理页「它加了什么 → 页面」进；缺省 true */
  inTabbar?: boolean;
}

/**
 * 插件声明的一个工具引用。
 *
 * `defaultOn`（缺省 true）= 插件开着时它进全局能力。
 * 少数「按需」工具要写 false —— 世界书的 entry_meta（改条目属性）就是这样：
 * 世界书插件默认开着，绝不能因为「插件开着」就把它抬成默认开（那会让模型默认多一个工具、
 * 界面上的「默认关」标签也自相矛盾）。要按需用它，在预设里勾。
 */
export interface PluginToolRef {
  name: string;
  /** false = 插件开着也**不默认进全局能力**（仍然注册、界面里看得见、预设能勾） */
  defaultOn?: boolean;
}

/**
 * 插件清单。
 *
 * 阶段 1 的 contributes.tools 只声明**工具归谁、默不默认给**，工具的实现在 agent/registry.ts
 * （阶段 3 才搬进插件目录）；这样「关插件 → 它的工具消失」在第 1 阶段就能生效，而不用先搬家。
 */
export interface PluginManifest {
  id: PluginId;
  /** 列表里显示的名字（不带「插件」后缀：列表里每行都是插件） */
  name: string;
  /** 一句话：这插件干什么（列表行上用） */
  desc: string;
  version: string;
  /** 底座只保证同大版本兼容 */
  apiVersion: 1;
  /** true = 内置（可关不可卸）；false = 外部装载（二期） */
  builtin: boolean;
  /** plugin_state 里没有这个 id 时的缺省开关 */
  defaultEnabled: boolean;
  contributes: {
    pages?: PluginPage[];
    tools?: PluginToolRef[];
  };
  /**
   * 插件自己算状态（未启用由底座先判，这里只管「开着的插件缺什么」）。
   * 缺省实现：开着就是「已启用」。
   */
  status?: (config: unknown) => PluginStatus;
}

/** plugin_state 的最小形状：注册表函数只依赖它，不依赖整个 RootData（免得 import 成环） */
export interface PluginStateHost {
  plugin_state?: Record<string, { enabled?: boolean } | undefined>;
}