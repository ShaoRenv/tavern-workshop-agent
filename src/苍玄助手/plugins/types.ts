/**
 * 插件契约（阶段 1 定死，阶段 3 补齐装载口径）。
 *
 * 底座只承诺这三件事：
 *   1. 插件往四张注册表里贡献东西（页面 / 工具 / 技能 / 宏）+ 预设 + 设置字段；
 *   2. 插件只拿得到底座给的 host，**插件之间不许互相 import**；
 *   3. 贡献的东西必须「关掉即消失」（关插件 → 页面没了、工具不给模型、宏换空串）。
 *
 * 阶段 3 的关键变化：**contributes.tools 从 `PluginToolRef{name}` 换成真的 `ToolDef`**。
 * 从此「插件 = 一个自包含目录 + manifest.ts」，内置插件与未来外部插件同形 ——
 * 外部插件只剩「目录里的文件从哪来」这一个问题了。
 */
import type { ToolDef } from '../core/ports.ts';

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
 * id 跟**老页签 id 一致**（worldbook）→ 老数据零迁移。
 * component 在阶段 3 起由插件目录自己提供（静态 import，见 App.vue 的装配表）——
 * 单文件酒馆脚本里 `import()` 拆出的 chunk 永远 404，所以插件页**只能静态 import**。
 */
export interface PluginPage {
  id: string;
  /** 顶栏显示名 */
  title: string;
  /** 排序：核心页 10/90，插件页排在自己该在的位置 */
  order: number;
  /** false = 不上顶栏，从插件管理页「它加了什么 → 页面」进；缺省 true */
  inTabbar?: boolean;
}

/**
 * 插件贡献的一个宏。
 *
 * `scopes` 决定这个宏在哪能生效：
 *   - 'tavern'：注册进酒馆宏引擎（酒馆助手 registerMacroLike / ST registerMacro），角色卡里也能用；
 *   - 'preset'：只在苍玄助手自己的预设渲染里替换。
 * 两个都给 = 两边都认。
 *
 * `render` 收到的是底座的宏上下文（MacroData 的形状由 core/macros.ts 定），
 * 插件自己决定怎么把数据变成字符串 —— 底座不认识任何具体宏名。
 */
export interface PluginMacro {
  /** 宏名（不含花括号），如 '图片提示词' */
  name: string;
  scopes: Array<'tavern' | 'preset'>;
  /** 一句话说明（界面 / 文档用） */
  desc?: string;
  render: (data: PluginMacroContext) => string;
}

/**
 * 宏上下文：底座给插件渲染宏时能看到的全部数据。
 *
 * 故意做成宽松的 Record：插件的宏不该依赖某个具体字段一定存在，
 * 拿不到就渲染空串（老预设里写了这个宏也不至于报错）。
 */
export type PluginMacroContext = Record<string, unknown>;

/**
 * 插件贡献的一个设置字段（阶段 4 起由声明式 SettingsForm.vue 渲染）。
 *
 * 阶段 3 只补**契约**：插件声明字段，界面暂时仍可自己画 —— 但外部插件
 * 没有自己画界面的机会，所以字段形状现在就要定死。
 */
export interface PluginSettingField {
  /** 存在 plugins.<id>.<key> 里 */
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'switch' | 'select' | 'textarea';
  /** 一句话说明 */
  hint?: string;
  /** 缺省值（类型与 type 对应） */
  default?: unknown;
  /** type='select' 时的选项 */
  options?: Array<{ value: string; label: string }>;
  /** number 用 */
  min?: number;
  max?: number;
  /** 正数才显示（值是 plugins.<id> 下的另一个字段名）—— 声明式表单的「条件显示」 */
  showIf?: string;
}

/**
 * 插件清单。
 *
 * 阶段 3 起 `contributes.tools` 直接就是 `ToolDef[]`（字段形状**只留一种**）：
 * 工具的实现、说明、schema、default_on 全在插件目录里，底座只负责按开关筛选后喂给模型。
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
    tools?: ToolDef[];
    macros?: PluginMacro[];
    skills?: PluginSkillRef[];
    presets?: PluginPresetRef[];
    settings?: PluginSettingField[];
  };
  /**
   * 插件自己算状态（未启用由底座先判，这里只管「开着的插件缺什么」）。
   * 缺省实现：开着就是「已启用」。
   */
  status?: (config: unknown) => PluginStatus;
}

/**
 * 插件贡献的技能（阶段 3 只补契约）。
 *
 * 技能的定义文件（SKILL.md）由插件目录自己带，这里只声明名字与用途，
 * 底座把它并进技能注册表 —— 关插件即从列表消失。
 */
export interface PluginSkillRef {
  name: string;
  /** 一句话用途（技能列表上显示） */
  desc: string;
  /** 技能正文（Markdown）。静态字符串，或按需读（阶段 6 外部插件会用后者） */
  content: string;
}

/**
 * 插件贡献的「入口」（预设）。
 *
 * 与其它贡献**语义不同**：预设是**入口**，导入后归用户所有 ——
 * 关掉插件**不回收**用户已经用上的预设（活的贡献才「关掉即消失」）。
 */
export interface PluginPresetRef {
  name: string;
  desc: string;
  /** 预设内容（形状由 presets/ 定；阶段 3 只搬运声明） */
  build: () => unknown;
}

/** plugin_state 的最小形状：注册表函数只依赖它，不依赖整个 RootData（免得 import 成环） */
export interface PluginStateHost {
  plugin_state?: Record<string, { enabled?: boolean } | undefined>;
}