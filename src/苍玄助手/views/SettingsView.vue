<template>
  <div class="cx-body">
    <!-- 二级导航：接口｜预设｜数据（设置页只留全局的东西，工具/技能归「能力」页） -->
    <div class="cx-blk cx-pb10">
      <SegBar v-model="seg" :items="SET_SEG_ITEMS" variant="mode" class="cx-modebar-grow" />
    </div>

    <div class="cx-setbody">
      <!-- ============ 接口（全局共用） ============ -->
      <div v-if="seg === 'api'" class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">接口</span>
          <span class="cx-spacer"></span>
          <span class="cx-hint">全局共用</span>
        </div>
        <div class="cx-f">
          <span class="cx-lab">走哪条路</span>
          <SegBar :model-value="data.api.route" :items="ROUTE_ITEMS" variant="mode" @update:model-value="setApiRoute" />
          <div class="cx-hint cx-mt6">自己填 → 能发原生 tools；酒馆默认 → 自动降级用文本标记。</div>
        </div>
        <div class="cx-f">
          <span class="cx-lab">接口地址</span>
          <input v-model="data.api.url" type="text" placeholder="https://…/v1" @input="touch" />
        </div>
        <div class="cx-f">
          <span class="cx-lab">API Key</span>
          <input v-model="data.api.key" type="password" placeholder="sk-…" @input="touch" />
        </div>
        <div class="cx-f">
          <span class="cx-lab">模型</span>
          <div class="cx-frow">
            <input v-model="data.api.model" type="text" list="cx-model-list" placeholder="模型名" @input="touch" />
            <button class="cx-tiny" type="button" @click="emit('fetch-models')">获取</button>
          </div>
          <datalist id="cx-model-list">
            <option v-for="name in models" :key="name" :value="name"></option>
          </datalist>
        </div>
        <div class="cx-f">
          <div class="cx-frow">
            <span class="cx-sw-lab">发送图片（多模态）</span>
            <Sw :model-value="data.api.send_images" @update:model-value="setSendImages" />
          </div>
          <div class="cx-hint cx-mt6">开着，模型才看得见自己生的图。</div>
        </div>
        <div class="cx-f">
          <div class="cx-frow">
            <span class="cx-sw-lab">流式输出</span>
            <Sw :model-value="data.api.stream" @update:model-value="setStream" />
          </div>
          <div class="cx-hint cx-mt6">边生成边显示；走文本工具通道时没有增量，对话页会显示「生成中…」。</div>
        </div>
        <div class="cx-f">
          <span class="cx-lab">超时（秒）</span>
          <input v-model.number="data.api.timeout_sec" type="number" min="1" @input="touch" />
        </div>
      </div>

      <!-- ============ 预设（切类型，下面的编辑区跟着变） ============ -->
      <template v-else-if="seg === 'preset'">
        <div class="cx-blk">
          <div class="cx-blkh">
            <span class="cx-t">预设</span>
            <span class="cx-spacer"></span>
            <div class="cx-menu-wrap">
              <button class="cx-ghost" type="button" title="预设操作" @click="presetMenu = !presetMenu">⋯</button>
              <div v-if="presetMenu" class="cx-menu">
                <button
                  v-for="action in PRESET_ACTIONS"
                  :key="action.value"
                  class="cx-menu-i"
                  :class="{ dang: action.danger }"
                  type="button"
                  @click="runPresetAction(action.value)"
                >
                  {{ action.label }}
                </button>
              </div>
            </div>
          </div>
          <span class="cx-lab">用哪个</span>
          <select v-model="data.active_preset_id" @change="touch">
            <option value="">（没选预设）</option>
            <option v-for="item in data.presets" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <div class="cx-frow cx-mt12">
            <span class="cx-tag" :class="preset && isAgent(preset) ? 'ok' : ''">{{ kindTag }}</span>
            <span class="cx-tag">{{ countTag }}</span>
            <span class="cx-tag" :class="preset && preset.output !== 'none' ? 'ok' : ''">{{ outputTag }}</span>
          </div>
          <div class="cx-hint cx-mt10">{{ kindHint }}</div>
        </div>

        <!-- 预设本体：消息条目 + 特殊层（两种东西排在同一条序列里） -->
        <div v-if="preset" class="cx-blk">
          <div class="cx-blkh">
            <span class="cx-t">预设本体</span>
            <span class="cx-n">{{ preset.items.length }} 条</span>
            <span class="cx-spacer"></span>
            <button class="cx-ghost" type="button" @click="addMessage">＋ 添加一条</button>
          </div>

          <button class="cx-goto" type="button" @click="specialOpen = true">＋ 添加特殊层</button>

          <div class="cx-mslist">
            <MsgRow
              v-for="(item, index) in preset.items"
              :key="item.id"
              :msg="item"
              :index="index"
              @edit="openItem(index)"
              @toggle="toggleMessage(item)"
              @move="moveItem(index)"
              @remove="removeItem(index)"
            />
          </div>
          <p v-if="preset.items.length === 0" class="cx-hint">
            还没有内容。点「＋ 添加一条」写第一句，或「＋ 添加特殊层」插一段上下文。
          </p>
          <p class="cx-hint cx-mt10">
            点普通消息那一行弹编辑（角色 / 名称 / 内容 / 插宏）；特殊层没有正文，只能开关和排序。开关关掉的那条不发出去。
          </p>
        </div>

        <!-- 两级能力启用：跟随全局（默认）／只用这个预设自己勾的 -->
        <div v-if="preset" class="cx-blk">
          <div class="cx-blkh">
            <span class="cx-t">单独启用预设能力</span>
            <span class="cx-spacer"></span>
            <span class="cx-n">{{ preset.use_global_caps ? '只用这个预设的' : '跟随全局' }}</span>
            <Sw :model-value="preset.use_global_caps" @update:model-value="setUseGlobalCaps" />
          </div>

          <template v-if="preset.use_global_caps">
            <p class="cx-hint cx-mb10">
              {{ isAgent(preset) ? '打开后不再使用全局工具及技能' : '当前是普通对话：不跑工具循环，模型的回复直接发给你' }}
            </p>

            <!-- 勾选区顶部：要改提示词 / 参数的去「能力」页 -->
            <button class="cx-goto" type="button" @click="emit('goto-capability')">改提示词 / 参数 →「能力」页</button>

            <button class="cx-multi" type="button" @click="toolPickOpen = true">
              <span>工具 {{ pickedToolCount }} / {{ toolRows.length }}</span>
              <span class="cx-spacer"></span>
              <span class="cx-multi-go">▾</span>
            </button>
            <button class="cx-multi" type="button" @click="skillPickOpen = true">
              <span>技能 {{ pickedSkillCount }} / {{ data.skills.length }}</span>
              <span class="cx-spacer"></span>
              <span class="cx-multi-go">▾</span>
            </button>

            <p class="cx-hint cx-mt10">点开一行做勾选（带全开 / 全关）；工具、技能本身在「能力」页管理。</p>
          </template>
          <p v-else class="cx-hint">
            跟随「能力」页的全局设置（当前 {{ globalToolCount }} 个工具 / {{ globalSkillCount }} 个技能，在「能力」页改）
          </p>
        </div>
      </template>

      <!-- ============ 数据：备份 / 迁移 / 危险操作（下载和读文件都由 App.vue 接，这里只发事件） ============ -->
      <div v-else class="cx-blk">
        <div class="cx-blkh">
          <span class="cx-t">数据</span>
          <span class="cx-spacer"></span>
          <span class="cx-hint">备份 / 迁移</span>
        </div>
        <div class="cx-macros">
          <button class="cx-tiny" type="button" @click="runDataAction('export-all')">导出全部数据</button>
          <button class="cx-tiny" type="button" @click="runDataAction('export-nokey')">导出（不含 API Key）</button>
          <button class="cx-tiny" type="button" @click="runDataAction('import')">导入数据</button>
        </div>
        <p class="cx-hint cx-mt8">数据存在本脚本的脚本变量里，卸载脚本会一起删掉，所以建议偶尔导出备份。</p>
        <span class="cx-lab cx-mt16">危险操作</span>
        <div class="cx-macros">
          <button class="cx-ghost dang" type="button" @click="runDataAction('clear-session')">清空对话</button>
          <button class="cx-ghost dang" type="button" @click="runDataAction('clear-drafts')">丢弃草稿</button>
          <button class="cx-ghost dang" type="button" @click="runDataAction('clear-artifacts')">丢弃产物</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 紧凑多选：工具（全开 / 全关 + 逐个勾） -->
  <Sheet v-if="toolPickOpen" title="这个预设用哪些工具" @close="toolPickOpen = false">
    <template #head>
      <span class="cx-tag" :class="pickedToolCount ? 'ok' : ''">{{ pickedToolCount }} / {{ toolRows.length }}</span>
    </template>
    <div class="cx-macros">
      <button class="cx-chip" type="button" @click="toggleAllTools(true)">全开</button>
      <button class="cx-chip" type="button" @click="toggleAllTools(false)">全关</button>
    </div>
    <div class="cx-list">
      <label v-for="tool in toolRows" :key="tool.name" class="cx-trow" :class="{ off: !toolOn(tool) }">
        <input type="checkbox" :checked="toolOn(tool)" @change="toggleTool(tool)" />
        <div>
          <div class="cx-tn2">{{ tool.title || tool.name }}</div>
          <div class="cx-td">{{ tool.desc || '（内核还没给这个工具写说明）' }}</div>
        </div>
      </label>
    </div>
    <p v-if="toolRows.length === 0" class="cx-hint">工具清单还没就绪：agent 内核注册好工具后会自动出现在这里。</p>
    <p class="cx-hint">清单是脚本内置的，你只能勾要不要；想加新的告诉我。改提示词 / 参数去「能力」页。</p>
    <template #footer>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="toolPickOpen = false">完成</button>
    </template>
  </Sheet>

  <!-- 紧凑多选：技能 -->
  <Sheet v-if="skillPickOpen" title="这个预设用哪些技能" @close="skillPickOpen = false">
    <template #head>
      <span class="cx-tag" :class="pickedSkillCount ? 'ok' : ''">{{ pickedSkillCount }} / {{ data.skills.length }}</span>
    </template>
    <div class="cx-macros">
      <button class="cx-chip" type="button" @click="toggleAllSkills(true)">全开</button>
      <button class="cx-chip" type="button" @click="toggleAllSkills(false)">全关</button>
    </div>
    <div class="cx-list">
      <label v-for="skill in data.skills" :key="skill.id" class="cx-trow" :class="{ off: !skillOn(skill) }">
        <input type="checkbox" :checked="skillOn(skill)" @change="toggleSkill(skill)" />
        <div>
          <div class="cx-tn2">{{ skill.name }}</div>
          <div class="cx-td">{{ skill.summary || '（还没写一句话描述）' }}</div>
        </div>
      </label>
    </div>
    <p v-if="data.skills.length === 0" class="cx-hint">还没有技能。去「能力」页建几个，这里就能勾了。</p>
    <p class="cx-hint">技能库（新建 / 编辑 / 参考文件）在「能力 · 技能」段。</p>
    <template #footer>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="skillPickOpen = false">完成</button>
    </template>
  </Sheet>

  <!-- 添加特殊层：第一版只给「上下文」和「用户需求」 -->
  <Sheet v-if="specialOpen" title="添加特殊层" @close="specialOpen = false">
    <div class="cx-list">
      <button
        v-for="entry in SPECIAL_KINDS"
        :key="entry.value"
        class="cx-specrow"
        type="button"
        @click="addSpecial(entry.value)"
      >
        <div class="cx-tn2">{{ entry.label }}</div>
        <div class="cx-td">{{ entry.hint }}</div>
      </button>
    </div>
    <p class="cx-hint cx-mt10">特殊层没有正文：运行时按它的类型展开成真正的消息。</p>
    <template #footer>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="specialOpen = false">取消</button>
    </template>
  </Sheet>

  <!-- 消息编辑弹窗 -->
  <Sheet v-if="messageDraft" title="编辑消息" @close="messageDraft = null">
    <template #head>
      <Sw :model-value="messageDraft.enabled" @update:model-value="messageDraft.enabled = $event" />
      <span class="cx-tag" :class="messageDraft.enabled ? 'ok' : ''">{{ messageDraft.enabled ? '启用' : '已关' }}</span>
    </template>
    <div>
      <SegBar v-model="messageDraft.role" :items="ROLE_ITEMS" variant="mode" class="cx-rolebar" />
    </div>
    <div>
      <span class="cx-lab">名称</span>
      <input v-model="messageDraft.name" type="text" placeholder="这条叫什么" />
    </div>
    <div>
      <span class="cx-lab">内容</span>
      <textarea ref="msgEl" v-model="messageDraft.content" class="cx-mono" style="min-height: 170px"></textarea>
    </div>
    <div>
      <span class="cx-lab">插宏</span>
      <div class="cx-macros">
        <button v-for="macro in MSG_MACROS" :key="macro" class="cx-chip" type="button" @click="insertMessageMacro(macro)">
          {{ macro }}
        </button>
      </div>
    </div>
    <template #footer>
      <button class="cx-ghost dang" type="button" @click="removeMessageDraft">删除</button>
      <button class="cx-ghost dim" type="button" @click="duplicateMessageDraft">复制</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost dim" type="button" @click="messageDraft = null">取消</button>
      <button class="cx-ghost" type="button" @click="saveMessage">保存</button>
    </template>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';

