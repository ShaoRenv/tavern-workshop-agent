/**
 * 验收补充：core/types.ts 的校验契约 + core/storage.ts 的逐块恢复 / 读写 / 防抖。
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const core = '../../src/苍玄助手/core/';
const { RootDataSchema, PresetSchema, ApiSettingsSchema, DATA_VERSION, GLOBAL_KEY, uid, roleLabel, migratePresetItems } =
  await import(core + 'types.ts');
const {
  recoverRootData,
  migrateRootData,
  defaultRootData,
  loadData,
  readStoredRootData,
  saveData,
  saveRootData,
  setHostBridge,
  saveRootDataDebounced,
  flushSave,
  cancelPendingSave,
  hasPendingSave,
  hostFn,
  hasHostFn,
  isPlainRecord,
  getHostBridge,
  resetDataScope,
  resetLoadOutcome,
  resetUserTouchedData,
} = await import(core + 'storage.ts');

/* ============================ types 校验 ============================ */

test('types: RootDataSchema.parse({}) 各块默认值齐全（老数据零字段也能跑）', () => {
  const data = RootDataSchema.parse({});
  assert.equal(data.version, DATA_VERSION);
  assert.equal(data.active_tab, 'chat', '阶段 3：默认页从 portraits 改成 chat（立绘页撤了）');
  assert.deepEqual(data.api, {
    route: 'tavern',
    url: '',
    key: '',
    model: '',
    stream: false,
    send_images: false,
    timeout_sec: 60,
  });
  assert.deepEqual(data.gen, { image_concurrency: 4, retry: 2, max_rounds: 12 });
  // v5 = v4 + 插件化：插件开关从 plugins.<id>.enabled 搬到 plugin_state
  assert.equal(DATA_VERSION, 5, 'v5 = 多会话 + 工具覆盖 + 事件日志 + 预设合并 + 插件开关');
  // 页面集合不再由 core/types.ts 的 TAB_IDS 说了算（页面注册表在 core/pages.ts + 插件 manifest）；
  // 这里是「插件开关」那份新数据：缺省空表，开关状态按 manifest.defaultEnabled 现算。
  assert.deepEqual(data.plugin_state, {}, '缺 plugin_state 补 {}');
  // v2：会话在 sessions + active_session_id；schema 层不自动造会话（迁移/归一化才补）
  assert.deepEqual(data.sessions, []);
  assert.equal(data.active_session_id, '');
  assert.deepEqual(data.session, {
    id: '',
    title: '',
    created_at: 0,
    updated_at: 0,
    mode: 'agent',
    preset_id: '',
    turns: [],
    running: false,
    round: 0,
    started_at: 0,
  });
  assert.deepEqual(data.selection, { character_ids: [], worldbook_names: [], entry_uid: [], demand: '' });
  assert.deepEqual(data.presets, []);
  assert.deepEqual(data.skills, []);
  assert.deepEqual(data.drafts, []);
  assert.deepEqual(data.artifacts, []);
});

