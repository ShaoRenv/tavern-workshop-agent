/**
 * 验收：写盘策略（2.5s 防抖 + 批量挂起）与「删掉全局 deep watcher 之后，原来的写点仍然落盘」。
 *
 * 背景（实测的卡顿根因）：
 *   1) App.vue 原来有一条 `watch(() => store.data, () => store.save(), { deep: true })`：
 *      任何一次数据变动都要深遍历整份 RootData（会话 / 事件 / 轮次 / 草稿）并排一次保存；
 *      agent 流式输出每几十毫秒改一次 turn.text，于是每几十毫秒遍历一次。
 *   2) 一次保存 = 整份 RootData 回传酒馆（实测 content-length = 46670868 ≈ 46.7 MB）。
 *   3) 原来的防抖只有 400ms，一次 agent 运行里的十几个停顿点 = 十几次 46.7 MB。
 *
 * 现在那条 deep watcher 删了，所以每个写点必须**自己**落盘；这些用例就是防它悄悄丢数据的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { setHostBridge } = await import(root + 'core/storage.ts');
const { GLOBAL_KEY } = await import(root + 'core/types.ts');
const { useAppStore, SAVE_DEBOUNCE_MS } = await import(root + 'stores/app.ts');

function turn(id, role, text, over = {}) {
  return { id, role, text, images: [], calls: [], at: Date.now(), ...over };
}

/**
 * 每个用例一套全新 pinia + store。
 * 写盘接口注入假实现，`writes` 的长度就是「真实落盘次数」（一次 = 一次 46.7 MB）。
 */
function freshStore() {
  const writes = [];
  setHostBridge({
    insertOrAssignVariables: (payload, options) => writes.push({ payload, options }),
  });
  setActivePinia(createPinia());
  const store = useAppStore();
  store.load();
  return {
    store,
    writes,
    /** 最后一次真正写进去的 RootData */
    saved() {
      return writes.length ? writes[writes.length - 1].payload[GLOBAL_KEY] : null;
    },
    done() {
      setHostBridge(null);
    },
  };
}

test('save: 防抖间隔是 2500ms（400ms → 2500ms 的硬要求）', () => {
  assert.equal(SAVE_DEBOUNCE_MS, 2500);
});

test('save: 挂起期间多次变更不写盘；releaseSaves() 之后恰好写一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;
    const sessionId = store.activeSessionId;

    store.holdSaves();
    assert.equal(store.savesHeld, true);
    assert.equal(store.savesHeldCount, 1);

    // 模拟一次 agent 运行里的多次写点（页签 / 模式 / 轮次 / 流式增量 / 预设字段）
    store.setTab('chat');
    store.setMode('chat');
    store.appendTurn(turn('u1', 'user', '你好'));
    store.patchTurnText('u1', '，在吗');
    store.updatePreset(store.data.presets[0].id, { name: '改过的预设' });

    // 挂起期间无论过多久都不该排定时器、更不该写盘
    t.mock.timers.tick(SAVE_DEBOUNCE_MS * 4);
    assert.equal(writes.length, 0, '挂起期间一次都不能写');
    assert.equal(store.dirty, true);

    store.releaseSaves();
    assert.equal(store.savesHeld, false);
    assert.equal(store.savesHeldCount, 0);
    assert.equal(writes.length, 1, 'release 之后恰好写一次');

    const saved = box.saved();
    assert.equal(saved.active_tab, 'chat');
    assert.equal(saved.sessions.find((item) => item.id === sessionId).mode, 'chat');
    assert.equal(saved.sessions.find((item) => item.id === sessionId).turns[0].text, '你好，在吗');
    assert.equal(saved.presets[0].name, '改过的预设');
    assert.equal(store.dirty, false);
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

test('save: 挂起期间调 save(true) 仍然立刻写盘；release 不会重复写', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;
    store.holdSaves();
    store.setTab('records');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
    assert.equal(writes.length, 0, '自动防抖那条路被抑制');

    store.save(true);
    assert.equal(writes.length, 1, '显式立即写不受挂起影响');
    assert.equal(box.saved().active_tab, 'records');
    assert.equal(store.dirty, false);

    store.releaseSaves();
    assert.equal(writes.length, 1, '已经写完了，release 不再重复写');
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

test('save: 挂起支持嵌套（计数到 0 才写）；releaseSaves 多调一次是幂等的', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;
    store.holdSaves();
    store.holdSaves();
    assert.equal(store.savesHeld, true);
    assert.equal(store.savesHeldCount, 2);

    store.setTab('settings');
    store.releaseSaves();
    assert.equal(store.savesHeld, true, '还有一层没释放');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
    assert.equal(writes.length, 0, '没释放完就不写');

    store.releaseSaves();
    assert.equal(store.savesHeld, false);
    assert.equal(writes.length, 1);

    store.releaseSaves(); // 幂等：没挂起时什么都不做
    assert.equal(writes.length, 1, '多释放一次不会误写');
    assert.equal(store.savesHeld, false);
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

test('save: 任务抛异常时 withHeldSaves() 仍然释放（finally 语义），异常前的改动照样落盘', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;
    await assert.rejects(
      store.withHeldSaves(async () => {
        store.setTab('capability');
        throw new Error('跑挂了');
      }),
      /跑挂了/,
    );

    assert.equal(store.savesHeld, false, '异常路径也必须释放，否则之后永远不落盘');
    assert.equal(store.savesHeldCount, 0);
    assert.equal(writes.length, 1, '异常前改的东西要保住');
    assert.equal(box.saved().active_tab, 'capability');
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

test('save: 页面隐藏时的 flushSaves() 无视挂起兜底写；release 时不会漏掉之后的改动', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;
    store.holdSaves();
    store.appendTurn(turn('u1', 'user', '第一句'));

    store.flushSaves();
    assert.equal(writes.length, 1, '隐藏时兜底写一次（挂起也照写）');

    // 隐藏之后 runner 还会直接改 data（session.round / 草稿镜像是绕过 save() 的写点）
    store.activeSession.round = 7;
    store.releaseSaves();
    assert.equal(writes.length, 2, 'release 再写一次，兜底那次之后的改动不会丢');
    assert.equal(box.saved().sessions.find((item) => item.id === store.activeSessionId).round, 7);

    // 之后恢复正常防抖
    store.setTab('portraits');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 3);
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

test('save: 删掉 deep watcher 后，页签 / 会话 / 技能开关 / 预设字段仍然会落盘', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const box = freshStore();
  const { store, writes } = box;
  try {
    writes.length = 0;

    // 1) 切换页签（App.vue goto() → store.setTab）
    store.setTab('worldbook');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 1, '切页签要落盘');
    assert.equal(box.saved().active_tab, 'worldbook');

    // 2) 切换会话（App.vue onSessionAction('open') → store.openSession）
    const second = store.createSession('第二条');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 2, '新建会话要落盘');
    assert.equal(box.saved().active_session_id, second.id);
    store.openSession(store.sessions[0].id);
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 3, '切会话要落盘');
    assert.equal(box.saved().active_session_id, store.sessions[0].id);

    // 3) 技能的 enabled（App.vue onSkillToggle() → store.updateSkill）
    const skill = store.addSkill({ name: '测试技能' });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 4);
    store.updateSkill(skill.id, { enabled: !skill.enabled });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 5, '技能开关要落盘');
    assert.equal(box.saved().skills.find((item) => item.id === skill.id).enabled, false);

    // 4) 预设字段（SettingsView 改预设 → store.updatePreset）
    const preset = store.addPreset({ name: '测试预设' });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 6);
    store.updatePreset(preset.id, { name: '改过的预设', use_global_caps: true });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(writes.length, 7, '改预设字段要落盘');
    const savedPreset = box.saved().presets.find((item) => item.id === preset.id);
    assert.equal(savedPreset.name, '改过的预设');
    assert.equal(savedPreset.use_global_caps, true);
  } finally {
    t.mock.timers.reset();
    box.done();
  }
});

