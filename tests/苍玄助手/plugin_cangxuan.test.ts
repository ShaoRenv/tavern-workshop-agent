/**
 * 阶段 3 · T3-7：苍玄助手插件的「关掉即消失」全套（宏 + 工具 + 技能）。
 *
 * 硬规矩 2 是**三层**都要成立（阶段 2 验收 F-A 抓过一次：
 * 界面写着「来源已停用」、模型却照样能调）：
 *   ① 宏层 —— 关掉插件 → {{图片提示词}} 渲染退回空串（不是报错、不是留着旧值）；
 *   ② 工具层 —— 它的 3 个 portrait_* 从能力里消失，且**新形状的 ToolDef 也过 liveToolDefs 闸**；
 *   ③ 技能层 —— 它带的技能在关掉后不进「可用技能」。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './_helpers.ts';

const srcRoot = fileURLToPath(new URL('../../src/苍玄助手/', import.meta.url));
const root = '../../src/苍玄助手/';

const {
  PLUGIN_MANIFESTS,
  pluginManifest,
  pluginEnabled,
  pluginTools,
  pluginAllTools,
  pluginToolDefs,
  pluginMacros,
  pluginSkills,
  toolOwner,
  toolOwnerLabel,
} = await import(root + 'plugins/registry.ts');
const { liveToolDefs } = await import(root + 'run/runner.ts');
const macros = await import(root + 'core/macros.ts');

/** 注册表函数只依赖 plugin_state 那一小块 */
function state(plugin_state = {}) {
  return { plugin_state };
}

/** 苍玄助手贡献的 3 个工具（阶段 3 新增，归它所有） */
const CX_TOOLS = ['portrait_list', 'portrait_meta', 'portrait_prompt'];
/** 苍玄助手贡献的宏；图片提示词是天天要用的那个（tavern + preset 双作用域） */
const CX_MACRO_NAMES = ['图片提示词', '角色列表', '图片元数据'];

/* ==================== 插件契约本体 ==================== */

test('苍玄助手插件：没有页面、3 个 portrait_* 工具、宏齐全、默认开', () => {
  const manifest = pluginManifest('cangxuan');
  assert.equal(manifest.id, 'cangxuan');
  assert.equal(manifest.builtin, true, '内置：可关不可卸');
  assert.equal(manifest.defaultEnabled, true);
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.contributes.pages, undefined, '苍玄助手不贡献页面（阶段 3 去页面）');

  // 工具是真 ToolDef（阶段 3 的契约变化：不再是 { name, defaultOn? }）
  const defs = manifest.contributes.tools ?? [];
  assert.deepEqual(defs.map((def: any) => def.name).sort(), [...CX_TOOLS].sort());
  for (const def of defs) {
    assert.equal(typeof def.run, 'function', def.name + ' 要有 run（真 ToolDef，不是引用）');
    assert.equal(typeof def.model_description, 'string', def.name + ' 要有 model_description');
    assert.equal(typeof def.default_on, 'boolean', def.name + ' 要有 default_on');
    assert.equal('defaultOn' in def, false, def.name + ' 不许再出现老的 defaultOn 写法');
    assert.equal(typeof def.group, 'string');
    assert.equal(typeof def.title, 'string');
    assert.equal(typeof def.parameters, 'object');
  }

  const macros = manifest.contributes.macros ?? [];
  assert.deepEqual(macros.map((macro: any) => macro.name).sort(), [...CX_MACRO_NAMES].sort());
  for (const macro of macros) {
    assert.equal(typeof macro.render, 'function', macro.name + ' 要自己给 render（注册/注销由底座做）');
    assert.ok(Array.isArray(macro.scopes) && macro.scopes.length > 0, macro.name + ' 要声明作用域');
  }
  const promptMacro = macros.find((macro: any) => macro.name === '图片提示词');
  assert.deepEqual(promptMacro.scopes.slice().sort(), ['preset', 'tavern'], '图片提示词两边都注册（角色卡里也能用）');
});

