/**
 * 生图插件的**声明式设置**（阶段 4 · P4-3 试点）。
 *
 * 这一份就是旧 `PluginDetail.vue:56-343` 那一整页手写表单的**逐行等价转写**：
 * 界面从「宿主手写 HTML」改成「插件声明字段、宿主渲染」，加字段只改本文件。
 * 对照表见 `reports/阶段4-声明式设置-等价基线.md`（Lead 在改写前从旧代码逐行抄下来的），
 * 下面每个字段的注释都标了它对应的旧行号。
 *
 * ## 归属与依赖
 * - 契约：`core/ports.ts` 的 SettingsField / SettingsGroup / SettingsSchema（阶段 4 冻结，本文件只读）
 * - 选项表：**复用同目录 `options.ts`**（NAI_MODELS / NAI_SAMPLERS / NAI_SCHEDULES / NAI_SIZES /
 *   NAI_UC_PRESETS），不复制第二份 —— 那正是「两份表早晚对不上」的老坑。
 *
 * ## 两处「按字段名特判」的硬编码在这里消失（等价基线 §4）
 * 1. 旧 `PluginDetail.vue:478` 的 `if (key !== 'guidance' && key !== 'guidance_rescale') Math.round(value)`
 *    → 现在由 `step` 决定：0.5 / 0.02 都 < 1，宿主 `clampNumber` 据此不取整，**与 key 叫什么无关**。
 * 2. 旧 `PluginDetail.vue:467` 的 `if (key === 'straight_alpha' && !straightAlphaOk) return`
 *    → 现在由 `visibleIf` 让控件**根本不出现**（比「点了没反应」更好），也没有名字判断。
 *
 * ## 两处既有不一致：**原样保留，不顺手修**（等价基线 §5）
 * 1. `straight_alpha` 以**代码**为准（`options.ts` 的 `supportsStraightAlpha` 只在 v5 返回 true），
 *    界面文案也写「只有 v5 认」—— 那句「v4.5 / v5」的旧注释是错的，但改注释不改行为。
 * 2. `guidance_rescale` 的可见性**不跟版本挂钩**：它的小字写着「v4 起才认」，可旧界面在 v3 下
 *    照样显示（没有 v-if）。等价改写 = **不给它加 visibleIf**，加了就是行为变更。
 */
import type { SettingsField, SettingsGroup, SettingsSchema, SettingsValues } from '../../../core/ports.ts';
import { IMAGE_SOURCE_LABELS } from '../../../core/types.ts';
import {
  NAI_MODELS,
  NAI_SAMPLERS,
  NAI_SCHEDULES,
  NAI_SIZES,
  NAI_UC_PRESETS,
  naiVersion,
  parseSize,
  qualityWordsFor,
  sizePresetOf,
  supportsStraightAlpha,
} from './options.ts';

/* ============================ 小工具 ============================ */

/**
 * 把 `options.ts` 的选项转成声明式选项。
 *
 * 旧界面每个下拉自己拼 `{{ item.label }}{{ item.note ? '（' + item.note + '）' : '' }}`
 * （旧 114-116 / 203-205 / 212-214 行）；宿主 `SettingsForm` 只画 `label`，
 * 所以**后缀在这里拼好**，界面上的字与旧版一字不差。
 */
function withNote(items: ReadonlyArray<{ value: string; label: string; note?: string }>): SettingsFieldOptionLite[] {
  return items.map(item => ({
    value: item.value,
    label: item.note ? item.label + '（' + item.note + '）' : item.label,
  }));
}

/** 只用到 value / label / patch 三项；单独命名免得跟契约里的 SettingsFieldOption 绕 */
interface SettingsFieldOptionLite {
  value: string;
  label: string;
  patch?: SettingsValues;
}

/** 固定提示词那三段的字数（等价基线 §2 的「N 字」角标，旧 `fixedChars`，511 行） */
function fixedChars(values: SettingsValues): number {
  const len = (key: string): number => (typeof values[key] === 'string' ? (values[key] as string).length : 0);
  return len('prompt') + len('prompt_end') + len('negative');
}

/** 当前模型版本标签：认识的给 'v4.5'，不认识的给「不认识的模型名」（旧 `versionLabel`，505 行） */
function versionLabel(values: SettingsValues): string {
  return naiVersion(String(values.model ?? '')) || '不认识的模型名';
}

