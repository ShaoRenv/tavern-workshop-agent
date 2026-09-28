/**
 * B44/B45/B58/B59：预设系统的「工具提示词跟预设走」+ 分三类导入导出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { setHostBridge } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');
const { TRANSFER_VERSION, exportPreset, exportSkill, exportToolPrompts, importTransfer, transferFileName, transferKindLabel } = await import(root + 'core/transfer.ts');
const { PresetSchema } = await import(root + 'core/types.ts');

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
      store.save(true);
      setHostBridge(null);
    },
  };
}

/* ============================ B45：字段与默认值 ============================ */

test('B45: Preset 有 tool_overrides 字段，老数据缺省成空对象（= 全跟随内置）', () => {
  const box = freshStore();
  try {
    for (const preset of box.store.data.presets) {
      assert.ok(preset.tool_overrides !== undefined, preset.id + ' 缺 tool_overrides');
      assert.equal(typeof preset.tool_overrides, 'object');
    }
    const old = PresetSchema.parse({ id: 'p1', name: '老预设' });
    assert.deepEqual(old.tool_overrides, {}, '老数据要缺省成 {} 而不是 undefined');
  } finally {
    box.done();
  }
});

test('B45: 新建预设不带上一份的残留（默认空 = 全跟随内置）', () => {
  const box = freshStore();
  try {
    box.store.setToolOverride('wb_read', { description: '改过的说明' });
    const made = box.store.addPreset({ name: '新的' });
    assert.deepEqual(made.tool_overrides, {}, '新预设不该继承临时区');
  } finally {
    box.done();
  }
});

/* ============================ B58：切预设同步 ============================ */

test('B58: 切预设 → 新预设存的那份整体覆盖临时区', () => {
  const box = freshStore();
  try {
    const a = box.store.addPreset({ name: 'A', tool_overrides: { wb_read: { description: 'A 的说明' } } });
    const b = box.store.addPreset({ name: 'B', tool_overrides: { wb_write: { description: 'B 的说明' } } });
    box.store.selectPreset(a.id);
    assert.equal(box.store.data.tool_overrides.wb_read.description, 'A 的说明');
    box.store.selectPreset(b.id);
    assert.equal(box.store.data.tool_overrides.wb_write.description, 'B 的说明');
    assert.equal(box.store.data.tool_overrides.wb_read, undefined, '要整体覆盖：A 的残留不能漏到 B');
  } finally {
    box.done();
  }
});

test('B58: 切到没有 tool_overrides 的预设 → 临时区被清空', () => {
  const box = freshStore();
  try {
    const a = box.store.addPreset({ name: 'A', tool_overrides: { wb_read: { description: 'x' } } });
    const clean = box.store.addPreset({ name: '干净' });
    box.store.selectPreset(a.id);
    assert.equal(Object.keys(box.store.data.tool_overrides).length, 1);
    box.store.selectPreset(clean.id);
    assert.deepEqual(box.store.data.tool_overrides, {}, '切到干净预设要清空临时区');
  } finally {
    box.done();
  }
});

test('B58: 清空预设选择（id 传空）不动临时区', () => {
  const box = freshStore();
  try {
    box.store.setToolOverride('wb_read', { description: '用户调好的' });
    box.store.selectPreset('');
    assert.equal(box.store.data.tool_overrides.wb_read.description, '用户调好的');
  } finally {
    box.done();
  }
});

test('B58: 切预设不会污染预设本身（改的是临时区那份）', () => {
  const box = freshStore();
  try {
    const a = box.store.addPreset({ name: 'A', tool_overrides: { wb_read: { description: '原本' } } });
    box.store.selectPreset(a.id);
    box.store.setToolOverride('wb_read', { description: '临时改的' });
    const stored = box.store.data.presets.find(p => p.id === a.id);
    assert.equal(stored.tool_overrides.wb_read.description, '原本', '临时区改了不该动预设里那份');
    assert.equal(box.store.data.tool_overrides.wb_read.description, '临时改的');
  } finally {
    box.done();
  }
});

/* ============================ B45：存进预设 ============================ */