test('苍玄助手工具归它自己；底座工具不受影响', () => {
  for (const name of CX_TOOLS) {
    assert.equal(toolOwner(name), 'cangxuan', name + ' 归苍玄助手');
    assert.equal(toolOwnerLabel(name), '苍玄助手');
  }
  assert.equal(toolOwnerLabel('wb_list'), '世界书');
  assert.equal(toolOwner('skill'), 'base');

  // 三个工具都**注册**（走 pluginAllTools / 界面清单）；默认进不进全局能力由各自的 default_on 定，
  // **不在这里钉死**（Lead 口径：portrait_list / portrait_meta 默认给，portrait_prompt 按需）——
  // 钉太死会让别人调整默认值误伤这条闸。这里只保证「注册了」+「关掉就都没了」。
  const on = state({ cangxuan: { enabled: true } });
  for (const name of CX_TOOLS) {
    assert.ok(pluginAllTools(on).includes(name), name + ' 在注册清单里');
  }
  // pluginTools 必须是 pluginAllTools 的子集（默认给的 ⊆ 注册的）
  for (const name of pluginTools(on)) {
    assert.ok(pluginAllTools(on).includes(name), name + ' 默认给的必须在注册清单里');
  }
});

/* ==================== ① 宏层：关掉退回空串 ==================== */

test('关掉苍玄助手 → 它的宏从 pluginMacros 消失（渲染面就没了占位符来源）', () => {
  const on = state({ cangxuan: { enabled: true } });
  const off = state({ cangxuan: { enabled: false } });

  const onNames = pluginMacros(on).map(macro => macro.name);
  for (const name of CX_MACRO_NAMES) assert.ok(onNames.includes(name), '开着的时候 ' + name + ' 在');

  assert.deepEqual(pluginMacros(off), [], '关掉 → 一个插件宏都不剩');
  assert.equal(
    pluginMacros(off).some(macro => macro.name === '图片提示词'),
    false,
    '关掉苍玄助手 → 图片提示词宏不再注册',
  );

  // 关掉的是苍玄助手**一个**插件：别的插件的贡献不受牵连。
  // 现况：只有苍玄助手贡献宏，所以关掉它之后（别的插件都开着）宏清单为空。
  assert.deepEqual(
    pluginMacros(state({ cangxuan: { enabled: false }, worldbook: { enabled: true }, image: { enabled: true } })),
    [],
    '关掉苍玄助手之后，别的插件开着也不该凭空冒出它的宏',
  );
});

test('关掉苍玄助手 → {{图片提示词}} 渲染退回空串（**运行层**闸，不是只看清单）', () => {
  // 契约（Lead 口径，core/macros.ts 的 registerPluginMacroSource / registerPluginMacroNames）：
  //   判据是「**宏名还在不在清单里**」，不是「renderer 在不在」。
  //   插件停用 → 名字仍在清单、renderer 注销 → 渲染成**空串**（老预设不会露出 {{图片提示词}}）；
  //   压根没装过插件 → 名字都不在清单 → 占位符原样留着。
  const { render, emptyMacroData, registerPluginMacroSource, registerPluginMacroNames, pluginMacroNames } = macros;

  const restore = () => {
    registerPluginMacroSource(null);
    registerPluginMacroNames([]);
  };

  try {
    // ① 从没装过插件：名字不在清单 → 占位符原样留着
    restore();
    assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'A{{图片提示词}}B', '没装过插件时占位符原样留着');

    // ② 插件**开着**：名字在清单 + renderer 给值 → 真的替换
    registerPluginMacroNames(['图片提示词']);
    registerPluginMacroSource((name, data) => {
      assert.equal(name, '图片提示词');
      return 'PROMPT:' + String(data.character_name ?? '');
    });
    assert.equal(
      render('A{{图片提示词}}B', { ...emptyMacroData(), character_name: '潮听澜' }),
      'APROMPT:潮听澜B',
      '开着的时候宏真的展开',
    );
    assert.deepEqual(pluginMacroNames(), ['图片提示词']);

    // ③ 插件**关掉**：名字仍在清单、renderer 注销 → 空串（这条就是「关掉即消失」）
    registerPluginMacroSource(null);
    assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'AB', '关掉 → 退成空串，不留裸露占位符');

    // ④ renderer 抛错 / 返回 undefined 也不炸：按空串走，别让一条坏宏拖垮整轮渲染
    registerPluginMacroSource(() => {
      throw new Error('插件宏炸了');
    });
    assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'AB', 'renderer 抛错 → 空串');
    registerPluginMacroSource(() => undefined);
    assert.equal(render('A{{图片提示词}}B', emptyMacroData()), 'AB', 'renderer 返回 undefined → 空串');

    // ⑤ 关掉苍玄助手时，插件宏清单里一个它的宏都不剩（清单由底座按开关现算）
    assert.deepEqual(pluginMacros(state({ cangxuan: { enabled: false } })), []);
    const onNames = pluginMacros(state({ cangxuan: { enabled: true } })).map((macro: any) => macro.name);
    assert.ok(onNames.includes('图片提示词'), '开着的时候图片提示词在插件宏清单里');
  } finally {
    restore(); // 进程级全局状态：用完必须还原，免得污染别的用例
  }
});

