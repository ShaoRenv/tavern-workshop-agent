<template>
  <div class="cx-toolpage">
    <!-- 1 头部：名字 / 分组 / 来源 / 状态（任何工具都一样） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <button class="cx-back" type="button" @click="emit('back')">← 返回</button>
        <span class="cx-spacer"></span>
        <span class="cx-tag" :class="edited ? 'ok' : ''">{{ edited ? '已改过' : '默认' }}</span>
      </div>
      <div class="cx-tpname">
        <span class="cx-tn2">{{ tool.title || tool.name }}</span>
        <span v-if="groupLabel" class="cx-tag">{{ groupLabel }}</span>
      </div>
      <div class="cx-frow cx-mt10">
        <span class="cx-lab cx-f0">来源</span>
        <span class="cx-tag">{{ sourceLabel }}</span>
        <span class="cx-lab cx-f0">状态</span>
        <span class="cx-tag" :class="tool.missing ? 'dang' : 'ok'">{{ tool.missing ? '内核里没有' : '正常' }}</span>
        <span v-if="tool.default_on" class="cx-tag">默认开</span>
        <span v-if="tool.readonly" class="cx-tag">只读</span>
        <span v-if="tool.user_initiated_only" class="cx-tag warn">仅明确要求时用</span>
      </div>
      <p v-if="tool.origin" class="cx-hint cx-mt6">{{ tool.origin }}</p>
      <div class="cx-f cx-mt12 cx-f0">
        <span class="cx-lab">名字（只读）</span>
        <input :value="tool.name" type="text" disabled />
      </div>
      <p class="cx-hint cx-mt6">名字是模型调它用的键，改名会让模型调不到它，所以这里只读。</p>
      <p class="cx-hint cx-mt6">{{ tool.desc || '（内核还没给这个世界一句话说明）' }}</p>
    </div>

    <!-- 2 提示词：永远在这一块，位置固定 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">提示词</span>
        <span v-if="descriptionEdited" class="cx-tag ok">已改过</span>
        <span class="cx-spacer"></span>
        <button v-if="descriptionEdited" class="cx-ghost dim" type="button" @click="clearDescription">恢复默认</button>
      </div>
      <textarea
        ref="descEl"
        v-model="descDraft"
        class="cx-mono cx-grow"
        placeholder="（内置默认还没暴露；填了就会盖住它）"
        @input="onDescriptionInput"
      ></textarea>
      <p class="cx-hint cx-mt6">这段就是模型看到的工具说明。</p>
      <p v-if="!tool.model_description" class="cx-hint cx-mt6 cx-warn-text">
        内核还没把内置默认说明暴露给界面（catalog() 里没有 model_description）。这里空着 = 用内核里那份，不填不会有问题。
      </p>
    </div>

    <!-- 3 参数：逐个参数的说明 + 默认值 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">参数</span>
        <span class="cx-n">{{ params.length }} 个</span>
        <span class="cx-spacer"></span>
        <button v-if="paramsEdited" class="cx-ghost dim" type="button" @click="clearParams">恢复默认</button>
      </div>
      <template v-if="params.length">
        <div v-for="param in params" :key="param.name" class="cx-tparam">
          <div class="cx-tparam-h">
            <span class="cx-tn2">{{ param.name }}</span>
            <span class="cx-tag">{{ param.type }}</span>
            <span v-if="param.required" class="cx-tag warn">必填</span>
          </div>
          <div class="cx-f cx-f0">
            <span class="cx-lab">说明</span>
            <input
              v-model="paramDescDraft[param.name]"
              type="text"
              :placeholder="param.description || '（内置没写说明）'"
              @change="onParamDescChange(param.name)"
            />
          </div>
          <div class="cx-f cx-mt10 cx-f0">
            <span class="cx-lab">默认值</span>
            <input
              v-model="paramDefaultDraft[param.name]"
              type="text"
              :placeholder="defaultPlaceholder(param)"
              @change="onParamDefaultChange(param)"
            />
          </div>
          <p v-if="paramError[param.name]" class="cx-hint cx-mt6 cx-danger-text">{{ paramError[param.name] }}</p>
        </div>
      </template>
      <p v-else class="cx-hint">内核还没把参数 schema（parameters）暴露给界面，等 agent-core 在 catalog() 里带上就能逐个参数改了。</p>
    </div>

    <!-- 4 调用：启用开关 + 单次超时 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">调用</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">用不用它 · 最多等多久</span>
      </div>
      <div class="cx-f">
        <template v-if="!followsGlobal">
          <div class="cx-frow">
            <span class="cx-sw-lab">在当前这个预设里启用</span>
            <Sw :model-value="enabled" @update:model-value="emit('toggle-enabled')" />
          </div>
          <p class="cx-hint cx-mt6">关掉 = 这个预设不把它给模型（只是这个预设的勾选，别处不受影响）。</p>
        </template>
        <!-- 跟随全局时这个开关不起作用，就别摆一个点不动的死控件 -->
        <p v-else class="cx-hint">
          这个预设跟随「能力」页的全局设置，所以这里没有单独的开关。要单独控制它，去「设置 · 预设」打开「单独启用预设能力」。
        </p>
      </div>
      <div class="cx-f">
        <div class="cx-frow">
          <span class="cx-lab cx-flex1 cx-f0">单次超时（毫秒，可空）</span>
          <button v-if="timeoutEdited" class="cx-ghost dim" type="button" @click="clearTimeout">恢复默认</button>
        </div>
        <input v-model="timeoutDraft" type="number" min="0" step="1000" placeholder="空着 = 不限制" @change="onTimeoutChange" />
        <p class="cx-hint cx-mt6">
          单次调用最多等多久，超了算失败。{{ tool.timeout_ms ? '内置默认 ' + tool.timeout_ms + ' ms。' : '内核没给内置默认。' }}
        </p>
      </div>
    </div>

    <!-- 5 工具自己的设置：声明式表单（ToolSettingsField）下一轮做，这里先占位 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">工具自己的设置</span>
        <span class="cx-spacer"></span>
        <span class="cx-tag">后面做</span>
      </div>
      <div class="cx-placeholder">
        {{
          isImage
            ? '生图是插件：接口地址、模型、采样器、尺寸、固定提示词都在「能力 · 插件」页改（这里只管提示词 / 参数 / 超时）。'
            : '这个工具没有专属设置'
        }}
      </div>
    </div>

    <!-- 6 来源与更新：只有外部工具才有，位置先留好 -->
    <div v-if="isExternal" class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">来源与更新</span>
        <span class="cx-spacer"></span>
        <span class="cx-tag">后面做</span>
      </div>
      <div class="cx-placeholder">外部工具的 URL、hash、拉取时间、重新拉取、卸载会放在这里。</div>
    </div>

    <!-- 底部：恢复默认（清掉这个工具的所有覆盖项） -->
    <div class="cx-foot">
      <button class="cx-fill dang" type="button" :disabled="!edited" @click="reset">恢复默认</button>
      <p class="cx-hint cx-mt8">恢复默认会清掉提示词、参数说明、参数默认值、超时和专属配置，用回内核里的那一份。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import type { ToolOverride } from '../core/ports.ts';
