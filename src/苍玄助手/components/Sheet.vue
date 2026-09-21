<template>
  <div class="cx-backdrop" role="presentation"></div>
  <div ref="sheetEl" class="cx-sheet" role="dialog" :aria-label="title">
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
import { onBeforeUnmount, onMounted } from 'vue';

/**
 * 弹窗外壳（设计稿里的 .veil + .sheet）。
 *
 * ⚠️ 定位方式在阶段 3.5 翻案了 —— 这份注释原来写的是：
 *   「前端界面是高度跟着内容走的 iframe，用 position:fixed 居中会在长页面里弹到屏幕外」
 * 那个前提**不成立**：面板现在挂在 #extensions_settings2（酒馆页面里的普通 div），
 * 见 src/extension/index.ts 的 mountTarget() + src/苍玄助手/mount.ts 的 app.mount(container)。
 * 这里的 window / document **就是酒馆页面的**，不是自适应高度的 iframe，
 * 所以 position:fixed + 居中才是正确做法，也是 .cx-backdrop 原本就假设的那套参照系：
 *  - .cx-backdrop：fixed 全屏暗幕，把酒馆页面压暗
 *  - .cx-sheet：fixed 居中 + max-height 约束 + 内部滚动（CSS 在 global.css 的「弹窗」段）
 *
 * 这里保留的脚本只剩「按 Esc 关」：旧的 scrollIntoView 是为了迁就 iframe 而写的，现在没用了。
 */
withDefaults(defineProps<{ title?: string }>(), { title: '' });
const emit = defineEmits<{ close: [] }>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>
