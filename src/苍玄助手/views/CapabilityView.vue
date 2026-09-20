<template>
  <div class="cx-body">
    <!-- 二级导航：工具｜技能（沿用 SegBar 切内容，不做内嵌滚动区） -->
    <div class="cx-blk cx-pb10">
      <SegBar v-model="seg" :items="SEG_ITEMS" variant="mode" class="cx-modebar-grow" />
    </div>

    <div class="cx-capbody">
      <!-- 工具详情：整段让位给详情页，点「← 返回」回列表 -->
      <ToolDetail
        v-if="seg === 'tools' && openTool"
        :tool="openTool"
        :override="openToolOverride"
        :enabled="toolOn(openTool)"
        :follows-global="followsGlobal"
        @back="closeToolDetail"
        @patch="onToolPatch"
        @reset="onToolReset"
        @toggle-enabled="toggleTool(openTool)"
      />

      <!-- 工具段：一行一个，点进去改提示词 / 参数 / 超时 / 停用 -->
      <div v-else-if="seg === 'tools'" class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">工具</span>
          <span class="cx-n">{{ toolRows.length }} 个 · 已改 {{ editedToolCount }}</span>
          <span class="cx-spacer"></span>
          <span class="cx-hint">点一行改它的提示词</span>
        </div>
        <div class="cx-list">
          <div v-for="tool in toolRows" :key="tool.name" class="cx-toolrow" @click="openToolDetail(tool.name)">
            <div class="cx-toolrow-main">
              <div class="cx-toolrow-name">
                <span class="cx-tn2">{{ tool.title || tool.name }}</span>
                <!-- 来源标签（插件化之后最重要的一条可读性）：底座 / 世界书 / 生图 / … -->
                <span class="cx-tag">{{ tool.owner || '底座' }}</span>
                <span v-if="tool.user_initiated_only" class="cx-tag warn">仅明确要求时用</span>
                <span v-if="tool.missing" class="cx-tag dang">内核里没有</span>
                <span class="cx-tag" :class="toolEdited(tool.name) ? 'ok' : ''">{{ toolEdited(tool.name) ? '已改过' : '默认' }}</span>
              </div>
              <div class="cx-toolrow-desc">{{ tool.desc || '（内核还没给一句话说明）' }}</div>
            </div>
            <button class="cx-iconbtn" type="button" title="只改提示词" @click.stop="openToolPrompt(tool.name)">✎</button>
            <span class="cx-toolrow-go">›</span>
          </div>
        </div>
        <p v-if="toolRows.length === 0" class="cx-hint">工具清单还没就绪：agent 内核注册好工具后会自动出现在这里。</p>
        <p class="cx-hint cx-mt10">
          点一行进详情：改提示词、参数说明、参数默认值、单次超时。
          用不用某个工具由两级决定：「能力」页是全局默认（这里管）；预设里打开「单独启用预设能力」后，才由「设置 · 预设」那份勾选管。
        </p>
      </div>

      <!-- 插件段：插件库（列表 + 详情）。插件自带工具，设置（Key / 模型 / 采样器）不进工具详情 -->
      <PluginsView
        v-else-if="seg === 'plugins'"
        :data="data"
        @toggle="onPluginToggle"
        @patch="onPluginPatch"
        @reset="onPluginReset"
        @goto="emit('goto', $event)"
      />

      <!-- 技能段：技能库 + 编辑弹窗 + 参考文件弹窗（原技能页整体纳入） -->
      <SkillsView
        v-else-if="seg === 'skills'"
        :data="data"
        @save="emit('save', $event)"
        @delete="emit('delete', $event)"
        @duplicate="emit('duplicate', $event)"
        @export="emit('export', $event)"
        @toggle="emit('skill-toggle', $event)"
        @change="emit('change')"
      />
    </div>
  </div>

  <!-- 列表行 ✎：只改提示词的快捷弹窗 -->
  <ToolPromptSheet
    v-if="quickTool"
    :key="quickToolName"
    :tool="quickTool"
    :override="quickToolOverride"
    @close="closeToolPrompt"
    @patch="onQuickPatch"
  />
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';

import type { ToolOverride } from '../core/ports.ts';
import { RootDataSchema, type RootData, type Skill } from '../core/types.ts';
import SegBar from '../components/SegBar.vue';
import ToolDetail from '../components/ToolDetail.vue';
import ToolPromptSheet from '../components/ToolPromptSheet.vue';
import type { SegItem, UiTool } from '../components/ui_types.ts';
import { overrideEdited, readToolOverride } from '../components/ui_types.ts';
import { toolOwnerLabel } from '../plugins/registry.ts';
import PluginsView from './PluginsView.vue';
import SkillsView from './SkillsView.vue';

/**
 * 能力页（原「技能」页扩容）：一个分段器，两段 ——
 *  - 工具：脚本内置工具库，点一行进详情改提示词 / 参数 / 超时 / 停用，行尾 ✎ 只弹提示词
 *  - 技能：整份技能库（列表 + 编辑弹窗 + 参考文件弹窗，复用 SkillsView）
 *
 * 归位原则（reports/苍玄助手-UI整理.md）：库只在这一个入口；
 * 「这个预设用哪些工具 / 技能」是**本次配置**，去设置页勾。所以工具行上不再挂预设勾选开关。
 *
 * 覆盖项仍然只读（data.tool_overrides）：写路径唯一 —— emit 给 App.vue → store.setToolOverride。
 */
