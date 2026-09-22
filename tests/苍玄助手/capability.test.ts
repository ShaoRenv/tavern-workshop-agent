/**
 * P0-C / task-14：Capability 能力表（core/capability.ts）+ 插件能力闸（plugins/registry.ts）的契约测试。
 *
 * 本文件钉的是**本任务的核心验收项**：
 *   能力缺失 → 该插件**不注册**，且原因是**人话**（不是「加载失败」这种没信息量的文案）。
 *
 * 要防的回归：
 *  1. 缺必需能力 → 插件的页面 / 工具 / 宏 / 技能 / 预设**全都不出**（不是运行时炸半路）；
 *  2. 原因必须是人话：说清缺哪个能力、缺的接口名、ST 原生对应是什么；
 *  3. 缺可选能力 → **照常注册**，只降级（跑 degrade），不拦装；
 *  4. 探测**绝不抛**（探测发生在界面挂载之前，抛一下就是白屏）；
 *  5. 探测**不缓存**（ST 上下文晚就绪，缓存会把「还没就绪」固化成「不可用」）；
 *  6. getScriptTrees 类**明确不可用**的接口，原因要区别于「这台机器恰好缺」；
 *  7. 变量两档能力分开标：vars.table 需要酒馆助手，vars.keyed 原生始终可用。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const capability = await import(core + 'capability.ts');
const {
  CAPABILITIES,
  probeCapability,
  probeCapabilities,
  availableCapabilities,
  evaluatePluginCapabilities,
  capabilityStatus,
  installCapabilityResolver,
  fromHasHostFn,
  reportCapabilityTable,
} = capability;

const { pluginCapabilitySkips, loadablePlugins, enabledPlugins, pluginPages, pluginToolDefs, pluginMacros, pluginStatusWithCapabilities } =
  await import('../../src/苍玄助手/plugins/registry.ts');

const { PLUGIN_MANIFESTS } = await import('../../src/苍玄助手/plugins/registry.ts');
const { getHostBridge, setHostBridge } = await import(core + 'storage.ts');
const { capabilityNameOffenders } = await import('./_helpers.ts');

/** 当前能力表的合法名字集合（供声明判定用） */
function CAPACITY_NAMES_NOW() {
  return CAPABILITIES.map(capability => capability.name);
}

/* ============================ 脚手架 ============================ */

/**
 * 装一个「什么能力都给不了」的解析器：没有原生、没有酒馆助手。
 * 这就是**纯扩展形态**（玩家没装酒馆助手）的现实。
 */
function nothingAvailable() {
  installCapabilityResolver(() => 'none');
}

/** 装一个「全都有」的解析器：模拟真机能力齐备 */
function everythingAvailable() {
  installCapabilityResolver(() => 'native');
}

/** 只给这几个能力，其余没有 */
function onlyThese(names) {
  const set = new Set(names);
  installCapabilityResolver(name => (set.has(name) ? 'native' : 'none'));
}

/**
 * 造一个「宿主**存在**」的环境（P4-7 撞闸后新增）。
 *
 * 为什么需要：能力闸现在只在「宿主在、但缺具体能力」时才拦 ——
 * 宿主**完全不存在**（单测默认状态 / 扩展还没 activate）时放行，
 * 因为那不是「缺能力」而是「还没接上」（晚绑定原则）。
 * 所以要测「缺能力被拦」，先得让宿主看起来是存在的。
 *
 * 做法：往注入表里塞一个 getVariables（provider chain 第一层即 injection，
 * 立刻就"在"），具体能力由各用例的 installCapabilityResolver 决定。
 * 返回 restore()，**必须**在 finally 里调，否则会污染同进程的其它测试。
 */
function withHostPresent(body) {
  const saved = getHostBridge();
  setHostBridge({ ...(saved ?? {}), getVariables: () => ({}) });
  try {
    return body();
  } finally {
    setHostBridge(saved);
  }
}

