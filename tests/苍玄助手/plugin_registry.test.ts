/**
 * 阶段 1-C：插件注册表 + 页面注册表 + plugin_state（v5）的契约测试。
 *
 * 要防的回归（reports/苍玄助手-底座化实施计划.md §3/§4、reports/苍玄助手-设计自查.md A9）：
 *  - 页面集合是**运行时算的**（核心页 + 已启用插件页按 order），不再是写死的 TAB_IDS；
 *  - 插件开关只住在 plugin_state，缺省取 manifest.defaultEnabled；
 *  - 关掉插件 → 它的页面从顶栏消失、它的工具不给模型（「活的贡献」关掉即消失）；
 *  - active_tab 只是一个 id：未知字符串不再是坏数据，「画不出来」由 availablePages + store.setTab 兜底；
 *  - 阶段 3 起核心页只剩 对话 10 / 设置 90，插件页只有 worldbook 30（苍玄助手去页面了 → 顶栏 3 格）：
 *    记录进对话页 ⋯ 的 Sheet、能力进设置里的一格；老页名 records / capability / skills / portraits 由 TAB_ID_ALIASES 兜。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { DATA_VERSION, RootDataSchema, TAB_ID_ALIASES, migrateTabId } = await import(root + 'core/types.ts');
const { CORE_PAGES, mergePages, tabbarPages, findPage } = await import(root + 'core/pages.ts');
const {
  PLUGIN_MANIFESTS,
  pluginManifest,
  pluginEnabled,
  enabledPlugins,
  pluginPages,
  allPages,
  availablePages,
  pluginTools,
  pluginAllTools,
  toolOwner,
  toolOwnerLabel,
  pluginStatus,
} = await import(root + 'plugins/registry.ts');
const { GLOBAL_KEY } = await import(root + 'core/types.ts');
const { DEFAULT_ON_TOOLS } = await import(root + 'agent/registry.ts');
const { defaultRootData, migrateRootData, recoverRootData, importAll, setHostBridge } = await import(
  root + 'core/storage.ts'
);
const { useAppStore } = await import(root + 'stores/app.ts');

/** 注册表函数只依赖 plugin_state 那一小块，不用造整份 RootData */
function state(plugin_state = {}) {
  return { plugin_state };
}