import {
  isAgentPreset,
  PresetMessageSchema,
  PresetSpecialSchema,
  resolveCaps,
  RootDataSchema,
  SPECIAL_KIND_HINTS,
  SPECIAL_KIND_LABELS,
  uid,
  type GlobalCaps,
  type Preset,
  type PresetItem,
  type PresetMessage,
  type RootData,
  type Skill,
  type SpecialKind,
} from '../core/types.ts';
import MsgRow from '../components/MsgRow.vue';
import SegBar from '../components/SegBar.vue';
import Sheet from '../components/Sheet.vue';
import Sw from '../components/Sw.vue';
import type { SegItem, UiTool } from '../components/ui_types.ts';

/**
 * 设置页：只有三块，用分段器切 —— 接口｜预设｜数据。
 *
 * 预设（v4 起只有一种，没有 kind，reports/苍玄助手-预设与上下文.md）：
 *  - **预设本体**：items 序列 —— 普通消息（走宏渲染）+ 特殊层（上下文 / 用户需求，
 *    运行时原生展开成真正的消息）
 *  - **单独启用预设能力**：默认关 = 跟随「能力」页的全局设置；
 *    打开 = 只用这个预设自己勾的工具 / 技能，完全不再叠加全局
 *  - 是不是 Agent 由**解析后的工具集**决定（core/types.ts 的 resolveCaps / isAgentPreset）：
 *    跟随全局时算上「能力」页那份默认工具，所以自己 tools=[] 也可能是 Agent
 *
 * 归位（reports/苍玄助手-UI整理.md 三）：
 *  - 工具 / 技能**本身**（库）在「能力」页；这里不再复制那份 13 行清单
 *  - 要改提示词 / 参数，走那条「改提示词 / 参数 →「能力」页」
 */
