/**
 * 阶段 6 · 运行时工具注册通道（P6-1 / task-41）的契约测试。
 *
 * 为什么这条通道值得单独钉一遍：
 *   `manifest.contributes.tools` 是**静态声明**，而 MCP 要 initialize + tools/list
 *   之后才知道远端有什么工具（设计自查 B1）。于是工具表多出**第二个入口** ——
 *   多出来的入口最容易漏掉的就是「关掉即消失」：静态那条路已经被 runner 的
 *   liveToolDefs 钉过（验收 F-A 的回归闸），运行时这条路是新的，必须自己钉。
 *
 * 这里钉的是**不变量**（不是实现细节）：
 *   1. 注册后、插件开着 → 进 pluginToolDefs / pluginAllTools（默认开的还进 pluginTools）；
 *   2. 关掉插件 → 从表里消失，**但 toolOwner 仍认它**（落回 'base' 的话
 *      liveToolDefs 会把它当底座工具，关掉插件后照样发给模型 —— 最危险的一处）；
 *   3. 重复注册 = **整批替换**（重连后远端工具变少，不许残留）；
 *   4. 撞上静态声明的名字 → 拒绝 + 人话原因，且**不夺走原归属**；
 *   5. default_on=false 的运行时工具：def 在、但不进默认能力；
 *   6. 插件被**能力闸**拦下时，运行时工具同样不出（「关掉即消失」的第四层）。
 *
 * 跑法：node --test "tests/苍玄助手/runtime_tools.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  pluginToolDefs,
  pluginTools,
  pluginAllTools,
  toolOwner,
  toolOwnerLabel,
  registerRuntimeTools,
  unregisterRuntimeTools,
  runtimeToolsOf,
  runtimeToolNames,
} = await import(root + 'plugins/registry.ts');
const { installCapabilityGateHost } = await import('./_helpers.ts');

/**
 * 拿一个**真实存在**的内置插件当宿主。
 *
 * 为什么不用 'mcp'：这条通道与「是哪个插件」无关，而 mcp 的 manifest 由另一个任务在做 ——
 * 测试不该依赖别人还没落地的文件。注册表只要求这个 id 在 PLUGIN_MANIFESTS 里
 * （不在的话 runtimeToolsOf 根本不会被 pluginToolDefs 取到，那是另一条约束）。
 */
const HOST = 'image';
const ON = { plugin_state: { [HOST]: { enabled: true } } };
const OFF = { plugin_state: { [HOST]: { enabled: false } } };

/** 最小的 ToolDef：只填注册表真正读的字段 */
function tool(name: string, defaultOn = true) {
  return {
    name,
    group: 'external' as const,
    title: name,
    desc: name,
    model_description: name,
    parameters: { type: 'object', properties: {} },
    default_on: defaultOn,
    run: async () => ({ ok: true, text: '' }),
  };
}

/** 运行时注册是**进程级**状态，每个用例自己收拾干净 */
function cleanup(t: { after: (fn: () => void) => void }) {
  t.after(() => unregisterRuntimeTools(HOST));
}

test('注册后：插件开着时工具进表（defs / all / 默认开的那份）', t => {
  cleanup(t);
  const report = registerRuntimeTools(HOST, [tool('mcp_echo_a')], 'MCP · 测试服');
  assert.deepEqual(report.registered, ['mcp_echo_a']);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(runtimeToolNames(HOST), ['mcp_echo_a']);

  assert.ok(
    pluginToolDefs(ON).some(def => def.name === 'mcp_echo_a'),
    'pluginToolDefs 必须带上运行时工具，否则模型永远看不到它',
  );
  assert.ok(pluginAllTools(ON).includes('mcp_echo_a'));
  assert.ok(pluginTools(ON).includes('mcp_echo_a'));
});

test('关掉插件：工具从表里消失，但 toolOwner 仍认它（不许落回 base）', t => {
  cleanup(t);
  registerRuntimeTools(HOST, [tool('mcp_echo_a')], 'MCP · 测试服');

  assert.ok(!pluginToolDefs(OFF).some(def => def.name === 'mcp_echo_a'));
  assert.ok(!pluginAllTools(OFF).includes('mcp_echo_a'));

  // 本文件最关键的一行：落回 'base' = runner 的 liveToolDefs 会把它当底座工具照发
  assert.equal(toolOwner('mcp_echo_a'), HOST);
  // 反例自检：没注册过的名字仍落回 base —— 证明上一行不是恒真
  assert.equal(toolOwner('mcp_totally_unknown_xyz'), 'base');
});

test('重复注册是整批替换，不是追加（重连后远端工具变少不许残留）', t => {
  cleanup(t);
  registerRuntimeTools(HOST, [tool('mcp_a'), tool('mcp_b')], 'MCP · 测试服');
  assert.deepEqual(runtimeToolNames(HOST), ['mcp_a', 'mcp_b']);

  registerRuntimeTools(HOST, [tool('mcp_c')], 'MCP · 测试服');
  assert.deepEqual(runtimeToolNames(HOST), ['mcp_c']);

  const names = pluginAllTools(ON);
  assert.ok(!names.includes('mcp_a') && !names.includes('mcp_b'), '上一批必须整批消失');
  // 反例自检：被替换掉的名字也不再被任何插件认领（否则会算成底座工具）
  assert.equal(toolOwner('mcp_a'), 'base');
});

