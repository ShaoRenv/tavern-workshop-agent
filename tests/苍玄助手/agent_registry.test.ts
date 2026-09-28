/**
 * agent/registry.ts —— 工具注册表：清单 / 顺序 / 默认开关 / JSON Schema 合法性
 * （用 zod.fromJSONSchema 真校验）、空参调用不炸，以及 entry_edit 的 old_string 语义。
 *
 * 阶段 3 的契约变化（reports/苍玄助手-底座化实施计划.md §17.3）：
 *  - 工具从 **13 → 16**（世界书 7 + 苍玄助手 3 + 底座技能 3 + 生图 1 + 流程 2）；
 *    世界书 / 生图 / 苍玄助手的工具都从**插件目录**来（plugins/builtin/<id>/tools.ts）；
 *  - 注册表按 `TOOL_NAMES` 排序（不再随注册顺序漂移）；
 *  - **默认装配 15 个**：`gen_image` 因为生图插件 `defaultEnabled:false` 不在里面；
 *  - 所以 `audit().missing === ['gen_image']` 是**预期**，不是缺陷（image 插件开着就没这条）。
 *
 * ⚠️ 下面用到的 helper 都在文件顶部补齐（ctx.wb 必填 —— 世界书端口改成经 ctx 注入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const agent = '../../src/苍玄助手/agent/';
const {
  createRegistry,
  ToolRegistry,
  TOOL_NAMES,
  DEFAULT_ON_TOOLS,
  TOOL_GROUP_LABELS,
} = await import(agent + 'registry.ts');
const plugins = await import('../../src/苍玄助手/plugins/registry.ts');
const { DraftStore } = await import(agent + 'draft.ts');

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
]);

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
      return (worlds.get(world) ?? []).filter(entry => uids.includes(entry.uid)).map(entry => structuredClone(entry));
    },
    async search() {
      return [];
    },
    async createWorldbook() {},
    async deleteWorldbook() {},
    async writeAll(world, entries) {
      writes.push({ world, entries });
      worlds.set(
        world,
        entries.map(entry => structuredClone(entry)),
      );
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

function ctxOf(port, over = {}) {
  const drafts = over.drafts ?? new DraftStore();
  return {
    drafts,
    // 阶段 3：世界书端口经 ctx 注入（ToolContext.wb 必填）
    ctx: { wb: port, worlds: over.worlds ?? ['天枢阁'], drafts, skills: over.skills ?? [] },
  };
}

/** 按 required 造一份最小合法参数 */
function sampleArgs(params) {
  const out = {};
  for (const key of params.required ?? []) {
    const schema = params.properties[key];
    if (Array.isArray(schema.enum)) out[key] = schema.enum[0];
    else if (schema.type === 'boolean') out[key] = false;
    else if (schema.type === 'integer' || schema.type === 'number') out[key] = schema.minimum ?? 1;
    else if (schema.type === 'array') out[key] = [];
    else out[key] = 'x';
  }
  return out;
}

/* ============================ 清单 / 默认开关 ============================ */

