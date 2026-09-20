/**
 * agent-core 自测：草稿 / 注册表 / 双通道传输 / 循环，不依赖 UI。
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const base = '../../src/苍玄助手/agent/';
const core = '../../src/苍玄助手/core/';

const draftMod = await import(base + 'draft.ts');
const registryMod = await import(base + 'registry.ts');
const transportMod = await import(base + 'transport.ts');
const loopMod = await import(base + 'loop.ts');

const { DraftStore, lineDiff, diffStat, formatDiff, changedLines, applyChangesToEntries } = draftMod;
const { createRegistry, TOOL_NAMES } = registryMod;
const { createTransport } = transportMod;
const { runAgentLoop, turnsToMessages, toToolSpecs } = loopMod;

/* ---------------- 假世界书 ---------------- */

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

function makePort(seed) {
  const worlds = new Map();
  for (const [name, entries] of Object.entries(seed)) worlds.set(name, entries);
  const port = {
    writes: [],
    failNextWrite: false,
    async list() {
      return [...worlds.keys()];
    },
    async current() {
      return [...worlds.keys()].slice(0, 1);
    },
    async readAll(world) {
      return (worlds.get(world) ?? []).map(item => structuredClone(item));
    },
    async readByUid(world, uids) {
      return (worlds.get(world) ?? []).filter(item => uids.includes(item.uid)).map(item => structuredClone(item));
    },
    async search(worldsArg, keyword, limit) {
      const hits = [];
      for (const world of worldsArg) {
        for (const item of worlds.get(world) ?? []) {
          if (item.content.includes(keyword) || item.name.includes(keyword)) {
            hits.push({ world, uid: item.uid, name: item.name, snippet: item.content.slice(0, 20), hits: 1 });
          }
        }
      }
      return hits.slice(0, limit);
    },
    async createWorldbook(name) {
      worlds.set(name, []);
    },
    async deleteWorldbook(name) {
      worlds.delete(name);
    },
    async writeAll(world, entries) {
      if (port.failNextWrite) throw new Error('写回失败（假）');
      port.writes.push({ world, entries });
      worlds.set(world, entries.map(item => structuredClone(item)));
    },
  };
  return port;
}

function makeCtx(port, over = {}) {
  const drafts = over.drafts ?? new DraftStore();
  return {
    drafts,
    ctx: {
      worlds: over.worlds ?? ['天枢阁'],
      drafts,
      skills: over.skills ?? [],
      ...(over.genImage ? { genImage: over.genImage } : {}),
      ...(over.askUser ? { askUser: over.askUser } : {}),
    },
  };
}

function settings(over = {}) {
  return { route: 'custom', url: 'https://api.test/v1', key: 'sk-1', model: 'm', stream: false, send_images: false, timeout_sec: 30, ...over };
}

/* ---------------- draft ---------------- */

test('draft: lineDiff 逐行 +/- 正确', () => {
  const before = '天枢阁总部在苍梧山，掌门为凌霄真人';
  const after = '天枢阁总部位于苍梧山巅，掌门为凌霄真人\n口头禅："此事须从长计议"';
  const diff = lineDiff(before, after);
  const stat = diffStat(diff);
  assert.equal(stat.del, 1);
  assert.equal(stat.add, 2);
  assert.equal(changedLines(diff).length, 3);
  const text = formatDiff(changedLines(diff));
  assert.match(text, /^- 天枢阁总部在苍梧山/);
  assert.match(text, /^\+ 天枢阁总部位于苍梧山巅/m);
});