/** 剥掉注释：注释里提到旧代码不算数，只看真正会跑的代码（照 stores_save.test.ts 的写法） */
function codeOnly(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** 世界书注册了 7 个工具，但默认给 6 个（entry_meta 是按需的） */
const WB_TOOLS = ['wb_list', 'wb_search', 'wb_read', 'entry_create', 'entry_edit', 'entry_delete'];
const WB_META = 'entry_meta';
/**
 * 阶段 3 起苍玄助手插件贡献 3 个工具：
 * portrait_list / portrait_meta 默认**开**（只读、便宜），portrait_prompt 默认**关**（会产出正文，按需）。
 * 所以默认能力里多的是前两个。
 */
const CX_TOOLS_ON = ['portrait_list', 'portrait_meta'];
const CX_PROMPT = 'portrait_prompt';
const CX_ALL = [...CX_TOOLS_ON, CX_PROMPT];

/** 每个用例一份干净的 store（pinia 全局单例，必须重建） */
function freshStore() {
  const writes = [];
  setHostBridge({ insertOrAssignVariables: payload => writes.push(payload) });
  setActivePinia(createPinia());
  const store = useAppStore();
  store.load();
  return { store, writes };
}

/* ==================== 页面注册表 ==================== */

test('页面注册表：availablePages(store.data) = 对话/世界书/设置（阶段 3 的 3 格）', () => {
  // 阶段 3：苍玄助手插件**不再带页面**，顶栏收成 3 格。
  assert.deepEqual(
    availablePages({}).map(page => [page.id, page.title, page.order, page.inTabbar, page.owner]),
    [
      ['chat', '对话', 10, true, 'base'],
      ['worldbook', '世界书', 30, true, 'worldbook'],
      ['settings', '设置', 90, true, 'base'],
    ],
  );

  // 核心页只剩 对话 10 / 设置 90（记录进对话页 ⋯、能力进设置里的一格）
  assert.deepEqual(
    CORE_PAGES.map(page => [page.id, page.title, page.order]),
    [
      ['chat', '对话', 10],
      ['settings', '设置', 90],
    ],
  );

  // records / capability 已经不占页面：它们只留在 TAB_ID_ALIASES 里兜老数据
  const ids = availablePages({}).map(page => page.id);
  assert.equal(ids.includes('records'), false, '记录不占页面');
  assert.equal(ids.includes('capability'), false, '能力不占页面');
  // 阶段 3 起 portraits 也不再是页面 → 加进别名表兜老数据
  assert.deepEqual(TAB_ID_ALIASES, {
    skills: 'settings',
    capability: 'settings',
    records: 'chat',
    portraits: 'chat',
  });

  // 生图 / 苍玄助手只有工具、没有页面；插件页只来自开着的插件
  assert.equal(PLUGIN_MANIFESTS.find(manifest => manifest.id === 'image').contributes.pages, undefined);
  assert.equal(
    PLUGIN_MANIFESTS.find(manifest => manifest.id === 'cangxuan').contributes.pages,
    undefined,
    '阶段 3：苍玄助手去页面了',
  );
  assert.deepEqual(pluginPages({}).map(page => page.id), ['worldbook'], '插件页只来自开着的插件');
  assert.deepEqual(allPages({}).map(page => page.id), availablePages({}).map(page => page.id));
});

test('页面注册表：mergePages 按 order 升序、同 order 按 id；tabbarPages 过滤 inTabbar:false', () => {
  // 核心页 chat(10) / settings(90) 之间按 order 夹进插件页：20 < 50 < 90
  const merged = mergePages([
    { id: 'zzz-late', title: 'Z', order: 50, inTabbar: true, owner: 'x' },
    { id: 'portraits', title: '苍玄助手', order: 20, inTabbar: true, owner: 'cangxuan' },
  ]);
  assert.deepEqual(
    merged.map(page => [page.id, page.order]),
    [
      ['chat', 10],
      ['portraits', 20],
      ['zzz-late', 50],
      ['settings', 90],
    ],
  );

  // 同 order 按 id 稳定排序（顺序不随声明顺序抖）
  assert.deepEqual(
    mergePages([
      { id: 'bbb', title: 'B', order: 40, inTabbar: true, owner: 'x' },
      { id: 'aaa', title: 'A', order: 40, inTabbar: true, owner: 'x' },
    ]).map(page => page.id),
    ['chat', 'aaa', 'bbb', 'settings'],
  );

  const pages = allPages({});
  assert.equal(findPage(pages, 'settings').title, '设置');
  assert.equal(findPage(pages, 'records'), null, '记录已经不是页面了');
  assert.equal(findPage(pages, 'capability'), null, '能力已经不是页面了');
  assert.equal(findPage(pages, 'nope'), null, '找不到返回 null，调用方自己决定回落');
  assert.equal(tabbarPages([...pages, { id: 'hidden', title: '隐藏', order: 99, inTabbar: false, owner: 'x' }]).some(p => p.id === 'hidden'), false);
});

test('pluginEnabled：plugin_state 说了算；没写的取 manifest.defaultEnabled（苍玄助手/世界书 true，生图 false）', () => {
  assert.equal(pluginEnabled({}, 'cangxuan'), true);
  assert.equal(pluginEnabled({}, 'worldbook'), true);
  assert.equal(pluginEnabled({}, 'image'), false);
  assert.equal(pluginManifest('image').defaultEnabled, false);

  // 显式值覆盖缺省
  assert.equal(pluginEnabled(state({ image: { enabled: true } }), 'image'), true);
  assert.equal(pluginEnabled(state({ worldbook: { enabled: false } }), 'worldbook'), false);
  // 有 id 但没写 enabled（半截数据）→ 回落到 manifest 缺省，不当成 false
  assert.equal(pluginEnabled(state({ cangxuan: {} }), 'cangxuan'), true);

  assert.deepEqual(enabledPlugins({}).map(manifest => manifest.id), ['cangxuan', 'worldbook']);
  assert.deepEqual(enabledPlugins(state({ image: { enabled: true } })).map(manifest => manifest.id), ['cangxuan', 'worldbook', 'image']);

  assert.throws(() => pluginManifest('nope'), /没有这个插件/, '配错 id 是代码错，不该静默');
});

/* ==================== 工具归属 + 关掉即消失 ==================== */

test('H1 回归闸：inTabbar:false 的页面进 allPages、但不进 availablePages', () => {
  // 存在性判定（setTab / App.vue 的兜底）必须用 allPages，顶栏才用 availablePages：
  // 否则以后的 MCP 内容页（默认不上顶栏）永远打不开。
  const hidden = { id: 'hidden', title: '隐藏页', order: 25, inTabbar: false, owner: 'someone' };
  const all = mergePages([hidden]);
  assert.equal(all.some(page => page.id === 'hidden'), true, '存在性留得住它');
  assert.equal(tabbarPages(all).some(page => page.id === 'hidden'), false, '顶栏画的时候过滤掉');
  assert.deepEqual(CORE_PAGES.map(page => page.id), ['chat', 'settings'], '阶段 2 核心页只剩 2 个');
  assert.equal(tabbarPages(all).length, CORE_PAGES.length, '顶栏过滤掉隐藏页后只剩核心页');
});

test('关掉生图：pluginTools 里没有 gen_image；重开就回来', () => {
  // 阶段 3：默认开着的插件是苍玄助手 + 世界书，所以默认能力 = 世界书 6 + 苍玄 2（portrait_prompt 按需）
  // 顺序 = manifest 声明顺序（cangxuan 在 worldbook 前）→ 苍玄的 2 个在前
  assert.deepEqual(pluginTools({}), [...CX_TOOLS_ON, ...WB_TOOLS], '生图默认关 → 不含 gen_image');
  assert.equal(pluginTools({}).indexOf(WB_META), -1, 'entry_meta 是按需工具，不进默认能力');
  assert.equal(pluginTools({}).indexOf(CX_PROMPT), -1, 'portrait_prompt 也是按需工具');
  assert.deepEqual(
    pluginAllTools({}),
    [...CX_ALL, ...WB_TOOLS, WB_META],
    '但它确实注册了（归属 / 界面里看得见）',
  );
  assert.equal(pluginTools({}).indexOf('gen_image'), -1);

  const on = { plugin_state: { image: { enabled: true } } };
  // gen_image 一直是 default_on:false（阶段 2 就是）—— 插件开着只是让它**注册**，
  // 不等于「默认进全局能力」；要发它得在预设里显式勾。
  assert.deepEqual(pluginTools(on), [...CX_TOOLS_ON, ...WB_TOOLS], 'gen_image 不属于默认能力');
  assert.equal(pluginAllTools(on).includes('gen_image'), true, '但插件开着它就注册了');
  assert.equal(pluginTools(state({ image: { enabled: false } })).indexOf('gen_image'), -1, '显式关掉也没有');
  assert.equal(pluginAllTools(state({ image: { enabled: false } })).includes('gen_image'), false, '关掉即消失');
});

test('关掉世界书：世界书页从 availablePages 消失、它的 7 个工具消失；重开就回来', () => {
  const off = state({ worldbook: { enabled: false } });

  assert.deepEqual(availablePages(off).map(page => page.id), ['chat', 'settings']);
  assert.equal(availablePages(off).some(page => page.id === 'worldbook'), false, '页面没了');
  // 苍玄助手仍开着，所以它的工具还在；世界书那 7 个一个不剩
  assert.deepEqual(pluginTools(off), CX_TOOLS_ON, '世界书默认给的 6 个没了，只剩苍玄助手的 2 个');
  assert.deepEqual(pluginAllTools(off), CX_ALL, '世界书注册的 7 个也一起没了（关掉即消失）');

  const back = state({ worldbook: { enabled: true } });
  assert.deepEqual(availablePages(back).map(page => page.id), ['chat', 'worldbook', 'settings']);
  assert.deepEqual(pluginTools(back), [...CX_TOOLS_ON, ...WB_TOOLS]);
});

test('F-A 回归闸：运行时也认插件开关（关掉的插件，工具连 def 都不进这一轮）', async () => {
  // 硬规矩 2「关掉即消失」有三层：界面清单 / 显示用 globalCaps / **运行时 toolDefs**。
  // 前两层阶段 1 验过，第三层是阶段 2 验收抓出来的（界面写「来源已停用」、模型却照样能调）。
  const { liveToolDefs } = await import(root + 'run/runner.ts');
  const defs = [{ name: 'skill' }, { name: 'wb_list' }, { name: 'entry_meta' }, { name: 'gen_image' }];

  // 默认：世界书开、生图关。按需工具 entry_meta 的 **def** 要在（能不能发由 resolveCaps 按 default_on 决定）
  assert.deepEqual(
    liveToolDefs(defs, state()).map(def => def.name),
    ['skill', 'wb_list', 'entry_meta'],
    '底座的给、世界书的给（含按需 def）、生图的先不给',
  );

  // 关掉世界书：它的工具连 def 都不进这一轮 → 模型根本看不到、也调不了
  assert.deepEqual(
    liveToolDefs(defs, state({ worldbook: { enabled: false } })).map(def => def.name),
    ['skill'],
    '关掉世界书 → wb_list 与 entry_meta 一起消失',
  );

  // 开生图：它的工具才进来
  assert.deepEqual(
    liveToolDefs(defs, state({ image: { enabled: true } })).map(def => def.name),
    ['skill', 'wb_list', 'entry_meta', 'gen_image'],
    '开生图 → gen_image 才进这一轮',
  );
});

test('F4 回归闸：界面工具清单用 pluginAllTools（按需工具也列得出来）', async () => {
  // 界面「能力 · 工具」段是改提示词 / 参数说明的唯一入口：entry_meta 这种按需工具也必须列出来。
  // 全局能力那份用 pluginTools（只含默认给的）—— 两个用途两把函数，别互相替。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/苍玄助手/App.vue', import.meta.url), 'utf8');
  assert.match(src, /new Set\(pluginAllTools\(store\.data\)\)/, '界面清单要用 pluginAllTools');
  assert.match(src, /pluginToolsOf\(store\.data\)/, '全局能力要用 pluginTools');
  assert.equal(/new Set\(pluginToolsOf\(store\.data\)\)/.test(src), false, '界面清单不许退化成 pluginTools（F4）');
});

test('F1 回归闸：默认状态下 全局能力 不许比 DEFAULT_ON_TOOLS 多', () => {
  // 世界书默认开、且它默认给的 6 个本来就在 DEFAULT_ON_TOOLS 里；
  // 所以 DEFAULT_ON_TOOLS 并 pluginTools 必须一个不多一个不少：
  // entry_meta（defaultOn:false）绝不许因为「插件开着」被抬成默认开。
  const merged = [...new Set([...DEFAULT_ON_TOOLS, ...pluginTools({})])].sort();
  assert.deepEqual(merged, [...DEFAULT_ON_TOOLS].sort(), '默认状态模型不该多拿到任何工具');
  // 阶段 3：DEFAULT_ON_TOOLS 里已经并进苍玄助手默认开的 2 个（portrait_list / portrait_meta）
  assert.equal(DEFAULT_ON_TOOLS.length, 11);
  assert.equal(pluginTools({}).length, 8, '世界书 6 + 苍玄助手 2');
  assert.equal(merged.indexOf(WB_META), -1);
  assert.equal(merged.indexOf(CX_PROMPT), -1);
});

test('toolOwnerLabel：gen_image → 生图；wb_list/entry_meta → 世界书；skill 等 → 底座', () => {
  assert.equal(toolOwner('gen_image'), 'image');
  assert.equal(toolOwnerLabel('gen_image'), '生图');
  assert.equal(toolOwnerLabel('wb_list'), '世界书');
  assert.equal(toolOwnerLabel('entry_meta'), '世界书');
  assert.equal(toolOwnerLabel('skill'), '底座');
  for (const base of ['read_skill_file', 'create_skill', 'submit', 'ask_user']) {
    assert.equal(toolOwner(base), 'base', base + ' 归底座');
    assert.equal(toolOwnerLabel(base), '底座');
  }
  assert.equal(toolOwnerLabel('mcp__whatever'), '底座', '没登记的（MCP 是运行时注册）不硬编成某个插件');
});

test('pluginStatus：未启用 > 插件自己说的（缺配置）> 已启用', () => {
  assert.deepEqual(pluginStatus(state({ image: { enabled: false } }), 'image', { api_key: 'pst-x' }), {
    label: '未启用',
    kind: '',
  });
  const on = state({ image: { enabled: true } });
  assert.deepEqual(pluginStatus(on, 'image', {}), { label: '缺 API Key', kind: 'warn' });
  assert.deepEqual(pluginStatus(on, 'image', { api_key: '   ' }), { label: '缺 API Key', kind: 'warn' });
  assert.deepEqual(pluginStatus(on, 'image', { api_key: 'pst-x', site: 'proxy', site_url: ' ' }), {
    label: '缺反代地址',
    kind: 'warn',
  });
  assert.deepEqual(pluginStatus(on, 'image', { api_key: 'pst-x', site: 'proxy', site_url: 'http://127.0.0.1:6969' }), {
    label: '已启用',
    kind: 'ok',
  });
  // 没写 status 的插件：开着就是「已启用」（开关先判，不看设置）
  assert.deepEqual(pluginStatus({}, 'cangxuan', { anything: 1 }), { label: '已启用', kind: 'ok' });
});

/* ==================== active_tab 放宽成 string ==================== */

test('active_tab：老页名兜底（records→chat，capability/skills→settings）；未知字符串保留；非字符串被拒', () => {
  // TAB_ID_ALIASES 只干一件事：把老数据里存过的页名兜到现在的页
  assert.deepEqual(TAB_ID_ALIASES, {
    skills: 'settings',
    capability: 'settings',
    records: 'chat',
    portraits: 'chat',
  });
  assert.equal(migrateTabId('records'), 'chat');
  assert.equal(migrateTabId('capability'), 'settings');
  assert.equal(migrateTabId('skills'), 'settings');
  assert.equal(migrateTabId('nope'), 'nope', '未知字符串原样返回');
  assert.equal(migrateTabId(123), 123, '非字符串原样返回，交给 schema 拒');

  // schema 层（所有读入口都过它：loadData / 逐块恢复 / importAll）
  assert.equal(RootDataSchema.parse({ active_tab: 'records' }).active_tab, 'chat');
  assert.equal(RootDataSchema.parse({ active_tab: 'capability' }).active_tab, 'settings');
  assert.equal(RootDataSchema.parse({ active_tab: 'skills' }).active_tab, 'settings');
  assert.equal(
    RootDataSchema.parse({ active_tab: 'portraits' }).active_tab,
    'chat',
    '阶段 3：portraits 不再是页面，schema 层就兜到 chat',
  );
  assert.equal(RootDataSchema.parse({ active_tab: 'nope' }).active_tab, 'nope', '未知字符串不再被清洗');
  // 非字符串仍然是坏数据
  assert.equal(RootDataSchema.safeParse({ active_tab: 123 }).success, false);
  assert.equal(RootDataSchema.safeParse({ active_tab: ['records'] }).success, false);
  assert.equal(RootDataSchema.safeParse({ active_tab: null }).success, false);
  // 整份读入口（逐块恢复）也不清洗
  const recovered = recoverRootData({ active_tab: 'nope' });
  assert.deepEqual(recovered.warnings, []);
  assert.equal(recovered.data.active_tab, 'nope');
});

test('store.setTab：页面不存在就回落到第一个可用页；关插件撤掉当前页时也自动回落', () => {
  const { store, writes } = freshStore();

  // 阶段 3：schema 缺省是 chat（苍玄助手去页面了），第一帧就停在画得出来的页上
  assert.equal(store.data.active_tab, 'chat');

  // 未知 id（老数据 / 手改）→ 第一个可用页
  store.setTab('nope');
  assert.equal(store.data.active_tab, 'chat');

  // 老页名走 TAB_ID_ALIASES 兜到它该去的页（records → 对话、capability / skills → 设置），
  // 而不是「第一个可用页」；关键是**绝不会**把 active_tab 写成画不出来的 id。
  for (const [legacy, expect] of [['records', 'chat'], ['capability', 'settings'], ['skills', 'settings']] as const) {
    store.setTab(legacy);
    assert.equal(store.data.active_tab, expect, legacy + ' 应该兜到 ' + expect);
    assert.notEqual(store.data.active_tab, legacy, '不许把画不出来的 id 写进 active_tab');
    for (const page of availablePages(store.data)) assert.notEqual(page.id, legacy);
  }

  // 当前页是插件页（世界书是阶段 3 唯一带页面的插件）→ 关掉插件即撤页，自动回落到第一个可用页
  store.setTab('worldbook');
  store.setPluginEnabled('worldbook', false);
  assert.equal(store.data.active_tab, 'chat');
  assert.deepEqual(
    availablePages(store.data).map(page => page.id),
    ['chat', 'settings'],
  );
  store.setTab('worldbook');
  assert.equal(store.data.active_tab, 'chat', '已撤掉的页再 setTab 也进不去');

  // 重开世界书：当前页停在它上面时，关掉**别的**插件不该把当前页挪走
  store.setPluginEnabled('worldbook', true);
  store.setTab('worldbook');
  store.setPluginEnabled('cangxuan', false);
  assert.equal(store.data.active_tab, 'worldbook', '关的不是当前页的插件 → 当前页不动');

  // 都重开就回到 3 格（阶段 3：苍玄助手不带页面）
  store.setPluginEnabled('cangxuan', true);
  assert.deepEqual(
    availablePages(store.data).map(page => page.id),
    ['chat', 'worldbook', 'settings'],
  );

  // 落盘：save() 是 2500ms 防抖，断言前先显式冲一次
  store.setTab('settings');
  store.save(true);
  const last = writes[writes.length - 1][GLOBAL_KEY];
  assert.equal(last.active_tab, 'settings');
  assert.deepEqual(last.plugin_state, { cangxuan: { enabled: true }, worldbook: { enabled: true } });
});

/* ==================== v4 → v5 迁移 ==================== */

/**
 * ⚠️ 这一组必须从**原始 v4 对象**进，不能先 RootDataSchema.parse：
 * v5 的 GenImageConfigSchema 没有 enabled，zod 对象默认丢掉未知键 —— 一旦先 parse，
 * 迁移就永远看不到老字段，老用户开着的生图会被静默关掉（生图 defaultEnabled=false）。
 * 修法见 core/types.ts 的 migratePluginSwitch（在 parse 之前抬开关），recoverRootData / importAll 都过它。
 */
test('v4 → v5 迁移（真实读路径 recoverRootData）：老 plugins.image.enabled 抬进 plugin_state，插件设置里不再有 enabled', () => {
  const once = recoverRootData({ version: 4, plugins: { image: { enabled: true, api_key: 'pst-x', max_count: 2 } } });

  assert.equal(once.data.version, DATA_VERSION);
  assert.equal(DATA_VERSION, 5);
  assert.deepEqual(once.data.plugin_state, { image: { enabled: true } }, '老开关照搬，别的插件留给 manifest 缺省');
  assert.equal('enabled' in once.data.plugins.image, false, '搬家后插件设置里不该再有 enabled');
  assert.equal(once.data.plugins.image.api_key, 'pst-x', '插件自己的设置一个字不丢');
  assert.equal(once.data.plugins.image.max_count, 2);
  assert.equal(pluginEnabled(once.data, 'image'), true, '老用户开着的还是开着（defaultEnabled=false 不能赢）');

  // 幂等：对结果再跑一次，开关与设置全等（不翻盘、不再搬一次）
  const twice = recoverRootData(once.data);
  assert.deepEqual(twice.data.plugin_state, once.data.plugin_state);
  assert.deepEqual(twice.data.plugins.image, once.data.plugins.image);
  assert.deepEqual(twice.warnings, []);
});

test('v4 → v5 迁移：importAll（导入老导出文件）走同一条搬家；enabled=false 照搬成 false', () => {
  const imported = importAll(
    JSON.stringify({ version: 4, plugins: { image: { enabled: true, api_key: 'pst-x', max_count: 2 } } }),
  );
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.data.version, DATA_VERSION);
  assert.deepEqual(imported.data.plugin_state, { image: { enabled: true } });
  assert.equal('enabled' in imported.data.plugins.image, false);
  assert.equal(imported.data.plugins.image.max_count, 2);

  // 老数据本来是关着的也照搬成 false（不能被 manifest 缺省抬起来）
  const off = recoverRootData({ version: 4, plugins: { image: { enabled: false, api_key: 'k' } } });
  assert.deepEqual(off.data.plugin_state, { image: { enabled: false } });
  assert.equal(pluginEnabled(off.data, 'image'), false);
});