test('registry: 14 个全集 / 默认装配 13 个、顺序按 TOOL_NAMES、分组一致', () => {
  const registry = createRegistry(makePort());
  // 全部工具名（含默认关的 gen_image 等）—— 这是「底座眼里的全集」
  //
  // ⚠️ B15-B19：世界书 7 → 5（entry_create/edit/delete/meta 合并成 wb_write，新增 wb_outline）→ 16 → 14。
  // ⚠️ B24：portrait_meta 删掉（用户：「不要元数据」）→ 14 → 13。
  // ⚠️ B21：新增 write_file / read_file → 13 → 15。
  assert.equal(TOOL_NAMES.length, 15);
  assert.deepEqual(
    [...TOOL_NAMES],
    [
      'wb_list', 'wb_outline', 'wb_read', 'wb_search', 'wb_write',
      'portrait_list', 'portrait_prompt',
      'skill', 'read_skill_file', 'create_skill',
      'write_file', 'read_file',
      'gen_image', 'submit', 'ask_user',
    ],
    'TOOL_NAMES 就是现在的 15 个（顺序 = 设置页显示顺序）',
  );
  // 默认装配：image 插件默认关 → gen_image 不在
  assert.equal(registry.names().length, 14);
  assert.deepEqual(
    registry.names(),
    [...TOOL_NAMES].filter(name => name !== 'gen_image'),
    '默认装配 = 全集去掉 gen_image（生图插件默认关）',
  );
  assert.deepEqual(registry.audit(), { ok: false, missing: ['gen_image'], extra: [] }, 'audit 报缺 gen_image 是预期的');
  // ports.ts 给 ToolDef['group'] 加了 'external'（工具页要显示外部工具），分组表必须齐
  assert.deepEqual(Object.keys(TOOL_GROUP_LABELS).sort(), ['external', 'file', 'flow', 'image', 'knowledge', 'skill', 'write']);
  for (const def of registry.defs) {
    // ⚠️ 阈值从 >10 放宽到 >=8（B15-B19）：世界书的 model_description 现在是
    // 用户批准的**一句话**（「干什么 / 什么时候用 / 返回什么」三件事），
    // 最短的是 wb_search 的「按关键词找条目。」= 8 字。
    // 原来 >10 是给「200 字领域教学」那种长文案定的 —— 那个方向已被否决。
    // 这里保留的意图是「不许空 / 不许占位符」，8 字的中文已经完全够表达。
    assert.ok(def.title && def.desc && def.model_description.length >= 8, def.name + ' 缺文案');
    assert.ok(Object.keys(TOOL_GROUP_LABELS).includes(def.group), def.name + ' 分组不对');
    assert.equal(typeof def.run, 'function');
  }
  assert.equal(registry.has('wb_read'), true);
  assert.equal(registry.has('nope'), false);
  assert.equal(registry.byName('nope'), undefined);
  assert.equal(registry.port().list instanceof Function, true);
});

test('registry: 默认开关 —— DEFAULT_ON_TOOLS 10 个，装配里 default_on 也正好 10 个', () => {
  const registry = createRegistry(makePort());
  // ⚠️ B15-B19：世界书 7 → 5（5 个全默认开）→ 11 → 10；
  // B24 删 portrait_meta → 9；B21 的 write_file/read_file 是**按需**的（不默认给）→ 仍是 9。
  assert.equal(DEFAULT_ON_TOOLS.length, 9);
  assert.deepEqual([...DEFAULT_ON_TOOLS], [
    'wb_list', 'wb_outline', 'wb_read', 'wb_search', 'wb_write',
    'portrait_list',
    'skill', 'read_skill_file', 'submit',
  ]);
  assert.deepEqual(
    registry.defs.filter(def => def.default_on).map(def => def.name),
    [
      // 世界书 5 个全默认开（合并 entry_meta 进 wb_write 之后不再有按需工具）
      'wb_list', 'wb_outline', 'wb_read', 'wb_search', 'wb_write',
      // 苍玄助手默认给的 1 个（portrait_prompt 是按需的）
      'portrait_list',
      // 底座技能 3 + 流程 1
      'skill', 'read_skill_file', 'submit',
    ],
    '装配里 default_on 的一共 9 个（顺序 = TOOL_NAMES）',
  );

  // 装配里 default_on 的那批必须与 DEFAULT_ON_TOOLS **逐个相等**（一个不多一个不少）
  assert.deepEqual(
    registry.defs.filter(def => def.default_on).map(def => def.name),
    [...DEFAULT_ON_TOOLS],
    'DEFAULT_ON_TOOLS 就是装配默认给的这批',
  );

  // 默认关的 4 个（它们在装配里，只是不默认给）：
  // portrait_prompt / create_skill / write_file / read_file
  // （entry_meta 已经合并进 wb_write 并改成默认开）
  for (const name of ['portrait_prompt', 'create_skill', 'write_file', 'read_file']) {
    assert.equal(registry.byName(name).default_on, false, name + ' 应该默认关');
  }
  // gen_image 的 default_on 也一直是 false（阶段 2 就是），但默认状态下它连 def 都没有 ——
  // 生图插件 defaultEnabled:false，所以这里要去**插件开着**的注册表里查。
  const withImage = createRegistry(makePort(), { plugin_state: { image: { enabled: true } } });
  assert.equal(withImage.byName('gen_image').default_on, false, 'gen_image 默认关（要发得在预设里显式勾）');
  assert.equal(registry.byName('create_skill').user_initiated_only, true);
  assert.match(registry.byName('create_skill').model_description, /仅当用户明确要求时使用/);

  // 默认状态下 gen_image 整个**不在**注册表里（生图插件默认关）→ 它那行 missing
  assert.equal(registry.has('gen_image'), false, '生图插件默认关 → gen_image 连 def 都没有');
  assert.deepEqual(
    registry.catalog().filter(row => row.missing).map(row => row.name),
    ['gen_image'],
    '界面清单仍列出 gen_image，并标 missing（来源已停用那条 UI）',
  );
  assert.ok(registry.catalog().every(row => row.title), '每行都要有标题');
});