test('draft: 草稿 apply 才 writeAll，写成功后才清空', async () => {
  const port = makePort({ 天枢阁: [entry('42', '天枢阁', '总部在苍梧山')] });
  const store = new DraftStore();
  const { ctx } = makeCtx(port, { drafts: store });
  const registry = createRegistry(port);
  const edit = registry.byName('entry_edit');
  const res = await edit.run(
    { world: '天枢阁', uid: '42', old_string: '总部在苍梧山', new_string: '总部位于苍梧山巅' },
    ctx,
  );
  assert.equal(res.ok, true, res.detail);
  assert.match(res.brief, /\+1 -1/);
  assert.equal(store.count(), 1);
  assert.equal(port.writes.length, 0, '草稿阶段不许写回');
  const report = await store.apply(port);
  assert.equal(report.ok, true);
  assert.equal(report.applied, 1);
  assert.equal(port.writes.length, 1);
  assert.equal(port.writes[0].entries[0].content, '总部位于苍梧山巅');
  assert.equal(port.writes[0].entries[0].extra.raw_field, 'keep-me', 'extra 必须原样带回');
  assert.equal(store.count(), 0);
});

test('draft: 写回失败时草稿留着，能重试', async () => {
  const port = makePort({ 天枢阁: [entry('42', '天枢阁', 'abc')] });
  const store = new DraftStore();
  const { ctx } = makeCtx(port, { drafts: store });
  const registry = createRegistry(port);
  await registry.byName('entry_edit').run({ world: '天枢阁', uid: '42', old_string: 'abc', new_string: 'abd' }, ctx);
  port.failNextWrite = true;
  const report = await store.apply(port);
  assert.equal(report.ok, false);
  assert.equal(store.count(), 1);
  port.failNextWrite = false;
  const retry = await store.apply(port);
  assert.equal(retry.ok, true);
});

test('draft: create / delete / meta 一起落地', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a'), entry('2', 'B', 'b')] });
  const changes = [
    { id: 'c1', kind: 'create', world: '天枢阁', uid: '9', label: 'C', before: '', after: 'ccc', payload: { name: 'C', content: 'ccc', strategy: 'constant', keys: ['x'] }, at: 1 },
    { id: 'c2', kind: 'delete', world: '天枢阁', uid: '2', label: 'B', before: 'b', after: '', payload: {}, at: 2 },
    { id: 'c3', kind: 'meta', world: '天枢阁', uid: '1', label: 'A', before: '', after: '', payload: { strategy: 'constant', keys: ['y', 'z'], scan_depth: 6 }, at: 3 },
  ];
  const merged = applyChangesToEntries(await port.readAll('天枢阁'), changes);
  const names = merged.entries.map(item => item.name);
  assert.deepEqual(names, ['A', 'C']);
  const a = merged.entries[0];
  assert.equal(a.strategy, 'constant');
  assert.deepEqual(a.keys, ['y', 'z']);
  assert.equal(a.scan_depth, 6);
  const c = merged.entries[1];
  assert.equal(c.uid, '9');
  assert.equal(c.content, 'ccc');
});

/* ---------------- registry ---------------- */

test('registry: 13 个工具齐全、顺序对、Schema 完整', () => {
  const port = makePort({ 天枢阁: [] });
  const registry = createRegistry(port);
  const audit = registry.audit();
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.extra, []);
  assert.deepEqual(registry.names(), [...TOOL_NAMES]);
  assert.equal(registry.defs.length, 13);
  for (const def of registry.defs) {
    assert.ok(def.title && def.desc, def.name + ' 缺 title/desc');
    assert.ok(def.model_description.length > 10, def.name + ' model_description 太短');
    assert.equal(def.parameters.type, 'object', def.name + ' parameters 不是 object');
    assert.ok(def.parameters.properties && Object.keys(def.parameters.properties).length > 0, def.name + ' 没参数');
    assert.equal(typeof def.run, 'function');
    assert.ok(['knowledge', 'write', 'skill', 'image', 'flow'].includes(def.group));
  }
});

test('registry: create_skill 是 user_initiated_only + 默认关 + 描述写明仅用户要求时用', () => {
  const registry = createRegistry(makePort({ 天枢阁: [] }));
  const def = registry.byName('create_skill');
  assert.equal(def.default_on, false);
  assert.equal(def.user_initiated_only, true);
  assert.match(def.model_description, /仅当用户明确要求时使用/);
});