const props = withDefaults(
  defineProps<{ data?: RootData; tools?: UiTool[]; models?: string[]; globalCaps?: GlobalCaps }>(),
  {
    data: () => RootDataSchema.parse({}),
    tools: () => [],
    models: () => [],
    // 独立预览没有全局清单时给一份空的：解析出来是「普通对话」
    globalCaps: () => ({ tools: [], skills: [] }),
  },
);
/** 「数据」区块能发出去的动作；下载 / 读文件由 App.vue 实现 */
type DataAction = 'export-all' | 'export-nokey' | 'import' | 'clear-session' | 'clear-drafts' | 'clear-artifacts';

const emit = defineEmits<{
  'fetch-models': [];
  'preset-action': [action: string, presetId: string];
  /** 去「能力」页改工具 / 技能的提示词与参数（路由由 App.vue 接） */
  'goto-capability': [];
  'data-action': [action: DataAction];
  /**
   * 页面里直接改过 props.data（接口字段 / 预设字段 / 消息与特殊层）之后发一次。
   * App.vue 接成 store.save()（防抖 2.5 秒）。全局 deep watch 已经删了，漏一次就是丢数据。
   */
  change: [];
}>();

/** 记一笔「数据变了」：本页所有写点改完都要调它 */
function touch(): void {
  emit('change');
}

