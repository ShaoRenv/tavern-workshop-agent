<template>
  <div class="cx-call">
    <div class="cx-cline" :class="{ open: open && !isImage, err: !call.ok, patch: isPatch, skill: isSkill }" @click="open = !open">
      <span class="cx-cv">▶</span>
      <span class="cx-tk">{{ icon }}</span>
      <span class="cx-tn">{{ call.name }}</span>
      <span v-if="argBrief" class="cx-ta">{{ argBrief }}</span>
      <span class="cx-tp">
        <span :class="call.ok ? 'cx-add' : 'cx-del'">{{ call.ok ? '✓' : '✗' }}</span>
        {{ call.brief }}
      </span>
    </div>

    <!-- 展开后的结果：失败和改动默认摊开，其余点开才看 -->
    <div v-if="showDetail" class="cx-cdetail">
      <template v-if="isPatch">
        <div v-for="(line, index) in lines" :key="index" :class="line.cls">{{ line.text }}</div>
      </template>
      <template v-else>{{ call.detail || call.brief || '（没有更多内容）' }}</template>
    </div>

    <!-- 生图卡：永远展开，图直接摆在对话里 -->
    <div v-if="isImage" class="cx-cimage">
      <div class="cx-gen" :class="{ full }">
        <img v-if="call.images.length" :src="call.images[0]" alt="生成的图" />
        <span v-else>生成的图（这里直接显示）</span>
      </div>
      <div class="cx-gmeta">
        <span>{{ call.images.length }} 张</span>
        <span>·</span>
        <span>{{ call.brief || '已完成' }}</span>
        <span class="cx-spacer"></span>
        <button class="cx-tiny" type="button" @click.stop="emit('retry', call)">重画</button>
        <button v-if="call.images.length" class="cx-tiny" type="button" @click.stop="full = !full">{{ full ? '收起' : '看原图' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ToolCall } from '../core/types.ts';
import { callArgBrief, callIcon, isImageCall, isPatchCall, isSkillCall, patchLines } from './tool_kind.ts';

/**
 * 一条工具调用 = 一行（约 28px，没有边框盒子）。
 *  - 淡淡底色，hover 才亮一点
 *  - 结果只在右边留一小段摘要（call.brief），参数列超出就省略号
 *  - 失败和改动默认摊开；生图永远摊开，图直接显示
 */
const props = defineProps<{ call: ToolCall }>();
const emit = defineEmits<{ retry: [call: ToolCall] }>();

const call = props.call;

const isImage = computed(() => isImageCall(call));
const isPatch = computed(() => isPatchCall(call));
const isSkill = computed(() => isSkillCall(call));
const icon = computed(() => callIcon(call));
const argBrief = computed(() => callArgBrief(call));
const lines = computed(() => patchLines(call.detail || call.brief || ''));

/** 失败 / 改动要自动摊开，免得错在折叠里看不见 */
const forced = computed(() => !call.ok || isPatch.value);
const open = ref(forced.value);
const full = ref(false);

watch(forced, value => {
  if (value) open.value = true;
});

const showDetail = computed(() => open.value && !isImage.value);
</script>
