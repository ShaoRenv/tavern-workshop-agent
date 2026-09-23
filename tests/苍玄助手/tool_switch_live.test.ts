/**
 * 工具级开关的**端到端语义**测试：手动关掉的工具真的不进这一轮的工具表。
 *
 * 这条是「开关」存在的唯一理由 —— 界面显示「手动关」而模型照样能调，
 * 就是又一次「界面替底层撒谎」。所以这里不看界面，直接跑 runner 的组装链。
 *
 * 链路（与 runAgent 里那段一致）：
 *   createRegistry(plugin_state) → liveToolDefs → resolveToolDefs(overrides) → resolveCaps
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createRegistry, resolveToolDefs } = await import(root + 'agent/registry.ts');
const { liveToolDefs } = await import(root + 'run/runner.ts');
const { resolveCaps } = await import(root + 'core/types.ts');
const { createWorldbookPort } = await import(root + 'core/worldbook.ts');

/** 组装一轮真正会发出去的工具名（与 runner 同一顺序、同一函数） */
function liveToolNames(overrides: Record<string, { enabled?: boolean }>): string[] {
  const state = { plugin_state: { worldbook: { enabled: true }, cangxuan: { enabled: true } } };
  const registry = createRegistry(createWorldbookPort(), { plugin_state: state.plugin_state });
  const defs = resolveToolDefs(liveToolDefs(registry.defs, state), overrides);
  return resolveCaps({ use_global_caps: false, tools: [], skills: [] }, { tools: defs, skills: [] }).tools;
}

test('手动关掉的工具**不进**这一轮（开关的唯一理由）', () => {
  const on = liveToolNames({});
  assert.ok(on.includes('wb_list'), '基线：没设过开关时 wb_list 在（否则下面那条是假绿）');

  const off = liveToolNames({ wb_list: { enabled: false } });
  assert.ok(!off.includes('wb_list'), '手动关 → 这条工具不能发给模型');
  assert.ok(off.length === on.length - 1, '只该少这一条，其余不受影响（实际差 ' + (on.length - off.length) + '）');
});

test('手动打开的按需工具**进**这一轮（entry_meta 默认不给）', () => {
  const base = liveToolNames({});
  assert.ok(!base.includes('entry_meta'), '基线：entry_meta 默认不给（default_on=false）');
  const on = liveToolNames({ entry_meta: { enabled: true } });
  assert.ok(on.includes('entry_meta'), '手动开 → 它该进');
});

test('跟随（没设过）保持内置 default_on，不被当成关', () => {
  const a = liveToolNames({});
  const b = liveToolNames({ wb_read: { description: '改过提示词但没动开关' } });
  assert.deepEqual(b, a, '只改提示词不该改变「发不发」');
});

test('只能收窄：来源插件关着时，手动开也救不回来', () => {
  const state = { plugin_state: { worldbook: { enabled: false } } };
  const registry = createRegistry(createWorldbookPort(), { plugin_state: state.plugin_state });
  const defs = resolveToolDefs(liveToolDefs(registry.defs, state), { wb_list: { enabled: true } });
  const names = resolveCaps({ use_global_caps: false, tools: [], skills: [] }, { tools: defs, skills: [] }).tools;
  assert.ok(!names.includes('wb_list'), '来源插件关着 → 手动开也不该出现（来源处的闸更早）');
});