test('registry（第一道闸）：插件开关直接决定装配 —— 关掉哪个插件，它的工具就不在注册表里', () => {
  // 「关掉即消失」有三层：**注册表** → 全局能力 → runner 的 liveToolDefs。
  // 这条钉最早的那层（比 runner 更早），阶段 2 验收的 F-A 就是漏了后面那层。
  const port = makePort();

  // 关世界书：wb 5 个全没，portrait 3 个还在
  const wbOff = new ToolRegistry(port, { plugin_state: { worldbook: { enabled: false } } });
  assert.deepEqual(
    wbOff.names(),
    ['portrait_list', 'portrait_prompt', 'skill', 'read_skill_file', 'create_skill', 'write_file', 'read_file', 'submit', 'ask_user'],
    '关世界书 → 只剩苍玄助手 2 + 底座 7 = 9',
  );

  // 关苍玄助手：portrait 3 个全没，wb 5 个还在
  const cxOff = new ToolRegistry(port, { plugin_state: { cangxuan: { enabled: false } } });
  assert.deepEqual(
    cxOff.names(),
    ['wb_list', 'wb_outline', 'wb_read', 'wb_search', 'wb_write', 'skill', 'read_skill_file', 'create_skill', 'write_file', 'read_file', 'submit', 'ask_user'],
    '关苍玄助手 → 只剩世界书 5 + 底座 7 = 12',
  );

  // 只开生图：gen_image 才进得来
  const imageOnly = new ToolRegistry(port, {
    plugin_state: { cangxuan: { enabled: false }, worldbook: { enabled: false }, image: { enabled: true } },
  });
  assert.deepEqual(
    imageOnly.names(),
    ['skill', 'read_skill_file', 'create_skill', 'write_file', 'read_file', 'gen_image', 'submit', 'ask_user'],
    '只开生图 → 底座技能 3 + 文件 2 + gen_image + 流程 2 = 8',
  );

  // 三个插件全关：一个插件工具都不该剩下
  const allOff = new ToolRegistry(port, {
    plugin_state: { cangxuan: { enabled: false }, worldbook: { enabled: false }, image: { enabled: false } },
  });
  assert.deepEqual(
    allOff.names(),
    ['skill', 'read_skill_file', 'create_skill', 'write_file', 'read_file', 'submit', 'ask_user'],
    '三个插件全关 → 只剩底座那 7 个',
  );

  // 全开：15 个一个不少
  const allOn = new ToolRegistry(port, {
    plugin_state: { cangxuan: { enabled: true }, worldbook: { enabled: true }, image: { enabled: true } },
  });
  assert.deepEqual(allOn.names(), [...TOOL_NAMES], '三个都开 → 恰好 15 个（= TOOL_NAMES 全集）');
  assert.deepEqual(allOn.audit(), { ok: true, missing: [], extra: [] }, '全开时 audit 干净');

  // 装配与**聚合函数**必须一致（两边都读同一份 plugin_state）
  const { pluginToolDefs } = plugins;
  for (const [label, st] of [
    ['默认', {}],
    ['关世界书', { plugin_state: { worldbook: { enabled: false } } }],
    ['关苍玄助手', { plugin_state: { cangxuan: { enabled: false } } }],
    ['全关', { plugin_state: { cangxuan: { enabled: false }, worldbook: { enabled: false }, image: { enabled: false } } }],
  ]) {
    const assembled = new ToolRegistry(port, st)
      .names()
      .filter(name => pluginToolDefs(st).some(def => def.name === name));
    // 两边**成员**必须一致；**顺序**不必 —— 注册表按 TOOL_NAMES 排（设置页显示顺序），
    // pluginToolDefs 按 manifest 声明顺序（cangxuan → worldbook → image）。
    assert.deepEqual(
      [...assembled].sort(),
      pluginToolDefs(st).map(def => def.name).sort(),
      label + '：注册表里的插件工具必须与 pluginToolDefs(state) 成员完全一致',
    );
  }
});

