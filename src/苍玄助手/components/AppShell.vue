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
      <button class="cx-kebab" type="button" title="收起面板" @click="emit('close')">✕</button>
    </div>
    <div class="cx-seg">
      <span
        v-for="page in pages"
        :key="page.id"
        :class="{ on: page.id === tab }"
        @click="emit('update:tab', page.id)"
      >{{ page.title }}</span>
    </div>
    <!--
      内容区：**这里就是唯一的滚动容器**（.cx-pane 在 global.css 里给了 flex:1 + min-height:0 + overflow:auto）。

      阶段 3.5 重估（task-15）：
      本组件原来写着「视图各自负责 .cx-body，**不要在这外面再套一层滚动容器**」——
      那条约定是给「自适应高度的 iframe」定的：iframe 里不能自己锁高度，只能让文档流一直长。
      现在宿主是 #extensions_settings2 里的普通 div（src/extension/index.ts + mount.ts），
      面板浮层有固定最大高度，所以**必须**有滚动容器，否则内容会顶出面板外、被裁掉。
      视图层不用改：.cx-body 现在当「内容区」用（自己不再滚），滚动统一由 .cx-pane 承担。
    -->
    <div class="cx-pane">
      <slot></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

/**
 * 界面骨架：顶栏（标题 + 状态 + ⋯ + ✕）+ 页签药丸分段器 + 当前页。
 *
 * **页签从页面注册表来**（core/pages.ts + 各插件 manifest 的 contributes.pages，
 * 聚合在 plugins/registry.ts 的 availablePages）：本组件只画传进来的数组，
 * 不 import TAB_IDS / TAB_LABELS —— 那份写死的名单已经删掉（设计自查 A9）。
 *
 * 约定：各视图只管「内容」（.cx-body）与「底部按钮」（.cx-foot / .cx-composer）；
 * **滚动容器由本组件提供**（.cx-pane），视图不要再自己锁高度 / 再套一层滚动 —— 见上面注释。
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
    title: '酒馆工坊Agent',
    status: '● 已连接',
  },
);
const emit = defineEmits<{ 'update:tab': [tab: string]; close: [] }>();

const menuOpen = ref(false);

function toggleLight() {
  document.body.classList.toggle('qx-light');
  menuOpen.value = false;
}

onBeforeUnmount(() => {
  document.body.classList.remove('qx-light');
});
</script>