test('撞上静态声明的工具名 → 拒绝 + 人话原因，且不夺走原归属', t => {
  cleanup(t);
  const report = registerRuntimeTools(HOST, [tool('wb_list'), tool('mcp_ok')], 'MCP · 测试服');

  assert.deepEqual(report.registered, ['mcp_ok']);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].name, 'wb_list');
  assert.match(report.rejected[0].reason, /内置插件|静态/);

  // 原归属不变：世界书的工具还是世界书的
  assert.equal(toolOwner('wb_list'), 'worldbook');
  assert.equal(toolOwnerLabel('wb_list'), '世界书');
});

test('空名与同批重名都拒绝（不静默丢）', t => {
  cleanup(t);
  const report = registerRuntimeTools(HOST, [tool(''), tool('mcp_x'), tool('mcp_x')], 'MCP · 测试服');
  assert.deepEqual(report.registered, ['mcp_x']);
  assert.equal(report.rejected.length, 2);
  assert.ok(report.rejected.some(item => item.name === ''));
  assert.ok(report.rejected.some(item => item.name === 'mcp_x'));
});

test('来源标签：有 label 用 label，空 label 回落插件名', t => {
  cleanup(t);
  registerRuntimeTools(HOST, [tool('mcp_echo_b')], 'MCP · 测试服');
  assert.equal(toolOwnerLabel('mcp_echo_b'), 'MCP · 测试服');

  registerRuntimeTools(HOST, [tool('mcp_echo_c')], '   ');
  assert.equal(toolOwnerLabel('mcp_echo_c'), '生图');
});

test('default_on=false 的运行时工具：def 在，但不进「默认给模型」的名单', t => {
  cleanup(t);
  registerRuntimeTools(HOST, [tool('mcp_manual', false)], 'MCP · 测试服');

  assert.ok(
    pluginToolDefs(ON).some(def => def.name === 'mcp_manual'),
    'def 必须在（能不能发由能力的 default_on 决定，缺 def 会直接 NotFound）',
  );
  assert.ok(pluginAllTools(ON).includes('mcp_manual'));
  assert.ok(!pluginTools(ON).includes('mcp_manual'), 'default_on=false 不许进默认能力');
});

test('插件被能力闸拦下：运行时工具也不出（「关掉即消失」的第四层）', t => {
  t.after(() => unregisterRuntimeTools('worldbook'));
  const st = { plugin_state: { worldbook: { enabled: true } } };

  // 对照组：能力齐全 → 运行时工具出得来（证明后面那条不是「本来就出不来」）
  const full = installCapabilityGateHost();
  registerRuntimeTools('worldbook', [tool('mcp_echo_d')], 'MCP · 测试服');
  assert.ok(pluginAllTools(st).includes('mcp_echo_d'), '能力齐全时应当出得来');
  full();

  // 真闸：缺必需的 getWorldbook → worldbook 整个不装载 → 连运行时工具一起消失
  const gated = installCapabilityGateHost(name => name !== 'getWorldbook');
  assert.ok(!pluginAllTools(st).includes('mcp_echo_d'), '被能力闸拦下的插件，运行时工具也不许出');
  gated();

  // 归属是静态事实：装载与否不影响 toolOwner（否则「来源已停用」这类界面标签会错）
  assert.equal(toolOwner('mcp_echo_d'), 'worldbook');
});

test('catalog：**名单外**的工具也要出现在工具目录里（真机验收抓到的漏）', async t => {
  t.after(() => unregisterRuntimeTools(HOST));
  const { createRegistry } = await import(root + 'agent/registry.ts');
  const { createWorldbookPort } = await import(root + 'core/worldbook.ts');

  registerRuntimeTools(HOST, [tool('cx_runtime_only')], 'MCP · 测试服');
  const on = { plugin_state: { [HOST]: { enabled: true } } };

  const rows = createRegistry(createWorldbookPort(), on).catalog().map(row => row.name);
  assert.ok(
    rows.includes('cx_runtime_only'),
    '名单外的真实工具必须出行 —— 否则模型拿得到、界面列不出来（这正是真机上 MCP 工具不显示的根因）',
  );
  assert.equal(rows.filter(name => name === 'cx_runtime_only').length, 1, '不许重复出行');
  // 内置名单的兜底行不能因为这次改动消失（插件关着的老名字仍要能看到「缺失 / 来源已停用」）
  assert.ok(rows.includes('gen_image'), '内置名单里的名字照旧要出行（即使插件关着）');

  // 反例自检：没注册过时它不该出现 —— 证明上面那条不是恒真
  unregisterRuntimeTools(HOST);
  const rowsOff = createRegistry(createWorldbookPort(), on).catalog().map(row => row.name);
  assert.ok(!rowsOff.includes('cx_runtime_only'));
});

test('注销后彻底消失（断开服务器的那条路）', t => {
  registerRuntimeTools(HOST, [tool('mcp_gone')], 'MCP · 测试服');
  assert.ok(pluginAllTools(ON).includes('mcp_gone'));
  unregisterRuntimeTools(HOST);
  assert.deepEqual(runtimeToolsOf(HOST), []);
  assert.ok(!pluginAllTools(ON).includes('mcp_gone'));
  assert.equal(toolOwner('mcp_gone'), 'base');
});
