/**
 * 验收补充：agent/draft.ts —— 逐行 diff、草稿仓、草稿落地（apply）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const agent = '../../src/苍玄助手/agent/';
const {
  DraftStore,
  createDraftStore,
  splitLines,
  lineDiff,
  changedLines,
  compactDiff,
  diffStat,
  formatDiff,
  formatStat,
  encodeMetaFields,
  applyChangesToEntries,
  entryFromPayload,
  describeChange,
} = await import(agent + 'draft.ts');

function portOf(seed = {}, over = {}) {
  const worlds = new Map(Object.entries(seed));
  const writes = [];
  return {
    writes,
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
      return (worlds.get(world) ?? []).filter(entry => uids.includes(entry.uid)).map(entry => structuredClone(entry));
    },
    async search() {
      return [];
    },
    async createWorldbook() {},
    async deleteWorldbook() {},
    async writeAll(world, entries) {
      if (over.failWorld === world) throw new Error('写回失败（假）');
      writes.push({ world, entries });
      worlds.set(world, entries.map(entry => structuredClone(entry)));
    },
  };
}

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

function change(over) {
  return {
    id: 'c1',
    kind: 'edit',
    world: '天枢阁',
    uid: '1',
    label: 'A',
    before: 'a',
    after: 'b',
    payload: {},
    at: 1,
    ...over,
  };
}

/* ============================ diff ============================ */

test('draft: lineDiff 相同文本全 same；增删行/行号正确', () => {
  const diff = lineDiff('甲\n乙\n丙', '甲\n乙改了\n丙');
  assert.deepEqual(diff.map(line => line.type), ['same', 'del', 'add', 'same'], 'LCS 的删/加顺序');
  assert.equal(diff[0].text, '甲');
  assert.equal(diff[0].old_line, 1);
  assert.equal(diff[0].new_line, 1);
  assert.equal(diff[1].text, '乙');
  assert.equal(diff[1].old_line, 2);
  assert.equal(diff[2].text, '乙改了');
  assert.equal(diff[2].new_line, 2);
  assert.equal(diff[3].text, '丙');
  assert.equal(diff[3].old_line, 3);
  assert.equal(diff[3].new_line, 3);
  assert.deepEqual(diffStat(diff), { add: 1, del: 1 });
  assert.deepEqual(changedLines(diff).map(line => line.type + ':' + line.text), ['del:乙', 'add:乙改了']);
  assert.deepEqual(lineDiff('一样', '一样').map(line => line.type), ['same']);
});

test('draft: lineDiff 空串 / CRLF / 只增行 / 只删行', () => {
  assert.deepEqual(splitLines(''), []);
  // 只是把 \r\n / \r 统一成 \n，不裁尾：文本以换行结尾时会多出一个空行（diff 里显示为空行）
  assert.deepEqual(splitLines('a\r\nb\r'), ['a', 'b', '']);
  assert.deepEqual(lineDiff('甲\r\n乙', '甲\n乙').map(line => line.type), ['same', 'same'], '换行符差异不算改动');
  assert.deepEqual(lineDiff('', 'a').map(line => line.type), ['add']);
  assert.deepEqual(lineDiff('a', '').map(line => line.type), ['del']);
  const added = lineDiff('甲', '甲\n乙');
  assert.deepEqual(added.map(line => line.type), ['same', 'add']);
  assert.equal(added[1].new_line, 2);
});

test('draft: 超长文本走整段替换（不做 LCS），照样给出全量增删行', () => {
  const before = Array.from({ length: 2100 }, (_, i) => '旧 ' + i).join('\n');
  const after = Array.from({ length: 2100 }, (_, i) => '新 ' + i).join('\n');
  const started = Date.now();
  const diff = lineDiff(before, after);
  assert.equal(diff.length, 4200, '2100 删 + 2100 加');
  assert.deepEqual(diffStat(diff), { add: 2100, del: 2100 });
  assert.ok(diff.slice(0, 2100).every(line => line.type === 'del'));
  assert.ok(diff.slice(2100).every(line => line.type === 'add'));
  assert.ok(Date.now() - started < 5000, '不能卡死');
});