/** 当前是不是 v3（旧 `isV3`，507 行）——v3 才有 SMEA / SMEA DYN / 减少伪影 三个开关 */
function isV3(values: SettingsValues): boolean {
  return naiVersion(String(values.model ?? '')) === 'v3';
}

/* ============================ 5 个块（等价基线 §2） ============================ */

/**
 * 5 个块。顺序 = 界面上的先后顺序（宿主按 `groups` 的顺序出块，见 `settings_form.ts` 的 `groupFields`）。
 *
 * ## 块头右侧那三处文案
 * 「固定提示词」的 **`badgeOf`**（活字数角标）与另外两处静态 `hint` 都写在各自的块上。
 * 等价基线 §3 要求「动态文案不许降级成静态字」—— 本文件里活的那处是 `badgeOf`（值一变就重算）。
 *
 * ## 「高级」块底部那句 v3 说明：为什么是**字段**而不是块的属性
 * 旧界面（311-314 行）那句 `<p v-if="!isV3">`「SMEA / SMEA DYN / 减少伪影 是 v3 的字段…」
 * 是**块内部底部的一段话**，而块**本身照常在**（`v-if` 只作用在那一个 `<p>` 上）。
 * 所以它在语义上**不是「整块隐藏」**，而是「块内的一段条件文案」，位置、条件都得跟旧版一致 ——
 * 位置是观感的一部分，把一句话从块尾挪到块头并不叫「文字还在」。
 *
 * 于是本文件用**一个 `label: ''` 的 `note` 字段**（`advanced_v3_note`）表达它：
 *   - `note` = 只读一行，不是控件；`label` 为空时宿主只画正文、不画空标签 = 块尾一段话；
 *   - 字段级 `visibleIf: v => !isV3(v)` 复刻旧版的 `v-if="!isV3"`，且每次值变都重算。
 * 而块自己的 `hint` 保持旧 268 行那句静态字「先都按默认，画歪了再来动」（v3 / 非 v3 都在块头）。
 *
 * ## 契约里**故意没有**的两个属性（别去找、也别加）
 * 1. **没有组级 `visibleIf`（整块隐藏）**：本页一个真实用例都没有 —— 旧界面那句 v3 说明
 *    条件只作用在**块内一个 `<p>`** 上，块从未整块消失。契约不留「没有使用者」的可选属性。
 * 2. **没有块级 `hintOf` 的使用者**：块头右侧是右对齐小字（`.cx-n`），一长段话塞那儿会把标题
 *    挤扁折行；块尾的话就该用上面那种 `note` 字段说。
 * 两条理由的权威表述写在 `core/ports.ts` 的 `SettingsGroup` 上（契约是唯一真相源）。
 */
export const GROUPS: SettingsGroup[] = [
  {
    id: 'iface',
    title: '接口',
    // 旧 62 行：块头右侧静态小字
    hint: '连哪家 · 用哪个 Key',
  },
  {
    id: 'fixed',
    title: '固定提示词',
    // 旧 129 行：动态角标「N 字」
    badgeOf: values => fixedChars(values) + ' 字',
    // 旧 131 行：块头右侧静态小字
    hint: '每张图都带上',
  },
  {
    id: 'params',
    title: '生成参数',
    // 旧 197 行
    hint: '模型给的 prompt 之外，画成什么样由这些定',
  },
  {
    id: 'advanced',
    title: '高级',
    // 旧 268 行：块头右侧静态小字（v3 / 非 v3 都在）
    hint: '先都按默认，画歪了再来动',
  },
  {
    id: 'output',
    title: '出图',
    // 旧 322 行
    hint: '成本上限',
  },
];

/* ============================ 24 个字段（等价基线 §1） ============================ */

/** 模型 / 采样器 / 噪点表这类下拉：把 note 拼进 label，界面与旧版一致 */
const MODEL_OPTIONS = withNote(NAI_MODELS);
const SAMPLER_OPTIONS = withNote(NAI_SAMPLERS);
const SCHEDULE_OPTIONS = withNote(NAI_SCHEDULES);