/* ==================== ② 工具层：3 个工具从能力里消失 ==================== */

test('关掉苍玄助手 → 它的 3 个工具从能力与注册清单一起消失；重开就回来', () => {
  const on = state({ cangxuan: { enabled: true } });
  const off = state({ cangxuan: { enabled: false } });

  for (const name of CX_TOOLS) {
    assert.equal(pluginAllTools(off).includes(name), false, '关掉 → ' + name + ' 连注册清单都不进');
    assert.equal(pluginTools(off).includes(name), false, '关掉 → ' + name + ' 不进全局能力');
    assert.equal(pluginToolDefs(off).some((def: any) => def.name === name), false, '关掉 → ' + name + ' 的 def 都没了');
  }

  const back = pluginToolDefs(on).map((def: any) => def.name);
  for (const name of CX_TOOLS) assert.ok(back.includes(name), '重开就回来：' + name);

  // 关苍玄助手只影响它自己：世界书那 6 个默认给的还在
  assert.equal(pluginTools(off).includes('wb_list'), true, '世界书的工具不受牵连');
});

test('F-A 回归闸（阶段 3 新形状）：liveToolDefs 按 ToolDef 归属过滤，不认老 { name } 写法', () => {
  // 阶段 2 验收抓的 F-A：界面写「来源已停用」、runner 却把全量 defs 喂给模型。
  // 阶段 3 的 contributes.tools 换成真 ToolDef 后，闸门必须照样成立。
  const defs = [{ name: 'skill' }, { name: 'portrait_list' }, { name: 'portrait_meta' }, { name: 'portrait_prompt' }, { name: 'wb_list' }];

  assert.deepEqual(
    liveToolDefs(defs, state({ cangxuan: { enabled: true } })).map((def: any) => def.name),
    ['skill', 'portrait_list', 'portrait_meta', 'portrait_prompt', 'wb_list'],
    '两个插件都开着 → 全给',
  );

  assert.deepEqual(
    liveToolDefs(defs, state({ cangxuan: { enabled: false } })).map((def: any) => def.name),
    ['skill', 'wb_list'],
    '关掉苍玄助手 → 3 个 portrait_* 连 def 都不进这一轮（模型根本看不到）',
  );

  assert.deepEqual(
    liveToolDefs(defs, state({ cangxuan: { enabled: false }, worldbook: { enabled: false } })).map((def: any) => def.name),
    ['skill'],
    '两个插件全关 → 只剩底座的工具',
  );

  // 按需工具（default_on:false）的 **def** 照样要过闸：能不能发给模型由 resolveCaps 定，
  // 但「插件关着 → 连 def 都没有」这条对默认给的与按需的一视同仁。
  const withOnDemand = [{ name: 'entry_meta' }, { name: 'portrait_prompt' }];
  assert.deepEqual(
    liveToolDefs(withOnDemand, state({ cangxuan: { enabled: false }, worldbook: { enabled: false } })).map((def: any) => def.name),
    [],
    '两个插件都关 → 按需工具的 def 也一个不留',
  );
  assert.deepEqual(
    liveToolDefs(withOnDemand, state({ cangxuan: { enabled: true }, worldbook: { enabled: true } })).map((def: any) => def.name).sort(),
    ['entry_meta', 'portrait_prompt'],
    '插件开着 → 按需工具的 def 要在（发不发是 resolveCaps 的事）',
  );

  // 默认状态（plugin_state 空）= manifest.defaultEnabled：苍玄助手/世界书开
  assert.deepEqual(
    liveToolDefs(defs, state()).map((def: any) => def.name),
    ['skill', 'portrait_list', 'portrait_meta', 'portrait_prompt', 'wb_list'],
    '缺省按 manifest.defaultEnabled 现算',
  );

  // 底座的工具永远不受插件开关影响
  const base = [{ name: 'skill' }, { name: 'submit' }, { name: 'ask_user' }];
  assert.deepEqual(
    liveToolDefs(base, state({ cangxuan: { enabled: false }, worldbook: { enabled: false } })).map((def: any) => def.name),
    ['skill', 'submit', 'ask_user'],
  );
});

