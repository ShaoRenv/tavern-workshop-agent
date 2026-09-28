/**
 * B3：**写后回读校验**（`verifyWrite` + apply / rollback 的接线）。
 *
 * ─────────────────────────── 为什么非要有这个 ───────────────────────────
 *
 * 阶段 5 那份报告里最刺眼的一句（`reports/阶段5-世界书读写全坏-真机发现.md` §7.3）：
 *
 * > 「`rollback()`/`writeAll` 只看有没有抛错，不看写进去的能不能读回来 ——
 * >   这次界面显示『换回去 4 条』而实际 0 条，就是**界面在替底层撒谎**。」
 *
 * 根因（同一份报告 §1）：适配层把数组传给了期望 `{ entries }` 的 `saveWorldInfo`，
 * 于是**书被清空成 0 条，而 `writeAll` 一声不吭、不抛错**。
 *
 * 所以这一组用例的核心不是「正常写能读回来」（那当然能），而是
 * **「写了个空 / 写了旧的，能不能被发现」**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createDraftStore, verifyWrite } = await import(root + 'agent/draft.ts');

/**
 * 造一条条目。形状**逐字段对齐** `tests/苍玄助手/agent_draft.test.ts` 的同名工厂
 * （也就是 `core/types.ts` 的 WbEntry）—— 少一个 `keys_secondary`，
 * `applyChangesToEntries` 会在 `.keys.slice()` 上直接抛（我第一次就是这么写错的）。
 */
function entry(uid, name, content, over = {}) {
  return {
    uid,
    name,
    content,
    enabled: true,
    strategy: 'selective',
    keys: ['k'],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
    position: 0,
    depth: 4,
    order: 100,
    extra: { raw_field: 'keep-me' },
    ...over,
  };
}

/** 造一份草稿改动 */
function change(over = {}) {
  return {
    kind: 'edit',
    world: '天枢阁',
    uid: '1',
    label: '潮听澜',
    before: '旧正文',
    after: '新正文',
    payload: {},
    at: 1,
    ...over,
  };
}

/**
 * 假端口。`onWrite` 让用例能**决定「写下去之后书变成什么样」** ——
 * 这正是复现「静默写空」那种 bug 的关键：写不抛错，但书变了别的样子。
 */
function portOf(seed = {}, { onWrite = null, failWorld = null, failRead = null } = {}) {
  const books = new Map(Object.entries(seed).map(([name, list]) => [name, list.map(item => ({ ...item }))]));
  const writes = [];
  const reads = [];
  return {
    books,
    writes,
    reads,
    async list() { return [...books.keys()]; },
    async readAll(world) {
      reads.push(world);
      if (failRead === world) throw new Error('读失败（假）');
      return (books.get(world) ?? []).map(item => ({
        ...item,
        keys: item.keys.slice(),
        keys_secondary: { logic: item.keys_secondary.logic, keys: item.keys_secondary.keys.slice() },
        extra: { ...item.extra },
      }));
    },
    async writeAll(world, entries) {
      writes.push({ world, entries });
      if (failWorld === world) throw new Error('写回失败（假）');
      books.set(world, onWrite ? onWrite(world, entries) : entries.map(item => ({ ...item })));
    },
  };
}

/* ============================ verifyWrite 本体 ============================ */

test('B3: 写进去的能读回来 → ok（正常路径不误报）', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '新正文')] });
  const result = await verifyWrite(port, '天枢阁', [entry('1', 'A', '新正文')]);
  assert.equal(result.ok, true);
  assert.equal(result.expected, 1);
  assert.equal(result.actual, 1);
  assert.deepEqual(result.problems, []);
});

test('B3: ⚠️ **静默写空**（阶段 5 那次事故的形态）→ 必须报出来', async () => {
  // 写不抛错，但书被清空了 —— 这正是 saveWorldInfo 收数组时的行为
  const port = portOf({ 天枢阁: [] });
  const result = await verifyWrite(port, '天枢阁', [entry('1', 'A', '新正文')]);
  assert.equal(result.ok, false, '写空必须被发现（writeAll 不抛错不代表写成功）');
  assert.equal(result.expected, 1);
  assert.equal(result.actual, 0);
  assert.match(result.problems.join('；'), /条目数对不上：写进去 1 条，读回来 0 条/);
});

test('B3: 条数对但内容是旧的（缓存没失效）→ 也要报出来', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '旧正文')] });
  const result = await verifyWrite(port, '天枢阁', [entry('1', 'A', '新正文')]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('；'), /正文和写进去的不一样/);
});

test('B3: 少了条目 → 报出**是哪几条**（不是只说「对不上」）', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', 'x')] });
  const wanted = [entry('1', 'A', 'x'), entry('2', 'B', 'y'), entry('3', 'C', 'z')];
  const result = await verifyWrite(port, '天枢阁', wanted);
  assert.equal(result.ok, false);
  const text = result.problems.join('；');
  assert.match(text, /条目数对不上/, '条数差要报');
  assert.match(text, /写进去了却读不到：2、3/, '要指出具体 uid：' + text);
});

