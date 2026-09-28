/**
 * 苍玄助手 · 内置预设与内置技能（builtin）
 *
 * 内容：
 *  - 3 个内置预设（v4 起统一是 items 形状，没有 kind；是不是 Agent 由解析后的工具集决定）
 *      1) `世界书 · 势力整理 Agent`（use_global_caps=false 跟随全局能力；items = 系统提示词 + 上下文层 + 产出世界书）
 *      2) `立绘 · 智绘姬角色预设`（use_global_caps=true + tools=[]，解析后 0 工具 = 普通对话，产出 JSON）
 *      3) `世界书 · 蓝灯精简`（同上，普通对话，产出世界书）
 *  - 2 个内置技能：`世界书精修`、`势力关系梳理`
 *
 * id 全部写死（builtin-*），这样刷新、导来导去都不会变成两份；
 * 内置内容只是**可编辑的起点**：用户在界面上改了就用用户的那份。
 *
 * 文本内容来源：设计稿/苍玄助手-设计稿.html（Agent 系统提示词）
 * 与旧工程 src/苍玄界立绘工坊/llm/presets_builtin.ts（智绘姬骨架与字段规范）。
 * 两个旧内置技能（世界书精修 / 势力关系梳理）已按 D7 删除，见 createBuiltinSkills 的注释。
 */
import { PresetSchema, type Preset, type RootData, type Skill } from '../core/types.ts';

/* ============================ 文案常量 ============================ */

/** Agent 的系统提示词（设计稿设置页原文） */
const AGENT_WORLDBOOK_SYSTEM = [
  '你是世界书的整理助手。改之前先读，只改该改的地方。',
  '需要专门手法时看看有哪些技能可用。做完调 submit。',
  '',
  '工作纪律：',
  '- 一切写操作都先进草稿，不要直接改酒馆里的世界书；用户点保存才落盘。',
  '- 改条目用 old_string → new_string 精确替换，不要整条重写。',
  // 工具只实现了「世界书级」范围，没有条目级范围；这里不能写「和条目」，否则是在骗模型
  '- 只动用户圈定范围内的世界书；范围外的先问。',
  '- 生图之后**自己看一眼**再决定收不收：图会回灌给你，对照用户的描述检查主体 / 构图 / 风格有没有跑偏，不对就在上一版 prompt 上改了重画。用户说不行时同理 —— 先看当前的哪里不对，再动手。',
].join('\n');

/**
 * Agent 预设自己勾的内置工具（名字必须与 agent/registry.ts 一致）。
 * 这个预设是 use_global_caps=false（跟随全局），所以这份清单平时不生效，
 * 是「以后关掉全局」时的兜底；内容与 DEFAULT_ON_TOOLS 保持一致。
 */
const AGENT_TOOLS = [
  'wb_list',
  'wb_outline',
  'wb_read',
  'wb_search',
  'wb_write',
  'skill',
  'read_skill_file',
  // gen_image 故意不默认勾选：生图 API 还没接，默认开着只会诱导模型乱调、白烧钱。
  // 工具本身保留（用户以后要接生图，走外部工具形态再打开）。
  'submit',
];

/**
 * Agent 预设默认挂着的技能 id。
 *
 * ⚠️ B15-B19 之后暂时**为空**：D7 定案要删掉「世界书精修」「势力关系梳理」，
 * 而替换它们的 `世界书工程` 要等 skill 系统（B46-B57）落地。
 * 空数组 = 这个预设暂时不挂技能，模型照常能干活（技能是可选的加速器，不是必需品）。
 */
const AGENT_SKILLS: string[] = [];

/* ---------------------------- 立绘 · 智绘姬 ---------------------------- */

const ZHI_SKELETON = JSON.stringify(
  {
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
  },
  null,
  2,
);

