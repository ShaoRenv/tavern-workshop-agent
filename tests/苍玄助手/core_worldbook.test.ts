/**
 * 验收补充：core/worldbook.ts —— 归一化、写回字段保真往返、搜索只回片段、真机端口的宿主调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const { toWbEntry, fromWbEntry, makeWbEntry, buildSnippet, countHits, searchInEntries, createWorldbookPort, MissingHostApiError } =
  await import(core + 'worldbook.ts');
const { setHostBridge } = await import(core + 'storage.ts');

/** 一条「TavernHelper 形态」的原始条目，带上一堆我们并不认识的字段 */
function thRaw(over = {}) {
  return {
    uid: 42,
    name: '天枢阁',
    enabled: true,
    behavior: 'normal',
    strategy: {
      type: 'selective',
      keys: ['天枢阁', '苍梧山'],
      keys_secondary: { logic: 'and_all', keys: ['掌门'] },
      scan_depth: 4,
    },
    position: { type: 'before_character_definition', role: 'system', depth: 3, order: 180 },
    content: '天枢阁总部在苍梧山',
    probability: 100,
    useProbability: true,
    extensions: { position: 0, depth: 3, role: 0 },
    vectorized: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    automation_id: 'auto_1',
    group: '角色设定',
    display_index: 7,
    ...over,
  };
}

/** 一条「旧版 ST 扁平形态」的原始条目 */
const legacyRaw = {
  uid: 7,
  comment: '旧版条目',
  content: '正文',
  disable: false,
  key: ['甲', '乙'],
  keysecondary: ['丙'],
  selectiveLogic: 3,
  constant: true,
  position: 0,
  depth: 2,
  order: 50,
  scanDepth: 6,
};

/* ============================ 归一化（读） ============================ */

test('worldbook: toWbEntry 归一化 TavernHelper 形态，extra 留下整条原始快照', () => {
  const raw = thRaw({ strategy: { ...thRaw().strategy, keys: ['天枢阁', /苍梧山(?=顶)/] } });
  const entry = toWbEntry(raw);

  assert.equal(entry.uid, '42', 'uid 统一成 string');
  assert.equal(entry.name, '天枢阁');
  assert.equal(entry.content, '天枢阁总部在苍梧山');
  assert.equal(entry.enabled, true);
  assert.equal(entry.strategy, 'selective');
  assert.deepEqual(entry.keys, ['天枢阁', '苍梧山(?=顶)'], 'RegExp 关键词取 source');
  assert.deepEqual(entry.keys_secondary, { logic: 'and_all', keys: ['掌门'] });
  assert.equal(entry.scan_depth, 4);
  assert.equal(entry.position, 0, 'position 对象形态归一成 0');
  assert.equal(entry.depth, 3);
  assert.equal(entry.order, 180);
  assert.equal(entry.extra.behavior, 'normal');
  assert.deepEqual(entry.extra.extensions, { position: 0, depth: 3, role: 0 });
  assert.equal(entry.extra.automation_id, 'auto_1');
  assert.equal(entry.extra.uid, 42, 'extra 是原始快照（uid 还是数字）');
});

test('worldbook: toWbEntry 归一化旧版扁平形态（comment/key/keysecondary/selectiveLogic/constant/scanDepth）', () => {
  const entry = toWbEntry(legacyRaw);
  assert.equal(entry.uid, '7');
  assert.equal(entry.name, '旧版条目', '没有 name 时用 comment');
  assert.equal(entry.strategy, 'constant', 'constant:true → 蓝灯');
  assert.deepEqual(entry.keys, ['甲', '乙'], '旧 key → keys');
  assert.deepEqual(entry.keys_secondary, { logic: 'and_all', keys: ['丙'] }, 'selectiveLogic 3 = and_all');
  assert.equal(entry.scan_depth, 6, '旧 scanDepth → scan_depth');
  assert.equal(entry.depth, 2);
  assert.equal(entry.order, 50);
});

test('worldbook: toWbEntry 对 undefined / null / 垃圾输入不炸', () => {
  for (const raw of [undefined, null, 1, 'x', [], { uid: null, strategy: 'bad', position: 'bad' }]) {
    const entry = toWbEntry(raw);
    assert.equal(typeof entry.uid, 'string');
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.content, 'string');
    assert.equal(entry.enabled, true);
    assert.ok(['constant', 'selective', 'vectorized'].includes(entry.strategy));
    assert.ok(Array.isArray(entry.keys));
  }
  assert.equal(toWbEntry({ uid: 0, content: 'x' }).uid, '0');
  assert.equal(toWbEntry({ uid: 'abc' }).uid, 'abc');
});

