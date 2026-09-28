/**
 * 验收补充：presets/builtin.ts —— 内置预设/技能的结构、宏/工具/技能引用一致性、applyBuiltins 只补不覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  createBuiltinSkills,
  createBuiltinPresets,
  BUILTIN_SKILLS,
  BUILTIN_PRESETS,
  BUILTIN_PRESET_IDS,
  BUILTIN_SKILL_IDS,
  isBuiltinPresetId,
  isBuiltinSkillId,
  applyBuiltins,
} = await import(root + 'presets/builtin.ts');
const { PresetSchema, SkillSchema, RootDataSchema, isAgentPreset, resolveCaps } = await import(root + 'core/types.ts');
const { TOOL_NAMES, DEFAULT_ON_TOOLS } = await import(root + 'agent/registry.ts');
const { OUR_MACROS } = await import(root + 'core/macros.ts');

/** 酒馆自带的宏（macros.ts 会先过酒馆引擎），允许出现在预设里 */
const ST_MACROS = ['roll', 'user', 'char', 'time', 'date', 'input', 'persona', 'description', 'scenario', 'lastMessage'];

/**
 * 阶段 3 起宏的第三个来源：**插件贡献的宏**。
 * 从插件 manifest 里现算（不写死名单），这样插件改了宏名这条闸也跟着走。
 * 用「全部内置插件」而不是「已启用的」—— 预设是**入口**，导入后归用户，
 * 关掉插件不回收用户已经用上的预设，所以预设里出现停用插件的宏是合法的。
 */
const PLUGIN_MACRO_NAMES = (await import(root + 'plugins/registry.ts')).PLUGIN_MANIFESTS.flatMap(
  manifest => (manifest.contributes.macros ?? []).map(macro => macro.name),
);

/**
 * 「能力」页的全局默认快照：工具 = DEFAULT_ON_TOOLS（agent_registry 测试保证它与
 * ToolDef.default_on 一致），技能 = 内置技能全开。
 * 判「是不是 Agent」必须拿它一起解析 —— 跟随全局的预设自己 tools=[] 也是 Agent。
 */
const globalCaps = {
  tools: DEFAULT_ON_TOOLS.map(name => ({ name, default_on: true })),
  skills: createBuiltinSkills(),
};

function macrosIn(text) {
  return [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]))];
}

test('presets: 内置技能目前为空（D7 删了旧的，新的等 B46-B57）', () => {
  const skills = createBuiltinSkills();
  // D7 定案删掉「世界书精修」「势力关系梳理」（用户：「内置 skill 没价值」—— 那是写作风格，用户的活儿）。
  // 替代它们的「世界书工程」要等 skill 系统（B46-B57）落地。
  // 在那之前**故意是空的**：技能是可选的加速器，不是必需品。
  assert.deepEqual(skills, [], 'B46-B57 落地前内置技能应为空');
  assert.deepEqual(BUILTIN_SKILL_IDS, []);
  assert.equal(BUILTIN_SKILLS.length, 0);
  assert.equal(isBuiltinSkillId('builtin-skill-worldbook-polish'), false, '删掉的旧技能不该还被认成内置');
  for (const skill of skills) {
    SkillSchema.parse(skill);
    assert.equal(skill.builtin, true);
    assert.ok(skill.name && skill.summary && skill.body, skill.id + ' 内容不全');
    for (const file of skill.files) assert.ok(file.name && typeof file.content === 'string');
  }
  assert.deepEqual(BUILTIN_SKILL_IDS, skills.map(skill => skill.id));
  assert.equal(BUILTIN_SKILLS.length, skills.length);
});

test('presets: 内置预设结构合法、id 唯一、items/output 齐全', () => {
  const presets = createBuiltinPresets();
  assert.ok(presets.length >= 3);
  assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length);
  for (const preset of presets) {
    PresetSchema.parse(preset);
    assert.equal(preset.builtin, true);
    assert.ok(preset.name);
    assert.ok(!('kind' in preset), preset.id + ' v4 起不该再有 kind');
    assert.ok(!('system' in preset), preset.id + ' v4 起不该再有 system 字符串');
    assert.ok(!('messages' in preset), preset.id + ' v4 起不该再有 messages');
    if (preset.id === 'builtin-agent-worldbook') {
      assert.equal(preset.use_global_caps, false, preset.id + ' 跟随「能力」页的全局设置');
    } else {
      assert.equal(preset.use_global_caps, true, preset.id + ' 不跟随全局（普通对话）');
      assert.deepEqual(preset.tools, [], preset.id + ' 普通预设不该勾工具');
    }
    assert.ok(preset.items.length > 0, preset.id + ' 预设本体一条都没有');
    for (const item of preset.items) {
      assert.ok(item.id, preset.id + ' 条目缺 id');
      if (item.type === 'message') assert.ok(item.content.length > 0, preset.id + ' 消息条目内容为空');
    }
    if (isAgentPreset(preset, globalCaps)) {
      assert.ok(preset.tools.length > 0, preset.id + ' agent 预设没挂工具（关掉全局后的兜底）');
      assert.ok(
        preset.items.some(item => item.type === 'message' && item.role === 'system'),
        preset.id + ' agent 预设没有系统提示词',
      );
    }
  }
  assert.deepEqual(BUILTIN_PRESET_IDS, presets.map(preset => preset.id));
  assert.equal(isBuiltinPresetId('builtin-agent-worldbook'), true);
  assert.equal(isBuiltinPresetId('不存在的'), false);
});

