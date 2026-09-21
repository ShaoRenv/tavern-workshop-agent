/**
 * 阶段 4 · P4-5：**插件设置契约闸**（防回归的硬闸，每条都能真的失败）。
 *
 * 这批断言的价值不是「跑通」，而是**拦住改错**。最值钱的一条是「字段键必须真的能落盘」：
 * zod 会**静默丢掉**不认识的键 —— 界面写错一个 key = 用户能点、能改、刷新就丢，
 * 而且**零报错**。这种 bug 只有静态断言拦得住，跑一遍界面是看不出来的。
 *
 * 契约来源：`core/ports.ts` 的 SettingsField / SettingsGroup / SettingsSchema（阶段 4 冻结）
 * 等价基线：`reports/阶段4-声明式设置-等价基线.md`（24 个键逐行对照那张表）
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './_helpers.ts';

const srcRoot = fileURLToPath(new URL('../../src/苍玄助手/', import.meta.url));
const root = '../../src/苍玄助手/';

const { GenImageConfigSchema } = await import(root + 'core/types.ts');
const { pluginSettings, pluginSettingFields } = await import(root + 'plugins/registry.ts');

/**
 * 生图设置声明（task-19 的产物）。
 *
 * ⚠️ **故意用「运行时按需加载 + 缺失兜底」而不是顶层 import**：
 * 顶层 import 一旦文件不存在，**整个测试文件都跑不起来**（ERR_MODULE_NOT_FOUND），
 * 于是那些**不依赖它**的闸（手写表单归零、vocabulary 只有一套、条数守卫……）
 * 会连坐变成「某一条红」，看不出哪条真红、为什么红。
 * 现在缺文件时这些闸照跑，只有真正需要 `FIELDS` 的那几条被标成「等 task-19」。
 */
const imageSettings = await (async () => {
  try {
    const mod = await import(root + 'plugins/builtin/image/settings.ts');
    return { ready: true as const, fields: mod.FIELDS, groups: mod.GROUPS };
  } catch (error) {
    return { ready: false as const, error: String((error as Error)?.message ?? error) };
  }
})();

/** 等 task-19 的门：缺声明时**明确跳过并说明原因**，不让它变成一条看不懂的红 */
function needsImageSettings(t: { skip: (reason: string) => void }): boolean {
  if (imageSettings.ready) return true;
  t.skip('等 task-19（plugins/builtin/image/settings.ts 还没交付）：' + imageSettings.error);
  return false;
}

/** 只有 ready 时才可安全取用的两个值 */
const FIELDS: any[] = imageSettings.ready ? imageSettings.fields : [];
const GROUPS: any[] = imageSettings.ready ? imageSettings.groups : [];

/** 生图设置的真 schema 键（24 个）—— 一切以它为准 */
const SCHEMA_KEYS = Object.keys(GenImageConfigSchema.parse({}));

/** 永不提交的控件类型：note 是只读行、button 只 emit 动作 —— 它们没有「落盘的键」可言 */
const NON_PERSISTING_TYPES = new Set(['note', 'button']);

/**
 * 一份声明「真的会落盘」的键集合 = 字段 key（排除 note/button 与派生键）∪ options[].patch 的键。
 *
 * 为什么必须排除 note/button：它们**永远不提交**。把它们算进来会让
 * 「覆盖 24 键」这个断言失去意义 —— 多一个伪键就被当成多覆盖了一个真键。
 */
function persistingKeys(fields: readonly any[]): Set<string> {
  const out = new Set<string>();
  for (const f of fields) {
    if (DERIVED_KEYS.has(f.key)) continue;
    if (NON_PERSISTING_TYPES.has(f.type)) continue;
    out.add(f.key);
    for (const opt of f.options ?? []) {
      for (const key of Object.keys(opt.patch ?? {})) out.add(key);
    }
  }
  return out;
}

/** 纯派生键：只活在界面上，不落盘（尺寸预设那个复合控件） */
const DERIVED_KEYS = new Set(['size']);

/** 递归列出某个目录下的文件（相对 src/苍玄助手 的 posix 路径） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/* ==================== 1. 本任务最值钱的一条 ==================== */