import Sw from './Sw.vue';
import type { UiTool, UiToolParam } from './ui_types.ts';
import { overrideEdited, textToValue, toolGroupLabel, toolParamList, valueToText } from './ui_types.ts';

/**
 * 工具详情页：**固定 5 块骨架**（外部工具多第 6 块），顺序固定，前 4 块对任何工具都一样。
 *   1 头部（名字 / 分组 / 来源 / 状态）  2 提示词  3 参数  4 调用（启用 + 超时）  5 工具自己的设置
 *   6 来源与更新（只有外部工具；先留位置，后面做）
 *
 * 编辑走本地草稿：输入框绑草稿，改了就 emit('patch') 让 App.vue 去写 store（界面不直接改 store）。
 * 用本地草稿而不是 props 双向绑定，是因为写路径在 store 那边、回显可能慢一拍甚至还没落地，
 * 本地草稿保证打字不会被回写冲掉；props 变了（恢复默认 / 换工具）会重新播种。
 *
 * 语义：patch 字段给 undefined = 用回内置默认；清空参数覆盖用空对象 {}；重置全部用 emit('reset')。
 * 内置默认（model_description / parameters）缺的时候明说「没暴露」，不自己复制文案。
 */
const props = withDefaults(defineProps<{ tool: UiTool; override?: ToolOverride; enabled?: boolean; followsGlobal?: boolean }>(), {
  override: undefined,
  enabled: false,
});
const emit = defineEmits<{
  back: [];
  patch: [patch: Partial<ToolOverride>];
  reset: [];
  'toggle-enabled': [];
}>();

const descEl = ref<HTMLTextAreaElement | null>(null);
const descDraft = ref('');
const timeoutDraft = ref('');
const paramDescDraft = ref<Record<string, string>>({});
const paramDefaultDraft = ref<Record<string, string>>({});
const paramError = ref<Record<string, string>>({});

const params = computed(() => toolParamList(props.tool.parameters));
const groupLabel = computed(() => toolGroupLabel(props.tool));
const isImage = computed(() => props.tool.group === 'image' || /image|生图/i.test(props.tool.name));
const isExternal = computed(() => props.tool.source === 'external');
/**
 * 来源标签：'底座' 或插件名（App.vue 用 plugins/registry.ts 的 toolOwnerLabel 打在 UiTool.owner 上）。
 * 界面不自己写死插件名 —— 工具归谁只有一个真相源。
 */