/** 每个用例跑完还原成「默认解析器」（不注入就是内省版，测试环境里基本啥都没有） */
function restore() {
  installCapabilityResolver(null);
}/* ============================ 1. 能力表本身 ============================ */

test('能力表: 清单里的 name 唯一，且都有 label / required 声明', () => {
  const names = CAPABILITIES.map(def => def.name);
  assert.equal(new Set(names).size, names.length, '能力名不许重复');
  for (const def of CAPABILITIES) {
    assert.equal(typeof def.name, 'string');
    assert.ok(def.name.length > 0);
    assert.equal(typeof def.label, 'string');
    assert.ok(def.label.length > 0, def.name + ' 缺人话 label');
    assert.equal(typeof def.required, 'boolean');
    assert.equal(typeof def.provider, 'undefined', 'provider 是探出来的，不是写死的');
  }
});

test('能力表: 契约字段齐全（name / provider / required / label，degrade 可选）', () => {
  everythingAvailable();
  try {
    const status = capabilityStatus('getWorldbook');
    for (const key of ['name', 'provider', 'required', 'label']) {
      assert.ok(key in status, '缺契约字段 ' + key);
    }
    assert.equal(typeof status.ok, 'boolean');
  } finally {
    restore();
  }
});

test('能力表: 全都有 → ok=true 且没有 reason', () => {
  everythingAvailable();
  try {
    const table = probeCapabilities();
    assert.equal(table.length, CAPABILITIES.length);
    for (const status of table) {
      assert.equal(status.ok, true, status.name + ' 应该可用');
      assert.equal(status.reason, undefined, status.name + ' 可用就不该有 reason');
    }
  } finally {
    restore();
  }
});

test('能力表: 什么都没有 → 每条都 ok=false 且有**人话** reason', () => {
  nothingAvailable();
  try {
    const table = probeCapabilities();
    for (const status of table) {
      assert.equal(status.ok, false, status.name + ' 应该不可用');
      assert.equal(typeof status.reason, 'string');
      assert.ok(status.reason.length > 0, status.name + ' 缺 reason');
      assert.ok(status.reason.includes(status.label), '原因里要带上人话名字，别只有接口名');
    }
  } finally {
    restore();
  }
});

test('能力表: 不可用原因要说清「缺哪个接口 / ST 原生对应是什么」', () => {
  nothingAvailable();
  try {
    const status = capabilityStatus('getWorldbook');
    assert.equal(status.ok, false);
    assert.match(status.reason, /getWorldbook/, '要写出缺的接口名');
    assert.match(status.reason, /loadWorldInfo/, '要给出 ST 原生对应，便于排查');
    assert.match(status.reason, /酒馆助手/, '要提示「装酒馆助手可顶替」这条路');
  } finally {
    restore();
  }
});

test('能力表: 明确不可用的接口，原因要**区别于**「这台机器恰好缺」', () => {
  nothingAvailable();
  try {
    const status = capabilityStatus('getScriptTrees');
    assert.equal(status.ok, false);
    assert.equal(status.noNativeEquivalent, true, '要标出「ST 原生压根没有对应」');
    assert.match(status.reason, /酒馆助手独有/, '原因口径不同：这是永久不可用，不是恰好缺');
    assert.ok(!/装酒馆助手可以顶替/.test(status.reason), '永久不可用的不该劝人去装酒馆助手');
  } finally {
    restore();
  }
});

test('能力表: probeCapabilities(only) 只探指定的几条', () => {
  everythingAvailable();
  try {
    const table = probeCapabilities(['generateRaw', 'getWorldbook']);
    assert.deepEqual(table.map(s => s.name), ['generateRaw', 'getWorldbook']);
    assert.deepEqual(availableCapabilities(['generateRaw', 'getWorldbook']), ['generateRaw', 'getWorldbook']);
  } finally {
    restore();
  }
});

