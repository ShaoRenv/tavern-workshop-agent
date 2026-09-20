/**
 * runner 接线：草稿视图 + 默认守卫 + 工具覆盖项；以及工具页要的 catalog 内置默认值。
 * 假 transport（假 generateRaw / 假 fetch）+ setHostBridge 假世界书宿主，不依赖 UI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createRunner } = await import(root + 'run/runner.ts');
const { createRegistry } = await import(root + 'agent/registry.ts');
const { setHostBridge, migrateRootData } = await import(root + 'core/storage.ts');
const { RootDataSchema, PresetSchema } = await import(root + 'core/types.ts');
const { createWorldbookPort } = await import(root + 'core/worldbook.ts');

function rawEntry(uid, name, content) {
  return {
    uid,
    name,
    enabled: true,
    content,
    strategy: { type: 'selective', keys: [name] },
    position: 0,
    depth: 4,
    order: 100,
  };
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
      worlds.set(
        name,
        entries.map(item => ({ ...item })),
      );
    },
    createWorldbook: name => worlds.set(name, []),
    deleteWorldbook: name => worlds.delete(name),
  });
  return { worlds, calls };
}

function makeData(over = {}) {
  const data = migrateRootData(RootDataSchema.parse({})).data;
  data.session = data.sessions[0];
  data.api = { route: 'tavern', url: '', key: '', model: '', stream: false, send_images: false, timeout_sec: 30 };
  data.selection.worldbook_names = ['天枢阁'];
  Object.assign(data, over);
  return data;
}

function presetOf(over) {
  return PresetSchema.parse(over);
}

function runBox() {
  const turns = [];
  const updates = [];
  const notices = [];
  return {
    turns,
    updates,
    notices,
    args: {
      onTurn: turn => turns.push(turn),
      onToolUpdate: (turnId, index, call) => updates.push({ turnId, index, call }),
      onArtifact: () => {},
      onNotice: text => notices.push(text),
    },
  };
}

/* ---------------- 草稿视图接线 ---------------- */

test('runner：工具层走草稿视图 —— 建完能读到、连着改两处都不丢、saveDrafts 合起来落地', async () => {
  const host = installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', '天枢阁总部在苍梧山，掌门为凌霄真人')] });
  let round = 0;
  globalThis.generateRaw = async () => {
    round++;
    if (round === 1) {
      return [
        '先读再看。',
        '<SystemQuery>{"name":"wb_read","args":{"world":"天枢阁","uid":"42"}}</SystemQuery>',
        '<SystemQuery>{"name":"entry_create","args":{"world":"天枢阁","name":"新条目","content":"刚建出来的条目"}}</SystemQuery>',
      ].join('\n');
    }
    if (round === 2) {
      return '<SystemQuery>{"name":"entry_edit","args":{"world":"天枢阁","uid":"42","old_string":"总部在苍梧山","new_string":"总部位于苍梧山巅"}}</SystemQuery>';
    }
    if (round === 3) {
      // 改过之后先重读（observe-guard 的版本 CAS 会要求这一点），再基于第一处改动继续改：
      // 没有草稿视图，第二处的 old_string 根本找不到
      return [
        '<SystemQuery>{"name":"wb_read","args":{"world":"天枢阁","uid":"42"}}</SystemQuery>',
        '<SystemQuery>{"name":"entry_edit","args":{"world":"天枢阁","uid":"42","old_string":"总部位于苍梧山巅","new_string":"总部位于苍梧山巅（云海之上）"}}</SystemQuery>',
        // 分页读要能看到刚建的条目
        '<SystemQuery>{"name":"wb_read","args":{"world":"天枢阁","limit":5}}</SystemQuery>',
      ].join('\n');
    }
    return '<SystemQuery>{"name":"submit","args":{"summary":"改完了"}}</SystemQuery>';
  };

  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'a1',
    name: 'agent',
    items: [{ type: 'message', id: 'a1-sys', role: 'system', content: '你是助手' }],
    use_global_caps: true,
    tools: ['wb_read', 'entry_create', 'entry_edit', 'submit'],
    max_rounds: 6,
  });
  const box = runBox();
  const result = await runner.runAgent({
    data,
    input: '整理天枢阁',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...box.args,
  });

  assert.equal(result.done, true);
  assert.equal(round, 4);
  // 三处改动都在草稿里（新建 + 两次编辑）
  assert.equal(data.drafts.length, 3, '三处改动都要在草稿里：' + JSON.stringify(box.notices));
  assert.deepEqual(
    data.drafts.map(draft => draft.kind),
    ['create', 'edit', 'edit'],
  );
  assert.equal(data.drafts[0].session_id, data.sessions[0].id, '草稿要归属当前会话');
  // 第二处改动的 old_string 只存在于第一处改动的成果里
  assert.match(data.drafts[2].after, /云海之上/);
  // 分页读到了刚建的条目（视图把 create 也算上）
  const readCall = box.updates.find(item => item.call.name === 'wb_read' && /刚建出来的条目/.test(item.call.detail));
  assert.ok(readCall, 'wb_read 要能看到视图里刚建的条目');

  const saved = await runner.saveDrafts();
  assert.deepEqual(saved, { applied: 3, failed: 0 });
  const written = host.calls.replace[0].entries;
  const main = written.find(item => String(item.uid) === '42');
  assert.match(main.content, /总部位于苍梧山巅（云海之上）/);
  assert.ok(
    written.some(item => item.name === '新条目'),
    '草稿建的条目也要落进世界书',
  );
});

