/**
 * B41 完整版：**内置预设只读**。
 *
 * 为什么需要这道闸：applyBuiltins() 每次载入都会把内置预设**强制覆盖成最新版**
 * （那是为了插件升级能带来新内置内容），所以用户对内置预设的任何编辑**下次刷新就丢**。
 * 界面上已经把所有写入口撤掉了（SettingsView 的 presetLocked + MsgRow 的 locked），
 * 这里验的是**数据层**那道闸 —— 界面漏一个按钮，也不该真的改进去。
 *
 * 用户自己的预设（builtin: false）必须照旧能改 —— 那是他唯一能持久化的地方。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { setHostBridge } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');
const { applyBuiltins } = await import(root + 'presets/builtin.ts');

function freshStore() {
  const writes = [];
  setHostBridge({ insertOrAssignVariables: (payload, options) => writes.push({ payload, options }) });
  setActivePinia(createPinia());
  const store = useAppStore();
  store.load();
  return {
    store,
    writes,
    done() {
      // 先把待定的防抖写点冲掉，再拆桥 —— 否则定时器会在桥拆了之后才烧，
      // 输出里会多出一串「没有可用的变量写入接口」的假报错。
      store.save(true);
      setHostBridge(null);
    },
  };
}

test('B41: 内置预设是只读的 —— updatePreset 拒写、原内容一个字不变', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find((p) => p.builtin);
    assert.ok(builtin, '载入后应该至少有一个内置预设');
    const before = JSON.stringify(builtin);

    const ok = box.store.updatePreset(builtin.id, { name: '被改过的内置预设' });
    assert.equal(ok, false, '改内置预设必须被拒绝（返回 false）');
    assert.equal(
      JSON.stringify(box.store.data.presets.find((p) => p.id === builtin.id)),
      before,
      '被拒绝的写入不许留下任何痕迹',
    );
  } finally {
    box.done();
  }
});

test('B41: 用户自己的预设照旧能改（只有内置那一份被锁）', () => {
  const box = freshStore();
  try {
    const mine = box.store.addPreset({ name: '我的预设' });
    assert.equal(mine.builtin, false, '派生出来的副本是用户的');
    const ok = box.store.updatePreset(mine.id, { name: '改过的' });
    assert.equal(ok, true, '用户预设必须能改');
    assert.equal(box.store.data.presets.find((p) => p.id === mine.id).name, '改过的');
  } finally {
    box.done();
  }
});

test('B41: addPreset 派生内置预设 → builtin:false + 新 id，改副本不影响内置', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find((p) => p.builtin);
    const builtinBefore = JSON.stringify(builtin);

    // App.vue 的 duplicate 分支就是这个形状
    const copy = { ...builtin, name: builtin.name + ' 副本', builtin: false };
    delete copy.id;
    const made = box.store.addPreset(copy);

    assert.notEqual(made.id, builtin.id, '副本必须是新 id');
    assert.equal(made.builtin, false, '副本不是内置');
    assert.equal(box.store.updatePreset(made.id, { name: '副本改名' }), true, '副本能改');
    assert.equal(
      JSON.stringify(box.store.data.presets.find((p) => p.id === builtin.id)),
      builtinBefore,
      '改副本不许波及内置那份',
    );
  } finally {
    box.done();
  }
});

test('B41: 内置预设删不掉（removePreset 内部挡）', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find((p) => p.builtin);
    const count = box.store.data.presets.length;
    box.store.removePreset(builtin.id);
    assert.equal(box.store.data.presets.length, count, '内置预设必须还在');
    assert.ok(box.store.data.presets.some((p) => p.id === builtin.id), '内置预设必须还在');
  } finally {
    box.done();
  }
});

test('B41: 「内置只读」与「强制覆盖」是配套的 —— 改过的内置预设会被 applyBuiltins 打回原样', () => {
  // 这条是上面那道闸的**理由**：如果放行写入，用户改的东西下一次载入就没了。
  // 用纯函数直接演示这个后果，避免以后有人觉得「updatePreset 拒写」太严。
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find((p) => p.builtin);
    // 绕过 store 那道闸，直接伪造一份「用户改过的内置预设」（模拟旧数据 / 老版本写进去的）
    const tampered = { ...box.store.data, presets: box.store.data.presets.map((p) => (p.id === builtin.id ? { ...p, name: '用户改的' } : p)) };
    const after = applyBuiltins(tampered);
    assert.equal(
      after.presets.find((p) => p.id === builtin.id).name,
      builtin.name,
      '内置预设会被强制覆盖回最新版 —— 这正是「改内置等于白改」的证据',
    );
  } finally {
    box.done();
  }
});
