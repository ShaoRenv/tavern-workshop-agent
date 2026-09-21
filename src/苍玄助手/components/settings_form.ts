/**
 * 声明式设置表单 —— **纯逻辑**（无 Vue import、无 DOM）。
 *
 * ## 为什么逻辑要抽成 .ts（本工程既有做法）
 *
 * `node --test` **测不了 .vue**：组件编译要走 vue-loader，测试进程里没有那套东西。
 * 所以凡是「判断 / 夹取 / 分组」这类会出错、且出错看不出来的逻辑，一律放这里；
 * `SettingsForm.vue` 只剩模板 + 事件转发。先例：`components/tool_rows.ts` + `ToolDetail.vue`。
 *
 * ## 为什么是 9 种控件而不是 8 种
 *
 * 生图插件的设置页是**最全的那张表单**，9 种是逐行倒推出来的。其中 `note` 不是控件 ——
 * 它是「来源：NovelAI」那一行**只读文本**。它必须占一个字段位，理由有两条：
 *   1. 它有自己的位置（夹在「接口」块第 1 行）和动态内容（`hintOf`,见下）；
 *   2. 它承载的是**用户需要看见、但不需要编辑**的信息。少掉它，界面上就凭空少一行说明。
 * 如果只算「能编辑的控件」是 8 种；把 `note` 也算进来才是 9。
 *
 * ## 契约
 *
 * 唯一来源是 `core/ports.ts` 的 `SettingsField` / `SettingsGroup` / `SettingsSchema`
 * （阶段 4 冻结，本文件只读它、不改它）。值的袋子是宽松的 `SettingsValues`：
 * 字段只是**声明**，值存在哪（ToolOverride.config / plugins.<id>）不归这里管。
 *
 * ⚠️ 属性名是 `valueFrom`，**不是** `valueOf`：后者是 `Object.prototype.valueOf`，
 * 对象字面量上叫这个名字会让 TS 在做结构比较时把继承来的 `valueOf(): Object` 也算进来，
 * 整个 `SettingsField` 直接赋值不上。同理避开 `toString` / `constructor`。
 */
import type { SettingsField, SettingsFieldOption, SettingsGroup, SettingsValues } from '../core/ports.ts';

/** 字符串化：把任意 unknown 稳妥地变成一个可显示 / 可比较的字符串 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * 宽松地把一个输入转成有限数字；**转不出来就是 undefined**（不是 0）。
 *
 * 为什么不能直接用 `Number()`：`Number('')` / `Number('   ')` / `Number(null)` 全都得 **0**，
 * 而且 0 是有限数 —— 于是「用户把数字框清空」会被当成「他填了 0」，
 * 再被 min 一夹就变成最小值（steps 清空 → 1）。那是**悄悄改掉用户的配置**。
 * 所以空串 / 空白 / null / undefined / NaN / 非数字串一律算「没输入」，交给 fallback。
 */