test('presets: 预设里的宏全部是我们认识的（或酒馆自带），没有拼错的宏', () => {
  // 阶段 3：宏有三个来源 —— 底座 OUR_MACROS / 酒馆自带 ST_MACROS / **插件贡献的宏**。
  // 立绘预设用的 角色列表 / 图片元数据 现在归苍玄助手插件，所以要把插件宏一起算进「认识」。
  const known = new Set([...OUR_MACROS, ...ST_MACROS, ...PLUGIN_MACRO_NAMES]);
  const seen = new Set();
  for (const preset of createBuiltinPresets()) {
    const texts = preset.items.map(item => (item.type === 'message' ? item.content : ''));
    for (const text of texts) {
      for (const macro of macrosIn(text)) {
        seen.add(macro);
        assert.ok(known.has(macro), preset.id + ' 里出现了不认识的宏 {{' + macro + '}}');
      }
    }
  }
  assert.ok(seen.size > 0, '内置预设应该真的用到了宏');
});

test('presets: agent 预设引用的工具和技能都存在', () => {
  const skillIds = new Set(BUILTIN_SKILL_IDS);
  const toolNames = new Set(TOOL_NAMES);
  for (const preset of createBuiltinPresets()) {
    if (!isAgentPreset(preset, globalCaps)) continue;
    for (const tool of preset.tools) assert.ok(toolNames.has(tool), preset.id + ' 引用了不存在的工具 ' + tool);
    for (const skill of preset.skills) assert.ok(skillIds.has(skill), preset.id + ' 引用了不存在的技能 ' + skill);
  }
});

test('presets: 跟随全局 ⇒ 解析后是 agent（内置 agent 预设照旧跑工具循环）', () => {
  const agent = createBuiltinPresets().find(preset => preset.id === 'builtin-agent-worldbook');
  assert.ok(agent, '内置 agent 预设不见了');
  assert.equal(agent.use_global_caps, false, '跟随全局');

  const caps = resolveCaps(agent, globalCaps);
  assert.equal(caps.tools.length, DEFAULT_ON_TOOLS.length, '工具来自「能力」页默认：' + caps.tools.join('、'));
  assert.ok(caps.tools.includes('wb_read'), '默认读工具要在');
  assert.ok(caps.tools.includes('submit'), '收工工具要在');
  assert.equal(isAgentPreset(agent, globalCaps), true, '解析后工具非空 = Agent（旧判据 tools.length>0 会误判）');

  // 自己一条工具都没勾，只要跟随全局，同样是 Agent（这正是旧判据漏掉的那种预设）
  const bare = PresetSchema.parse({ id: 'bare', name: '自己没勾', use_global_caps: false, tools: [] });
  assert.equal(isAgentPreset(bare, globalCaps), true);

  // 显式带了「上下文」特殊层（原来靠 agent 路径隐式补历史）
  assert.ok(
    agent.items.some(item => item.type === 'special' && item.kind === 'context'),
    'agent 预设要显式带一个上下文层',
  );
});

test('presets: 立绘 / 蓝灯预设解析后 0 工具 ⇒ 仍然走普通 LLM 路径', () => {
  for (const id of ['builtin-plain-zhihatsuki', 'builtin-plain-worldbook-lantern']) {
    const preset = createBuiltinPresets().find(item => item.id === id);
    assert.ok(preset, id + ' 内置预设不见了');
    assert.equal(preset.use_global_caps, true, id + '：不跟随全局');
    assert.deepEqual(preset.tools, [], id + '：自己也不勾工具');
    assert.deepEqual(resolveCaps(preset, globalCaps).tools, [], id + '：解析后 0 工具');
    assert.equal(isAgentPreset(preset, globalCaps), false, id + '：必须走普通路径（绝不能跑工具循环）');
    assert.equal(preset.skills.length, 0, id + '：普通预设不该挂技能');
  }
});

