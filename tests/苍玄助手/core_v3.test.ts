/**
 * 验收（task-22）：v3 数据模型 —— 工具覆盖项进 RootData + v2 → v3 迁移。
 *
 * 覆盖：
 *  - RootData 新增 tool_overrides（缺省 {}、往返、坏数据逐项兜底）
 *  - v2 → v3 迁移：补 tool_overrides、会话补 events、草稿回填 session_id、**幂等**
 *  - 老数据原样读出（只加新字段，不动旧字段）
 *  - adapters.toUiTools 全字段透传（工具详情页要的字段不能丢）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { DATA_VERSION, RootDataSchema, ToolOverrideMapSchema, makeSession } = await import(root + 'core/types.ts');
const { migrateRootData, recoverRootData, loadData, saveData, setHostBridge, defaultRootData } = await import(root + 'core/storage.ts');
const { toUiTools } = await import(root + 'core/adapters.ts');

function turn(id, role, text, at) {
  return { id, role, text, images: [], calls: [], at };
}
function draft(id, over = {}) {
  return { id, kind: 'edit', world: '苍玄界', uid: '42', label: '天枢阁', before: '旧文', after: '新文', payload: {}, at: 1, ...over };
}
function turnOfVersion2() {
  return turn('t1', 'user', '帮我把天枢阁压短', 111);
}

test('v3: RootDataSchema.parse({}) 的 tool_overrides / events 默认值', () => {
  assert.equal(DATA_VERSION, 5, 'v5 = v4 + 插件开关搬到 plugin_state');
  const data = RootDataSchema.parse({});
  assert.deepEqual(data.tool_overrides, {}, '缺 tool_overrides 补 {}');
  assert.deepEqual(data.plugin_state, {}, 'v5：缺 plugin_state 补 {}（开关缺省取 manifest.defaultEnabled）');
  assert.deepEqual(ToolOverrideMapSchema.parse(undefined), {});
  assert.deepEqual(data.sessions, []);
  assert.equal('events' in data.session, false, '单数 session 是 v1/v2 老形状，不带 v3 的 events');
  assert.deepEqual(defaultRootData().tool_overrides, {});
});

test('v3 迁移: v2 老数据补覆盖项 / 事件 / 草稿归属，且不报警', () => {
  const result = recoverRootData({
    version: 2,
    active_tab: 'chat',
    api: { route: 'custom', url: 'https://api.example/v1', key: 'sk-x', model: 'm' },
    // 老预设形状（v3）：kind + system，读出来要被迁进 items
    presets: [{ id: 'p1', name: '我的预设', kind: 'agent', system: '老系统提示词' }],
    sessions: [
      {
        id: 's1',
        title: '甲',
        created_at: 100,
        updated_at: 200,
        mode: 'agent',
        preset_id: 'p1',
        turns: [turnOfVersion2()],
        running: false,
        round: 0,
        started_at: 100,
      },
    ],
    active_session_id: 's1',
    drafts: [draft('d1')],
    artifacts: [{ id: 'a1', kind: 'json', name: 'x.json', data: '{}' }],
  });

  const data = result.data;
  assert.equal(data.version, 5);
  assert.deepEqual(data.tool_overrides, {}, '缺 tool_overrides 补 {}');
  assert.deepEqual(data.plugin_state, {}, 'v2 老数据没有插件开关：留空，按 manifest 缺省现算');
  assert.deepEqual(data.sessions[0].events, [], '老会话补空事件数组');
  assert.equal(data.drafts[0].session_id, 's1', '老草稿回填到当前会话');
  assert.deepEqual(result.warnings, [], 'v2 → v3 是正常升级，不该刷警告');
  assert.equal(migrateRootData(RootDataSchema.parse({ version: 2 })).migrated, true, '版本升了就算迁移过');

  // 老字段一个不动
  assert.equal(data.api.url, 'https://api.example/v1');
  assert.equal(data.presets[0].name, '我的预设');
  assert.equal(data.presets[0].items.length, 1, '老 system 迁进 items[0]');
  assert.equal(data.presets[0].items[0].role, 'system');
  assert.equal(data.presets[0].items[0].content, '老系统提示词');
  assert.equal(data.presets[0].use_global_caps, false);
  assert.deepEqual(data.sessions[0].turns, [turnOfVersion2()]);
  assert.equal(data.sessions[0].title, '甲');
  assert.equal(data.drafts[0].before, '旧文');
  assert.equal(data.drafts[0].after, '新文');
  assert.equal(data.artifacts[0].name, 'x.json');
  assert.equal(data.active_session_id, 's1');
});

test('v3 迁移: 幂等（再跑一次结果一样、migrated=false、无警告）', () => {
  const v2 = RootDataSchema.parse({
    version: 2,
    sessions: [makeSession({ id: 's1', title: '甲', turns: [turnOfVersion2()] })],
    active_session_id: 's1',
    drafts: [draft('d1')],
  });
  const once = migrateRootData(v2);
  const twice = migrateRootData(once.data);
  assert.deepEqual(twice.data, once.data);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.warnings, []);
  assert.deepEqual(migrateRootData(twice.data).data, once.data);

  // 已经是 v3 的干净数据：原样返回
  const clean = migrateRootData(once.data);
  assert.deepEqual(clean.data, once.data);
  assert.equal(clean.migrated, false);
  assert.deepEqual(clean.warnings, []);
});

test('v3 迁移: v1 → v3 一次到位（会话、事件、草稿归属一起补）', () => {
  const result = migrateRootData(
    RootDataSchema.parse({
      version: 1,
      session: { mode: 'chat', preset_id: 'p-old', turns: [turnOfVersion2()], running: false, round: 1, started_at: 100 },
      drafts: [draft('d1')],
    }),
  );
  assert.equal(result.migrated, true);
  assert.match(result.warnings.join('\n'), /检测到 v1 单会话数据/);
  assert.equal(result.data.version, 5);
  assert.equal(result.data.sessions.length, 1);
  assert.equal(result.data.sessions[0].id, 'sess-legacy');
  assert.deepEqual(result.data.sessions[0].events, []);
  assert.deepEqual(result.data.sessions[0].turns, [turnOfVersion2()]);
  assert.equal(result.data.drafts[0].session_id, 'sess-legacy', '草稿认到迁移后的会话');
  assert.deepEqual(result.data.tool_overrides, {});
  assert.equal(result.data.session.id, 'sess-shell');
});

test('tool_overrides: 往返（saveData → loadData）', () => {
  const table = {};
  try {
    setHostBridge({
      getVariables: () => table,
      insertOrAssignVariables: patch => Object.assign(table, patch),
    });
    const data = defaultRootData();
    data.tool_overrides = {
      wb_read: { description: '先读再改，别猜', param_descriptions: { uid: '条目 uid' }, timeout_ms: 8000, edited_at: 123 },
      gen_image: { config: { size: '1024x1024' } },
    };
    saveData(data);

    const back = loadData();
    assert.deepEqual(back.tool_overrides.wb_read, {
      description: '先读再改，别猜',
      param_descriptions: { uid: '条目 uid' },
      timeout_ms: 8000,
      edited_at: 123,
    });
    assert.deepEqual(back.tool_overrides.gen_image, { config: { size: '1024x1024' } });
    assert.deepEqual(back.tool_overrides.entry_edit, undefined);

    // 第二条：没有覆盖项的老数据读出来是 {}
    table[Object.keys(table)[0]] = { version: 2 };
    assert.deepEqual(loadData().tool_overrides, {});
  } finally {
    setHostBridge(null);
  }
});

test('tool_overrides: 坏数据逐项兜底，不清空整张表', () => {
  const wholeBad = recoverRootData({ version: 3, tool_overrides: '不是对象' });
  assert.deepEqual(wholeBad.data.tool_overrides, {});
  assert.match(wholeBad.warnings.join('\n'), /存储块 tool_overrides/);

  const partlyBad = recoverRootData({
    version: 3,
    tool_overrides: {
      wb_read: { description: '好键', timeout_ms: 500 },
      bad_value: { timeout_ms: 'not-a-number' },
      also_bad: 42,
    },
  });
  assert.deepEqual(partlyBad.data.tool_overrides.wb_read, { description: '好键', timeout_ms: 500 });
  assert.equal(partlyBad.data.tool_overrides.bad_value, undefined, '坏键丢掉');
  assert.equal(partlyBad.data.tool_overrides.also_bad, undefined);
  assert.match(partlyBad.warnings.join('\n'), /存储块 tool_overrides 有 2 项数据不合法（已丢弃），保留 1 项/);
});

test('drafts: session_id 有默认值，老草稿迁移回填', () => {
  assert.equal(RootDataSchema.parse({}).drafts.length, 0);
  const parsed = RootDataSchema.parse({ drafts: [draft('d1', { session_id: undefined })] });
  assert.equal(parsed.drafts[0].session_id, '', 'schema 层默认空串');

  const data = recoverRootData({
    version: 2,
    sessions: [makeSession({ id: 's1' })],
    active_session_id: 's1',
    drafts: [draft('d1'), draft('d2', { session_id: 's2' })],
  }).data;
  assert.equal(data.drafts[0].session_id, 's1', '空归属回填当前会话');
  assert.equal(data.drafts[1].session_id, 's2', '已有归属不动');
});

test('adapters: toUiTools 全字段透传（工具详情页要的不能丢）', () => {
  const rows = toUiTools([
    {
      name: 'wb_read',
      title: '读条目',
      desc: '读',
      group: 'knowledge',
      group_label: '读世界书',
      default_on: true,
      user_initiated_only: false,
      missing: false,
      model_description: '按 uid 把条目读全',
      parameters: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] },
      timeout_ms: 8000,
      readonly: true,
      source: 'builtin',
      origin: 'builtin://wb_read',
    },
    { name: 'submit' },
  ]);

  assert.deepEqual(rows[0], {
    name: 'wb_read',
    title: '读条目',
    desc: '读',
    group: 'knowledge',
    group_label: '读世界书',
    default_on: true,
    user_initiated_only: false,
    missing: false,
    model_description: '按 uid 把条目读全',
    parameters: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] },
    timeout_ms: 8000,
    readonly: true,
    source: 'builtin',
    origin: 'builtin://wb_read',
  });
  assert.equal(rows[1].name, 'submit');
  assert.equal(rows[1].model_description, undefined, '内核没给的字段保持 undefined，界面据此标「还没暴露」');
  assert.equal(rows[1].parameters, undefined);
});