function toFiniteNumber(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return undefined;
    const num = Number(text);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/** 读一个字段的当前值；字段自己的 key 从来没有过 → undefined（不是空串） */
export function rawValueNow(field: SettingsField, values: SettingsValues): unknown {
  return values[field.key];
}

/**
 * 读一个字段的当前值（**select 专用口径**）。
 *
 * `type='select'` 且声明了 `valueFrom` 时走它 —— 那是「尺寸预设」那种复合控件：
 * 它自己不吃 `values[key]`（那个键压根不存在），而是从 width+height 两个键**反推**出当前选中项。
 * 没给 `valueFrom` 就照常读 `values[key]`。
 *
 * 返回 string：select 的选项 value 都是字符串，控件要拿它跟 option.value 比。
 */
export function fieldValue(field: SettingsField, values: SettingsValues): string {
  if (field.type === 'select' && typeof field.valueFrom === 'function') {
    try {
      // 派生值也只认标量：数组 / 对象变成 "[object Object]" 会让 select 匹配不上任何选项
      return asText(field.valueFrom(values));
    } catch {
      // 声明方给的函数炸了不该连坐整个表单：退回读自己的键
      return asText(values[field.key]);
    }
  }
  return asText(values[field.key]);
}

/**
 * 缺键补 `default`，已有键以 `values` 为准。
 *
 * 为什么需要：老数据里没有新加的字段键。不补的话，界面画出来的控件是空的，
 * 用户不动它就永远是空的（而不是内置默认值）—— 看起来「默认值没生效」。
 * 返回**新对象**，不原地改传入的 values（那可能是 store 里那份）。
 */
export function seedValues(fields: readonly SettingsField[], values: SettingsValues): SettingsValues {
  const out: SettingsValues = { ...values };
  for (const field of fields) {
    if (field.default === undefined) continue;
    if (out[field.key] !== undefined) continue;
    out[field.key] = field.default;
  }
  return out;
}

/**
 * 按 `visibleIf` 过滤。`visibleIf` 缺失 = 可见。
 *
 * 这是「按字段名特判」的替代品。旧代码里有
 * `if (key === 'straight_alpha' && !straightAlphaOk) return`（点了没反应），
 * 现在是让控件**根本不出现** —— 语义更好，且没有任何字段名判断。
 * 声明方抛错时按「可见」处理：宁可多画一个控件，也不要整块表单凭空少东西。
 */
export function visibleFields(
  fields: readonly SettingsField[],
  values: SettingsValues,
): SettingsField[] {
  return fields.filter(field => {
    if (typeof field.visibleIf !== 'function') return true;
    try {
      return field.visibleIf(values) !== false;
    } catch {
      return true;
    }
  });
}

/** 一组：块头 + 块里的字段。`group` 为 null = 没登记在 groups 里的字段 */
export interface FieldGroupBlock {
  group: SettingsGroup | null;
  fields: SettingsField[];
}

/**
 * 分组。
 *
 * 三条口径：
 *  1. 声明了 `groups`：**按 groups 的顺序**出块（块顺序是声明方的表达，不该被字段顺序打乱）；
 *  2. 字段的 `group` 有值但**没在 groups 里登记** → 用 id 当标题兜底，**不许静默丢字段**
 *     （丢了 = 用户从此改不了那一项，而且没有任何报错，是本阶段最危险的失败模式）；
 *  3. 字段没写 `group` → 进「默认块」(`group: null`)，排在最后。
 *
 * ⚠️ 这里**故意没有组级 `visibleIf`**（曾经有过，已删）：契约里不留没有使用者的可选属性，
 * 而生图那张最全的表单一个真实用例都没有（理由写在 core/ports.ts 的 SettingsGroup 上）。
 * 删掉它同时消掉了一处很容易写错的逻辑：组被整块隐藏时，它里面的字段会被下面的
 * 「未登记兜底」当成孤儿**重新冒出来**，得额外记一个 hiddenGroups 集合去区分
 * 「主动关掉」和「压根没登记」。字段级 `visibleIf` 不受影响，照常生效。
 */
export function groupFields(
  fields: readonly SettingsField[],
  groups: readonly SettingsGroup[] | undefined,
  values: SettingsValues,
): FieldGroupBlock[] {
  const visible = visibleFields(fields, values);
  const blocks: FieldGroupBlock[] = [];
  const byId = new Map<string, FieldGroupBlock>();

  for (const group of groups ?? []) {
    const block: FieldGroupBlock = { group, fields: [] };
    byId.set(group.id, block);
    blocks.push(block);
  }

  /** 兜底块：group 有值但没登记。按出现顺序建，标题先用 id */
  const orphan = new Map<string, FieldGroupBlock>();
  const defaultBlock: FieldGroupBlock = { group: null, fields: [] };

  for (const field of visible) {
    const gid = field.group;
    if (!gid) {
      defaultBlock.fields.push(field);
      continue;
    }
    const registered = byId.get(gid);
    if (registered) {
      registered.fields.push(field);
      continue;
    }
    let block = orphan.get(gid);
    if (!block) {
      // 没登记就用 id 当标题兜底：字段一定画得出来
      block = { group: { id: gid, title: gid }, fields: [] };
      orphan.set(gid, block);
    }
    block.fields.push(field);
  }

  // 兜底块排在登记块之后、默认块之前（保持确定性顺序）
  for (const block of orphan.values()) blocks.push(block);
  if (defaultBlock.fields.length > 0) blocks.push(defaultBlock);

  // 空块（字段全被 visibleIf 滤掉、或本来就没字段）不画，免得留一个空标题
  return blocks.filter(block => block.fields.length > 0);
}

/**
 * 一个输入控件**该显示什么** —— 草稿优先，否则读已存的值。
 *
 * 为什么必须有它（真机抓到的 bug，SSR 看不见）：
 * 组件原来 5 处都绑 `:value="draft[key] ?? ''"` —— **只看草稿、完全不看 values**。
 * 结果：已经存着的值（steps=28 / api_key=… / 三段固定提示词）渲染出来全是空的，
 * 用户会以为自己填的东西丢了，还可能把空值再存回去。
 * 而 `commit()` 那一半读的是对的（草稿 → 回落到 values），
 * 所以这是个**「能存不能看」**的错 —— 不点开真界面看不出来。
 *
 * 口径：
 *  - 键**在草稿里** → 用草稿（用户正在打字，不能被父级回写冲掉；空串也算「他在清空」）
 *  - 不在草稿里     → 用 `values[key]`（**就是原来漏掉的那一半**）
 *  - 都没有         → `''`
 * 返回值一定是字符串：`<input>` / `<textarea>` 的 value 是字符串，数字 28 → `'28'`。
 */
export function inputValue(
  field: SettingsField,
  draft: Record<string, unknown>,
  values: SettingsValues,
): string {
  if (field.key in draft) return asText(draft[field.key]);
  return asText(values[field.key]);
}

/**
 * 把「select 变动的载荷」归一成字符串。
 *
 * 为什么必须有它（真机抓到的另一个 bug）：原生 `<select>` 的 `@change` 给的是
 * **DOM Event**（`$event`），而 `onSelect(field, value: string)` 期望字符串。
 * 直接传 `$event` 时 `asText(event)` 得空串 → `buildPatch` 写出 `{[key]: ''}`，
 * 于是「把模型从 v4.5 切成别的」实际存进去的是空串（小字立刻变「不认识的模型名」）。
 * 受害的是**所有非 SegBar 的下拉**（model / uc_preset / sampler / schedule）；
 * SegBar 那条路 `@update:model-value` 给的就是字符串，所以没事 —— 一种写法坏、另一种好。
 *
 * 归一放在这里、而不是模板里写 `$event.target.value`：模板里的表达式
 * **SSR 与单测都碰不到**，等于没修。放 .ts 里两条路都能测。
 *
 * 口径：字符串原样；类事件对象取 `target.value`；其余（undefined/null/数字/取不到）一律 `''` ——
 * **宁可空串，也不能把 `[object Object]` 写进配置**。
 */
export function selectValueFrom(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const target = (payload as { target?: unknown }).target;
    if (target && typeof target === 'object') {
      const value = (target as { value?: unknown }).value;
      if (typeof value === 'string') return value;
      return asText(value);
    }
  }
  return '';
}

