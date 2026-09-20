/**
 * runner 自测：不依赖 UI，假 transport（假 generateRaw / 假 fetch）+ 假世界书宿主。
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createRunner } = await import(root + 'run/runner.ts');
const { setHostBridge, migrateRootData } = await import(root + 'core/storage.ts');
const { RootDataSchema, PresetSchema, isAgentPreset } = await import(root + 'core/types.ts');
const { DEFAULT_ON_TOOLS } = await import(root + 'agent/registry.ts');
const { createBuiltinPresets } = await import(root + 'presets/builtin.ts');

/* ---------------- 假世界书宿主 ---------------- */

function rawEntry(uid, name, content) {
  return { uid, name, enabled: true, content, strategy: { type: 'selective', keys: [name] }, position: 0, depth: 4, order: 100 };
}

function installWorldbookHost(seed) {
  const worlds = new Map();
  for (const [name, entries] of Object.entries(seed)) worlds.set(name, entries);
  const calls = { replace: [] };
  setHostBridge({
    getWorldbookNames: () => [...worlds.keys()],
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: name => (worlds.get(name) ?? []).map(item => ({ ...item, strategy: { ...item.strategy } })),
    replaceWorldbook: (name, entries) => {
      calls.replace.push({ name, entries });
      worlds.set(name, entries.map(item => ({ ...item })));
    },
    createWorldbook: name => worlds.set(name, []),
    deleteWorldbook: name => worlds.delete(name),
  });
  return { worlds, calls };
}

function makeData(over = {}) {
  // v2：先迁移出 sessions，再把单数 session 绑成「当前会话」的别名（和 store 的 bindLegacyAlias 一致）
  const data = migrateRootData(RootDataSchema.parse({})).data;
  data.session = data.sessions[0];
  data.api = { route: 'tavern', url: '', key: '', model: '', stream: false, send_images: false, timeout_sec: 30 };
  data.selection.worldbook_names = ['天枢阁'];
  data.selection.character_ids = ['潮听澜'];
  data.selection.entry_uid = ['42'];
  data.selection.demand = '整理天枢阁';
  data.skills = [
    { id: 's1', name: '世界书精修', summary: '把啰嗦的条目压精简', body: '技能正文SECRET', files: [{ name: '模板.md', content: '模板' }], enabled: true, builtin: true },
  ];
  Object.assign(data, over);
  return data;
}

function presetOf(over) {
  return PresetSchema.parse(over);
}

function collect() {
  const turns = [];
  const updates = [];
  const artifacts = [];
  const notices = [];
  const deltas = [];
  return {
    turns,
    updates,
    artifacts,
    notices,
    deltas,
    args: {
      onTurn: t => turns.push(t),
      onToolUpdate: (turnId, index, call) => updates.push({ turnId, index, call }),
      onArtifact: a => artifacts.push(a),
      onNotice: text => notices.push(text),
      onDelta: (turnId, text) => deltas.push({ turnId, text }),
    },
  };
}

/* ---------------- plain ---------------- */

