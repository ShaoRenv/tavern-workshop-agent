/**
 * P4-12：插件列表 / 详情必须反映**能力闸**的裁决（界面不再替底层撒谎）。
 *
 * 要防的回归（真机实测过）：
 *   `worldbook` 的 requires 写成一个不存在的名字 → 插件被能力闸拦下（页面与工具全不出），
 *   但插件列表页那行**仍显示「已启用」** —— 因为界面用的是不看能力的 `pluginStatus`。
 *   用户看到「已启用」而插件根本没在工作，正是本项目一路在消除的「假状态」。
 *
 * 本文件钉两件事：
 *  1. **界面与装载裁决同源**：列表行显示「缺能力」时，`loadablePlugins` 里**必然没有**它；
 *     反过来 `loadablePlugins` 里有它时，列表行**不许**显示「缺能力」。
 *     这条比「状态文案对不对」重要得多 —— 它保证界面**不可能**和实际装载脱节。
 *  2. 反例自检：能力齐全 → 「已启用」；缺必需能力 → 「缺能力」；两个方向都要真跑一遍。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = '../../src/苍玄助手/';
const { PLUGIN_MANIFESTS, pluginStatus, pluginStatusWithCapabilities, pluginCapabilitySkips, loadablePlugins } =
  await import(root + 'plugins/registry.ts');
const { installCapabilityGateHost } = await import('./_helpers.ts');

/** 注册表函数只依赖 plugin_state 那一小块 */
function state(plugin_state = {}) {
  return { plugin_state };
}

