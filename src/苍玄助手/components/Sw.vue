<template>
  <span class="cx-sw" :class="{ on: modelValue }" role="switch" :aria-checked="modelValue" @click.stop="toggle"></span>
</template>

<script setup lang="ts">
/** 方形开关（设计稿里的 .sw）；点一下翻转，别的什么都不做 */
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

function toggle() {
  emit('update:modelValue', !props.modelValue);
}
</script>