test('types: 非法枚举 / 越界数字被拒', () => {
  // active_tab 已放宽成 z.string()：**未知字符串不再是坏数据**（页面可能不存在，兜底在
  // core/pages.ts + stores/app.ts 的 setTab，见 plugin_registry.test.ts）；
  // 非字符串仍然是坏数据。
  assert.equal(RootDataSchema.parse({ active_tab: 'nope' }).active_tab, 'nope', '未知字符串原样保留，schema 不清洗');
  assert.equal(
    RootDataSchema.parse({ active_tab: 'portraits' }).active_tab,
    'chat',
    '阶段 3：portraits 不再是真页面，走 TAB_ID_ALIASES 兜到 chat',
  );
  assert.equal(RootDataSchema.safeParse({ active_tab: 123 }).success, false, '非字符串仍被拒');
  assert.equal(RootDataSchema.safeParse({ active_tab: ['records'] }).success, false);
  assert.equal(RootDataSchema.safeParse({ active_tab: null }).success, false);
  // 阶段 2 老页名兜底（TAB_ID_ALIASES）：记录 → 对话、能力 / 技能 → 设置，不算非法值（DATA_VERSION 不动）
  assert.equal(RootDataSchema.parse({ active_tab: 'records' }).active_tab, 'chat');
  assert.equal(RootDataSchema.parse({ active_tab: 'capability' }).active_tab, 'settings');
  assert.equal(RootDataSchema.parse({ active_tab: 'skills' }).active_tab, 'settings');
  assert.equal(RootDataSchema.safeParse({ api: { route: 'nope' } }).success, false);
  assert.equal(RootDataSchema.safeParse({ api: { timeout_sec: 0 } }).success, false);
  assert.equal(RootDataSchema.safeParse({ gen: { max_rounds: 0 } }).success, false);
  assert.equal(RootDataSchema.safeParse({ session: { round: -1 } }).success, false);
  assert.equal(RootDataSchema.safeParse({ session: { mode: 'nope' } }).success, false);
  assert.equal(RootDataSchema.safeParse({ drafts: [{ id: 'd1', kind: 'nope' }] }).success, false);
  // 预设：没有 kind 了（老 kind 当未知键剥掉，不算错），真正的非法值是条目 / 角色
  assert.equal(PresetSchema.safeParse({ id: 'p', name: 'n', kind: 'nope' }).success, true);
  assert.equal(PresetSchema.safeParse({ id: 'p', name: 'n', items: [{ type: 'nope' }] }).success, false);
  assert.equal(PresetSchema.safeParse({ id: 'p', name: 'n', items: [{ type: 'message', id: 'm', role: 'nope' }] }).success, false);
  assert.equal(PresetSchema.safeParse({ id: 'p', name: 'n', items: [{ type: 'special', id: 's', kind: 'nope' }] }).success, false);
  assert.equal(PresetSchema.safeParse({ id: 'p', name: 'n', items: [{ type: 'special', id: 's', kind: 'context' }] }).success, true);
  assert.equal(ApiSettingsSchema.safeParse({ route: 'custom' }).success, true);
});

test('types: 块内缺字段自动补 default；未声明的键被剥掉（不污染存储）', () => {
  const data = RootDataSchema.parse({
    nope: 'unknown-top-level',
    presets: [{ id: 'p1', name: '老预设', messages: [{ id: 'm1', role: 'system', content: 'x' }] }],
    skills: [{ id: 's1', name: '老技能' }],
    drafts: [{ id: 'd1', kind: 'edit', before: 'a', after: 'b' }],
  });
  assert.ok(!('nope' in data), '未声明键必须被剥掉');
  // v4：老 messages 全部迁进 items（一条不丢），kind / system / messages 三个老键剥掉
  assert.equal('kind' in data.presets[0], false, 'kind 已经没了');
  assert.equal('system' in data.presets[0], false);
  assert.equal('messages' in data.presets[0], false);
  assert.equal(data.presets[0].builtin, false);
  assert.equal(data.presets[0].max_rounds, 12);
  // 老 messages 形状（没有 kind）= 老 plain：不跟随全局，自己一条工具都没有
  assert.equal(data.presets[0].use_global_caps, true, '老 plain 不跟随全局');
  assert.deepEqual(data.presets[0].tools, []);
  assert.deepEqual(data.presets[0].skills, []);
  assert.deepEqual(data.presets[0].items, [
    {
      type: 'message',
      id: 'm1',
      name: '',
      role: 'system',
      content: 'x',
      enabled: true,
      trigger: 'always',
      trigger_words: '',
    },
  ]);
  assert.equal(data.skills[0].body, '');
  assert.deepEqual(data.skills[0].files, []);
  assert.equal(data.skills[0].enabled, true);
  assert.equal(data.drafts[0].world, '');
  assert.deepEqual(data.drafts[0].payload, {});
});