/* ==================== ③ 技能层 ==================== */

test('关掉苍玄助手 → 它带的技能从 pluginSkills 消失（关插件即从技能列表消失）', () => {
  const skillsOn = pluginSkills(state({ cangxuan: { enabled: true } }));
  const skillsOff = pluginSkills(state({ cangxuan: { enabled: false } }));

  assert.deepEqual(skillsOff, [], '关掉 → 插件技能一个不剩');
  // 有技能就断言形状；没技能也不该让这条用例失败（技能是可选的贡献点）
  for (const skill of skillsOn) {
    assert.equal(typeof skill.name, 'string');
    assert.equal(typeof skill.content, 'string', skill.name + ' 的正文要能在关插件后一起消失');
    assert.ok(skill.name.length > 0);
  }
});

/* ==================== 源码级：插件的「活物」都在 contributions 里 ==================== */

test('源码级：苍玄助手目录不含 store / Store 的 import（插件页只拿 host + 自己那份设置）', () => {
  const dir = srcRoot + 'plugins/builtin/cangxuan/';
  const files = ['manifest.ts', 'macros.ts', 'tools.ts', 'portrait.ts'];
  const offenders: string[] = [];
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(dir + file, 'utf8');
    } catch {
      continue; // 文件还没搬过来：由「目录结构」那条用例兜，这里不重复报
    }
    const code = codeOnly(text);
    if (/from\s+['"][^'"]*stores\/app\.ts['"]/.test(code)) offenders.push(file + ' import 了 store');
    if (/\buseAppStore\b/.test(code)) offenders.push(file + ' 用了 useAppStore');
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('源码级：worldbook 插件是**唯一**贡献页面的内置插件（顶栏 3 格的来源）', () => {
  const withPages = PLUGIN_MANIFESTS.filter(manifest => (manifest.contributes.pages ?? []).length > 0);
  assert.deepEqual(withPages.map(manifest => manifest.id), ['worldbook'], '阶段 3 只有世界书带页面');

  const pages = withPages.flatMap(manifest => manifest.contributes.pages ?? []);
  assert.deepEqual(
    pages.map(page => [page.id, page.title, page.order, page.inTabbar]),
    [['worldbook', '世界书', 30, true]],
  );
});

test('源码级：插件开关缺省值 —— 苍玄助手 / 世界书 true，生图 false', () => {
  assert.equal(pluginEnabled({}, 'cangxuan'), true);
  assert.equal(pluginEnabled({}, 'worldbook'), true);
  assert.equal(pluginEnabled({}, 'image'), false);
  assert.equal(pluginManifest('image').defaultEnabled, false);
  // 半截数据（有 id 没 enabled）回落 manifest 缺省，不当成 false
  assert.equal(pluginEnabled(state({ cangxuan: {} }), 'cangxuan'), true);
});