/* ============================ JSON Schema 合法性 ============================ */

test('registry: 每个工具的 parameters 都是合法且可序列化的 JSON Schema', () => {
  const registry = createRegistry(makePort());
  for (const def of registry.defs) {
    const params = def.parameters;
    assert.equal(params.type, 'object', def.name + ': 顶层 type 必须是 object');
    // 阶段 3：portrait_list 是**无参**工具（列角色不需要参数）→ 允许 properties 为空
    if (def.name !== 'portrait_list') {
      assert.ok(Object.keys(params.properties ?? {}).length > 0, def.name + ': 至少要有一个参数');
    }
    assert.equal(typeof params.additionalProperties, 'boolean', def.name + ': additionalProperties 要是布尔');
    for (const key of Object.keys(params))
      assert.ok(ALLOWED_SCHEMA_KEYS.has(key), def.name + ': 出现了不认识的 JSON Schema 关键字 ' + key);

    const required = params.required ?? [];
    assert.ok(Array.isArray(required));
    for (const key of required)
      assert.ok(key in params.properties, def.name + ': required 里的 ' + key + ' 没在 properties 里');

    for (const [key, schema] of Object.entries(params.properties)) {
      assert.equal(typeof schema, 'object', def.name + '.' + key + ' 不是对象');
      for (const schemaKey of Object.keys(schema))
        assert.ok(ALLOWED_SCHEMA_KEYS.has(schemaKey), def.name + '.' + key + ': 未知关键字 ' + schemaKey);
      if (schema.type === 'object') {
        // 嵌套对象也必须有 description（原生 tools 通道里模型只看得到这里写的东西）
        //
        // ⚠️ B15-B19：wb_write 合并了旧 4 个写工具，参数里**不再有嵌套对象**
        // （keys_secondary 已下沉到 skill，不进工具提示词）→ 这条对 wb_write 不适用。
        if (def.name === 'wb_write') continue;
        assert.ok(
          schema.properties && Object.keys(schema.properties).length > 0,
          def.name + '.' + key + ' 嵌套对象没 properties',
        );
        assert.equal(typeof schema.description, 'string', def.name + '.' + key + ' 嵌套对象缺 description');
        assert.ok(schema.description.length > 0, def.name + '.' + key + ' 嵌套对象 description 为空');
        for (const [nestedKey, nestedSchema] of Object.entries(schema.properties)) {
          assert.equal(
            typeof nestedSchema.description,
            'string',
            def.name + '.' + key + '.' + nestedKey + ' 缺 description',
          );
          assert.ok(nestedSchema.description.length > 0);
        }
      } else {
        assert.equal(typeof schema.description, 'string', def.name + '.' + key + ' 缺 description（模型要靠它）');
        assert.ok(schema.description.length > 0);
      }
      assert.ok(typeof schema.type === 'string' || Array.isArray(schema.enum), def.name + '.' + key + ' 缺 type');
      if (schema.type === 'array') {
        assert.ok(schema.items && typeof schema.items === 'object', def.name + '.' + key + ' 数组缺 items');
        if (schema.items.type === 'object') {
          assert.equal(
            typeof schema.items.description,
            'string',
            def.name + '.' + key + ' 的数组元素对象缺 description',
          );
          assert.ok(schema.items.description.length > 0);
          for (const [itemKey, itemSchema] of Object.entries(schema.items.properties ?? {})) {
            assert.equal(
              typeof itemSchema.description,
              'string',
              def.name + '.' + key + '[] .' + itemKey + ' 缺 description',
            );
          }
        }
      }
      if (schema.enum) assert.ok(schema.enum.length > 0 && schema.enum.every(item => typeof item === 'string'));
      if (schema.minimum !== undefined && schema.maximum !== undefined) assert.ok(schema.minimum <= schema.maximum);
    }

    // 能整包 JSON 往返（要能塞进请求体）
    assert.deepEqual(JSON.parse(JSON.stringify(params)), params, def.name + ': parameters 不能 JSON 往返');
  }
});

