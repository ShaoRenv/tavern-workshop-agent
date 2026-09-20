<template>
  <!-- 详情：整段让位（跟工具详情同一个做法），点「‹ 插件」回列表 -->
  <PluginDetail
    v-if="openDef"
    :def="openDef"
    :config="config"
    @back="openId = ''"
    @patch="emit('patch', $event)"
    @reset="emit('reset')"
  />

  <!-- 列表段：**只有列表**。一行一个插件，行尾 › 进这个插件自己的页面 -->
  <div v-else class="cx-body">
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">插件</span>
        <span class="cx-n">{{ PLUGIN_DEFS.length }} 个 · 启用 {{ enabledCount }}</span>
        <span class="cx-spacer"></span>
      </div>
      <div class="cx-list">
        <div v-for="def in PLUGIN_DEFS" :key="def.id" class="cx-toolrow" @click="openId = def.id">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">{{ def.name }}</span>
              <span class="cx-tag" :class="statusOf(def).kind">{{ statusOf(def).label }}</span>
            </div>
            <div class="cx-toolrow-desc">{{ sourceOf(def) }} · v{{ def.version }}</div>
          </div>
          <Sw :model-value="configOf(def).enabled" @update:model-value="setEnabled(def, $event)" />
          <span class="cx-toolrow-go">›</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';

import type { GenImageConfig, RootData } from '../core/types.ts';
import { GenImageConfigSchema, IMAGE_SOURCE_LABELS } from '../core/types.ts';
import PluginDetail from '../components/PluginDetail.vue';
import Sw from '../components/Sw.vue';
import { PLUGIN_DEFS, imagePluginStatus, type PluginDef } from '../plugins/registry.ts';

/**
 * 插件页（能力页的第三段：工具｜技能｜插件）。
 *
 * 这一页的规矩（设计稿 v2）：
 *  - **列表就是列表**：图标 · 名字 · 状态 · 来源与版本 · 快捷开关 · ›，一行一件事，不给任何插件开小灶；
 *    页面上不放分工说明、不放「还没做」、不放某个插件的工具清单。
 *  - **点一行进这个插件自己的页面**（PluginDetail），那里只有它自己的设置。
 *  - 为什么插件要单独一段：一个插件的设置（API Key / 模型 / 采样器）不是「某个工具的参数」，
 *    塞进工具详情的固定骨架会把它撑爆；工具段那边只保留「这个工具给模型看什么、能不能用」。
 *
 * 写路径唯一：这一页只 emit，数据由 App.vue 交给 store.setPluginConfig / resetPluginConfig。
 */
const props = withDefaults(defineProps<{ data?: RootData }>(), { data: undefined });
const emit = defineEmits<{
  patch: [patch: Partial<GenImageConfig>];
  reset: [];
}>();

const data = toRef(props, 'data');
const openId = ref('');

/** 这一版只有生图一个插件；列表、状态、启停都按它来 */
const config = computed<GenImageConfig>(() =>
  data.value ? data.value.plugins.image : GenImageConfigSchema.parse({}),
);

const openDef = computed<PluginDef | null>(() => PLUGIN_DEFS.find(item => item.id === openId.value) ?? null);

function configOf(_def: PluginDef): GenImageConfig {
  return config.value;
}

function statusOf(_def: PluginDef) {
  return imagePluginStatus(config.value);
}

function sourceOf(_def: PluginDef): string {
  return IMAGE_SOURCE_LABELS[config.value.source] ?? 'NovelAI';
}

function setEnabled(_def: PluginDef, value: boolean): void {
  emit('patch', { enabled: value });
}

const enabledCount = computed(() => (config.value.enabled ? 1 : 0));
</script>