const ZHI_RULES = [
  '角色按身体部位拆成六个字段：facialFeatures / facialFeaturesBack / upperBodySFW / upperBodySFWBack / fullBodySFW / fullBodySFWBack。',
  '背面字段若无法从正面立绘得知，可依据已有特征合理推断，不要留空。',
  'nameEN 必须是小写、以单个空格分隔的拼音；它同时是 outfits 中 owner 的取值。',
  'outfits 数组填服装键名，键名必须是 [苍玄界]<中文服装名>；服装条目另起一张表。',
  '保留原始 NovelAI 权重语法（如 1.6::xxx::），不要转换成其他语法。',
  '无法从 SFW 立绘推断的 NSFW 字段留空字符串，禁止编造。',
].join('\n');

const ZHI_SYSTEM = [
  '你要把一张立绘的元数据转换成「智绘姬」角色预设。',
  '',
  '输入里的「角色DNA（char_caption）」是该角色最可靠的外观描述，请以它为准；',
  '「完整提示词（prompt）」里的场景、构图、光影、画风词**不属于角色本身**，不要写进角色字段。',
  '',
  '请逐个角色转换，严格遵守下面的 JSON 结构，只输出 JSON，不要输出任何解释性文字。',
].join('\n');

/* ---------------------------- 世界书 · 蓝灯精简 ---------------------------- */

const WB_SYSTEM = [
  '你是一个严谨的世界书整理助手，擅长把冗长的角色设定压缩为信息密度高、风格统一的精简条目。',
  '',
  '你要把世界书中的角色设定压缩成一份「全角色蓝灯精简」清单：',
  '输入会给出若干角色的完整设定，请为每个角色浓缩出一行，',
  '保留：身份、性别、年龄与修为境界、所属势力，以及最能区分该角色的性格与行为特征。',
  '丢弃：关系细节、具体台词、剧情经历、外貌细节。',
].join('\n');

