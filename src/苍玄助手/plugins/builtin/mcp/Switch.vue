<template>
  <span class="cx-sw" :class="{ on: modelValue }" role="switch" :aria-checked="modelValue" @click.stop="toggle"></span>
</template>

<script setup lang="ts">
/**
 * 方形开关（样式用 global.css 里现成的 .cx-sw，不是新造的）。
 *
 * 为什么插件目录里自己带一个，而不是 import 宿主的 components/Sw.vue：
 * 插件目录要能**在没有宿主外壳源码的情况下成立** —— 将来外部插件是「一份自包含目录 + manifest」，
 * 拿不到宿主 components/ 里的组件。这条硬规矩有测试闸（plugin_stage3_contract 的「只许落在
 * core / agent / plugins」），worldbook/Page.vue 也是照它写的。
 *
 * 行为与宿主那个一致：点一下翻转，别的什么都不做。
 */
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

function toggle() {
  emit('update:modelValue', !props.modelValue);
}
</script>