test('runner.runPlain：渲染宏 → 文本通道 → 抠 JSON → 产物', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', '总部在苍梧山')] });
  let seenPrompts = null;
  globalThis.generateRaw = async config => {
    seenPrompts = config.ordered_prompts;
    return '好的：\n```json\n{"characters":[{"name":"潮听澜"}]}\n```';
  };
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'p1',
    name: '世界书整理',
    output: 'json',
    items: [
      { type: 'message', id: 'm1', name: '开场', role: 'system', content: '你是整理助手。世界书：{{世界书}}。需求：{{用户需求}}' },
      { type: 'message', id: 'm2', name: '角色', role: 'user', content: '角色：{{角色列表}}' },
    ],
  });
  const box = collect();
  const result = await runner.runPlain({
    data,
    input: '把天枢阁整理一下',
    preset,
    history: [],
    images: [],
    signal: new AbortController().signal,
    ...box.args,
  });

  assert.equal(result.via, 'text');
  assert.equal(result.done, true);
  assert.equal(box.turns[0].role, 'user', '历史里没有这条用户消息，runner 补一条');
  assert.equal(box.turns[1].role, 'assistant');
  assert.equal(box.artifacts.length, 1);
  assert.equal(box.artifacts[0].kind, 'json');
  assert.deepEqual(JSON.parse(box.artifacts[0].data), { characters: [{ name: '潮听澜' }] });
  assert.match(box.artifacts[0].name, /\.json$/);
  assert.equal(seenPrompts[0].role, 'system');
  assert.match(seenPrompts[0].content, /世界书：天枢阁/, '{{世界书}} 要替成选中的世界书名');
  assert.match(seenPrompts[0].content, /把天枢阁整理一下/, '{{用户需求}} 要替成 input');
  assert.match(seenPrompts[1].content, /角色：潮听澜/, '{{角色列表}} 要替成选中的角色');
  assert.equal(seenPrompts.filter(p => p.role === 'user').length, 1, '预设里已经带了需求，不要再补一条');
});

test('runner.runPlain：历史里已有这条用户消息就不重复记；没 JSON 就提示', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', '总部在苍梧山')] });
  globalThis.generateRaw = async () => '这次我就不给 JSON 了';
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'p2',
    name: 'P',
    output: 'json',
    items: [{ type: 'message', id: 'm1', role: 'user', content: '{{用户需求}}' }],
  });
  const box = collect();
  const history = [{ id: 'h1', role: 'user', text: '整理天枢阁', images: [], calls: [], at: 1 }];
  const result = await runner.runPlain({
    data,
    input: '整理天枢阁',
    preset,
    history,
    signal: new AbortController().signal,
    ...box.args,
  });
  assert.equal(box.turns.length, 1, '只回助手一轮');
  assert.equal(box.turns[0].role, 'assistant');
  assert.equal(box.artifacts.length, 0);
  assert.equal(result.done, true);
  assert.ok(box.notices.some(text => /没有可解析的 JSON/.test(text)));
});

/* ---------------- agent（文本通道） ---------------- */