test('registry: 用 zod.fromJSONSchema 真解释一遍 —— 合法参数过、缺必填被拒', () => {
  const registry = createRegistry(makePort());
  for (const def of registry.defs) {
    const zodSchema = z.fromJSONSchema(def.parameters);
    const required = def.parameters.required ?? [];
    const good = zodSchema.safeParse(sampleArgs(def.parameters));
    assert.equal(good.success, true, def.name + ': 合法参数被拒 ' + JSON.stringify(good.error?.issues?.[0]));
    if (required.length) {
      const bad = zodSchema.safeParse({});
      assert.equal(bad.success, false, def.name + ': 缺必填参数不该通过');
    }
    const extraUnknown = zodSchema.safeParse({ ...sampleArgs(def.parameters), 不存在的参数: 1 });
    assert.equal(extraUnknown.success, false, def.name + ': 声明了 additionalProperties:false 就应该拒绝未知参数');
  }
});

test('registry: 嵌套对象参数都自带 description（create_skill.files 元素）', () => {
  // 回归 task-9 的 P3-3：以前 schemaObject() 不给嵌套对象写 description，模型只看得到子字段。
  //
  // ⚠️ B15-B19：wb_write 的 keys_secondary 已下沉到 skill（不进工具提示词），
  // 所以这里只剩 create_skill.files 一个嵌套对象。
  const registry = createRegistry(makePort());

  const filesItem = registry.byName('create_skill').parameters.properties.files.items;
  assert.equal(filesItem.type, 'object');
  assert.equal(typeof filesItem.description, 'string');
  assert.match(filesItem.description, /参考文件/);
  assert.ok(filesItem.properties.name.description && filesItem.properties.content.description);
});

test('registry: specs() / pick() 只发勾上的工具且顺序固定', () => {
  const registry = createRegistry(makePort());
  const all = registry.specs();
  assert.equal(all.length, 14, '默认装配 14 个（gen_image 因生图插件默认关缺席）');
  assert.deepEqual(
    all.map(spec => spec.name),
    [...TOOL_NAMES].filter(name => name !== 'gen_image'),
    '顺序 = TOOL_NAMES；gen_image 因生图插件默认关不在装配里',
  );
  for (const spec of all) {
    assert.equal(typeof spec.description, 'string');
    assert.equal(typeof spec.parameters, 'object');
  }
  const picked = registry.specs(['submit', 'wb_read']);
  assert.deepEqual(
    picked.map(spec => spec.name),
    ['wb_read', 'submit'],
    '按注册表顺序而不是传入顺序',
  );
  assert.deepEqual(registry.pick(['不存在的工具']), []);
  assert.equal(registry.pick([]).length, 14, '空数组 = 全给');
});

