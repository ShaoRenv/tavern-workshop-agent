/**
 * 验收回归（task-20）：v1 → v2 多会话迁移、会话归一化、落盘不存两份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const { migrateRootData, recoverRootData, saveData, setHostBridge, defaultRootData } = await import(core + 'storage.ts');
const {
  RootDataSchema,
  DATA_VERSION,
  DEFAULT_SESSION_TITLE,
  GLOBAL_KEY,
  makeSession,
  titleFromText,
  sessionTitle,
  toSessionMeta,
  pickActiveSession,
} = await import(core + 'types.ts');

function turn(id, role, text, at) {
  return { id, role, text, images: [], calls: [], at };
}

/* ============================ 会话小工具 ============================ */

test('sessions: makeSession 默认值 / titleFromText / sessionTitle', () => {
  const made = makeSession();
  assert.equal(made.id, '');
  assert.equal(made.title, DEFAULT_SESSION_TITLE);
  assert.equal(made.created_at, 0);
  assert.equal(made.updated_at, 0);
  assert.equal(made.mode, 'agent');
  assert.deepEqual(made.turns, []);
  assert.equal(makeSession({ id: 'x', title: 'T' }).id, 'x');

  assert.equal(titleFromText('\n  第一行  \n第二行'), '第一行');
  assert.equal(titleFromText('字'.repeat(40)), '字'.repeat(24) + '…');
  assert.equal(titleFromText('字'.repeat(24)), '字'.repeat(24), '正好 24 字不截断');
  assert.equal(titleFromText('  \n  '), DEFAULT_SESSION_TITLE);
  assert.equal(titleFromText(''), DEFAULT_SESSION_TITLE);

  assert.equal(sessionTitle(makeSession({ title: '自己写的' })), '自己写的');
  assert.equal(
    sessionTitle(makeSession({ title: '  ', turns: [turn('t1', 'assistant', '我先说', 1), turn('t2', 'user', '  用户说的话  ', 2)] })),
    '用户说的话',
    '没标题就从首条用户消息推',
  );
  assert.equal(sessionTitle(makeSession()), DEFAULT_SESSION_TITLE);

  const meta = toSessionMeta(makeSession({ id: 's', title: '标题', created_at: 7, updated_at: 9, turns: [turn('t', 'user', 'hi', 1)], round: 3 }));
  assert.deepEqual(meta, {
    id: 's',
    title: '标题',
    created_at: 7,
    updated_at: 9,
    turns: 1,
    preset_id: '',
    mode: 'agent',
    running: false,
  });
});

test('sessions: pickActiveSession 按 id → 第一条 → 现造一条', () => {
  const sessions = [makeSession({ id: 'a', title: 'A' }), makeSession({ id: 'b', title: 'B' })];
  assert.equal(pickActiveSession({ sessions, active_session_id: 'b' }).id, 'b');
  assert.equal(pickActiveSession({ sessions, active_session_id: '不存在' }).id, 'a', '指不上就退回第一条');
  const created = pickActiveSession({ sessions: [], active_session_id: '' });
  assert.equal(created.id, 'sess-default');
  assert.equal(created.title, DEFAULT_SESSION_TITLE);
});

/* ============================ v1 → v2 迁移 ============================ */

test('sessions: v1 老数据（只有 session）迁移成一条记录，内容一个字不丢', () => {
  const legacyTurns = [turn('t1', 'user', '帮我把天枢阁总部写清楚\n第二行', 111), turn('t2', 'assistant', '好的', 222)];
  const v1 = RootDataSchema.parse({
    version: 1,
    active_tab: 'chat',
    active_preset_id: 'p1',
    session: {
      mode: 'chat',
      preset_id: 'p-old',
      turns: legacyTurns,
      running: false,
      round: 2,
      started_at: 100,
    },
  });
  const result = migrateRootData(v1);

  assert.equal(result.migrated, true);
  assert.match(result.warnings.join('\n'), /检测到 v1 单会话数据/);
  assert.equal(result.data.version, DATA_VERSION);
  assert.equal(result.data.sessions.length, 1);
  const session = result.data.sessions[0];
  assert.equal(session.id, 'sess-legacy');
  assert.deepEqual(session.turns, legacyTurns, '轮次必须原样搬过来');
  assert.equal(session.preset_id, 'p-old');
  assert.equal(session.mode, 'chat');
  assert.equal(session.round, 2);
  assert.equal(session.started_at, 100);
  assert.equal(session.created_at, 100, 'created_at 缺就用 started_at');
  assert.equal(session.updated_at, 222, 'updated_at 缺就用最后一条轮次的时间');
  assert.equal(session.title, '帮我把天枢阁总部写清楚', '标题由首条用户消息推出来');
  assert.equal(result.data.active_session_id, 'sess-legacy', 'active 指向迁移后的那条');
  assert.equal(result.data.session.id, 'sess-shell', '单数 session 只剩空壳');
  assert.deepEqual(result.data.session.turns, []);
});

