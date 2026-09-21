<template>
  <div ref="rootEl" class="cx-toolpage">
    <!-- 1 头部：名字 / 来源 / 版本 / 状态 + 启用开关（每个插件都一样） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <button class="cx-back" type="button" @click="emit('back')">← 返回</button>
        <span class="cx-spacer"></span>
        <span class="cx-tag" :class="status.kind">{{ status.label }}</span>
      </div>
      <div class="cx-tpname">
        <span class="cx-tn2">{{ def.name }}</span>
        <span class="cx-tag">{{ def.builtin ? '内置' : '外部' }}</span>
        <span class="cx-tag">v{{ def.version }}</span>
      </div>
      <p class="cx-hint cx-mt6">{{ def.desc }}</p>
      <div class="cx-f cx-mt12">
        <div class="cx-frow">
          <span class="cx-sw-lab">启用</span>
          <Sw :model-value="enabled" @update:model-value="emit('toggle', $event)" />
        </div>
        <p class="cx-hint cx-mt6">关掉就完全不用它：它的页面与工具一起消失，模型也看不到。</p>
      </div>
    </div>

    <!-- 2 它加了什么：只放可点的跳转行（页面 / 工具），不写解释段落 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">它加了什么</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">点一行跳过去</span>
      </div>
      <div class="cx-list">
        <div v-for="page in pages" :key="page.id" class="cx-toolrow" @click="emit('goto', page.id)">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">页面：{{ page.title }}</span>
              <span v-if="page.inTabbar === false" class="cx-tag">不上顶栏</span>
            </div>
          </div>
          <span class="cx-toolrow-go">›</span>
        </div>
        <div v-if="tools.length" class="cx-toolrow" @click="emit('goto', 'capability')">
          <div class="cx-toolrow-main">
            <div class="cx-toolrow-name">
              <span class="cx-tn2">工具：{{ tools.join(' / ') }}</span>
              <span class="cx-tag">{{ tools.length }} 个</span>
            </div>
          </div>
          <span class="cx-toolrow-go">›</span>
        </div>
      </div>
      <p v-if="pages.length === 0 && tools.length === 0" class="cx-hint">这个插件现在没往注册表里贡献东西。</p>
    </div>

    <!--
      3 它自己的设置（阶段 4 起**声明式**）。

      这一块以前是**手写 HTML 的表单**（旧 56-343 行，9 个 <input>/<select>/<textarea> + 6 个 <Sw>）——
      每加一个插件就要再手写一遍，外部插件更没有 DOM 可写。
      现在插件只在 `contributes.settings` 里**声明字段**，由宿主的 `SettingsForm` 负责画：
       - 字段与块：`plugins/builtin/image/settings.ts`（加字段只改那一处）；
       - 渲染与"什么时候显示"：`components/SettingsForm.vue` + `settings_form.ts`；
       - 本文件只剩下「把声明和值喂进去 + 把改动转出去」，**一行表单代码都不许留**。

      值仍然只进不出：`config` 进、改动只 emit('patch')，写路径唯一在 App.vue → store。
      「恢复默认」现在由 SettingsForm 自己带（它按"跟默认值比"决定可不可点），只把 @reset 往上转。
      ⚠️ **旧版那个确认框没有丢**：它搬成了插件声明的 `SettingsSchema.resetConfirm`
      （生图那页有 API Key，一点就走会真丢东西），由宿主在 onReset 里弹；
      footer 下那句通用说明也由宿主统一画 —— 护栏跟着字段一起搬家，不能只搬控件。
    -->
    <SettingsForm
      v-if="settings.fields.length"
      :fields="settings.fields"
      :groups="settings.groups"
      :values="config"
      :reset-confirm="settings.resetConfirm"
      @patch="emit('patch', $event)"
      @reset="emit('reset')"
    />

    <!-- 没声明设置的插件：照旧一句话说清（这一版不是所有插件都有自己的字段） -->
    <div v-else class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">它自己的设置</span>
        <span class="cx-spacer"></span>
      </div>
      <div class="cx-placeholder">{{ def.name }} 现在没有自己的设置：它的活都在上面那些页面与工具里。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { SettingsSchema } from '../core/ports.ts';
import type { PluginManifest, PluginStatus } from '../plugins/types.ts';
import SettingsForm from './SettingsForm.vue';
import Sw from './Sw.vue';

/**
 * 插件管理页（设置 · 能力 · 插件 → ›）。**每个插件都是这三块**（设计稿屏 6）：
 *   1 头部（名字 / 来源 / 版本 / 状态 + 启用开关）
 *   2 它加了什么（页面 / 工具，点一行跳过去）—— 不写解释段落
 *   3 它自己的设置（**声明式**：插件的 `contributes.settings` + 宿主 SettingsForm）
 *
 * **这一页只管这个插件自己的设置**，不放别的东西：
 *  - 它提供哪些工具 → 工具段（那是工具的库）
 *  - 模型现在能不能用它 → 能力页全局 + 预设，不在这页
 *  - 试画 / 结果预览 → 不在这里，出图在对话页里自然显示
 *
 * 开关与设置是两条路（设计自查 A6 / §2.2）：enabled 存在 plugin_state 由底座拥有，
 * 这里只 emit('toggle')，不写进插件自己的设置；设置走 emit('patch')。
 * 写路径唯一（App.vue → store.setPluginEnabled / setPluginConfig / resetPluginConfig）。
 */
const props = defineProps<{
  def: PluginManifest;
  /**
   * 插件自己那段设置的**宽松袋子**（`plugins.<id>`）。
   *
   * 阶段 4 起不再收 `GenImageConfig`：字段契约是通用的 `SettingsValues`，
   * 本页不认识任何具体插件的键 —— 认识那些键的是插件自己的 `settings.ts`。
   */
  config: Record<string, unknown>;
  /** 开关在 plugin_state 里（底座拥有），不从 config 里读 */
  enabled: boolean;
  /** 状态标签由插件自己算（plugins/registry.ts 的 pluginStatus），界面只画 */
  status: PluginStatus;
}>();
const emit = defineEmits<{
  back: [];
  /** 启用开关（写路径：App.vue → store.setPluginEnabled） */
  toggle: [enabled: boolean];
  patch: [patch: Record<string, unknown>];
  reset: [];
  /** 「它加了什么」点一行跳过去（页面 id / 'capability'） */
  goto: [id: string];
}>();

const rootEl = ref<HTMLElement | null>(null);

/** 它加了什么：页面行 + 工具行（都来自 manifest 的 contributes） */
const pages = computed(() => props.def.contributes.pages ?? []);
/** contributes.tools 是 ToolDef[]（阶段 3 起）：界面只显示名字 */
const tools = computed(() => (props.def.contributes.tools ?? []).map(def => def.name));

/** 这个插件声明的设置（没有就是空 schema 兜底，界面画「它现在没有自己的设置」） */
const settings = computed<SettingsSchema>(() => props.def.contributes.settings ?? { fields: [] });
</script>