const props = withDefaults(
  defineProps<{
    data?: RootData;
    tools?: UiTool[];
  }>(),
  {
    data: () => RootDataSchema.parse({}),
    tools: () => [],
  },
);
const emit = defineEmits<{
  /** 工具覆盖项改了（数据由 App.vue 写进 store；这条只是通知） */
  'tool-override': [name: string, patch: Partial<ToolOverride>];
  'tool-reset': [name: string];
  save: [skill: Skill];
  delete: [skillId: string];
  duplicate: [skill: Skill];
  export: [skill: Skill];
  /** 技能卡的启用开关：转发给 App.vue → store.updateSkill（那里会落盘） */
  'skill-toggle': [skill: Skill];
  /** 页面里直接改过 props.data（例如「在当前预设里启用」开关）之后发一次，App.vue 接成 store.save() */
  change: [];
  /** 插件开关（写路径唯一：App.vue → store.setPluginEnabled，状态在 plugin_state） */
  'plugin-toggle': [id: string, enabled: boolean];
  /** 插件设置改了（写路径唯一：App.vue → store.setPluginConfig(id, patch)） */
  'plugin-patch': [id: string, patch: Record<string, unknown>];
  'plugin-reset': [id: string];
  /** 插件详情「它加了什么」点一行跳过去（页面 id / 'capability'） */
  goto: [id: string];
}>();

/** 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，缓存普通对象引用会读到旧数据 */
const data = toRef(props, 'data');

const SEG_ITEMS: SegItem[] = [
  { value: 'tools', label: '工具' },
  { value: 'skills', label: '技能' },
  { value: 'plugins', label: '插件' },
];

const seg = ref('tools');

/* ---------- 工具：清单（内核 + 预设里已有的名字） ---------- */

const preset = computed(() => data.value.presets.find(item => item.id === data.value.active_preset_id) ?? null);

/** 当前预设跟随「能力」页的全局设置时，工具详情里的「在本预设里启用」开关不起作用（默认就是跟随） */
const followsGlobal = computed(() => !(preset.value?.use_global_caps ?? false));

/** 内核给的工具清单 + 预设里已有的工具名（内核没就绪时至少能看能改） */
const toolRows = computed<UiTool[]>(() => {
  const out: UiTool[] = [];
  const seen = new Set<string>();
  for (const tool of props.tools) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      out.push(tool);
    }
  }
  for (const name of preset.value?.tools ?? []) {
    if (!seen.has(name)) {
      seen.add(name);
      // 内核清单里没有（例如插件被关掉）：仍然给出来源标签，别让它看着像底座的工具
      out.push({ name, owner: toolOwnerLabel(name) });
    }
  }
  return out;
});

/** 详情页里那个「在当前预设里启用」开关读的就是它 */
function toolOn(tool: UiTool) {
  return preset.value?.tools.includes(tool.name) ?? false;
}

function toggleTool(tool: UiTool) {
  const item = preset.value;
  if (!item) return;
  const index = item.tools.indexOf(tool.name);
  if (index >= 0) item.tools.splice(index, 1);
  else item.tools.push(tool.name);
  // 直接改了 props.data：必须让 App.vue 落盘（全局 deep watch 已删）
  emit('change');
}

/* ---------- 工具：列表 + 覆盖项 ---------- */

const openToolName = ref('');
const quickToolName = ref('');
const openTool = computed<UiTool | null>(() => toolRows.value.find(item => item.name === openToolName.value) ?? null);
const quickTool = computed<UiTool | null>(() => toolRows.value.find(item => item.name === quickToolName.value) ?? null);
const quickToolOverride = computed<ToolOverride | undefined>(() => readToolOverride(data.value, quickToolName.value));
const openToolOverride = computed<ToolOverride | undefined>(() => readToolOverride(data.value, openToolName.value));
const editedToolCount = computed(
  () => toolRows.value.filter(item => overrideEdited(readToolOverride(data.value, item.name))).length,
);

function toolEdited(name: string) {
  return overrideEdited(readToolOverride(data.value, name));
}

function openToolDetail(name: string) {
  openToolName.value = name;
}

function closeToolDetail() {
  openToolName.value = '';
}

/** 覆盖项只读：写路径只有一条 —— emit 给 App.vue，由它调 store.setToolOverride / resetToolOverride */
function emitToolPatch(name: string, patch: Partial<ToolOverride>) {
  if (!name) return;
  emit('tool-override', name, patch);
}

function onToolPatch(patch: Partial<ToolOverride>) {
  emitToolPatch(openToolName.value, patch);
}

function onQuickPatch(patch: Partial<ToolOverride>) {
  emitToolPatch(quickToolName.value, patch);
}

/** 列表行的 ✎：只弹提示词，不进详情页 */
function openToolPrompt(name: string) {
  quickToolName.value = name;
}

function closeToolPrompt() {
  quickToolName.value = '';
}

function onToolReset() {
  const name = openToolName.value;
  if (!name) return;
  emit('tool-reset', name);
}

/* ---------- 插件段：只转发事件，写路径在 App.vue → store ---------- */

function onPluginToggle(id: string, enabled: boolean) {
  emit('plugin-toggle', id, enabled);
}

function onPluginPatch(id: string, patch: Record<string, unknown>) {
  emit('plugin-patch', id, patch);
}

function onPluginReset(id: string) {
  emit('plugin-reset', id);
}

/* ---------- 换段：把工具详情 / 快捷弹窗收回去，免得切回来还停在详情 ---------- */

watch(seg, () => {
  openToolName.value = '';
  quickToolName.value = '';
});
</script>