/**
 * 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，
 * 缓存成普通对象引用就会一直读旧数据、改到旧对象上。
 */
const data = toRef(props, 'data');

const SET_SEG_ITEMS: SegItem[] = [
  { value: 'api', label: '接口' },
  { value: 'preset', label: '预设' },
  { value: 'data', label: '数据' },
];
const ROUTE_ITEMS: SegItem[] = [
  { value: 'custom', label: '自己填的接口' },
  { value: 'tavern', label: '酒馆默认' },
];
const ROLE_ITEMS: SegItem[] = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'AI' },
];
const PRESET_ACTIONS = [
  { value: 'new', label: '新建预设', danger: false },
  { value: 'duplicate', label: '复制当前预设', danger: false },
  { value: 'export', label: '导出当前预设', danger: false },
  { value: 'delete', label: '删除当前预设', danger: true },
];
/**
 * 消息条目的插宏芯片。
 *
 * ⚠️ `{{上下文}}` 已经摘掉（v4）：上下文只以**特殊层**形式存在，运行时原生展开。
 * core/macros.ts 里还留着它的渲染能力，只是兼容老预设 —— 新预设不许用。
 */
const MSG_MACROS = [
  '{{用户需求}}',
  '{{世界书}}',
  '{{已选条目}}',
  '{{角色列表}}',
  '{{角色名}}',
  '{{图片元数据}}',
  '{{截图}}',
  '{{当前时间}}',
];

