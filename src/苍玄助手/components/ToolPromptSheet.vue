<template>
  <Sheet :title="'改提示词 · ' + (tool.title || tool.name)" @close="emit('close')">
    <template #head>
      <span class="cx-tag" :class="edited ? 'ok' : ''">{{ edited ? '已改过' : '默认' }}</span>
    </template>
    <div>
      <span class="cx-lab">提示词（模型看到的就是这段）</span>
      <textarea ref="el" v-model="draft" class="cx-mono cx-grow" placeholder="（内置默认还没暴露；填了就会盖住它）" @input="grow"></textarea>
      <p class="cx-hint cx-mt6">改完点「确定」；内容跟内置默认一样就等于没改，会把覆盖项清掉。</p>
      <p v-if="!tool.model_description" class="cx-hint cx-mt6 cx-warn-text">
        内核还没把内置默认说明暴露给界面（catalog() 里没有 model_description），这里空着 = 用内核里那份。
      </p>
    </div>
    <template #footer>
      <button class="cx-ghost dang" type="button" title="把输入框恢复成内置默认，点确定生效" @click="restoreDefault">恢复默认</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost dim" type="button" @click="emit('close')">取消</button>
      <button class="cx-ghost" type="button" @click="confirmEdit">确定</button>
    </template>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';

import type { ToolOverride } from '../core/ports.ts';
import Sheet from './Sheet.vue';
import type { UiTool } from './ui_types.ts';

/**
 * 列表行 ✎ 的快捷弹窗：只改「提示词」，不跳详情页。
 * 仍然是只 emit，写路径归 App.vue → store.setToolOverride。
 */
const props = defineProps<{ tool: UiTool; override?: ToolOverride }>();
const emit = defineEmits<{
  close: [];
  patch: [patch: Partial<ToolOverride>];
}>();

const el = ref<HTMLTextAreaElement | null>(null);
const draft = ref(props.override?.description ?? props.tool.model_description ?? '');

const edited = computed(() => draft.value !== (props.tool.model_description ?? ''));

function grow() {
  const node = el.value;
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = node.scrollHeight + 'px';
}

onMounted(() => {
  void nextTick(grow);
});

/** 只把输入框恢复成内置默认，点「确定」才真的提交（这样取消就是什么都不做） */
function restoreDefault() {
  draft.value = props.tool.model_description ?? '';
}

function confirmEdit() {
  if (!edited.value) emit('patch', { description: undefined });
  else emit('patch', { description: draft.value });
  emit('close');
}
</script>