test('B45: saveToolOverridesToPreset 把临时区存回当前预设', () => {
  const box = freshStore();
  try {
    const mine = box.store.addPreset({ name: '我的预设' });
    box.store.selectPreset(mine.id);
    box.store.setToolOverride('wb_read', { description: '存进去的' });
    assert.equal(box.store.saveToolOverridesToPreset(), true);
    const stored = box.store.data.presets.find(p => p.id === mine.id);
    assert.equal(stored.tool_overrides.wb_read.description, '存进去的');
  } finally {
    box.done();
  }
});

test('B45: 内置预设存不进去（B41：内置只读）', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find(p => p.builtin);
    assert.ok(builtin, '该有内置预设');
    box.store.selectPreset(builtin.id);
    box.store.setToolOverride('wb_read', { description: '想存进内置' });
    assert.equal(box.store.saveToolOverridesToPreset(), false, '内置必须存不进去');
    const stored = box.store.data.presets.find(p => p.id === builtin.id);
    assert.deepEqual(stored.tool_overrides, {}, '内置那份一个字都不该动');
  } finally {
    box.done();
  }
});

/* ============================ B58：写路径唯一性（真机抓到的 bug）============================ */

/**
 * ⚠️ 这条抓过一个**真机验收才发现的 bug**：设置页的预设 `<select>` 用的是
 * `v-model="data.active_preset_id"` —— 直接改数据，**绕过 `store.selectPreset`**。
 * 于是 B58 的临时区同步与 B59 的「改没存」提示在那个入口上**全都不执行**，
 * 而同一页/隔壁页还有另一个走 store 的选择器 —— 用户看到的是「这边问、那边不问」。
 *
 * 写路径唯一是这个工程的既定口径（见 stores/app.ts 头部注释）。这条闸盯住它。
 */
test('B58: 视图层不许直接写 active_preset_id（必须走 store.selectPreset）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const viewsDir = fileURLToPath(new URL('../../src/苍玄助手/views/', import.meta.url));
  const offenders = [];
  for (const name of readdirSync(viewsDir)) {
    if (!name.endsWith('.vue')) continue;
    const text = readFileSync(viewsDir + name, 'utf8');
    // ⚠️ 先剥掉注释再查：说明这件事的**注释里**必然会写出那个坏写法，
    // 不剥的话这条闸会被自己的注释绊倒（第一次就绊了）。
    const code = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // 只揪「直接绑定 / 直接赋值」这两种写法；`:value` + @change 发事件是正确写法
    if (/v-model="[^"]*active_preset_id/.test(code)) offenders.push(name + ' 用了 v-model 绑 active_preset_id');
    if (/data\.value\.active_preset_id\s*=/.test(code)) offenders.push(name + ' 直接赋值了 active_preset_id');
  }
  assert.deepEqual(offenders, [], offenders.join('；') + ' —— 换预设必须走 store.selectPreset（B58 同步 + B59 拦截都在那里）');
});

/* ============================ B45：派生（另存为）要带上临时区 ============================ */

/**
 * ⚠️ 这条抓过一个**真机验收才发现的 bug**。
 *
 * 用户的真实流程是：在内置预设上调工具提示词 → 发现「存进预设」按钮是灰的（内置只读）
 * → 点「另存为一份再改」。那条调好的东西此刻**只存在于临时区**。
 *
 * 如果派生时不把临时区带进副本，副本的 `tool_overrides` 是空的 ——
 * 用户刚调好的东西就成了**孤儿**：副本里没有、内置里也存不进去，
 * 再点一次「存进预设」反而把副本清空。这正是「另存为一份再改」最该避免的事。
 */
test('B45: 派生（另存为）要把临时区当前的工具提示词带进副本', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find(p => p.builtin);
    box.store.selectPreset(builtin.id);
    box.store.setToolOverride('portrait_prompt', { description: '用户在内置预设上调好的' });

    // App.vue 的 duplicate 分支就是这个形状
    const copy = { ...builtin, name: builtin.name + ' 副本', builtin: false, tool_overrides: { ...box.store.data.tool_overrides } };
    delete copy.id;
    const made = box.store.addPreset(copy);

    assert.equal(
      made.tool_overrides.portrait_prompt.description,
      '用户在内置预设上调好的',
      '刚调好的东西必须跟着进副本，不能变成孤儿',
    );
  } finally {
    box.done();
  }
});

