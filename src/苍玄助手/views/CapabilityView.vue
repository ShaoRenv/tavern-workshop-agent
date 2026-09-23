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
                <span v-if="tool.owner_disabled" class="cx-tag warn">来源已停用</span>
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
          用不用某个工具由两级决定：「能力 · 工具」段是全局默认（这里管）；预设里打开「单独启用预设能力」后，才由「预设」那份勾选管。
        </p>
      </div>

      <!-- 插件段：插件库（列表 + 详情）。插件自带工具，设置（Key / 模型 / 采样器）不进工具详情 -->
      <PluginsView
        v-else-if="seg === 'plugins'"
        :data="data"
        :external="external"
        @toggle="onPluginToggle"
        @patch="onPluginPatch"
        @reset="onPluginReset"
        @goto="onGoto"
        @external-install-url="emit('external-install-url', $event)"
        @external-install-paste="emit('external-install-paste', $event)"
        @external-uninstall="emit('external-uninstall', $event)"
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
import type { GotoSeg, SegItem, UiTool } from '../components/ui_types.ts';
import { overrideEdited, readToolOverride } from '../components/ui_types.ts';
import { buildToolRows } from '../components/tool_rows.ts';
import PluginsView from './PluginsView.vue';
import SkillsView from './SkillsView.vue';

/**
 * 「能力」段（设置 · 能力）：二级药丸 工具｜技能｜插件。
 *  - 工具：脚本内置工具库，点一行进详情改提示词 / 参数 / 超时 / 停用，行尾 ✎ 只弹提示词
 *  - 技能：整份技能库（列表 + 编辑弹窗 + 参考文件弹窗，复用 SkillsView）
 *  - 插件：插件库（列表 + 管理页，复用 PluginsView）
 *
 * 它**不再占一个页面**：设置页把它整段塞进「能力」那一格（阶段 2），所以这里的根节点只管内容，
 * 页面级的 .cx-body 由 SettingsView 提供。
 *
 * 归位原则（reports/苍玄助手-UI整理.md）：库只在这一个入口；
 * 「这个预设用哪些工具 / 技能」是**本次配置**，去「预设」段勾。所以工具行上不再挂预设勾选开关。
 *
 * 覆盖项仍然只读（data.tool_overrides）：写路径唯一 —— emit 给 App.vue → store.setToolOverride。
 */
const props = withDefaults(
  defineProps<{
    data?: RootData;
    tools?: UiTool[];
    /** 子段跳转意图（H3）：设置了 sub 就切到那个二级段（工具 / 技能 / 插件） */
    segIntent?: GotoSeg | null;
    /** 外部插件的安装清单（阶段 7）；数据只读，装卸都走 emit */
    external?: ExternalPlugin[];
  }>(),
  {
    data: () => RootDataSchema.parse({}),
    tools: () => [],
    segIntent: null,
    external: () => [],
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
  /** 外部插件（阶段 7）：安装 / 卸载。写路径唯一：App.vue → loader + store */
  'external-install-url': [payload: { url: string }];
  'external-install-paste': [payload: { code: string }];
  'external-uninstall': [payload: { id: string }];
  /** 插件详情「它加了什么」点一行跳过去（页面 id） */
  goto: [id: string];
  /**
   * 带子段的跳转（H3）：本组件只认识「设置 · 能力」这一格里的二级段，
   * 往上交给 SettingsView → App.vue 记成一笔落点，从任何地方点都落得回来。
   */
  'goto-seg': [intent: GotoSeg];
}>();

/** 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，缓存普通对象引用会读到旧数据 */
const data = toRef(props, 'data');

const SEG_ITEMS: SegItem[] = [
  { value: 'tools', label: '工具' },
  { value: 'skills', label: '技能' },
  { value: 'plugins', label: '插件' },
];

const seg = ref('tools');

/**
 * 子段落点（H3）：拿到意图就切到它指的二级段（'tools' / 'skills' / 'plugins'）。
 * 认对象身份而不是值 —— App.vue 每次跳转都造新对象，所以「目标没变」的重复点也生效。
 */
watch(
  () => props.segIntent,
  next => {
    if (next?.seg === 'capability' && next.sub) seg.value = next.sub;
  },
  { immediate: true },
);

/* ---------- 工具：清单（内核 + 预设里已有的名字） ---------- */

const preset = computed(() => data.value.presets.find(item => item.id === data.value.active_preset_id) ?? null);

/** 当前预设跟随「能力」页的全局设置时，工具详情里的「在本预设里启用」开关不起作用（默认就是跟随） */
const followsGlobal = computed(() => !(preset.value?.use_global_caps ?? false));

/**
 * 工具行：内核全量清单里**来源可用**的那些 + 预设硬引用过、但来源关着的兜底行（行上标「来源已停用」）。
 *
 * 口径跟设置 · 预设 的「这个预设用哪些工具」Sheet **共用一份**（components/tool_rows.ts，H4）：
 * 两处各写一份的话，改一处漏一处 —— F-B 就是这么来的。
 */
const toolRows = computed<UiTool[]>(() => buildToolRows(props.tools, preset.value?.tools ?? []));

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

/**
 * 插件管理页「它加了什么 → 工具：…」点一下：PluginDetail 发的是 'capability'
 * （阶段 1 的老口径 = 回「能力 · 工具」段；页面注册表里它已经不是页面了）。
 *
 * 两条路一起走（H3）：
 *  - 本地先切到工具段 —— 常见情形（本来就在能力段里点）立刻到位，不依赖上层；
 *  - 再把「设置 · 能力 · 工具」这条完整落点抛上去，App.vue 记一笔 —— 将来从别处发起的跳转
 *    （⋯ 更多页面 / 错误边界里的「去设置」）也落在同一处，而不是落到设置页默认的「接口」段。
 */
function onGoto(id: string) {
  if (id === 'capability') {
    seg.value = 'tools';
    emit('goto-seg', { page: 'settings', seg: 'capability', sub: 'tools' });
    return;
  }
  emit('goto', id);
}

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
