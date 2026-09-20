/**
 * 验收补充：agent/registry.ts —— 13 个工具的 JSON Schema 合法性（用 zod.fromJSONSchema 真校验）、
 * 默认开关、空参调用不炸，以及 entry_edit 的 old_string 语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const agent = '../../src/苍玄助手/agent/';
const { createRegistry, TOOL_NAMES, DEFAULT_ON_TOOLS, TOOL_GROUP_LABELS } = await import(agent + 'registry.ts');
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
    ctx: { worlds: over.worlds ?? ['天枢阁'], drafts, skills: over.skills ?? [] },
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

test('registry: 13 个工具、顺序、分组、审计一致', () => {
  const registry = createRegistry(makePort());
  assert.deepEqual(registry.names(), [...TOOL_NAMES]);
  assert.equal(TOOL_NAMES.length, 13);
  assert.deepEqual(registry.audit(), { ok: true, missing: [], extra: [] });
  // ports.ts 给 ToolDef['group'] 加了 'external'（工具页要显示外部工具），分组表必须齐
  assert.deepEqual(Object.keys(TOOL_GROUP_LABELS).sort(), ['external', 'flow', 'image', 'knowledge', 'skill', 'write']);
  for (const def of registry.defs) {
    assert.ok(def.title && def.desc && def.model_description.length > 10, def.name + ' 缺文案');
    assert.ok(Object.keys(TOOL_GROUP_LABELS).includes(def.group), def.name + ' 分组不对');
    assert.equal(typeof def.run, 'function');
  }
  assert.equal(registry.has('wb_read'), true);
  assert.equal(registry.has('nope'), false);
  assert.equal(registry.byName('nope'), undefined);
  assert.equal(registry.port().list instanceof Function, true);
});

test('registry: 默认开关与设计稿一致（entry_meta / ask_user / create_skill / gen_image 默认关）', () => {
  const registry = createRegistry(makePort());
  assert.deepEqual(
    registry.defs.filter(def => def.default_on).map(def => def.name),
    [...DEFAULT_ON_TOOLS],
  );
  assert.equal(DEFAULT_ON_TOOLS.length, 9);
  for (const name of ['entry_meta', 'ask_user', 'create_skill', 'gen_image']) {
    assert.equal(registry.byName(name).default_on, false, name + ' 应该默认关');
  }
  assert.equal(registry.byName('create_skill').user_initiated_only, true);
  assert.match(registry.byName('create_skill').model_description, /仅当用户明确要求时使用/);
  assert.ok(registry.catalog().every(row => row.missing === false && row.title));
});

/* ============================ JSON Schema 合法性 ============================ */

test('registry: 每个工具的 parameters 都是合法且可序列化的 JSON Schema', () => {
  const registry = createRegistry(makePort());
  for (const def of registry.defs) {
    const params = def.parameters;
    assert.equal(params.type, 'object', def.name + ': 顶层 type 必须是 object');
    assert.ok(Object.keys(params.properties ?? {}).length > 0, def.name + ': 至少要有一个参数');
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

test('registry: 嵌套对象参数都自带 description（keys_secondary / create_skill.files 元素）', () => {
  // 回归 task-9 的 P3-3：以前 schemaObject() 不给嵌套对象写 description，模型只看得到子字段。
  const registry = createRegistry(makePort());
  for (const name of ['entry_create', 'entry_meta']) {
    const nested = registry.byName(name).parameters.properties.keys_secondary;
    assert.equal(nested.type, 'object');
    assert.equal(typeof nested.description, 'string', name + '.keys_secondary 应该有 description');
    assert.ok(nested.description.length > 10, name + '.keys_secondary 的 description 要能说清用途');
    assert.match(nested.description, /次关键词|keys_secondary/);
    assert.ok(nested.properties.logic.description && nested.properties.keys.description);
  }

  const filesItem = registry.byName('create_skill').parameters.properties.files.items;
  assert.equal(filesItem.type, 'object');
  assert.equal(typeof filesItem.description, 'string');
  assert.match(filesItem.description, /参考文件/);
  assert.ok(filesItem.properties.name.description && filesItem.properties.content.description);
});

test('registry: specs() / pick() 只发勾上的工具且顺序固定', () => {
  const registry = createRegistry(makePort());
  const all = registry.specs();
  assert.equal(all.length, 13);
  assert.deepEqual(
    all.map(spec => spec.name),
    [...TOOL_NAMES],
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
  assert.equal(registry.pick([]).length, 13, '空数组 = 全给');
});

test('registry: 13 个工具拿空对象调用都不炸，且都给出人话 brief', async () => {
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

/* ============================ entry_edit 的 old_string 语义 ============================ */

test('entry_edit: 0 命中 → 报错、草稿不动、世界书不写', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '风起。云涌。')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '1', old_string: '不存在的一段', new_string: 'X' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.brief, /找不到/);
  assert.match(result.detail, /一字不差/);
  assert.equal(drafts.count(), 0);
  assert.equal(port.writes.length, 0);
});

test('entry_edit: 多命中不加 replace_all → 报错并给上下文建议；草稿不动', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '风起。云涌。风起。')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '1', old_string: '风起', new_string: '雷落' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.brief, /命中 2 处，不唯一/);
  assert.match(result.detail, /replace_all=true/);
  assert.equal(drafts.count(), 0);
});

