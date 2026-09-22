/**
 * 世界书插件 · 清单。
 *
 * 自包含目录：manifest（本文件）+ tools.ts（7 个工具）+ Page.vue（世界书页）。
 * 依赖方向单向：plugins/builtin/worldbook → core / agent，**插件之间零 import**。
 *
 * 工具现在是**真的 ToolDef[]**（阶段 3 契约）：实现在同目录 tools.ts，这里只是把它 import 进来。
 * entry_meta 的 default_on: false 来自它自己的 ToolDef（不再有 PluginToolRef.defaultOn）。
 *
 * ─────────────────────────── requires 的口径（P4-7）───────────────────────────
 *
 * 名字逐字取自 core/capability.ts 的 CAPABILITIES（写错 = 装载失败，故意的）。
 * 「必需 / 可选」不是照抄能力表里的 required 字段，而是按**本插件自己的代码路径**定的：
 *
 *   必需（缺了这插件就干不了活 —— core/worldbook.ts 用 requireHostFn，取不到直接抛）：
 *     · getWorldbook      读整本世界书（readAll / readByUid / search 都走它）
 *                          → 缺了 wb_list / wb_search / wb_read 全废，页面也是空的
 *     · replaceWorldbook  全量写回（writeAll，草稿落地唯一出口）
 *                          → 缺了「改完存不回去」，7 个工具里凡是能改的都是假动作
 *
 *   可选（缺了只降级，插件照常装载 —— 代码里是 hostFn + 空数组 / 兜底返回）：
 *     · getWorldbookNames          list() 取不到返回 []；界面列不出名字但能跑
 *     · getGlobalWorldbookNames    current() 里 try/catch 后 continue
 *     · getCharWorldbookNames      current() 里 try/catch 后 continue
 *     · getChatWorldbookName       current() 里 try/catch 后 continue
 *     · createWorldbook            建新本用；缺了还有 createOrReplaceWorldbook 兜底
 *     · deleteWorldbook            只影响 entry_delete 之外没有删除它的路径
 *
 *   为什么不声明 createOrReplaceWorldbook：它**不在**能力表里（26 个名字里没有它），
 *   声明它 = probeCapabilities 判 fail = 世界书插件整个装不上。它是 createWorldbook
 *   的**内部兜底**（worldbook.ts:531），不是对外能力，不该出现在 requires 里。
 *
 *   为什么列表类的四个是「可选」而不是「必需」：它们全是 hostFn()（不是 requireHostFn），
 *   取不到就是返回 []/跳过 —— 那是**降级**，不是不可用。把它们写成必需会让
 *   「只缺一个枚举接口」的机器整插件消失，比降级更糟。
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
    requires: [
      'getWorldbook',
      'replaceWorldbook',
      'getWorldbookNames?',
      'getGlobalWorldbookNames?',
      'getCharWorldbookNames?',
      'getChatWorldbookName?',
      'createWorldbook?',
      'deleteWorldbook?',
    ],
  },
};

export default manifest;