test('types: 预设 v3 → v4 迁移 —— agent 的 system / plain 的 messages 迁进 items，一条都不丢，幂等', () => {
  // agent：原来的 system 变成 items[0] 的 system 消息；tools / skills / max_rounds 原样
  const agent = PresetSchema.parse({
    id: 'a1',
    name: 'agent',
    kind: 'agent',
    builtin: false,
    output: 'worldbook',
    system: '你是苍玄界世界书整理助手。',
    messages: [],
    tools: ['wb_read', 'submit'],
    skills: ['s1'],
    max_rounds: 6,
  });
  assert.deepEqual(agent.items, [
    {
      type: 'message',
      id: 'a1-system',
      name: '系统提示词',
      role: 'system',
      content: '你是苍玄界世界书整理助手。',
      enabled: true,
      trigger: 'always',
      trigger_words: '',
    },
  ]);
  assert.deepEqual(agent.tools, ['wb_read', 'submit']);
  assert.deepEqual(agent.skills, ['s1']);
  assert.equal(agent.use_global_caps, false, '老 agent 跟随全局');
  assert.equal(agent.max_rounds, 6);
  assert.equal(agent.output, 'worldbook');

  // agent 预设的 system 是空串：不塞一条空 system 进 items
  assert.deepEqual(PresetSchema.parse({ id: 'a2', name: 'x', kind: 'agent', tools: ['wb_read'] }).items, []);

  // plain：messages 逐条补上 type，顺序不变，字段一个字不改
  const plain = PresetSchema.parse({
    id: 'p1',
    name: 'plain',
    kind: 'plain',
    output: 'json',
    messages: [
      { id: 'm1', name: '开场', role: 'system', content: '你是助手', enabled: true, trigger: 'always' },
      { id: 'm2', name: '任务', role: 'user', content: '{{用户需求}}', enabled: false, trigger: 'not_first_round', trigger_words: '压一压' },
    ],
  });
  assert.equal(plain.items.length, 2, '两条消息一条都不能丢');
  assert.deepEqual(
    plain.items.map(item => item.type),
    ['message', 'message'],
  );
  assert.equal(plain.items[0].role, 'system');
  assert.equal(plain.items[0].content, '你是助手');
  assert.equal(plain.items[1].role, 'user');
  assert.equal(plain.items[1].content, '{{用户需求}}');
  assert.equal(plain.items[1].enabled, false);
  assert.equal(plain.items[1].trigger, 'not_first_round');
  assert.equal(plain.items[1].trigger_words, '压一压');
  assert.equal(plain.use_global_caps, true, '老 plain 不跟随全局（自己能力为空）');
  assert.deepEqual(plain.tools, [], '老 plain 不该留下工具');

  // 幂等 + 确定性：同一个老对象跑两次结果完全一致（id 不重新生成）
  const legacy = { id: 'a1', name: 'agent', kind: 'agent', system: 'S', messages: [{ id: 'm1', role: 'user', content: 'c' }] };
  const once = migratePresetItems(legacy);
  assert.deepEqual(migratePresetItems(once), once);

  // 已经是新形状的：原样返回（引用都不变，别每次读盘都造新对象）
  const fresh = PresetSchema.parse({
    id: 'n1',
    name: '新',
    items: [{ type: 'message', id: 'x', role: 'user', content: 'y' }],
    use_global_caps: true,
  });
  assert.equal(migratePresetItems(fresh), fresh);
  assert.equal(fresh.use_global_caps, true);

  // 老预设夹在整份 RootData 里也走同一条路；版本号提到 4
  const root = RootDataSchema.parse({ version: 3, presets: [legacy] });
  assert.equal(root.presets[0].items.length, 2);
  assert.equal(root.presets[0].items[1].content, 'c');
  assert.equal(migrateRootData(root).data.version, DATA_VERSION);
});

