<template>
  <div ref="rootEl" class="cx-sf">
    <div v-for="(block, index) in blocks" :key="block.group ? block.group.id : 'cx-sf-default-' + index" class="cx-blk">
      <div v-if="block.group" class="cx-blkh">
        <span class="cx-t">{{ block.group.title }}</span>
        <span v-if="badgeOf(block.group)" class="cx-sf-badge">{{ badgeOf(block.group) }}</span>
        <span class="cx-spacer"></span>
        <span v-if="hintOfGroup(block.group)" class="cx-n">{{ hintOfGroup(block.group) }}</span>
      </div>

      <div v-for="field in block.fields" :key="field.key" class="cx-f">
        <!--
          note：只读一行，不是控件。两种用法，靠 label 空不空区分：

          1. **有 label** = 带标签的一行（旧界面「来源：NovelAI」那一行）：
             标签「来源」+ 值 + 说明小字。**label 必须画出来** ——
             只画正文会剩一句没有主语的说明，用户不知道这行在说什么。
          2. **label 为空** = **块尾的一段话**（旧界面「高级」块底下那句
             「SMEA / SMEA DYN / 减少伪影 是 v3 的字段…」）。这时**不画空标签** ——
             空 <label> 会撑出一个没有内容的行。

          为什么块尾的话要用 note 字段、而不是 SettingsGroup.hintOf：
          hintOf 画在**块头右侧**（.cx-n，右对齐小字），长句子挤在那里会把标题压扁；
          而旧界面那句话本来就在块**内部底部**。位置是观感的一部分，不能因为「文字还在」就搬走。
          配 visibleIf 还能让它只在需要时出现（非 v3 才说这句话）。
        -->
        <template v-if="field.type === 'note'">
          <label v-if="field.label" class="cx-lab">{{ field.label }}</label>
          <p class="cx-sf-note">{{ noteValue(field) }}</p>
        </template>

        <!-- button：点一下 emit 动作名，立即提交 -->
        <button
          v-else-if="field.type === 'button'"
          class="cx-tiny"
          type="button"
          @click="emit('field-action', field.action || field.key)"
        >{{ field.label }}</button>

        <!-- boolean：一行标签 + 右侧 Sw，点了立即提交 -->
        <div v-else-if="field.type === 'boolean'" class="cx-frow">
          <span class="cx-sw-lab">{{ field.label }}</span>
          <Sw :model-value="boolOf(field)" @update:model-value="onBool(field, $event)" />
        </div>

        <template v-else>
          <label class="cx-lab">{{ field.label }}</label>

          <!-- select：2~4 项且声明 seg 时用药丸，否则下拉 -->
          <SegBar
            v-if="field.type === 'select' && segVariant(field)"
            :model-value="strOf(field)"
            :items="itemsOf(field)"
            :variant="segVariant(field) || 'seg'"
            @update:model-value="onSelect(field, $event)"
          />
          <select
            v-else-if="field.type === 'select'"
            :value="strOf(field)"
            @change="onSelect(field, $event)"
          >
            <option v-for="option in field.options || []" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>

          <!-- password：带一个「显示 · 隐藏」的幽灵键，默认遮住 -->
          <div v-else-if="field.type === 'password'" class="cx-frow">
            <input
              :type="shown[field.key] ? 'text' : 'password'"
              :value="inputValue(field, draft, model)"
              :placeholder="field.placeholder || ''"
              autocomplete="off"
              spellcheck="false"
              class="cx-flex1"
              @input="onInput(field, $event)"
              @change="commit(field)"
            />
            <button class="cx-ghost" type="button" @click="toggleShown(field.key)">
              {{ shown[field.key] ? '隐藏' : '显示' }}
            </button>
          </div>

          <!-- code：等宽正文 -->
          <textarea
            v-else-if="field.type === 'code'"
            class="cx-grow cx-sf-code"
            :value="inputValue(field, draft, model)"
            :placeholder="field.placeholder || ''"
            spellcheck="false"
            @input="onInput(field, $event)"
            @change="commit(field)"
          ></textarea>

          <!-- textarea：自动增高 -->
          <textarea
            v-else-if="field.type === 'textarea'"
            class="cx-grow"
            :value="inputValue(field, draft, model)"
            :placeholder="field.placeholder || ''"
            @input="onInput(field, $event)"
            @change="commit(field)"
          ></textarea>

          <!-- number：change 时夹取提交 -->
          <input
            v-else-if="field.type === 'number'"
            type="number"
            :value="inputValue(field, draft, model)"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            @input="onInput(field, $event)"
            @change="commit(field)"
          />

          <!-- text（兜底，也是唯一剩下的） -->
          <input
            v-else
            type="text"
            :value="inputValue(field, draft, model)"
            :placeholder="field.placeholder || ''"
            @input="onInput(field, $event)"
            @change="commit(field)"
          />
        </template>

        <!-- note 的说明已经在上面那一行里了，这里不重复画；其它控件照常带小字 -->
        <p v-if="field.type !== 'note' && hintOf(field)" class="cx-hint cx-mt6">{{ hintOf(field) }}</p>
      </div>
    </div>

    <!--
      恢复默认。

      ⚠️ **确认 + 说明都不能省**：这一下会把这一页的设置全部清回内置默认值，
      而插件设置里常常有**凭据**（生图的 API Key 就是）。少一个确认，用户点一下就把 Key 弄丢了、
      而且找不回来。旧的手写表单有这两句，改成声明式之后**必须补回来**：
        - 确认文案由插件给（`SettingsSchema.resetConfirm`）—— 只有插件知道这页里有什么值钱的东西；
        - 说明文案由宿主给（下面那句通用的），免得每个插件都要自己写一遍「清回内置默认值」这种话。
      插件没给 `resetConfirm` 时不弹确认（工具那类没有凭据的设置不需要拦一道）。
    -->
    <div v-if="showReset" class="cx-foot">
      <button class="cx-fill dang" type="button" :disabled="!dirty.length" @click="onReset">
        {{ resetLabel }}
      </button>
      <p class="cx-hint cx-mt8">恢复默认会把这一页的设置全部清回内置默认值。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';