test('registry: entry_meta / ask_user 默认关，写工具默认开', () => {
  const registry = createRegistry(makePort({ 天枢阁: [] }));
  assert.equal(registry.byName('entry_meta').default_on, false);
  assert.equal(registry.byName('ask_user').default_on, false);
  assert.equal(registry.byName('gen_image').default_on, false, 'gen_image 默认关（生图 API 没接）');
  for (const name of ['wb_search', 'wb_read', 'entry_edit', 'entry_create', 'entry_delete', 'submit']) {
    assert.equal(registry.byName(name).default_on, true, name + ' 应该默认开');
  }
});

test('registry: entry_edit 命中多处要报错，加上下文或 replace_all 才行', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '风起。云涌。风起。')] });
  const { ctx, drafts } = makeCtx(port);
  const registry = createRegistry(port);
  const edit = registry.byName('entry_edit');
  const dup = await edit.run({ world: '天枢阁', uid: '1', old_string: '风起', new_string: '雷落' }, ctx);
  assert.equal(dup.ok, false);
  assert.match(dup.brief, /不唯一/);
  assert.equal(drafts.count(), 0);
  const all = await edit.run({ world: '天枢阁', uid: '1', old_string: '风起', new_string: '雷落', replace_all: true }, ctx);
  assert.equal(all.ok, true, all.detail);
  const changed = drafts.list()[0];
  assert.equal(changed.after, '雷落。云涌。雷落。');
  const missing = await edit.run({ world: '天枢阁', uid: '1', old_string: '不存在', new_string: 'x' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.brief, /找不到/);
});

test('registry: entry_edit 不许整条重写（old_string 必填）', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'abc')] });
  const { ctx, drafts } = makeCtx(port);
  const res = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '1', new_string: '整条新内容' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(drafts.count(), 0);
});

test('registry: wb_read 分页 + 按 uid 读', async () => {
  const entries = Array.from({ length: 7 }, (_, i) => entry(String(i + 1), 'E' + (i + 1), '正文 ' + (i + 1)));
  const port = makePort({ 天枢阁: entries });
  const { ctx } = makeCtx(port);
  const read = createRegistry(port).byName('wb_read');
  const page1 = await read.run({ world: '天枢阁', limit: 3 }, ctx);
  assert.equal(page1.ok, true);
  assert.match(page1.detail, /共 7 条/);
  assert.match(page1.detail, /next_offset=3/);
  const loaded1 = page1.detail.split('\n').filter(line => /^\[\d+\] uid=/.test(line)).length;
  assert.equal(loaded1, 3);
  const page2 = await read.run({ world: '天枢阁', offset: 3, limit: 3 }, ctx);
  assert.match(page2.detail, /next_offset=6/);
  const page3 = await read.run({ world: '天枢阁', offset: 6, limit: 3 }, ctx);
  assert.match(page3.detail, /has_more=false/);
  const one = await read.run({ world: '天枢阁', uid: '4' }, ctx);
  assert.match(one.detail, /uid=4/);
  assert.match(one.detail, /正文 4/);
});

test('registry: 写工具受 ctx.worlds 限制，超范围直接拒', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a')], 别本: [] });
  const { ctx, drafts } = makeCtx(port, { worlds: ['天枢阁'] });
  const res = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '别本', uid: '1', old_string: 'a', new_string: 'b' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.detail, /《别本》不在本次可操作范围内。本次只能用：天枢阁。/);
  assert.match(res.detail, /请让用户去「世界书」页勾上/);
  assert.equal(drafts.count(), 0);
  const none = await createRegistry(port).byName('entry_create').run({ world: '天枢阁', name: 'n', content: 'c' }, makeCtx(port, { worlds: [] }).ctx);
  assert.equal(none.ok, false, '一本都没选就不许写');
  assert.match(none.brief + none.detail, /当前没有勾选任何世界书/);
});

test('registry: entry_create 草稿 payload 完整（strategy/keys）', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx, drafts } = makeCtx(port);
  const res = await createRegistry(port)
    .byName('entry_create')
    .run({ world: '天枢阁', name: '新条目', content: '正文', strategy: 'constant', keys: ['甲', '乙'] }, ctx);
  assert.equal(res.ok, true);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'create');
  assert.equal(change.payload.name, '新条目');
  assert.equal(change.payload.strategy, 'constant');
  assert.deepEqual(change.payload.keys, ['甲', '乙']);
  assert.equal(change.after, '正文');
});