test('types: 迁移口径 —— 老 plain → use_global_caps=true + tools=[]；老 agent → false（保留自己的工具）', () => {
  // 老 plain：就算数据里残留了 tools 也不算数（那条路从来没跑过工具循环）
  const plain = PresetSchema.parse({
    id: 'p-plain',
    name: 'plain 带残留工具',
    kind: 'plain',
    messages: [{ id: 'm1', role: 'user', content: 'x' }],
    tools: ['wb_read'],
  });
  assert.equal(plain.use_global_caps, true, 'plain 不跟随全局');
  assert.deepEqual(plain.tools, [], 'plain 的残留工具要清掉，否则迁移后会被当成 Agent');

  // 老 agent：跟随全局；自己勾的工具原样保留（以后关掉全局还能用）
  const agent = PresetSchema.parse({
    id: 'p-agent',
    name: 'agent',
    kind: 'agent',
    system: 'S',
    tools: ['wb_read', 'submit'],
    skills: ['s1'],
  });
  assert.equal(agent.use_global_caps, false, 'agent 跟随全局');
  assert.deepEqual(agent.tools, ['wb_read', 'submit']);
  assert.deepEqual(agent.skills, ['s1']);

  // 没有 kind 的老数据按 plain 处理（v3 的默认形态）
  const noKind = PresetSchema.parse({ id: 'p-none', name: '没有 kind', messages: [{ id: 'm1', role: 'user', content: 'x' }] });
  assert.equal(noKind.use_global_caps, true);

  // 新形状只是缺这个开关：按 schema 默认（跟随全局），工具不动
  const fresh = PresetSchema.parse({ id: 'p-fresh', name: '新', items: [{ type: 'message', id: 'm', role: 'system', content: 's' }], tools: ['wb_read'] });
  assert.equal(fresh.use_global_caps, false, '新形状缺开关 = 跟随全局');
  assert.deepEqual(fresh.tools, ['wb_read']);
});

test('types: parse 结果可直接 JSON 序列化（能原样存进酒馆变量）', () => {
  const data = RootDataSchema.parse({});
  const json = JSON.parse(JSON.stringify(data));
  assert.deepEqual(json, data);
  assert.equal(typeof json.api.timeout_sec, 'number');
});

test('types: uid / roleLabel 小工具', () => {
  const a = uid('draft');
  const b = uid('draft');
  assert.match(a, /^draft_[0-9a-z]+_[0-9a-z]+$/);
  assert.notEqual(a, b);
  assert.equal(roleLabel('system'), 'SYST');
  assert.equal(roleLabel('assistant'), 'AI');
  assert.equal(roleLabel('user'), 'USER');
});

/* ============================ storage：逐块恢复 ============================ */

test('storage: recoverRootData(null / undefined) 给填满的默认值 + 静默补一条会话，不报警', () => {
  for (const empty of [null, undefined]) {
    const result = recoverRootData(empty);
    // v2 里「没有会话」属于正常情况：静默补一条「新对话」，不刷警告
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.data, migrateRootData(defaultRootData()).data);
    assert.equal(result.data.version, DATA_VERSION);
    assert.equal(result.data.gen.image_concurrency, 4, '默认值必须是填满的，不能是 {}');
    assert.equal(result.data.sessions.length, 1);
    assert.equal(result.data.sessions[0].id, 'sess-default');
    assert.equal(result.data.sessions[0].title, '新对话');
    assert.equal(result.data.active_session_id, 'sess-default', 'active 要指得上');
    assert.equal(result.data.session.id, 'sess-shell', '单数 session 只是兼容空壳');
    assert.deepEqual(result.data.session.turns, [], '聊天记录不存两份');
  }
});

test('storage: 顶层不是对象时整体回退默认值 + 一条警告（不抛）', () => {
  for (const bad of ['坏数据', 42, true, []]) {
    const result = recoverRootData(bad);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /不是对象/);
    assert.equal(result.data.active_tab, 'chat');
  }
});

