/**
 * 验收回归（task-20）：多会话 store 动作（create/open/rename/delete/轮次）+ 记录页导出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { setHostBridge } = await import(root + 'core/storage.ts');
const { makeSession, DEFAULT_SESSION_TITLE } = await import(root + 'core/types.ts');
const { useAppStore, sessionToMarkdown, formatTime } = await import(root + 'stores/app.ts');

function turn(id, role, text, over = {}) {
  return { id, role, text, images: [], calls: [], at: Date.now(), ...over };
}

/** 每个用例一套全新的 pinia + store；写盘注入假接口，最后手动 flush 掉防抖定时器 */
function freshStore() {
  const writes = [];
  setHostBridge({ insertOrAssignVariables: (payload, options) => writes.push({ payload, options }) });
  setActivePinia(createPinia());
  const store = useAppStore();
  return {
    store,
    writes,
    done() {
      store.save(true);
      setHostBridge(null);
    },
  };
}

test('store: 一进来就有一条会话，active 指得上（迁移/归一化保证）', () => {
  const box = freshStore();
  try {
    assert.equal(box.store.sessions.length, 1);
    assert.equal(box.store.sessions[0].id, 'sess-default');
    assert.equal(box.store.sessions[0].title, DEFAULT_SESSION_TITLE);
    assert.equal(box.store.activeSessionId, 'sess-default');
    assert.equal(box.store.activeSession, box.store.sessions[0], 'activeSession 就是列表里那条');
    assert.deepEqual(box.store.sessionMetas, [
      { id: 'sess-default', title: DEFAULT_SESSION_TITLE, created_at: 0, updated_at: 0, turns: 0, preset_id: '', mode: 'agent', running: false },
    ]);
  } finally {
    box.done();
  }
});

test('store: createSession 新建并切过去；openSession 只认存在的 id', () => {
  const box = freshStore();
  const { store } = box;
  try {
    const first = store.activeSessionId;
    const second = store.createSession('第二个');
    assert.equal(store.sessions.length, 2);
    assert.equal(store.activeSessionId, second.id);
    assert.equal(second.title, '第二个');
    assert.equal(second.mode, store.sessions[0].mode);
    assert.notEqual(second.id, first);

    const blank = store.createSession('   ');
    assert.equal(blank.title, DEFAULT_SESSION_TITLE, '标题空白就退回默认');

    assert.equal(store.openSession(first), true);
    assert.equal(store.activeSessionId, first);
    assert.equal(store.openSession('不存在的会话'), false);
    assert.equal(store.activeSessionId, first, '失败不改 active');
  } finally {
    box.done();
  }
});

test('store: renameSession 去空白；空标题退回「由首条用户消息推出来」', () => {
  const box = freshStore();
  const { store } = box;
  try {
    const session = store.createSession();
    store.renameSession(session.id, '  改过的名字  ');
    assert.equal(store.activeSession.title, '改过的名字');

    store.appendTurn(turn('u1', 'user', '把天枢阁总部写清楚\n第二行'));
    store.renameSession(session.id, '先起个名');
    assert.equal(store.activeSession.title, '先起个名');
    store.renameSession(session.id, '   ');
    assert.equal(store.activeSession.title, '把天枢阁总部写清楚', '空标题退回首条用户消息');

    store.renameSession('不存在', 'x');
    assert.equal(store.activeSession.title, '把天枢阁总部写清楚', 'id 不存在就什么也不做');
  } finally {
    box.done();
  }
});

test('store: deleteSession —— 删非当前不动 active，删当前退到下一条，删最后一个自动补一条', () => {
  const box = freshStore();
  const { store } = box;
  try {
    const a = store.sessions[0].id;
    const b = store.createSession('B').id;
    const c = store.createSession('C').id;

    store.openSession(b);
    store.deleteSession(a);
    assert.equal(store.sessions.length, 2);
    assert.equal(store.activeSessionId, b, '删的不是当前就不动 active');

    store.deleteSession(b);
    assert.equal(store.sessions.length, 1);
    assert.equal(store.activeSessionId, c, '删当前就退到列表里剩的那条');

    store.deleteSession(c);
    assert.equal(store.sessions.length, 1, '删最后一个会自动补一条');
    assert.equal(store.sessions[0].title, DEFAULT_SESSION_TITLE);
    assert.equal(store.activeSessionId, store.sessions[0].id, 'active 必须指得上');
    assert.deepEqual(store.sessions[0].turns, []);
  } finally {
    box.done();
  }
});