const sourceLabel = computed(() => {
  if (props.tool.source === 'external') return props.tool.origin ? 'URL' : '粘贴';
  return props.tool.owner || '底座';
});

/* ---------- 播种：props → 草稿 ---------- */

function builtinDescription() {
  return props.tool.model_description ?? '';
}

function builtinParamDescription(param: UiToolParam) {
  return param.description;
}

function builtinParamDefault(param: UiToolParam) {
  return param.has_default ? valueToText(param.default_value) : '';
}

function seed() {
  const override = props.override;
  descDraft.value = override?.description ?? builtinDescription();
  timeoutDraft.value = override?.timeout_ms === undefined ? '' : String(override.timeout_ms);
  const descs: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const param of params.value) {
    const customDesc = override?.param_descriptions?.[param.name];
    descs[param.name] = typeof customDesc === 'string' ? customDesc : builtinParamDescription(param);
    const customDefaults = override?.param_defaults;
    defaults[param.name] =
      customDefaults && Object.prototype.hasOwnProperty.call(customDefaults, param.name)
        ? valueToText(customDefaults[param.name])
        : builtinParamDefault(param);
  }
  paramDescDraft.value = descs;
  paramDefaultDraft.value = defaults;
  paramError.value = {};
}

watch(() => [props.tool, props.override, params.value] as const, seed, { immediate: true, deep: true });

/* ---------- 有没有改过（看草稿跟内置默认的差） ---------- */

const descriptionEdited = computed(() => descDraft.value !== builtinDescription());

const paramsEdited = computed(() =>
  params.value.some(
    param =>
      (paramDescDraft.value[param.name] ?? '') !== builtinParamDescription(param) ||
      (paramDefaultDraft.value[param.name] ?? '') !== builtinParamDefault(param),
  ),
);

const timeoutEdited = computed(
  () => timeoutDraft.value.trim() !== (props.tool.timeout_ms === undefined ? '' : String(props.tool.timeout_ms)),
);

const edited = computed(
  () => overrideEdited(props.override) || descriptionEdited.value || paramsEdited.value || timeoutEdited.value,
);

/* ---------- 提示词 ---------- */

/** 让 textarea 跟着内容长，不做内嵌小滚动区 */
function grow() {
  const el = descEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

onMounted(() => {
  void nextTick(grow);
});

watch(descDraft, () => {
  void nextTick(grow);
});

function onDescriptionInput() {
  emit('patch', { description: descDraft.value });
  void nextTick(grow);
}

function clearDescription() {
  descDraft.value = builtinDescription();
  emit('patch', { description: undefined });
}

/* ---------- 参数 ---------- */

function defaultPlaceholder(param: UiToolParam) {
  return param.has_default ? '（内置默认：' + valueToText(param.default_value) + '）' : '（没有默认值）';
}

function onParamDescChange(name: string) {
  emit('patch', { param_descriptions: { [name]: paramDescDraft.value[name] ?? '' } });
}

function onParamDefaultChange(param: UiToolParam) {
  const text = paramDefaultDraft.value[param.name] ?? '';
  const next = { ...paramError.value };
  if (text.trim() === '') {
    delete next[param.name];
    paramError.value = next;
    emit('patch', { param_defaults: { [param.name]: undefined } });
    return;
  }
  const parsed = textToValue(text, param.type);
  if (!parsed.ok) {
    next[param.name] = '这不是合法的 ' + param.type + '，没保存（改对了会自动存）';
    paramError.value = next;
    return;
  }
  delete next[param.name];
  paramError.value = next;
  emit('patch', { param_defaults: { [param.name]: parsed.value } });
}

function clearParams() {
  const descs: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const param of params.value) {
    descs[param.name] = builtinParamDescription(param);
    defaults[param.name] = builtinParamDefault(param);
  }
  paramDescDraft.value = descs;
  paramDefaultDraft.value = defaults;
  paramError.value = {};
  emit('patch', { param_descriptions: {}, param_defaults: {} });
}

/* ---------- 调用：超时 ---------- */

function onTimeoutChange() {
  const text = timeoutDraft.value.trim();
  if (text === '') {
    emit('patch', { timeout_ms: undefined });
    return;
  }
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return;
  emit('patch', { timeout_ms: Math.round(num) });
}

function clearTimeout() {
  timeoutDraft.value = props.tool.timeout_ms === undefined ? '' : String(props.tool.timeout_ms);
  emit('patch', { timeout_ms: undefined });
}

/* ---------- 恢复默认 ---------- */

function reset() {
  const label = props.tool.title || props.tool.name;
  if (!confirm('把「' + label + '」的改动全部恢复成内置默认？')) return;
  emit('reset');
  seed();
}
</script>