test('B45: 派生后点「存进预设」能真的存住（孤儿 bug 的完整闭环）', () => {
  const box = freshStore();
  try {
    const builtin = box.store.data.presets.find(p => p.builtin);
    box.store.selectPreset(builtin.id);
    box.store.setToolOverride('wb_read', { description: '调好的' });

    const copy = { ...builtin, name: builtin.name + ' 副本', builtin: false, tool_overrides: { ...box.store.data.tool_overrides } };
    delete copy.id;
    const made = box.store.addPreset(copy);

    assert.equal(box.store.saveToolOverridesToPreset(), true, '副本该能存');
    const stored = box.store.data.presets.find(p => p.id === made.id);
    assert.equal(stored.tool_overrides.wb_read.description, '调好的', '存进去的不能是空的');
    assert.equal(box.store.toolOverridesDirty(), false, '存完就不脏了');
  } finally {
    box.done();
  }
});

/* ============================ B59：脏检查 ============================ */

test('B59: toolOverridesDirty —— 临时区和预设里那份不一致时为真', () => {
  const box = freshStore();
  try {
    const mine = box.store.addPreset({ name: '我的预设' });
    box.store.selectPreset(mine.id);
    assert.equal(box.store.toolOverridesDirty(), false, '刚切过来是一致的');
    box.store.setToolOverride('wb_read', { description: '改了没存' });
    assert.equal(box.store.toolOverridesDirty(), true, '临时区变了就是脏');
    box.store.saveToolOverridesToPreset();
    assert.equal(box.store.toolOverridesDirty(), false, '存进预设之后就不脏了');
  } finally {
    box.done();
  }
});

test('B59: 删掉一个覆盖项也算脏（键集合变了）', () => {
  const box = freshStore();
  try {
    const mine = box.store.addPreset({ name: 'p', tool_overrides: { wb_read: { description: 'x' } } });
    box.store.selectPreset(mine.id);
    assert.equal(box.store.toolOverridesDirty(), false);
    box.store.resetToolOverride('wb_read');
    assert.equal(box.store.toolOverridesDirty(), true, '删掉键也是改动');
  } finally {
    box.done();
  }
});

test('B59: 没有当前预设时也返回确定答案（不抛）', () => {
  const box = freshStore();
  try {
    box.store.selectPreset('');
    box.store.setToolOverride('wb_read', { description: 'x' });
    assert.equal(typeof box.store.toolOverridesDirty(), 'boolean');
  } finally {
    box.done();
  }
});

/* ============================ B44：三类导出 ============================ */

test('B44: 三类导出各带自己的 kind + version（T4：JSON 单文件）', () => {
  const tools = JSON.parse(exportToolPrompts({ wb_read: { description: 'x' } }));
  assert.equal(tools.kind, 'tool-prompts');
  assert.equal(tools.version, TRANSFER_VERSION);
  assert.equal(tools.overrides.wb_read.description, 'x');
  const preset = JSON.parse(exportPreset(PresetSchema.parse({ id: 'p1', name: 'P' })));
  assert.equal(preset.kind, 'preset');
  assert.equal(preset.preset.id, 'p1');
  const skill = JSON.parse(exportSkill({ id: 's1', name: 'S', summary: 'x', body: 'y', files: [], enabled: true, builtin: false }));
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.skill.id, 's1');
  assert.equal(exportToolPrompts({}).includes('"kind": "tool-prompts"'), true);
});

/* ============================ B44：导入校验 ============================ */

test('B44: 拿技能文件去点「导入预设」→ 当场报错，不塞成坏数据', () => {
  const skillFile = exportSkill({ id: 's1', name: 'S', summary: 'x', body: 'y', files: [], enabled: true, builtin: false });
  const res = importTransfer(skillFile, { expect: 'preset' });
  assert.equal(res.ok, false);
  assert.match(res.error, /这个文件是/, '要说清是什么：' + res.error);
  assert.match(res.error, /导不进/, '要说清导不进什么：' + res.error);
});