test('v4 → v5 迁移：v5 数据里混进老的 plugins.image.enabled —— plugin_state 说了算，多余的键丢掉', () => {
  const mixed = recoverRootData({
    version: 5,
    plugins: { image: { enabled: true, api_key: 'k' } },
    plugin_state: { image: { enabled: false } },
  });
  assert.deepEqual(mixed.data.plugin_state, { image: { enabled: false } }, '搬过的以 plugin_state 为准，不许被老字段翻盘');
  assert.equal('enabled' in mixed.data.plugins.image, false, '混进来的老键要被丢掉');
  assert.equal(pluginEnabled(mixed.data, 'image'), false);
  assert.equal(mixed.data.version, DATA_VERSION);
});

test('v4 → v5 迁移：没有 plugins 块 / 块是坏值也不炸（plugin_state 为空，开关按 manifest 缺省）', () => {
  for (const raw of [{ version: 5 }, { version: 4 }, { version: 5, plugins: '不是对象' }]) {
    const result = recoverRootData(raw);
    assert.deepEqual(result.data.plugin_state, {}, JSON.stringify(raw));
    assert.equal(pluginEnabled(result.data, 'image'), false, '生图 defaultEnabled=false');
    assert.equal(pluginEnabled(result.data, 'cangxuan'), true);
  }
});

