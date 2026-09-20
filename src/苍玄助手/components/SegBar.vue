<template>
  <div :class="variant === 'mode' ? 'cx-modebar' : 'cx-seg'">
    <span
      v-for="item in items"
      :key="item.value"
      :class="[variant === 'mode' ? 'm' : '', spanClass(item)]"
      @click="pick(item.value)"
      >{{ item.label }}</span
    >
  </div>
</template>

<script setup lang="ts">
import type { SegItem } from './ui_types.ts';

/**
 * 药丸分段器。
 *  - variant='seg'：顶部五个页签那种（.cx-seg）
 *  - variant='mode'：Agent｜聊天、System｜User｜AI 那种（.cx-modebar）
 */
const props = withDefaults(defineProps<{ modelValue: string; items: SegItem[]; variant?: 'seg' | 'mode' }>(), {
  variant: 'seg',
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function pick(value: string) {
  emit('update:modelValue', value);
}

function spanClass(item: SegItem) {
  const on = item.value === props.modelValue;
  return { on, off: props.variant === 'mode' && !on };
}
</script>