test('draft: changedLines / compactDiff / formatDiff / formatStat', () => {
  const diff = lineDiff('一\n二\n三\n四\n五', '一\n二\n三改了\n四\n五');
  assert.deepEqual(changedLines(diff).map(line => line.type + ':' + line.text), ['del:三', 'add:三改了']);
  assert.equal(formatDiff(changedLines(diff)), '- 三\n+ 三改了');
  assert.equal(formatDiff(diff, { only_changed: true }), '- 三\n+ 三改了');
  const compact = compactDiff(diff, 1);
  assert.equal(compact[0].type, 'same');
  assert.equal(compact[0].text, '…', '省略号打头');
  assert.ok(compact.length < diff.length && compact.length > changedLines(diff).length);
  assert.equal(formatDiff(diff).split('\n')[0], '  一', '默认全量 diff');
  assert.equal(formatStat({ add: 0, del: 0 }), '无变化');
  assert.equal(formatStat({ add: 2, del: 0 }), '+2');
  assert.equal(formatStat({ add: 2, del: 1 }), '+2 -1');
  assert.equal(encodeMetaFields({ strategy: 'constant', keys: ['a'] }), 'strategy: "constant"\nkeys: ["a"]');
});

/* ============================ 草稿仓 ============================ */

test('draft: add() 兼容 DraftSink 的三种接法（create / meta / edit / delete）', () => {
  const store = new DraftStore();
  const created = store.add('天枢阁', '', 'create', JSON.stringify({ name: '新条', content: '正文' }), '正文', '');
  assert.equal(created.kind, 'create');
  assert.equal(created.label, '新条', 'create 时 label 从 payload.name 兜底');
  assert.equal(created.before, '');
  assert.equal(created.after, '正文');
  assert.equal(created.payload.name, '新条');

  const meta = store.add('天枢阁', '1', 'meta', JSON.stringify({ strategy: 'selective' }), JSON.stringify({ strategy: 'constant' }), 'A');
  assert.equal(meta.before, 'strategy: "selective"');
  assert.equal(meta.after, 'strategy: "constant"');
  assert.equal(meta.payload.strategy, 'constant');

  const edit = store.add('天枢阁', '1', 'edit', '旧的', '新的', 'A');
  assert.equal(edit.before, '旧的');
  assert.equal(edit.after, '新的');
  assert.deepEqual(edit.payload, {});

  const removed = store.add('天枢阁', '2', 'delete', '要删的', '', 'B');
  assert.equal(removed.kind, 'delete');
  assert.equal(store.count(), 4);
  assert.equal(store.seqNo(), 4);
});

test('draft: diffs / summary / describeChange；delete 的 diff 是全删', () => {
  const store = createDraftStore([
    change({ id: 'c1', label: 'A', before: '一\n二', after: '一\n二改' }),
    change({ id: 'c2', uid: '2', label: 'B', kind: 'delete', before: 'x\ny', after: '' }),
    change({ id: 'c3', label: '', uid: '3', before: '', after: '' }),
  ]);
  const diffs = store.diffs();
  assert.equal(diffs.length, 3);
  assert.deepEqual(diffs[0].stat, { add: 1, del: 1 });
  assert.match(diffs[0].text, /^\+ 二改$/m);
  assert.deepEqual(diffs[1].stat, { add: 0, del: 2 }, '删除 = 全删');
  assert.deepEqual(store.summary(), ['A · +1 -1', 'B · -2', '无变化'], 'label 为空时不加前缀');
  assert.equal(describeChange(store.list()[0]), '修改 · A');
  assert.equal(describeChange(store.list()[1]), '删除 · B');
  assert.equal(describeChange(change({ kind: 'worldbook', label: '', uid: '' })), '世界书 · 天枢阁');
  assert.equal(describeChange(change({ kind: 'worldbook', label: '' })), '世界书 · 1', 'label 空退 uid，再退世界书');
});

test('draft: get / remove / removeWorld / ofWorld / clear / 默认值补齐', () => {
  const store = createDraftStore([
    change({ id: 'c1', world: '甲本' }),
    change({ id: 'c2', world: '甲本' }),
    change({ id: 'c3', world: '乙本' }),
  ]);
  assert.equal(store.get('c2').uid, '1');
  assert.equal(store.get('没有'), undefined);
  assert.deepEqual(store.ofWorld('甲本').map(item => item.id), ['c1', 'c2']);
  assert.equal(store.removeWorld('甲本'), 2);
  assert.equal(store.count(), 1);
  assert.equal(store.remove('c3'), true);
  assert.equal(store.remove('c3'), false);
  assert.equal(store.count(), 0);

  const loose = createDraftStore([{ kind: 'edit' }]);
  const item = loose.list()[0];
  assert.match(item.id, /^draft_/);
  assert.equal(item.world, '');
  assert.equal(typeof item.at, 'number');
  assert.ok(item.at > 0);
  loose.clear();
  assert.equal(loose.count(), 0);
});