/** 剥掉注释：注释里提到某个函数不算「用了它」，只看真正会跑的代码 */
function codeOnly(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** 取一个内置插件（worldbook 有 7 个工具 + 一个页面，最适合当样本） */
const WORLD = PLUGIN_MANIFESTS.find(item => item.id === 'worldbook');

/* ==================== 1. 反例自检：两个方向都要真跑 ==================== */

test('反例自检 ①：能力**齐全**时，worldbook 必须是「已启用」——不许误报缺能力', (t) => {
  // 宿主在位 + 能力全可用：这正是真机上「什么都没缺」的那台机器
  t.after(installCapabilityGateHost());

  const status = pluginStatusWithCapabilities(state(), 'worldbook', {});
  assert.equal(status.label, '已启用', '能力齐全时必须是已启用，不能因为探测就把好插件说成缺能力');
  assert.deepEqual(pluginCapabilitySkips(state()), [], '能力齐全不该有任何 skip');
  assert.ok(
    loadablePlugins(state()).some(item => item.id === 'worldbook'),
    '而且它确实在装载列表里 —— 状态与装载必须一致',
  );
});

test('反例自检 ②：缺**必需**能力时，worldbook 必须是「缺能力」——不许再报已启用', (t) => {
  // 这就是真机实验造出来的场景：requires 里有一条这个环境给不了
  t.after(installCapabilityGateHost(name => name !== 'getWorldbook' && name !== 'replaceWorldbook'));

  const status = pluginStatusWithCapabilities(state(), 'worldbook', {});
  assert.equal(status.label, '缺能力', '被能力闸拦下时列表行必须说缺能力');
  assert.equal(status.kind, 'dang', '而且要是危急档（不是 warn）——它整个插件都没工作');

  const skips = pluginCapabilitySkips(state());
  const skip = skips.find(item => item.id === 'worldbook');
  assert.ok(skip, 'skip 记录要在（界面的人话原因就从它来）');
  assert.ok(skip.reason.length > 0, 'reason 不能空 —— 界面要直接显示它');
  assert.ok(!loadablePlugins(state()).some(item => item.id === 'worldbook'), '它确实没被装载');
});

test('★界面与装载裁决同源：列表说「缺能力」⇔ loadablePlugins 里没有它（不许脱节）', (t) => {
  // 这条是本任务的**核心契约**：状态标签不许和实际装载各说各话。
  // 逐个插件、两种环境各跑一遍，断言两边永远一致。
  const check = (label) => {
    const loadable = new Set(loadablePlugins(state()).map(item => item.id));
    for (const def of PLUGIN_MANIFESTS) {
      const status = pluginStatusWithCapabilities(state(), def.id, {});
      const saysMissing = status.label === '缺能力';
      const isBlocked = !loadable.has(def.id) && def.defaultEnabled;
      assert.equal(
        saysMissing,
        isBlocked,
        label + '：' + def.id + ' 状态说「' + status.label + '」但装载情况是 ' + (isBlocked ? '被拦' : '已装载') + ' —— 界面与装载脱节了',
      );
    }
  };

  // ① 能力齐全
  const restoreOk = installCapabilityGateHost();
  try {
    check('能力齐全');
  } finally {
    restoreOk();
  }

  // ② 缺 getWorldbook（worldbook 会被拦）
  const restoreGated = installCapabilityGateHost(name => name !== 'getWorldbook' && name !== 'replaceWorldbook');
  try {
    check('缺 getWorldbook');
    assert.equal(pluginStatusWithCapabilities(state(), 'worldbook', {}).label, '缺能力');
  } finally {
    restoreGated();
  }
});/* ==================== 2. 源码级：界面确实用了「带能力」的那条路 ==================== */

/**
 * 为什么要有源码级断言（而不是只测注册表函数）：
 * 上面那些用例证明的是**注册表算得对**；但 P4-12 的 bug 恰恰是
 * 「算得对的那个函数没人用」。函数再对，界面调的是另一个，bug 照样在。
 * 所以必须钉住**界面调用了哪一个**。
 */

const pluginsView = codeOnly(readFileSync('src/苍玄助手/views/PluginsView.vue', 'utf8'));
const detailView = codeOnly(readFileSync('src/苍玄助手/components/PluginDetail.vue', 'utf8'));

test('源码级：PluginsView 用的是 pluginStatusWithCapabilities，不是不看能力的 pluginStatus', () => {
  assert.match(pluginsView, /pluginStatusWithCapabilities\s*\(/, '列表必须走带能力的那个');
  // ⚠️ 关键反例：不许**又**出现裸的 pluginStatus( 调用
  const bareCalls = [...pluginsView.matchAll(/(?<![\w.])pluginStatus\s*\(/g)];
  assert.equal(
    bareCalls.length,
    0,
    '不许再调裸的 pluginStatus() —— 它不看能力，正是 P4-12 那个「假已启用」的来源',
  );
});

test('源码级：PluginsView 把「缺能力」的原因取出来了（pluginCapabilitySkips）', () => {
  assert.match(pluginsView, /pluginCapabilitySkips\s*\(/, '要取 skip 记录才能在行上给人话原因');
});

test('源码级：探能力**只算一次**（computed），不是每行现算 —— O(N²) 防线', () => {
  // 为什么钉这条：pluginStatusWithCapabilities 会遍历全部已启用插件、逐个现探能力。
  // 模板里 statusOf(def) 是**每行调一次**，若每次都重新探 = O(N²)。
  // 实测（4 插件）：不带能力 0.001ms/次 vs 带能力 0.216ms/次（约 200 倍）。
  // 现在插件少、绝对值可忽略，但形状是 O(N²)：插件变多或探测变重就会卡。
  assert.match(pluginsView, /new Map\(\s*pluginCapabilitySkips/, 'skip 结果要按 id 建表，供 O(1) 查');
});

test('源码级：PluginDetail 收得到「缺能力」的原因（skip prop）', () => {
  assert.match(detailView, /skip\??:/, '详情页要有 skip 这个 prop');
  assert.match(detailView, /skip\.reason|skip\.detail/, '详情页要把原因画出来，不是收下就算了');
});

test('源码级：两个界面都不许自己算「缺什么」——判据只能来自注册表', () => {
  // 界面自己拼原因 = 迟早和装载裁决漂移。原因必须来自 registry 的 reason/detail。
  const pairs = [
    { name: 'PluginsView.vue', text: pluginsView },
    { name: 'PluginDetail.vue', text: detailView },
  ];
  for (const item of pairs) {
    assert.ok(
      !/evaluatePluginCapabilities|CAPABILITIES\s*\.\s*(find|filter|some|map)/.test(item.text),
      item.name + ' 不该自己判能力 —— 判据只能来自 plugins/registry.ts',
    );
  }
});

/* ==================== 3. 优先级口径：缺能力排在正确的档位 ==================== */

test('优先级：未启用 > 缺能力 > 插件自己说的（缺配置）> 已启用', (t) => {
  t.after(installCapabilityGateHost(name => name !== 'getWorldbook' && name !== 'replaceWorldbook'));
  const off = state({ worldbook: { enabled: false } });
  const on = state();

  // ① 未启用最优先：即使缺能力，关着的插件只说「未启用」
  assert.deepEqual(
    pluginStatusWithCapabilities(off, 'worldbook', {}),
    { label: '未启用', kind: '' },
    '关着的插件优先说未启用（用户关的，比他能不能跑更重要）',
  );

  // ② 开着 + 缺能力 → 缺能力（而不是「已启用」）
  assert.equal(pluginStatusWithCapabilities(on, 'worldbook', {}).label, '缺能力');

  // ③ 对照：不带能力的旧口径在这台机器上会说什么（证明这个差别是真实存在的）
  assert.equal(
    pluginStatus(on, 'worldbook', {}).label,
    '已启用',
    '旧口径确实会说「已启用」—— 这正是 P4-12 要修的那个假状态',
  );
});

test('优先级：不声明 requires 的插件不受影响（能力闸与它无关）', (t) => {
  // image 不声明 requires（P5-5 查实的结论，见它的 manifest 注释）→ 缺什么都不该拦它
  t.after(installCapabilityGateHost(() => false)); // 极端：什么都探不到
  const image = pluginStatusWithCapabilities(state({ image: { enabled: true } }), 'image', { api_key: 'x' });
  assert.equal(image.label, '已启用', '没有 requires 的插件不该被能力闸影响');
});
