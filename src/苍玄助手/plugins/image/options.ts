/**
 * 生图插件 · NovelAI 的选项表与版本规则（纯数据 + 纯函数，界面和请求组装共用一份）。
 *
 * 为什么要单独一个文件：界面里那些下拉框的取值、以及 nai.ts 组装请求时要按模型版本
 * 决定发哪些字段，都必须**看同一份表**；散在两个地方早晚对不上。
 * 参考：st-chatu8 的 NovelAI 设置页（D:\dsh\deliver\st-chatu8-perf\html\settings\novelai.html）。
 */

/** NovelAI 的模型 → 大版本。请求字段按版本分叉，界面也用它在字段旁边标「v4 起」 */
export type NaiVersion = 'v3' | 'v4' | 'v4.5' | 'v5' | '';

export interface NaiOption {
  value: string;
  label: string;
  /** 界面上跟在标签后面的一句备注（可空） */
  note?: string;
}

/** 模型：v3 是老的；v4 起才有角色/氛围参考；v4.5 起才有透明背景 */
export const NAI_MODELS: NaiOption[] = [
  { value: 'nai-diffusion-3', label: 'NAI Diffusion 3', note: 'v3' },
  { value: 'nai-diffusion-4-full', label: 'NAI Diffusion 4 Full', note: 'v4' },
  { value: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion 4 Curated', note: 'v4' },
  { value: 'nai-diffusion-4-5-full', label: 'NAI Diffusion 4.5 Full', note: 'v4.5' },
  { value: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion 4.5 Curated', note: 'v4.5' },
  { value: 'nai-diffusion-5-full', label: 'NAI Diffusion 5 Full', note: 'v5' },
  { value: 'nai-diffusion-5-curated', label: 'NAI Diffusion 5 Curated', note: 'v5' },
];

/** 采样方法 */
export const NAI_SAMPLERS: NaiOption[] = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral', note: '默认，画面更活' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M', note: '稳' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM' },
];

/** 噪点表（v3 的 native 只有老模型认，v4 起用 karras 之类） */
export const NAI_SCHEDULES: NaiOption[] = [
  { value: 'karras', label: 'Karras', note: '默认' },
  { value: 'native', label: 'Native', note: 'v3' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 尺寸预设（value = '宽x高'；对齐 st-chatu8 那份列表） */
export const NAI_SIZES: NaiOption[] = [
  { value: '832x1216', label: '832x1216 · 竖 13:19', note: '默认' },
  { value: '1216x832', label: '1216x832 · 横 19:13' },
  { value: '1024x1024', label: '1024x1024 · 方 1:1' },
  { value: '512x768', label: '512x768 · 竖 2:3' },
  { value: '768x512', label: '768x512 · 横 3:2' },
  { value: '640x640', label: '640x640 · 方' },
  { value: '512x512', label: '512x512 · 方' },
];

/** 负面质量预设 → NovelAI 请求里的 ucPreset 数字 */
export const NAI_UC_PRESETS: (NaiOption & { uc: number })[] = [
  { value: 'heavy', label: '重（官方默认）', uc: 0 },
  { value: 'light', label: '轻', uc: 1 },
  { value: 'human', label: '人像向', uc: 2 },
  { value: 'none', label: '不用', uc: 3 },
];

/**
 * qualityToggle 追加的质量词：**各版本不一样**（照 st-chatu8 的 AQT 映射）。
 * 老版本那串 `best quality, amazing quality...` 拿到 v4 起反而容易出"过锐"的味道。
 */
export const NAI_QUALITY_BY_MODEL: Record<string, string> = {
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-5-full': 'very aesthetic, amazing quality, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
};

/** 老版本兜底用的那串 */
export const NAI_QUALITY_WORDS = NAI_QUALITY_BY_MODEL['nai-diffusion-3'];

/** 当前模型会追加的质量词（界面把那串原样显示出来，免得用户猜） */
export function qualityWordsFor(model: string): string {
  return NAI_QUALITY_BY_MODEL[model] ?? NAI_QUALITY_WORDS;
}

/** 'nai-diffusion-4-5-full' → 'v4.5'；不认识的名字返回空串 */
export function naiVersion(model: string): NaiVersion {
  const name = String(model ?? '').toLowerCase();
  if (!name.startsWith('nai-diffusion-')) return '';
  const rest = name.slice('nai-diffusion-'.length);
  const major = rest.split('-')[0];
  if (major === '3') return 'v3';
  if (major === '4') return rest.startsWith('4-5') ? 'v4.5' : 'v4';
  if (major === '5') return 'v5';
  return '';
}

/** v4 起：请求要带 v4_prompt / v4_negative_prompt 那套结构 */
export function isV4Plus(version: NaiVersion): boolean {
  return version === 'v4' || version === 'v4.5' || version === 'v5';
}

/**
 * 透明背景（straight_alpha）只有 v5 的请求会带 —— 参考实现里这三个 v5 字段
 * 就写在 nai-diffusion-5 的分支里（reports/苍玄助手-生图参考-nai.md §2.2）。
 */
export function supportsStraightAlpha(version: NaiVersion): boolean {
  return version === 'v5';
}

/** 把 config 里的宽高跟预设对上：对得上就返回 '832x1216'，对不上返回空串（界面显示「自定义」） */
export function sizePresetOf(width: number, height: number): string {
  const hit = NAI_SIZES.find(item => item.value === width + 'x' + height);
  return hit ? hit.value : '';
}

/** '832x1216' → { width, height }；认不出来返回 null */
export function parseSize(value: string): { width: number; height: number } | null {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}
