<template>
  <div class="cx-mrow" :class="{ off: !msg.enabled }" @click="emit('edit')">
    <span class="cx-grip" title="拖动排序（这一版先用 ⇅ 按钮）">⠿</span>
    <span v-if="isMessage" class="cx-rl" :class="msg.role">{{ roleLabel(msg.role) }}</span>
    <span v-else class="cx-rl special">SPEC</span>
    <span class="cx-enm">{{ label }}</span>
    <Sw :model-value="msg.enabled" @update:model-value="emit('toggle')" />
    <button class="cx-rb" type="button" title="上移（已是首行则下移）" @click.stop="emit('move')">⇅</button>
    <button v-if="isMessage" class="cx-rb" type="button" title="编辑这条消息" @click.stop="emit('edit')">✎</button>
    <button class="cx-rb dang" type="button" title="删掉这一条" @click.stop="emit('remove')">✕</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { roleLabel, SPECIAL_KIND_LABELS, type PresetItem, type PresetMessage } from '../core/types.ts';
import Sw from './Sw.vue';

/**
 * 预设本体的一行：普通消息（⠿ SYST 名称 开关 ⇅ ✎ ✕）
 * 或者特殊层（⠿ SPEC 名称 开关 ⇅ ✕ —— 特殊层没有正文，点行不弹编辑窗）。
 */
const props = defineProps<{ msg: PresetItem; index: number }>();
const emit = defineEmits<{ edit: []; toggle: []; move: []; remove: [] }>();

/** 收窄成消息条目；不是消息（特殊层）就返回 null */
const message = computed<PresetMessage | null>(() => (props.msg.type === 'message' ? props.msg : null));
const isMessage = computed(() => message.value !== null);

const label = computed(() => {
  const msg = props.msg;
  if (msg.type === 'special') {
    const name = SPECIAL_KIND_LABELS[msg.kind] ?? msg.kind;
    return '特殊层 · ' + name + (msg.name && msg.name !== name ? '（' + msg.name + '）' : '');
  }
  return msg.name || '（未命名）';
});
</script>
