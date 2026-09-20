<template>
  <div class="cx-root">
    <div class="cx-bar">
      <span class="cx-ttl">{{ title }}</span>
      <span class="cx-st">{{ status }}</span>
      <span class="cx-spacer"></span>
      <div class="cx-menu-wrap">
        <button class="cx-kebab" type="button" title="更多" @click="menuOpen = !menuOpen">⋯</button>
        <div v-if="menuOpen" class="cx-menu">
          <button class="cx-menu-i" type="button" @click="toggleLight">深浅色切换</button>
        </div>
      </div>
    </div>
    <div class="cx-seg">
      <span
        v-for="page in pages"
        :key="page.id"
        :class="{ on: page.id === tab }"
        @click="emit('update:tab', page.id)"
      >{{ page.title }}</span>
    </div>
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

/**
 * 界面骨架：顶栏（标题 + 状态 + ⋯）+ 页签药丸分段器 + 当前页。
 *
 * **页签从页面注册表来**（core/pages.ts + 各插件 manifest 的 contributes.pages，
 * 聚合在 plugins/registry.ts 的 availablePages）：本组件只画传进来的数组，
 * 不 import TAB_IDS / TAB_LABELS —— 那份写死的名单已经删掉（设计自查 A9）。
 *
 * 约定：各视图各自负责「内容区 (.cx-body)」和「底部按钮 (.cx-foot / .cx-composer)」，
 * 所以 <slot/> 里的视图必须是本组件的直接内容（不要在这外面再套一层滚动容器）。
 */
withDefaults(
  defineProps<{
    /** 能上顶栏的页面（已按 order 排好） */
    pages: { id: string; title: string }[];
    /** 当前页 id（active_tab） */
    tab: string;
    title?: string;
    status?: string;
  }>(),
  {
    title: '苍玄助手',
    status: '● 已连接',
  },
);
const emit = defineEmits<{ 'update:tab': [tab: string] }>();

const menuOpen = ref(false);

function toggleLight() {
  document.body.classList.toggle('qx-light');
  menuOpen.value = false;
}

onBeforeUnmount(() => {
  document.body.classList.remove('qx-light');
});
</script>