test('registry: 默认装配的 14 个工具拿空对象调用都不炸，且都给出人话 brief', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a')] });
  const { ctx } = ctxOf(port, {
    worlds: ['天枢阁'],
    skills: [{ id: 's1', name: '技能甲', summary: '摘要', body: '正文', files: [] }],
  });
  for (const def of createRegistry(port).defs) {
    const result = await def.run({}, ctx);
    assert.equal(typeof result, 'object', def.name + ' 没返回对象');
    assert.equal(typeof result.ok, 'boolean', def.name + ' 缺 ok');
    assert.ok(result.brief.length > 0, def.name + ' brief 为空');
    assert.equal(typeof result.detail, 'string');
  }
});
/* ============================ wb_write 的语义 ============================ */

test('wb_write: create 必填 content；缺了要拒', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx, drafts } = ctxOf(port);
  const write = createRegistry(port).byName('wb_write');
  for (const args of [
    { world: '天枢阁', action: 'create' },
    { world: '天枢阁', action: 'create', content: '   ' },
  ]) {
    const result = await write.run(args, ctx);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.brief, /content/);
  }
  assert.equal(drafts.count(), 0);
  assert.equal(port.writes.length, 0);
});

test('wb_write: action 不认识要报错并说清只能是哪三个', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port).byName('wb_write').run({ world: '天枢阁', action: '改名' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.detail, /create \/ update \/ delete/);
  assert.equal(drafts.count(), 0);
});

test('wb_write: create 落草稿，payload 完整（strategy/keys/position/order）', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('wb_write')
    .run({ world: '天枢阁', action: 'create', name: '新条目', content: '刚建出来的条目', keys: ['新'], constant: true, order: 50 }, ctx);
  assert.equal(result.ok, true, result.detail);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'create');
  assert.equal(change.label, '新条目');
  assert.equal(change.after, '刚建出来的条目');
  assert.equal(change.payload.name, '新条目');
  assert.equal(change.payload.strategy, 'constant');
  assert.deepEqual(change.payload.keys, ['新']);
  assert.equal(change.payload.order, 50);
  assert.equal(port.writes.length, 0, '草稿阶段不许写回');
});

test('wb_write: create 不给 keys 也不给 constant → 警告但不拦（可能是分节标记）', async () => {
  const port = makePort({ 天枢阁: [] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('wb_write')
    .run({ world: '天枢阁', action: 'create', name: '死条目', content: 'x' }, ctx);
  assert.equal(result.ok, true, '只警告不拦截 —— 真实数据里 4 条死条目有 2 条是故意的分节标记');
  assert.match(result.detail, /不会被任何消息触发/);
  assert.equal(drafts.count(), 1, '警告归警告，草稿照落');
});

test('wb_write: update 只改填了的字段，其余一字不动；落地后 extra 还在', async () => {
  const port = makePort({ 天枢阁: [entry('42', '天枢阁', '总部在苍梧山，掌门为凌霄真人')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('wb_write')
    .run({ world: '天枢阁', action: 'update', uid: '42', content: '总部位于苍梧山巅，掌门为凌霄真人' }, ctx);
  assert.equal(result.ok, true, result.detail);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'edit');
  assert.equal(change.after, '总部位于苍梧山巅，掌门为凌霄真人');
  assert.equal('name' in change.payload, false, '没填 name 就不该出现在 payload 里');
  const report = await drafts.apply(port);
  assert.equal(report.ok, true);
  assert.equal(port.writes[0].entries[0].content, '总部位于苍梧山巅，掌门为凌霄真人');
  assert.equal(port.writes[0].entries[0].name, '天枢阁', '没改的标题原样保留');
  assert.equal(port.writes[0].entries[0].extra.raw_field, 'keep-me');
  assert.equal(drafts.count(), 0, '写成功才清草稿');
});

test('wb_write: update 能只改属性（蓝绿灯 / 顺序），不碰正文', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '正文不动')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('wb_write')
    .run({ world: '天枢阁', action: 'update', uid: '1', constant: true, order: 7 }, ctx);
  assert.equal(result.ok, true, result.detail);
  const change = drafts.list()[0];
  assert.equal(change.payload.strategy, 'constant');
  assert.equal(change.payload.order, 7);
  assert.equal('content' in change.payload, false, '没给 content 就不该动正文');
  await drafts.apply(port);
  assert.equal(port.writes[0].entries[0].content, '正文不动');
  assert.equal(port.writes[0].entries[0].strategy, 'constant');
});

test('wb_write: update 没给 uid / 没给任何字段 → 都拒，草稿不动', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'abc')] });
  const { ctx, drafts } = ctxOf(port);
  const write = createRegistry(port).byName('wb_write');
  const noUid = await write.run({ world: '天枢阁', action: 'update', content: 'x' }, ctx);
  assert.equal(noUid.ok, false);
  assert.match(noUid.brief, /uid/);
  const noFields = await write.run({ world: '天枢阁', action: 'update', uid: '1' }, ctx);
  assert.equal(noFields.ok, false);
  assert.match(noFields.brief, /没给要改的字段/);
  assert.equal(drafts.count(), 0);
});

