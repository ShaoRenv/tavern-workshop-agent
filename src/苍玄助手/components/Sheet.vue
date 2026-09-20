<template>
  <div class="cx-backdrop"></div>
  <div ref="sheetEl" class="cx-sheet">
    <div class="cx-sh">
      <span class="cx-ttl">{{ title }}</span>
      <slot name="head"></slot>
      <button class="cx-kebab" type="button" title="关闭" @click="emit('close')">✕</button>
    </div>
    <div class="cx-sb">
      <slot></slot>
    </div>
    <div v-if="$slots.footer" class="cx-sf">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

/**
 * 弹窗外壳（设计稿里的 .veil + .sheet）。
 *
 * 注意：前端界面是「高度跟着内容走」的 iframe，用 position:fixed 居中会在长页面里
 * 弹到屏幕外。所以这里拆成两半：
 *  - .cx-backdrop：fixed 全屏暗幕，只负责变暗，不参与布局（pointer-events:none）
 *  - .cx-sheet：在文档流里，打开时滚到用户当前视野（scrollIntoView nearest）
 */
withDefaults(defineProps<{ title?: string }>(), { title: '' });
const emit = defineEmits<{ close: [] }>();
const sheetEl = ref<HTMLElement | null>(null);

onMounted(() => {
  void nextTick(() => sheetEl.value?.scrollIntoView({ block: 'nearest' }));
});
</script>
