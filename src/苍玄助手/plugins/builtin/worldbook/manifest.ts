/**
 * 世界书插件 · 清单。
 *
 * 自包含目录：manifest（本文件）+ tools.ts（7 个工具）+ Page.vue（世界书页）。
 * 依赖方向单向：plugins/builtin/worldbook → core / agent，**插件之间零 import**。
 *
 * 工具现在是**真的 ToolDef[]**（阶段 3 契约）：实现在同目录 tools.ts，这里只是把它 import 进来。
 * entry_meta 的 default_on: false 来自它自己的 ToolDef（不再有 PluginToolRef.defaultOn）。
 */
import type { PluginManifest } from '../../types.ts';
import { createWorldbookTools } from './tools.ts';

export const manifest: PluginManifest = {
  id: 'worldbook',
  name: '世界书',
  desc: '读写酒馆世界书：列 / 搜 / 读 / 建 / 改 / 删 / 改属性（7 个工具 + 一个页面）。',
  version: '0.1',
  apiVersion: 1,
  builtin: true,
  defaultEnabled: true,
  contributes: {
    // 页面 id 跟老页签 id 一致（worldbook）→ 老数据零迁移；order 30 = 对话(10) 与设置(90) 之间
    pages: [{ id: 'worldbook', title: '世界书', order: 30, inTabbar: true }],
    tools: createWorldbookTools(),
  },
};

export default manifest;