/* ============================ 写回（往返保真） ============================ */

test('worldbook: TavernHelper 形态往返字段一个不丢（整条 deepEqual）', () => {
  const raw = thRaw();
  const back = fromWbEntry(toWbEntry(raw));
  assert.deepEqual(back, raw);
  assert.equal(back.uid, 42, '原本是数字 uid，写回还是数字');
  assert.deepEqual(back.strategy, raw.strategy, 'strategy 里的 keys_secondary / scan_depth 都要在');
  assert.deepEqual(back.position, raw.position);
});

test('worldbook: 旧版扁平形态往返 —— 原有字段全保，只补一个 enabled', () => {
  const back = fromWbEntry(toWbEntry(legacyRaw));
  for (const [key, value] of Object.entries(legacyRaw)) assert.deepEqual(back[key], value, '字段丢了：' + key);
  assert.equal(back.enabled, true, '旧版没有 enabled 字段，归一化后补上');
  assert.ok(!('name' in back), '原本只有 comment，不要凭空多写一个 name');
});

test('worldbook: 野字段（自动化 / 分组 / 概率 / 扩展）原样带回', () => {
  const raw = thRaw({ 自定义字段: { a: 1 }, 我的数组: [1, 2, 3], nullField: null });
  const back = fromWbEntry(toWbEntry(raw));
  assert.deepEqual(back['自定义字段'], { a: 1 });
  assert.deepEqual(back['我的数组'], [1, 2, 3]);
  assert.equal(back.nullField, null);
  assert.equal(back.group, '角色设定');
  assert.equal(back.probability, 100);
  assert.equal(back.display_index, 7);
  assert.deepEqual(back.extensions, raw.extensions);
});

test('worldbook: name 与 comment 同时存在且不同时，两个都原样带回（往返完全一致）', () => {
  // 回归 task-9 的 P2-1：旧实现写回时会把 comment 覆盖成 name。
  const raw = thRaw({ name: 'A', comment: 'B' });
  const back = fromWbEntry(toWbEntry(raw));
  assert.equal(back.name, 'A');
  assert.equal(back.comment, 'B', '原始 comment 必须原样带回');
  assert.deepEqual(back, raw, 'name/comment 双写形态往返应当完全一致');

  // 只改 name 时，comment 保持原值，不被跟着改
  const renamed = toWbEntry(raw);
  renamed.name = 'A2';
  const renamedBack = fromWbEntry(renamed);
  assert.equal(renamedBack.name, 'A2');
  assert.equal(renamedBack.comment, 'B');

  // 原始只有 comment（旧版写法）时，comment 才是标题，要跟着 entry.name 走
  const onlyComment = toWbEntry({ uid: 7, comment: '旧版条目', content: 'x' });
  assert.equal(onlyComment.name, '旧版条目');
  onlyComment.name = '改名了';
  const onlyBack = fromWbEntry(onlyComment);
  assert.equal(onlyBack.comment, '改名了');
  assert.ok(!('name' in onlyBack), '原本没有 name 就不要凭空多写一个');

  // 原始只有 name 时，只写 name，不补 comment
  const onlyNameRaw = thRaw({ uid: 8, name: '新式条目' });
  delete onlyNameRaw.comment;
  const onlyNameBack = fromWbEntry(toWbEntry(onlyNameRaw));
  assert.equal(onlyNameBack.name, '新式条目');
  assert.ok(!('comment' in onlyNameBack));
});