test('registry: entry_meta 草稿带 before_fields，落地只改属性', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '正文', { keys: ['old'], strategy: 'selective' })] });
  const { ctx, drafts } = makeCtx(port);
  const res = await createRegistry(port)
    .byName('entry_meta')
    .run({ world: '天枢阁', uid: '1', strategy: 'constant', keys: ['新'], scan_depth: 8 }, ctx);
  assert.equal(res.ok, true);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'meta');
  assert.equal(change.payload.strategy, 'constant');
  assert.deepEqual(change.payload.keys, ['新']);
  assert.equal(change.payload.before_fields.strategy, 'selective');
  await drafts.apply(port);
  const written = port.writes[0].entries[0];
  assert.equal(written.strategy, 'constant');
  assert.deepEqual(written.keys, ['新']);
  assert.equal(written.scan_depth, 8);
  assert.equal(written.content, '正文', 'meta 不许动正文');
});

test('registry: skill / read_skill_file / create_skill', async () => {
  const port = makePort({ 天枢阁: [] });
  const skills = [
    { id: 's1', name: '世界书精修', summary: '把啰嗦条目压精简', body: '1. 先读\n2. 再改', files: [{ name: '模板.md', content: '模板正文' }] },
  ];
  const created = [];
  const registry = createRegistry(port, { createSkill: draft => created.push(draft) });
  const { ctx } = makeCtx(port, { skills });
  const got = await registry.byName('skill').run({ name: '世界书精修' }, ctx);
  assert.equal(got.ok, true);
  assert.match(got.detail, /先读/);
  assert.match(got.detail, /模板\.md/);
  const missing = await registry.byName('skill').run({ name: '没有的' }, ctx);
  assert.equal(missing.ok, false);
  const file = await registry.byName('read_skill_file').run({ skill: '世界书精修', file: '模板.md' }, ctx);
  assert.equal(file.ok, true);
  assert.match(file.detail, /模板正文/);
  const badFile = await registry.byName('read_skill_file').run({ skill: '世界书精修', file: 'nope.md' }, ctx);
  assert.equal(badFile.ok, false);
  const made = await registry.byName('create_skill').run({ name: '新技能', summary: '什么时候用', body: '怎么做' }, ctx);
  assert.equal(made.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, '新技能');
});

test('registry: gen_image / ask_user / submit', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port, { genImage: async () => ['data:image/png;base64,AAA'], askUser: async q => '要' });
  const registry = createRegistry(port);
  const image = await registry.byName('gen_image').run({ prompt: '苍梧山巅', count: 1 }, ctx);
  assert.equal(image.ok, true);
  assert.deepEqual(image.images, ['data:image/png;base64,AAA']);
  const noImage = await createRegistry(port).byName('gen_image').run({ prompt: 'x' }, makeCtx(port).ctx);
  assert.equal(noImage.ok, false, '没接生图接口要报错');
  const asked = await registry.byName('ask_user').run({ question: '删吗？' }, ctx);
  assert.equal(asked.ok, true);
  assert.match(asked.detail, /要/);
  const submitted = await registry.byName('submit').run({ summary: '改完了' }, ctx);
  assert.equal(submitted.ok, true);
});

/* ---------------- transport ---------------- */

function fetchOnce(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

test('transport: native 通道发 tools 并解析 tool_calls', async () => {
  const body = {
    choices: [
      {
        message: {
          content: '先查一下',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wb_search', arguments: '{"keyword":"天枢阁"}' } }],
        },
      },
    ],
  };
  const { impl, calls } = fetchOnce({ ok: true, status: 200, text: async () => '', json: async () => body });
  const transport = createTransport({ fetchImpl: impl });
  const reply = await transport.chat({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '查' }],
    tools: [{ name: 'wb_search', description: '搜', parameters: { type: 'object', properties: { keyword: { type: 'string' } } } }],
    settings: settings(),
  });
  assert.equal(reply.via, 'native');
  assert.equal(reply.text, '先查一下');
  assert.equal(reply.tool_calls.length, 1);
  assert.equal(reply.tool_calls[0].name, 'wb_search');
  assert.deepEqual(reply.tool_calls[0].args, { keyword: '天枢阁' });
  assert.equal(calls[0].url, 'https://api.test/v1/chat/completions');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.tools[0].function.name, 'wb_search');
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-1');
  assert.equal(transport.supportsTools(), 'yes');
});