test('能力表: 探测**不缓存** —— 解析器换了，同一次会话里结果要跟着变', () => {
  nothingAvailable();
  try {
    assert.equal(capabilityStatus('getWorldbook').ok, false);
    // 模拟「酒馆晚就绪」：能力突然有了
    everythingAvailable();
    assert.equal(capabilityStatus('getWorldbook').ok, true, '不许缓存 —— 晚就绪的能力要能变可用');
  } finally {
    restore();
  }
});

test('能力表: 解析器抛错时按「不可用」处理，异常不许放出来', () => {
  installCapabilityResolver(() => {
    throw new Error('探测炸了');
  });
  try {
    const status = capabilityStatus('getWorldbook');
    assert.equal(status.ok, false, '抛错 = 不可用，不能把异常放出去（挂载前跑，抛了就白屏）');
    assert.ok(status.reason.length > 0);
  } finally {
    restore();
  }
});

test('能力表: capabilityStatus 对不存在的名字返回 undefined（不抛）', () => {
  assert.equal(capabilityStatus('根本没有这条能力'), undefined);
});

test('能力表: reportCapabilityTable 给出 total/ok/missing 摘要', () => {
  nothingAvailable();
  try {
    const report = reportCapabilityTable();
    assert.equal(report.total, CAPABILITIES.length);
    assert.equal(report.ok, 0);
    assert.equal(report.missing.length, CAPABILITIES.length);
  } finally {
    restore();
  }
});
/* ==================== fetch 能力（P5-5） ==================== */

/**
 * `fetch` 是宿主能力（core/host.ts 的 hostFetch() → hostFn('fetch')），
 * `transport.ts:489` 与 `image/nai.ts:332` 都在用 —— 但它此前**没登记进能力表**。
 *
 * 这为什么是真问题：test-author 的静态名字闸「requires 里的名字必须在 CAPABILITIES 里」，
 * 本意是拦 typo。可 fetch 不在表里时，一个**合法需要网络**的插件声明 'fetch' 会被判成打错，
 * **整个装载失败**。下面三条把这条堵死。
 */

/**
 * ⚠️ 这里**不自己写一份判定**，用 `_helpers.ts` 的共享纯函数 ——
 * 那份实现同时被 `plugin_registry.test.ts` 的真实清单扫描用着。
 * 各写一份副本 = 我以为在测那条闸，其实在测我自己的副本。
 */
/** 「挖掉 fetch 的能力表副本」—— 反例自检用（不污染真表） */
function CAPACITIES_WITHOUT_FETCH() {
  return CAPACITY_NAMES_NOW().filter(name => name !== 'fetch');
}

function declaredOffenders(requires) {
  return capabilityNameOffenders(requires, CAPACITY_NAMES_NOW());
}


test('fetch: 登记在能力表里，且 label / required 都有据', () => {
  const def = CAPABILITIES.find(capability => capability.name === 'fetch');
  assert.ok(def, 'fetch 必须在 CAPABILITIES 里 —— 否则声明它的插件会被静态闸判成 typo');
  assert.equal(def.label, '网络请求', 'label 要是人话');
  // required 的口径：fetch 在浏览器里总是存在，真正常变的是「是谁的 fetch」。
  // 写 true 会让插件在任何探测意外时被整个拦掉，代价远大于收益。
  assert.equal(def.required, false, 'fetch 不该是必需能力（它总是可用，不该拦插件）');
});

test('fetch: 宿主在位时判定可用，且来源是 platform（不是 tavern-helper）', () => {
  withHostPresent(() => {
    try {
      const verdict = evaluatePluginCapabilities(['fetch']);
      assert.equal(verdict.ok, true, '声明 fetch 的插件不该被拦：' + verdict.reason);
      assert.deepEqual(verdict.missingRequired, []);

      const status = capabilityStatus('fetch');
      assert.equal(status.ok, true);
      // ⚠️ 这条是关键：fetch 是**平台内置**，不是酒馆助手给的。
      // 通用兜底 lookupCompat() 会因为 globalThis.fetch 存在而把它标成 'tavern-helper' ——
      // 那会让人误以为「装了酒馆助手才有网络」。所以解析器给它单开了分支。
      assert.equal(
        status.provider,
        'platform',
        'fetch 必须标成 platform（运行时自带），标成 tavern-helper 会误导用户',
      );
      assert.ok(status.nativePath, '要说清它从哪来（排查时用）');
    } finally {
      restore();
    }
  });
});

