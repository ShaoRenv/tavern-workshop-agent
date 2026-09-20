import {
  JsonTemplateSchema,
  LlmPresetSchema,
  MetaExtractRuleSchema,
  WorldbookPresetSchema,
  type JsonTemplateData,
  type LlmPresetData,
  type MetaExtractRuleData,
  type WorldbookPresetData,
} from './schema.ts';
import { createDefaultExtractRule } from '../core/extractor.ts';

/**
 * 内置内容：JSON 模板、元数据提取规则、LLM 预设、世界书预设。
 *
 * 这些只是**可编辑的起点**，用户可在界面上复制、修改或新建。
 * 模板字段结构取自两个绘图插件真实导出文件的实测结构。
 */

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const ZHI_SKELETON = pretty({
  characters: {
    '[苍玄界]<中文名>': {
      nameCN: '<中文名>',
      nameEN: '<全小写拼音，空格分隔>',
      characterTraits: '<2-5 个英文标签>',
      facialFeatures: '<面部与发型>',
      facialFeaturesBack: '<背面发型>',
      upperBodySFW: '<上身>',
      upperBodySFWBack: '<背面>',
      fullBodySFW: '<下身>',
      fullBodySFWBack: '<背面>',
      upperBodyNSFW: '',
      upperBodyNSFWBack: '',
      fullBodyNSFW: '',
      fullBodyNSFWBack: '',
      outfits: ['[苍玄界]<服装名>'],
      negative: '<角色负向词>',
      generationContext: '',
      generationVariables: {},
      generationWorldBook: '',
      mediaSchemaVersion: 2,
    },
  },
  outfits: {
    '[苍玄界]<服装名>': {
      nameCN: '<服装名>',
      nameEN: '<服装英文>',
      owner: '<该角色的 nameEN>',
      upperBody: '',
      upperBodyBack: '',
      fullBody: '',
      fullBodyBack: '',
    },
  },
});

const XIAOBAIX_SKELETON = pretty({
  type: 'novel-draw-characters',
  version: 3,
  characters: [
    {
      id: '',
      name: '<中文名>',
      aliases: [],
      type: '<girl / mature woman / 1boy …>',
      appearance: '<全部外观，保留权重语法，末尾以逗号结尾>',
      negativeTags: '<角色相关负向词>',
      danbooruTag: '',
      outfits: [{ name: '<服装名>', tags: '<服装标签>' }],
    },
  ],
});
const ZHI_NOTE = [
  '角色按身体部位拆成六个字段：facialFeatures / facialFeaturesBack / upperBodySFW / upperBodySFWBack / fullBodySFW / fullBodySFWBack。',
  '背面字段若无法从正面立绘得知，可依据已有特征合理推断，不要留空。',
  'nameEN 必须是小写、以单个空格分隔的拼音；它同时是 outfits 中 owner 的取值。',
  'outfits 数组填服装键名，键名必须是 [苍玄界]<中文服装名>；服装条目另起一张表。',
  '保留原始 NovelAI 权重语法（如 1.6::xxx::），不要转换成其他语法。',
  '无法从 SFW 立绘推断的 NSFW 字段留空字符串，禁止编造。',
].join('\n');

const XIAOBAIX_NOTE = [
  '外观全部合并进单个 appearance 字段，不要按身体部位拆分。',
  'appearance 保留 NovelAI 权重语法，并保留末尾的逗号（与原格式一致）。',
  'type 只放一个核心身份标签，如 girl / mature woman / 1boy。',
  'id 一律输出空字符串，由脚本生成 char-<时间戳>-<随机串>。',
  'outfits 是内联数组，每项含 name 与 tags。',
  'danbooruTag 没有把握就留空字符串。',
].join('\n');

const ZHI_INSTRUCTION = [
  '你要把一张立绘的元数据转换成「智绘姬」角色预设。',
  '',
  '输入中的「角色DNA（char_caption）」是该角色最可靠的外观描述，请以它为准。',
  '输入中的「完整提示词（prompt）」包含大量场景、构图、光影与画风词，',
  '这些**不属于角色本身**，不要写进任何角色字段。',
  '',
  '请逐个角色转换，严格遵守 JSON 模板的字段名与层级。',
  '只输出 JSON，不要输出任何解释性文字。',
].join('\n');

const XIAOBAIX_INSTRUCTION = [
  '你要把一张立绘的元数据转换成「小白x」创意工坊角色提示词。',
  '',
  '输入中的「角色DNA（char_caption）」是该角色最可靠的外观描述，请以它为准。',
  '输入中的「完整提示词（prompt）」包含场景、构图、光影与画风词，不属于角色本身。',
  '',
  '请逐个角色转换，严格遵守 JSON 模板的字段名与层级。',
  '只输出 JSON，不要输出任何解释性文字。',
].join('\n');
const WORLD_BOOK_FIELD_SPEC = [
  '每个角色输出一行，格式为：',
  '**名字**｜身份一句话。性别，年龄（修为），境界，势力。性格与行为模式 2-4 句。',
  '',
  '示例：',
  '**今长乐**｜天剑宗护宗祥瑞仙兽兼风雪堂采药童子。女，24岁（外表十六出头），筑基五层，天剑宗/风雪堂。慵懒随性、务实理性，极度眷恋烟火气。',
  '**蛸**｜浅海珊瑚礁散居八爪海妖。女，327岁（外貌18），筑基二层，无宗门。怯懦胆小、温柔善良、好奇敏感。',
  '',
  '要求：',
  '- 每行用 ** 包裹名字，紧跟一个全角竖线 ｜。',
  '- 身份一句话不超过 30 字。',
  '- 性格部分 2-4 句，只保留最能区分该角色的特征。',
  '- 不要输出标题、序号、列表符号或任何额外说明。',
].join('\n');

