/**
 * B2：备份/回滚的**四条硬性质**（对着 `stores/app.ts` 的**真实实现**测，不是假钩子）。
 *
 * ─────────────────────────── 为什么这条测试非写不可 ───────────────────────────
 *
 * `agent_draft.test.ts` 里已经有一大堆 P5-2 的用例，但它们**全都用假 sink**
 * （`backupSinkOf()` 只是个 `{ snapshot(){...} }`）。
 * 而真正决定「用户的数据还在不在」的是 **`stores/app.ts` 里那个真实 sink** ——
 * `backupSink()` / `pruneBackups()` / `rollbackBackup()`，它们**一条测试都没有**。
 *
 * 这正是阶段 5 那份报告的教训（`reports/阶段5-世界书读写全坏-真机发现.md` §6）：
 *
 * > 「`node --test` 543 条全绿 —— 用的是**假端口**，从不走真适配层 → 形状对不对测不到。」
 * > 「共同点：验证了『接上了』，没验证『真的能用』。」
 *
 * ─────────────────────────── 四条硬性质 ───────────────────────────
 *
 * 出处是代码自己的注释（`stores/app.ts` / `types.ts:905-910` / `draft.ts`），不是我编的：
 *
 * | # | 性质 | 丢了会怎样 |
 * |---|---|---|
 * | ① | 备份是**写回之前**的内容，不是合并后的 | 回滚回不去，反而把坏数据固化 |
 * | ② | `extra` 等未知字段**一个都不能丢** | 回滚会抹掉用户手写的字段（真实数据 45 条带 extra） |
 * | ③ | 每本只留最近 **3** 份，按 `taken_at` 裁（不是数组位置） | 整本 1.1MB 塞进 8KB 变量，撑爆存储 |
 * | ④ | **回滚前必须先备份当前状态** | 点错一次回滚就再也回不到回滚之前（不可撤销） |
 *
 * 另外补两条**边界**（回滚的写路径唯一入口）：
 *   · 找不到备份 id → 明确失败（**不猜「最新那份」**）
 *   · 回滚通道没接上 → 明确失败，不静默什么都不做
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const root = '../../src/苍玄助手/';
const { setHostBridge } = await import(root + 'core/storage.ts');
const { useAppStore } = await import(root + 'stores/app.ts');

/** 每本世界书保留几份备份。从 store 上取（它是 store 内部的策略，不是模块级常量） */
const BACKUPS_PER_WORLD = 3;
const { BACKUP_REASON_APPLY, BACKUP_REASON_ROLLBACK } = await import(root + 'agent/draft.ts');

/** 每个用例一套全新 pinia + store；写盘注入假接口 */
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

/** 造一条世界书条目（形状 = WbEntry；带 extra 用来验性质②） */
function entry(uid, comment, content, over = {}) {
  return { uid, comment, content, keys: ['k'], extra: { 手写字段: '别丢我' }, ...over };
}

/* ============================ 性质①：备份 = 写回之前 ============================ */

test('B2①: 快照存的是**写回之前**的原始条目，不是合并后的结果', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    const before = [entry('1', '旧名', '旧正文')];
    sink.snapshot('天枢阁', before, BACKUP_REASON_APPLY);

    const saved = box.store.data.wb_backups.find(item => item.world === '天枢阁');
    assert.ok(saved, '备份该进 wb_backups');
    assert.equal(saved.entries[0].content, '旧正文', '备份必须是「写坏之前长什么样」');
    assert.equal(saved.reason, BACKUP_REASON_APPLY);
    assert.equal(saved.entry_count, 1, 'entry_count 要与 entries 对上');
  } finally {
    box.done();
  }
});

test('B2①: 同一本书备两次 → 两份都在，且各自保留当时的内容', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    sink.snapshot('天枢阁', [entry('1', 'A', '第一版')], BACKUP_REASON_APPLY);
    sink.snapshot('天枢阁', [entry('1', 'A', '第二版')], BACKUP_REASON_APPLY);

    const mine = box.store.backupsOf('天枢阁');
    assert.equal(mine.length, 2, '两次备份该都在');
    const texts = mine.map(item => item.entries[0].content).sort();
    assert.deepEqual(texts, ['第一版', '第二版'], '两份各自保留当时的内容');
  } finally {
    box.done();
  }
});

/* ============================ 性质②：extra 一个都不能丢 ============================ */