import type { SettingsField, SettingsGroup, SettingsValues } from '../core/ports.ts';
import {
  buildPatch,
  dirtyFields,
  fieldHint,
  fieldValue,
  groupBadge,
  groupFields,
  groupHint,
  inputValue,
  seedValues,
  segItems,
  segVariantOf,
  selectValueFrom,
} from './settings_form.ts';
import SegBar from './SegBar.vue';
import Sw from './Sw.vue';

/**
 * 声明式设置表单 —— **宿主侧渲染**。逻辑全在 `settings_form.ts`，这里只有模板 + 事件。
 *
 * 为什么要分家（本工程既有做法，见 `tool_rows.ts` + `ToolDetail.vue`）：
 * `node --test` **测不了 .vue**（编译要 vue-loader）。凡是「判断 / 夹取 / 分组」这种
 * 错了也看不出来的逻辑，抽到 .ts 才测得动。所以本文件里**不出现**任何
 * `Math.round` / `visibleIf` 判断 / 分组逻辑 —— 只调用上面的函数。
 *
 * 值住在外面：组件**不吃也不写** store。
 *  - props `values` 进（来自 ToolOverride.config 或 plugins.<id>）
 *  - 改动只 `emit('patch', ...)`，写路径唯一在 App.vue → store
 *
 * 本地草稿（照 `PluginDetail.vue` 的做法）：打字时不被 props 回写冲掉 ——
 * 没有草稿的话，用户每敲一个字父级回写一次，光标就会跳。
 * `props.values` 外部变化（恢复默认 / 换对象）时重新播种。
 */
const props = withDefaults(
  defineProps<{
    fields: SettingsField[];
    values: SettingsValues;
    groups?: SettingsGroup[];
    /** 底部「恢复默认」画不画（默认画） */
    showReset?: boolean;
    /** 按钮文案 */
    resetLabel?: string;
    /**
     * 点「恢复默认」前的确认文案；**不给就不确认**。
     *
     * 由插件声明（`SettingsSchema.resetConfirm`）：只有插件自己知道这一页里
     * 有没有值钱的东西（生图的 API Key 就是）。宿主编不出这句话，也不该编。
     */
    resetConfirm?: string;
  }>(),
  {
    groups: undefined,
    showReset: true,
    resetLabel: '恢复默认',
    // 显式 undefined：「不给就不确认」是有意义的缺省（工具那类没有凭据的设置不该被拦一道），
    // 而且 vue/require-default-prop 要求可选 prop 有缺省值 —— 照上面 groups 的既有写法给。
    resetConfirm: undefined,
  },
);

const emit = defineEmits<{
  patch: [Record<string, unknown>];
  reset: [];
  'field-action': [key: string];
}>();

const rootEl = ref<HTMLElement | null>(null);

/**
 * 外部值 + 缺键补默认，合成一份「界面认为的当前值」。
 *
 * 三件事都从它出发：分组 / 可见性 / 动态小字 / 甚至 draft 的种子。
 * `seedValues` 不原地改 props.values（那可能是 store 里那份）。
 */
const model = computed<SettingsValues>(() => seedValues(props.fields, props.values));

/**
 * 每个块里的字段。`groupFields` 负责分组 + 组级 visibleIf + 未登记兜底。
 * 这是 computed：values 一变整张表单跟着重算（`hintOf` 也就跟着变）。
 */
const blocks = computed(() => groupFields(props.fields, props.groups, model.value));

/** 恢复默认按钮的依据：跟「播种后的默认值」比 */
const dirty = computed(() => dirtyFields(props.fields, model.value, seedValues(props.fields, {})));

