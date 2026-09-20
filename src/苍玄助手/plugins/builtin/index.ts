/**
 * 内置插件汇总 —— **全工程唯一列出内置插件的地方**。
 *
 * 每个插件是一个自包含目录：
 *   plugins/builtin/<id>/
 *     manifest.ts   插件清单（contributes 声明它给底座贡献什么）
 *     tools.ts      它的工具（ToolDef[]）
 *     Page.vue      它的页面（可选；没有页面就不写这个文件）
 *     其它实现文件
 *
 * 依赖方向**单向**：plugins/builtin/* → core / agent，**插件之间零 import**。
 * 加一个内置插件 = 建一个目录 + 在这里加一行。
 *
 * 阶段 6 的外部插件装载会走同一条路：把外部目录的 manifest 并进这个数组。
 */
import { manifest as cangxuan } from './cangxuan/manifest.ts';
import { manifest as worldbook } from './worldbook/manifest.ts';
import { manifest as image } from './image/manifest.ts';
import type { PluginManifest } from '../types.ts';

export const BUILTIN_MANIFESTS: PluginManifest[] = [cangxuan, worldbook, image];

export default BUILTIN_MANIFESTS;