/**
 * 数字夹取。**语义由 `step` 决定，与字段 key 叫什么无关。**
 *
 * 这是本轮要消灭的那句硬编码的替代：
 *   旧 `PluginDetail.vue:478` —— `if (key !== 'guidance' && key !== 'guidance_rescale') value = Math.round(value)`
 *   新 —— `step < 1` 不取整（guidance 0.5 / guidance_rescale 0.02），
 *          `step >= 1` 或没给 → 取整。
 *
 * 所以**这里不许出现任何字段名判断**。回归闸：`step:0.5` 的字段不取整，且与 key 无关。
 * `fallback` 是「输入不是数 / NaN」时的退路（通常是当前已存的值）；它也不是数就用 min。
 */
export function clampNumber(field: SettingsField, raw: unknown, fallback?: unknown): number {
  let value = toFiniteNumber(raw);
  if (value === undefined) value = toFiniteNumber(fallback);
  if (value === undefined) value = field.min ?? 0;

  const step = field.step;
  // step 缺失 或 step >= 1 → 取整；step < 1 → **保留小数**
  //
  // ⚠️ 这里只「保留小数」，**不按 step 对齐到网格**：契约说的是「< 1 时不许取整」，
  // 没说要吸附到 step 的整数倍。用户输 7.3 就该存 7.3（step:0.5 只影响控件的
  // 步进按钮与浏览器校验），吸附成 7.5 属于契约之外的行为变更。
  // 唯一的处理是消掉浮点垃圾（7.300000000000001 → 7.3）。
  const stepMissingOrWhole = !(typeof step === 'number' && Number.isFinite(step) && step > 0 && step < 1);
  if (stepMissingOrWhole) {
    value = Math.round(value);
  } else {
    value = Number(value.toPrecision(12));
  }

  const min = typeof field.min === 'number' ? field.min : undefined;
  const max = typeof field.max === 'number' ? field.max : undefined;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

/**
 * 一个控件的改动 → 要写下去的**一个或多个键**。
 *
 * 三个分支：
 *  - `number`：先夹取（见 clampNumber），写进去的是**数字**不是字符串；
 *  - `select` 选中了带 `patch` 的项：**展开成多个键**
 *    （尺寸预设 `{value:'832x1216', patch:{width:832,height:1216}}` —— 一个控件写两个键）；
 *  - 其余：`{[key]: raw}` 原样。
 *
 * select 命中带 patch 的项时**不写字段自己的 key**：那样会在 values 里留一个没人读的键，
 * 而且「选预设」和「改宽高」两条路会互相覆盖。字段自己的 key 只在选项没 patch 时写。
 */
export function buildPatch(
  field: SettingsField,
  raw: unknown,
  numberFallback?: unknown,
): Record<string, unknown> {
  if (field.type === 'number') {
    // numberFallback 透传给 clampNumber：用户清空数字框 / 输入非数字时，
    // 旧代码的退路是「保留原来存着的值」（而不是变成 min）。组件传 `model.value[key]`。
    return { [field.key]: clampNumber(field, raw, numberFallback) };
  }

  if (field.type === 'select') {
    const picked = asText(raw);
    const option = (field.options ?? []).find(item => item.value === picked);
    if (option && option.patch && Object.keys(option.patch).length > 0) {
      return { ...option.patch };
    }
    return { [field.key]: picked };
  }

  return { [field.key]: raw };
}

/**
 * 哪些字段跟基线（`base`，用内置默认播种过的那份）不一样 —— 「恢复默认」按钮的 disabled 依据。
 *
 * 比较用 `Object.is`：数字 / 字符串 / 布尔 / null 都对；
 * 对象这类（本契约里没有，但别炸）退化成 JSON 比较。
 */
export function dirtyFields(
  fields: readonly SettingsField[],
  values: SettingsValues,
  base: SettingsValues,
): string[] {
  const keys: string[] = [];
  for (const field of fields) {
    const now = values[field.key];
    const was = base[field.key];
    /**
     * 基线里**根本没有这个键**的字段不参与判定。
     *
     * 为什么（真缺陷，Lead 2026-09 指出）：基线是「播种过的默认值」。
     * 字段**没声明 default** 时，基线里这个键就是 undefined，而 values 里通常有值
     * （空串 / 用户填的）→ `Object.is('', undefined)` 为假 → **永远算「改过」**，
     * 「恢复默认」按钮一直亮着，点下去又什么都没变（因为声明方压根没说默认值是什么）。
     * 声明方没给 default = 没表达「原始值该是什么」= 本来就没法判断改没改，所以跳过。
     */
    if (was === undefined) continue;
    if (Object.is(now, was)) continue;
    // NaN === NaN 走 Object.is 已经是 true；这里只剩对象 / 数组
    if (isPlainish(now) && isPlainish(was)) {
      if (safeJson(now) === safeJson(was)) continue;
      keys.push(field.key);
      continue;
    }
    keys.push(field.key);
  }
  return keys;
}

function isPlainish(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * 字段下面那句小字。
 *
 * **`hintOf` 优先于 `hint`**，且每次调用都重算 —— 它是「活的」：
 * 模型从 v4.5 切成 v3，「现在选的是 v4.5」必须跟着变成 v3。
 * 所以这个函数**不能在组件里只算一次**（挂载时算一次 = 「写得出来但不跟着变」，
 * 那是最难发现的一类错）。组件里必须把它放进 computed。
 *
 * `hintOf` 返回空串时**不**回退到 `hint`：空串是「这一条现在没有要说的」的明确表达。
 */
export function fieldHint(field: SettingsField, values: SettingsValues): string {
  if (typeof field.hintOf === 'function') {
    try {
      return field.hintOf(values);
    } catch {
      return field.hint ?? '';
    }
  }
  return field.hint ?? '';
}

/** 块头右侧那句小字；口径同 fieldHint（`hintOf` 优先，活的重算） */
export function groupHint(group: SettingsGroup | null, values: SettingsValues): string {
  if (!group) return '';
  if (typeof group.hintOf === 'function') {
    try {
      return group.hintOf(values);
    } catch {
      return group.hint ?? '';
    }
  }
  return group.hint ?? '';
}

/** 块头标题旁的角标（生图「固定提示词」那块显示「N 字」）；活的重算，空串 = 不画 */
export function groupBadge(group: SettingsGroup | null, values: SettingsValues): string {
  if (!group || typeof group.badgeOf !== 'function') return '';
  try {
    return group.badgeOf(values);
  } catch {
    return '';
  }
}

/**
 * 这个 select 该画成**哪种**药丸；`''` = 回落成 `<select>`。
 *
 * ⚠️ 把 `field.variant` **原样带出去**，组件里不许再猜、也不许补默认值。
 * 两个取值是两种不同的药丸（契约里写清楚了）：
 *   - `'mode'` → `.cx-modebar`：块内内联二选一（站点那个「官网直连｜反代 / 中转」）
 *   - `'seg'`  → `.cx-seg`：顶栏页签那种
 * 旧界面的站点选择器用的是 `variant="mode"`；这里若给个 `'seg'` 的默认值，
 * 就会在块里画出一条像顶栏页签的东西 —— 肉眼可见的观感退化。
 *
 * 条数守卫：少于 2 个没有「分段」可言；多于 4 个药丸会挤成一团（那时下拉更好）。
 * 守卫不通过就返回 `''`（用下拉），**不是**改写 variant —— 声明方的意思照旧保留。
 */
export function segVariantOf(field: SettingsField): '' | 'seg' | 'mode' {
  if (field.type !== 'select') return '';
  const wanted = field.variant;
  if (wanted !== 'seg' && wanted !== 'mode') return '';
  const count = field.options?.length ?? 0;
  if (count < 2 || count > 4) return '';
  return wanted;
}

/** select 的选项转成 SegBar 要的 `{value,label}`（只取它认的两个键） */
export function segItems(field: SettingsField): { value: string; label: string }[] {
  return (field.options ?? []).map((option: SettingsFieldOption) => ({
    value: option.value,
    label: option.label,
  }));
}