test('⭐ 生图字段的每个 key 都必须真的能落盘（写错一个字母 = 能改、能存、刷新就丢、零报错）', t => {
  if (!needsImageSettings(t)) return;
  const bad: string[] = [];
  for (const f of FIELDS) {
    if (DERIVED_KEYS.has(f.key)) continue; // size 是界面伪键，靠 options[].patch 落 width/height
    if (NON_PERSISTING_TYPES.has(f.type)) continue; // note/button 永不提交，没有「能落盘的键」可言
    if (!SCHEMA_KEYS.includes(f.key)) bad.push(f.key);
  }
  assert.deepEqual(
    bad,
    [],
    '这些 key 不在 GenImageConfigSchema 里 —— zod 会静默丢掉它们，用户改了等于没改：' + bad.join(', '),
  );

  // 反例自检：故意拿一个 schema 里没有的键跑同一段逻辑，必须被判出来。
  // （证明上面的断言不是「永远绿」——空数组也可能是筛选逻辑写错了。）
  const probe = [...FIELDS, { key: '绝对不存在的键', label: 'x', type: 'text' }].filter(
    (f: any) => !DERIVED_KEYS.has(f.key) && !NON_PERSISTING_TYPES.has(f.type) && !SCHEMA_KEYS.includes(f.key),
  );
  assert.deepEqual(probe.map((f: any) => f.key), ['绝对不存在的键'], '这套筛选逻辑真的能抓出坏键');
});

test('⭐ 派生键（size）不许出现在 schema 里，且它必须靠 patch 写真实键', t => {
  if (!needsImageSettings(t)) return;
  // 反向的坑：把界面伪键当成真配置键存下去，会在 plugins.image 里留一个无主字段。
  assert.equal(SCHEMA_KEYS.includes('size'), false, 'size 不是真配置键（它靠 patch 写 width/height）');
  const size = FIELDS.find((f: any) => f.key === 'size');
  assert.ok(size, '尺寸那个复合控件必须在（丢掉它 = 用户失去「选预设尺寸」这条路）');
  const patched = (size.options ?? []).filter((o: any) => o.patch && Object.keys(o.patch).length);
  assert.ok(patched.length > 0, '至少有一个选项带 patch（否则它写不进 width/height）');
  for (const opt of patched) {
    for (const key of Object.keys(opt.patch)) {
      assert.ok(SCHEMA_KEYS.includes(key), 'patch 写的 ' + key + ' 必须是真配置键');
    }
  }
});

/* ==================== 2. manifest 真的接上了 ==================== */

test('pluginSettingFields（image）与 FIELDS 同源同长度（manifest 真的接了）', t => {
  if (!needsImageSettings(t)) return;
  const wired = pluginSettingFields('image');
  assert.deepEqual(
    wired,
    FIELDS,
    'manifest.contributes.settings 必须就是这份声明（同源，不是抄了一份）',
  );
  assert.equal(wired.length, FIELDS.length, '长度一致');

  // 反例自检：没接上时这里会空 —— 验证「同源」这件事真的在测（不是两边都恰好为空）
  assert.ok(FIELDS.length > 0, '生图声明不能是空的（那就是没接）');
});

test('pluginSettings（image）的 groups 也接上了，且默认返回 { fields: [] } 兜底', t => {
  if (!needsImageSettings(t)) return;
  const schema = pluginSettings('image');
  assert.deepEqual(schema.groups, GROUPS, '块声明要一起接进 manifest');
  assert.ok((schema.groups ?? []).length > 0, '生图有真实的块');
  // 没声明设置的插件：必须是 { fields: [] } 而不是 undefined（界面直接 .fields 会炸）
  assert.deepEqual(pluginSettings('cangxuan'), { fields: [] });
  assert.deepEqual(pluginSettingFields('cangxuan'), []);
});

/* ==================== 3. 24 个键一个都不许漏 ==================== */