test('runner.runAgent：文本通道跑完整循环，草稿镜像到 data.drafts，saveDrafts 落回世界书', async () => {
  const host = installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', '天枢阁总部在苍梧山，掌门为凌霄真人')] });
  let round = 0;
  globalThis.generateRaw = async config => {
    round++;
    const system = config.ordered_prompts.find(p => p.role === 'system');
    assert.ok(system && /你是苍玄界世界书整理助手/.test(system.content));
    assert.match(system.content, /世界书精修/, '系统提示词要带技能清单');
    assert.ok(!system.content.includes('技能正文SECRET'), '技能正文不许进系统提示词');
    if (round === 1) return '先读。<SystemQuery>{"name":"wb_read","args":{"world":"天枢阁","uid":"42"}}</SystemQuery>';
    if (round === 2) {
      return '<SystemQuery>{"name":"entry_edit","args":{"world":"天枢阁","uid":"42","old_string":"总部在苍梧山","new_string":"总部位于苍梧山巅"}}</SystemQuery>';
    }
    return '收工。<SystemQuery>{"name":"submit","args":{"summary":"补了总部位置"}}</SystemQuery>';
  };

  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'a1',
    name: 'agent',
    output: 'none',
    items: [{ type: 'message', id: 'a1-sys', name: '系统提示词', role: 'system', content: '你是苍玄界世界书整理助手。{{用户需求}}' }],
    // 只用这个预设自己勾的工具 / 技能
    use_global_caps: true,
    tools: ['wb_read', 'entry_edit', 'submit'],
    skills: ['s1'],
    max_rounds: 6,
  });
  const box = collect();
  const result = await runner.runAgent({
    data,
    input: '把总部位置写清楚',
    preset,
    history: [{ id: 'h1', role: 'user', text: '把总部位置写清楚', images: [], calls: [], at: 1 }],
    signal: new AbortController().signal,
    ...box.args,
  });

  assert.equal(result.done, true);
  assert.equal(result.via, 'text');
  assert.equal(round, 3);
  // 历史末尾已经有这条用户消息 → 不再补用户轮次
  assert.deepEqual(result.turns.map(t => t.role), ['assistant', 'assistant', 'assistant']);
  // 工具卡挂在 assistant 轮的 calls 上，并就地更新
  const editTurn = result.turns[1];
  assert.equal(editTurn.calls.length, 1);
  assert.equal(editTurn.calls[0].name, 'entry_edit');
  assert.equal(editTurn.calls[0].ok, true);
  assert.match(editTurn.calls[0].brief, /\+1 -1/);
  assert.match(editTurn.calls[0].detail, /总部位于苍梧山巅/);
  // onToolUpdate 定位到 turn + 下标
  assert.ok(box.updates.length >= 4);
  const done = box.updates.find(u => u.call.name === 'entry_edit' && u.call.ok && u.call.detail);
  assert.equal(done.turnId, editTurn.id);
  assert.equal(done.index, 0);
  // 草稿镜像
  assert.equal(data.drafts.length, 1);
  assert.equal(runner.draftCount(), 1);
  assert.match(runner.exportDrafts(), /\+ 天枢阁总部位于苍梧山巅/);
  // 轮次写进 session
  assert.equal(data.session.round, 3);
  // 落回世界书
  const saved = await runner.saveDrafts();
  assert.deepEqual(saved, { applied: 1, failed: 0 });
  assert.equal(data.drafts.length, 0);
  assert.equal(host.calls.replace.length, 1);
  assert.equal(host.calls.replace[0].name, '天枢阁');
  const written = host.calls.replace[0].entries[0];
  assert.equal(written.content, '天枢阁总部位于苍梧山巅，掌门为凌霄真人');
  assert.equal(written.uid, 42, '原始 uid 形态要保住');
  assert.equal(written.strategy.type, 'selective', 'strategy 结构要保住');
});

/* ---------------- agent（原生通道） ---------------- */

test('runner.runAgent：原生通道自己 fetch，带 tools，没 tool_calls 就收工', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  let round = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    round++;
    if (round === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wb_list', arguments: '{}' } }],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '看完了' } }] }) };
  };

  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'sk-1', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = presetOf({
    id: 'a2',
    name: 'agent',
    items: [{ type: 'message', id: 'a2-sys', role: 'system', content: '你是助手' }],
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 4,
  });
  const box = collect();
  const result = await runner.runAgent({
    data,
    input: '列一下世界书',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...box.args,
  });

  assert.equal(result.via, 'native');
  assert.equal(result.done, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].function.name, 'wb_list');
  assert.equal(bodies[0].tools.length, 1, '只发预设勾上的工具');
  assert.equal(bodies[0].messages[0].role, 'system');
  assert.equal(bodies[0].messages[0].content, '你是助手', '预设本体的 system 在最前面');
  assert.equal(bodies[1].messages.at(-1).role, 'tool', '工具结果要按标准转写塞回去');
  assert.deepEqual(box.turns.map(t => t.role), ['user', 'assistant', 'assistant']);
  assert.match(result.turns[1].calls[0].brief, /^本次范围 1 本 · 列出 1 本 · 共 1 条（启用 1）$/);
  // 追加的三条系统段：顺序 = 本次可操作范围 → 轮数预算（这里没技能，所以没有技能段）
  assert.deepEqual(
    bodies[0].messages.slice(0, 3).map(m => m.role),
    ['system', 'system', 'system'],
  );
  assert.match(bodies[0].messages[1].content, /^# 本次可操作范围\n/);
  assert.match(bodies[0].messages[1].content, /- 天枢阁（1 条）/);
  assert.match(bodies[0].messages[2].content, /^# 轮数预算\n/);
});