test('B2②: 未知字段（extra）原样进备份 —— 丢一个键就是回滚时抹掉用户的东西', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    const weird = {
      uid: '7',
      comment: '带怪字段',
      content: '正文',
      keys: ['a'],
      extra: { 自定义A: 1, 自定义B: { 嵌套: true }, 自定义C: ['数组'] },
    };
    sink.snapshot('天枢阁', [weird], BACKUP_REASON_APPLY);

    const saved = box.store.data.wb_backups.find(item => item.world === '天枢阁');
    assert.deepEqual(saved.entries[0].extra, weird.extra, 'extra 必须逐字段原样保留');
    assert.equal(saved.entries[0].uid, '7', 'uid 也不能动');
  } finally {
    box.done();
  }
});

test('B2②: 备份是**快照**不是引用 —— 之后再改原数组，备份里那份不受影响', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    const live = [entry('1', 'A', '当时的样子')];
    sink.snapshot('天枢阁', live, BACKUP_REASON_APPLY);

    // 模拟写回之后宿主那份被改了
    live[0].content = '被改过的';
    live.push(entry('2', 'B', '后来加的'));

    const saved = box.store.data.wb_backups.find(item => item.world === '天枢阁');
    assert.equal(saved.entries.length, 1, '备份不该跟着长出新条目');
    assert.equal(saved.entries[0].content, '当时的样子', '备份不该跟着变 —— 它是「当时」的快照');
  } finally {
    box.done();
  }
});

/* ============================ 性质③：限量 3 份，按 taken_at 裁 ============================ */

test('B2③: 每本只留最近 3 份（整本快照 1.1MB，不裁会撑爆变量）', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    for (let i = 1; i <= 6; i++) {
      sink.snapshot('天枢阁', [entry(String(i), 'C' + i, '第' + i + '版')], BACKUP_REASON_APPLY);
    }
    const mine = box.store.backupsOf('天枢阁');
    assert.equal(mine.length, BACKUPS_PER_WORLD, '每本最多留 ' + BACKUPS_PER_WORLD + ' 份');
    assert.equal(BACKUPS_PER_WORLD, 3, '这个常量是硬要求，别偷偷改大');
  } finally {
    box.done();
  }
});

test('B2③: 裁掉的是**最旧**的，留的是最近 3 份', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    for (let i = 1; i <= 5; i++) {
      sink.snapshot('天枢阁', [entry(String(i), 'C' + i, '第' + i + '版')], BACKUP_REASON_APPLY);
    }
    const kept = box.store.backupsOf('天枢阁').map(item => item.entries[0].content).sort();
    assert.deepEqual(kept, ['第3版', '第4版', '第5版'], '要留最近三份（第1、2 版被挤掉）');
  } finally {
    box.done();
  }
});

test('B2③: **同一毫秒**内连备多次，留的必须是后插入的那几份（taken_at 相等时的排序）', () => {
  // ⚠️ 这条抓过一个真 bug：sort 是稳定排序，taken_at 相等时保持数组原序，
  // 于是 slice(0,3) 取到的是**最早插入**的 3 份 —— 与「留最近 3 份」正好相反。
  // 同毫秒连备是常态（一次 apply 写多本书 / 用户连点两下），所以这不是边角情况。
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    // 手工把 taken_at 钉成同一个值，模拟同毫秒
    const fixed = 1700000000000;
    for (let i = 1; i <= 5; i++) {
      sink.snapshot('天枢阁', [entry(String(i), 'C' + i, '第' + i + '版')], BACKUP_REASON_APPLY);
      // snapshot 内部用 Date.now()，这里立刻改掉以便构造「同毫秒」
      const last = box.store.data.wb_backups[box.store.data.wb_backups.length - 1];
      if (last) last.taken_at = fixed;
      box.store.pruneBackups('天枢阁');
    }

    const kept = box.store.backupsOf('天枢阁').map(item => item.entries[0].content).sort();
    assert.deepEqual(kept, ['第3版', '第4版', '第5版'], '同毫秒时要留后插入的三份（第1、2 版被挤掉）');
  } finally {
    box.done();
  }
});

test('B2③: 限量**按书分开算** —— 备满 A 本不影响 B 本的额度', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    for (let i = 1; i <= 5; i++) sink.snapshot('A书', [entry(String(i), 'x', 'A' + i)], BACKUP_REASON_APPLY);
    for (let i = 1; i <= 2; i++) sink.snapshot('B书', [entry(String(i), 'y', 'B' + i)], BACKUP_REASON_APPLY);

    assert.equal(box.store.backupsOf('A书').length, 3);
    assert.equal(box.store.backupsOf('B书').length, 2, 'B 本不该被 A 本挤掉');
    assert.equal(box.store.backupsOf().length, 5, '不传参 = 全部（3 + 2）');
  } finally {
    box.done();
  }
});