test('生图字段覆盖 GenImageConfigSchema 的**全部 24 个键**：一个不漏、也没多余的', t => {
  if (!needsImageSettings(t)) return;
  assert.equal(SCHEMA_KEYS.length, 24, '基线报告 §1 就是 24 个键');

  // 真配置键 = 会落盘的字段（排除 note/button 与派生键）∪ patch 写的键
  const declared = persistingKeys(FIELDS);

  // 例外名单：**只读展示**的键（等价基线 §1 第 1 行：source 在旧界面就是 sourceLabel 只读标签，
  // 没有控件）。它必须有界面入口，但入口是 type:'note'，不是可编辑控件 ——
  // 所以它不进「落盘键」集合，却仍必须被**声明**（下面单独钉它的存在）。
  const READ_ONLY_KEYS = new Set(['source']);

  const missing = SCHEMA_KEYS.filter(key => !declared.has(key) && !READ_ONLY_KEYS.has(key));
  // 「漏 = 用户没法改这一项」，而且界面完全正常、没有任何报错 —— 这正是等价基线存在的理由
  assert.deepEqual(missing, [], '这些键没有任何界面入口，用户改不了：' + missing.join(', '));

  const extra = [...declared].filter(key => !SCHEMA_KEYS.includes(key));
  assert.deepEqual(extra, [], '这些键不在 schema 里，改了也存不下：' + extra.join(', '));

  // 只读键也必须有界面入口（否则界面上会少一行），只是入口类型不同
  for (const key of READ_ONLY_KEYS) {
    const f = FIELDS.find((x: any) => x.key === key);
    assert.ok(f, key + ' 是只读展示键，但也必须在声明里有它那一行');
    assert.equal(f.type, 'note', key + ' 的入口应该是 note（只读行），实际 ' + f.type);
  }

  // 反例自检：把某个真键从声明里拿掉，上面的 missing 必须报出来
  const probeMissing = SCHEMA_KEYS.filter(key => !persistingKeys(FIELDS.filter((x: any) => x.key !== 'decrisp')).has(key) && !READ_ONLY_KEYS.has(key));
  assert.deepEqual(probeMissing, ['decrisp'], '这套覆盖判定真的能抓出漏掉的键');
});

test('24 个键逐个点名（漏掉时能一眼看出是哪个，而不是只报个数字）', t => {
  if (!needsImageSettings(t)) return;
  // 逐键断言：任何一个从声明里消失，这条会直接报出它的名字。
  const declared = persistingKeys(FIELDS);

  // 注：`source` 在旧界面就是**只读标签**（等价基线 §1 第 1 行），声明成 type:'note'，
  // 所以它不属于「会落盘的键」—— 单独在下面用字段存在性钉它。
  const expectedPersisting = [
    'api_key', 'site', 'site_url', 'model',
    'sampler', 'schedule', 'steps', 'width', 'height',
    'seed', 'guidance', 'guidance_rescale',
    'smea', 'smea_dyn', 'variety', 'decrisp', 'straight_alpha',
    'quality', 'uc_preset',
    'prompt', 'prompt_end', 'negative', 'max_count',
  ];
  assert.deepEqual([...declared].sort(), [...expectedPersisting].sort());
  for (const key of expectedPersisting) {
    assert.equal(declared.has(key), true, '缺了 ' + key + ' —— 旧界面能改，新界面改不了');
  }

  // source 必须**有声明**（否则界面上少那一行「来源：NovelAI」），但走 note 通道
  const source = FIELDS.find((f: any) => f.key === 'source');
  assert.ok(source, 'source 那一行必须在（旧界面有 sourceLabel 只读标签）');
  assert.ok(
    ['note', 'select', 'text'].includes(source.type),
    'source 是只读行/只读展示，类型应是 note（实际 ' + source.type + '）',
  );
  // 真正的判据：source 不该出现在「会落盘」的集合里（它永不提交）
  assert.equal(persistingKeys([source]).has('source'), false, 'source 是只读行，不该算进落盘键');
});

/* ==================== 4. 字段形状合法性 ==================== */