/* ============================ 落地 apply ============================ */

test('draft: apply 逐本世界书分组落地，成功才摘草稿，失败留着', async () => {
  const port = portOf({ 甲本: [entry('1', 'A', 'aaa')], 乙本: [entry('2', 'B', 'bbb')] }, { failWorld: '乙本' });
  const store = createDraftStore([
    change({ id: 'c1', world: '甲本', uid: '1', before: 'aaa', after: 'AAA' }),
    change({ id: 'c2', world: '乙本', uid: '2', before: 'bbb', after: 'BBB' }),
  ]);

  const report = await store.apply(port);
  assert.equal(report.ok, false);
  assert.equal(report.applied, 1);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.worlds, [
    { world: '甲本', ok: true, applied: 1, total: 1 },
    { world: '乙本', ok: false, applied: 0, total: 1, error: '写回失败（假）' },
  ]);
  assert.deepEqual(report.remain.map(item => item.id), ['c2']);
  assert.equal(port.writes.length, 1);
  assert.equal(port.writes[0].world, '甲本');
  assert.equal(port.writes[0].entries[0].content, 'AAA');
  assert.equal(port.writes[0].entries[0].extra.raw_field, 'keep-me', '写回要带着 extra');

  // 修好之后重试：只剩失败的那条
  const retry = await store.apply(portOf({ 乙本: [entry('2', 'B', 'bbb')] }));
  assert.equal(retry.ok, true);
  assert.equal(retry.applied, 1);
  assert.equal(store.count(), 0);
});

test('draft: apply 支持只落指定世界书；没写世界书名的草稿报错但不丢', async () => {
  const port = portOf({ 甲本: [entry('1', 'A', 'a')] });
  const store = createDraftStore([
    change({ id: 'c1', world: '甲本', uid: '1', before: 'a', after: 'A' }),
    change({ id: 'c2', world: '乙本', uid: '2', before: 'b', after: 'B' }),
  ]);
  const one = await store.apply(port, { world: '甲本' });
  assert.equal(one.applied, 1);
  assert.deepEqual(one.remain.map(item => item.id), ['c2']);

  const noWorld = createDraftStore([change({ id: 'c9', world: '', uid: '3', before: 'x', after: 'y' })]);
  const report = await noWorld.apply(port);
  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
  assert.match(report.worlds[0].error, /没有指定世界书名/);
  assert.equal(noWorld.count(), 1);
});

test('draft: apply 把 readAll 找不到 uid 的警告带进 report', async () => {
  const port = portOf({ 天枢阁: [entry('1', 'A', 'a')] });
  const store = createDraftStore([change({ id: 'c1', world: '天枢阁', uid: '404', before: 'x', after: 'y' })]);
  const report = await store.apply(port);
  assert.equal(report.ok, true, '读到了世界书就算成功（只是这条被跳过）');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /天枢阁：找不到 uid 404/);
  assert.equal(store.count(), 0);
});

/* ============================ 套用算法（纯函数） ============================ */

test('draft: applyChangesToEntries 不改入参，edit / delete / meta / create 都生效', () => {
  const original = [entry('1', 'A', 'aaa'), entry('2', 'B', 'bbb'), entry('3', 'C', 'ccc')];
  const snapshot = structuredClone(original);
  const changes = [
    change({ id: 'c1', kind: 'edit', uid: '1', before: 'aaa', after: 'A1' }),
    change({ id: 'c2', kind: 'delete', uid: '2', before: 'bbb', after: '' }),
    change({
      id: 'c3',
      kind: 'meta',
      uid: '3',
      payload: { strategy: 'constant', keys: ['甲', '乙'], scan_depth: 9, enabled: false, name: 'C改' },
      before: '',
      after: '',
    }),
    change({
      id: 'c4',
      kind: 'create',
      uid: '',
      payload: { name: '新条', content: '新正文', strategy: 'constant', keys: ['新'] },
      before: '',
      after: '新正文',
    }),
  ];
  const merged = applyChangesToEntries(original, changes);
  assert.deepEqual(original, snapshot, '纯函数不能改入参');
  assert.deepEqual(merged.warnings, []);
  assert.deepEqual(merged.entries.map(item => item.name), ['A', 'C改', '新条']);
  assert.equal(merged.entries[0].content, 'A1');
  assert.equal(merged.entries[1].content, 'ccc', 'meta 不许动正文');
  assert.equal(merged.entries[1].strategy, 'constant');
  assert.deepEqual(merged.entries[1].keys, ['甲', '乙']);
  assert.equal(merged.entries[1].scan_depth, 9);
  assert.equal(merged.entries[1].enabled, false);
  assert.equal(merged.entries[1].extra.raw_field, 'keep-me', 'meta 不许动 extra');
  assert.equal(merged.entries[2].content, '新正文');
  assert.equal(merged.entries[2].strategy, 'constant');
});

