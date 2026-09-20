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
 * 文本内容来源：设计稿/苍玄助手-设计稿.html（Agent 系统提示词、两个技能正文）
 * 与旧工程 src/苍玄界立绘工坊/llm/presets_builtin.ts（智绘姬骨架与字段规范）。
 */
import { PresetSchema, SkillSchema, type Preset, type RootData, type Skill } from '../core/types.ts';

/* ============================ 文案常量 ============================ */

/** Agent 的系统提示词（设计稿设置页原文） */
const AGENT_WORLDBOOK_SYSTEM = [
  '你是苍玄界世界书的整理助手。改之前先读，只改该改的地方。',
  '需要专门手法时看看有哪些技能可用。做完调 submit。',
  '',
  '工作纪律：',
  '- 一切写操作都先进草稿，不要直接改酒馆里的世界书；用户点保存才落盘。',
  '- 改条目用 old_string → new_string 精确替换，不要整条重写。',
  // 工具只实现了「世界书级」范围，没有条目级范围；这里不能写「和条目」，否则是在骗模型
  '- 只动用户圈定范围内的世界书；范围外的先问。',
].join('\n');

/**
 * Agent 预设自己勾的内置工具（名字必须与 agent/registry.ts 一致）。
 * 这个预设是 use_global_caps=false（跟随全局），所以这份清单平时不生效，
 * 是「以后关掉全局」时的兜底；内容与 DEFAULT_ON_TOOLS 保持一致。
 */
const AGENT_TOOLS = [
  'wb_list',
  'wb_search',
  'wb_read',
  'entry_create',
  'entry_edit',
  'entry_delete',
  'skill',
  'read_skill_file',
  // gen_image 故意不默认勾选：生图 API 还没接，默认开着只会诱导模型乱调、白烧钱。
  // 工具本身保留（用户以后要接生图，走外部工具形态再打开）。
  'submit',
];

/** Agent 预设默认挂着的技能 id */
const AGENT_SKILLS = ['builtin-skill-worldbook-polish', 'builtin-skill-faction-relations'];

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

const SKILL_WORLDBOOK_POLISH_BODY = [
  '# 世界书精修',
  '',
  '## 什么时候用',
  '用户说「这几条太啰嗦」「压一压」「统一成蓝灯精简」时用这套手法。',
  '',
  '## 怎么做',
  '1. 先 wb_read 把条目读全，不要凭标题猜内容。',
  '2. 只保留：身份、外貌、能力、关键关系。',
  '3. 每条压到 150 字以内，激活策略用蓝灯（strategy = constant → 写回 strategy.type = \'constant\'）。',
  '4. 改完对照原文检查一遍有没有丢设定；丢了的补回去。',
  '',
  '## 硬性要求',
  '- 一条一条改，禁止整条重写：用 entry_edit 的 old_string → new_string 精确替换。',
  '- 条目名（name）不改，除非用户明确要求。',
  '- 原文里的专有名词、称呼、境界数值一律照抄，不许「顺手润色」成别的说法。',
  '- 拿不准的条目直接列出来问用户，不要猜。',
].join('\n');

const SKILL_FACTION_BODY = [
  '# 势力关系梳理',
  '',
  '## 什么时候用',
  '用户说「理一理势力关系」「互相引用」「补上所属势力」时用。',
  '',
  '## 怎么做',
  '1. 先用 wb_search 把每个势力名搜一遍，确认势力条目和角色条目都在哪几本世界书里。',
  '2. 逐个势力抽出一行关系：势力名 → 立场 / 首领 / 所在地 / 与其他势力的关系（盟友、敌对、上下属、暗中往来）。',
  '3. 在角色条目里补「所属势力」，在势力条目里补「主要人物」，两边互相引用。',
  '4. 关系只写有依据的；世界书里没有的内容标成「待确认」，不要编。',
  '',
  '## 输出格式',
  '每条关系一行：`势力A →关系→ 势力B（依据：条目名）`。',
  '收尾时把新加的引用列成清单，方便用户核对。',
].join('\n');

/* ============================ 内置内容 ============================ */

/** 内置技能（每次调用返回全新副本，避免界面改到常量） */
export function createBuiltinSkills(): Skill[] {
  return [
    SkillSchema.parse({
      id: 'builtin-skill-worldbook-polish',
      name: '世界书精修',
      summary: '把啰嗦的条目压成蓝灯精简，保持人设口吻',
      body: SKILL_WORLDBOOK_POLISH_BODY,
      enabled: true,
      builtin: true,
      files: [
        {
          name: '模板·角色条目.md',
          content: [
            '# 角色条目模板',
            '',
            '**姓名**｜一句话身份。性别，年龄（修为），境界，势力。',
            '外貌：只留最具辨识度的三点。',
            '性格：2-4 句，写行为模式而不是形容词堆砌。',
            '能力：功法 / 武器 / 特殊之处。',
            '关系：只写对剧情有推动的那几条。',
            '口癖：有就写，没有就不写。',
          ].join('\n'),
        },
        {
          name: '范例·势力条目.json',
          content: JSON.stringify(
            {
              name: '天枢阁',
              strategy: 'constant',
              content: '天枢阁总部位于苍梧山巅，掌门为凌霄真人。以星象推演立宗，与幽冥殿敌对，暗中庇护苍梧一带的散修。',
            },
            null,
            2,
          ),
        },
      ],
    }),
    SkillSchema.parse({
      id: 'builtin-skill-faction-relations',
      name: '势力关系梳理',
      summary: '从多条目里抽出势力之间的关系，补成互相引用',
      body: SKILL_FACTION_BODY,
      enabled: true,
      builtin: true,
      files: [
        {
          name: '关系符号表.md',
          content: [
            '# 关系符号表',
            '',
            '| 符号 | 含义 |',
            '| --- | --- |',
            '| →盟友→ | 明面结盟 |',
            '| →敌对→ | 公开敌对 |',
            '| →上下属→ | 隶属 / 附庸 |',
            '| →暗中→ | 私下往来，明面不承认 |',
            '| →待确认→ | 有线索但世界书里没写死 |',
          ].join('\n'),
        },
      ],
    }),
  ];
}

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
 * 规则：**只补不覆盖**。同 id 已存在就原样保留（用户可能改过内置内容，
 * 刷新时不能把用户的编辑冲掉）；只有缺失的 id 才插入。
 * 顺带把空的 active_preset_id 指向第一个可用预设，保证界面一进来就有选中的预设。
 *
 * 纯函数：返回新对象，不改入参。
 */
export function applyBuiltins(data: RootData): RootData {
  const presetIds = new Set(data.presets.map(preset => preset.id));
  const presets = [...data.presets];
  for (const preset of createBuiltinPresets()) {
    if (!presetIds.has(preset.id)) presets.push(preset);
  }

  const skillIds = new Set(data.skills.map(skill => skill.id));
  const skills = [...data.skills];
  for (const skill of createBuiltinSkills()) {
    if (!skillIds.has(skill.id)) skills.push(skill);
  }

  const hasActive = presets.some(preset => preset.id === data.active_preset_id);
  const activePresetId = hasActive ? data.active_preset_id : (presets[0]?.id ?? '');

  return { ...data, presets, skills, active_preset_id: activePresetId };
}