test('B44: 三类互相都拦得住（不只是技能→预设）', () => {
  const files = {
    'tool-prompts': exportToolPrompts({}),
    preset: exportPreset(PresetSchema.parse({ id: 'p1', name: 'P' })),
    skill: exportSkill({ id: 's1', name: 'S', summary: 'x', body: 'y', files: [], enabled: true, builtin: false }),
  };
  for (const from of Object.keys(files)) {
    for (const to of ['tool-prompts', 'preset', 'skill']) {
      if (from === to) continue;
      const res = importTransfer(files[from], { expect: to });
      assert.equal(res.ok, false, from + ' 不该能导进 ' + to);
      assert.match(res.error, /导不进/, from + ' -> ' + to + ' 的报错要清楚：' + res.error);
    }
  }
});

test('B44: 整树导出（没有 kind）→ 提示用「导入数据」，不静默失败', () => {
  const res = importTransfer(JSON.stringify({ version: 5, presets: [], skills: [] }), { expect: 'preset' });
  assert.equal(res.ok, false);
  assert.match(res.error, /认不出|整树/, res.error);
});

test('B44: 撞内置 id → 直接拒绝（内置随版本走，覆盖了下次刷新也被打回）', () => {
  const text = exportPreset(PresetSchema.parse({ id: 'builtin-agent-worldbook', name: '内置' }));
  const res = importTransfer(text, { expect: 'preset', builtinIds: ['builtin-agent-worldbook'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /内置/, res.error);
  assert.match(res.error, /另存为/, '要给一条出路：' + res.error);
});

test('B44: 撞用户自己的 id → 不自己决定，返回 conflict 让界面问（T5）', () => {
  const text = exportPreset(PresetSchema.parse({ id: 'p1', name: '导入的' }));
  const res = importTransfer(text, { expect: 'preset', existing: { p1: '我的预设' } });
  assert.equal(res.ok, true);
  assert.equal(res.conflict.id, 'p1');
  assert.equal(res.conflict.name, '我的预设');
  assert.equal(res.preset.name, '导入的', '内容照常解析出来');
});

test('B44: 不撞车时没有 conflict（直接落地）', () => {
  const text = exportPreset(PresetSchema.parse({ id: 'brand-new', name: '新的' }));
  const res = importTransfer(text, { expect: 'preset', existing: { p1: '别的' } });
  assert.equal(res.ok, true);
  assert.equal(res.conflict, undefined);
});

test('B44: 坏 JSON / 空内容 / 顶层不是对象 → 都给明确人话（不抛）', () => {
  for (const bad of ['', '   ', '不是 json', '[1,2,3]', '"字符串"', '123']) {
    const res = importTransfer(bad, { expect: 'preset' });
    assert.equal(res.ok, false, JSON.stringify(bad) + ' 该失败');
    assert.ok(res.error && res.error.length > 0, '要给原因');
  }
});

test('B44: 缺 id 的预设 / 技能 → 明确报「没法判断撞不撞车」', () => {
  const p = importTransfer(JSON.stringify({ kind: 'preset', version: 1, preset: { name: '没 id' } }), { expect: 'preset' });
  assert.equal(p.ok, false);
  assert.match(p.error, /没有 id/, p.error);
  const s = importTransfer(JSON.stringify({ kind: 'skill', version: 1, skill: { name: '没 id' } }), { expect: 'skill' });
  assert.equal(s.ok, false);
  assert.match(s.error, /没有 id/, s.error);
});

test('B44: 不传 expect = 不校验类别（自动识别用）', () => {
  const text = exportToolPrompts({ wb_read: { description: 'x' } });
  const res = importTransfer(text);
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'tool-prompts');
});

/* ============================ B44：文件名与标签 ============================ */

test('B44: 文件名带类别 + 时间戳，且不含非法字符', () => {
  const name = transferFileName('preset', '我的/预设:v1', new Date(2026, 0, 2, 3, 4));
  assert.match(name, /\.json$/);
  assert.match(name, /20260102-0304/, '要带时间戳：' + name);
  assert.equal(/[\\/:*?"<>|]/.test(name), false, '文件名不能含非法字符：' + name);
  assert.equal(transferKindLabel('tool-prompts'), '工具提示词');
  assert.equal(transferKindLabel('preset'), '预设');
  assert.equal(transferKindLabel('skill'), '技能');
});

test('B44: 名字为空时用类别名兜底（不会产出 .json 这种没名字的文件）', () => {
  const name = transferFileName('skill', '   ', new Date(2026, 0, 2, 3, 4));
  assert.match(name, /^技能\./, name);
});