const WB_FIELD_SPEC = [
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

const WB_TOLERANCE = [
  '【容错规则】',
  '1. 若某角色在世界书中查不到完整设定，只写已知信息，不要编造。',
  '2. 若同一角色出现多种写法（如 朝听澜/潮听澜），以世界书条目名为准，只输出一个。',
  '3. 若某势力下的人物在角色条目中缺失，跳过该角色，不要输出占位内容。',
  '4. 若输入为空或无法解析，直接说明缺什么，不要输出空内容。',
  '5. 境界、年龄等不确定的字段留空，不要臆测。',
].join('\n');

/* ============================ 内置技能 ============================ */

/*
 * ⚠️ 这里原来是两个内置技能（`世界书精修` / `势力关系梳理`），D7 定案**删掉**。
 *
 * 为什么删（用户原话：「内置 skill 没价值」）：它们讲的是**写作风格**——
 * 「压到 150 字以内」「关系只写有依据的」这类，那是用户的活儿，不是底座的活儿。
 * 而且它们用的是旧工具名（`entry_edit` 的 old_string 替换），留着会让模型照着调一个不存在的工具。
 *
 * 替代它们的是 **`世界书工程` skill**（TavernWeave 手册原文适配版，
 * 见 reports/世界书skill-适配稿/），落地在 B46-B57 的 skill 系统里。
 *
 * 在那之前这里**故意返回空数组**：技能是可选的加速器，不是必需品 ——
 * 没有技能模型照常能干活（工具 + 预设提示词已经够了）。
 */
export function createBuiltinSkills(): Skill[] {
  return [];
}

/**
 * **已退役的内置技能 id**：曾经是内置、现在被删掉的。
 *
 * 为什么需要这张表：`applyBuiltins()` 的「强制覆盖」只能删掉**当前内置清单里**的 id ——
 * 而这两个已经不在清单里了，光靠它删不掉，会永远留在用户的存储里（模型还能挑中它们，
 * 而它们教的是旧工具名 `entry_edit`，照着做就是调一个不存在的工具）。
 *
 * 口径：**只删 id 精确匹配的这两个**。用户如果自己建了同名技能，那就是他自己的东西，
 * 不该被我们顺手删掉 —— 所以匹配用 id（`builtin-skill-*`），不是名字。
 */
export const RETIRED_BUILTIN_SKILL_IDS = ['builtin-skill-worldbook-polish', 'builtin-skill-faction-relations'];

/**
 * 内置预设。
 *
 * 立绘预设里的 `{{图片元数据}}` / `{{角色列表}}` / `{{用户需求}}` 由 macros.ts 替换；
 * 世界书预设里的 `{{世界书}}` / `{{已选条目}}` 同理。
 */
export function createBuiltinPresets(): Preset[] {
  return [
    /* ---------- 1) Agent：世界书整理 ---------- */
    PresetSchema.parse({
      id: 'builtin-agent-worldbook',
      name: '世界书 · 势力整理 Agent',
      builtin: true,
      output: 'worldbook',
      // 预设本体 = items 序列；原来的 system 字符串就是第一条第 system 消息
      items: [
        {
          type: 'message',
          id: 'agent-1-system',
          name: '系统提示词',
          role: 'system',
          content: AGENT_WORLDBOOK_SYSTEM,
          enabled: true,
          trigger: 'always',
        },
        {
          // 显式带上「上下文」特殊层：这条历史原来靠 agent 路径隐式补，
          // 现在写出来，语义清楚、行为不变（有它就展开原生历史，不再补第二次）
          type: 'special',
          id: 'agent-2-context',
          name: '上下文',
          kind: 'context',
          enabled: true,
        },
      ],
      // 默认关：跟随「能力」页的全局工具 / 技能（全局默认有工具，所以它仍然跑工具循环）
      use_global_caps: false,
      tools: AGENT_TOOLS,
      skills: AGENT_SKILLS,
      max_rounds: 12,
    }),

    /* ---------- 2) 普通：立绘 · 智绘姬 ---------- */
    PresetSchema.parse({
      id: 'builtin-plain-zhihatsuki',
      name: '立绘 · 智绘姬角色预设',
      builtin: true,
      output: 'json',
      items: [
        {
          type: 'message',
          id: 'zhi-1-system',
          name: '开场白',
          role: 'system',
          content: ZHI_SYSTEM,
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'zhi-2-assistant',
          name: '明白了',
          role: 'assistant',
          content: '明白。把立绘元数据给我，我按智绘姬模板逐角色转换，只输出 JSON。',
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'zhi-3-input',
          name: '角色与元数据',
          role: 'user',
          content: ['要处理的角色：', '{{角色列表}}', '', '立绘图元数据：', '{{图片元数据}}', '', '用户需求：{{用户需求}}'].join('\n'),
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'zhi-4-format',
          name: '按这个格式输出 JSON',
          role: 'user',
          content: ['按下面这个结构输出 JSON（键名、层级一个都不能改）：', '', ZHI_SKELETON, '', '要求：', ZHI_RULES].join('\n'),
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'zhi-5-repair',
          name: '缺字段时补问',
          role: 'user',
          content: '有字段实在写不出来就留空字符串，不要编造；写完自查一遍每个键都在。',
          enabled: true,
          trigger: 'not_first_round',
        },
      ],
      // 普通预设：不跟随全局，自己一条工具都不勾 —— 解析后 0 工具 = 只发消息，不跑工具循环
      use_global_caps: true,
      tools: [],
    }),

    /* ---------- 3) 普通：世界书 · 蓝灯精简 ---------- */
    PresetSchema.parse({
      id: 'builtin-plain-worldbook-lantern',
      name: '世界书 · 蓝灯精简',
      builtin: true,
      output: 'worldbook',
      items: [
        {
          type: 'message',
          id: 'wb-1-system',
          name: '开场白',
          role: 'system',
          content: WB_SYSTEM,
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'wb-2-assistant',
          name: '明白了',
          role: 'assistant',
          content: '明白。把要精简的角色设定给我，我按「一行一角色」的格式输出，成品用于新建世界书。',
          enabled: true,
          trigger: 'always',
        },
        {
          type: 'message',
          id: 'wb-3-input',
          name: '世界书与条目',
          role: 'user',
          content: ['世界书：{{世界书}}', '', '已选条目：', '{{已选条目}}', '', '用户需求：{{用户需求}}'].join('\n'),
          enabled: true,
          trigger: 'has_worldbook',
        },
        {
          type: 'message',
          id: 'wb-4-role-list',
          name: '角色列表',
          role: 'user',
          content: '需要覆盖的角色：\n{{角色列表}}',
          enabled: true,
          trigger: 'has_worldbook',
        },
        {
          type: 'message',
          id: 'wb-5-format',
          name: '行格式与容错',
          role: 'user',
          content: [WB_FIELD_SPEC, '', WB_TOLERANCE].join('\n'),
          enabled: true,
          trigger: 'always',
        },
      ],
      // 普通预设：不跟随全局，自己一条工具都不勾 —— 解析后 0 工具 = 只发消息，不跑工具循环
      use_global_caps: true,
      tools: [],
    }),
  ];
}

/** 常量化版本：只读用（界面列内置清单、测试断言）；要改请用 create* 拿副本 */
export const BUILTIN_SKILLS: Skill[] = createBuiltinSkills();
export const BUILTIN_PRESETS: Preset[] = createBuiltinPresets();

/** 内置 id 清单，方便别处判断「这是不是内置的」 */
export const BUILTIN_PRESET_IDS = BUILTIN_PRESETS.map(preset => preset.id);
export const BUILTIN_SKILL_IDS = BUILTIN_SKILLS.map(skill => skill.id);

/** 某个 id 是不是内置预设 / 技能 */
export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_PRESET_IDS.includes(id);
}