test('draft: applyChangesToEntries 的警告：uid 找不到 / create 撞车 / 未知类型', () => {
  const entries = [entry('1', 'A', 'a')];
  const merged = applyChangesToEntries(entries, [
    change({ id: 'c1', kind: 'edit', uid: '404', before: 'x', after: 'y' }),
    change({ id: 'c2', kind: 'create', uid: '1', payload: { name: '撞车' }, after: 'z' }),
    change({ id: 'c3', kind: 'worldbook', uid: '1' }),
  ]);
  assert.equal(merged.entries.length, 2, '撞车的 create 换个 uid 保留');
  assert.match(merged.warnings[0], /找不到 uid 404/);
  assert.match(merged.warnings[1], /新建条目 uid 撞车/);
  assert.match(merged.warnings[2], /未知草稿类型：worldbook/);
  assert.match(merged.entries[1].uid, /^entry_/, '撞车后换新 uid');
});

test('draft: meta 只改 payload 里出现的字段（包括 constant 简写）', () => {
  const merged = applyChangesToEntries([entry('1', 'A', '正文', { keys: ['旧'], depth: 7 })], [
    change({ id: 'c1', kind: 'meta', uid: '1', payload: { constant: true } }),
  ]);
  const item = merged.entries[0];
  assert.equal(item.strategy, 'constant', 'constant:true 是 strategy 简写');
  assert.deepEqual(item.keys, ['旧'], '没给的字段不动');
  assert.equal(item.depth, 7);
  assert.equal(item.name, 'A');
  assert.equal(item.content, '正文');
});

test('draft: entryFromPayload 归一化各种入参形态', () => {
  const item = entryFromPayload(
    {
      name: 'N',
      content: 'C',
      strategy: 'vectorized',
      keys: '甲,乙\n丙',
      keys_secondary: { logic: 'not_any', keys: ['丁'] },
      scan_depth: '6',
      enabled: 'false',
      position: '2',
      depth: '3.9',
      order: 7,
      extra: { 自定义: 1 },
    },
    '9',
  );
  assert.equal(item.uid, '9');
  assert.equal(item.strategy, 'vectorized');
  assert.deepEqual(item.keys, ['甲', '乙', '丙'], '逗号/换行都要能切');
  assert.deepEqual(item.keys_secondary, { logic: 'not_any', keys: ['丁'] });
  assert.equal(item.scan_depth, 6, '字符串数字也认');
  assert.equal(item.enabled, false);
  assert.equal(item.position, 2);
  assert.equal(item.depth, 3.9, 'depth 不取整（只有 scan_depth 走 Math.trunc）');
  assert.equal(item.order, 7);
  assert.deepEqual(item.extra, { 自定义: 1 });

  const fallback = entryFromPayload({}, '');
  assert.match(fallback.uid, /^entry_/, '没 uid 时自动发一个');
  assert.equal(fallback.strategy, 'selective');
  assert.equal(fallback.scan_depth, 'same_as_global');
  assert.equal(fallback.depth, 4);
  assert.equal(fallback.order, 100);
  assert.equal(fallback.enabled, true);
  assert.deepEqual(fallback.keys_secondary, { logic: 'and_any', keys: [] });

  const shorthand = entryFromPayload({ constant: false, keys: ['x'], keys_secondary: ['y'] }, '3');
  assert.equal(shorthand.strategy, 'selective', 'constant:false = 绿灯');
  assert.deepEqual(shorthand.keys_secondary, { logic: 'and_any', keys: ['y'] });
});