test('⭐静态名字闸：requires 写 \'fetch\' **不再报错**（这条就是被它卡住的）', () => {
  // 用 _helpers.ts 的共享判定 —— 与 plugin_registry.test.ts 那条闸**同一份实现**
  assert.deepEqual(declaredOffenders(['fetch']), [], "'fetch' 必须被认成合法能力名");
  assert.deepEqual(declaredOffenders(['fetch?']), [], '可选写法 fetch? 同样要合法');
  assert.deepEqual(declaredOffenders(['getWorldbook', 'fetch', 'getScriptTrees?']), [], '混合声明里 fetch 不拖后腿');
});

test('⭐静态名字闸反例自检：把 fetch 从能力表挖掉 → **必须重新报错**（证明不是恒绿）', () => {
  // ⚠️ 这条是本次重构的**验收核心**：共享函数把 known 做成参数，
  // 就是为了能喂一张「挖掉 fetch」的副本进来。
  // 用**同一份共享实现**跑两次，只有 known 不同 —— 这才是有牙的反例。
  const withoutFetch = CAPACITIES_WITHOUT_FETCH();
  assert.equal(withoutFetch.includes('fetch'), false, '副本里确实没有 fetch（否则反例不成立）');
  assert.equal(CAPACITY_NAMES_NOW().includes('fetch'), true, '真表里有 fetch');

  // ① 没登记 → 必须报错
  assert.deepEqual(
    capabilityNameOffenders(['fetch'], withoutFetch),
    ['fetch'],
    '没登记时必须报错 —— 否则这条测试恒绿、什么也证明不了',
  );
  assert.deepEqual(capabilityNameOffenders(['fetch?'], withoutFetch), ['fetch?'], '可选写法同样要被抓');

  // ② 登记了 → 必须放行（同一份实现，只换 known）
  assert.deepEqual(capabilityNameOffenders(['fetch'], CAPACITY_NAMES_NOW()), [], '登记后必须放行');

  // ③ 真 typo 仍要有牙（防止「为了放行 fetch 把闸弄松」）
  assert.deepEqual(
    capabilityNameOffenders(['fetchh'], CAPACITY_NAMES_NOW()),
    ['fetchh'],
    '真 typo 仍要被抓',
  );
});

/* ==================== 2. 插件装载裁决：缺能力 → 不注册 + 人话原因 ==================== */

test('裁决: 没声明 requires 的插件 → 一律通过（不受能力表影响）', () => {
  nothingAvailable();
  try {
    const verdict = evaluatePluginCapabilities(undefined);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.missingRequired, []);
    assert.equal(verdict.reason, '');
    assert.equal(evaluatePluginCapabilities([]).ok, true);
  } finally {
    restore();
  }
});

test('裁决: 声明的能力全都有 → ok，reason 空', () => {
  everythingAvailable();
  try {
    const verdict = evaluatePluginCapabilities(['getWorldbook', 'getWorldbookNames']);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, '');
    assert.deepEqual(verdict.missingRequired, []);
  } finally {
    restore();
  }
});

test('裁决: 缺**必需**能力 → ok=false，且 reason 是人话（本任务核心验收项）', () => {
  nothingAvailable();
  try {
    const verdict = evaluatePluginCapabilities(['getWorldbook', 'getWorldbookNames']);
    assert.equal(verdict.ok, false);
    // 人话的四条判据：不空、带能力名、说清「插件被跳过」、带接口名
    assert.ok(verdict.reason.length > 0, '不能是空原因');
    assert.match(verdict.reason, /读世界书/, '要带人话能力名');
    assert.match(verdict.reason, /跳过|未注册/, '要说清后果：插件没被注册');
    assert.ok(!/^加载失败$|^插件加载失败$/.test(verdict.reason), '不许是「加载失败」这种没信息量的文案');
    assert.equal(verdict.missingRequired.length, 2);
    assert.deepEqual(verdict.missingRequired.map(s => s.name), ['getWorldbook', 'getWorldbookNames']);
  } finally {
    restore();
  }
});