test('store: appendTurn / upsertTurn / patchTurnText 只作用于当前会话', () => {
  const box = freshStore();
  const { store } = box;
  try {
    const a = store.createSession('A');
    store.appendTurn(turn('a1', 'user', '第一条'));
    store.appendTurn(turn('a2', 'assistant', '回复'));
    assert.equal(store.activeSession.turns.length, 2);
    assert.equal(store.activeSession.turns[0].text, '第一条');
    assert.ok(store.activeSession.updated_at > 0, '记更新时间');

    const b = store.createSession('B');
    store.appendTurn(turn('b1', 'user', 'B 的第一条'));
    assert.equal(store.activeSession.turns.length, 1);

    // 回到 A：B 的动作不能串进来
    store.openSession(a.id);
    assert.deepEqual(store.activeSession.turns.map(item => item.id), ['a1', 'a2']);
    store.upsertTurn(turn('a1', 'user', '替换掉第一条'));
    assert.equal(store.activeSession.turns.length, 2, 'upsert 命中就整条替换，不新增');
    assert.equal(store.activeSession.turns[0].text, '替换掉第一条');

    store.patchTurnText('a2', '（补充）');
    assert.equal(store.activeSession.turns[1].text, '回复（补充）');
    store.patchTurnText('a2', '');
    assert.equal(store.activeSession.turns[1].text, '回复（补充）', '空增量不做事');
    store.patchTurnText('不存在', 'x');
    assert.equal(store.activeSession.turns.length, 2);

    // upsert 新 id 就 push
    store.upsertTurn(turn('a3', 'assistant', '新的'));
    assert.equal(store.activeSession.turns.length, 3);
    assert.equal(store.activeSession.turns[2].id, 'a3');

    // B 还是自己那一条
    store.openSession(b.id);
    assert.deepEqual(store.activeSession.turns.map(item => item.id), ['b1']);
  } finally {
    box.done();
  }
});

test('store: exportSession json 可往返、md 有结构且不出现 dataURL；exportSessions 是数组', () => {
  const box = freshStore();
  const { store } = box;
  try {
    const session = store.createSession('导出用');
    store.appendTurn(turn('u1', 'user', '用户说的话', { images: ['data:image/png;base64,AAAA'], at: 1700000000000 }));
    store.appendTurn(
      turn('a1', 'assistant', '助手回的话', {
        calls: [
          { id: 'c1', name: 'wb_read', args: { uid: '1' }, ok: true, brief: '读了 1 条', detail: '', images: [], at: 1 },
          { id: 'c2', name: 'entry_edit', args: {}, ok: false, brief: '找不到 uid', detail: '', images: [], at: 2 },
        ],
        at: 1700000060000,
      }),
    );

    const json = store.exportSession(session.id, 'json');
    const parsed = JSON.parse(json);
    assert.equal(parsed.id, session.id);
    assert.equal(parsed.title, '导出用');
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0].text, '用户说的话');

    const md = store.exportSession(session.id, 'md');
    assert.match(md, /^# 导出用$/m);
    assert.match(md, /创建：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 更新：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 共 2 轮/);
    assert.match(md, /^## 用户$/m);
    assert.match(md, /^## 苍玄$/m);
    assert.match(md, /^用户说的话$/m, '正文不缩进');
    assert.match(md, /^  - 工具 wb_read → 读了 1 条$/m);
    assert.match(md, /^  - 工具 entry_edit → 找不到 uid（失败）$/m);
    assert.match(md, /^  - 图片 1 张（导出不含图片数据）$/m);
    assert.ok(!md.includes('data:image'), 'md 里绝不能出现 dataURL');
    assert.ok(!md.includes('base64'), 'md 里绝不能出现 base64');

    assert.equal(store.exportSession('不存在的会话', 'json'), '');
    assert.equal(store.exportSession('不存在的会话', 'md'), '');

    const all = JSON.parse(store.exportSessions());
    assert.ok(Array.isArray(all), 'exportSessions 是 JSON 数组');
    assert.equal(all.length, store.sessions.length);
    assert.equal(all[0].id, store.sessions[0].id);
  } finally {
    box.done();
  }
});

test('store: sessionToMarkdown / formatTime 纯函数边界', () => {
  assert.equal(formatTime(0), '—');
  assert.equal(formatTime(-1), '—');
  assert.match(formatTime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  const session = makeSession({
    id: 's',
    title: 'T',
    created_at: 1700000000000,
    updated_at: 1700000060000,
    turns: [
      turn('t0', 'tool', '工具轮次'),
      turn('t1', 'user', '   '),
      turn('t2', 'assistant', '', {
        calls: [{ id: 'c', name: 'submit', args: {}, ok: true, brief: '', detail: '', images: [], at: 0 }],
      }),
    ],
  });
  const md = sessionToMarkdown(session);
  assert.match(md, /^## 工具$/m);
  assert.match(md, /^  - 工具 submit → 完成$/m, 'ok 且没摘要时显示「完成」');
  assert.ok(md.endsWith('\n'));
  assert.ok(!md.includes('undefined'));

  // 没标题的会话用推出来的标题
  const untitled = makeSession({ id: 's2', title: '', turns: [turn('u', 'user', '推出来的标题', 1)] });
  assert.match(sessionToMarkdown(untitled), /^# 推出来的标题$/m);
});