test('storage: 坏块逐块恢复 —— 好数据保留、坏块换默认、数组逐条丢坏留好', () => {
  const result = recoverRootData({
    version: 99,
    // 坏值的口径变了：active_tab 放宽成 string 之后，未知字符串不算坏数据，
    // 只有非字符串才进不了 schema（未知字符串的兜底见 plugin_registry.test.ts）
    active_tab: 123,
    api: { route: 'nope' },
    gen: { image_concurrency: -1 },
    presets: [{ id: 'p1', name: '好的' }, { name: '缺 id' }, '坏条目'],
    skills: '不是数组',
    drafts: [{ kind: 'nope' }],
    artifacts: null,
  });

  assert.equal(result.data.active_tab, 'chat');
  assert.equal(result.data.api.route, 'tavern');
  assert.equal(result.data.api.timeout_sec, 60);
  assert.equal(result.data.gen.image_concurrency, 4);
  assert.equal(result.data.presets.length, 1);
  assert.equal(result.data.presets[0].name, '好的');
  assert.deepEqual(result.data.skills, []);
  assert.deepEqual(result.data.drafts, []);
  assert.deepEqual(result.data.artifacts, []);

  const text = result.warnings.join('\n');
  assert.match(text, /active_tab/);
  assert.match(text, /存储块 api 校验失败/);
  assert.match(text, /存储块 gen 校验失败/);
  assert.match(text, /存储块 presets 有 2 条数据不合法（已丢弃），保留 1 条/);
  assert.match(text, /存储块 skills 校验失败/);
  assert.match(text, /存储块 drafts 有 1 条数据不合法/);
  assert.match(text, /存储块 artifacts 校验失败/);
  assert.match(text, /数据版本 99 与当前版本 5 不一致/);
  // 只有「比当前版本新」才会报这一条（storage.ts 里老数据交给迁移警告），
  // 文案 v3 起统一成「与当前版本 N 不一致，已按当前版本读取」，上面已经断言过了
  assert.match(text, /已按当前版本读取/);
  // active_tab(123) / api / gen / presets / skills / drafts / artifacts + 版本号 = 8 条
  assert.equal(result.warnings.length, 8);
  assert.equal(result.data.sessions.length, 1, '没会话就补一条');
  assert.equal(result.data.active_session_id, 'sess-default');
});

test('storage: active_tab 未知字符串不再被清洗；老页名走 TAB_ID_ALIASES 兜底（不报警告）', () => {
  // 老数据里合法、但页面可能不存在 / 已改名的 id：读进来原样保留，绝不是坏块
  const recovered = recoverRootData({ active_tab: 'nope' });
  assert.deepEqual(recovered.warnings, []);
  assert.equal(recovered.data.active_tab, 'nope');
  assert.equal(recoverRootData({ active_tab: 'portraits' }).data.active_tab, 'chat', '老页名 portraits → chat');
  // 阶段 2 老页名兜底：记录 → 对话、能力 / 技能 → 设置（整份读入口也过 migrateTabId）
  assert.equal(recoverRootData({ active_tab: 'records' }).data.active_tab, 'chat');
  assert.equal(recoverRootData({ active_tab: 'capability' }).data.active_tab, 'settings');
  assert.equal(recoverRootData({ active_tab: 'skills' }).data.active_tab, 'settings');
  // 非字符串仍然按坏块换默认值
  assert.equal(recoverRootData({ active_tab: 123 }).data.active_tab, 'chat');
  assert.equal(recoverRootData({ active_tab: ['records'] }).data.active_tab, 'chat');
});

