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
  },
  status: cangxuanStatus,
};

export default manifest;