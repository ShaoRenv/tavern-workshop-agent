/**
 * 生图插件 · 清单。
 *
 * 自包含目录：manifest（本文件）+ tools.ts（gen_image）+ nai.ts（NovelAI 适配层）+ options.ts（选项表）
 * + settings.ts（它的设置声明）。
 * 依赖方向单向：plugins/builtin/image → core / agent，**插件之间零 import**。
 *
 * 默认 **关**（defaultEnabled: false）：生图 API 没配好时开着只会诱导模型乱调、白烧钱，
 * 用户要自己在「能力 · 插件」里打开。status() 告诉界面它现在缺什么。
 *
 * 阶段 4：它的设置整页改成**声明式** —— `contributes.settings` 是 `SettingsSchema`（字段 + 块），
 * 宿主 `components/SettingsForm.vue` 负责画。**加一个字段只改 settings.ts**，界面不用动。
 *
 * ─────────────────────────── requires 的口径（P4-7，P5-5 更新）───────────────────────────
 *
 * **本插件什么都不声明（requires 缺省 / 空）** —— 这是查实的结论，不是漏了。
 *
 * 查法：grep 本目录全部宿主调用点，只有一处 —— nai.ts 的 `hostFn('fetch')`。
 *
 * · 它**不需要**写：生图是**用户自己填接口地址**直连 NovelAI（config.site / api_key），
 *   不经过酒馆助手，也不需要模型生成能力。fetch 是**运行时平台自带**的，不是「酒馆给的能力」。
 * · 它**可以**写了（P5-5 起）：`fetch` 已登记进 core/capability.ts，来源归 `'platform'` 档。
 *   在那之前它是**不能写**的 —— 会撞上「requires 名字必须在能力表里」的静态闸，
 *   被判成 typo，导致整插件装不上。（这正是 P5-5 修掉的那个坑。）
 * · 任务描述里假设过 `['generateImage']` —— 能力表里**没有这个名字**，
 *   照抄会让插件永远装不上（这正是静态闸要防的「名字打错」。我实查后否掉了它）。
 *
 * ⚠️ **既然现在能写了，为什么仍然选择不写？**（这是取舍，不是遗漏）
 *   1. **装载行为完全一致**：`fetch` 是 `required: false` 的可选能力，
 *      而 `pluginCapabilitySkips` 只在**必需**能力缺失时才产出 skip 记录；
 *      就算某台机器真的没有 fetch，也只会记进 `missingOptional`，**不拦装**。
 *   2. **「更诚实」这个收益落不了地**：可选缺失当前**上不了界面**（不生成 skip 记录），
 *      所以声明与否用户看不到任何差别。
 *   3. **成本是真的**：这是行为变更，要复跑 image 那组测试；
 *      而 image `defaultEnabled: false`，本来就只在用户显式开启后才跑。
 *      为「语义上更完整」去动一个能跑的插件，收益/风险比不划算。
 *
 * 结论：requires 保持缺省 = 生图插件在**任何**宿主环境都照常装载，
 * 只受它自己的 status()（缺 API Key / 缺反代地址）与开关控制。
 *
 * 📌 将来若真的要声明它，直接写 `requires: ['fetch']` 即可 —— 静态闸已经不拦它了（P5-5）。
 */
import type { PluginManifest } from '../../types.ts';
import { IMAGE_SETTINGS } from './settings.ts';
import { createImageTools } from './tools.ts';

export const manifest: PluginManifest = {
  id: 'image',
  name: '生图',
  desc: '接 NovelAI 生图：模型调 gen_image 画图，图直接进对话。',
  version: '0.1',
  apiVersion: 1,
  builtin: true,
  defaultEnabled: false,
  contributes: {
    tools: createImageTools(),
    // 声明式设置：字段 + 块合在一个 SettingsSchema 里（P4-1 契约），字段与它的块一起搬家
    settings: IMAGE_SETTINGS,
    // requires 缺省 = 不依赖任何宿主能力（唯一用到的 fetch 是运行时平台自带的，已登记为 'platform' 档）。
    // 这里**故意不写空数组**：空数组与缺省同义，但缺省少一行、也就少一个「以后被人填充错」的地方。
  },
  status: config => {
    const bag = (config ?? {}) as Record<string, unknown>;
    const key = typeof bag.api_key === 'string' ? bag.api_key.trim() : '';
    const site = typeof bag.site === 'string' ? bag.site : 'official';
    const siteUrl = typeof bag.site_url === 'string' ? bag.site_url.trim() : '';
    if (!key) return { label: '缺 API Key', kind: 'warn' };
    if (site === 'proxy' && !siteUrl) return { label: '缺反代地址', kind: 'warn' };
    return { label: '已启用', kind: 'ok' };
  },
};

export default manifest;