/* ---------------- 其他 ---------------- */

test('runner：AbortSignal 已中止 → done=false；dropDrafts 清空', async () => {
  installWorldbookHost({ 天枢阁: [] });
  globalThis.generateRaw = async () => '不该被调用';
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'a3',
    name: 'agent',
    items: [{ type: 'message', id: 'a3-sys', role: 'system', content: 's' }],
    use_global_caps: true,
    tools: [],
    max_rounds: 3,
  });
  const controller = new AbortController();
  controller.abort();
  const box = collect();
  const result = await runner.runAgent({ data, input: 'x', preset, history: [], signal: controller.signal, ...box.args });
  assert.equal(result.done, false);
  runner.dropDrafts();
  assert.equal(runner.draftCount(), 0);
  assert.deepEqual(data.drafts, []);
});

test('runner.runAgent：连续两轮（原生）转写合法 —— 每个 tool_calls 都有配对的 tool 结果', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  let round = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    round++;
    if (round === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [
            { message: { content: '列一下', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wb_list', arguments: '{}' } }] } },
          ],
        }),
      };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '第 ' + round + ' 轮结束' } }] }) };
  };

  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = presetOf({
    id: 'a4',
    name: 'agent',
    items: [{ type: 'message', id: 'a4-sys', role: 'system', content: '你是助手' }],
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 4,
  });
  const first = await runner.runAgent({
    data,
    input: '列一下',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...collect().args,
  });
  assert.equal(first.done, true);
  assert.deepEqual(first.turns.map(t => t.role), ['user', 'assistant', 'assistant']);

  // 第二轮：界面把 store 里的 turns（只有 user + assistant）当历史传回来
  const history = [...first.turns, { id: 'u2', role: 'user', text: '再来一次', images: [], calls: [], at: 9 }];
  const second = await runner.runAgent({
    data,
    input: '再来一次',
    preset,
    history,
    signal: new AbortController().signal,
    ...collect().args,
  });
  assert.equal(second.done, true);
  const sent = bodies[bodies.length - 1].body.messages;
  const wanted = new Set();
  for (const message of sent) {
    if (message.role === 'assistant' && message.tool_calls) for (const call of message.tool_calls) wanted.add(call.id);
  }
  const provided = new Set(sent.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  assert.ok(wanted.size >= 1, '历史里的 tool_calls 要保留');
  for (const id of wanted) assert.ok(provided.has(id), 'tool_call ' + id + ' 没有配对的 tool 结果');
  assert.equal(sent.filter(m => m.role === 'user').length, 2, '两条用户消息，不重复');
});

test('runner.runAgent：工具卡通过 session.turns 那条路更新（onToolUpdate 给的是界面里的对象）', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  let round = 0;
  globalThis.generateRaw = async () => {
    round++;
    if (round === 1) return '<SystemQuery>{"name":"wb_list","args":{}}</SystemQuery>';
    return '<SystemQuery>{"name":"submit","args":{"summary":"done"}}</SystemQuery>';
  };
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'a5',
    name: 'agent',
    items: [{ type: 'message', id: 'a5-sys', role: 'system', content: 's' }],
    use_global_caps: true,
    tools: ['wb_list', 'submit'],
    max_rounds: 4,
  });
  const updates = [];
  const result = await runner.runAgent({
    data,
    input: '列一下',
    preset,
    history: [],
    signal: new AbortController().signal,
    onTurn: turn => data.session.turns.push(turn), // 模拟 store.appendTurn
    onToolUpdate: (turnId, index, call) => updates.push({ turnId, index, call }),
    onArtifact: () => {},
    onNotice: () => {},
  });

  const inStore = data.session.turns.find(turn => turn.role === 'assistant' && turn.calls.length);
  assert.ok(inStore, 'assistant 轮次要进了 session.turns');
  assert.equal(inStore.calls[0].ok, true);
  assert.match(inStore.calls[0].brief, /^本次范围 1 本 · 列出 1 本 · 共 1 条（启用 1）$/);
  const last = updates.filter(item => item.call.name === 'wb_list').at(-1);
  assert.equal(last.turnId, inStore.id);
  assert.equal(last.index, 0);
  assert.equal(last.call, inStore.calls[0], 'onToolUpdate 必须给界面里那个对象');
  const submitTurn = result.turns.find(turn => turn.calls[0] && turn.calls[0].name === 'submit');
  assert.equal(submitTurn.calls[0].ok, true);
});