test('migrateRootData 直调：喂**手工构造的、还带老字段的原始对象**也能搬（migratePluginSwitch 之外的第二道保险）', () => {
  // ⚠️ 前提：这个用例故意**绕过 RootDataSchema.parse**，直接喂原始对象 ——
  //    经过 parse 的对象里 enabled 已经被 zod 丢掉了，直调就测不到东西。
  const base = defaultRootData();
  const raw = {
    ...base,
    version: 4,
    plugins: { ...base.plugins, image: { enabled: true, api_key: 'pst-old', steps: 33 } },
  };

  const once = migrateRootData(raw);
  assert.equal(once.migrated, true);
  assert.equal(once.data.version, DATA_VERSION);
  assert.deepEqual(once.data.plugin_state, { image: { enabled: true } });
  assert.equal('enabled' in once.data.plugins.image, false);
  assert.equal(once.data.plugins.image.api_key, 'pst-old');
  assert.equal(once.data.plugins.image.steps, 33);

  // 幂等：再跑一次结果完全一致、migrated=false
  const twice = migrateRootData(once.data);
  assert.deepEqual(twice.data, once.data);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.warnings, []);
});

/* ==================== 开关与设置的两个写点 ==================== */

test('store：setPluginConfig 忽略 enabled 键（开关只在 setPluginEnabled）；resetPluginConfig 只清设置不动开关', () => {
  const { store, writes } = freshStore();

  // 缺省取 manifest.defaultEnabled
  assert.equal(store.pluginEnabled('image'), false);
  assert.equal(store.pluginEnabled('cangxuan'), true);

  store.setPluginEnabled('image', true);
  assert.equal(store.pluginEnabled('image'), true);
  // gen_image 是 default_on:false，所以它在**注册表**里（pluginAllTools）但不在默认能力里
  assert.equal(pluginAllTools(store.data).includes('gen_image'), true, '生图开着 → 注册了');
  assert.equal(pluginTools(store.data).includes('gen_image'), false, '但它默认关，不进全局能力');

  // 设置里塞 enabled：必须被忽略，开关不能被第二个写点分叉
  store.setPluginConfig('image', { api_key: 'pst-abc', steps: 33, enabled: false });
  assert.equal(store.pluginEnabled('image'), true, 'setPluginConfig 不许改开关');
  assert.equal('enabled' in store.data.plugins.image, false, '插件设置里永远不出现 enabled');
  assert.equal(store.data.plugins.image.api_key, 'pst-abc');
  assert.equal(store.data.plugins.image.steps, 33);

  // 显式 undefined 不当成「改成 undefined」
  store.setPluginConfig('image', { api_key: undefined });
  assert.equal(store.data.plugins.image.api_key, 'pst-abc');

  // 回默认：只清设置
  store.resetPluginConfig('image');
  assert.equal(store.pluginEnabled('image'), true, 'resetPluginConfig 不动开关');
  assert.equal(store.data.plugins.image.api_key, '');
  assert.equal(store.data.plugins.image.steps, 28);
  assert.equal('enabled' in store.data.plugins.image, false);

  store.save(true);
  const last = writes[writes.length - 1][GLOBAL_KEY];
  assert.equal(last.plugins.image.api_key, '');
  assert.equal(last.plugins.image.steps, 28);
  assert.equal('enabled' in last.plugins.image, false);
  assert.deepEqual(last.plugin_state, { image: { enabled: true } });
});

