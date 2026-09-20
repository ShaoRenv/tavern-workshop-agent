/**
 * 验收（task-22）：会话事件日志（仅追加）+ turns 双写 + 工具覆盖项 + 草稿按会话分离。
 *
 * 覆盖：
 *  - Session.events 缺省 []、老数据补空
 *  - makeEvent / appendEvent / appendEvents 纯函数行为
 *  - turns → events 双写桥 eventsForTurn（含确定性 id、raw 截断、失败标记）
 *  - store：appendTurn / upsertTurn / setTurns 双写；patchTurnText 不刷日志
 *  - store：appendEvent / logEvent / eventsOf
 *  - store：setToolOverride / resetToolOverride / toolOverrideOf（含落盘往返）
 *  - store：草稿归属会话（addDraft 盖章、draftsOf / clearDraftsFor）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { GLOBAL_KEY, RootDataSchema, makeEvent, appendEvent, appendEvents, eventsForTurn, eventTitle, EVENT_TYPE_TITLES } = await import(root + 'core/types.ts');
const { setHostBridge, recoverRootData } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');

function turn(id, role, text, over = {}) {
  return { id, role, text, images: [], calls: [], at: 0, ...over };
}
function call(id, name, over = {}) {
  return { id, name, args: {}, ok: true, brief: '', detail: '', images: [], at: 0, ...over };
}
/** 每个用例一套全新的 pinia + store；写盘注入假接口，最后手动 flush 防抖定时器 */
function box() {
  const table = {};
  setHostBridge({
    getVariables: () => table,
    insertOrAssignVariables: (patch) => Object.assign(table, patch),
  });
  setActivePinia(createPinia());
  const store = useAppStore();
  return {
    store,
    table,
    saved() {
      store.save(true);
      return table[GLOBAL_KEY];
    },
    done() {
      store.save(true);
      setHostBridge(null);
    },
  };
}

/* ============================ 纯函数 ============================ */

test('events: 缺省是空数组，老数据（v2）补空不报错', () => {
  assert.deepEqual(RootDataSchema.parse({}).sessions, []);
  const result = recoverRootData({
    version: 2,
    sessions: [{ id: 's1', title: '甲', turns: [turn('t1', 'user', '你好', { at: 5 })] }],
    active_session_id: 's1',
  });
  assert.deepEqual(result.data.sessions[0].events, [], 'v2 老会话补空事件数组');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.data.sessions[0].turns, [turn('t1', 'user', '你好', { at: 5 })], 'turns 读路径不动');
});

test('events: makeEvent 保证 title 非空，appendEvent / appendEvents 是纯函数', () => {
  const made = makeEvent('tool', { tool: 'wb_read' });
  assert.equal(made.type, 'tool');
  assert.equal(made.tool, 'wb_read');
  assert.equal(made.title, EVENT_TYPE_TITLES.tool, 'title 拿不到就从 type 兜底');
  assert.ok(made.title.length > 0);
  assert.ok(made.at > 0, 'makeEvent 补时间戳');
  assert.ok(made.id.length > 0);

  const titled = makeEvent('notice', { title: '  自己写的  ' });
  assert.equal(titled.title, '自己写的');
  assert.equal(eventTitle({ type: 'artifact', title: '' }), EVENT_TYPE_TITLES.artifact);

  const list = [made];
  const appended = appendEvent(list, titled);
  assert.notEqual(appended, list, '返回新数组');
  assert.equal(list.length, 1, '不改入参');
  assert.deepEqual(appended.map(e => e.id), [made.id, titled.id]);

  assert.equal(appendEvents(list, []), list, '空批次返回原引用');
  const more = appendEvents(list, [titled, made]);
  assert.equal(more.length, 3);
  assert.equal(list.length, 1);
});

