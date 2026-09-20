<template>
  <!-- 只有一条：不折，直接一行 -->
  <ToolCard v-if="calls.length === 1" :call="calls[0]" @retry="emit('retry', $event)" />

  <!-- 连续多条：跑动中一条条冒出来，跑完这一段收起成一行 -->
  <div v-else class="cx-tgroup">
    <div class="cx-tc" :class="{ open }" @click="toggle">
      <span class="cx-cv">▶</span>
      <span>{{ calls.length }} 次工具调用</span>
      <span v-if="failedCount" class="cx-del">· {{ failedCount }} 失败</span>
      <span class="cx-spacer"></span>
      <span class="cx-tc-hint">{{ open ? '收起' : '展开' }}</span>
    </div>
    <div v-if="open" class="cx-tc-body">
      <ToolCard v-for="call in calls" :key="call.id" :call="call" @retry="emit('retry', $event)" />
    </div>
    <!-- 折叠时生图卡也照样展开：图不能被藏起来 -->
    <div v-else-if="imageCalls.length" class="cx-tc-body">
      <ToolCard v-for="call in imageCalls" :key="call.id" :call="call" @retry="emit('retry', $event)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ToolCall } from '../core/types.ts';
import ToolCard from './ToolCard.vue';
import { isImageCall } from './tool_kind.ts';

/**
 * 一轮里的连续工具调用。
 *
 * 折叠规则（真机反馈那两条）：
 *  - 跑动中**不折**：一条条实时冒出来，能看见它在干活
 *  - 这一轮跑完（running 由 true 变 false）才把最后这一段收起成「▸ N 次工具调用」
 *  - 失败了就不自动收起（把错藏起来更糟），摘要行上也会写「· N 失败」
 *  - 生图卡永远展开
 */
const props = defineProps<{ calls: ToolCall[]; running: boolean; isLast: boolean }>();
const emit = defineEmits<{ retry: [call: ToolCall] }>();

/** 用户手动点过就听用户的；没点过：跑动中展开、跑完收起 */
const manual = ref<boolean | null>(null);
const imageCalls = computed(() => props.calls.filter(call => isImageCall(call)));
const failedCount = computed(() => props.calls.filter(call => !call.ok).length);
const open = computed(() => manual.value ?? (props.running || failedCount.value > 0));

watch(
  () => props.running,
  (now, before) => {
    // 刚跑完的这一段恢复默认（收起）；老的段落保留用户自己展开的状态
    if (before && !now && props.isLast) manual.value = null;
  },
);

function toggle() {
  manual.value = !open.value;
}
</script>
