/**
 * 阶段 4 · P4-5：`components/settings_form.ts` 纯逻辑的**行为**测试。
 *
 * 为什么测这个文件而不是 `SettingsForm.vue`：`node --test` 测不了 .vue，
 * 所以声明式设置的逻辑被抽成纯函数（照 `tool_rows.ts` + `tool_rows.test.ts` 的先例）。
 * 这里每一条都**断言行为**，不断言「函数存在」——后者只给虚假安全感。
 *
 * 契约来源：`core/ports.ts` 的 SettingsField / SettingsGroup / SettingsSchema（阶段 4 冻结），
 * 等价基线：`reports/阶段4-声明式设置-等价基线.md`（Lead 从改写前旧代码逐行抄的）。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { codeOnly } from './_helpers.ts';

const root = '../../src/苍玄助手/';
const {
  seedValues,
  fieldValue,
  visibleFields,
  groupFields,
  clampNumber,
  buildPatch,
  dirtyFields,
  fieldHint,
  groupHint,
  groupBadge,
} = await import(root + 'components/settings_form.ts');
// variant 相关的两个 helper 以 ui-shell 的最终交付为准（Lead 会把它从 useSegBar 改成
// 返回变体字符串的形式）；这里按名字动态取，名字没定之前用 try 兜住，避免整文件 import 失败。
const sf = await import(root + 'components/settings_form.ts');
const segVariantOf = (sf as any).segVariantOf ?? (sf as any).variantOf ?? (sf as any).useSegBar;
const segItems = (sf as any).segItems;

// task-24 的两个新函数（ui-shell 正在落地）。用动态取用：还没交付时取到 undefined，
// 用例会以「函数不存在」明确失败，而不是整个文件 import 报错、把无关的断言一起带红。
const inputValue: ((field: any, draft: Record<string, unknown>, values: Record<string, unknown>) => string) | undefined =
  (sf as any).inputValue;
const selectValueFrom: ((payload: unknown) => string) | undefined = (sf as any).selectValueFrom;

/* ==================== 小工具 ==================== */

/** 造一个字段（默认值给齐，用例只覆盖关心的那几个） */
function field(over: Record<string, unknown> = {}) {
  return { key: 'k', label: 'K', type: 'text', ...over } as any;
}

function group(over: Record<string, unknown> = {}) {
  return { id: 'g', title: 'G', ...over } as any;
}

/* ==================== task-24：inputValue（5 个控件的显示值） ==================== */

/**
 * 这两个函数是**真酒馆里才暴露出来**的 bug 的修复（SSR / 单测都漏过去了）。
 *
 * bug 1：`password / code / textarea / number / text` 五个控件的显示值原先绑的是
 *        `:value="draft[field.key] ?? ''"` —— **只看本地草稿、完全不读 `values`**。
 *        后果：已存的值在界面上一片空白（steps 存着 28 却显示空、api_key 显示空、
 *        三段固定提示词显示空）。用户会以为自己填的 Key 丢了。
 *
 * 修复 = 把「该显示什么」抽成纯函数 `inputValue(field, draft, values)`，
 * 顺序是：**草稿优先**（用户正在打字不能被回写冲掉）→ 否则读 `values`（这次补上的那一半）→ 空串。
 */

test('⭐inputValue：该键**不在草稿里**时读 values（这条退回 draft ?? \'\' 就必须红）', () => {
  // 这一条是 bug 1 的核心：原实现只读 draft，所以 values 里有值也显示空白。
  assert.equal(
    inputValue!(field({ key: 'steps', type: 'number' }), {}, { steps: 28 }),
    '28',
    '草稿里没有该键 → 必须读 values；返回空串就是原来那个 bug',
  );
  assert.equal(inputValue!(field({ key: 'api_key', type: 'password' }), {}, { api_key: 'pst-abc' }), 'pst-abc');
  assert.equal(inputValue!(field({ key: 'prompt', type: 'textarea' }), {}, { prompt: 'masterpiece' }), 'masterpiece');
  assert.equal(inputValue!(field({ key: 'model', type: 'text' }), {}, { model: 'nai-diffusion-3' }), 'nai-diffusion-3');
  assert.equal(inputValue!(field({ key: 'body', type: 'code' }), {}, { body: 'const a = 1' }), 'const a = 1');
});

test('⭐inputValue：values 里是数字 → 返回**字符串**（<input> 的 value 只能是字符串）', () => {
  // 不能返回 28（number）—— 原生 <input> 的 value 是字符串，返回数字类型在模板里会出问题；
  // 也不能返回 undefined（会渲染成 "undefined" 字样）。
  assert.equal(inputValue!(field({ key: 'steps', type: 'number' }), {}, { steps: 28 }), '28');
  assert.equal(inputValue!(field({ key: 'guidance', type: 'number' }), {}, { guidance: 5.5 }), '5.5');
  assert.equal(inputValue!(field({ key: 'seed', type: 'number' }), {}, { seed: 0 }), '0', '0 是有效值，不能变成空串');
  assert.equal(typeof inputValue!(field({ key: 'steps', type: 'number' }), {}, { steps: 28 }), 'string');
});

