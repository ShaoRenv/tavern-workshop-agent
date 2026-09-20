<template>
  <div class="flex flex-col gap-3">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-baseline gap-2">
        <h1 class="text-[15px] font-bold tracking-wide">苍玄界 · 立绘提示词工坊</h1>
        <span class="text-[11px] text-[var(--cx-muted)]">立绘元数据 → 角色预设 · 世界书生成</span>
      </div>
      <nav class="flex flex-wrap gap-1">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="cx-btn"
          :style="store.data.settings.active_tab === tab.id ? activeStyle : undefined"
          @click="store.data.settings.active_tab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <GalleryView v-if="activeTab === 'gallery'" />
    <PortraitsView v-else-if="activeTab === 'portraits'" />
    <WorldbookView v-else-if="activeTab === 'worldbook'" />
    <PresetsView v-else />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useWorkshopStore } from './stores/workshop.ts';
import GalleryView from './views/GalleryView.vue';
import PortraitsView from './views/PortraitsView.vue';
import WorldbookView from './views/WorldbookView.vue';
import PresetsView from './views/PresetsView.vue';

const store = useWorkshopStore();

const TABS = [
  { id: 'gallery', label: '① 立绘图库' },
  { id: 'portraits', label: '② 打包导出' },
  { id: 'worldbook', label: '③ 世界书' },
  { id: 'presets', label: '④ 预设与模板' },
];

const activeTab = computed(() => store.data.settings.active_tab);
const activeStyle = { background: 'rgba(139, 92, 246, 0.42)', borderColor: 'var(--cx-accent)' };
</script>

<style lang="scss" scoped></style>
