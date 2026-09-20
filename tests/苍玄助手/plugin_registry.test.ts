/**
 * 阶段 1-C：插件注册表 + 页面注册表 + plugin_state（v5）的契约测试。
 *
 * 要防的回归（reports/苍玄助手-底座化实施计划.md §3、reports/苍玄助手-设计自查.md A9）：
 *  - 页面集合是**运行时算的**（核心页 + 已启用插件页按 order），不再是写死的 TAB_IDS；
 *  - 插件开关只住在 plugin_state，缺省取 manifest.defaultEnabled；
 *  - 关掉插件 → 它的页面从顶栏消失、它的工具不给模型（「活的贡献」关掉即消失）；
 *  - active_tab 只是一个 id：未知字符串不再是坏数据，「画不出来」由 availablePages + store.setTab 兜底。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { DATA_VERSION, RootDataSchema } = await import(root + 'core/types.ts');
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

/** 世界书注册了 7 个工具，但默认给 6 个（entry_meta 是按需的） */
const WB_TOOLS = ['wb_list', 'wb_search', 'wb_read', 'entry_create', 'entry_edit', 'entry_delete'];
const WB_META = 'entry_meta';

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

test('页面注册表：availablePages(store.data) 的顺序与标题 = 现在的 6 格（老顺序逐格不变）', () => {
  assert.deepEqual(
    availablePages({}).map(page => [page.id, page.title, page.order, page.inTabbar, page.owner]),
    [
      ['portraits', '立绘', 10, true, 'cangxuan'],
      ['worldbook', '世界书', 20, true, 'worldbook'],
      ['chat', '对话', 30, true, 'base'],
      ['capability', '能力', 40, true, 'base'],
      ['records', '记录', 50, true, 'base'],
      ['settings', '设置', 90, true, 'base'],
    ],
  );

  // 核心页还是这 4 个（阶段 1 不动界面：records / capability 第 2 阶段才并走）
  assert.deepEqual(
    CORE_PAGES.map(page => page.id),
    ['chat', 'capability', 'records', 'settings'],
  );

  // 生图插件只有工具、没有页面
  assert.equal(PLUGIN_MANIFESTS.find(manifest => manifest.id === 'image').contributes.pages, undefined);
  assert.deepEqual(pluginPages({}).map(page => page.id), ['portraits', 'worldbook'], '插件页只来自开着的插件');
  assert.deepEqual(allPages({}).map(page => page.id), availablePages({}).map(page => page.id));
});

test('页面注册表：mergePages 按 order 升序、同 order 按 id；tabbarPages 过滤 inTabbar:false', () => {
  const merged = mergePages([
    { id: 'zzz-late', title: 'Z', order: 25, inTabbar: true, owner: 'x' },
    { id: 'portraits', title: '立绘', order: 10, inTabbar: true, owner: 'cangxuan' },
  ]);
  // 只在传入的那两张插件页 + 4 张核心页之间排序（order 25 落在世界书 20 与对话 30 之间）
  assert.deepEqual(merged.map(page => page.id), ['portraits', 'zzz-late', 'chat', 'capability', 'records', 'settings']);

  const pages = allPages({});
  assert.equal(findPage(pages, 'records').title, '记录');
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
  assert.equal(tabbarPages(all).length, CORE_PAGES.length, '顶栏只剩 4 个核心页（隐藏页被过滤掉）');
});

test('关掉生图：pluginTools 里没有 gen_image；重开就回来', () => {
  assert.deepEqual(pluginTools({}), WB_TOOLS, '生图默认关 → 只有世界书那 6 个默认给的');
  assert.equal(pluginTools({}).indexOf(WB_META), -1, 'entry_meta 是按需工具，不进默认能力');
  assert.deepEqual(pluginAllTools({}), [...WB_TOOLS, WB_META], '但它确实注册了（归属 / 界面里看得见）');
  assert.equal(pluginTools({}).indexOf('gen_image'), -1);

  const on = { plugin_state: { image: { enabled: true } } };
  assert.deepEqual(pluginTools(on), [...WB_TOOLS, 'gen_image']);
  assert.equal(pluginTools(state({ image: { enabled: false } })).indexOf('gen_image'), -1, '显式关掉也没有');
});

test('关掉世界书：世界书页从 availablePages 消失、它的 7 个工具消失；重开就回来', () => {
  const off = state({ worldbook: { enabled: false } });

  assert.deepEqual(availablePages(off).map(page => page.id), ['portraits', 'chat', 'capability', 'records', 'settings']);
  assert.equal(availablePages(off).some(page => page.id === 'worldbook'), false, '页面没了');
  assert.deepEqual(pluginTools(off), [], '默认给的 6 个没了，苍玄助手本身不带工具');
  assert.deepEqual(pluginAllTools(off), [], '注册的 7 个也一起没了（关掉即消失）');

  const back = state({ worldbook: { enabled: true } });
  assert.deepEqual(availablePages(back).map(page => page.id), ['portraits', 'worldbook', 'chat', 'capability', 'records', 'settings']);
  assert.deepEqual(pluginTools(back), WB_TOOLS);
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
  assert.equal(DEFAULT_ON_TOOLS.length, 9);
  assert.equal(pluginTools({}).length, 6);
  assert.equal(merged.indexOf(WB_META), -1);
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

test('active_tab：未知字符串是合法数据（schema 不清洗），非字符串才被拒', () => {
  // 老数据里合法但页面可能不存在 / 已改名的 id：schema 一律原样保留，兜底交给界面
  assert.equal(RootDataSchema.parse({ active_tab: 'records' }).active_tab, 'records');
  assert.equal(RootDataSchema.parse({ active_tab: 'portraits' }).active_tab, 'portraits');
  assert.equal(RootDataSchema.parse({ active_tab: 'nope' }).active_tab, 'nope', '未知字符串不再被清洗');
  // skills → capability 的老名字兜底仍然在（migrateTabId）
  assert.equal(RootDataSchema.parse({ active_tab: 'skills' }).active_tab, 'capability');
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

  assert.equal(store.data.active_tab, 'portraits', '默认页就是第一个可用页');

  // 未知 id（老数据 / 手改）→ 第一个可用页
  store.setTab('nope');
  assert.equal(store.data.active_tab, 'portraits');
  // 页面真的存在就原样保留（records 是核心页，永远在）
  store.setTab('records');
  assert.equal(store.data.active_tab, 'records');

  // 当前页是插件页 → 关掉插件即撤页，并自动回落到第一个可用页
  store.setTab('portraits');
  store.setPluginEnabled('cangxuan', false);
  assert.equal(store.data.active_tab, 'worldbook');
  assert.deepEqual(
    availablePages(store.data).map(page => page.id),
    ['worldbook', 'chat', 'capability', 'records', 'settings'],
  );
  store.setTab('portraits');
  assert.equal(store.data.active_tab, 'worldbook', '已撤掉的页再 setTab 也进不去');

  // 关的不是当前页的插件：当前页不动
  store.setTab('chat');
  store.setPluginEnabled('worldbook', false);
  assert.equal(store.data.active_tab, 'chat');

  // 重开就回来
  store.setPluginEnabled('cangxuan', true);
  store.setPluginEnabled('worldbook', true);
  assert.deepEqual(
    availablePages(store.data).map(page => page.id),
    ['portraits', 'worldbook', 'chat', 'capability', 'records', 'settings'],
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
  assert.equal(pluginTools(store.data).indexOf('gen_image'), WB_TOOLS.length);

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