test('每个 type:"select" 都必须有非空 options；每个选项都要 value + label', t => {
  if (!needsImageSettings(t)) return;
  for (const f of FIELDS) {
    if (f.type !== 'select') continue;
    assert.ok(Array.isArray(f.options) && f.options.length > 0, f.key + ' 是 select 却没有 options');
    const values = f.options.map((o: any) => o.value);
    for (const opt of f.options) {
      assert.equal(typeof opt.value, 'string', f.key + ' 的选项缺 value');
      assert.equal(typeof opt.label, 'string', f.key + ' 的选项缺 label');
      assert.ok(opt.label.length > 0, f.key + ' 的选项 ' + opt.value + ' label 是空的（界面会显示一片空白）');
    }
    assert.equal(new Set(values).size, values.length, f.key + ' 的选项 value 有重复（选了会出歧义）');
  }
});

test('不存在 min > max 的字段；type:"number" 必须有 min 和 max', t => {
  if (!needsImageSettings(t)) return;
  for (const f of FIELDS) {
    if (typeof f.min === 'number' && typeof f.max === 'number') {
      assert.ok(f.min <= f.max, f.key + ' 的 min > max（滑块/夹取都会是坏的）');
    }
    if (f.type === 'number') {
      assert.equal(typeof f.min, 'number', f.key + ' 是 number 却没声明 min（越界值会直接写进配置）');
      assert.equal(typeof f.max, 'number', f.key + ' 是 number 却没声明 max');
    }
  }
});

test('界面的 min/max 边界值必须能真的过 schema（否则用户能填出「保存就整份配置 parse 失败」的值）', t => {
  if (!needsImageSettings(t)) return;
  // 比上面那条更实在：不查 zod 内部结构，直接拿边界的**实际值**跑一次真 parse。
  // 例：steps 的 schema 是 1..50，界面若写成 max:999，用户填 999 就会让整份 plugins.image 校验失败 ——
  // 而失败的表现是「设置整块回默认」，非常难查。
  for (const f of FIELDS) {
    if (f.type !== 'number' || DERIVED_KEYS.has(f.key)) continue;
    for (const [label, value] of [['min', f.min], ['max', f.max]] as const) {
      if (typeof value !== 'number') continue;
      const parsed = GenImageConfigSchema.safeParse({ [f.key]: value });
      assert.equal(
        parsed.success,
        true,
        f.key + ' 的界面 ' + label + '(' + value + ') 过不了 schema：' + JSON.stringify(parsed.error?.issues?.[0]),
      );
    }
  }
});

test('生图字段的 default 值必须能过 schema（界面「恢复默认」写下去的就是它）', t => {
  if (!needsImageSettings(t)) return;
  // 「恢复默认」按钮写的是字段声明的 default；写错类型/越界，一按就整份配置校验失败。
  for (const f of FIELDS) {
    if (f.default === undefined || DERIVED_KEYS.has(f.key)) continue;
    const parsed = GenImageConfigSchema.safeParse({ [f.key]: f.default });
    assert.equal(
      parsed.success,
      true,
      f.key + ' 的 default(' + JSON.stringify(f.default) + ') 过不了 schema：' +
        JSON.stringify(parsed.error?.issues?.[0]),
    );
  }
});

/* ==================== 5. 块登记 ==================== */

test('每个字段的 group 都在 GROUPS 里登记（否则界面会冒出一个没名字的块）', t => {
  if (!needsImageSettings(t)) return;
  const ids = new Set(GROUPS.map((g: any) => g.id));
  const orphans = FIELDS.filter((f: any) => f.group && !ids.has(f.group)).map((f: any) => f.key);
  assert.deepEqual(orphans, [], '这些字段指了没登记的 group：' + orphans.join(', '));

  // 反向：登记了却一个字段都没有的块 = 一个永远空的标题
  const used = new Set(FIELDS.map((f: any) => f.group).filter(Boolean));
  const empty = GROUPS.filter((g: any) => !used.has(g.id)).map((g: any) => g.id);
  assert.deepEqual(empty, [], '这些块没有任何字段（会画出一个空标题）：' + empty.join(', '));
});