/** 「＋ 添加特殊层」第一版给的两个（文案来自 core/types.ts） */
const SPECIAL_KINDS: { value: SpecialKind; label: string; hint: string }[] = (
  ['context', 'user'] as SpecialKind[]
).map(value => ({ value, label: SPECIAL_KIND_LABELS[value], hint: SPECIAL_KIND_HINTS[value] }));

const seg = ref('api');
const presetMenu = ref(false);
const msgEl = ref<HTMLTextAreaElement | null>(null);
const toolPickOpen = ref(false);
const skillPickOpen = ref(false);
const specialOpen = ref(false);

const preset = computed(() => data.value.presets.find(item => item.id === data.value.active_preset_id) ?? null);

/** 解析后的工具集非空 = 走 Agent 路径（v4 起没有 kind；跟随全局时算上全局默认工具） */
function isAgent(item: Preset | null): boolean {
  return isAgentPreset(item, props.globalCaps);
}

/** 解析后的能力：跟随全局时就是「能力」页那份；判据和计数都用它 */
const resolvedCaps = computed(() => resolveCaps(preset.value, props.globalCaps));

/** 「能力」页当前的全局默认：工具数 = default_on 的那些，技能数 = 启用的那些 */
const globalToolCount = computed(() => props.globalCaps.tools.filter(tool => tool.default_on).length);
const globalSkillCount = computed(() => props.globalCaps.skills.filter(skill => skill.enabled).length);

const kindTag = computed(() => (isAgent(preset.value) ? 'Agent 类型' : '普通类型'));
const countTag = computed(() => {
  const item = preset.value;
  if (!item) return '未选预设';
  const size = '本体 ' + item.items.length + ' 条';
  return isAgent(item)
    ? size + ' · 工具 ' + resolvedCaps.value.tools.length + ' · 技能 ' + resolvedCaps.value.skills.length
    : size;
});
const outputTag = computed(() => {
  const output = preset.value?.output ?? 'none';
  if (output === 'json') return '产出 JSON';
  if (output === 'worldbook') return '产出世界书';
  return '不产出文件';
});
const kindHint = computed(() =>
  isAgent(preset.value)
    ? '走 Agent 路径：本体后面会自动追加「本次可操作范围 / 轮数预算 / 可用技能」三段系统提示词。'
    : '普通对话：不跑工具循环，模型的回复直接发给你。',
);

/* ---------- 接口：直接改 props.data，改完 touch ---------- */

function setApiRoute(value: string): void {
  data.value.api.route = value === 'custom' ? 'custom' : 'tavern';
  touch();
}

function setSendImages(value: boolean): void {
  data.value.api.send_images = value;
  touch();
}

function setStream(value: boolean): void {
  data.value.api.stream = value;
  touch();
}

/* ---------- 工具：只是「这个预设用哪些」，清单本身在「能力」页 ---------- */

/** 内核给的工具清单 + 预设里已有的工具名（内核没就绪时至少能看能勾） */
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
      out.push({ name });
    }
  }
  return out;
});

const pickedToolCount = computed(() => preset.value?.tools.length ?? 0);

function toolOn(tool: UiTool) {
  return preset.value?.tools.includes(tool.name) ?? false;
}

function toggleTool(tool: UiTool) {
  const item = preset.value;
  if (!item) return;
  const index = item.tools.indexOf(tool.name);
  if (index >= 0) item.tools.splice(index, 1);
  else item.tools.push(tool.name);
  touch();
}

function toggleAllTools(on: boolean) {
  const item = preset.value;
  if (!item) return;
  item.tools = on ? toolRows.value.map(tool => tool.name) : [];
  touch();
}

/* ---------- 技能：同样只是勾选，技能库在「能力 · 技能」 ---------- */

function skillOn(skill: Skill) {
  const item = preset.value;
  return !!item && (item.skills.includes(skill.id) || item.skills.includes(skill.name));
}

function toggleSkill(skill: Skill) {
  const item = preset.value;
  if (!item) return;
  const wasOn = skillOn(skill);
  // 历史数据里可能存的是名字，统一按 id 存
  item.skills = item.skills.filter(value => value !== skill.id && value !== skill.name);
  if (!wasOn) item.skills.push(skill.id);
  touch();
}