test('events: eventsForTurn 把轮次摊成事件（确定性 id / ref / raw / 失败标记）', () => {
  const user = eventsForTurn(turn('u1', 'user', '帮我把天枢阁压短\n第二行', { at: 1000 }));
  assert.equal(user.length, 1);
  assert.equal(user[0].id, 'u1:0', 'id 确定性：轮次id:序号');
  assert.equal(user[0].type, 'user');
  assert.equal(user[0].title, '帮我把天枢阁压短', '标题取首行');
  assert.equal(user[0].text, '帮我把天枢阁压短\n第二行', '正文是整段');
  assert.equal(user[0].ref, 'u1');
  assert.equal(user[0].at, 1000);
  assert.deepEqual(eventsForTurn(turn('u1', 'user', '帮我把天枢阁压短\n第二行', { at: 1000 })), user, '同输入同输出');

  const long = '长'.repeat(600);
  const assistant = eventsForTurn(
    turn('a1', 'assistant', '我看看。', {
      at: 2000,
      calls: [
        call('c1', 'wb_read', { brief: '读了 1 条', detail: long }),
        call('c2', 'entry_edit', { ok: false, brief: 'uid 不对', detail: '没这条' }),
      ],
    }),
  );
  assert.deepEqual(assistant.map(e => e.id), ['a1:0', 'a1:1', 'a1:2']);
  assert.equal(assistant[0].type, 'assistant');
  assert.equal(assistant[0].title, '我看看。');
  assert.equal(assistant[1].type, 'tool');
  assert.equal(assistant[1].tool, 'wb_read');
  assert.equal(assistant[1].ok, true);
  assert.equal(assistant[1].ref, 'c1', '工具事件的 ref 是 call id');
  assert.equal(assistant[1].title, 'wb_read · 读了 1 条');
  assert.equal(assistant[1].text.length, 401, 'text 是 400 字预览 + 省略号');
  assert.equal(assistant[1].raw, long, 'raw 保留完整原文');
  assert.equal(assistant[2].title, 'entry_edit · uid 不对（失败）');
  assert.equal(assistant[2].ok, false);
  assert.equal(assistant[2].raw, undefined, '短结果不塞 raw');

  const toolTurn = eventsForTurn(turn('t9', 'tool', '工具结果正文', { at: 3 }));
  assert.equal(toolTurn.length, 1);
  assert.equal(toolTurn[0].type, 'tool');
  assert.equal(toolTurn[0].title, '工具结果正文');

  const empty = eventsForTurn(turn('e1', 'user', ''));
  assert.equal(empty[0].title, EVENT_TYPE_TITLES.user, '空文本也保证 title 非空');
});

/* ============================ store：双写与事件 API ============================ */

test('store: appendTurn / upsertTurn 双写（turns 与 events 都不落）', () => {
  const b = box();
  try {
    b.store.appendTurn(turn('u1', 'user', '帮我把天枢阁压短', { at: 10 }));
    assert.deepEqual(b.store.currentSessionTurns.map(t => t.id), ['u1'], 'turns 读路径照旧');
    assert.deepEqual(b.store.currentSessionEvents.map(e => e.id), ['u1:0']);
    assert.equal(b.store.currentSessionEvents[0].title, '帮我把天枢阁压短');
    assert.equal(b.store.currentSessionEvents, b.store.activeSession.events, '计算属性就是会话上的数组');

    // upsert 重写同一个轮次：turns 只有一条，events 再追加一条（后写的算数）
    b.store.upsertTurn(turn('u1', 'user', '帮我把天枢阁压短一点', { at: 11 }));
    assert.deepEqual(b.store.currentSessionTurns.map(t => t.id), ['u1']);
    assert.deepEqual(b.store.currentSessionEvents.map(e => e.id), ['u1:0', 'u1:0']);
    assert.equal(b.store.currentSessionEvents[1].text, '帮我把天枢阁压短一点');

    b.store.appendTurn(
      turn('a1', 'assistant', '好。', { at: 12, calls: [call('c1', 'wb_read', { brief: '3 条' })] }),
    );
    assert.equal(b.store.currentSessionTurns.length, 2);
    assert.deepEqual(b.store.currentSessionEvents.map(e => e.id), ['u1:0', 'u1:0', 'a1:0', 'a1:1']);

    // 流式增量不入日志（避免日志爆炸）
    const before = b.store.currentSessionEvents.length;
    b.store.patchTurnText('a1', '我看看');
    assert.equal(b.store.currentSessionEvents.length, before, 'patchTurnText 不追加事件');
    assert.equal(b.store.currentSessionTurns[1].text, '好。我看看');

    // setTurns 整批换：events 只追加，所以每一条都补上事件
    b.store.setTurns([turn('x1', 'user', '第一句', { at: 20 }), turn('x2', 'assistant', '好的', { at: 21 })]);
    assert.equal(b.store.currentSessionTurns.length, 2);
    assert.deepEqual(
      b.store.currentSessionEvents.slice(before).map(e => e.id),
      ['x1:0', 'x2:0'],
    );

    // 落盘再读：events 跟着会话走
    const stored = b.saved();
    assert.equal(stored.sessions[0].events.length, b.store.currentSessionEvents.length);
    assert.equal(stored.sessions[0].turns.length, 2);
    assert.equal(JSON.stringify(stored).includes('"events"'), true);
  } finally {
    b.done();
  }
});

