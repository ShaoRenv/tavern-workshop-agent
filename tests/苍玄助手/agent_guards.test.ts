/**
 * 三个守卫（agent/guards.ts）：
 *  - observe-guard：NOT_OBSERVED / STALE / 读后记录
 *  - prune-guard  ：8192 / 8193 边界，只标记不改 detail
 *  - repeat-guard ：第 3/5/8 次建议、绝不阻断、新用户消息清零
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = 'file:///C:/tavern_helper_template-main/src/苍玄助手/';
const {
  PRUNE_LIMIT,
  PRUNE_HEAD,
  PRUNE_TAIL,
  PRUNE_MARKER,
  createObservationLog,
  createObserveGuard,
  createPruneGuard,
  createRepeatGuard,
  createToolGuards,
  pruneForModel,
  stableStringify,
} = await import(root + 'agent/guards.ts');
const { createDraftStore } = await import(root + 'agent/draft.ts');
const { createDraftView } = await import(root + 'agent/wb_view.ts');

function entry(uid, name, content) {
  return {
    uid,
    name,
    content,
    enabled: true,
    strategy: 'selective',
    keys: [],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
    position: 0,
    depth: 4,
    order: 100,
    extra: {},
  };
}

function makePort(seed) {
  const worlds = new Map(Object.entries(seed));
  return {
    worlds,
    async list() {
      return [...worlds.keys()];
    },
    async current() {
      return [...worlds.keys()];
    },
    async readAll(world) {
      return structuredClone(worlds.get(world) ?? []);
    },
    async readByUid(world, uids) {
      return (worlds.get(world) ?? []).filter(e => uids.includes(e.uid)).map(e => structuredClone(e));
    },
    async search(list, keyword) {
      const hits = [];
      for (const world of list) {
        for (const item of worlds.get(world) ?? []) {
          if (item.content.includes(keyword))
            hits.push({ world, uid: item.uid, name: item.name, snippet: '', hits: 1 });
        }
      }
      return hits;
    },
    async createWorldbook() {},
    async deleteWorldbook() {},
    async writeAll() {},
  };
}

function ctxOf(worlds = ['甲本'], observations) {
  return { worlds, drafts: createDraftStore(), skills: [], ...(observations ? { observations } : {}) };
}

/* ---------------- observe ---------------- */

test('observe-guard：没读过就改 → NOT_OBSERVED（DSH 文案）', async () => {
  const port = makePort({
    甲本: [entry('1', '甲条目', '正文'), entry('2', '乙条目', '正文2')],
  });
  const observations = createObservationLog();
  const guard = createObserveGuard(port, observations);
  const ctx = ctxOf();

  // meta / delete 同样要先读过（uid 2 没读过）
  assert.equal(
    (await guard.before({ name: 'entry_meta', args: { world: '甲本', uid: '2' }, ctx, round: 1 }))?.code,
    'NOT_OBSERVED',
  );
  assert.equal(
    (await guard.before({ name: 'entry_delete', args: { world: '甲本', uid: '2' }, ctx, round: 1 }))?.code,
    'NOT_OBSERVED',
  );

  const blocked = await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 });
  assert.ok(blocked, '必须先读');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'NOT_OBSERVED');
  assert.equal(blocked.detail, 'cannot modify "甲条目": entry has not been read — wb_read it, then retry');
  assert.match(blocked.brief, /甲条目/);

  // wb_read 成功后记录观察 → 放行
  await guard.after(
    { name: 'wb_read', args: { world: '甲本', uid: '1' }, ctx, round: 1 },
    { ok: true, brief: '读到 1 条', detail: '...' },
  );
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 }), null);

  // 只读工具不管
  assert.equal(await guard.before({ name: 'wb_list', args: {}, ctx, round: 1 }), null);
  // 条目本身不存在 → 交给工具报 NOT_FOUND，不当成「没读过」
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '不存在' }, ctx, round: 1 }), null);
  // 唯一一本时不用写 world
  assert.equal(
    await guard.before({ name: 'entry_edit', args: { uid: '1' }, ctx: ctxOf(['甲本']), round: 1 }),
    null,
    '本轮只勾一本时按那本解析',
  );
});

