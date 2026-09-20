/**
 * 验收回归（task-20）：世界书范围提示词、越权文案、wb_list 只列范围内、系统提示词不泄露范围外名字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { buildScopePrompt, outOfScopeError, scopeEmptyNotice, scopeNames } = await import(root + 'agent/tools_worldbook.ts');
const { createRegistry } = await import(root + 'agent/registry.ts');
const { setHostBridge } = await import(root + 'core/storage.ts');
const { RootDataSchema, PresetSchema } = await import(root + 'core/types.ts');
const { createRunner } = await import(root + 'run/runner.ts');

const SCOPE_EMPTY = '当前没有勾选任何世界书，读写都会失败，请先让用户去「世界书」页勾选。';

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

function makePort(seed = {}) {
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
      return (worlds.get(world) ?? []).filter(item => uids.includes(item.uid)).map(item => structuredClone(item));
    },
    async search(scope, keyword) {
      const hits = [];
      for (const world of scope) for (const item of worlds.get(world) ?? []) if (item.content.includes(keyword)) hits.push({ world, uid: item.uid, name: item.name, snippet: '', hits: 1 });
      return hits;
    },
    async createWorldbook() {},
    async deleteWorldbook() {},
    async writeAll(world, entries) {
      writes.push({ world, entries });
    },
  };
}

function ctxOf(port, worlds, over = {}) {
  return { worlds, drafts: { add() {}, count: () => 0 }, skills: [], ...over };
}

/* ============================ 范围提示词 ============================ */

test('scope: buildScopePrompt 三种范围（0 本 / 1 本 / 多本）', async () => {
  const port = makePort({ 甲本: [entry('1', 'A', 'a'), entry('2', 'B', 'b', { enabled: false })], 乙本: [entry('3', 'C', 'c')] });

  // 0 本：专门文案，不列任何书名
  assert.equal(await buildScopePrompt(port, []), SCOPE_EMPTY);
  assert.ok(!(await buildScopePrompt(port, [])).includes('甲本'));

  // 1 本：带条目数 / 启用数
  const one = await buildScopePrompt(port, ['甲本']);
  assert.equal(one, '本次你可以读改这些世界书：\n- 甲本（2 条，启用 1）\n范围外的世界书一律不可读写，也不要问它们的内容。若确实需要别的，请让用户去「世界书」页勾上。');

  // 多本：按传入顺序；空白名过滤
  const many = await buildScopePrompt(port, ['甲本', '乙本', '   ']);
  assert.match(many, /- 甲本（2 条，启用 1）\n- 乙本（1 条）/);
  assert.equal((many.match(/- /g) || []).length, 2, '空名字不能混进来');

  // 读不到条目数就不写括号
  const broken = { async readAll() { throw new Error('读不到'); } };
  assert.equal(await buildScopePrompt(broken, ['坏本']), '本次你可以读改这些世界书：\n- 坏本\n范围外的世界书一律不可读写，也不要问它们的内容。若确实需要别的，请让用户去「世界书」页勾上。');
});

test('scope: outOfScopeError / scopeNames / scopeEmptyNotice 文案', () => {
  assert.equal(scopeNames([' 甲本 ', '', '乙本']), '甲本、乙本');
  assert.equal(scopeNames([]), '');
  assert.equal(scopeEmptyNotice(), SCOPE_EMPTY);

  const text = outOfScopeError(['甲本', '乙本'], '别本');
  assert.equal(
    text,
    '《别本》不在本次可操作范围内。本次只能用：甲本、乙本。如果需要《别本》，请让用户去「世界书」页勾上。',
  );
  assert.match(outOfScopeError([], '别本'), /^当前没有勾选任何世界书/);
  assert.match(outOfScopeError([], '别本'), /你想动的是《别本》/);
  assert.match(outOfScopeError(['甲本'], ''), /没写名字的那一本/);
});

test('scope: wb_list 只列范围内的世界书，范围外的不出现', async () => {
  const port = makePort({ 甲本: [entry('1', 'A', 'a')], 别本: [entry('9', 'Z', 'z')] });
  const registry = createRegistry(port);

  const scoped = await registry.byName('wb_list').run({}, ctxOf(port, ['甲本']));
  assert.equal(scoped.ok, true);
  assert.match(scoped.brief, /^本次范围 1 本 · 列出 1 本 · 共 1 条（启用 1）$/);
  assert.match(scoped.detail, /甲本/);
  assert.ok(!scoped.detail.includes('别本'), '范围外的名字一个字都不许出现：' + scoped.detail);
  assert.ok(!scoped.brief.includes('别本'));

  const both = await registry.byName('wb_list').run({}, ctxOf(port, ['甲本', '别本']));
  assert.match(both.brief, /^本次范围 2 本 · 列出 2 本 · 共 2 条（启用 2）$/);
  assert.ok(both.detail.includes('甲本') && both.detail.includes('别本'));

  const none = await registry.byName('wb_list').run({}, ctxOf(port, []));
  assert.equal(none.ok, false);
  assert.equal(none.detail, SCOPE_EMPTY);
});

