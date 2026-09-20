/**
 * 草稿视图（agent/wb_view.ts）：
 *  - create 后立刻 edit / read 能不能看到刚建的条目
 *  - 同一条改两次不丢第一处改动
 *  - entryVersion 稳定、且只跟内容字段有关
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = 'file:///C:/tavern_helper_template-main/src/苍玄助手/';
const { createDraftView, entryVersion } = await import(root + 'agent/wb_view.ts');
const { createDraftStore } = await import(root + 'agent/draft.ts');

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
    extra: { raw: 'keep' },
    ...over,
  };
}

function makePort(seed) {
  const worlds = new Map(Object.entries(seed));
  return {
    writes: [],
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
          if (item.content.includes(keyword) || item.name.includes(keyword)) {
            hits.push({ world, uid: item.uid, name: item.name, snippet: item.content.slice(0, 20), hits: 1 });
          }
        }
      }
      return hits;
    },
    async createWorldbook(name) {
      worlds.set(name, []);
    },
    async deleteWorldbook(name) {
      worlds.delete(name);
    },
    async writeAll(world, entries) {
      this.writes.push({ world, entries });
      worlds.set(
        world,
        entries.map(e => structuredClone(e)),
      );
    },
  };
}

test('草稿视图：create 之后立刻 edit / read 都能看到刚建的条目', async () => {
  const base = makePort({ 甲本: [] });
  const drafts = createDraftStore();
  const view = createDraftView(base, drafts);

  drafts.addChange({
    kind: 'create',
    world: '甲本',
    uid: 'new1',
    label: '新条目',
    before: '',
    after: '初稿正文',
    payload: { name: '新条目', content: '初稿正文' },
  });
  assert.deepEqual((await base.readAll('甲本')).length, 0, '真实端口还没这条');
  const created = await view.readByUid('甲本', ['new1']);
  assert.equal(created.length, 1, '视图里要能看到刚建的条目');
  assert.equal(created[0].content, '初稿正文');

  drafts.addChange({
    kind: 'edit',
    world: '甲本',
    uid: 'new1',
    label: '新条目',
    before: '初稿正文',
    after: '改过的正文',
    payload: {},
  });
  const edited = await view.readByUid('甲本', ['new1']);
  assert.equal(edited[0].content, '改过的正文');
  assert.equal((await view.readAll('甲本')).length, 1);
  assert.equal(base.writes.length, 0, '视图不许自己 writeAll');
});

test('草稿视图：同一条改两次，两处改动都在（不丢第一处）', async () => {
  const base = makePort({ 甲本: [entry('1', '甲', '总部在苍梧山，掌门为凌霄真人')] });
  const drafts = createDraftStore();
  const view = createDraftView(base, drafts);

  drafts.addChange({
    kind: 'edit',
    world: '甲本',
    uid: '1',
    label: '甲',
    before: (await view.readByUid('甲本', ['1']))[0].content,
    after: '总部位于苍梧山巅，掌门为凌霄真人',
    payload: {},
  });
  // 第二次改：基于视图里（已含第一处改动）的正文
  const afterFirst = (await view.readByUid('甲本', ['1']))[0].content;
  assert.match(afterFirst, /苍梧山巅/, '第二次改之前要能看到第一处改动');
  drafts.addChange({
    kind: 'edit',
    world: '甲本',
    uid: '1',
    label: '甲',
    before: afterFirst,
    after: afterFirst + '\n口头禅："此事须从长计议"',
    payload: {},
  });

  const merged = (await view.readByUid('甲本', ['1']))[0];
  assert.match(merged.content, /苍梧山巅/, '第一处改动不能丢');
  assert.match(merged.content, /口头禅/);

  // 落地时也要两处都在
  const report = await drafts.apply(base);
  assert.equal(report.ok, true);
  const written = base.writes[0].entries[0];
  assert.match(written.content, /苍梧山巅/);
  assert.match(written.content, /口头禅/);
  assert.equal(written.extra.raw, 'keep', 'extra 原样带回');
});

test('草稿视图：delete / meta 也先套在视图上；search 看的是草稿后的内容', async () => {
  const base = makePort({ 甲本: [entry('1', '甲', '老内容'), entry('2', '乙', '乙内容')] });
  const drafts = createDraftStore();
  const view = createDraftView(base, drafts);

  drafts.addChange({ kind: 'delete', world: '甲本', uid: '2', label: '乙', before: '乙内容', after: '', payload: {} });
  assert.deepEqual((await view.readByUid('甲本', ['2'])).length, 0, '视图里已删');
  assert.equal((await base.readAll('甲本')).length, 2, '真实数据没动');

  drafts.addChange({
    kind: 'meta',
    world: '甲本',
    uid: '1',
    label: '甲',
    before: '',
    after: '',
    payload: { strategy: 'constant', keys: ['新词'] },
  });
  const meta = (await view.readByUid('甲本', ['1']))[0];
  assert.equal(meta.strategy, 'constant');
  assert.deepEqual(meta.keys, ['新词']);

  // 草稿造出来的新词，search 要能搜到
  drafts.addChange({
    kind: 'create',
    world: '甲本',
    uid: 'new9',
    label: '丙',
    before: '',
    after: '这是刚写的专属词',
    payload: { name: '丙', content: '这是刚写的专属词' },
  });
  const hits = await view.search(['甲本'], '专属词', 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].uid, 'new9');
});

test('entryVersion：稳定短 hash，内容/标题/开关/关键词变了就变', () => {
  const base = entry('1', '甲', '正文');
  const version = entryVersion(base);
  assert.match(version, /^[0-9a-f]{8}$/, '短 hash');
  assert.equal(entryVersion(entry('1', '甲', '正文')), version, '同内容稳定');
  assert.equal(entryVersion({ ...base, position: 9, depth: 1, order: 2 }), version, '位置类字段不参与');
  assert.notEqual(entryVersion({ ...base, content: '正文改' }), version);
  assert.notEqual(entryVersion({ ...base, name: '乙' }), version);
  assert.notEqual(entryVersion({ ...base, enabled: false }), version);
  assert.notEqual(entryVersion({ ...base, strategy: 'constant' }), version);
  assert.notEqual(entryVersion({ ...base, keys: ['k', 'k2'] }), version);
  assert.notEqual(entryVersion({ ...base, keys_secondary: { logic: 'and_all', keys: [] } }), version);
  // 长度前缀防串味：['ab','c'] 和 ['a','bc'] 不能撞
  assert.notEqual(entryVersion({ ...base, keys: ['ab', 'c'] }), entryVersion({ ...base, keys: ['a', 'bc'] }));
});