test('entry_edit: replace_all 全换（split/join，字面量安全），草稿记全量 before/after', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', '风起。云涌。风起。')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '1', old_string: '风起', new_string: '雷落', replace_all: true }, ctx);
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /替换 2 处/);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'edit');
  assert.equal(change.uid, '1');
  assert.equal(change.label, 'A');
  assert.equal(change.before, '风起。云涌。风起。');
  assert.equal(change.after, '雷落。云涌。雷落。');
  assert.deepEqual(change.payload, { old_string: '风起', new_string: '雷落', replace_all: true, add: 1, del: 1 });
  assert.equal(port.writes.length, 0, '草稿阶段不许写回');
});

test('entry_edit: 唯一命中时只换一处，其余一字不动；落地后 extra 还在', async () => {
  const port = makePort({ 天枢阁: [entry('42', '天枢阁', '总部在苍梧山，掌门为凌霄真人')] });
  const { ctx, drafts } = ctxOf(port);
  const result = await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '42', old_string: '总部在苍梧山', new_string: '总部位于苍梧山巅' }, ctx);
  assert.equal(result.ok, true, result.detail);
  assert.equal(drafts.list()[0].after, '总部位于苍梧山巅，掌门为凌霄真人');
  const report = await drafts.apply(port);
  assert.equal(report.ok, true);
  assert.equal(port.writes[0].entries[0].content, '总部位于苍梧山巅，掌门为凌霄真人');
  assert.equal(port.writes[0].entries[0].extra.raw_field, 'keep-me');
  assert.equal(drafts.count(), 0, '写成功才清草稿');
});

test('entry_edit: old_string 为空 / 只给 new_string → 拒绝整条重写', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'abc')] });
  const { ctx, drafts } = ctxOf(port);
  const edit = createRegistry(port).byName('entry_edit');
  for (const args of [
    { world: '天枢阁', uid: '1', new_string: '整条新内容' },
    { world: '天枢阁', uid: '1', old_string: '', new_string: 'x' },
  ]) {
    const result = await edit.run(args, ctx);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(drafts.count(), 0);
  }
  const same = await edit.run({ world: '天枢阁', uid: '1', old_string: 'abc', new_string: 'abc' }, ctx);
  assert.equal(same.ok, false);
  assert.match(same.brief, /没有变化/);
  assert.equal(drafts.count(), 0);
  const noUid = await edit.run({ world: '天枢阁', old_string: 'abc', new_string: 'abd' }, ctx);
  assert.equal(noUid.ok, false);
  assert.match(noUid.brief, /uid/);
});

test('entry_edit: 写范围受 ctx.worlds 限制；uid 不存在要报错', async () => {
  const port = makePort({ 天枢阁: [entry('1', 'A', 'a')], 别本: [entry('9', 'B', 'b')] });
  const { ctx, drafts } = ctxOf(port, { worlds: ['天枢阁'] });
  const edit = createRegistry(port).byName('entry_edit');
  const outside = await edit.run({ world: '别本', uid: '9', old_string: 'b', new_string: 'c' }, ctx);
  assert.equal(outside.ok, false);
  assert.match(outside.detail, /《别本》不在本次可操作范围内。本次只能用：天枢阁。/);
  assert.match(outside.detail, /如果需要《别本》，请让用户去「世界书」页勾上/);
  const missing = await edit.run({ world: '天枢阁', uid: '404', old_string: 'a', new_string: 'b' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.brief, /没找到 uid 404/);
  assert.equal(drafts.count(), 0);
});

test('entry_edit: new_string 里的 $& / $ 反引号 / 单引号美元 / $$ / $1 一律当字面量（单命中与 replace_all 都一样）', async () => {
  // 回归 task-9 的 P3-1：旧实现单命中走 String.replace(old, new)，会把 $& 当替换模式，
  // 与 replace_all 的 split/join 行为不一致；现在两个分支共用 split/join，一律字面量。
  const specials = ['$&X', "$'尾巴", '$\u0060前缀', '$$', '$1', 'a$&b$1c'];
  for (const replaceAll of [false, true]) {
    const port = makePort({ 天枢阁: [entry('1', 'A', 'abc')] });
    const { ctx, drafts } = ctxOf(port);
    const edit = createRegistry(port).byName('entry_edit');
    for (const newString of specials) {
      drafts.clear();
      const result = await edit.run(
        { world: '天枢阁', uid: '1', old_string: 'b', new_string: newString, replace_all: replaceAll },
        ctx,
      );
      assert.equal(
        result.ok,
        true,
        'replace_all=' + replaceAll + ' new_string=' + JSON.stringify(newString) + ' → ' + result.detail,
      );
      assert.equal(drafts.list()[0].after, 'a' + newString + 'c', '必须字面量落进正文：' + JSON.stringify(newString));
    }
  }

  // 正则/替换元字符同样不参与解释
  const port = makePort({ 天枢阁: [entry('1', 'A', 'x(y)z')] });
  const { ctx, drafts } = ctxOf(port);
  await createRegistry(port)
    .byName('entry_edit')
    .run({ world: '天枢阁', uid: '1', old_string: '(y)', new_string: '$&$1[$]' }, ctx);
  assert.equal(drafts.list()[0].after, 'x$&$1[$]z');
});