test('5 个块的 id / 标题与等价基线 §2 那张表一致', t => {
  if (!needsImageSettings(t)) return;
  assert.deepEqual(
    GROUPS.map((g: any) => g.title),
    ['接口', '固定提示词', '生成参数', '高级', '出图'],
    '块顺序 = 界面上的先后顺序',
  );
  for (const g of GROUPS) {
    assert.equal(typeof g.id, 'string');
    assert.ok(g.id.length > 0, '块 id 不能为空（字段靠它归属）');
    assert.ok(g.title && g.title.length > 0, g.id + ' 缺标题');
  }
  assert.equal(new Set(GROUPS.map((g: any) => g.id)).size, GROUPS.length, '块 id 不许重复');
});

/* ==================== 6. 不许有第二套 vocabulary ==================== */
//
// ⚠️ 这里**故意没有**「三个插件都声明了 contributes.requires」那条断言。
// 理由（Lead 2026-09 修正）：三个插件**现在一个都没声明** requires，而声明它会改变装载行为 ——
// 声明了必需能力、能力表又说缺失 → 该插件**整个不注册**（页面消失、工具不给模型）。
// 那是行为变更，已拆到 **task-23** 单独做（含真机验证），不该跟「设置改声明式」一起验收。
// 更要紧的是：**不能**把「现在为空」写成断言 —— 那会把一个待做的缺口钉成「正确状态」，
// 以后补上反而会红。缺的东西不该有闸。

test('源码级：不许再出现第二套字段类型 vocabulary（switch / PluginSettingField / ToolSettingsField）', t => {
  const files = walk(srcRoot).filter(file => /\.(ts|vue)$/.test(file));
  assert.ok(files.length > 20, '要真的扫到文件（否则这条是空转）');

  const offenders: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const rel = file.replace(srcRoot, '');
    // 注释里提到历史名字是允许的（core/ports.ts 就靠注释解释「为什么合并」），所以只看代码
    const code = codeOnly(raw);

    // 'switch' 不再是字段类型（布尔那个类型现在叫 'boolean'）
    if (/type\s*:\s*'switch'/.test(code) || /===\s*'switch'/.test(code)) {
      offenders.push(rel + ': 还在用 \'switch\' 当字段类型（应该用 \'boolean\'）');
    }
    // 两个旧接口名只许出现在注释里
    if (/\bToolSettingsField\b/.test(code)) offenders.push(rel + ': 还有 ToolSettingsField');
    if (/\bToolFieldType\b/.test(code)) offenders.push(rel + ': 还有 ToolFieldType');
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('源码级：PluginSettingField 只剩兼容别名（定义处最多一处），或已彻底删除', t => {
  const files = walk(srcRoot).filter(file => /\.(ts|vue)$/.test(file));
  const hits: string[] = [];
  for (const file of files) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/\bPluginSettingField\b/g)) {
      hits.push(file.replace(srcRoot, '') + ' @' + (code.slice(0, m.index).split('\n').length));
    }
  }
  // 契约定的是「只剩别名」：出现 0 次（彻底删了）或只有一处 type 别名都算合格；
  // 出现两处以上 = 有人又开了一条并行形状，正是本轮要消灭的东西。
  assert.ok(hits.length <= 1, 'PluginSettingField 出现 ' + hits.length + ' 处，应该是 0（已删）或 1（别名）：\n' + hits.join('\n'));
});

