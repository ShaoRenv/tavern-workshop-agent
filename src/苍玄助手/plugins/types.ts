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
import type { SettingsSchema, ToolDef } from '../core/ports.ts';

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
  /**
   * 进**酒馆宏引擎**时用的 ASCII 别名（可选）。
   *
   * ⚠️ 为什么需要它：酒馆的宏名**只能含 ASCII**（词法器只认 [a-zA-Z] 开头，
   * 见 MacroLexer.js:17 的 MACRO_IDENTIFIER_PATTERN）。所以中文名的宏
   * **永远不可能**在角色卡 / 酒馆里生效 —— 只会静默不替换。
   *
   * 于是分两条路走：
   *   - scopes 含 'preset'：中文名照旧，走**我们自己的**渲染器（不经酒馆词法器）→ 用户预设不用改
   *   - scopes 含 'tavern'：必须提供这个 ASCII 别名，注册给酒馆的是它
   *
   * 没给别名又声明了 'tavern' → 底座明确拒绝注册并报原因（不静默失败）。
   */
  tavernAlias?: string;
}

/**
 * 宏上下文：底座给插件渲染宏时能看到的全部数据。
 *
 * 故意做成宽松的 Record：插件的宏不该依赖某个具体字段一定存在，
 * 拿不到就渲染空串（老预设里写了这个宏也不至于报错）。
 */
export type PluginMacroContext = Record<string, unknown>;

/**
 * 插件贡献的设置声明：`SettingsSchema`（字段 + 块）。**规范形状在 core/ports.ts 的 SettingsField。**
 *
 * ⚠️ 阶段 3 这里曾经有**第二套**字段形状（`PluginSettingField`：7 种控件、把布尔叫 `switch`、
 * 条件显示只能写 `showIf: '另一个字段名'`），跟 core/ports.ts 的 `ToolSettingsField`
 * （8 种控件、布尔叫 `boolean`）不是一回事 —— 于是 `SettingsForm` 根本写不出来。
 * 阶段 4 合成**一份**：一种控件名、一种条件表达（`visibleIf` 谓词，能表达
 * `model 是 v3 才显示` 这种「跟另一个字段的值有关」而 `showIf` 表达不了的事）。
 */

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
    settings?: SettingsSchema;
    /**
     * 这个插件**需要哪些宿主能力**（能力名 = core/capability.ts 的 CAPABILITIES[].name，
     * 也就是 core/host.ts 的 hostFn 认的那个接口名）。
     *
     * 装载口径（core/capability.ts 的 evaluatePluginCapabilities）：
     *   - 底座启动**探一遍**宿主，得出一张能力表；
     *   - 这里声明的能力里，**required 的缺失 → 该插件不注册**，并给一句人话原因；
     *   - 只声明可选能力的缺失 → 照常注册，界面标「部分功能降级」。
     *
     * 为什么要有这个字段：迁移前能力可得性是**隐式**的 —— 拿不到宿主接口时插件
     * 跑起来炸在半路，用户只看到一句没有上下文的报错。声明出来后，缺能力是
     * **装载期**就能说清的事：「世界书插件不可用（缺 getWorldbook）」。
     */
    requires?: string[];
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