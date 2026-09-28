<template>
  <div class="cx-mrow" :class="{ off: !msg.enabled, ro: locked }" @click="onRowClick">
    <span class="cx-grip" :title="locked ? '内置预设只读 —— 想改先另存为一份' : '拖动排序（这一版先用 ⇅ 按钮）'">⠿</span>
    <span v-if="isMessage" class="cx-rl" :class="msg.role">{{ roleLabel(msg.role) }}</span>
    <span v-else class="cx-rl special">SPEC</span>
    <span class="cx-enm">{{ label }}</span>
    <span v-if="locked" class="cx-tag">{{ msg.enabled ? '开' : '关' }}</span>
    <Sw v-else :model-value="msg.enabled" @update:model-value="emit('toggle')" />
    <template v-if="!locked">
      <button class="cx-rb" type="button" title="上移（已是首行则下移）" @click.stop="emit('move')">⇅</button>
      <button v-if="isMessage" class="cx-rb" type="button" title="编辑这条消息" @click.stop="emit('edit')">✎</button>
      <button class="cx-rb dang" type="button" title="删掉这一条" @click.stop="emit('remove')">✕</button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { roleLabel, SPECIAL_KIND_LABELS, type PresetItem, type PresetMessage } from '../core/types.ts';
import Sw from './Sw.vue';

/**
 * 预设本体的一行：普通消息（⠿ SYST 名称 开关 ⇅ ✎ ✕）
 * 或者特殊层（⠿ SPEC 名称 开关 ⇅ ✕ —— 特殊层没有正文，点行不弹编辑窗）。
 *
 * locked（B41 完整版）：内置预设的行**不给任何写入口** —— 开关 / ⇅ / ✎ / ✕ 全撤掉，
 * 点行也不弹编辑窗，只留一个「开 / 关」的**显示**标签。
 * 想改内置预设得先派生一份（拦截点在 SettingsView 的 ensureEditable，这里只负责不画按钮）。
 *
 * ⚠️ 属性名不能叫 readonly：它是 TS 的修饰符关键字，写成「readonly?: boolean」
 * 会被解析成「修饰符 + 缺属性名」直接报语法错（真踩过）。
 */
const props = withDefaults(defineProps<{ msg: PresetItem; index: number; locked?: boolean }>(), {
  locked: false,
});
const emit = defineEmits<{ edit: []; toggle: []; move: []; remove: [] }>();

/** 只读时点整行不算「编辑」（否则等于留了一条绕过按钮的暗门） */
function onRowClick(): void {
  if (props.locked) return;
  emit('edit');
}

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