test('runner：没读过就改 → observe-guard 拦下（NOT_OBSERVED），草稿不动', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', '天枢阁总部在苍梧山')] });
  let round = 0;
  globalThis.generateRaw = async () => {
    round++;
    if (round === 1) {
      return '<SystemQuery>{"name":"entry_edit","args":{"world":"天枢阁","uid":"42","old_string":"总部在苍梧山","new_string":"总部位于苍梧山巅"}}</SystemQuery>';
    }
    return '<SystemQuery>{"name":"submit","args":{"summary":"收到"}}</SystemQuery>';
  };
  const runner = createRunner();
  const data = makeData();
  const preset = presetOf({
    id: 'a2',
    name: 'agent',
    items: [{ type: 'message', id: 'a2-sys', role: 'system', content: 's' }],
    use_global_caps: true,
    tools: ['entry_edit', 'submit'],
    max_rounds: 4,
  });
  const box = runBox();
  const result = await runner.runAgent({
    data,
    input: '改一下',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...box.args,
  });
  assert.equal(result.done, true);
  assert.equal(data.drafts.length, 0, '被拦下就不该有草稿');
  const editCall = box.updates.find(item => item.call.name === 'entry_edit');
  assert.equal(editCall.call.ok, false);
  assert.match(editCall.call.detail, /entry has not been read — wb_read it, then retry/);
  assert.match(editCall.call.detail, /cannot modify "天枢阁"/);
});

/* ---------------- 工具覆盖项 ---------------- */

test('runner：tool_overrides 套进发给模型的 specs（原生通道）', async () => {
  installWorldbookHost({ 天枢阁: [rawEntry(42, '天枢阁', 'x')] });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '好' } }] }),
    };
  };
  const runner = createRunner();
  const data = makeData({
    api: {
      route: 'custom',
      url: 'https://api.test/v1',
      key: 'k',
      model: 'm',
      stream: false,
      send_images: false,
      timeout_sec: 30,
    },
    tool_overrides: {
      wb_list: {
        description: '被用户改过的工具说明',
        param_descriptions: { in_scope_only: '被用户改过的参数说明' },
        timeout_ms: 1234,
      },
    },
  });
  const preset = presetOf({
    id: 'a3',
    name: 'agent',
    items: [{ type: 'message', id: 'a3-sys', role: 'system', content: 's' }],
    use_global_caps: true,
    tools: ['wb_list'],
    max_rounds: 2,
  });
  await runner.runAgent({
    data,
    input: '列一下',
    preset,
    history: [],
    signal: new AbortController().signal,
    ...runBox().args,
  });
  const tool = bodies[0].tools[0];
  assert.equal(tool.function.name, 'wb_list');
  assert.equal(tool.function.description, '被用户改过的工具说明');
  // 阶段 3：wb_list 的参数从 current_only 改成 in_scope_only（列全部 + 标绑定范围）
  assert.equal(tool.function.parameters.properties.in_scope_only.description, '被用户改过的参数说明');
});

test('catalog：给工具详情页的是 ToolDef 原样值（不套覆盖），覆盖只影响 specs', () => {
  installWorldbookHost({ 天枢阁: [] });
  const registry = createRegistry(createWorldbookPort());
  const row = registry.catalog().find(item => item.name === 'wb_list');
  const def = registry.byName('wb_list');
  assert.ok(row && def);
  assert.equal(row.group_label, '读世界书');
  assert.equal(row.model_description, def.model_description, 'catalog 给的是内置默认值');
  assert.deepEqual(row.parameters, def.parameters);
  assert.equal(row.source, undefined);
  assert.equal(row.missing, false);
  assert.equal(typeof row.parameters.properties.in_scope_only.description, 'string');

  const overrides = { wb_list: { description: '用户版', param_defaults: { in_scope_only: true } } };
  const spec = registry.specs(['wb_list'], overrides)[0];
  assert.equal(spec.description, '用户版');
  assert.equal(spec.parameters.properties.in_scope_only.default, true);
  // 覆盖不改 def / catalog（「恢复默认」的基准不能被污染）
  assert.notEqual(registry.byName('wb_list').model_description, '用户版');
  assert.equal(registry.catalog().find(item => item.name === 'wb_list').model_description, def.model_description);
});