export function isBuiltinSkillId(id: string): boolean {
  return BUILTIN_SKILL_IDS.includes(id);
}

/* ============================ 合并进 RootData ============================ */

/**
 * 把内置预设 / 技能补进 RootData。
 *
 * ─────────────────────────── 规则（B41 已改）───────────────────────────
 *
 * **内置预设：强制覆盖成最新版。** 用户的预设（`builtin: false`）一个字都不碰。
 *
 * ⚠️ 原来这里是「**只补不覆盖**」，那条规则的立意（别冲掉用户的编辑）是对的，
 * 但落点错了 —— 它把「内置」和「用户的」混为一谈：
 *
 *  | 后果 | 真机表现 |
 *  |---|---|
 *  | 插件升级带了新内置预设 | **用户永远看不到**（被存储里的旧副本挡住）|
 *  | 内置预设的提示词改好了 | 同样看不到（B20 那次改的就没生效）|
 *  | 内置预设引用了已删除的工具名 | 界面多出几行「entry_create」这种幽灵工具 |
 *
 * 正确的分工是：**内置的归内置（随版本走），要改就派生**。
 * 「另存为」早就做对了（`App.vue` 的 duplicate → `builtin: false` + 新 id），
 * 所以这里强制覆盖**不会**让用户丢东西 —— 用户改过的内容在**他自己的副本**里。
 *
 * **技能同理**：`builtin: true` 的强制覆盖（B15-B19 删掉了两个旧内置技能，
 * 不覆盖的话它们会一直留在存储里，模型还能挑中它们）。
 *
 * 顺带把空的 / 指不上任何预设的 active_preset_id 指向第一个可用预设。
 *
 * 纯函数：返回新对象，不改入参。
 */
export function applyBuiltins(data: RootData): RootData {
  const presets = [...data.presets];
  for (const preset of createBuiltinPresets()) {
    const index = presets.findIndex(item => item.id === preset.id);
    if (index < 0) presets.push(preset);
    else presets[index] = preset; // 内置 → 强制覆盖成最新版
  }

  // 技能：删掉「当前内置」+「已退役内置」，用户自建的原样保留
  const ownedSkillIds = new Set([
    ...createBuiltinSkills().map(skill => skill.id),
    ...RETIRED_BUILTIN_SKILL_IDS,
  ]);
  const skills = data.skills.filter(skill => !ownedSkillIds.has(skill.id));
  for (const skill of createBuiltinSkills()) skills.push(skill);

  const hasActive = presets.some(preset => preset.id === data.active_preset_id);
  const activePresetId = hasActive ? data.active_preset_id : (presets[0]?.id ?? '');

  return { ...data, presets, skills, active_preset_id: activePresetId };
}