test('observe-guard：读过之后条目变了 → STALE', async () => {
  const port = makePort({ 甲本: [entry('1', '甲条目', '旧正文')] });
  const observations = createObservationLog();
  const guard = createObserveGuard(port, observations);
  const ctx = ctxOf();

  await guard.after(
    { name: 'wb_read', args: { world: '甲本', uid: '1' }, ctx, round: 1 },
    { ok: true, brief: '', detail: '' },
  );
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 }), null);

  // 模拟外部改动（别人改了世界书 / 草稿又动过）
  port.worlds.set('甲本', [entry('1', '甲条目', '被别人改过的正文')]);
  const stale = await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 2 });
  assert.ok(stale);
  assert.equal(stale.code, 'STALE');
  assert.match(stale.detail, /条目在读过之后变了，重新 wb_read 再改/);

  // 重新读过就放行
  await guard.after(
    { name: 'wb_read', args: { world: '甲本', uid: '1' }, ctx, round: 2 },
    { ok: true, brief: '', detail: '' },
  );
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 2 }), null);
});

test('observe-guard：记录的是草稿视图的版本（草稿改过也算「读过之后变了」）', async () => {
  const base = makePort({ 甲本: [entry('1', '甲条目', '旧正文')] });
  const drafts = createDraftStore();
  const view = createDraftView(base, drafts);
  const guard = createObserveGuard(view, createObservationLog());
  const ctx = ctxOf();

  await guard.after(
    { name: 'wb_read', args: { world: '甲本', uid: '1' }, ctx, round: 1 },
    { ok: true, brief: '', detail: '' },
  );
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 }), null);

  // 又往草稿里塞了一处改动 → 视图版本变了
  drafts.addChange({
    kind: 'edit',
    world: '甲本',
    uid: '1',
    label: '甲条目',
    before: '旧正文',
    after: '草稿改过',
    payload: {},
  });
  const stale = await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 });
  assert.ok(stale, '草稿视图的版本变了也要 STALE');
  assert.equal(stale.code, 'STALE');
});

test('observe-guard：分页读只记读到的那一页；wb_search 也记观察', async () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    entry(String(index + 1), 'E' + (index + 1), '内容 ' + (index + 1)),
  );
  const port = makePort({ 甲本: entries });
  const guard = createObserveGuard(port, createObservationLog());
  const ctx = ctxOf();

  await guard.after(
    { name: 'wb_read', args: { world: '甲本', offset: 3, limit: 2 }, ctx, round: 1 },
    { ok: true, brief: '', detail: '' },
  );
  // 第 4、5 条读过 → 放行；第 1 条没读 → 拦
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '4' }, ctx, round: 1 }), null);
  assert.equal(await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '5' }, ctx, round: 1 }), null);
  const notObserved = await guard.before({ name: 'entry_edit', args: { world: '甲本', uid: '1' }, ctx, round: 1 });
  assert.equal(notObserved?.code, 'NOT_OBSERVED');

  const guard2 = createObserveGuard(port, createObservationLog());
  const ctx2 = ctxOf();
  await guard2.after(
    { name: 'wb_search', args: { world: '甲本', keyword: '内容 7' }, ctx: ctx2, round: 1 },
    { ok: true, brief: '', detail: '' },
  );
  assert.equal(
    await guard2.before({ name: 'entry_edit', args: { world: '甲本', uid: '7' }, ctx: ctx2, round: 1 }),
    null,
  );
  assert.equal(
    (await guard2.before({ name: 'entry_edit', args: { world: '甲本', uid: '8' }, ctx: ctx2, round: 1 }))?.code,
    'NOT_OBSERVED',
  );
});

/* ---------------- prune ---------------- */