/* ---------------- 流式增量（onDelta） ---------------- */

test('runner.runAgent：原生流式会发 onDelta，delta 的 turnId 对应轮次已经发布，最终文本以 reply.text 为准', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const previousFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let read = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => (read < chunks.length ? { done: false, value: encoder.encode(chunks[read++]) } : { done: true }),
      }),
    },
  });
  try {
    const runner = createRunner();
    const data = makeData();
    data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: true, send_images: false, timeout_sec: 30 };
    const preset = presetOf({
      id: 'od1',
      name: 'agent',
      items: [{ type: 'message', id: 'od1-sys', role: 'system', content: '你是助手' }],
      use_global_caps: true,
      tools: ['wb_list'],
      max_rounds: 3,
    });

    const publishedTurns = [];
    const deltas = [];
    const publishedAtDelta = [];
    const result = await runner.runAgent({
      data,
      input: '流式跑一下',
      preset,
      history: [],
      signal: new AbortController().signal,
      onTurn: turn => publishedTurns.push(turn),
      onToolUpdate: () => {},
      onArtifact: () => {},
      onNotice: () => {},
      onDelta: (turnId, text) => {
        deltas.push({ turnId, text });
        publishedAtDelta.push(publishedTurns.some(turn => turn.id === turnId));
      },
    });

    assert.equal(result.via, 'native');
    assert.equal(read, chunks.length, 'SSE 三块都读完了');
    assert.deepEqual(deltas.map(item => item.text), ['你', '好']);
    assert.equal(new Set(deltas.map(item => item.turnId)).size, 1, '整轮共用一个 turnId');
    assert.ok(publishedAtDelta.every(Boolean), '收到增量时那条轮次已经在 onTurn 里了（UI 才能往它上面追加）');

    const assistant = result.turns.find(turn => turn.role === 'assistant');
    assert.equal(assistant.id, deltas[0].turnId);
    assert.equal(assistant.text, '你好', '最终文本以 reply.text 为准');
    assert.ok(publishedTurns.some(turn => turn.id === assistant.id), '轮次真的进过 UI');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runner.runAgent：文本通道一条 onDelta 都不发', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  globalThis.generateRaw = async () => '好的。<SystemQuery>{"name":"submit","args":{"summary":"done"}}</SystemQuery>';
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'od2',
    name: 'agent',
    items: [{ type: 'message', id: 'od2-sys', role: 'system', content: '你是助手' }],
    use_global_caps: true,
    tools: ['submit'],
    max_rounds: 3,
  });
  const box = collect();
  const result = await runner.runAgent({
    data,
    input: '走文本通道',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...box.args,
  });
  assert.equal(result.via, 'text');
  assert.deepEqual(box.deltas, [], '文本通道不该有流式增量');
  assert.equal(result.turns.find(turn => turn.role === 'assistant').text, '好的。');
});

/* ---------------- 特殊层（v4） ---------------- */