test('worldbook: uid 只有为空才交给酒馆分配，非空一律原样带上', () => {
  // 回归 task-9 的 P3-2：旧实现按「数字/非数字」判断，把自造的 entry_xxx / cx_新建_1 也丢了。
  const made = makeWbEntry({ name: '新条', content: '正文', strategy: 'constant', keys: ['甲'], scan_depth: 8, depth: 5, order: 9 });
  assert.equal(made.uid, '');
  assert.equal(made.enabled, true);
  assert.deepEqual(made.keys_secondary, { logic: 'and_any', keys: [] });

  const out = fromWbEntry({ ...made, uid: '12' });
  assert.equal(out.uid, 12, '数字字符串 uid 写回成数字');
  assert.equal(out.name, '新条');
  assert.equal(out.content, '正文');
  assert.equal(out.enabled, true);
  assert.deepEqual(out.strategy, {
    type: 'constant',
    keys: ['甲'],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 8,
  });
  assert.deepEqual(out.position, { type: 'before_character_definition', role: 'system', depth: 5, order: 9 });

  // 空 uid 才交给酒馆分配
  const empty = fromWbEntry({ ...made, uid: '' });
  assert.equal('uid' in empty, false, '空 uid 不写，交给酒馆分配');

  // 非空 uid 一律带上（含自造 id / 中文 id / 前导零）
  for (const [uid, expected] of [['entry_abc', 'entry_abc'], ['cx_新建_1', 'cx_新建_1'], ['0042', 42], ['12', 12]]) {
    const one = fromWbEntry({ ...made, uid });
    assert.deepEqual(one.uid, expected, '非空 uid 不该被丢：' + uid);
  }

  // 有 extra 底稿时按原本形态保真：数字还是数字，文本还是文本
  assert.equal(fromWbEntry({ ...made, uid: '42', extra: { uid: 42 } }).uid, 42);
  assert.equal(typeof fromWbEntry({ ...made, uid: '42', extra: { uid: 42 } }).uid, 'number');
  assert.equal(fromWbEntry({ ...made, uid: 'cx_1', extra: { uid: 'cx_1' } }).uid, 'cx_1');
});

/* ============================ 搜索（不回全文） ============================ */

test('worldbook: searchInEntries 只回 uid + 片段，命中数与 limit 正确', () => {
  const entries = [
    toWbEntry(thRaw({ uid: 1, name: '甲', content: '风起。云涌。风起。雨落。' })),
    toWbEntry(thRaw({ uid: 2, name: '风起阁', content: '没有关键词的正文' })),
    toWbEntry(thRaw({ uid: 3, name: '丙', content: '不相关' })),
  ];
  const hits = searchInEntries('天枢阁', entries, '风起', 10);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(hit => hit.uid), ['1', '2']);
  assert.equal(hits[0].hits, 2, '正文里出现两次');
  assert.equal(hits[1].hits, 1, '命中标题');
  for (const hit of hits) {
    assert.equal(typeof hit.snippet, 'string');
    assert.ok(!('content' in hit), '绝不能把正文带回搜索结果');
  }
  assert.ok(hits[0].snippet.length < 40, '片段要短');
  assert.equal(searchInEntries('天枢阁', entries, '', 10).length, 0);
  assert.equal(searchInEntries('天枢阁', entries, '风起', 0).length, 0);
  assert.equal(searchInEntries('天枢阁', entries, '风起', 1).length, 1, 'limit 生效');
});

test('worldbook: countHits / buildSnippet 边界', () => {
  assert.equal(countHits('aaaa', 'aa'), 2, '不重叠计数');
  assert.equal(countHits('AAAA', 'aa'), 2, '大小写不敏感');
  assert.equal(countHits('', 'a'), 0);
  assert.equal(countHits('abc', ''), 0);
  assert.equal(buildSnippet('', 'a'), '');
  assert.equal(buildSnippet('短正文', '不存在'), '短正文', '没命中就给开头');
  const long = 'x'.repeat(200);
  assert.ok(buildSnippet(long, '').endsWith('…'), '长文截断加省略号');
  const hitSnippet = buildSnippet('甲'.repeat(50) + '关键词' + '乙'.repeat(50), '关键词', 5);
  assert.ok(hitSnippet.startsWith('…'));
  assert.ok(hitSnippet.endsWith('…'));
  assert.ok(hitSnippet.includes('关键词'));
});

/* ============================ 真机端口（假宿主） ============================ */

function installHost(over = {}) {
  const worlds = new Map();
  const calls = { replace: [], create: [], delete: [], createOrReplace: [] };
  const bridge = {
    getWorldbookNames: () => [...worlds.keys()],
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: name => structuredClone(worlds.get(name) ?? []),
    replaceWorldbook: (name, entries, options) => calls.replace.push({ name, entries, options }),
    createWorldbook: (name, entries) => {
      calls.create.push({ name, entries });
      worlds.set(name, []);
    },
    deleteWorldbook: name => {
      calls.delete.push(name);
      return true;
    },
    ...over,
  };
  setHostBridge(bridge);
  return { worlds, calls, bridge };
}

test('worldbook: 端口 readAll / readByUid 走宿主接口', async () => {
  const host = installHost();
  try {
    host.worlds.set('天枢阁', [thRaw(), thRaw({ uid: 99, name: '别条' })]);
    const port = createWorldbookPort();
    const all = await port.readAll('天枢阁');
    assert.equal(all.length, 2);
    assert.equal(all[0].uid, '42');
    const picked = await port.readByUid('天枢阁', ['99', 42]);
    assert.deepEqual(picked.map(entry => entry.uid), ['42', '99']);
    assert.deepEqual(await port.readByUid('天枢阁', []), []);
    assert.deepEqual(await port.readAll('  '), [], '空世界书名直接回空');
    assert.deepEqual(await port.readAll('没这本'), []);
  } finally {
    setHostBridge(null);
  }
});