test('⭐inputValue：草稿优先于 values（用户打字时不能被回写冲掉）', () => {
  // 这是「本地草稿」存在的唯一理由：props.values 还没回来时，用户刚敲的字不能被覆盖。
  assert.equal(
    inputValue!(field({ key: 'api_key' }), { api_key: 'pst-正在输入' }, { api_key: 'pst-旧的' }),
    'pst-正在输入',
    '草稿里有就用草稿',
  );
  assert.equal(inputValue!(field({ key: 'steps', type: 'number' }), { steps: '3' }, { steps: 28 }), '3', '草稿里的字符串原样显示');
  // 草稿里是空串（用户清空了）→ 也不能回落到 values，否则用户清不掉这个字段
  assert.equal(inputValue!(field({ key: 'prompt' }), { prompt: '' }, { prompt: '旧内容' }), '', '草稿是空串就用空串');
});

test('inputValue：草稿和 values 都没有 → 空串（不是 undefined / null / "undefined"）', () => {
  assert.equal(inputValue!(field({ key: 'nope' }), {}, {}), '');
  assert.equal(inputValue!(field({ key: 'nope' }), {}, { 别的键: 'x' }), '');
  assert.equal(inputValue!(field({ key: 'nope' }), {}, { nope: undefined }), '', '显式 undefined 也当没有');
  assert.equal(inputValue!(field({ key: 'nope' }), {}, { nope: null }), '', 'null 也当没有');
  assert.equal(typeof inputValue!(field({ key: 'nope' }), {}, {}), 'string', '永远是字符串');
});

test('inputValue：布尔 / 对象这类非标量值不许渲染成 "[object Object]"', () => {
  assert.equal(inputValue!(field({ key: 'q' }), {}, { q: { a: 1 } }), '', '对象 → 空串（不是 [object Object]）');
  assert.equal(inputValue!(field({ key: 'q' }), {}, { q: ['x'] }), '', '数组 → 空串');
  // 布尔：布尔控件走 Sw，不经 inputValue；但真给了也不该出 "true" 这种字样进输入框
  assert.equal(typeof inputValue!(field({ key: 'q' }), {}, { q: true }), 'string');
});

test('inputValue：是纯函数（不改 draft / values）', () => {
  const draft = { api_key: 'd' };
  const values = { steps: 28 };
  const draftCopy = { ...draft };
  const valuesCopy = { ...values };
  inputValue!(field({ key: 'steps' }), draft, values);
  assert.deepEqual(draft, draftCopy, '不许改草稿');
  assert.deepEqual(values, valuesCopy, '不许改 values');
});

/* ==================== task-24：selectValueFrom（原生 select 的事件载荷） ==================== */

/**
 * bug 2：原生 `<select>` 的 `@change="onSelect(field, $event)"` 把 **DOM Event** 当 string 用 ——
 * `asText(event)` 得空串 → `buildPatch` 写出 `{[key]: ''}`。
 * 实测：把「模型」切一下，模型被写成空串（页面上小字立刻变成「现在选的是 不认识的模型名」）。
 * 受害字段 = 所有**非 SegBar** 的下拉：model / uc_preset / sampler / schedule。
 *
 * 修复 = `selectValueFrom(payload)` 把「字符串 / 事件对象」两种载荷归一成 string。
 * ⚠️ 这里**用普通对象当假事件**，不依赖 DOM（本仓库没有 jsdom，也不许装）。
 */

test('⭐selectValueFrom：类事件对象 { target: { value } } → 取出真正的值（bug 2 的核心）', () => {
  // 这一条如果实现退回「把载荷当 string 直接 asText」，必须红。
  assert.equal(
    selectValueFrom!({ target: { value: 'nai-diffusion-3' } }),
    'nai-diffusion-3',
    '原生 <select> 的 change 事件要给的是 target.value，不是事件对象本身',
  );
  for (const value of ['nai-diffusion-4-5-full', 'heavy', 'k_euler_ancestral', 'karras']) {
    assert.equal(selectValueFrom!({ target: { value } }), value, '四个受害下拉逐一点名：' + value);
  }
  // 注：契约只要求 `target.value`（原生 change 事件的形态就是它）。
  // `currentTarget` 不在契约里，所以**故意不测** —— 断言契约之外的行为会变成
  // 「我有想法就让实现照做」，那条线不该由测试来推。
});

test('selectValueFrom：字符串**直通**（SegBar 那条路不能被这次修复弄坏）', () => {
  // SegBar 走的是 `@update:model-value="onSelect(field, $event)"`，$event 就是字符串本身。
  assert.equal(selectValueFrom!('official'), 'official', '字符串原样返回');
  assert.equal(selectValueFrom!('proxy'), 'proxy');
  assert.equal(selectValueFrom!(''), '', '空串原样');
});

test('selectValueFrom：undefined / null / 数字 / 取不到值的对象 → 空串（绝不能写出 [object Object]）', () => {
  for (const payload of [undefined, null, 42, 0, true, {}, { target: {} }, { target: { value: undefined } }, { target: null }, []]) {
    assert.equal(selectValueFrom!(payload), '', JSON.stringify(payload) + ' 应归一成空串');
  }
  // 最关键的一条：绝不能把事件对象本身字符串化 —— 那会把 "[object Object]" 写进配置
  const out = selectValueFrom!({ target: { value: 'nai-diffusion-3' } });
  assert.equal(out === '[object Object]', false, '绝不能把事件对象字符串化');
});

test('selectValueFrom：返回的永远是字符串（写进配置的类型要稳）', () => {
  assert.equal(typeof selectValueFrom!({ target: { value: 'x' } }), 'string');
  assert.equal(typeof selectValueFrom!('x'), 'string');
  assert.equal(typeof selectValueFrom!(undefined), 'string');
  assert.equal(typeof selectValueFrom!(123), 'string', '数字输入也要归一成字符串，不是返回数字');
});