test('transport: native 400 不支持 tools → 自动降级 text 且 via=text', async () => {
  const { impl } = fetchOnce({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => '{"error":{"message":"tools is not supported by this model"}}',
    json: async () => ({}),
  });
  let prompts = null;
  const generateRawImpl = async config => {
    prompts = config.ordered_prompts;
    return '好，我来查。<SystemQuery>{"name":"wb_read","args":{"uid":"42"}}</SystemQuery>';
  };
  const notices = [];
  const transport = createTransport({ fetchImpl: impl, generateRawImpl, onNotice: n => notices.push(n) });
  const reply = await transport.chat({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '读 42' }],
    tools: [{ name: 'wb_read', description: '读条目', parameters: { type: 'object', properties: { uid: { type: 'string' } } } }],
    settings: settings(),
  });
  assert.equal(reply.via, 'text');
  assert.equal(reply.tool_calls.length, 1);
  assert.equal(reply.tool_calls[0].name, 'wb_read');
  assert.deepEqual(reply.tool_calls[0].args, { uid: '42' });
  assert.equal(reply.text, '好，我来查。');
  assert.equal(transport.supportsTools(), 'no');
  assert.equal(transport.lastVia(), 'text');
  assert.ok(notices.some(n => /文本标记通道|不支持原生 tools/.test(n.message)));
  assert.equal(prompts[0].role, 'system');
  assert.match(prompts[0].content, /可用工具/);
  assert.match(prompts[0].content, /wb_read/);
  // 第二次直接走 text，不再打接口
  let called = 0;
  const transport2 = createTransport({ fetchImpl: async () => { called++; throw new Error('不该再走 native'); }, generateRawImpl });
  transport2.markToolsUnsupported();
  const reply2 = await transport2.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], settings: settings() });
  assert.equal(reply2.via, 'text');
  assert.equal(called, 0);
});

test('transport: 酒馆路线直接走 text，不 fetch', async () => {
  let fetched = false;
  const transport = createTransport({
    fetchImpl: async () => {
      fetched = true;
      throw new Error('不该 fetch');
    },
    generateRawImpl: async () => '纯文本回复',
  });
  const reply = await transport.chat({ messages: [{ role: 'user', content: 'hi' }], settings: settings({ route: 'tavern' }) });
  assert.equal(reply.via, 'text');
  assert.equal(reply.text, '纯文本回复');
  assert.equal(fetched, false);
});

test('transport: 多模态只在 send_images 开着时塞图', async () => {
  const body = { choices: [{ message: { content: 'ok' } }] };
  const { impl, calls } = fetchOnce({ ok: true, status: 200, text: async () => '', json: async () => body });
  const transport = createTransport({ fetchImpl: impl });
  const messages = [{ role: 'user', content: '看图', images: ['data:image/png;base64,AAA'] }];
  await transport.chat({ messages, settings: settings({ send_images: false }) });
  assert.equal(typeof JSON.parse(calls[0].init.body).messages[0].content, 'string');
  await transport.chat({ messages, settings: settings({ send_images: true }) });
  const sent = JSON.parse(calls[1].init.body).messages[0].content;
  assert.equal(Array.isArray(sent), true);
  assert.equal(sent[0].type, 'text');
  assert.equal(sent[1].type, 'image_url');
  assert.equal(sent[1].image_url.url, 'data:image/png;base64,AAA');
});

