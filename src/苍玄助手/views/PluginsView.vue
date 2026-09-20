<template>
  <!-- 详情：整段让位（跟工具详情同一个做法），点「‹ 插件」回列表 -->
  <PluginDetail
    v-if="openDef"
    :def="openDef"
    :config="configOf(openDef)"
    :enabled="enabledOf(openDef)"
    :status="statusOf(openDef)"
    @back="openId = ''"
    @toggle="emit('toggle', openDef.id, $event)"
    @patch="emit('patch', openDef.id, $event)"
    @reset="emit('reset', openDef.id)"
    @goto="emit('goto', $event)"
  />

  <!-- 列表段：**只有列表**。一行一个插件，行尾 › 进这个插件自己的页面 -->
  <div v-else class="cx-body">
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">插件</span>
        <span class="cx-n">{{ PLUGIN_MANIFESTS.length }} 个 · 启用 {{ enabledCount }}</span>
        <span class="cx-spacer"></span>
      </div>
      <div class="cx-list">
        <div v-for="def in PLUGIN_MANIFESTS" :key="def.id" class="cx-toolrow" @click="openId = def.id">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">{{ def.name }}</span>
              <span class="cx-tag" :class="statusOf(def).kind">{{ statusOf(def).label }}</span>
            </div>
            <!-- 行上就写清「它加了什么」（1 页 · 7 工具），省一次点击 -->
            <div class="cx-toolrow-desc">{{ whatItAdds(def) }}</div>
          </div>
          <Sw :model-value="enabledOf(def)" @update:model-value="emit('toggle', def.id, $event)" />
          <span class="cx-toolrow-go">›</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { GenImageConfigSchema, RootDataSchema, type GenImageConfig, type RootData } from '../core/types.ts';
import PluginDetail from '../components/PluginDetail.vue';
import Sw from '../components/Sw.vue';
import { PLUGIN_MANIFESTS, pluginEnabled, pluginStatus } from '../plugins/registry.ts';
import type { PluginManifest } from '../plugins/types.ts';

/**
 * 插件页（能力页的第三段：工具｜技能｜插件）。**注册表驱动**：
 * 列表 / 状态 / 启停 / 设置了什么全部来自 plugins/registry.ts 的 PLUGIN_MANIFESTS 与聚合函数，
 * 界面不写死任何插件名、也不自己算「缺什么」。
 *
 * 这一页的规矩（设计稿 v2 / 设计自查 A7）：
 *  - **列表就是列表**：名字 · 状态 · 来源版本与「它加了什么」· 快捷开关 · ›，一行一件事，不给任何插件开小灶；
 *    页面上不放分工说明、不放「还没做」、不放某个插件的工具清单。
 *  - **点一行进这个插件自己的管理页**（PluginDetail）：头部 / 它加了什么 / 它自己的设置。
 *  - 为什么插件要单独一段：一个插件的设置（API Key / 模型 / 采样器）不是「某个工具的参数」，
 *    塞进工具详情的固定骨架会把它撑爆；工具段那边只保留「这个工具给模型看什么、能不能用」。
 *
 * 写路径唯一：这一页只 emit，数据由 App.vue 交给 store
 * （开关 → setPluginEnabled；设置 → setPluginConfig；恢复默认 → resetPluginConfig）。
 */
const props = withDefaults(defineProps<{ data?: RootData }>(), {
  data: () => RootDataSchema.parse({}),
});
const emit = defineEmits<{
  /** 插件开关：写 plugin_state（App.vue → store.setPluginEnabled） */
  toggle: [id: string, enabled: boolean];
  /** 插件自己的设置：写 plugins.<id>（App.vue → store.setPluginConfig，enabled 不走这条路） */
  patch: [id: string, patch: Record<string, unknown>];
  reset: [id: string];
  /** 「它加了什么」点一行跳过去（页面 id / 'capability'） */
  goto: [id: string];
}>();

const openId = ref('');

const openDef = computed<PluginManifest | null>(
  () => PLUGIN_MANIFESTS.find(item => item.id === openId.value) ?? null,
);

/** 这个插件自己那段设置（plugins 数据里的同名那一段）；没设置过就是空对象 */
function configBag(id: string): Record<string, unknown> {
  const bag = props.data.plugins as unknown as Record<string, Record<string, unknown> | undefined>;
  return bag[id] ?? {};
}

/**
 * 详情页表单吃的是生图那份有真 schema 的设置；非生图插件现在还没有自己的字段
 * （详情页不画表单，只画「它加了什么」）。
 */
const EMPTY_IMAGE_CONFIG = GenImageConfigSchema.parse({});
function configOf(def: PluginManifest): GenImageConfig {
  return def.id === 'image' ? props.data.plugins.image : EMPTY_IMAGE_CONFIG;
}

/** 开关的唯一读法：plugin_state 里有就听它的，没有就用 manifest.defaultEnabled */
function enabledOf(def: PluginManifest): boolean {
  return pluginEnabled(props.data, def.id);
}

/** 状态标签只有一份口径（未启用 > 插件自己说的缺什么 > 已启用），插件自己算、底座只画 */
function statusOf(def: PluginManifest): { label: string; kind: '' | 'ok' | 'warn' | 'dang' } {
  return pluginStatus(props.data, def.id, configBag(def.id));
}

/** 行上的「它加了什么」：内置 · v0.1 · 1 页 · 7 工具 */
function whatItAdds(def: PluginManifest): string {
  const parts = [def.builtin ? '内置' : '外部', 'v' + def.version];
  const pages = def.contributes.pages?.length ?? 0;
  const tools = def.contributes.tools?.length ?? 0;
  if (pages > 0) parts.push(pages + ' 页');
  if (tools > 0) parts.push(tools + ' 工具');
  if (pages === 0 && tools === 0) parts.push('没有贡献');
  return parts.join(' · ');
}

const enabledCount = computed(() => PLUGIN_MANIFESTS.filter(def => enabledOf(def)).length);
</script>