/* ==================== 阶段 2 结构（源码级防回归） ==================== */

test('源码级：App.vue 的页面分支只剩 worldbook / chat（设置走 v-else），没有 portraits / capability / records', () => {
  const app = codeOnly(readFileSync('src/苍玄助手/App.vue', 'utf8'));
  const branchIds = [...app.matchAll(/v-(?:if|else-if)="tab === '([^']+)'"/g)].map(match => match[1]);
  // 阶段 3：苍玄助手去页面 → 插件页只剩 worldbook，加核心页 chat。
  // ⚠️ 错误边界那个 v-if="pageError" 不带 tab === 判定，所以不会混进来。
  assert.deepEqual(branchIds, ['worldbook', 'chat'], '页面分支 = 1 个插件页 + 1 个核心页');
  assert.equal(branchIds.includes('portraits'), false, '阶段 3：苍玄助手不再是页面');
  assert.equal(branchIds.includes('capability'), false, '能力不再是页面');
  assert.equal(branchIds.includes('records'), false, '记录不再是页面');
  assert.match(app, /<SettingsView[\s\S]*?v-else/, '设置是兜底分支');
  // 跨页跳转统一走 goto(pageId) → store.setTab；阶段 1 的 goto-capability 一次性事件删了
  assert.equal(app.includes('goto-capability'), false, 'goto-capability 应该已经删掉');
  assert.ok(app.includes('function goto('), '跨页跳转统一走 goto(pageId)');
  assert.ok(app.includes('store.setTab(id)'), 'goto 落回 setTab（存在性校验在 store）');
  // 阶段 1 那条 watch 整个 store.data 的 deep watcher 也没了（页面写点各自 emit change）
  assert.equal(/\bdeep\s*:\s*true\b/.test(app), false, '不该再有 deep: true 的 watcher');
});