test('storage: 好数据原样读出（不改内容、不误报警告）', () => {
  const raw = defaultRootData();
  raw.active_tab = 'worldbook';
  raw.selection.demand = '整理天枢阁';
  raw.presets = PresetSchema.parse({ id: 'p1', name: 'P' }) && [PresetSchema.parse({ id: 'p1', name: 'P' })];
  const result = recoverRootData(raw);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.data, migrateRootData(raw).data);
  assert.equal(result.data.active_tab, 'worldbook');
  assert.equal(result.data.selection.demand, '整理天枢阁');

  // 老页签名也走「原样读出」这条路：阶段 2 起 'skills' 落到 'settings'（能力并进设置），不报警告
  const legacyTab = recoverRootData({ active_tab: 'skills' });
  assert.deepEqual(legacyTab.warnings, []);
  assert.equal(legacyTab.data.active_tab, 'settings');
});

test('storage: recoverRootData 对奇形怪状输入不抛异常', () => {
  for (const raw of [{}, { api: [] }, { presets: {} }, { session: 1 }, { drafts: 'x' }, { version: 'v1' }]) {
    const result = recoverRootData(raw);
    assert.equal(typeof result.data, 'object');
    assert.ok(Array.isArray(result.warnings));
    assert.equal(result.data.active_tab, 'chat');
  }
});

/* ============================ storage：读 ============================ */

test('storage: loadData 走宿主 getVariables（**按形态选作用域**），缺接口时给默认值', () => {
  // ⚠️ P4-10 改：原来只断言 { type: 'script' }。新契约是「按形态分流」，
  // 所以脚本形态 / 扩展形态**两面都钉** —— 只钉一面等于没测到真正的契约。
  const saved = {
    scriptId: globalThis.__CX_SCRIPT_ID__,
    helper: globalThis.TavernHelper,
    bare: globalThis.getScriptId,
  };
  try {
    // ---- 形态一：脚本形态 → 带 script_id 的脚本作用域 ----
    delete globalThis.TavernHelper;
    delete globalThis.getScriptId;
    globalThis.__CX_SCRIPT_ID__ = 'sid-storage';
    resetDataScope();
    resetLoadOutcome();
    const scriptScopes = [];
    setHostBridge({
      getVariables: scope => {
        scriptScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'chat', gen: { retry: 5 } } };
      },
    });
    const data = loadData();
    assert.equal(data.active_tab, 'chat');
    assert.equal(data.gen.retry, 5);
    assert.equal(data.gen.image_concurrency, 4, '没写的字段要补 default');
    assert.deepEqual(scriptScopes, [{ type: 'script', script_id: 'sid-storage' }], '脚本形态：读走脚本变量');

    // ---- 形态二：扩展形态 → global（P4-10：否则真机读不回来） ----
    delete globalThis.__CX_SCRIPT_ID__;
    resetDataScope();
    resetLoadOutcome();
    const extScopes = [];
    setHostBridge({
      getVariables: scope => {
        extScopes.push(scope);
        return { [GLOBAL_KEY]: { active_tab: 'chat', gen: { retry: 5 } } };
      },
    });
    assert.equal(loadData().active_tab, 'chat');
    assert.deepEqual(extScopes, [{ type: 'global' }], '扩展形态：读必须走 global');
  } finally {
    setHostBridge(null);
    if (saved.scriptId === undefined) delete globalThis.__CX_SCRIPT_ID__;
    else globalThis.__CX_SCRIPT_ID__ = saved.scriptId;
    if (saved.helper !== undefined) globalThis.TavernHelper = saved.helper;
    if (saved.bare !== undefined) globalThis.getScriptId = saved.bare;
    resetDataScope();
    resetLoadOutcome();
  }
  assert.equal(readStoredRootData(), null, '没宿主读不到 → null');
});

/* ============================ storage：写 ============================ */

/**
 * P4-10：写作用域也是**按形态分流**的，所以三个降级用例都两面钉。
 *
 * 用法：runInBothForms(body)，body 收到 { scopes, expectedScope }，
 * 分别在「脚本形态」与「扩展形态」下各跑一遍，断言各自该用的作用域。
 */