test('store: appendEvent / logEvent / eventsOf（title 兜底、按会话取）', () => {
  const b = box();
  try {
    b.store.appendEvent({ id: 'e1', at: 0, type: 'notice', title: '' });
    assert.equal(b.store.currentSessionEvents[0].title, EVENT_TYPE_TITLES.notice, '空 title 落盘前兜底');

    const logged = b.store.logEvent('draft', { title: '草稿 · 12 处改动', ok: true, ref: 'd1' });
    assert.equal(logged.type, 'draft');
    assert.ok(logged.at > 0);
    assert.equal(logged.ref, 'd1');
    assert.equal(b.store.currentSessionEvents.length, 2);

    b.store.appendEvents([makeEvent('apply', { title: '已保存' }), makeEvent('artifact', { title: 'x.json' })]);
    assert.equal(b.store.currentSessionEvents.length, 4);
    b.store.appendEvents([]);
    assert.equal(b.store.currentSessionEvents.length, 4, '空批次 no-op');

    const firstId = b.store.activeSessionId;
    const second = b.store.createSession('乙');
    assert.deepEqual(b.store.eventsOf(firstId).map(e => e.title), ['提示', '草稿 · 12 处改动', '已保存', 'x.json']);
    assert.deepEqual(b.store.eventsOf(second.id), []);
    assert.deepEqual(b.store.eventsOf(), [], '不传 = 当前会话');
    b.store.appendEvent(makeEvent('notice', { title: '乙的提示' }));
    assert.deepEqual(b.store.eventsOf(second.id).map(e => e.title), ['乙的提示']);
    assert.equal(b.store.eventsOf(firstId).length, 4, '另一个会话不受影响');
  } finally {
    b.done();
  }
});

/* ============================ store：工具覆盖项 ============================ */

test('store: setToolOverride 合并 + 自动 edited_at，resetToolOverride 清掉', () => {
  const b = box();
  try {
    assert.equal(b.store.toolOverrideOf('wb_read'), undefined);
    assert.deepEqual(b.store.toolOverrides, {});

    b.store.setToolOverride('wb_read', { description: '先读再改' });
    const first = b.store.toolOverrideOf('wb_read');
    assert.equal(first.description, '先读再改');
    assert.ok(first.edited_at > 0, '自动盖 edited_at');

    b.store.setToolOverride('wb_read', { timeout_ms: 9000 });
    const merged = b.store.toolOverrideOf('wb_read');
    assert.equal(merged.description, '先读再改', '合并进已有项');
    assert.equal(merged.timeout_ms, 9000);
    assert.ok(merged.edited_at >= first.edited_at);

    // patch 里显式 undefined 的字段不当成「覆盖成 undefined」
    b.store.setToolOverride('wb_read', { description: undefined, param_defaults: { uid: '42' } });
    assert.equal(b.store.toolOverrideOf('wb_read').description, '先读再改');
    assert.deepEqual(b.store.toolOverrideOf('wb_read').param_defaults, { uid: '42' });

    // 落盘往返
    const stored = b.saved();
    assert.deepEqual(stored.tool_overrides.wb_read.param_defaults, { uid: '42' });
    setActivePinia(createPinia());
    const again = useAppStore();
    again.load();
    assert.equal(again.toolOverrideOf('wb_read').timeout_ms, 9000, '重新 load 还在');
    assert.equal(again.toolOverrideOf('wb_read').description, '先读再改');

    again.resetToolOverride('wb_read');
    assert.equal(again.toolOverrideOf('wb_read'), undefined);
    assert.deepEqual(again.toolOverrides, {});
    again.resetToolOverride('没改过的工具');
    assert.deepEqual(again.toolOverrides, {}, '重置不存在的键是 no-op');
  } finally {
    b.done();
  }
});

/* ============================ store：草稿归属会话 ============================ */

test('store: 草稿按会话分开（addDraft 盖章 / draftsOf / clearDraftsFor）', () => {
  const b = box();
  try {
    const first = b.store.activeSessionId;
    const change = (id) => ({ id, kind: 'edit', world: '苍玄界', uid: '42', label: '天枢阁', before: 'a', after: 'b', payload: {}, at: 1 });

    b.store.addDraft(change('d1'));
    assert.equal(b.store.data.drafts[0].session_id, first, '没传 session_id 就盖当前会话');
    assert.deepEqual(b.store.draftsOf(first).map(d => d.id), ['d1']);
    assert.deepEqual(b.store.currentDrafts.map(d => d.id), ['d1']);
    assert.equal(b.store.draftCount(), 1);
    assert.equal(b.store.draftCount('没这个会话'), 0);

    const second = b.store.createSession('乙');
    assert.deepEqual(b.store.draftsOf(), [], '切会话后草稿条是空的');
    b.store.addDraft(change('d2'));
    b.store.addDraft({ ...change('d3'), session_id: first });
    assert.deepEqual(b.store.draftsOf(second.id).map(d => d.id), ['d2']);
    assert.deepEqual(b.store.draftsOf(first).map(d => d.id), ['d1', 'd3'], '显式归属按传入的算');

    b.store.clearDraftsFor(second.id);
    assert.deepEqual(b.store.draftsOf(second.id), []);
    assert.deepEqual(b.store.draftsOf(first).map(d => d.id), ['d1', 'd3'], '只清自己那份');

    const stored = b.saved();
    assert.deepEqual(stored.drafts.map(d => d.session_id), [first, first]);

    b.store.clearDrafts();
    assert.deepEqual(b.store.data.drafts, [], 'clearDrafts 清全部');
  } finally {
    b.done();
  }
});
