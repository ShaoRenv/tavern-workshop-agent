/**
 * 苍玄助手插件的设置与状态。
 *
 * ⚠️ 设置字段的**真 schema 在 core/types.ts 的 CangxuanConfigSchema**（存在 plugins.cangxuan），
 * 这里是同一份契约的**声明式描述**，形状用 core/ports.ts 的 SettingsField
 * （阶段 4 起只有这一份 vocabulary，不再有第二套）。
 *
 * ⚠️⚠️ **这三个字段现在故意没有接进 manifest.contributes.settings**，所以插件管理页会显示
 * 「没有自己的设置」。不是漏了，而是**它们还没被任何代码消费**：
 *   - `gallery`：只有下面的 cangxuanStatus 读过它（算状态标签）。`core/portrait.ts` 的
 *     `collectGallery()` 根本不看它 —— 立绘来源仍然只来自工坊角色 / 状态栏脚本；
 *   - `meta_rule`：谁都没读。预设里真正生效的提取规则是预设自己的 ExtractRule；
 *   - `manual_meta`：那是**插件自己的状态**（传图解析出来的路径），不是给用户改的设置项，
 *     所以它连字段都不是（原来声明成 `textarea` + `default: []`，形状本身就是错的）。
 *
 * 接上就会画出「能点、能存、但什么也不影响」的死控件 —— 这正是底座最该避免的东西。
 * 等 portrait 侧真的按 gallery / meta_rule 取值了，再把 `{ fields: CANGXUAN_SETTINGS_FIELDS }`
 * 放进 `manifest.contributes.settings`（形状已经是 SettingsSchema 能吃的）。
 * `tests/苍玄助手/plugin_settings_contract.test.ts` 有一条闸钉着这件事，改的时候会被提醒。
 *
 * `manual_meta` 的落盘本身是阶段 3 顺带修的老坑：以前手动传的立绘元数据只存在内存里，刷新就没了。
 */
import type { SettingsField } from '../../../core/ports.ts';
import type { PluginStatus } from '../../types.ts';

/** 设置字段声明（**暂时不接进 manifest，理由见文件头**） */
export const CANGXUAN_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: 'gallery',
    label: '图库来源',
    type: 'select',
    hint: '从哪儿读角色立绘：当前角色卡，或你自己传的。',
    default: 'chat',
    options: [
      { value: 'chat', label: '角色卡立绘' },
      { value: 'manual', label: '手动传图' },
    ],
  },
  {
    key: 'meta_rule',
    label: '元数据读取规则',
    type: 'textarea',
    hint: '怎么从立绘里抠出图片提示词。留空用内置规则。',
    default: '',
  },
];

/**
 * 状态：缺什么说什么。
 * 优先级由底座的 pluginStatus 保证（未启用 > 这里 > 已启用）。
 */
export function cangxuanStatus(config: unknown): PluginStatus {
  const bag = (config ?? {}) as Record<string, unknown>;
  const gallery = typeof bag.gallery === 'string' ? bag.gallery : 'chat';
  const manual = Array.isArray(bag.manual_meta) ? bag.manual_meta : [];

  if (gallery === 'manual' && !manual.length) {
    return { label: '还没传图', kind: 'warn' };
  }
  return { label: '已启用', kind: 'ok' };
}