test('presets: create* 每次给新副本，改副本不影响常量', () => {
  // 技能：现在内置为空（D7 + B46-B57 之间），所以用预设来钉「新副本」这条性质。
  assert.deepEqual(createBuiltinSkills(), [], '内置技能暂时为空');

  const presets = createBuiltinPresets();
  presets[0].max_rounds = 99;
  assert.notEqual(BUILTIN_PRESETS[0].max_rounds, 99);
  // 深一层：改 items 里的对象也不许影响常量（浅拷贝会漏这条）
  const again = createBuiltinPresets();
  again[0].items[0].content = '被外部改了';
  assert.notEqual(BUILTIN_PRESETS[0].items[0].content, '被外部改了');
});

test('presets: applyBuiltins 内置强制覆盖、用户预设不碰、补齐 active_preset_id、纯函数、幂等', () => {
  // ⚠️ 这条规则 B41 改过：原来叫「只补不覆盖」，但它把「内置」和「用户的」混为一谈 ——
  // 后果是插件升级带的新内置预设**永远看不到**（被存储里的旧副本挡住），
  // 真机上还表现为「内置预设引用了已删除的工具名 → 界面多出幽灵工具行」。
  //
  // 现在的分工：内置的归内置（随版本走），要改就派生（duplicate 早就做对了）。
  const staleBuiltin = PresetSchema.parse({
    id: 'builtin-agent-worldbook',
    name: '旧版内置预设（存储里那份）',
    items: [{ type: 'message', id: 'custom-system', role: 'system', content: '旧版系统提示词' }],
    tools: ['wb_read', 'entry_edit'], // ← 旧工具名，正是真机上那几行幽灵工具的来源
  });
  const staleSkill = SkillSchema.parse({ id: 'builtin-skill-worldbook-polish', name: '旧版内置技能', body: 'x' });
  // 用户自己的预设 / 技能：id 不在内置清单里 → 一个字都不许碰
  const myPreset = PresetSchema.parse({ id: 'preset_mine', name: '我自己的预设', builtin: false, tools: ['wb_read'] });
  const mySkill = SkillSchema.parse({ id: 'skill_mine', name: '我自己的技能', body: 'y' });

  const before = RootDataSchema.parse({});
  const input = {
    ...before,
    presets: [staleBuiltin, myPreset],
    skills: [staleSkill, mySkill],
    active_preset_id: '',
  };
  const snapshot = structuredClone(input);

  const once = applyBuiltins(input);
  assert.deepEqual(input, snapshot, '纯函数不许改入参');

  // ① 内置预设被覆盖成最新版
  const fixed = once.presets.find(preset => preset.id === 'builtin-agent-worldbook');
  assert.equal(fixed.name, '世界书 · 势力整理 Agent', '内置预设要更新成最新版');
  assert.ok(!fixed.tools.includes('entry_edit'), '旧工具名要跟着内置更新一起消失');
  assert.ok(fixed.tools.includes('wb_write'), '新工具名要进来');
  assert.equal(fixed.items[0].content.includes('苍玄界'), false, 'B20 的文案改动要能到设备上');

  // ② 内置技能被覆盖（B15-B19 删掉了两个旧内置技能）
  assert.equal(once.skills.some(skill => skill.id === 'builtin-skill-worldbook-polish'), false, '已删除的内置技能不该复活');

  // ③ 用户自己的预设 / 技能**一个字都不碰**
  assert.deepEqual(
    once.presets.find(preset => preset.id === 'preset_mine'),
    myPreset,
    '用户预设不许动',
  );
  assert.deepEqual(once.skills.find(skill => skill.id === 'skill_mine'), mySkill, '用户技能不许动');

  assert.equal(once.presets.length, BUILTIN_PRESET_IDS.length + 1, '内置补齐 + 用户那份');
  assert.equal(once.active_preset_id, 'builtin-agent-worldbook', '空的 active_preset_id 指到第一个');

  const twice = applyBuiltins(once);
  assert.deepEqual(twice, once, '幂等');

  const keptActive = applyBuiltins({ ...before, active_preset_id: '用户自己的预设' });
  assert.equal(keptActive.active_preset_id, 'builtin-agent-worldbook', '指向不存在预设时改指第一个');

  const withExisting = applyBuiltins({ ...once, active_preset_id: 'builtin-plain-zhihatsuki' });
  assert.equal(withExisting.active_preset_id, 'builtin-plain-zhihatsuki', '指向存在预设时不动');
});