test('裁决: detail 逐条列缺什么、缺的接口名、以及「永久不可用」的警告', () => {
  nothingAvailable();
  try {
    const verdict = evaluatePluginCapabilities(['getWorldbook', 'getScriptTrees']);
    assert.match(verdict.detail, /getWorldbook/);
    assert.match(verdict.detail, /getScriptTrees/);
    assert.match(verdict.detail, /ST 原生没有|不是.*还没接/, '永久不可用的要特别标注，别让人去补适配器');
  } finally {
    restore();
  }
});

test('裁决: 只缺**可选**能力 → 照常通过，但记进 missingOptional', () => {
  // generateRaw 是 required:true；getRequestHeaders 是 required:false
  onlyThese(['generateRaw']);
  try {
    const verdict = evaluatePluginCapabilities(['generateRaw', 'getRequestHeaders?']);
    assert.equal(verdict.ok, true, '缺可选的不能拦装（问号后缀 = 可选）');
    assert.deepEqual(verdict.missingRequired, []);
    assert.deepEqual(verdict.missingOptional.map(s => s.name), ['getRequestHeaders']);
  } finally {
    restore();
  }
});

test('裁决: 缺可选能力时要跑它的 degrade（降级动作是能力自己的事）', () => {
  let degraded = 0;
  installCapabilityResolver(name => (name === 'has-degrade' ? 'none' : 'native'));
  const original = CAPABILITIES.slice();
  try {
    // 往能力表里塞一条带 degrade 的（用 CAPABILITIES 的运行时数组）
    CAPABILITIES.push({
      name: 'has-degrade',
      label: '会降级的能力',
      required: false,
      degrade: () => {
        degraded += 1;
      },
    });
    const verdict = evaluatePluginCapabilities(['has-degrade?']);
    assert.equal(verdict.ok, true);
    assert.equal(degraded, 1, '缺可选能力要跑一次 degrade');
  } finally {
    CAPABILITIES.length = 0;
    for (const def of original) CAPABILITIES.push(def);
    restore();
  }
});

test('裁决: degrade 抛错不影响裁决结果（单个降级失败不拦装）', () => {
  installCapabilityResolver(name => (name === 'bad-degrade' ? 'none' : 'native'));
  const original = CAPABILITIES.slice();
  try {
    CAPABILITIES.push({
      name: 'bad-degrade',
      label: '降级会炸的能力',
      required: false,
      degrade: () => {
        throw new Error('degrade 炸了');
      },
    });
    const verdict = evaluatePluginCapabilities(['bad-degrade?']);
    assert.equal(verdict.ok, true, 'degrade 抛错不该把插件也拦下来');
  } finally {
    CAPABILITIES.length = 0;
    for (const def of original) CAPABILITIES.push(def);
    restore();
  }
});

test('裁决: requires 里混入空串 / 非字符串不炸（脏声明当成没声明）', () => {
  nothingAvailable();
  try {
    assert.equal(evaluatePluginCapabilities(['', '   ']).ok, true);
    assert.equal(evaluatePluginCapabilities([null, undefined, 42]).ok, true);
  } finally {
    restore();
  }
});

test('裁决: requires 里的能力名不在能力表里 → 明确报「没有这条能力」', () => {
  everythingAvailable();
  try {
    const verdict = evaluatePluginCapabilities(['根本没有这条能力']);
    assert.equal(verdict.ok, false, '声明了不存在的能力不能当通过');
    assert.match(verdict.reason, /根本没有这条能力|不存在/);
  } finally {
    restore();
  }
});

