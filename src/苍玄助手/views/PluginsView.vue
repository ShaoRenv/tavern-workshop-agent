<template>
  <!-- 详情：整段让位（跟工具详情同一个做法），点「‹ 插件」回列表 -->
  <PluginDetail
    v-if="openDef"
    :def="openDef"
    :config="configBag(openDef.id)"
    :enabled="enabledOf(openDef)"
    :status="statusOf(openDef)"
    :skip="skipOf(openDef) ?? null"
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
            <!--
              ★ 缺能力时**在行上**给一句人话原因（P4-12）。

              为什么非要在这一行说、而不是让用户点进详情看：
              「缺能力」只回答了「它能不能用」，没回答「缺什么、我该怎么办」——
              不说原因的话，这行和以前那句「已启用」一样对用户没用。
              点一下展开完整明细（含缺的接口名与 ST 原生对应），不用进详情页来回翻。
            -->
            <div v-if="skipOf(def)" class="cx-toolrow-desc">
              <span class="cx-warn-text" @click.stop="toggleReason(def.id)">
                {{ skipOf(def).reason }}
                <span class="cx-hint">{{ openReason === def.id ? '收起' : '详情' }}</span>
              </span>
              <pre v-if="openReason === def.id" class="cx-code cx-mt6" @click.stop>{{ skipOf(def).detail }}</pre>
            </div>
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

import { RootDataSchema, type RootData } from '../core/types.ts';
import PluginDetail from '../components/PluginDetail.vue';
import Sw from '../components/Sw.vue';
import { PLUGIN_MANIFESTS, pluginCapabilitySkips, pluginEnabled, pluginStatusWithCapabilities } from '../plugins/registry.ts';
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

/** 开关的唯一读法：plugin_state 里有就听它的，没有就用 manifest.defaultEnabled */
function enabledOf(def: PluginManifest): boolean {
  return pluginEnabled(props.data, def.id);
}

/**
 * ★ 状态标签 = **装载裁决的口径**（未启用 > 缺能力 > 插件自己说的 > 已启用）。
 *
 * ⚠️ 这里用 `pluginStatusWithCapabilities` 而不是 `pluginStatus`（P4-12 修的就是这个）：
 * 后者**不看能力**，于是「插件被能力闸拦下、页面与工具全不出」时，列表行仍然显示「已启用」——
 * 界面替底层撒谎。同一个根因的另一面：这一页的 `whatItAdds()` 数的是 manifest 里声明的
 * 页数 / 工具数，**声明归声明**；缺能力时那些东西其实一个都没装载。
 *
 * 为什么把「探能力」的结果**算一次缓存起来**，而不是在模板里每行现算：
 * `pluginStatusWithCapabilities` 会调 `pluginCapabilitySkips()`，后者要遍历**全部**已启用插件、
 * 逐个现探能力（`evaluatePluginCapabilities`）。模板里 `statusOf(def)` 是**每行调一次**，
 * 于是 N 行 = N 次全表探测 —— O(N²)。
 *
 * 实测（4 个插件的当下）：`pluginStatus` 单次渲染 0.001ms，带能力的 0.216ms（约 200 倍）。
 * 4 个插件时绝对值仍很小，但**这是 O(N²) 的形状**：插件变多、或将来能力探测变重
 * （外部插件要真去探网络能力）就会变成可感的卡顿。所以用 computed 把它压成**每次数据变化只探一遍**。
 * （这也是当初没直接用它的合理顾虑 —— 现在用「算一次」把它解决了，而不是继续不用。）
 */
const skipById = computed(() => new Map(pluginCapabilitySkips(props.data).map(skip => [skip.id, skip])));

/** 这台是不是「开着但被能力闸拦下」（列表与详情共用同一份判据） */
function skipOf(def: PluginManifest) {
  return skipById.value.get(def.id);
}

function statusOf(def: PluginManifest): { label: string; kind: '' | 'ok' | 'warn' | 'dang' } {
  return pluginStatusWithCapabilities(props.data, def.id, configBag(def.id));
}

/**
 * 缺能力的**人话原因**（列表行上直接显示，点一下能看全部明细）。
 *
 * 为什么不只显示「缺能力」三个字：用户看到「缺能力」但不知道缺什么、更不知道怎么办 ——
 * 那和「已启用」一样没用。`skip.reason` 是装配期就算好的人话（含能力名），
 * `skip.detail` 是逐条明细（含缺的接口名与 ST 原生对应），两个都是现成的。
 */
const openReason = ref('');

function toggleReason(id: string): void {
  openReason.value = openReason.value === id ? '' : id;
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