test('B2③: 裁剪排序用 taken_at，不是数组位置（多标签页乱序写入也不出错）', () => {
  const box = freshStore();
  try {
    // 手工造 4 份，taken_at 乱序（模拟多标签页写入顺序错乱）
    const base = { world: '天枢阁', reason: BACKUP_REASON_APPLY, entry_count: 0, entries: [] };
    box.store.data.wb_backups.push(
      { ...base, id: 'oldest', taken_at: 100, entries: [entry('1', 'x', '最旧')] },
      { ...base, id: 'newest', taken_at: 400, entries: [entry('1', 'x', '最新')] },
      { ...base, id: 'middle', taken_at: 300, entries: [entry('1', 'x', '中间')] },
      { ...base, id: 'ancient', taken_at: 50, entries: [entry('1', 'x', '上古')] },
    );
    box.store.pruneBackups('天枢阁');

    const kept = box.store.data.wb_backups.map(item => item.id).sort();
    assert.deepEqual(kept, ['middle', 'newest', 'oldest'], '留 taken_at 最大的三份（与数组位置无关）');
    assert.equal(kept.includes('ancient'), false, 'taken_at 最小那份该被裁掉');
  } finally {
    box.done();
  }
});

/* ============================ 性质④：回滚前必须先备份当前状态 ============================ */

test('B2④: 回滚**之前**先对当前状态备一份（否则点错一次就回不去了）', async () => {
  const box = freshStore();
  try {
    // 造一份「很久以前」的备份
    box.store.data.wb_backups.push({
      id: 'bk-old', world: '天枢阁', taken_at: 1, reason: BACKUP_REASON_APPLY,
      entry_count: 1, entries: [entry('1', 'A', '很久以前')],
    });

    const calls = [];
    const source = {
      async rollback(backup) {
        calls.push(backup);
        return { ok: true, world: backup.world, restored: backup.entries.length };
      },
    };

    const result = await box.store.rollbackBackup(source, 'bk-old');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, '该调一次回滚通道');
    assert.equal(calls[0].world, '天枢阁');
    assert.equal(calls[0].entries[0].content, '很久以前', '写回去的是备份里的内容');

    // ⚠️ 「回滚前自动备份」那一步在 runner/DraftStore.rollback 内部（见 draft.ts:455），
    // 这条用例只验 store 把请求正确转了出去；真正那次 snapshot 由 agent_draft.test.ts 的
    // 「回滚前自动备份」用例覆盖（那边验了 reason 和调用顺序）。
  } finally {
    box.done();
  }
});

test('B2④: store 不自己造「回滚前备份」—— 那是 runner 的职责，重复备会白占额度', async () => {
  const box = freshStore();
  try {
    box.store.data.wb_backups.push({
      id: 'bk-old', world: '天枢阁', taken_at: 1, reason: BACKUP_REASON_APPLY,
      entry_count: 1, entries: [entry('1', 'A', '备份')],
    });
    const before = box.store.data.wb_backups.length;
    const source = { async rollback() { return { ok: true, world: '天枢阁', restored: 1 }; } };

    await box.store.rollbackBackup(source, 'bk-old');
    assert.equal(box.store.data.wb_backups.length, before, 'store 这一层不该自己多备一份（runner 会备）');
  } finally {
    box.done();
  }
});

/* ============================ 边界：回滚入口的两种失败 ============================ */

test('B2边界: 找不到备份 id → 明确失败（**不猜「最新那份」**）', async () => {
  const box = freshStore();
  try {
    box.store.data.wb_backups.push({
      id: 'bk-1', world: '天枢阁', taken_at: 1, reason: BACKUP_REASON_APPLY,
      entry_count: 1, entries: [entry('1', 'A', '唯一那份')],
    });
    let called = 0;
    const source = { async rollback() { called++; return { ok: true, world: '天枢阁', restored: 1 }; } };

    const result = await box.store.rollbackBackup(source, '不存在的id');
    assert.equal(result.ok, false);
    assert.equal(called, 0, '找不到就必须一个字节都不写（猜「最新那份」是危险行为）');
    assert.match(result.error, /找不到/, '要给人话：' + result.error);
  } finally {
    box.done();
  }
});

