/**
 * 苍玄助手插件的设置与状态。
 *
 * ⚠️ 设置字段的**真 schema 在 core/types.ts 的 CangxuanConfigSchema**（存在 plugins.cangxuan），
 * 这里只是把同一份契约用「声明式字段」描述一遍 —— 阶段 4 起 SettingsForm.vue 按这些字段自动画界面，
 * 外部插件将来也走这条路（它们没有自己画界面的机会）。
 *
 * `manual_meta` 是阶段 3 顺带修的老坑：以前手动传的立绘元数据只存在内存里，刷新就没了。
 */
import type { PluginSettingField, PluginStatus } from '../../types.ts';

/** 设置字段声明（阶段 4 的声明式表单用；界面也能先按这个画） */
export const CANGXUAN_SETTINGS_FIELDS: PluginSettingField[] = [
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
  {
    key: 'manual_meta',
    label: '手动传的元数据',
    type: 'textarea',
    hint: '上传立绘后解析出来的提示词（只存 URL / 文本，不存图片本身）。',
    default: [],
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