/**
 * 「尺寸」那个复合控件（等价基线 §1 的 14/15 行来源）。
 *
 * 旧界面是**一个 select 读两个键、又写两个键**：`get` 从 width+height 反推预设名，
 * `set` 解析出宽高一起写。声明式里它必须**独立成一个字段**（不是 width/height 的附属）：
 * - `options[].patch` = 一个控件写多个键（NAI_SIZES 各项 → `{width, height}`）；
 * - `valueFrom`     = 当前值从 width + height 两个键反推（`sizePresetOf`，对不上就是 'custom'）。
 *
 * 丢掉它 = 用户失去「选预设尺寸」这条路，是本阶段最容易丢的东西。
 * `size` 是**界面伪键**，不落盘（宿主命中带 patch 的项时只写 patch 里的键）。
 */
const SIZE_OPTIONS: SettingsFieldOptionLite[] = [
  ...NAI_SIZES.map(item => {
    const size = parseSize(item.value);
    return {
      value: item.value,
      label: item.note ? item.label + '（' + item.note + '）' : item.label,
      patch: size ? { width: size.width, height: size.height } : undefined,
    };
  }),
  // 旧 442 行：'自定义（下面填宽高）'；这一项没有 patch → 写字段自己的 key 'size'（伪键，无害）
  { value: 'custom', label: '自定义（下面填宽高）' },
];