test('runner.runAgent：上下文特殊层原生展开 —— 角色分明、插在它所在的位置', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '看完了' } }] }) };
  };
  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = presetOf({
    id: 'ctx1',
    name: '带上下文特殊层的 agent',
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 2,
    items: [
      { type: 'message', id: 'c1-sys', role: 'system', content: '你是助手' },
      { type: 'special', id: 'c1-ctx', kind: 'context' },
    ],
  });
  const history = [
    { id: 'h1', role: 'user', text: '第一问', images: [], calls: [], at: 1 },
    { id: 'h2', role: 'assistant', text: '第一答', images: [], calls: [], at: 2 },
    { id: 'h3', role: 'user', text: '第二问', images: [], calls: [], at: 3 },
  ];

  const result = await runner.runAgent({
    data,
    input: '第二问',
    preset,
    history,
    signal: new AbortController().signal,
    ...collect().args,
  });

  assert.equal(result.done, true);
  const sent = bodies[0].messages;
  assert.deepEqual(
    sent.map(message => message.role),
    ['system', 'system', 'system', 'user', 'assistant', 'user'],
  );
  assert.equal(sent[0].content, '你是助手');
  assert.match(sent[1].content, /^# 本次可操作范围/);
  assert.match(sent[2].content, /^# 轮数预算/);
  // 历史**原样搬**：不加【用户】前缀、不重命名角色
  assert.equal(sent[3].content, '第一问');
  assert.equal(sent[4].content, '第一答');
  assert.equal(sent[5].content, '第二问');
  assert.ok(!sent[3].content.includes('【'), '原生展开不许加文本前缀');
  assert.equal(sent.filter(message => message.role === 'user').length, 2, '有上下文层就不再隐式补一次历史');
});

test('runner.runAgent：用户需求特殊层展开成一条 user 消息，并补记用户轮次', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '收到' } }] }) };
  };
  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = presetOf({
    id: 'u1',
    name: '用户需求层',
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 2,
    items: [
      { type: 'message', id: 'u1-sys', role: 'system', content: '你是助手' },
      { type: 'special', id: 'u1-user', kind: 'user' },
    ],
  });
  const box = collect();
  const result = await runner.runAgent({
    data,
    input: '把天枢阁压短',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...box.args,
  });

  const sent = bodies[0].messages;
  assert.deepEqual(sent.map(message => message.role), ['system', 'system', 'system', 'user']);
  assert.equal(sent.at(-1).content, '把天枢阁压短', '内容就是 {{用户需求}} 的取值');
  assert.equal(sent.filter(message => message.role === 'user').length, 1, '不许再补一条重复的用户消息');
  // 轮次记录不能少（历史里没有这条用户消息，runner 自己补一条）
  assert.deepEqual(box.turns.map(turn => turn.role), ['user', 'assistant']);
  assert.equal(box.turns[0].text, '把天枢阁压短');
  assert.equal(result.done, true);
});

test('runner.runPlain：上下文特殊层原生展开（角色分明、顺序正确）', async () => {
  installWorldbookHost({ 天枢阁: [] });
  let seen = null;
  globalThis.generateRaw = async config => {
    seen = config.ordered_prompts;
    return '好';
  };
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'pc1',
    name: 'plain + 上下文层',
    output: 'none',
    items: [
      { type: 'message', id: 'pc1-sys', role: 'system', content: '你是助手' },
      { type: 'special', id: 'pc1-ctx', kind: 'context' },
      { type: 'message', id: 'pc1-user', role: 'user', content: '现在：{{用户需求}}' },
    ],
  });
  const history = [
    { id: 'p1', role: 'user', text: '第一问', images: [], calls: [], at: 1 },
    { id: 'p2', role: 'assistant', text: '第一答', images: [], calls: [], at: 2 },
  ];
  await runner.runPlain({
    data,
    input: '第二问',
    preset,
    history,
    signal: new AbortController().signal,
    ...collect().args,
  });

  assert.deepEqual(seen.map(prompt => prompt.role), ['system', 'user', 'assistant', 'user']);
  assert.match(seen[0].content, /你是助手/);
  assert.equal(seen[1].content, '第一问', '历史原样搬，不加【用户】前缀');
  assert.equal(seen[2].content, '第一答');
  assert.equal(seen[3].content, '现在：第二问');
  assert.equal(seen.filter(prompt => prompt.role === 'user').length, 2, '用户需求已经写进消息里，不再补一条');
});

