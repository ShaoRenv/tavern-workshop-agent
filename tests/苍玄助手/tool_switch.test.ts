/**
 * 工具级开关（tool_overrides.enabled）的契约测试。
 *
 * 这是对旧口径的一次**有意反转**：原计划 A6 明确否决过「工具级开关」，理由是
 * 「停用只在来源处」。反转后仍然成立的那部分：开关**只能收窄**——
 * 显式开也救不回「来源已停用」的工具；关插件 / 关服务器仍然是首选。
 *
 * 这里钉三条硬性质：
 *   1. **三态语义**：undefined（跟随）≠ true（手动开）≠ false（手动关）——
 *      把 undefined 当成 false 会让所有按需工具在界面上显示成「已关」（用户以为系统背着他改了设置）；
 *   2. **落点在 default_on**：applyToolOverride 把 enabled 翻译成 default_on，
 *      runner 与界面因此共用同一份口径（否则又是「两处各判一次、早晚分叉」）；
 *   3. **只能收窄**：来源插件关着时，手动开也不进能力表（来源处的闸更早）。
 *
 * 跑法：node --test "tests/苍玄助手/tool_switch.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { applyToolOverride } = await import(root + 'agent/registry.ts');
const { toolSwitchState, toolSwitchLabel, overrideEdited } = await import(root + 'components/ui_types.ts');
const { resolveCaps } = await import(root + 'core/types.ts');

/** 一个最小的 ToolDef */
function def(name: string, defaultOn: boolean) {
  return {
    name,
    group: 'knowledge' as const,
    title: name,
    desc: name,
    model_description: name,
    parameters: { type: 'object', properties: {} },
    default_on: defaultOn,
    run: async () => ({ ok: true, brief: '', detail: '' }),
  };
}

test('三态：undefined = 跟随，true = 手动开，false = 手动关（三者必须互不相同）', () => {
  assert.equal(toolSwitchState(undefined), 'follow');
  assert.equal(toolSwitchState({}), 'follow');
  assert.equal(toolSwitchState({ enabled: true }), 'on');
  assert.equal(toolSwitchState({ enabled: false }), 'off');

  // 反例自检：三者标签两两不同 —— 否则「区分三态」这件事等于没做
  const labels = [toolSwitchLabel(undefined), toolSwitchLabel({ enabled: true }), toolSwitchLabel({ enabled: false })];
  assert.equal(new Set(labels).size, 3, '三态文案必须两两不同，实际：' + labels.join(' / '));
});

test('enabled 落到 default_on（唯一 choke point：runner 与界面共用）', () => {
  const base = def('wb_list', true);
  assert.equal(applyToolOverride(base, { enabled: false }).default_on, false, '手动关 → 不给');
  assert.equal(applyToolOverride(base, { enabled: true }).default_on, true, '手动开 → 给');

  const onDemand = def('entry_meta', false);
  assert.equal(applyToolOverride(onDemand, { enabled: true }).default_on, true, '按需工具手动开 → 给');
  // 没设过 → 原样（不能被 undefined 改成 false）
  assert.equal(applyToolOverride(onDemand, {}).default_on, false, '跟随 = 保持内置 default_on');
  assert.equal(applyToolOverride(onDemand, undefined).default_on, false);
});

test('开关算「改过」（edited_at 不算，但 enabled 算）', () => {
  assert.equal(overrideEdited({ enabled: false }), true);
  assert.equal(overrideEdited({ enabled: true }), true);
  assert.equal(overrideEdited({ edited_at: 123 }), false, '只盖时间戳不算改过');
});

test('resolveCaps：显式关掉的工具不进全局能力', () => {
  const preset = { use_global_caps: false, tools: [], skills: [] };
  const global = {
    tools: [
      { name: 'wb_list', default_on: true },
      { name: 'entry_meta', default_on: false },
    ],
    skills: [],
  };
  // 基线：跟随全局 → 只有 default_on 的那条
  assert.deepEqual(resolveCaps(preset, global).tools, ['wb_list']);
  // 把 wb_list 手动关掉（模拟 App.vue 的过滤后它根本不在列表里）
  const filtered = { tools: global.tools.filter(tool => tool.name !== 'wb_list'), skills: [] };
  assert.deepEqual(resolveCaps(preset, filtered).tools, [], '手动关掉的工具不该出现在能力里');
});

test('只能收窄：来源处关着时，手动开也救不回来（来源处的闸更早）', async () => {
  // 这条性质由 liveToolDefs / pluginAllTools 保证（在 applyToolOverride **之前**筛），
  // 这里用真函数验证一遍，免得将来有人把顺序调反。
  const { liveToolDefs } = await import(root + 'run/runner.ts');
  const defs = [def('wb_list', true), def('wb_read', true)];
  // 世界书插件关着 → 它的工具连 def 都不该进这一轮
  const state = { plugin_state: { worldbook: { enabled: false } } };
  const live = liveToolDefs(defs, state).map(item => item.name);
  assert.ok(!live.includes('wb_list'), '来源插件关着 → 它的工具不进这一轮（手动开也不该救回来）');
  // 反例自检：插件开着时它们必须在（证明上面那条不是「本来就为空」）
  const on = { plugin_state: { worldbook: { enabled: true } } };
  assert.ok(liveToolDefs(defs, on).map(item => item.name).includes('wb_list'));
});
