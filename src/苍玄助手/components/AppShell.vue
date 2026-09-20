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
      <span v-for="id in TAB_IDS" :key="id" :class="{ on: id === tab }" @click="emit('update:tab', id)">{{ TAB_LABELS[id] }}</span>
    </div>
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

import { TAB_IDS, type TabId } from '../core/types.ts';
import { TAB_LABELS } from './ui_types.ts';

/**
 * 界面骨架：顶栏（标题 + 状态 + ⋯）+ 五个页签的药丸分段器 + 当前页。
 *
 * 约定：五个视图各自负责「内容区 (.cx-body)」和「底部按钮 (.cx-foot / .cx-composer)」，
 * 所以 <slot/> 里的视图必须是本组件的直接内容（不要在这外面再套一层滚动容器）。
 */
withDefaults(defineProps<{ tab: TabId; title?: string; status?: string }>(), {
  title: '苍玄助手',
  status: '● 已连接',
});
const emit = defineEmits<{ 'update:tab': [tab: TabId] }>();

const menuOpen = ref(false);

function toggleLight() {
  document.body.classList.toggle('qx-light');
  menuOpen.value = false;
}

onBeforeUnmount(() => {
  document.body.classList.remove('qx-light');
});
</script>