test('runner.runAgent：上下文层 + 用户需求层同时存在时，本轮需求只出现一次', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '收到' } }] }) };
  };
  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = presetOf({
    id: 'dup1',
    name: '上下文 + 用户需求',
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 2,
    items: [
      { type: 'message', id: 'd1-sys', role: 'system', content: '你是助手' },
      { type: 'special', id: 'd1-ctx', kind: 'context' },
      { type: 'special', id: 'd1-user', kind: 'user' },
    ],
  });
  // 界面在 onSend 里已经把这条用户消息记进 turns 了 —— 历史末尾就是本轮需求
  const history = [
    { id: 'x1', role: 'user', text: '第一问', images: [], calls: [], at: 1 },
    { id: 'x2', role: 'user', text: '第二问', images: [], calls: [], at: 2 },
  ];
  await runner.runAgent({
    data,
    input: '第二问',
    preset,
    history,
    signal: new AbortController().signal,
    ...collect().args,
  });

  const sent = bodies[0].messages;
  assert.equal(sent.filter(message => message.role === 'user' && message.content === '第二问').length, 1, '本轮需求只能有一条');
  assert.equal(sent.at(-1).content, '第二问', '而且要在最后');
  assert.deepEqual(sent.map(message => message.role), ['system', 'system', 'system', 'user', 'user']);
});

/* ---------------- 两级能力启用（v4） ---------------- */

test('runner：两级能力 —— 默认跟随全局（工具走 default_on），打开后只发预设自己勾的', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '完了' } }] }) };
  };
  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const items = [{ type: 'message', id: 'cap-sys', role: 'system', content: '你是助手' }];

  // 默认：use_global_caps = false —— 自己一条工具都没勾，照样发「能力」页的全局默认
  const followGlobal = presetOf({ id: 'cap1', name: '跟随全局', items, tools: [], skills: [], max_rounds: 2 });
  assert.equal(followGlobal.use_global_caps, false);
  await runner.runAgent({
    data,
    input: '列一下',
    preset: followGlobal,
    history: [],
    signal: new AbortController().signal,
    ...collect().args,
  });
  const globalNames = bodies[0].tools.map(tool => tool.function.name);
  assert.ok(globalNames.includes('wb_read'), '默认开的工具要在：' + globalNames.join('、'));
  assert.ok(globalNames.includes('submit'));
  assert.ok(!globalNames.includes('gen_image'), 'gen_image 默认关，跟随全局时不该出现');
  assert.ok(!globalNames.includes('ask_user'), 'ask_user 默认关，跟随全局时不该出现');
  assert.ok(!globalNames.includes('entry_meta'), 'entry_meta 默认关，跟随全局时不该出现');

  // 打开：只用预设自己勾的，一条都不多
  const ownOnly = presetOf({
    id: 'cap2',
    name: '只用预设的',
    items,
    use_global_caps: true,
    tools: ['wb_read'],
    max_rounds: 2,
  });
  await runner.runAgent({
    data,
    input: '列一下',
    preset: ownOnly,
    history: [],
    signal: new AbortController().signal,
    ...collect().args,
  });
  assert.deepEqual(
    bodies[1].tools.map(tool => tool.function.name),
    ['wb_read'],
  );
});