test('B3: 读失败不抛，转成 ok:false + error（回读失败是一种结果，不是异常）', async () => {
  const port = portOf({ 天枢阁: [] }, { failRead: '天枢阁' });
  const result = await verifyWrite(port, '天枢阁', [entry('1', 'A', 'x')]);
  assert.equal(result.ok, false);
  assert.match(result.error, /读失败（假）/);
  assert.equal(result.actual, 0);
});

test('B3: 空书写空书 → ok（「本来就是空的」不该被当成失败）', async () => {
  const port = portOf({ 空书: [] });
  const result = await verifyWrite(port, '空书', []);
  assert.equal(result.ok, true);
  assert.equal(result.expected, 0);
  assert.equal(result.actual, 0);
});

test('B3: 只比 uid / 正文，**不比全字段** —— 宿主补默认字段不算失败', async () => {
  // 宿主读回来时多给了字段（真实 ST 会补一堆默认值），这不该算写失败，
  // 否则这条警告会天天误报，最后没人看（比没有更糟）。
  const port = portOf({
    天枢阁: [entry('1', 'A', '正文', { 宿主补的字段: 1, another: 'x' })],
  });
  // 读回来那份多了字段、name 也可能被宿主改过 —— 只比 uid 和 content
  const result = await verifyWrite(port, '天枢阁', [entry('1', 'A', '正文')]);
  assert.equal(result.ok, true, '多出来的字段不该算失败：' + result.problems.join('；'));
});

/* ============================ 接进 apply ============================ */

test('B3+apply: 回读对不上 → 报失败 + **草稿保留**（让用户还有得救）', async () => {
  // 写下去之后书变成空的（静默写空的形态）
  const port = portOf({ 天枢阁: [entry('1', 'A', '旧正文')] }, { onWrite: () => [] });
  const store = createDraftStore([change({ id: 'c1' })]);

  const report = await store.apply(port);
  assert.equal(report.ok, false, '回读没过必须报失败');
  assert.equal(report.applied, 0, '没写成功就不能算 applied —— 旧口径会把它算成 1');
  assert.equal(report.failed, 1);
  assert.equal(report.remain.length, 1, '草稿必须留着（摘了就是「说成功、没写进去、草稿也没了」）');
  assert.match(report.warnings.join('；'), /写回后回读对不上/);

  const world = report.worlds.find(item => item.world === '天枢阁');
  assert.equal(world.verify.ok, false);
  assert.equal(world.verify.actual, 0);
});

test('B3+apply: 回读过了才摘草稿（正常路径照旧）', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '旧正文')] });
  const store = createDraftStore([change({ id: 'c1' })]);

  const report = await store.apply(port);
  assert.equal(report.ok, true);
  assert.equal(report.applied, 1);
  assert.equal(report.remain.length, 0, '回读过了才摘草稿');
  assert.equal(report.worlds[0].verify.ok, true);
});

/* ============================ 接进 rollback ============================ */

test('B3+rollback: 回读对不上 → ok:false + error（不假装回滚成功）', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '当前')] }, { onWrite: () => [] });
  const store = createDraftStore();
  const result = await store.rollback(port, { world: '天枢阁', entries: [entry('1', 'A', '备份里的')] });

  assert.equal(result.ok, false, '回滚后回读对不上 = 回滚没成功');
  assert.match(result.error, /条目数对不上/);
  assert.match(result.warnings.join('；'), /回滚后回读对不上/);
});

test('B3+rollback: restored 报**回读到的**条数，不是「以为写进去的」条数', async () => {
  // ⚠️ 这条正是阶段 5 那个 bug 的核心：界面显示「换回去 4 条」而实际 0 条。
  // 旧代码 `restored: entries.length` 报的是**意图**，不是**事实**。
  const port = portOf({ 天枢阁: [] }, { onWrite: () => [] });
  const store = createDraftStore();
  const backup = { world: '天枢阁', entries: [entry('1', 'A', 'a'), entry('2', 'B', 'b'), entry('3', 'C', 'c'), entry('4', 'D', 'd')] };
  const result = await store.rollback(port, backup);

  assert.equal(result.ok, false);
  assert.equal(result.restored, 0, '写进去 4 条但读回来 0 条 → restored 必须是 0（事实），不是 4（意图）');
});

test('B3+rollback: 回滚成功时 restored = 回读到的条数', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '当前')] });
  const store = createDraftStore();
  const backup = { world: '天枢阁', entries: [entry('1', 'A', 'a'), entry('2', 'B', 'b')] };
  const result = await store.rollback(port, backup);

  assert.equal(result.ok, true);
  assert.equal(result.restored, 2);
  assert.equal(result.verify.ok, true);
});

test('B3+rollback: 回滚也会**先备当前状态**（回读校验不影响这条硬性质）', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', '当前')] });
  const snapshots = [];
  const store = createDraftStore();
  store.setBackupSink({ snapshot: (world, entries, reason) => { snapshots.push({ world, reason, count: entries.length }); } });
  const result = await store.rollback(port, { world: '天枢阁', entries: [entry('9', 'Z', '备份')] });

  assert.equal(result.ok, true);
  assert.equal(snapshots.length, 1, '回滚前必须备一次');
  assert.equal(snapshots[0].reason, '回滚前自动备份');
  assert.equal(snapshots[0].count, 1, '备的是**当前**状态（1 条），不是备份里那份');
});
