/**
 * 苍玄助手插件（原「立绘」页）。
 *
 * 阶段 3 起它**没有页面**了 —— 顶栏收成 3 格（对话 / 世界书 / 设置），
 * 它的界面入口在设置页与插件管理页里。
 *
 * 它贡献两样东西：
 *   1. 宏：图片提示词（酒馆 + 预设两边都能用）、角色列表 / 图片元数据（预设里用）；
 *   2. 工具：portrait_list / portrait_meta / portrait_prompt。
 *
 * ⚠️ **它现在不贡献设置字段**：gallery / meta_rule 还没被任何代码消费，
 * 声明出来只会变成两个点不动的死控件（完整理由写在 config.ts 的文件头）。
 * 于是插件管理页对它会显示「没有自己的设置」—— 这是当前**正确**的样子，不是漏了。
 *
 * 依赖方向：本目录 → core / agent（**插件之间零 import**）。
 *
 * ─────────────────────────── requires 的口径（P4-7）───────────────────────────
 *
 * 只声明一个，而且是**可选**：`getScriptTrees?`。
 *
 * 为什么是它：本插件的「立绘图库」走 core/portrait.ts 的 getScriptTreesViaHost()，
 * 那是它唯一真正碰宿主的地方（tools 的 portrait_list / portrait_meta / portrait_prompt
 * 与三个宏都建在它上面）。
 *
 * 为什么必须带问号（可选）而不是必需：core/portrait.ts:30-40 的口径写得很清楚 ——
 * 这个接口在 **ST 原生没有对应**（core/native.ts 的 NO_NATIVE_EQUIVALENT），
 * 只有装了酒馆助手（JS-Slash-Runner）才有。取不到时它**返回空数组并记一次原因**，
 * 由能力层在界面上显示「立绘图库：不可用（缺 getScriptTrees）」。
 * 声明成必需 = 只要玩家没装酒馆助手，整个苍玄助手插件（含三个宏）直接消失 ——
 * 那比「图库空着、别的照用」糟糕得多，也违背它自己的降级设计。
 *
 * 其余能力一个都不声明：本插件的宏与工具不碰写变量 / 生成 / 世界书，
 * 多声明一条就是凭空多一个能让它整插件消失的理由。
 */
import type { PluginManifest } from '../../types.ts';
import { cangxuanMacros } from './macros.ts';
import { createCangxuanTools } from './tools.ts';
import { cangxuanStatus } from './config.ts';

export const manifest: PluginManifest = {
  id: 'cangxuan',
  name: '苍玄助手',
  desc: '苍玄界专用：立绘元数据（图片提示词宏）+ 角色卡图片工具。界面入口在设置页。',
  version: '0.1',
  apiVersion: 1,
  builtin: true,
  defaultEnabled: true,
  contributes: {
    // 阶段 3：**不带页面** —— 顶栏 3 格（对话 / 世界书 / 设置）
    macros: cangxuanMacros(),
    tools: createCangxuanTools(),
    // getScriptTrees 是**可选**：ST 原生无此能力，缺了只降级图库，插件照常装载
    requires: ['getScriptTrees?'],
  },
  status: cangxuanStatus,
};

export default manifest;