test('源码级：字段类型联合里就是 9 种控件（note 也要在，它是生图那个只读行）', t => {
  const ports = readFileSync(srcRoot + 'core/ports.ts', 'utf8');
  const block = /export type SettingsFieldType =([\s\S]*?);/.exec(ports);
  assert.ok(block, '没找到 SettingsFieldType');
  const types = [...block[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(
    types.sort(),
    ['boolean', 'button', 'code', 'note', 'number', 'password', 'select', 'text', 'textarea'].sort(),
    '就是这 9 种；note 是只读行（不是控件，但占一行）',
  );
  assert.equal(types.includes('switch'), false, '布尔那个叫 boolean，不叫 switch');
});

/* ==================== 8. 手写表单归零闸 ==================== */

test('PluginDetail.vue：手写表单控件归零，且必须 import SettingsForm（页面级开关那一处 <Sw> 除外）', t => {
  const raw = readFileSync(srcRoot + 'components/PluginDetail.vue', 'utf8');
  const code = codeOnly(raw);

  for (const tag of ['<input', '<select', '<textarea']) {
    const count = (code.match(new RegExp(tag, 'g')) ?? []).length;
    assert.equal(count, 0, 'PluginDetail.vue 里还有 ' + count + ' 处 ' + tag + ' —— 手写表单必须归零（阶段 4 的验收原文）');
  }

  // 唯一允许保留的控件是页面最上面那个「插件开关」
  const swCount = (code.match(/<Sw\b/g) ?? []).length;
  assert.equal(swCount, 1, '只许保留 1 处 <Sw>（插件启用开关），实际 ' + swCount + ' 处');

  assert.match(code, /import SettingsForm from '\.\/SettingsForm\.vue'/, '必须 import SettingsForm');
  assert.match(code, /<SettingsForm/, '必须在模板里真的用上它');
});

test('源码级：settings_form.ts 是纯逻辑（不许 import vue / 不许 import .vue）', t => {
  // 逻辑抽 .ts 的唯一理由就是「node --test 测不了 .vue」；一旦 import 了 vue，这条理由就没了。
  const raw = readFileSync(srcRoot + 'components/settings_form.ts', 'utf8');
  const code = codeOnly(raw);
  assert.equal(/from\s+'vue'/.test(code), false, 'settings_form.ts 不许 import vue');
  assert.equal(/\.vue'/.test(code), false, 'settings_form.ts 不许 import .vue');
  assert.equal(/defineComponent|ref\(|computed\(/.test(code), false, '不许出现 Vue 运行时 API');
});

/* ==================== 9. 扩展字段不许无消费者 ==================== */

test('扩展字段在生图声明里**至少被用过一次**（没人用的契约字段下一轮就会被人删掉或写歪）', t => {
  if (!needsImageSettings(t)) return;
  const fields = FIELDS;

  // ⚠️ action **故意不在这张表里** —— 见下面那条专用的反闸（它是契约保留位，不是漏接）。
  const users: Record<string, string[]> = {
    group: fields.filter((f: any) => f.group).map((f: any) => f.key),
    hintOf: fields.filter((f: any) => typeof f.hintOf === 'function').map((f: any) => f.key),
    visibleIf: fields.filter((f: any) => typeof f.visibleIf === 'function').map((f: any) => f.key),
    valueFrom: fields.filter((f: any) => typeof f.valueFrom === 'function').map((f: any) => f.key),
    variant: fields.filter((f: any) => f.variant).map((f: any) => f.key),
    step: fields.filter((f: any) => typeof f.step === 'number').map((f: any) => f.key),
  };

  // 逐条列出「谁在用」——失败信息里直接给人看的
  const unused = Object.entries(users)
    .filter(([, keys]) => keys.length === 0)
    .map(([name]) => name);
  assert.deepEqual(
    unused,
    [],
    '这些契约字段在生图声明里一个使用者都没有，等于死契约：' + unused.join(', ') + '\n' + JSON.stringify(users, null, 2),
  );

  // 顺手把「谁在用」钉成编号，改坏了能立刻看出是哪一类丢了
  assert.ok(users.group.length >= 1, 'group 要有人用（5 个块全靠它）');
  assert.ok(users.hintOf.length >= 1, 'hintOf 要有人用（「现在选的是 v4.5」那条动态小字）');
  assert.ok(users.visibleIf.length >= 1, 'visibleIf 要有人用（v3 那三个开关 / 代理地址）');
  assert.ok(users.valueFrom.length >= 1, 'valueFrom 要有人用（尺寸预设反向还原）');
  assert.ok(users.step.length >= 1, 'step 要有人用（guidance 0.5 那个「不许取整」）');
});

test('反闸：**所有内置插件的设置声明里，带 action 的字段必须是 0 个**', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 为什么这是「必须为 0」而不是「至少 1 个」：
  //   `action` 是契约里的**保留位** —— 宿主只负责 emit `field-action`，**全工程零消费方**
  //   （core/ports.ts:375 原文：「阶段 4 只负责 emit，还没有消费者」）。
  //   旧生图设置页也**没有可搬的字段按钮**：那三个 <button> 分别是「返回」「显示/隐藏」「恢复默认」，
  //   都不是声明字段。
  //
  //   所以：谁声明了带 action 的 button 字段，就是往用户界面上放一个**点了没反应**的按钮。
  //   这条闸负责拦住它 —— 将来真做按钮（比如「原地试画一张」）时，必须**先有消费方**再声明，
  //   顺序被钉死，而不是靠人记得。
  // ─────────────────────────────────────────────────────────────────────────
  const offenders: string[] = [];
  for (const id of ['cangxuan', 'worldbook', 'image']) {
    for (const f of pluginSettingFields(id)) {
      if ((f as any).action) offenders.push(id + '.' + f.key + ' → action:' + String((f as any).action));
    }
  }
  // 生图那份用 FIELDS 再查一遍（pluginSettingFields 与它同源，但这样报错更直接）
  for (const f of FIELDS) {
    if ((f as any).action) offenders.push('image.' + f.key + ' → action:' + String((f as any).action));
  }
  assert.deepEqual(
    offenders,
    [],
    '这些字段声明了 action，但全工程没有任何地方消费 field-action —— 用户会看到一个点了没反应的按钮：\n' +
      offenders.join('\n'),
  );

  // 契约本身必须留着这个通道：删掉 action 会让「第一个要按钮的插件」无处声明
  const ports = readFileSync(srcRoot + 'core/ports.ts', 'utf8');
  assert.match(ports, /action\?:\s*string/, 'action 是契约里保留的通道，不许顺手删掉');
});

test('块级扩展字段：hint 与 badgeOf **各有使用者**（block 级的真实能力）', t => {
  if (!needsImageSettings(t)) return;
  const groups = GROUPS;
  assert.ok(
    groups.some((g: any) => typeof g.hint === 'string' && g.hint),
    '静态块说明要有人用（接口块「连哪家 · 用哪个 Key」）',
  );
  assert.ok(
    groups.some((g: any) => typeof g.badgeOf === 'function'),
    'badgeOf 要有人用（固定提示词块那个「N 字」角标）—— 它也是「块级动态文案是真实需求」的证据',
  );

  // ─────────────────────────────────────────────────────────────────────────
  // ⚠️ 这里**故意没有**「块级 hintOf 必须有使用者」的闸（Lead 裁定）：
  //   `hintOf` 是 `hint` 的**动态形态**、由**同一个表达式**渲染**同一个位置**（块头右侧小字）。
  //   `badgeOf` 已经被 `fixed` 块用了 → 证明「块级动态文案」在本页是**真实需求**，
  //   所以 `hintOf` 是**同一条线上的正常能力**，不是猜想的 API。
  //   生图页当前没有使用者 —— 这是**有意**的：为它写「必须有使用者」的闸会逼出一个没人要的控件。
  //
  // ⚠️ 也**没有**「块级 visibleIf」的闸 —— 那个属性已从契约里**整个删除**：
  //   组级整块隐藏在生图页一个真实用例都没有（旧界面高级块那段说明是**块内一段话**，
  //   不是隐藏块）。要加回来必须先有真实使用者。
  // ─────────────────────────────────────────────────────────────────────────
  const ports = readFileSync(srcRoot + 'core/ports.ts', 'utf8');
  const groupBlock = /export interface SettingsGroup \{([\s\S]*?)\n\}/.exec(ports);
  assert.ok(groupBlock, '没找到 SettingsGroup');
  assert.equal(
    /visibleIf/.test(codeOnly(groupBlock[1])),
    false,
    'SettingsGroup 又长出 visibleIf 了 —— 契约里不留没有使用者的可选属性；加回来前先确认真的有「整块隐藏」的使用者',
  );
  assert.match(groupBlock[1], /hintOf\?:/, '块级 hintOf 要留着（hint 的动态形态，同一条线）');
  assert.match(groupBlock[1], /badgeOf\?:/, '块级 badgeOf 要留着（fixed 块在用）');
});

/* ==================== 10. 动态文案不许降级成静态字 ==================== */

test('⭐ 等价基线 §3 的 4 处动态文案必须真的是**活的**（换 values 就要换文案）', t => {
  if (!needsImageSettings(t)) return;
  // 这是最难发现的一类错：静态字「写得出来」，但模型从 v4.5 切成 v3 时**不跟着变**。
  const modelField = FIELDS.find((f: any) => f.key === 'model');
  assert.ok(modelField, '要有 model 字段');
  assert.equal(typeof modelField.hintOf, 'function', 'model 的小字必须是 hintOf（显示「现在选的是 …」）');
  const v45 = modelField.hintOf!({ model: 'nai-diffusion-4-5-full' });
  const v3 = modelField.hintOf!({ model: 'nai-diffusion-3' });
  assert.notEqual(v45, v3, '换模型必须换文案 —— 相等说明它其实是静态的');
  assert.match(v3, /v3/);
  assert.match(v45, /v4\.5/);

  const qualityField = FIELDS.find((f: any) => f.key === 'quality');
  if (qualityField && typeof qualityField.hintOf === 'function') {
    assert.notEqual(
      qualityField.hintOf({ model: 'nai-diffusion-3' }),
      qualityField.hintOf({ model: 'nai-diffusion-4-5-full' }),
      'quality 的小字要随模型变（质量词各模型不一样）',
    );
  }

  // 固定提示词块的「N 字」角标：内容变了角标就要变
  const fixed = [...GROUPS].find((g: any) => typeof g.badgeOf === 'function');
  assert.ok(fixed, '要有块用 badgeOf');
  assert.notEqual(
    fixed.badgeOf!({ prompt: 'abcd', prompt_end: '', negative: '' }),
    fixed.badgeOf!({ prompt: '', prompt_end: '', negative: '' }),
    '字数变了角标必须跟着变',
  );
});

/* ==================== 11. 有意识的决定闸（苍玄助手设置被摘下来） ==================== */

test('⭐【有意识的决定】pluginSettingFields("cangxuan") 现在**故意为空**', t => {
  // ─────────────────────────────────────────────────────────────────────────
  // 为什么现在应该为空（不是漏了）：
  //   CANGXUAN_SETTINGS_FIELDS 里的 gallery / meta_rule **还没有任何代码消费** ——
  //   core/portrait.ts 的 collectGallery() 根本不看 plugins.cangxuan.gallery，
  //   真正生效的提取规则是预设自己的 ExtractRule；meta_rule 更是谁都没读。
  //   声明出来 = 两个「能点、能存、但什么也不影响」的死控件，正是底座最该避免的东西。
  //   完整理由写在 src/苍玄助手/plugins/builtin/cangxuan/config.ts 的文件头。
  //
  // 谁把它接上时必须来改这条测试：
  //   等 portrait 侧真的按 gallery / meta_rule 取值了（即这两个键真的影响行为），
  //   再在 cangxuan/manifest.ts 里加 contributes.settings。
  //   那时候**这条测试会红** —— 那是故意的：它逼你做一次有意识的选择
  //   （「我现在真的接上了，所以把闸改成断言非空」），而不是顺手把死控件放出来。
  // ─────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    pluginSettingFields('cangxuan'),
    [],
    '苍玄助手的设置字段还没接进 manifest（有意识为空；接上前请先确认 gallery / meta_rule 真的被消费）',
  );
  assert.deepEqual(pluginSettings('cangxuan'), { fields: [] }, '整个 schema 也应为空');

  // 字段声明本身还在（没被删掉），只是没接进 manifest —— 接线时不用重写
  const config = readFileSync(srcRoot + 'plugins/builtin/cangxuan/config.ts', 'utf8');
  assert.match(config, /export const CANGXUAN_SETTINGS_FIELDS/, '声明留着，等接线');
  assert.match(
    config,
    /没有接进 manifest|故意没有接进/,
    'config.ts 文件头要写清「为什么现在是空的」，否则下一个人会以为是漏了',
  );
});