test('prune-guard：8192 不动、8193 标记 pruned，detail 本体一字不改', async () => {
  const guard = createPruneGuard();
  const input = { name: 'wb_read', args: {}, ctx: ctxOf(), round: 1 };

  const atLimit = 'x'.repeat(PRUNE_LIMIT);
  const kept = await guard.after(input, { ok: true, brief: 'b', detail: atLimit });
  assert.equal(kept.pruned, undefined, '8192 是边界内');
  assert.equal(kept.detail, atLimit);
  assert.equal(pruneForModel(atLimit), atLimit);

  const overLimit = 'y'.repeat(PRUNE_LIMIT + 1);
  const pruned = await guard.after(input, { ok: true, brief: 'b', detail: overLimit });
  assert.deepEqual(pruned.pruned, {
    original_chars: PRUNE_LIMIT + 1,
    kept_chars: PRUNE_HEAD + PRUNE_MARKER.length + PRUNE_TAIL,
  });
  assert.equal(pruned.detail, overLimit, 'detail 是会话日志原文，不许剪');
  const forModel = pruneForModel(overLimit);
  assert.equal(forModel.length, pruned.pruned.kept_chars);
  assert.equal(forModel.slice(0, PRUNE_HEAD), overLimit.slice(0, PRUNE_HEAD));
  assert.equal(forModel.slice(-PRUNE_TAIL), overLimit.slice(-PRUNE_TAIL));
  assert.match(forModel, /\[\.\.\. 中间已修剪 \.\.\.\]/);
});

/* ---------------- repeat ---------------- */

test('repeat-guard：第 3/5/8 次才建议、绝不阻断、参数规范化', async () => {
  const guard = createRepeatGuard();
  const ctx = ctxOf();
  const input = { name: 'wb_read', args: { world: '甲本', uid: '1' }, ctx, round: 1 };
  const counts = [];
  let result = { ok: true, brief: 'b', detail: 'd' };
  for (let times = 1; times <= 8; times++) {
    result = await guard.after(input, result);
    counts.push((result.contexts ?? []).length);
  }
  assert.deepEqual(counts, [0, 0, 1, 1, 2, 2, 2, 3], '只在 3/5/8 次追加建议');
  assert.equal(result.ok, true, '绝不阻断');
  const note = (result.contexts ?? [])[2];
  assert.equal(note.source, 'repeat-guard');
  assert.match(note.text, /换个方法|收工/);

  // 参数键顺序不同算同一组
  const swapped = { name: 'wb_read', args: { uid: '1', world: '甲本' }, ctx, round: 2 };
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(guard.countOf('wb_read', { world: '甲本', uid: '1' }), 8);
  assert.equal(
    (await guard.after(swapped, { ok: true, brief: 'b', detail: 'd' })).contexts,
    undefined,
    '键序不同 = 同一次',
  );

  // 别的工具/别的参数各算各的
  assert.equal(
    (await guard.after({ ...input, name: 'wb_list' }, { ok: true, brief: 'b', detail: 'd' })).contexts,
    undefined,
  );

  // 新用户消息 → reset
  guard.reset();
  assert.equal(guard.countOf('wb_read', { world: '甲本', uid: '1' }), 0);
  assert.equal((await guard.after(input, { ok: true, brief: 'b', detail: 'd' })).contexts, undefined);
});

/* ---------------- 默认装配 ---------------- */

test('createToolGuards：带端口 → observe+prune+repeat；不带 → prune+repeat；reset 清两份状态', async () => {
  const port = makePort({ 甲本: [entry('1', '甲', '正文')] });
  const set = createToolGuards({ port });
  assert.deepEqual(
    set.guards.map(guard => guard.name),
    ['observe-guard', 'prune-guard', 'repeat-guard'],
  );
  assert.ok(set.observe);

  // reset 同时清观察记录和重复计数
  set.observe.record('甲本', entry('1', '甲', '正文'));
  assert.ok(set.observations.seen('甲本', '1'));
  await set.repeat.after({ name: 'x', args: {}, ctx: ctxOf(), round: 1 }, { ok: true, brief: '', detail: '' });
  assert.equal(set.repeat.countOf('x', {}), 1);
  set.reset();
  assert.equal(set.observations.seen('甲本', '1'), undefined);
  assert.equal(set.repeat.countOf('x', {}), 0);

  const withoutPort = createToolGuards();
  assert.deepEqual(
    withoutPort.guards.map(guard => guard.name),
    ['prune-guard', 'repeat-guard'],
  );
  assert.equal(withoutPort.observe, undefined);
});