test('⭐回归闸：SettingsForm.vue 的原生 <select> 不许再把 $event 直接当值用', () => {
  // 这条是**源码级**的：纯函数测得到「归一逻辑对不对」，但测不到「组件有没有真的接上」。
  // 如果模板又退回 `:value="draft[field.key] ?? \'\'"`（不读 values）或
  // `@change="onSelect(field, $event)"` 直接把手写值当 string，这条会红。
  const src = readFileSync(new URL('../../src/苍玄助手/components/SettingsForm.vue', import.meta.url), 'utf8');
  const code = codeOnly(src);

  // 「只看草稿、不读 values」的原始写法必须消失
  assert.equal(
    /:value="draft\[field\.key\]\s*\?\?\s*''"/.test(code),
    false,
    '控件显示值不能只绑 draft（那是 bug 1：已存的值全渲染成空），要走 inputValue(field, draft, values)',
  );
  // 五个控件都要用新函数
  const uses = (code.match(/inputValue\(/g) ?? []).length;
  assert.ok(uses >= 5, 'password/code/textarea/number/text 五个控件都要走 inputValue，实际 ' + uses + ' 处');

  // 原生 select 的载荷必须过 selectValueFrom
  assert.match(code, /selectValueFrom\(/, '<select> 的事件载荷必须过 selectValueFrom（bug 2）');
});

/* ==================== seedValues ==================== */

test('seedValues：缺键补 default；**已有值不许被 default 覆盖**', () => {
  const fields = [field({ key: 'a', default: 1 }), field({ key: 'b', default: 2 }), field({ key: 'c', default: 3 })];
  const values = { b: 99 };

  const seeded = seedValues(fields, values);

  assert.equal(seeded.a, 1, '缺的键补 default');
  assert.equal(seeded.b, 99, '已有值必须以 values 为准 —— 这是「用户改过就别动」的唯一保证');
  assert.equal(seeded.c, 3);
});

test('seedValues：已有值是 **falsy**（0 / false / 空串）时同样不许被 default 覆盖', () => {
  // 回归：`values[key] || default` 这种写法会把「用户特意设成 0」当成没设过。
  // 生图里 steps=0 不合法、但 seed=0 表示「每次随机」，variety=false 表示「关掉」——
  // 都是**有意义的值**，被 default 顶掉就是丢配置。
  const fields = [
    field({ key: 'seed', type: 'number', default: 12345 }),
    field({ key: 'variety', type: 'boolean', default: true }),
    field({ key: 'prompt', type: 'textarea', default: '默认提示词' }),
  ];
  const seeded = seedValues(fields, { seed: 0, variety: false, prompt: '' });

  assert.equal(seeded.seed, 0, 'seed=0（每次随机）不能被 default 顶掉');
  assert.equal(seeded.variety, false, 'variety=false（关掉）不能被 default 顶掉');
  assert.equal(seeded.prompt, '', '空串也是用户设过的值');
});

test('seedValues：**只播种声明了 default 的字段**，没声明的键不凭空造出来', () => {
  // 口径：seedValues 的职责是「老数据缺的那几个键补上内置默认」。
  // 没声明 default 的字段没有「内置默认」可言 —— 硬塞一个 undefined 进 values
  // 反而会让 Object.keys 多出一堆空键，写回 store 时把无关键也带上。
  const fields = [field({ key: 'withDefault', default: 'x' }), field({ key: 'noDefault' })];
  const seeded = seedValues(fields, {});

  assert.equal(seeded.withDefault, 'x', '声明了 default 的要补上');
  assert.equal('noDefault' in seeded, false, '没声明 default 的键不该被凭空造出来');
  assert.deepEqual(Object.keys(seeded), ['withDefault']);

  // 但**已经存在的**无 default 键要原样留着（那是用户 / store 里的真值）
  const kept = seedValues(fields, { noDefault: '用户填的' });
  assert.equal(kept.noDefault, '用户填的', '已有的值不许因为「没声明 default」被丢掉');
});

test('seedValues：不改传进来的 values（纯函数）', () => {
  const values = { a: 1 };
  const copy = { ...values };
  seedValues([field({ key: 'a', default: 7 }), field({ key: 'b', default: 8 })], values);
  assert.deepEqual(values, copy, 'seedValues 不许就地改入参');
});

/* ==================== clampNumber ==================== */

test('clampNumber：step >= 1 取整并夹到 min/max；两侧越界都夹', () => {
  const f = field({ key: 'steps', type: 'number', min: 1, max: 50, step: 1 });
  assert.equal(clampNumber(f, 28, 1), 28, '范围内原样');
  assert.equal(clampNumber(f, 27.6, 1), 28, 'step>=1 → 取整');
  assert.equal(clampNumber(f, 999, 1), 50, '超上界夹到 max');
  assert.equal(clampNumber(f, -5, 1), 1, '低于下界夹到 min');
});

test('clampNumber：**step < 1 不许取整**（P4-3 删掉的那个按字段名特判的回归闸）', () => {
  // 旧代码 PluginDetail.vue:478 是 `if (key !== 'guidance' && key !== 'guidance_rescale') value = Math.round(value)`。
  // 本阶段的目的就是让这句话消失 —— 现在由 step 决定。
  const guidance = field({ key: 'guidance', type: 'number', min: 0, max: 20, step: 0.5 });
  assert.equal(clampNumber(guidance, 5.5, 5), 5.5, 'step 0.5 → 保留小数');

  const rescale = field({ key: 'guidance_rescale', type: 'number', min: 0, max: 1, step: 0.02 });
  assert.equal(clampNumber(rescale, 0.35, 0), 0.35, 'step 0.02 → 保留小数');

  // ⭐ 关键：**与字段 key 叫什么无关**。同一个 0.5 的步长换个名字也必须保留小数。
  // 如果实现里还留着 `key === 'guidance'` 之类的判断，这一条会红。
  const renamed = field({ key: 'totally_other_name', type: 'number', min: 0, max: 20, step: 0.5 });
  assert.equal(clampNumber(renamed, 7.25, 5), 7.25, '不许按字段名特判 —— 换名字行为必须一样');

  // 反过来的方向也要钉：同一个名字配 step:1 就该取整（证明上一条不是「永远不取整」）
  const intWithSameName = field({ key: 'guidance', type: 'number', min: 0, max: 20, step: 1 });
  assert.equal(clampNumber(intWithSameName, 7.25, 5), 7, 'step 1 → 该取整就取整，与名字无关');
});

test('clampNumber：小数步长同样要夹 min/max', () => {
  const f = field({ key: 'guidance_rescale', type: 'number', min: 0, max: 1, step: 0.02 });
  assert.equal(clampNumber(f, 3.7, 0), 1, '超上界夹 max 后再保留小数');
  assert.equal(clampNumber(f, -2.5, 0), 0, '低于下界夹 min');
});

test('clampNumber：真非数字（abc / NaN / undefined）回落 fallback', () => {
  const f = field({ key: 'steps', type: 'number', min: 1, max: 50, step: 1 });
  for (const raw of ['abc', NaN, undefined]) {
    assert.equal(clampNumber(f, raw, 28), 28, JSON.stringify(raw) + ' 应回落 fallback');
  }
  // 数字字符串要能认（界面 input 给的就是字符串），且认完照样夹
  assert.equal(clampNumber(f, '30', 1), 30, '数字字符串要认得出来');
  assert.equal(clampNumber(f, '999', 1), 50, '认出来之后照样夹上界');
});

test('clampNumber：**空输入要回落 fallback，不能变成 0 再被夹到 min**', () => {
  // ⚠️ 这是一个真实的行为陷阱：`Number('')` 是 **0**（不是 NaN），
  //   所以「用户把数字输入框清空」会被当成「用户填了 0」，再被 min 夹到下限。
  //   表现：steps 清空 → 变成 1（而不是回到原值 28）；seed 清空 → 变成 0（而 0 恰好是「每次随机」的合法值，
  //   用户以为清空 = 不动，实际把种子打成了随机）。
  //   契约里 fallback 的定义是「输入不是数时的退路（通常是当前已存的值）」——
  //   空串属于「不是数」，必须走 fallback。
  const steps = field({ key: 'steps', type: 'number', min: 1, max: 50, step: 1 });
  assert.equal(clampNumber(steps, '', 28), 28, '清空 steps → 回到原值 28，不能变成 min=1');
  assert.equal(clampNumber(steps, '   ', 28), 28, '只有空白也算空输入');

  const seed = field({ key: 'seed', type: 'number', min: 0, max: 4294967295, step: 1 });
  assert.equal(clampNumber(seed, '', 12345), 12345, '清空 seed → 回到原值，不能悄悄变成 0（0 = 每次随机）');

  const guidance = field({ key: 'guidance', type: 'number', min: 0, max: 20, step: 0.5 });
  assert.equal(clampNumber(guidance, '', 5.5), 5.5, '小数控件同样要回落，且保留小数');

  // null / undefined 是「没有值」的另一种写法，同样走 fallback（不是「当成 0」）
  assert.equal(clampNumber(steps, null, 28), 28, 'null 走 fallback');
});

test('clampNumber：没给 min/max 时不夹；step 缺失按整数字段处理', () => {
  const open = field({ key: 'seed', type: 'number' });
  assert.equal(clampNumber(open, 123456789, 0), 123456789, '没声明上界就原样保留');
  assert.equal(clampNumber(open, 42.9, 0), 43, 'step 缺失 = 整数控件 → 取整');
  assert.equal(clampNumber(open, -3, 0), -3, '没声明下界就允许负数（别自作主张夹到 0）');
});

test('clampNumber：只有 max 没有 min（生图 seed 那种 min:0,max:4294967295）两侧独立', () => {
  const seed = field({ key: 'seed', type: 'number', min: 0, max: 4294967295, step: 1 });
  assert.equal(clampNumber(seed, 4294967296, 0), 4294967295, '上界是 schema 之外的补充上界，要生效');
  assert.equal(clampNumber(seed, -1, 0), 0, '下界生效');
});

/* ==================== buildPatch ==================== */

test('buildPatch：普通字段只写自己的 key', () => {
  assert.deepEqual(buildPatch(field({ key: 'api_key', type: 'password' }), 'pst-x'), { api_key: 'pst-x' });
  assert.deepEqual(buildPatch(field({ key: 'quality', type: 'boolean' }), false), { quality: false });
  assert.deepEqual(buildPatch(field({ key: 'steps', type: 'number', min: 1, max: 50, step: 1 }), 999), { steps: 50 });
});

test('buildPatch：命中带 patch 的 select 选项 → **展开成多个键**', () => {
  // 这是「尺寸预设」那个复合控件：一个下拉同时写 width + height。
  // 丢掉它就等于用户失去「选预设尺寸」这条路（等价基线 §1 标了「最容易丢的东西」）。
  const size = field({
    key: 'size',
    type: 'select',
    options: [
      { value: '832x1216', label: '832x1216 · 竖 13:19', patch: { width: 832, height: 1216 } },
      { value: 'custom', label: '自定义（下面填宽高）' },
    ],
  });

  assert.deepEqual(buildPatch(size, '832x1216'), { width: 832, height: 1216 }, '命中 → 展开成两个键');
  // 未命中（'custom' 没 patch）→ 只写 key 自己
  assert.deepEqual(buildPatch(size, 'custom'), { size: 'custom' }, '没 patch 的选项只写 key');
});

test('buildPatch：select 未命中任何选项 → 只写 key（不许瞎展开、也不许丢）', () => {
  const f = field({
    key: 'model',
    type: 'select',
    options: [{ value: 'nai-diffusion-3', label: 'v3' }],
  });
  assert.deepEqual(buildPatch(f, '不存在的值'), { model: '不存在的值' });
});

test('buildPatch：select 命中 patch 时**不**额外写 key 自己（尺寸那个 key 不是真配置键）', () => {
  const size = field({
    key: 'size',
    type: 'select',
    options: [{ value: 'p', label: 'P', patch: { width: 64, height: 64 } }],
  });
  const patch = buildPatch(size, 'p');
  assert.equal('size' in patch, false, 'size 只是界面用的伪键，落盘会变成无主配置');
  assert.deepEqual(patch, { width: 64, height: 64 });
});

/* ==================== fieldValue + valueFrom ==================== */

test('fieldValue：没有 valueFrom 时读 values[key]，并统一成**字符串**（select 要比 option.value）', () => {
  // 口径：fieldValue 是 **select 专用**口径 —— 返回值要能跟 option.value（字符串）比。
  // 所以数字 / 布尔也要字符串化；读不到就是空串（不是 undefined，免得模板里显示 "undefined"）。
  assert.equal(fieldValue(field({ key: 'steps', type: 'number' }), { steps: 28 }), '28');
  assert.equal(fieldValue(field({ key: 'quality', type: 'boolean' }), { quality: false }), 'false');
  assert.equal(fieldValue(field({ key: 'model', type: 'select' }), { model: 'nai-diffusion-3' }), 'nai-diffusion-3');
  assert.equal(fieldValue(field({ key: 'steps', type: 'number' }), {}), '', '读不到 → 空串');

  // 复合值（数组 / 对象）不该变成 "[object Object]" 那种鬼东西
  assert.equal(fieldValue(field({ key: 'weird' }), { weird: { a: 1 } }), '', '非标量 → 空串，不是 "[object Object]"');
});

test('fieldValue：有 valueFrom 时走 valueFrom（尺寸预设「对得上」）', () => {
  // 尺寸那个复合控件要**反向还原**：width/height 对得上某个预设就显示那个预设，
  // 否则显示「自定义」。旧代码是 `sizePresetOf(width,height) || 'custom'`。
  const size = field({
    key: 'size',
    type: 'select',
    valueFrom: (v: any) => (v.width === 832 && v.height === 1216 ? '832x1216' : 'custom'),
    options: [
      { value: '832x1216', label: '832x1216', patch: { width: 832, height: 1216 } },
      { value: 'custom', label: '自定义' },
    ],
  });

  assert.equal(fieldValue(size, { width: 832, height: 1216 }), '832x1216', '对得上预设 → 显示预设');
  assert.equal(fieldValue(size, { width: 900, height: 1216 }), 'custom', '对不上 → 显示自定义');
  assert.equal(fieldValue(size, {}), 'custom', '两个键都缺 → 也是自定义（不能抛）');
});

test('fieldValue：valueFrom 优先于 values[key]（两者不一致时以 valueFrom 为准）', () => {
  const f = field({ key: 'size', type: 'select', valueFrom: () => 'from-valueFrom' });
  assert.equal(fieldValue(f, { size: 'stale-in-values' }), 'from-valueFrom', '派生值说了算');
});

/* ==================== visibleFields ==================== */

test('visibleFields：visibleIf 缺失 = 可见；返回 false = 不可见', () => {
  const fields = [
    field({ key: 'always' }),
    field({ key: 'never', visibleIf: () => false }),
    field({ key: 'sometimes', visibleIf: (v: any) => v.site === 'proxy' }),
  ];

  assert.deepEqual(
    visibleFields(fields, {}).map((f: any) => f.key),
    ['always'],
    '没写 visibleIf 的永远可见；写了且条件不成立的不见（{} 里 site 是 undefined ≠ \'proxy\'）',
  );
  assert.deepEqual(
    visibleFields(fields, { site: 'proxy' }).map((f: any) => f.key),
    ['always', 'sometimes'],
  );
  assert.deepEqual(
    visibleFields(fields, { site: 'official' }).map((f: any) => f.key),
    ['always'],
    '条件为假时隐藏',
  );
});

test('visibleFields：visibleIf 内部能读到**动态值**（v3 判断 / 代理判断）—— 不是只算一次', () => {
  // 等价基线 §3：`v-if="isV3"` 与 `site==='proxy'` 这两处是**活的条件**。
  // 这里用「同一个 fields 数组、换 values」证明它每次现算（若实现把结果缓存了就红）。
  const fields = [
    field({ key: 'smea', type: 'boolean', visibleIf: (v: any) => v.model === 'nai-diffusion-3' }),
    field({ key: 'site_url', type: 'text', visibleIf: (v: any) => v.site === 'proxy' }),
  ];

  assert.deepEqual(visibleFields(fields, { model: 'nai-diffusion-4-5-full', site: 'official' }).map((f: any) => f.key), []);
  assert.deepEqual(
    visibleFields(fields, { model: 'nai-diffusion-3', site: 'official' }).map((f: any) => f.key),
    ['smea'],
    '切成 v3 → smea 出现',
  );
  assert.deepEqual(
    visibleFields(fields, { model: 'nai-diffusion-3', site: 'proxy' }).map((f: any) => f.key),
    ['smea', 'site_url'],
    '再切代理 → 两个都在（顺序 = 声明顺序）',
  );
  // 切回去必须消失（证明不是「一旦可见就记住」）
  assert.deepEqual(visibleFields(fields, { model: 'nai-diffusion-5-curated', site: 'official' }).map((f: any) => f.key), []);
});

/* ==================== groupFields ==================== */

test('groupFields：分组顺序 = groups 声明顺序（不是字段出现顺序）', () => {
  const groups = [group({ id: 'b', title: 'B 块' }), group({ id: 'a', title: 'A 块' })];
  // 字段故意先声明 a 块的，顺序仍应按 groups
  const fields = [
    field({ key: 'a1', group: 'a' }),
    field({ key: 'b1', group: 'b' }),
    field({ key: 'a2', group: 'a' }),
  ];

  const out = groupFields(fields, groups, {});
  assert.deepEqual(out.map((item: any) => item.group?.id), ['b', 'a']);
  assert.deepEqual(out[0].fields.map((f: any) => f.key), ['b1']);
  assert.deepEqual(out[1].fields.map((f: any) => f.key), ['a1', 'a2'], '块内保持字段声明顺序');
});

test('groupFields：group 有值但**没在 groups 里登记** → 用 id 当标题兜底，不许静默丢字段', () => {
  // 契约原文：两份平行数组早晚出现「字段指了个没人登记的 group」这种漂移。
  // 这一条就是防它 —— 丢了字段 = 用户再也改不了那一项，而且没有任何报错。
  const groups = [group({ id: 'known', title: '认识的块' })];
  const fields = [field({ key: 'ok', group: 'known' }), field({ key: 'orphan', group: '没登记的' })];

  const out = groupFields(fields, groups, {});
  const allKeys = out.flatMap((item: any) => item.fields.map((f: any) => f.key));
  assert.deepEqual(allKeys.sort(), ['ok', 'orphan'], '**一个字段都不许丢**');

  const orphanBlock = out.find((item: any) => item.fields.some((f: any) => f.key === 'orphan'));
  assert.ok(orphanBlock, '孤儿字段要有自己的块');
  assert.equal(orphanBlock.group?.id, '没登记的', '兜底块的 id = 字段声明的 group');
  assert.equal(orphanBlock.group?.title, '没登记的', '没有标题就用 id 当标题（不能是空标题）');
});

test('groupFields：没写 group 的字段进默认块（group 为 null）', () => {
  const fields = [field({ key: 'noGroup' }), field({ key: 'withGroup', group: 'g1' })];
  const out = groupFields(fields, [group({ id: 'g1', title: '一块' })], {});

  const loose = out.find((item: any) => item.group === null);
  assert.ok(loose, '没写 group 的要有归处（group 为 null 的默认块）');
  assert.deepEqual(loose.fields.map((f: any) => f.key), ['noGroup']);
  assert.deepEqual(out.find((item: any) => item.group?.id === 'g1').fields.map((f: any) => f.key), ['withGroup']);
});

test('回归闸：SettingsGroup **不许再有 visibleIf**（组级整块隐藏在生图页没有真实用例）', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 为什么删掉它：
  //   契约里**不留没有使用者的可选属性**。我原先以为「高级块在非 v3 时整块隐藏」是个真实用例 ——
  //   查旧代码证明那是**错的**：旧界面那句「SMEA / SMEA DYN / 减少伪影 是 v3 的字段…」
  //   是块**内部底部**的一段 <p>（`v-if="!isV3"` 只作用在那一个 <p> 上），**块本身照常在**。
  //   所以「整块隐藏」在本页一个真实用例都没有。
  //   那段说明现在的正解 = `label: ''` 的 note 字段 + **字段级** visibleIf，位置正好是块内底部 ——
  //   比 `visibleIf` + 块头小字**更忠实**于旧界面。
  //
  // 要加回来必须先有真实使用者（而不是先有 API 再找地方用）。
  // ─────────────────────────────────────────────────────────────────────────
  const ports = readFileSync(new URL('../../src/苍玄助手/core/ports.ts', import.meta.url), 'utf8');
  const block = /export interface SettingsGroup \{([\s\S]*?)\n\}/.exec(ports);
  assert.ok(block, '没找到 SettingsGroup');
  assert.equal(
    /visibleIf/.test(codeOnly(block[1])),
    false,
    'SettingsGroup 又长出 visibleIf 了 —— 加回来之前先确认真的有「整块隐藏」的使用者',
  );

  // 但字段级 visibleIf 必须还在（那是真实的：isV3 × 3 / 代理地址 / 尺寸 / straight_alpha）
  assert.match(ports, /visibleIf\?:\s*\(values: SettingsValues\)\s*=>\s*boolean/, 'SettingsField 的 visibleIf 是真实能力，不许删');
});

// ⚠️ 组级 hintOf / badgeOf 的裁定（见下）：hintOf 保留但**不要求有使用者**；
//    badgeOf 已被 fixed 块使用，证明块级动态文案是真实需求。
//    所以这里**故意没有**「块级 hintOf 必须有使用者」的闸 —— 那会逼出一个没人要的控件。
test('groupFields：空 fields → 空数组（界面画 0 块，不是画一个空块）', () => {
  assert.deepEqual(groupFields([], [group({ id: 'g' })], {}), []);
});


/* ==================== variant（seg / mode 两种药丸样式） ==================== */

test('variant：声明了 variant 且选项 2~4 个才画成药丸；否则回落成下拉', () => {
  // 契约（core/ports.ts）：variant 从只认 'seg' 扩成 'seg' | 'mode'。
  //   - 'seg'  = .cx-seg（顶栏页签那种）
  //   - 'mode' = .cx-modebar（块内内联二选一，站点选择器用的是这个）
  // 之前只认 'seg' 会让站点选择器画成一条页签 —— 观感退化，所以这条既钉「要认」也钉「认对哪一种」。
  const mk = (variant: any, n: number) =>
    field({
      key: 'site',
      type: 'select',
      variant,
      options: Array.from({ length: n }, (_, i) => ({ value: 'v' + i, label: 'V' + i })),
    });

  // 2~4 项：按声明给对应的变体
  assert.equal(segVariantOf(mk('mode', 2)), 'mode', "variant:'mode' 要还回 'mode'（站点那两个）");
  assert.equal(segVariantOf(mk('seg', 3)), 'seg', "variant:'seg' 要还回 'seg'");
  assert.equal(segVariantOf(mk('mode', 4)), 'mode');

  // 条数守卫：< 2 或 > 4 → 回落（空串 / falsy），由组件去画 <select>
  assert.ok(!segVariantOf(mk('mode', 1)), '1 项没有「分段」可言 → 回落');
  assert.ok(!segVariantOf(mk('mode', 5)), '5 项药丸会挤成一团 → 回落成下拉');
  assert.ok(!segVariantOf(mk('seg', 0)), '0 项 → 回落');

  // 没声明 variant → 永远回落
  assert.ok(!segVariantOf(mk(undefined, 2)), '没声明 variant → 下拉');
  // 非 select 类型：即使声明了 variant 也不该画成药丸
  assert.ok(!segVariantOf(field({ key: 'x', type: 'text', variant: 'mode' })), '只有 select 才可能用药丸');
});

test('segItems：把 options 转成 SegBar 要的 {value,label}（丢掉 patch 这类它不认的键）', () => {
  const sizeField = field({
    key: 'site',
    type: 'select',
    variant: 'mode',
    options: [
      { value: 'official', label: '官网直连' },
      { value: 'proxy', label: '反代 / 中转', patch: { site_url: 'x' } },
    ],
  });
  assert.deepEqual(segItems(sizeField), [
    { value: 'official', label: '官网直连' },
    { value: 'proxy', label: '反代 / 中转' },
  ], '只取 value/label —— 多带 patch 进去会让 SegBar 的项比较出问题');
  assert.deepEqual(segItems(field({ key: 'x', type: 'select' })), [], '没 options → 空数组，不抛');
});

/* ==================== fieldHint / groupHint / groupBadge ==================== */

test('fieldHint：hintOf 优先于静态 hint', () => {
  const f = field({ key: 'model', hint: '静态小字', hintOf: (v: any) => '现在选的是 ' + v.model });
  assert.equal(fieldHint(f, { model: 'nai-diffusion-3' }), '现在选的是 nai-diffusion-3');
  assert.equal(
    fieldHint(field({ key: 'x', hint: '只有静态' }), {}),
    '只有静态',
    '没有 hintOf 就用静态 hint',
  );
  assert.equal(fieldHint(field({ key: 'x' }), {}), '', '两个都没有 → 空串（不是 undefined）');
});

test('fieldHint：hintOf 返回空串时**不回落**到 hint（作者说覆盖就覆盖）', () => {
  // 口径：给了 hintOf 就由它说了算；否则「悄悄换回静态字」会让动态文案时有时无。
  const f = field({ key: 'model', hint: '静态', hintOf: () => '' });
  assert.equal(fieldHint(f, {}), '', 'hintOf 在就不看 hint');
});

test('fieldHint：hintOf 拿到的 values 是**当前值**（v3 判断那条）', () => {
  const f = field({
    key: 'model',
    hintOf: (v: any) => '现在选的是 ' + (v.model === 'nai-diffusion-3' ? 'v3' : 'v4.5'),
  });
  assert.equal(fieldHint(f, { model: 'nai-diffusion-3' }), '现在选的是 v3');
  assert.equal(fieldHint(f, { model: 'nai-diffusion-4-5-full' }), '现在选的是 v4.5');
});

test('groupHint：hintOf 优先于静态 hint；都没有 → 空串', () => {
  const g = group({ hint: '静态块说明', hintOf: (v: any) => '当前 ' + v.model });
  assert.equal(groupHint(g, { model: 'x' }), '当前 x');
  assert.equal(groupHint(group({ hint: '只有静态' }), {}), '只有静态');
  assert.equal(groupHint(group({}), {}), '');
});

test('groupBadge：badgeOf 算出「N 字」这类角标；没声明返回空串', () => {
  // 等价基线 §2：「固定提示词」块的角标 = len(prompt)+len(prompt_end)+len(negative)
  const fixed = group({
    id: 'fixed',
    badgeOf: (v: any) => {
      const n = ['prompt', 'prompt_end', 'negative'].reduce((sum, k) => sum + String(v[k] ?? '').length, 0);
      return n ? n + ' 字' : '';
    },
  });
  assert.equal(groupBadge(fixed, { prompt: 'abcd', prompt_end: 'ef', negative: 'ghi' }), '9 字');
  assert.equal(groupBadge(fixed, {}), '', '一个字都没有时不显示角标');
  assert.equal(groupBadge(fixed, { prompt: 'abcd' }), '4 字');
  assert.equal(groupBadge(group({ id: 'x' }), { prompt: 'abcd' }), '', '没声明 badgeOf → 空串');
});

/* ==================== dirtyFields ==================== */

test('dirtyFields：与基线相等 → 空（「恢复默认」按钮保持 disabled）', () => {
  const fields = [field({ key: 'a', default: 1 }), field({ key: 'b', default: 2 })];
  assert.deepEqual(dirtyFields(fields, { a: 1, b: 2 }, { a: 1, b: 2 }), [], '没改过 → 空');
  assert.deepEqual(dirtyFields(fields, {}, {}), [], '两边都空 → 空');
});

test('dirtyFields：改一个键 → **只报那一个**（不许整表都脏）', () => {
  const fields = [field({ key: 'a' }), field({ key: 'b' }), field({ key: 'c' })];
  assert.deepEqual(dirtyFields(fields, { a: 1, b: 99, c: 3 }, { a: 1, b: 2, c: 3 }), ['b']);
  assert.deepEqual(dirtyFields(fields, { a: 9, b: 9, c: 3 }, { a: 1, b: 2, c: 3 }), ['a', 'b'], '改了两个就报两个');
});

test('dirtyFields：falsy 值的变化要认得出来（0 / false / 空串 vs 有值）', () => {
  // 回归：用 `!values[k]` 判空的话，「把 seed 从 5 改成 0」会被当成没改。
  const fields = [field({ key: 'seed' }), field({ key: 'variety' }), field({ key: 'prompt' })];
  assert.deepEqual(dirtyFields(fields, { seed: 0 }, { seed: 5 }), ['seed'], '5 → 0 是改过');
  assert.deepEqual(dirtyFields(fields, { variety: false }, { variety: true }), ['variety'], 'true → false 是改过');
  assert.deepEqual(dirtyFields(fields, { prompt: '' }, { prompt: 'x' }), ['prompt'], '清空也是改过');
});

test('dirtyFields：只看**声明过的字段**（values 里的无关键不算脏）', () => {
  // values 是宽松袋子：可能同时装着别的插件 / 工具覆盖的键。
  // 只按 fields 声明比对，否则「恢复默认」会永远亮着。
  const fields = [field({ key: 'a' })];
  assert.deepEqual(dirtyFields(fields, { a: 1, 别的插件: 'x' }, { a: 1 }), [], '没声明的键不参与比对');
});

test('dirtyFields：基线有值、现在没了 → 脏；**基线没值**时不判（口径见下条）', () => {
  const fields = [field({ key: 'a', default: 1 }), field({ key: 'b', default: 2 })];
  assert.deepEqual(dirtyFields(fields, { a: 1 }, { a: 1, b: 2 }), ['b'], '基线有值、现在没了 → 脏（用户清掉了）');
  // ⚠️ 反方向**不算脏**：base[key] === undefined = 这个字段没有基线，
  //   无法判断「改没改」，所以不参与 —— 否则「恢复默认」永远亮着（Lead 追加的口径）。
  assert.deepEqual(dirtyFields(fields, { a: 1, b: 2 }, { a: 1 }), [], '基线缺该键 → 该字段不参与判定');
});

test('dirtyFields：**没声明 default 的字段不参与判定**（否则「恢复默认」永远可点）', () => {
  // 口径（Lead 追加）：base[key] === undefined 表示「这个字段没有基线可比」——
  // 没有 default 的字段本来就不该被「恢复默认」管，把它算成 dirty 会让按钮永远亮着。
  const fields = [field({ key: 'withDefault', default: 'd' }), field({ key: 'noDefault' })];
  const base = { withDefault: 'd' }; // noDefault 没有基线值

  assert.deepEqual(dirtyFields(fields, { withDefault: 'd', noDefault: '用户填的' }, base), [], '没 default 的字段有值也不算脏');
  assert.deepEqual(dirtyFields(fields, { withDefault: 'd' }, base), [], '没 default 的字段缺着也不算脏');
  // 有 default 的照常判定（证明上一条不是「整表都不判」）
  assert.deepEqual(dirtyFields(fields, { withDefault: 'changed' }, base), ['withDefault'], '有基线的照常判');
});

test('dirtyFields：顺序 = fields 声明顺序（结果稳定，UI 才好显示）', () => {
  const fields = [field({ key: 'z' }), field({ key: 'a' })];
  assert.deepEqual(dirtyFields(fields, { z: 1, a: 1 }, { z: 0, a: 0 }), ['z', 'a'], '按声明顺序而不是字典序');
});