/** 剥掉注释：注释里提到旧代码不算数，只看真正会跑的代码 */
function codeOnly(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

test('源码级: App.vue 不再有 deep 全局 watcher，页面的写点都接上了 store.save()（防回归）', () => {
  const app = codeOnly(readFileSync('src/苍玄助手/App.vue', 'utf8'));
  assert.ok(!/deep\s*:\s*true/.test(app), 'App.vue 里不该再有 deep: true 的 watcher');
  assert.ok(!/watch\(\s*\(\)\s*=>\s*store\.data/.test(app), '不该再 watch 整个 store.data');
  assert.ok(app.includes('store.holdSaves()'), '长任务入口要挂起保存');
  assert.ok(app.includes('store.releaseSaves()'), '长任务入口的 finally 要释放保存');

  // 会直接改 store.data 的页面：都 emit('change')，由 App.vue 接成 store.save()
  // （ChatView 的 mode 与 SkillsView 的开关走的是 store 动作，另有断言）
  for (const view of ['WorldbookView', 'PortraitsView', 'SettingsView', 'CapabilityView']) {
    const src = codeOnly(readFileSync('src/苍玄助手/views/' + view + '.vue', 'utf8'));
    assert.ok(src.includes("emit('change')"), view + ' 的写点没有 emit(\'change\') 出口');
    const usage = new RegExp('<' + view + '[\\s\\S]*?/>').exec(app);
    assert.ok(usage, 'App.vue 里没找到 ' + view + ' 的用法');
    assert.match(usage[0], /@change="store\.save\(\)"/, view + ' 的 change 事件没接到 store.save()');
  }

  // ChatView：Agent｜聊天 由 store.setMode 落盘
  assert.match(app, /@mode-change="store\.setMode\(\$event\)"/);
  const chat = codeOnly(readFileSync('src/苍玄助手/views/ChatView.vue', 'utf8'));
  assert.ok(chat.includes("emit('mode-change'"), 'ChatView 的 mode 写点要 emit(mode-change)');
  assert.ok(!chat.includes('v-model="session.mode"'), 'ChatView 不该再直接 v-model 改 session.mode');

  // SkillsView 的启用开关 → CapabilityView 转发 → App.vue → store.updateSkill
  const skills = codeOnly(readFileSync('src/苍玄助手/views/SkillsView.vue', 'utf8'));
  assert.ok(skills.includes("emit('toggle', skill)"), '技能开关要 emit(toggle)');
  assert.ok(!skills.includes('skill.enabled = !skill.enabled'), '技能开关不该再在界面里直接改');
  const capability = codeOnly(readFileSync('src/苍玄助手/views/CapabilityView.vue', 'utf8'));
  assert.ok(capability.includes("emit('skill-toggle', $event)"), 'CapabilityView 要转发技能开关');
  assert.match(app, /@skill-toggle="onSkillToggle"/);
  assert.match(app, /store\.updateSkill\(skill\.id, \{ enabled: !skill\.enabled \}\)/);
});