test('worldbook: 端口 writeAll 带上 render 参数，uid 形态与 extra 字段全保住', async () => {
  const host = installHost();
  try {
    host.worlds.set('天枢阁', [thRaw()]);
    const port = createWorldbookPort();
    const entries = await port.readAll('天枢阁');
    entries[0].content = '改过的正文';
    await port.writeAll('天枢阁', entries);

    assert.equal(host.calls.replace.length, 1);
    const [call] = host.calls.replace;
    assert.equal(call.name, '天枢阁');
    assert.deepEqual(call.options, { render: 'debounced' });
    assert.equal(call.entries[0].uid, 42);
    assert.equal(call.entries[0].content, '改过的正文');
    assert.equal(call.entries[0].automation_id, 'auto_1', '原始字段必须合并回去');
    assert.deepEqual(call.entries[0].extensions, { position: 0, depth: 3, role: 0 });

    await assert.rejects(port.writeAll('', entries), /世界书名称不能为空/);
  } finally {
    setHostBridge(null);
  }
});

test('worldbook: 端口 list / current 去重保序；宿主缺接口时降级不炸', async () => {
  const host = installHost({
    getGlobalWorldbookNames: () => ['全局', '共享', ''],
    getCharWorldbookNames: () => ({ primary: '角色', additional: ['共享', '额外'] }),
    getChatWorldbookName: () => '聊天',
  });
  try {
    host.worlds.set('全局', []);
    host.worlds.set('共享', []);
    const port = createWorldbookPort();
    assert.deepEqual(await port.list(), ['全局', '共享']);
    assert.deepEqual(await port.current(), ['全局', '共享', '角色', '额外', '聊天']);
  } finally {
    setHostBridge(null);
  }

  try {
    setHostBridge({});
    const port = createWorldbookPort();
    assert.deepEqual(await port.list(), [], '没有 getWorldbookNames 就回空数组');
    assert.deepEqual(await port.current(), []);
    await assert.rejects(port.readAll('天枢阁'), MissingHostApiError);
    await assert.rejects(port.deleteWorldbook('天枢阁'), MissingHostApiError);
    assert.deepEqual(await port.search(['天枢阁'], '关键词', 5), []);
  } finally {
    setHostBridge(null);
  }
});

test('worldbook: createWorldbook 绝不覆盖同名；createOrReplace 返回 false 要报错', async () => {
  const host = installHost();
  try {
    host.worlds.set('已有', []);
    const port = createWorldbookPort();
    await assert.rejects(port.createWorldbook('已有'), /已存在/);
    await assert.rejects(port.createWorldbook('   '), /不能为空/);
    await port.createWorldbook('新的');
    assert.deepEqual(host.calls.create, [{ name: '新的', entries: [] }]);
  } finally {
    setHostBridge(null);
  }

  try {
    setHostBridge({ getWorldbookNames: () => [], createOrReplaceWorldbook: () => false });
    await assert.rejects(createWorldbookPort().createWorldbook('X'), /已存在/);
  } finally {
    setHostBridge(null);
  }

  try {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    setHostBridge({ deleteWorldbook: () => false });
    try {
      await createWorldbookPort().deleteWorldbook('不存在');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不存在或删除失败/);
  } finally {
    setHostBridge(null);
  }
});

test('worldbook: 端口 search 跨世界书按 limit 截断，坏世界书不影响其他本', async () => {
  const host = installHost({
    getWorldbook: name => {
      if (name === '坏的') throw new Error('读不到');
      return structuredClone(host.worlds.get(name) ?? []);
    },
  });
  try {
    host.worlds.set('甲本', [thRaw({ uid: 1, name: '一', content: '关键词在这里' })]);
    host.worlds.set('乙本', [thRaw({ uid: 2, name: '二', content: '关键词也在' })]);
    host.worlds.set('坏的', []);
    const port = createWorldbookPort();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = () => warnings.push(1);
    let hits;
    try {
      hits = await port.search(['坏的', '甲本', '乙本'], '关键词', 1);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(hits.length, 1);
    assert.equal(hits[0].world, '甲本');
    assert.equal(warnings.length, 1, '读不到的世界书要 warn 一次并跳过');
  } finally {
    setHostBridge(null);
  }
});
