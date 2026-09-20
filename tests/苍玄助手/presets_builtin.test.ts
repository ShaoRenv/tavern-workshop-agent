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

test('presets: 内置技能结构合法、id 唯一、都是 builtin', () => {
  const skills = createBuiltinSkills();
  assert.ok(skills.length >= 2);
  assert.equal(new Set(skills.map(skill => skill.id)).size, skills.length);
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
  assert.equal(isBuiltinSkillId('builtin-skill-worldbook-polish'), true);
});

test('presets: 预设里的宏全部是我们认识的（或酒馆自带），没有拼错的宏', () => {
  const known = new Set([...OUR_MACROS, ...ST_MACROS]);
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
  const skills = createBuiltinSkills();
  skills[0].name = '被外部改了';
  skills[0].files.push({ name: 'x', content: 'y' });
  assert.notEqual(BUILTIN_SKILLS[0].name, '被外部改了');
  assert.equal(BUILTIN_SKILLS[0].files.some(file => file.name === 'x'), false);

  const presets = createBuiltinPresets();
  presets[0].max_rounds = 99;
  assert.notEqual(BUILTIN_PRESETS[0].max_rounds, 99);
});

test('presets: applyBuiltins 只补不覆盖、补齐 active_preset_id、纯函数、幂等', () => {
  const userPreset = PresetSchema.parse({
    id: 'builtin-agent-worldbook',
    name: '用户自己改过的内置预设',
    items: [{ type: 'message', id: 'custom-system', role: 'system', content: '我改过的系统提示词' }],
    tools: ['wb_read'],
  });
  const userSkill = SkillSchema.parse({ id: 'builtin-skill-worldbook-polish', name: '用户改过的技能', body: 'x' });

  const before = RootDataSchema.parse({});
  const input = { ...before, presets: [userPreset], skills: [userSkill], active_preset_id: '' };
  const snapshot = structuredClone(input);

  const once = applyBuiltins(input);
  assert.deepEqual(input, snapshot, '纯函数不许改入参');
  assert.equal(once.presets.find(preset => preset.id === 'builtin-agent-worldbook').name, '用户自己改过的内置预设', '不许覆盖用户的');
  assert.equal(
    once.presets.find(preset => preset.id === 'builtin-agent-worldbook').items[0].content,
    '我改过的系统提示词',
  );
  assert.equal(once.skills.find(skill => skill.id === 'builtin-skill-worldbook-polish').name, '用户改过的技能');
  assert.equal(once.presets.length, BUILTIN_PRESET_IDS.length, '缺的内置预设补进来了');
  assert.equal(once.skills.length, BUILTIN_SKILL_IDS.length);
  assert.equal(once.presets[0].id, 'builtin-agent-worldbook', '用户已有的排前面，不重排');
  assert.equal(once.active_preset_id, 'builtin-agent-worldbook', '空的 active_preset_id 指到第一个');

  const twice = applyBuiltins(once);
  assert.deepEqual(twice, once, '幂等');

  const keptActive = applyBuiltins({ ...before, active_preset_id: '用户自己的预设' });
  assert.equal(keptActive.active_preset_id, 'builtin-agent-worldbook', '指向不存在预设时改指第一个');

  const withExisting = applyBuiltins({ ...once, active_preset_id: 'builtin-plain-zhihatsuki' });
  assert.equal(withExisting.active_preset_id, 'builtin-plain-zhihatsuki', '指向存在预设时不动');
});