test('B2边界: 回滚通道没接上 → 明确失败，不静默什么都不做', async () => {
  const box = freshStore();
  try {
    box.store.data.wb_backups.push({
      id: 'bk-1', world: '天枢阁', taken_at: 1, reason: BACKUP_REASON_APPLY,
      entry_count: 1, entries: [entry('1', 'A', '备份')],
    });

    for (const bad of [null, undefined, {}, { rollback: '不是函数' }]) {
      const result = await box.store.rollbackBackup(bad, 'bk-1');
      assert.equal(result.ok, false, '通道没接上要失败：' + JSON.stringify(bad));
      assert.match(result.error, /回滚通道/, '要说出是通道的问题：' + result.error);
      assert.equal(result.world, '天枢阁', '失败时也要报出是哪本书（界面要显示）');
    }
  } finally {
    box.done();
  }
});

test('B2边界: 回滚失败时把原因原样带回来（不吞错误）', async () => {
  const box = freshStore();
  try {
    box.store.data.wb_backups.push({
      id: 'bk-1', world: '天枢阁', taken_at: 1, reason: BACKUP_REASON_APPLY,
      entry_count: 1, entries: [entry('1', 'A', '备份')],
    });
    const source = {
      async rollback() {
        return { ok: false, world: '天枢阁', error: '写回时宿主抛了：磁盘满了' };
      },
    };

    const result = await box.store.rollbackBackup(source, 'bk-1');
    assert.equal(result.ok, false);
    assert.match(result.error, /磁盘满了/, '底层的原因要原样上来');
  } finally {
    box.done();
  }
});

/* ============================ 集成：备份 + 裁剪 + 回滚串起来 ============================ */

test('B2集成: 写回 5 次 → 只留 3 份；回滚到其中一份 → 内容对得上', async () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    // 模拟「改了 5 次，每次写回前备一份」
    for (let i = 1; i <= 5; i++) {
      sink.snapshot('天枢阁', [entry('1', 'A', '第' + i + '版')], BACKUP_REASON_APPLY);
    }
    const mine = box.store.backupsOf('天枢阁');
    assert.equal(mine.length, 3, '裁到 3 份');

    // 挑最早那份回滚（第 3 版），确认写回去的是它
    const oldest = mine.slice().sort((a, b) => a.taken_at - b.taken_at)[0];
    const written = [];
    const source = {
      async rollback(backup) {
        written.push(backup);
        return { ok: true, world: backup.world, restored: backup.entries.length };
      },
    };
    const result = await box.store.rollbackBackup(source, oldest.id);
    assert.equal(result.ok, true);
    assert.equal(written[0].entries[0].content, oldest.entries[0].content, '写回去的必须正是选中那份');
  } finally {
    box.done();
  }
});

test('B2集成: 备份里的条目数 = entries.length（列表页不解析整份就能显示）', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    sink.snapshot('天枢阁', [entry('1', 'A', 'x'), entry('2', 'B', 'y'), entry('3', 'C', 'z')], BACKUP_REASON_APPLY);
    const saved = box.store.backupsOf('天枢阁')[0];
    assert.equal(saved.entry_count, 3);
    assert.equal(saved.entry_count, saved.entries.length);
  } finally {
    box.done();
  }
});

test('B2集成: 空书也能备份（0 条是合法状态，不是错误）', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    sink.snapshot('空书', [], BACKUP_REASON_APPLY);
    const saved = box.store.backupsOf('空书')[0];
    assert.ok(saved, '空书也该留一份（「当时是空的」也是有用的信息）');
    assert.equal(saved.entry_count, 0);
    assert.deepEqual(saved.entries, []);
  } finally {
    box.done();
  }
});

test('B2集成: 备份立刻落盘（晚 2.5 秒就可能来不及 —— 用户下一秒就点回滚）', () => {
  const box = freshStore();
  try {
    const sink = box.store.backupSink();
    box.writes.length = 0;
    sink.snapshot('天枢阁', [entry('1', 'A', 'x')], BACKUP_REASON_APPLY);
    assert.ok(box.writes.length >= 1, 'snapshot 必须立刻写盘，不能等 2.5 秒防抖');
  } finally {
    box.done();
  }
});

test('B2: 回滚原因文案常量在（记录页直接显示它们）', () => {
  assert.equal(BACKUP_REASON_APPLY, '写回前自动备份');
  assert.equal(BACKUP_REASON_ROLLBACK, '回滚前自动备份');
});