function runInBothForms(body) {
  const saved = {
    scriptId: globalThis.__CX_SCRIPT_ID__,
    helper: globalThis.TavernHelper,
    bare: globalThis.getScriptId,
  };
  const current = () => globalThis.__CX_SCRIPT_ID__;
  try {
    // 形态一：脚本形态
    delete globalThis.TavernHelper;
    delete globalThis.getScriptId;
    globalThis.__CX_SCRIPT_ID__ = 'sid-write';
    resetDataScope();
    resetLoadOutcome();
    resetUserTouchedData();
    body({ form: 'script', expectedScope: { type: 'script', script_id: 'sid-write' } });

    // 形态二：扩展形态
    delete globalThis.__CX_SCRIPT_ID__;
    resetDataScope();
    resetLoadOutcome();
    resetUserTouchedData();
    body({ form: 'extension', expectedScope: { type: 'global' } });
  } finally {
    setHostBridge(null);
    if (saved.scriptId === undefined) delete globalThis.__CX_SCRIPT_ID__;
    else globalThis.__CX_SCRIPT_ID__ = saved.scriptId;
    if (saved.helper !== undefined) globalThis.TavernHelper = saved.helper;
    if (saved.bare !== undefined) globalThis.getScriptId = saved.bare;
    resetDataScope();
    resetLoadOutcome();
    resetUserTouchedData();
    void current;
  }
}

test('storage: 没有任何变量接口时 saveData 抛错（store 会 catch）', () => {
  try {
    setHostBridge({});
    // ⚠️ P4-10 改：报错文案更新 —— 现在要说清「没有写入接口」，也要带上作用域信息。
    // 期望仍钉住**真实原因**（是「没有可用的变量写入接口」），不是泛泛的「保存失败」。
    assert.throws(() => saveData(defaultRootData()), /没有可用的变量写入接口/);
    assert.equal(saveRootData(defaultRootData()), false, 'saveRootData 不抛，返回 false');
  } finally {
    setHostBridge(null);
  }
});

test('storage: 优先 insertOrAssignVariables，只动我们那一个 key（作用域按形态分流）', () => {
  runInBothForms(({ form, expectedScope }) => {
    const calls = [];
    setHostBridge({
      insertOrAssignVariables: (payload, options) => calls.push({ payload, options }),
    });
    const data = defaultRootData();
    data.selection.demand = '整理天枢阁';
    saveData(data);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, expectedScope, form + '：写作用域要跟读一致');
    assert.equal(calls[0].payload[GLOBAL_KEY].selection.demand, '整理天枢阁');
    assert.equal(calls[0].payload[GLOBAL_KEY].version, DATA_VERSION);
    assert.ok(!('other' in calls[0].payload), '整表接口不该被用');
    // 核心意图之一仍在：只动我们那一个 key，别人的变量不碰
    assert.deepEqual(Object.keys(calls[0].payload), [GLOBAL_KEY], '只许动 GLOBAL_KEY 那一个键');
  });
});

test('storage: 退化到 replaceVariables 时保留别人的变量（作用域按形态分流）', () => {
  runInBothForms(({ form, expectedScope }) => {
    const replaced = [];
    setHostBridge({
      getVariables: () => ({ someone_else: { a: 1 }, [GLOBAL_KEY]: { active_tab: 'chat' } }),
      replaceVariables: (next, options) => replaced.push({ next, options }),
    });
    saveData(defaultRootData());
    assert.equal(replaced.length, 1);
    // 核心意图仍在：别人的变量必须被保留
    assert.deepEqual(replaced[0].next.someone_else, { a: 1 }, form + '：不许把别人的变量抹掉');
    assert.equal(replaced[0].next[GLOBAL_KEY].active_tab, 'chat');
    assert.deepEqual(replaced[0].options, expectedScope, form + '：写作用域要跟读一致');
  });
});