/** 本地草稿：控件里正在被编辑的字符串。只装**用户动过**的键，没动过的走 model */
const draft = reactive<Record<string, unknown>>({});
/** password 的显示 / 隐藏开关（按字段 key 记，默认遮住） */
const shown = reactive<Record<string, boolean>>({});

/**
 * 重新播种。
 *
 * 只在「外部的值真的变了」时才清草稿 —— 用 JSON 比一下，
 * 免得父级每次渲染都给个新对象引用、把用户正在打的字冲掉。
 */
let lastSeeded = '';
watch(
  () => props.values,
  next => {
    const expected = JSON.stringify(seedValues(props.fields, next));
    if (expected !== lastSeeded) {
      lastSeeded = expected;
      for (const key of Object.keys(draft)) delete draft[key];
    }
    void nextTick(growAll);
  },
  { deep: true },
);

onMounted(() => {
  lastSeeded = JSON.stringify(model.value);
  void nextTick(growAll);
});

/* ---------- 读值（全部走 settings_form.ts 的口径） ---------- */

function strOf(field: SettingsField): string {
  return fieldValue(field, model.value);
}

function boolOf(field: SettingsField): boolean {
  return model.value[field.key] === true;
}

function hintOf(field: SettingsField): string {
  return fieldHint(field, model.value);
}

function hintOfGroup(group: SettingsGroup | null): string {
  return groupHint(group, model.value);
}

function badgeOf(group: SettingsGroup | null): string {
  return groupBadge(group, model.value);
}

/** `''` = 用下拉；`'seg'` / `'mode'` 是两种不同的药丸（由声明方说了算，这里不猜） */
function segVariant(field: SettingsField): '' | 'seg' | 'mode' {
  return segVariantOf(field);
}

function itemsOf(field: SettingsField): { value: string; label: string }[] {
  return segItems(field);
}

/**
 * note 的「值」。
 *
 * note 不是控件，没有 `values[key]` 可读 —— 它要显示的是**派生出来的当前状态**
 * （来源标签「NovelAI」）。所以复用 `hintOf` 的通道：字段用 hintOf 提供它。
 * 退化情况：作者没给 hintOf 就退回静态 hint，别画一行空白。
 */
function noteValue(field: SettingsField): string {
  return hintOf(field);
}

/* ---------- 草稿 ---------- */

function onInput(field: SettingsField, event: Event): void {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  draft[field.key] = el.value;
  // textarea 跟着内容长（不做内嵌小滚动区）
  if (el instanceof HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
}

/**
 * 提交一个字段。`buildPatch` 决定写几个键：
 *  - number → 夹取后的数字
 *  - select 命中带 patch 的项 → 展开成多个键（尺寸预设写 width+height）
 *  - 其余 → `{[key]: raw}`
 *
 * 提交后清掉这个字段的草稿：让界面回到「以外部值为准」，
 * 这样夹取结果（比如输入 999 被夹成 50）会立刻显示出来。
 */
function commit(field: SettingsField): void {
  const raw = field.key in draft ? draft[field.key] : model.value[field.key];
  if (field.key in draft) delete draft[field.key];
  // 第 3 个参数是 number 的退路：用户清空 / 输入非数字时保留原值，
  // 而不是 `Number('')` → 0 再被 min 夹成最小值（那是悄悄改掉用户的配置）。
  emit('patch', buildPatch(field, raw, model.value[field.key]));
}

/** boolean：点了立即提交 */
function onBool(field: SettingsField, next: boolean): void {
  emit('patch', { [field.key]: next });
}

/**
 * select：选了立即提交（药丸和下拉共用）。
 *
 * `payload` 故意收宽：药丸那条路给的是字符串，原生 `<select>` 那条路给的是 **DOM Event**。
 * 归一交给 `selectValueFrom`（放 .ts 里才测得到）——
 * 原来这里直接当字符串用，于是下拉选中值被 `asText(event)` 变成空串写进配置。
 */
function onSelect(field: SettingsField, payload: unknown): void {
  emit('patch', buildPatch(field, selectValueFrom(payload)));
}

/**
 * 恢复默认。
 *
 * 插件声明了 `resetConfirm` 就先问一句 —— 这一下会清掉凭据（API Key 之类），
 * 用户点错了找不回来。取消时不 emit，什么都不发生。
 */
function onReset(): void {
  if (props.resetConfirm && !window.confirm(props.resetConfirm)) return;
  emit('reset');
}

function toggleShown(key: string): void {
  shown[key] = !shown[key];
}

/* ---------- 自动增高 ---------- */

function growAll(): void {
  const root = rootEl.value;
  if (!root) return;
  root.querySelectorAll('textarea').forEach(node => {
    const el = node as HTMLTextAreaElement;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  });
}
</script>