test('scope: 读 / 搜 / 建 / 改 / 删 / meta 六个入口的越权文案一致', async () => {
  const port = makePort({ 甲本: [entry('1', 'A', '甲本正文')], 别本: [entry('9', 'Z', '别本正文')] });
  const registry = createRegistry(port);
  const ctx = ctxOf(port, ['甲本']);

  const cases = [
    ['wb_read', { world: '别本', uid: '9' }],
    ['wb_search', { keyword: '正文', worlds: ['别本'] }],
    ['entry_create', { world: '别本', name: 'n', content: 'c' }],
    ['entry_edit', { world: '别本', uid: '9', old_string: '别本正文', new_string: 'x' }],
    ['entry_delete', { world: '别本', uid: '9' }],
    ['entry_meta', { world: '别本', uid: '9', strategy: 'constant' }],
  ];
  for (const [name, args] of cases) {
    const result = await registry.byName(name).run(args, ctx);
    assert.equal(result.ok, false, name + ' 不该放行越权');
    const text = result.brief + '\n' + result.detail;
    assert.match(text, /《别本》不在本次可操作范围内。本次只能用：甲本。/, name + ' 的越权文案：' + text);
    assert.match(text, /如果需要《别本》，请让用户去「世界书」页勾上。/, name);
  }

  // 一本都没勾：走「没有勾选任何世界书」那条文案
  const emptyCtx = ctxOf(port, []);
  for (const [name, args] of cases) {
    const result = await registry.byName(name).run(args, emptyCtx);
    assert.equal(result.ok, false, name);
    assert.match(result.brief + '\n' + result.detail, /当前没有勾选任何世界书/, name);
  }

  // 搜索不填 worlds 时只用范围；范围里搜不到范围外内容
  const scopedSearch = await registry.byName('wb_search').run({ keyword: '正文' }, ctx);
  assert.equal(scopedSearch.ok, true);
  assert.ok(scopedSearch.detail.includes('甲本'), scopedSearch.detail);
  assert.ok(!scopedSearch.detail.includes('别本正文'), '范围外正文不能漏出来');
});

test('scope: 范围只有 1 本时不写 world 也能命中那一本（读 / 写都算）', async () => {
  const port = makePort({ 甲本: [entry('1', 'A', '风起。云涌。')] });
  const registry = createRegistry(port);

  const read = await registry.byName('wb_read').run({ uid: '1' }, ctxOf(port, ['甲本']));
  assert.equal(read.ok, true, read.detail);
  assert.match(read.detail, /风起/);

  const drafts = { items: [], add(world, uid, kind, before, after, label) { this.items.push({ world, uid, kind, before, after, label }); }, count() { return this.items.length; } };
  const edit = await registry.byName('entry_edit').run({ uid: '1', old_string: '风起', new_string: '雷落' }, ctxOf(port, ['甲本'], { drafts }));
  assert.equal(edit.ok, true, edit.detail);
  assert.equal(drafts.items[0].world, '甲本', '唯一一本就算没写 world 也命中它');

  // 范围不止一本又没写 world → 要求指明
  const multi = await registry.byName('wb_read').run({ uid: '1' }, ctxOf(port, ['甲本', '乙本']));
  assert.equal(multi.ok, false);
  assert.match(multi.detail, /请指明 world（本次可操作范围：甲本、乙本）/);
});

/* ============================ 系统提示词里的范围 ============================ */

function installHost(seed) {
  const worlds = new Map(Object.entries(seed));
  const previousGenerate = globalThis.generateRaw;
  setHostBridge({
    getWorldbookNames: () => [...worlds.keys()],
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: name => structuredClone(worlds.get(name) ?? []),
    replaceWorldbook: () => {},
    createWorldbook: () => {},
    deleteWorldbook: () => true,
    insertOrAssignVariables: () => {},
  });
  return {
    restore() {
      setHostBridge(null);
      if (previousGenerate === undefined) delete globalThis.generateRaw;
      else globalThis.generateRaw = previousGenerate;
    },
  };
}

async function captureAgentSystem(selected) {
  const seen = { system: '' };
  globalThis.generateRaw = async config => {
    const system = config.ordered_prompts.find(prompt => prompt.role === 'system');
    seen.system = system ? system.content : '';
    return '收工。<SystemQuery>{"name":"submit","args":{"summary":"done"}}</SystemQuery>';
  };
  const runner = createRunner();
  const data = RootDataSchema.parse({});
  data.api = { route: 'tavern', url: '', key: '', model: '', stream: false, send_images: false, timeout_sec: 30 };
  data.selection.worldbook_names = selected;
  const preset = PresetSchema.parse({
    id: 'p',
    name: 'agent',
    items: [{ type: 'message', id: 'p-sys', role: 'system', content: '你是助手' }],
    use_global_caps: true,
    tools: ['submit'],
    max_rounds: 3,
  });
  await runner.runAgent({
    data,
    input: '干活',
    preset,
    history: [],
    signal: new AbortController().signal,
    onTurn: () => {},
    onToolUpdate: () => {},
    onArtifact: () => {},
    onNotice: () => {},
  });
  return seen.system;
}

test('scope: 系统提示词里有「本次可操作范围」，且范围外的世界书名一个字都不出现', async () => {
  const host = installHost({ 天枢阁: [entry('1', 'A', 'a')], 别本: [entry('9', 'Z', '范围外的秘密')] });
  try {
    const system = await captureAgentSystem(['天枢阁']);
    assert.match(system, /# 本次可操作范围/);
    assert.match(system, /本次你可以读改这些世界书：\n- 天枢阁（1 条）/);
    assert.ok(!system.includes('别本'), '范围外的世界书名不许进系统提示词：' + system);
    assert.ok(!system.includes('范围外的秘密'), '范围外的正文更不许进');
  } finally {
    host.restore();
  }
});

test('scope: 一本都没勾时，系统提示词走「没有勾选任何世界书」文案', async () => {
  const host = installHost({ 天枢阁: [entry('1', 'A', 'a')] });
  try {
    const system = await captureAgentSystem([]);
    assert.match(system, /# 本次可操作范围/);
    assert.ok(system.includes(SCOPE_EMPTY), system);
    assert.ok(!system.includes('- 天枢阁'), '没勾的书名不该被列出来');
  } finally {
    host.restore();
  }
});