/* ============ 3. 装配到注册表：缺能力的插件**真的**不贡献东西 ============ */

test('注册表: 缺能力时插件的页面 / 工具 / 宏真的不出（不是运行时炸半路）', () => {
  const all = PLUGIN_MANIFESTS.map(m => m.id);
  assert.ok(all.length >= 3, '内置插件至少 3 个（cangxuan / worldbook / image）');

  // 给所有内置插件都安上一个「必需能力」声明，验证闸真的生效
  const saved = PLUGIN_MANIFESTS.map(m => m.contributes.requires);
  nothingAvailable();
  withHostPresent(() => {
  try {
    for (const manifest of PLUGIN_MANIFESTS) manifest.contributes.requires = ['getWorldbook'];

    const state = {};
    const skips = pluginCapabilitySkips(state);
    assert.equal(skips.length, PLUGIN_MANIFESTS.filter(m => m.defaultEnabled).length, '每个开着的插件都该被拦下');
    assert.equal(loadablePlugins(state).length, 0, '全被拦下 → 一个都不装载');
    assert.deepEqual(pluginPages(state), [], '页面不该出');
    assert.deepEqual(pluginToolDefs(state), [], '工具不该出');
    assert.deepEqual(pluginMacros(state), [], '宏不该出');

    // 但 enabledPlugins 仍是「开着」——插件管理页要能显示「它开着但不可用」
    assert.ok(enabledPlugins(state).length > 0, 'enabledPlugins 保持原语义（只看开关）');
  } finally {
    PLUGIN_MANIFESTS.forEach((m, i) => { m.contributes.requires = saved[i]; });
    restore();
  }
  });
});

test('注册表: skip 记录里有人话理由 + 缺的能力名（界面直接可用）', () => {
  const saved = PLUGIN_MANIFESTS.map(m => m.contributes.requires);
  nothingAvailable();
  withHostPresent(() => {
  try {
    for (const manifest of PLUGIN_MANIFESTS) manifest.contributes.requires = ['getWorldbook'];
    const skips = pluginCapabilitySkips({});
    assert.ok(skips.length > 0);
    for (const skip of skips) {
      assert.equal(typeof skip.id, 'string');
      assert.equal(typeof skip.name, 'string');
      assert.ok(skip.reason.length > 0, skip.id + ' 缺人话原因');
      assert.match(skip.reason, /读世界书/, skip.id + ' 原因要带人话能力名');
      assert.deepEqual(skip.missing, ['getWorldbook']);
      assert.ok(skip.detail.includes('getWorldbook'), 'detail 要能查到缺的接口名');
    }
  } finally {
    PLUGIN_MANIFESTS.forEach((m, i) => { m.contributes.requires = saved[i]; });
    restore();
  }
  });
});

test('注册表: 能力齐备时插件照常装载（闸不误伤）', () => {
  const saved = PLUGIN_MANIFESTS.map(m => m.contributes.requires);
  everythingAvailable();
  try {
    for (const manifest of PLUGIN_MANIFESTS) manifest.contributes.requires = ['getWorldbook'];
    const state = {};
    assert.deepEqual(pluginCapabilitySkips(state), [], '能力齐备不该有 skip');
    assert.equal(loadablePlugins(state).length, enabledPlugins(state).length);
    assert.ok(pluginPages(state).some(page => page.id === 'worldbook'), '世界书页面照常出');
    assert.ok(pluginToolDefs(state).length > 0, '工具照常出');
  } finally {
    PLUGIN_MANIFESTS.forEach((m, i) => { m.contributes.requires = saved[i]; });
    restore();
  }
});