test('transport: native 流式 SSE 拼文本和 tool_calls', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"wb_list","arguments":"{\\"a\\":1}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const response = {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true }),
      }),
    },
  };
  const transport = createTransport({ fetchImpl: async () => response });
  const deltas = [];
  const reply = await transport.chat({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'wb_list', description: 'd', parameters: { type: 'object', properties: {} } }],
    settings: settings({ stream: true }),
    onDelta: text => deltas.push(text),
  });
  assert.equal(reply.text, '你好');
  assert.deepEqual(deltas, ['你好']);
  assert.equal(reply.tool_calls[0].name, 'wb_list');
  assert.deepEqual(reply.tool_calls[0].args, { a: 1 });
});

test('transport: 文本通道把 SystemQuery 抠干净，assistant 历史转成标记文本', async () => {
  let prompts = null;
  const transport = createTransport({
    generateRawImpl: async config => {
      prompts = config.ordered_prompts;
      return '收到';
    },
  });
  await transport.chat({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '改一下' },
      { role: 'assistant', content: '我看看', tool_calls: [{ id: 'c1', name: 'wb_read', args: { uid: '1' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '条目正文' },
    ],
    tools: [{ name: 'wb_read', description: '读', parameters: { type: 'object', properties: {} } }],
    settings: settings({ route: 'tavern' }),
  });
  const assistant = prompts.find(p => p.role === 'assistant');
  assert.match(assistant.content, /<SystemQuery>\{"name":"wb_read","args":\{"uid":"1"}\}<\/SystemQuery>/);
  const toolPrompt = prompts[prompts.length - 1];
  assert.equal(toolPrompt.role, 'user');
  assert.match(toolPrompt.content, /【工具结果 id=c1】/);
  assert.match(toolPrompt.content, /条目正文/);
});

/* ---------------- loop ---------------- */

function scriptedTransport(replies) {
  const requests = [];
  let index = 0;
  return {
    requests,
    supportsTools: () => 'yes',
    markToolsUnsupported: () => {},
    async chat(req) {
      requests.push({ ...req, messages: req.messages.slice() });
      const reply = replies[Math.min(index, replies.length - 1)];
      index++;
      return typeof reply === 'function' ? reply(req) : reply;
    },
  };
}

test('loop: 两轮跑完，转写是 system+user+assistant(tool_calls)+tool', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a')] });
  const { ctx, drafts } = makeCtx(port);
  const registry = createRegistry(port);
  const transport = scriptedTransport([
    { text: '先列一下', tool_calls: [{ id: 'c1', name: 'wb_list', args: {} }], via: 'native' },
    { text: '好了', tool_calls: [], via: 'native' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    transport,
    tools: registry.defs,
    settings: settings(),
    system: '你是助手',
    user: '看看世界书',
    context: ctx,
    max_rounds: 6,
    onEvent: event => events.push(event),
  });
  assert.equal(result.reason, 'no_tool_calls');
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(result.messages[2].tool_calls[0].name, 'wb_list');
  assert.equal(result.messages[3].tool_call_id, 'c1');
  assert.equal(result.via, 'native');
  const types = events.map(event => event.type);
  assert.deepEqual(types.filter(t => t === 'round'), ['round', 'round']);
  assert.ok(types.includes('tool_call'));
  assert.equal(types[types.length - 1], 'done');
  const assistantTurn = result.turns.find(turn => turn.role === 'assistant');
  assert.equal(assistantTurn.calls[0].name, 'wb_list');
  assert.equal(assistantTurn.calls[0].ok, true);
  assert.equal(transport.requests[1].messages.length, 4);
});

test('loop: 调 submit 立刻收工', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port);
  const registry = createRegistry(port);
  const transport = scriptedTransport([
    { text: '', tool_calls: [{ id: 'c1', name: 'submit', args: { summary: '改完了' } }], via: 'native' },
  ]);
  const result = await runAgentLoop({
    transport,
    tools: registry.defs,
    settings: settings(),
    system: 's',
    user: 'u',
    context: ctx,
  });
  assert.equal(result.reason, 'submit');
  assert.match(result.submit_result, /改完了/);
});