/** 宽高对不上任何预设时才露出两个数字框（等价基线 §1「visibleIf: 对不上预设才显示」） */
function sizeIsCustom(values: SettingsValues): boolean {
  const width = Number(values.width);
  const height = Number(values.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true;
  return sizePresetOf(width, height) === '';
}

export const FIELDS: SettingsField[] = [
  /* ---------------- 接口 ---------------- */
  {
    // 1: 只读标签（旧 66-70 行 `sourceLabel`），没有控件 → type:'note'
    key: 'source',
    label: '来源',
    type: 'note',
    group: 'iface',
    // note 的值走 hintOf 通道（宿主 noteValue() 就取它）；这里同时带上旧 69 行那句说明。
    hintOf: values => (IMAGE_SOURCE_LABELS[values.source as keyof typeof IMAGE_SOURCE_LABELS] ?? String(values.source ?? '')) + '　' + '先只做这一家；OpenAI 兼容 / SD WebUI 之类以后加在这',
  },
  {
    // 2: input password⇄text（旧 76-89 行，showKey 切换）
    key: 'api_key',
    label: 'API Key',
    type: 'password',
    group: 'iface',
    placeholder: 'pst-…',
    default: '',
    hint:
      'NovelAI 官网「Account → Persistent Token」拿，pst- 开头那条。' +
      '它跟其它数据一起存在脚本变量里，导出会带上 —— 别把带 Key 的文件发给别人。',
  },
  {
    // 3: SegBar 药丸（旧 94 行 `variant="mode"`）→ select + variant:'mode'（块内内联二选一）
    key: 'site',
    label: '站点',
    type: 'select',
    group: 'iface',
    variant: 'mode',
    default: 'official',
    options: [
      { value: 'official', label: '官网直连' },
      { value: 'proxy', label: '反代 / 中转' },
    ],
    hint:
      '酒馆页面在浏览器里直连 NovelAI 官网大概率被 CORS 挡（跟网页打开别家站点一个道理）。' +
      '被挡就选「反代」填自己的地址；协议 + 主机 + 端口即可，不必带路径。',
  },
  {
    // 4: input text，只在 site==='proxy' 时出现（旧 95-104 行）
    key: 'site_url',
    label: '反代 / 中转地址',
    type: 'text',
    group: 'iface',
    placeholder: 'http://192.168.1.10:6969',
    default: '',
    visibleIf: values => values.site === 'proxy',
  },
  {
    // 5: select，label 后拼 note（旧 113-117 行）
    key: 'model',
    label: '模型',
    type: 'select',
    group: 'iface',
    default: 'nai-diffusion-4-5-full',
    options: MODEL_OPTIONS,
    // 动态小字（旧 118-121 行的 versionLabel）
    hintOf: values =>
      '现在选的是 ' + versionLabel(values) + '。' +
      '有些字段只有新模型认（界面上标了版本），老模型收到会忽略或报错。',
  },

  /* ---------------- 固定提示词 ---------------- */
  {
    // 6: textarea rows=3（旧 136-144 行）
    key: 'prompt',
    label: '固定正面（拼在最前）',
    type: 'textarea',
    group: 'fixed',
    placeholder: '例如：masterpiece, 1girl, cinematic lighting',
    default: '',
  },
  {
    // 7: textarea rows=2（旧 149-157 行）
    key: 'prompt_end',
    label: '后置固定正面（拼在最后）',
    type: 'textarea',
    group: 'fixed',
    placeholder: '例如：depth of field, film grain（画风 / 镜头这类）',
    default: '',
  },
  {
    // 8: textarea rows=3（旧 162-170 行）
    key: 'negative',
    label: '固定负面（拼在下面那份负面预设后面）',
    type: 'textarea',
    group: 'fixed',
    placeholder: '例如：extra fingers, watermark',
    default: '',
  },
  {
    // 9: Sw 布尔（旧 176 行）+ 动态质量词小字（旧 178-180 行）
    key: 'quality',
    label: '追加官方质量词',
    type: 'boolean',
    group: 'fixed',
    default: true,
    hintOf: values => '开着会自动加上（各模型不一样）：' + qualityWordsFor(String(values.model ?? '')),
  },
  {
    // 10: select（旧 185-187 行，只显示 label）
    key: 'uc_preset',
    label: '负面质量预设',
    type: 'select',
    group: 'fixed',
    default: 'heavy',
    options: NAI_UC_PRESETS.map(item => ({ value: item.value, label: item.label })),
    hint: '官方的内置负面词表，跟上面的「固定负面」是叠加的。',
  },

  /* ---------------- 生成参数 ---------------- */
  {
    // 11: select（旧 202-206 行）
    key: 'sampler',
    label: '采样方法',
    type: 'select',
    group: 'params',
    default: 'k_euler_ancestral',
    options: SAMPLER_OPTIONS,
  },
  {
    // 12: select（旧 211-215 行）
    key: 'schedule',
    label: '噪点表',
    type: 'select',
    group: 'params',
    default: 'karras',
    options: SCHEDULE_OPTIONS,
  },
  {
    // 13: number min=1 max=50 step=1（旧 220 行）
    key: 'steps',
    label: '生成步数',
    type: 'number',
    group: 'params',
    min: 1,
    max: 50,
    step: 1,
    default: 28,
    hint: '1–50；28 左右够用，越高越慢越贵。',
  },
  {
    // 14+15: 尺寸预设那个复合控件（旧 226-228 行 select + 440-443 行 SIZE_ITEMS）
    key: 'size',
    label: '尺寸',
    type: 'select',
    group: 'params',
    options: SIZE_OPTIONS,
    valueFrom: values => {
      const width = Number(values.width);
      const height = Number(values.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return 'custom';
      return sizePresetOf(width, height) || 'custom';
    },
  },
  {
    // 14: width number min=64 max=2048 step=64（旧 230 行），对不上预设才显示
    key: 'width',
    label: '宽',
    type: 'number',
    group: 'params',
    min: 64,
    max: 2048,
    step: 64,
    default: 832,
    visibleIf: sizeIsCustom,
  },
  {
    // 15: height number min=64 max=2048 step=64（旧 232 行），对不上预设才显示
    key: 'height',
    label: '高',
    type: 'number',
    group: 'params',
    min: 64,
    max: 2048,
    step: 64,
    default: 1216,
    visibleIf: sizeIsCustom,
  },
  {
    // 16: number min=0 step=1，旧 clamp 上界 4294967295（旧 239 行 + 429 行 NUM_RANGES）
    key: 'seed',
    label: '种子',
    type: 'number',
    group: 'params',
    min: 0,
    max: 4294967295,
    step: 1,
    default: 0,
    hint: '0 = 每次随机；定住一个数就能复现同一张（prompt 也一样的前提下）。',
  },
  {
    // 17: number min=0 max=20 step=0.5 —— step<1 → 宿主不取整（旧 245 行；硬编码在此消失）
    key: 'guidance',
    label: 'Prompt Guidance',
    type: 'number',
    group: 'params',
    min: 0,
    max: 20,
    step: 0.5,
    default: 5,
    hint: '越大越贴提示词，太大会发硬。v3 默认 11，v4 起常用 5。',
  },
  {
    // 18: number min=0 max=1 step=0.02 —— 同上；**故意不给 visibleIf**（等价基线 §5.2）
    key: 'guidance_rescale',
    label: 'Guidance Rescale',
    type: 'number',
    group: 'params',
    min: 0,
    max: 1,
    step: 0.02,
    default: 0,
    hint: '0–1，v4 起才认；压一下高 Guidance 的过曝，一般 0。',
  },

  /* ---------------- 高级 ---------------- */
  {
    // 19: Sw，v-if="isV3"（旧 271-277 行）
    key: 'smea',
    label: 'SMEA',
    type: 'boolean',
    group: 'advanced',
    default: false,
    visibleIf: isV3,
  },
  {
    // 20: Sw，同上条件（旧 279-285 行）
    key: 'smea_dyn',
    label: 'SMEA DYN',
    type: 'boolean',
    group: 'advanced',
    default: false,
    visibleIf: isV3,
    hint: '这两个是官方推荐的动态阈值组合，能少一堆畸形；SMEA DYN 要 SMEA 一起开。',
  },
  {
    // 21: Sw，同上条件（旧 287-292 行）
    key: 'decrisp',
    label: '减少伪影（Decrisp）',
    type: 'boolean',
    group: 'advanced',
    default: false,
    visibleIf: isV3,
  },
  {
    // 22: Sw，无条件（旧 295-301 行）
    key: 'variety',
    label: '多样性（Variety+）',
    type: 'boolean',
    group: 'advanced',
    default: true,
    hint: '开着会按尺寸算一个「放开高引导」的阈值（越大越松），少一点糊成一团。',
  },
  {
    // 23: Sw，v-if="straightAlphaOk" = supportsStraightAlpha(naiVersion)（旧 303-309 行）
    key: 'straight_alpha',
    label: '透明背景',
    type: 'boolean',
    group: 'advanced',
    default: false,
    visibleIf: values => supportsStraightAlpha(naiVersion(String(values.model ?? ''))),
    hint: '出 PNG 透明底，抠图省一步（只有 v5 的接口认这个字段）。',
  },
  {
    /**
     * 高级块**底部**那句话（旧 311-314 行 `<p v-if="!isV3">`）。
     *
     * 为什么是一个 note 字段而不是 `SettingsGroup.hintOf`：`hintOf` 画在**块头右侧**
     * （`.cx-n` 右对齐小字），这一长段话塞在那儿会把标题挤扁、折成两三行；
     * 而旧界面里它本来就在块**内部底部**。位置是观感的一部分。
     *
     * `label` 故意为空 —— 宿主对空 label 的 note 只画正文、不画空标签（就是「块尾一段话」）。
     * `key` 是**界面伪键**，永不落盘（note 没有值、不参与 patch）。
     */
    key: 'advanced_v3_note',
    label: '',
    type: 'note',
    group: 'advanced',
    // 旧 311 行的条件就是 v-if="!isV3"：只有当前模型不是 v3 时才说这句话
    visibleIf: values => !isV3(values),
    hint:
      'SMEA / SMEA DYN / 减少伪影 是 v3 的字段：v4 起的请求官方不带它们（换成 autoSmea），' +
      '所以当前模型下不摆这几个开关 —— 想调就先把上面模型切回 v3。',
  },

  /* ---------------- 出图 ---------------- */
  {
    // 24: number min=1 max=4 step=1（旧 326-333 行）
    key: 'max_count',
    label: '一次最多几张',
    type: 'number',
    group: 'output',
    min: 1,
    max: 4,
    step: 1,
    default: 1,
    hint: '模型一次调用最多能出几张（1–4）。生图按张收费，这是钱的上限。',
  },
];

/**
 * 整份声明（manifest 的 `contributes.settings` 直接给这个对象）。
 *
 * `resetConfirm`：这一页里有 **API Key**，恢复默认会把它一起清掉而且找不回来 ——
 * 所以点「恢复默认」必须拦一道。文案照抄旧 `PluginDetail.vue:485` 那一句，不自创。
 * （footer 下那句通用说明「恢复默认会把这一页的设置全部清回内置默认值。」由宿主统一画。）
 */
export const IMAGE_SETTINGS: SettingsSchema = {
  fields: FIELDS,
  groups: GROUPS,
  resetConfirm: '把「生图」的设置全部恢复成内置默认？（含 API Key）',
};

/**
 * 兼容别名：P4-1 契约冻结前后的两个名字。
 * 题面里写的是 `IMAGE_SETTINGS_FIELDS` / `IMAGE_SETTINGS_GROUPS`，契约闸读的是 `FIELDS` / `GROUPS`；
 * 两个都给，免得下游按哪个名字 import 都能用。
 */
export const IMAGE_SETTINGS_FIELDS: SettingsField[] = FIELDS;
export const IMAGE_SETTINGS_GROUPS: SettingsGroup[] = GROUPS;