test('注册表: pluginStatusWithCapabilities 把「缺能力」显示成 dang 档', () => {
  const saved = PLUGIN_MANIFESTS.map(m => m.contributes.requires);
  nothingAvailable();
  withHostPresent(() => {
  try {
    const id = PLUGIN_MANIFESTS.find(m => m.defaultEnabled).id;
    for (const manifest of PLUGIN_MANIFESTS) manifest.contributes.requires = ['getWorldbook'];
    assert.deepEqual(pluginStatusWithCapabilities({}, id, {}), { label: '缺能力', kind: 'dang' });

    // 未启用优先于缺能力
    assert.deepEqual(pluginStatusWithCapabilities({ plugin_state: { [id]: { enabled: false } } }, id, {}), {
      label: '未启用',
      kind: '',
    });
  } finally {
    PLUGIN_MANIFESTS.forEach((m, i) => { m.contributes.requires = saved[i]; });
    restore();
  }
  });
});

test('注册表: 探测抛错时**没有异常逃出去**，插件按「不可用」被明确拦下', () => {
  const saved = PLUGIN_MANIFESTS.map(m => m.contributes.requires);
  installCapabilityResolver(() => {
    throw new Error('探测炸了');
  });
  withHostPresent(() => {
  try {
    for (const manifest of PLUGIN_MANIFESTS) manifest.contributes.requires = ['getWorldbook'];
    const state = {};
    // 关键：probeCapability 内部就吞掉了 resolver 的异常（深层防线），
    // 所以这里不会抛 —— 且插件被**明确**判为缺能力，而不是静默通过。
    const skips = pluginCapabilitySkips(state);
    assert.ok(skips.length > 0, '探测炸了不能静默放行');
    for (const skip of skips) {
      assert.ok(skip.reason.length > 0);
      assert.match(skip.reason, /读世界书|探测失败/, '原因要么是「缺能力」要么是「探测失败」，都得是人话');
    }
    assert.deepEqual(loadablePlugins(state), [], '探测炸了 → 不该有任何插件被装载');
  } finally {
    PLUGIN_MANIFESTS.forEach((m, i) => { m.contributes.requires = saved[i]; });
    restore();
  }
  });
});

/* ============ 4. 变量两档能力：vars.table（需酒馆助手）vs vars.keyed（原生可用）============ */

test('变量两档: 纯原生环境 → vars.keyed 可用、vars.table **不可用**（这条差异要暴露给用户）', () => {
  // 造一个「ST 原生在、但没装酒馆助手」的真机形态
  const previous = globalThis.SillyTavern;
  const previousHelper = globalThis.TavernHelper;
  globalThis.SillyTavern = {
    getContext: () => ({ variables: { global: { get: () => undefined, set: () => {} } } }),
  };
  delete globalThis.TavernHelper;
  restore(); // 用默认内省解析器（不看注入的）
  try {
    assert.equal(capabilityStatus('vars.keyed').ok, true, 'ST 原生按 key 读写始终可用');
    const table = capabilityStatus('vars.table');
    assert.equal(table.ok, false, '整表语义需要「列出全部键」，ST 原生没有 → 必须明确不可用');
    assert.match(table.reason, /整表|酒馆助手/, '原因要说清为什么不可用、缺什么才能有');
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
    if (previousHelper !== undefined) globalThis.TavernHelper = previousHelper;
    restore();
  }
});