test('storage: 退化到 updateVariablesWith 时保留别人的变量（作用域按形态分流）', () => {
  runInBothForms(({ expectedScope }) => {
    let merged = null;
    setHostBridge({
      updateVariablesWith: (updater, options) => {
        merged = { value: updater({ someone_else: 7 }), options };
      },
    });
    saveData(defaultRootData());
    assert.equal(merged.value.someone_else, 7);
    assert.equal(merged.value[GLOBAL_KEY].version, DATA_VERSION);
    assert.deepEqual(merged.options, expectedScope, '写作用域要跟读一致');
  });
});

test('storage: 写入前先校验修复坏块（坏值不会落盘）', () => {
  const calls = [];
  try {
    setHostBridge({ insertOrAssignVariables: payload => calls.push(payload) });
    saveData({
      // 非字符串才是坏块；未知字符串是合法 id（页面存不存在由 store 兜底）
      active_tab: 123,
      gen: { image_concurrency: -3 },
      presets: [{ name: '缺 id' }, { id: 'ok', name: '好' }],
    });
    const stored = calls[0][GLOBAL_KEY];
    assert.equal(stored.active_tab, 'chat');
    assert.equal(stored.gen.image_concurrency, 4);
    assert.deepEqual(
      stored.presets.map(item => item.id),
      ['ok'],
    );
  } finally {
    setHostBridge(null);
  }
});

/* ============================ storage：防抖 ============================ */

test('storage: 防抖保存只落最后一次，flush / cancel 语义正确', async () => {
  const writes = [];
  try {
    setHostBridge({ insertOrAssignVariables: payload => writes.push(payload) });
    const first = defaultRootData();
    first.selection.demand = '第一次';
    const second = defaultRootData();
    second.selection.demand = '第二次';

    saveRootDataDebounced(first, 5);
    saveRootDataDebounced(second, 5);
    assert.equal(hasPendingSave(), true);
    assert.equal(writes.length, 0, '还没到点不许写');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(hasPendingSave(), false);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][GLOBAL_KEY].selection.demand, '第二次');

    const third = defaultRootData();
    saveRootDataDebounced(third, 10000);
    assert.equal(flushSave(), true);
    assert.equal(hasPendingSave(), false);
    assert.equal(writes.length, 2);
    assert.equal(flushSave(), false, '没有挂起的返回 false');

    saveRootDataDebounced(third, 10000);
    cancelPendingSave();
    assert.equal(hasPendingSave(), false);
    assert.equal(flushSave(), false);
    assert.equal(writes.length, 2);
  } finally {
    cancelPendingSave();
    setHostBridge(null);
  }
});

/* ============================ storage：宿主接口查找 ============================ */

test('storage: hostFn 优先级 —— 注入 > TavernHelper > 全局；isPlainRecord 排除数组', () => {
  const scope = globalThis;
  const previousHelper = scope.TavernHelper;
  try {
    setHostBridge({ probe: () => 'injected' });
    assert.equal(getHostBridge().probe(), 'injected');
    scope.TavernHelper = { probe: () => 'tavern' };
    assert.equal(hostFn('probe')(), 'injected', '注入的优先级最高');
    scope.onlyGlobal = () => 'helper-scope';
    assert.equal(hostFn('onlyGlobal')(), 'helper-scope', 'TavernHelper 上没有就走全局同名函数');

    setHostBridge(null);
    assert.equal(hostFn('probe')(), 'tavern', '没注入时走 TavernHelper');
    scope.onlyGlobal = () => 'global';
    assert.equal(hostFn('onlyGlobal')(), 'global', 'TavernHelper 没实现时走全局同名函数');
    assert.equal(hasHostFn('nothing'), false);
    assert.equal(hostFn('nothing'), null);

    assert.equal(isPlainRecord({}), true);
    assert.equal(isPlainRecord([]), false);
    assert.equal(isPlainRecord(null), false);
    assert.equal(isPlainRecord('x'), false);
  } finally {
    setHostBridge(null);
    delete scope.onlyGlobal;
    if (previousHelper === undefined) delete scope.TavernHelper;
    else scope.TavernHelper = previousHelper;
  }
});