test('源码级：设置里四格（接口/预设/能力/数据）＋「能力」里三段（工具/技能/插件）', () => {
  const segLabels = (text, name) => {
    const block = new RegExp('const ' + name + ': SegItem\\[\\] = \\[([\\s\\S]*?)\\];').exec(text);
    assert.ok(block, '没找到 ' + name);
    return [...block[1].matchAll(/label: '([^']+)'/g)].map(match => match[1]);
  };

  const settings = readFileSync('src/苍玄助手/views/SettingsView.vue', 'utf8');
  assert.deepEqual(segLabels(settings, 'SET_SEG_ITEMS'), ['接口', '预设', '能力', '数据'], '设置外层四格');
  // 能力整段塞在设置里（CapabilityView），不再是顶栏的一页
  assert.match(settings, /v-else-if="seg === 'capability'"/);
  assert.match(settings, /<CapabilityView[\s\S]*?@change="touch"/, 'CapabilityView 的写点转成设置页的 change');

  const capability = readFileSync('src/苍玄助手/views/CapabilityView.vue', 'utf8');
  assert.deepEqual(segLabels(capability, 'SEG_ITEMS'), ['工具', '技能', '插件'], '能力内三段');
});

test('源码级：记录不占页面 —— 对话页右上角 ⋯ 打开一张「记录」Sheet', () => {
  const chat = readFileSync('src/苍玄助手/views/ChatView.vue', 'utf8');
  assert.match(chat, /@click="recordsOpen = true"/, '⋯ 按钮打开记录');
  assert.match(chat, /<Sheet v-if="recordsOpen"/, '记录收在一张 Sheet 里');
  assert.match(chat, /title="记录"/, 'Sheet 标题 = 记录');
  assert.match(chat, /<RecordsView/, '原记录页的内容整段塞进 Sheet');

  const app = codeOnly(readFileSync('src/苍玄助手/App.vue', 'utf8'));
  assert.equal(app.includes('RecordsView'), false, 'App.vue 不再挂记录页');
});

test('源码级：来源插件关掉时「能力 · 工具」段有「来源已停用」兜底行（F2）', () => {
  const ui = readFileSync('src/苍玄助手/components/ui_types.ts', 'utf8');
  assert.match(ui, /owner_disabled\?: boolean/, 'UiTool 要有 owner_disabled');
  const capability = readFileSync('src/苍玄助手/views/CapabilityView.vue', 'utf8');
  assert.match(capability, /tool\.owner_disabled/, '工具行要读它');
  assert.match(capability, /来源已停用/, '兜底行要标「来源已停用」');
  const app = codeOnly(readFileSync('src/苍玄助手/App.vue', 'utf8'));
  assert.match(app, /owner_disabled:/, 'App.vue 给工具行打这个标');
});