const WORLD_BOOK_TOLERANCE = [
  '【容错规则】',
  '1. 若某角色在世界书中查不到完整设定，只写已知信息，不要编造。',
  '2. 若同一角色出现多种写法（如 朝听澜/潮听澜），以世界书条目名为准，只输出一个。',
  '3. 若某势力下的人物在角色条目中缺失，跳过该角色，不要输出占位内容。',
  '4. 若输入为空或无法解析，输出一个含 error 字段的 JSON 对象，不要输出空内容。',
  '5. 境界、年龄等不确定的字段留空，不要臆测。',
].join('\n');

const WORLD_BOOK_INSTRUCTION = [
  '你要把世界书中的角色设定压缩成一份「全角色蓝灯精简」清单。',
  '',
  '输入会给出若干角色的完整设定。请为每个角色浓缩出一行，',
  '保留：身份、性别、年龄与修为境界、所属势力，以及最能区分该角色的性格与行为特征。',
  '丢弃：关系细节、具体台词、剧情经历、外貌细节。',
  '',
  '严格遵守行格式规范。',
].join('\n');

const WORLD_BOOK_SYSTEM =
  '你是一个严谨的世界书整理助手，擅长把冗长的角色设定压缩为信息密度高、风格统一的精简条目。';

/** 内置 JSON 模板：两个绘图插件的既有格式 */
export function createBuiltinTemplates(): JsonTemplateData[] {
  return [
    JsonTemplateSchema.parse({
      id: 'tpl-zhihatsuki',
      name: '智绘姬 · 角色预设 (st-chatu8)',
      builtin: true,
      target: 'zhihatsuki',
      merge_mode: 'object_map',
      key_prefix: '[苍玄界]',
      skeleton: ZHI_SKELETON,
      schema_note: ZHI_NOTE,
    }),
    JsonTemplateSchema.parse({
      id: 'tpl-xiaobaix',
      name: '小白x · 创意工坊角色提示词',
      builtin: true,
      target: 'xiaobaix',
      merge_mode: 'array_push',
      skeleton: XIAOBAIX_SKELETON,
      schema_note: XIAOBAIX_NOTE,
    }),
  ];
}

/** 内置元数据提取规则：默认 char_caption + prompt */
export function createBuiltinMetaExtractRules(): MetaExtractRuleData[] {
  return [MetaExtractRuleSchema.parse(createDefaultExtractRule())];
}

/** 内置 LLM 预设：两个绘图插件各一套 */
export function createBuiltinLlmPresets(): LlmPresetData[] {
  return [
    LlmPresetSchema.parse({
      id: 'preset-zhihatsuki',
      name: '智绘姬 · 立绘转角色预设',
      builtin: true,
      target: 'zhihatsuki',
      system_prompt: '你是一个精确的立绘元数据转换器，只输出严格合法的 JSON。',
      instruction: ZHI_INSTRUCTION,
      template_mode: 'reference',
      template_id: 'tpl-zhihatsuki',
      meta_extract_rule_id: 'builtin-default',
      batch_size: 4,
      temperature: 0.3,
      conflict: 'overwrite',
    }),
    LlmPresetSchema.parse({
      id: 'preset-xiaobaix',
      name: '小白x · 立绘转角色提示词',
      builtin: true,
      target: 'xiaobaix',
      system_prompt: '你是一个精确的立绘元数据转换器，只输出严格合法的 JSON。',
      instruction: XIAOBAIX_INSTRUCTION,
      template_mode: 'reference',
      template_id: 'tpl-xiaobaix',
      meta_extract_rule_id: 'builtin-default',
      batch_size: 6,
      temperature: 0.3,
      conflict: 'overwrite',
    }),
  ];
}

/** 内置世界书预设：全角色蓝灯精简 */
export function createBuiltinWorldbookPresets(): WorldbookPresetData[] {
  return [
    WorldbookPresetSchema.parse({
      id: 'wbpreset-lite-constant',
      name: '全角色蓝灯精简',
      builtin: true,
      worldbook_name_template: '{源名} · 全角色蓝灯精简',
      entry_mode: 'single',
      entry_name_template: '全角色蓝灯精简',
      system_prompt: WORLD_BOOK_SYSTEM,
      instruction: WORLD_BOOK_INSTRUCTION,
      field_spec: WORLD_BOOK_FIELD_SPEC,
      tolerance_note: WORLD_BOOK_TOLERANCE,
      temperature: 0.4,
      batch_size: 6,
    }),
  ];
}