test('wb_write: delete 落草稿；给了 name 就必须和实际标题一致（防删错）', async () => {
  const port = makePort({ 天枢阁: [entry('1', '甲', '正文')] });
  const { ctx, drafts } = ctxOf(port);
  const write = createRegistry(port).byName('wb_write');

  const mismatched = await write.run({ world: '天枢阁', action: 'delete', uid: '1', name: '乙' }, ctx);
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.brief, /标题对不上/);
  assert.equal(drafts.count(), 0);

  const ok = await write.run({ world: '天枢阁', action: 'delete', uid: '1', name: '甲' }, ctx);
  assert.equal(ok.ok, true, ok.detail);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'delete');
  assert.equal(change.before, '正文');
  assert.equal(change.after, '');
});

test('wb_write: 写范围受 ctx.worlds 限制；uid 不存在要报错', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a')], 别本: [entry('9', 'B', 'b')] });
  const { ctx, drafts } = ctxOf(port, { worlds: ['天枢阁'] });
  const write = createRegistry(port).byName('wb_write');
  const outside = await write.run({ world: '别本', action: 'update', uid: '9', content: 'c' }, ctx);
  assert.equal(outside.ok, false);
  assert.match(outside.detail, /《别本》不在本次可操作范围内。本次只能用：天枢阁。/);
  assert.match(outside.detail, /如果需要《别本》，请让用户去「世界书」页勾上/);
  const missing = await write.run({ world: '天枢阁', action: 'update', uid: '404', content: 'b' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.brief, /没找到 uid 404/);
  const missingDelete = await write.run({ world: '天枢阁', action: 'delete', uid: '404' }, ctx);
  assert.equal(missingDelete.ok, false);
  assert.match(missingDelete.brief, /没找到 uid 404/);
  assert.equal(drafts.count(), 0);
});

test('wb_write: content 里的 $& / $1 / $$ 一律当字面量（整条替换，不做模式解释）', async () => {
  // 回归 task-9 的 P3-1 的同类问题：整条替换也不能走 String.replace 的模式解释。
  const specials = ['$&X', "$'尾巴", '$`前缀', '$$', '$1', 'a$&b$1c'];
  for (const content of specials) {
    const port = makePort({ 天枢阁: [entry('1', 'A', 'abc')] });
    const { ctx, drafts } = ctxOf(port);
    const result = await createRegistry(port)
      .byName('wb_write')
      .run({ world: '天枢阁', action: 'update', uid: '1', content }, ctx);
    assert.equal(result.ok, true, JSON.stringify(content) + ' → ' + result.detail);
    assert.equal(drafts.list()[0].after, content, '必须字面量落进正文：' + JSON.stringify(content));
  }
});