test('loop: 未知工具不炸，跑完还能停', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port);
  const registry = createRegistry(port);
  const transport = scriptedTransport([
    { text: '', tool_calls: [{ id: 'c1', name: '不存在', args: {} }], via: 'native' },
    { text: '收工', tool_calls: [], via: 'native' },
  ]);
  const result = await runAgentLoop({ transport, tools: registry.defs, settings: settings(), system: 's', user: 'u', context: ctx });
  assert.equal(result.reason, 'no_tool_calls');
  const toolTurn = result.turns.find(turn => turn.role === 'tool');
  assert.equal(toolTurn.calls[0].ok, false);
  assert.match(toolTurn.calls[0].brief, /没有这个工具/);
});

test('loop: AbortSignal 能停', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port);
  const registry = createRegistry(port);
  const controller = new AbortController();
  controller.abort();
  const transport = scriptedTransport([{ text: 'x', tool_calls: [], via: 'native' }]);
  const result = await runAgentLoop({
    transport,
    tools: registry.defs,
    settings: settings(),
    system: 's',
    user: 'u',
    context: ctx,
    signal: controller.signal,
  });
  assert.equal(result.reason, 'aborted');
  assert.equal(transport.requests.length, 0);
});

test('loop: 接口报错 → reason=error 且带消息', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port);
  const transport = scriptedTransport([
    () => {
      throw new Error('接口炸了');
    },
  ]);
  const result = await runAgentLoop({
    transport,
    tools: createRegistry(port).defs,
    settings: settings(),
    system: 's',
    user: 'u',
    context: ctx,
  });
  assert.equal(result.reason, 'error');
  assert.match(result.error, /接口炸了/);
});

test('loop: max_rounds 兜底；工具产出的图回灌成图片消息', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx } = makeCtx(port, { genImage: async () => ['data:image/png;base64,AAA'] });
  const registry = createRegistry(port);
  const transport = scriptedTransport([
    { text: '', tool_calls: [{ id: 'c1', name: 'gen_image', args: { prompt: '山' } }], via: 'native' },
  ]);
  const result = await runAgentLoop({
    transport,
    tools: registry.defs,
    settings: settings(),
    system: 's',
    user: 'u',
    context: ctx,
    max_rounds: 2,
  });
  assert.equal(result.reason, 'max_rounds');
  assert.equal(result.rounds, 2);
  const imageMessage = result.messages.find(m => m.role === 'user' && (m.images ?? []).length);
  assert.ok(imageMessage, '图要作为图片消息回灌给模型');
  assert.equal(imageMessage.images[0], 'data:image/png;base64,AAA');
});

test('loop: turnsToMessages / toToolSpecs 正常工作', () => {
  const turns = [
    { id: 't1', role: 'user', text: '查 42', images: [], calls: [], at: 1 },
    { id: 't2', role: 'assistant', text: '好', images: [], calls: [{ id: 'c1', name: 'wb_read', args: { uid: '42' }, ok: true, brief: 'b', detail: '正文', images: [], at: 2 }], at: 2 },
    { id: 't3', role: 'tool', text: '', images: [], calls: [{ id: 'c1', name: 'wb_read', args: { uid: '42' }, ok: true, brief: 'b', detail: '正文', images: [], at: 3 }], at: 3 },
  ];
  const messages = turnsToMessages(turns);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(messages[1].tool_calls[0].name, 'wb_read');
  assert.equal(messages[2].content, '正文');
  assert.equal(messages.length, 3, 'tool 轮次和 assistant 的 calls 不能重复转写');
  // 界面上没存 tool 轮次时（runner 的存法），也要能从 assistant 的 calls 里补出 tool 消息
  const onlyAssistant = turnsToMessages([turns[0], turns[1]]);
  assert.deepEqual(onlyAssistant.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(onlyAssistant[2].tool_call_id, 'c1');
  const specs = toToolSpecs(createRegistry(makePort({ 天枢阁: [] })).defs, ['wb_read']);
  assert.deepEqual(specs.map(s => s.name), ['wb_read']);
  assert.equal(toToolSpecs(createRegistry(makePort({ 天枢阁: [] })).defs).length, 13);
});