function toggleAllSkills(on: boolean) {
  const item = preset.value;
  if (!item) return;
  item.skills = on ? data.value.skills.map(skill => skill.id) : [];
  touch();
}

const pickedSkillCount = computed(() => data.value.skills.filter(skill => skillOn(skill)).length);

/* ---------- 预设本体：消息条目 + 特殊层 ---------- */

const messageDraft = ref<PresetMessage | null>(null);
const messageIndex = ref(-1);

/** 「单独启用预设能力」开关：直接改预设对象，改完落盘 */
function setUseGlobalCaps(value: boolean): void {
  const item = preset.value;
  if (!item) return;
  item.use_global_caps = value;
  touch();
}

/** 行上的开关：普通消息 / 特殊层都只是翻转 enabled（编辑正文走弹窗里的本地副本） */
function toggleMessage(item: PresetItem): void {
  item.enabled = !item.enabled;
  touch();
}

function addMessage() {
  const item = preset.value;
  if (!item) return;
  item.items.push(PresetMessageSchema.parse({ type: 'message', id: uid('msg'), name: '新消息', role: 'user' }));
  touch();
}

/** 加一个特殊层：没有正文，只有 kind */
function addSpecial(kind: SpecialKind) {
  const item = preset.value;
  if (!item) return;
  item.items.push(
    PresetSpecialSchema.parse({ type: 'special', id: uid('special'), name: SPECIAL_KIND_LABELS[kind], kind }),
  );
  specialOpen.value = false;
  touch();
}

/** 点一行：只有普通消息弹编辑窗；特殊层没有正文可改 */
function openItem(index: number) {
  const target = preset.value?.items[index];
  if (!target || target.type !== 'message') return;
  messageIndex.value = index;
  messageDraft.value = { ...target };
}

function saveMessage() {
  const item = preset.value;
  const draft = messageDraft.value;
  if (!item || !draft || messageIndex.value < 0) return;
  item.items[messageIndex.value] = draft;
  messageDraft.value = null;
  touch();
}

function removeMessageDraft() {
  const item = preset.value;
  if (!item || messageIndex.value < 0) return;
  item.items.splice(messageIndex.value, 1);
  messageDraft.value = null;
  touch();
}

function duplicateMessageDraft() {
  const draft = messageDraft.value;
  if (!draft) return;
  const copy: PresetMessage = { ...draft, id: uid('msg') };
  const item = preset.value;
  if (!item) return;
  item.items.splice(messageIndex.value + 1, 0, copy);
  messageDraft.value = null;
  touch();
}

function moveItem(index: number) {
  const item = preset.value;
  if (!item) return;
  // 单个 ⇅ 按钮：不是首行就上移，已经是首行就下移
  const target = index > 0 ? index - 1 : index + 1;
  if (target < 0 || target >= item.items.length) return;
  const [moved] = item.items.splice(index, 1);
  if (moved) item.items.splice(target, 0, moved);
  touch();
}

function removeItem(index: number) {
  preset.value?.items.splice(index, 1);
  touch();
}

/* ---------- 插宏 ---------- */

function insertMacro(el: HTMLTextAreaElement | null, value: string, apply: (next: string) => void, macro: string) {
  if (!el) {
    apply(value + macro);
    return;
  }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  apply(value.slice(0, start) + macro + value.slice(end));
  void nextTick(() => {
    el.focus();
    const pos = start + macro.length;
    el.setSelectionRange(pos, pos);
  });
}

function insertMessageMacro(macro: string) {
  const draft = messageDraft.value;
  if (!draft) return;
  insertMacro(msgEl.value, draft.content ?? '', next => {
    draft.content = next;
  }, macro);
}

/* ---------- 预设 ⋯ 菜单 ---------- */

function runPresetAction(action: string) {
  presetMenu.value = false;
  emit('preset-action', action, preset.value?.id ?? '');
}

/* ---------- 数据备份 ---------- */

/** 导出 / 导入 / 清空都只是把意图丢给 App.vue */
function runDataAction(action: DataAction) {
  emit('data-action', action);
}

/* ---------- 换段：把多选弹窗收回去 ---------- */

watch(seg, () => {
  toolPickOpen.value = false;
  skillPickOpen.value = false;
  specialOpen.value = false;
  presetMenu.value = false;
});
</script>