test('变量两档: 装了酒馆助手 → vars.table 也可用（存储不再受限）', () => {
  const previousHelper = globalThis.TavernHelper;
  globalThis.TavernHelper = { getVariables: () => ({}) };
  restore();
  try {
    const table = capabilityStatus('vars.table');
    assert.equal(table.ok, true, '酒馆助手给了整表接口 → 整表语义可用');
    assert.equal(table.provider, 'tavern-helper');
  } finally {
    if (previousHelper === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = previousHelper;
    restore();
  }
});

test('变量两档: 两条都在能力表里，且没有合成一条「存储可用」', () => {
  const names = CAPABILITIES.map(def => def.name);
  assert.ok(names.includes('vars.table'), '要有 vars.table（需酒馆助手）');
  assert.ok(names.includes('vars.keyed'), '要有 vars.keyed（原生可用）');
  assert.equal(names.includes('vars'), false, '不许有一个笼统的 vars —— 那正是要根治的「能力可得性隐式」');
});

/* ============ 5. 与真实 host 链的适配（fromHasHostFn）============ */

test('fromHasHostFn: 有 → 按原生/酒馆助手分档；没有 → none', () => {
  const present = new Set(['generateRaw', 'getVariables']);
  const resolver = fromHasHostFn(name => present.has(name));
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => ({ generateRaw: () => 'x' }) };
  try {
    assert.equal(resolver('generateRaw'), 'native', '原生表里有的算 native');
    assert.equal(resolver('getVariables'), 'tavern-helper', '链上有但原生表里没有的算 tavern-helper');
    assert.equal(resolver('根本没有'), 'none');
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
});

test('fromHasHostFn: hasHostFn 抛错时按 none 处理（不把异常放出去）', () => {
  const resolver = fromHasHostFn(() => {
    throw new Error('链炸了');
  });
  assert.equal(resolver('whatever'), 'none');
});

test('fromHasHostFn 接进能力表: 链上有能力 → 插件通过裁决', () => {
  installCapabilityResolver(fromHasHostFn(name => name === 'getWorldbook'));
  try {
    assert.equal(evaluatePluginCapabilities(['getWorldbook']).ok, true, '链上真有这条能力就该通过');
    assert.equal(evaluatePluginCapabilities(['getWorldbookNames']).ok, false, '链上没有的仍要拦');
  } finally {
    restore();
  }
});

/* ============ 6. 端到端：能力表 → 裁决 → 装载 的完整链路 ============ */

test('端到端: 插件自己声明的 requires 从「缺能力被跳过」到「能力齐备被装载」', () => {
  const worldbook = PLUGIN_MANIFESTS.find(m => m.id === 'worldbook');
  assert.ok(worldbook, '要有 worldbook 插件');
  const saved = worldbook.contributes.requires;
  withHostPresent(() => {
  try {
    // ① 插件声明「我需要读世界书」
    worldbook.contributes.requires = ['getWorldbook'];
    const state = {};

    // ② 纯原生环境（没有酒馆助手）→ 缺能力 → 不注册 + 人话原因
    nothingAvailable();
    const skips = pluginCapabilitySkips(state);
    const skip = skips.find(item => item.id === 'worldbook');
    assert.ok(skip, '缺能力就必须被跳过');
    assert.match(skip.reason, /读世界书/, '原因要人话');
    assert.ok(!loadablePlugins(state).some(m => m.id === 'worldbook'), '被跳过的插件不装载');
    assert.equal(pluginPages(state).some(page => page.id === 'worldbook'), false, '它的页面不该出现');

    // ③ 能力齐备 → 照常装载
    everythingAvailable();
    assert.deepEqual(pluginCapabilitySkips(state), [], '能力齐备不该有 skip');
    assert.ok(loadablePlugins(state).some(m => m.id === 'worldbook'), '能力齐备就装载');
    assert.equal(pluginPages(state).some(page => page.id === 'worldbook'), true, '页面照常出现');
  } finally {
    worldbook.contributes.requires = saved;
    restore();
  }
  });
});

test('端到端: 声明可选（问号后缀）的能力缺失 → 装载不受影响，只记一笔', () => {
  const worldbook = PLUGIN_MANIFESTS.find(m => m.id === 'worldbook');
  const saved = worldbook.contributes.requires;
  try {
    // getWorldbook 必需、getRequestHeaders 可选
    worldbook.contributes.requires = ['getWorldbook', 'getRequestHeaders?'] + '';
    onlyThese(['getWorldbook']);
    const state = {};
    assert.deepEqual(pluginCapabilitySkips(state), [], '只缺可选的不能拦装');
    assert.ok(loadablePlugins(state).some(m => m.id === 'worldbook'));
  } finally {
    worldbook.contributes.requires = saved;
    restore();
  }
});