test('sessions: v1 空会话（没痕迹）迁移成一条「新对话」并留警告', () => {
  const result = migrateRootData(RootDataSchema.parse({ version: 1, session: {} }));
  assert.equal(result.migrated, true);
  assert.match(result.warnings.join('\n'), /没有会话内容，已建一个空白会话/);
  assert.deepEqual(result.data.sessions.map(session => session.id), ['sess-default']);
  assert.equal(result.data.active_session_id, 'sess-default');
  assert.equal(result.data.sessions[0].title, DEFAULT_SESSION_TITLE);
});

test('sessions: 混合形态（sessions 有内容 + 残留单数 session）并进去不丢', () => {
  const v1 = RootDataSchema.parse({
    version: 1,
    sessions: [{ id: 's-a', title: '甲', turns: [turn('x', 'user', 'hi', 5)] }],
    active_session_id: 's-a',
    session: { id: 's-b', turns: [turn('y', 'user', '旧会话', 9)] },
  });
  const result = migrateRootData(v1);
  assert.equal(result.migrated, true);
  assert.match(result.warnings.join('\n'), /残留的单会话数据/);
  assert.deepEqual(result.data.sessions.map(session => session.id), ['s-a', 's-b']);
  assert.equal(result.data.sessions[1].title, '旧会话');
  assert.equal(result.data.sessions[1].turns.length, 1);
  assert.equal(result.data.active_session_id, 's-a', '原来指向的还在就不动');

  // 残留的单数 session 和 sessions 里同 id 时不要重复加
  const same = migrateRootData(RootDataSchema.parse({ version: 1, sessions: [{ id: 's-b', turns: [turn('y', 'user', '旧会话', 9)] }], session: { id: 's-b', turns: [turn('y', 'user', '旧会话', 9)] } }));
  assert.deepEqual(same.data.sessions.map(session => session.id), ['s-b']);
});

test('sessions: 迁移是幂等的（migrate(migrate(x)) 等价，第二次不再报迁移）', () => {
  const v1 = RootDataSchema.parse({ version: 1, session: { id: 's1', turns: [turn('t', 'user', '你好', 10)] } });
  const once = migrateRootData(v1);
  const twice = migrateRootData(once.data);
  assert.deepEqual(twice.data, once.data);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.warnings, []);
  assert.deepEqual(migrateRootData(twice.data).data, once.data);
});

test('sessions: v2 干净数据 sessions 为空 → 静默补一条；active 指不上 → 修到第一条', () => {
  const empty = recoverRootData({ version: 2, sessions: [], active_session_id: '' });
  assert.deepEqual(empty.warnings, [], 'v2 没会话属于正常情况，不刷警告');
  assert.deepEqual(empty.data.sessions.map(session => session.id), ['sess-default']);
  assert.equal(empty.data.active_session_id, 'sess-default');

  const badActive = recoverRootData({
    version: 2,
    sessions: [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }],
    active_session_id: '不存在',
  });
  assert.deepEqual(badActive.warnings, []);
  assert.equal(badActive.data.active_session_id, 's1');

  const noId = recoverRootData({ version: 2, sessions: [{ title: '没 id' }], active_session_id: '' });
  assert.equal(noId.data.sessions[0].id, 'sess-1', '缺 id 按序号补');
  assert.equal(noId.data.active_session_id, 'sess-1');
});

test('sessions: sessions 块坏条目逐条丢坏留好', () => {
  const result = recoverRootData({
    version: 2,
    sessions: [{ id: 'a', title: 'A' }, { title: 42 }, '不是对象'],
    active_session_id: 'a',
  });
  assert.match(result.warnings.join('\n'), /存储块 sessions 有 2 条数据不合法（已丢弃），保留 1 条/);
  assert.deepEqual(result.data.sessions.map(session => session.id), ['a']);
  assert.equal(result.data.active_session_id, 'a');
});

/* ============================ 落盘 ============================ */

test('sessions: 落盘后单数 session 是空壳，聊天记录只在 sessions 里存一份', () => {
  const calls = [];
  try {
    setHostBridge({ insertOrAssignVariables: (payload, options) => calls.push({ payload, options }) });
    const data = RootDataSchema.parse({
      sessions: [
        {
          id: 's1',
          title: '一条会话',
          turns: [turn('t1', 'user', '唯一的聊天记录', 5)],
        },
      ],
      active_session_id: 's1',
    });
    saveData(data);
    const stored = calls[0].payload[GLOBAL_KEY];

    assert.equal(stored.sessions.length, 1);
    assert.equal(stored.sessions[0].turns.length, 1);
    assert.equal(stored.session.id, 'sess-shell', '兼容字段写成空壳');
    assert.deepEqual(stored.session.turns, []);
    assert.equal(
      (JSON.stringify(stored).match(/唯一的聊天记录/g) || []).length,
      1,
      '聊天记录不能存两份（可能有 dataURL 大图）',
    );
    assert.equal(stored.version, DATA_VERSION);
    assert.equal(stored.active_session_id, 's1');

    // 空壳再过一次读入口也不会污染回来
    const roundTrip = recoverRootData(stored);
    assert.equal(roundTrip.data.sessions.length, 1);
    assert.deepEqual(roundTrip.data.sessions[0].turns, stored.sessions[0].turns);
    assert.deepEqual(roundTrip.warnings, [], '再读一遍不该报警');
  } finally {
    setHostBridge(null);
  }
  assert.equal(defaultRootData().sessions.length, 0, '默认数据本身不预置会话，迁移才补');
});