test('runner：内置「势力整理 Agent」跟随全局 —— 照旧跑工具循环，发全局默认工具，上下文层不重复补历史', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '收工' } }] }) };
  };
  const runner = createRunner();
  const data = makeData();
  data.api = { route: 'custom', url: 'https://api.test/v1', key: 'k', model: 'm', stream: false, send_images: false, timeout_sec: 30 };
  const preset = createBuiltinPresets().find(item => item.id === 'builtin-agent-worldbook');
  assert.ok(preset, '内置 agent 预设不见了');
  const globalCaps = { tools: DEFAULT_ON_TOOLS.map(name => ({ name, default_on: true })), skills: data.skills };
  assert.equal(isAgentPreset(preset, globalCaps), true, '跟随全局 + 全局默认有工具 = Agent，App.vue 才会调 runAgent');

  const history = [{ id: 'h1', role: 'user', text: '整理天枢阁', images: [], calls: [], at: 1 }];
  await runner.runAgent({
    data,
    input: '整理天枢阁',
    preset,
    history,
    signal: new AbortController().signal,
    ...collect().args,
  });

  const sent = bodies[0];
  const names = sent.tools.map(tool => tool.function.name);
  assert.ok(names.includes('wb_read') && names.includes('entry_edit') && names.includes('submit'), '全局默认工具都在：' + names.join('、'));
  assert.ok(!names.includes('gen_image'), '默认关的工具不发');
  assert.match(sent.messages[0].content, /苍玄界世界书的整理助手/, '第一条是预设自己的系统提示词');
  assert.equal(sent.messages.filter(message => message.role === 'user' && message.content === '整理天枢阁').length, 1, '上下文层展开的历史只带一条本轮需求，不再补第二次');
});

test('runner：两级能力 —— 技能跟随 skill.enabled / 打开后只认预设勾的（关掉的仍然不发）', async () => {
  installWorldbookHost({ 天枢阁: [] });
  const systems = [];
  globalThis.generateRaw = async config => {
    const system = config.ordered_prompts.find(prompt => prompt.role === 'system');
    systems.push(system ? system.content : '');
    return '收工。<SystemQuery>{"name":"submit","args":{"summary":"done"}}</SystemQuery>';
  };
  const runner = createRunner();
  const data = makeData();
  data.skills = [
    { id: 's1', name: '甲技能', summary: '甲的一句话', body: '甲正文SECRET', files: [], enabled: true, builtin: false },
    { id: 's2', name: '乙技能', summary: '乙的一句话', body: '乙正文SECRET', files: [], enabled: false, builtin: false },
  ];
  const items = [{ type: 'message', id: 'sk-sys', role: 'system', content: '你是助手' }];
  const run = preset =>
    runner.runAgent({
      data,
      input: '干活',
      preset,
      history: [],
      signal: new AbortController().signal,
      ...collect().args,
    });

  // 跟随全局：只有 enabled 的技能进「可用技能」
  await run(presetOf({ id: 'sk1', name: '跟随全局', items, tools: ['submit'], max_rounds: 1 }));
  assert.match(systems[0], /# 可用技能/);
  assert.match(systems[0], /- 甲技能：甲的一句话/);
  assert.ok(!systems[0].includes('乙技能'), '关掉的技能不该进系统提示词');
  assert.ok(!systems[0].includes('甲正文SECRET'), '技能正文不许进系统提示词');

  // 打开：只认预设勾的 —— 勾了一个关着的 = 一条都不发
  await run(presetOf({ id: 'sk2', name: '只用预设的', items, use_global_caps: true, tools: ['submit'], skills: ['s2'], max_rounds: 1 }));
  assert.ok(!systems[1].includes('# 可用技能'), '勾了一个关着的技能 = 没有可用技能：' + systems[1]);

  // 打开 + 勾上启用的那个 → 只有它
  await run(
    presetOf({ id: 'sk3', name: '只用预设的', items, use_global_caps: true, tools: ['submit'], skills: ['s1', 's2'], max_rounds: 1 }),
  );
  assert.match(systems[2], /- 甲技能：甲的一句话/);
  assert.ok(!systems[2].includes('乙技能'), '关掉的技能就算被勾了也不发');
});
