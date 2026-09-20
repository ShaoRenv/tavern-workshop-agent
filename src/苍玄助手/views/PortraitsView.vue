<template>
  <div class="cx-body">
    <!-- 提示词：用哪个预设 + 它会产出什么 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">提示词</span>
        <span class="cx-spacer"></span>
        <button v-if="artifact" class="cx-ghost" type="button" @click="resultOpen = true">看产物</button>
        <button class="cx-ghost" type="button" @click="emit('open-settings')">去设置 →</button>
      </div>
      <span class="cx-lab">用哪个预设</span>
      <select v-model="data.active_preset_id" @change="touch">
        <option value="">（没选预设）</option>
        <option v-for="item in data.presets" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <div class="cx-frow cx-mt10">
        <span class="cx-tag" :class="outputTag.cls">{{ outputTag.label }}</span>
        <span class="cx-tag">{{ kindLabel }}</span>
      </div>
      <p v-if="!preset" class="cx-hint cx-mt8">还没挑预设 —— 先点右上角「去设置 →」，在设置页里选一个。</p>
    </div>

    <!-- 角色 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">角色</span>
        <span class="cx-n">{{ data.selection.character_ids.length }} / {{ roles.length }}</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="selectAllRoles">全选</button>
        <button class="cx-ghost dim" type="button" @click="clearRoles">清空</button>
      </div>
      <div class="cx-f">
        <input v-model="keyword" type="text" placeholder="搜索角色名…" />
      </div>
      <div class="cx-list">
        <label v-for="role in filteredRoles" :key="role.id" class="cx-row">
          <input type="checkbox" :checked="roleChecked(role)" @change="toggleRole(role)" />
          <span class="cx-nm">{{ role.name }}</span>
          <span v-if="role.source" class="cx-tag">{{ role.source }}</span>
          <span v-if="role.has_image" class="cx-tag ok">有图</span>
          <span v-if="role.has_meta === false" class="cx-tag warn">无元数据</span>
          <button class="cx-tiny" type="button" @click.prevent.stop="emit('pick-portrait', role.id)">传图</button>
        </label>
      </div>
      <p v-if="roles.length === 0" class="cx-hint cx-mt8">还没读到角色。等数据层把 Tavern 的角色列表接上，它们就会出现在这里。</p>
    </div>

    <!-- 用户需求 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">用户需求</span>
      </div>
      <textarea v-model="data.selection.demand" rows="3" placeholder="例：全部换成夏日泳装，泳池边，黄昏光线" @input="touch"></textarea>
    </div>
  </div>

  <div class="cx-foot">
    <button class="cx-fill" type="button" :disabled="!preset || generating" @click="emit('generate')">
      {{ generating ? '生成中…' : '生成' }}
    </button>
  </div>

  <!-- 产物弹窗 -->
  <Sheet v-if="resultOpen && artifact" title="产物 JSON" @close="resultOpen = false">
    <template #head>
      <span class="cx-tag ok">{{ copied ? '已复制' : '未保存' }}</span>
    </template>
    <div>
      <span class="cx-lab">内容</span>
      <pre class="cx-code">{{ artifact.data || '（空）' }}</pre>
    </div>
    <div>
      <span class="cx-lab">文件名</span>
      <input v-model="artifactName" type="text" placeholder="苍玄界-产物.json" />
    </div>
    <template #footer>
      <button class="cx-ghost dim" type="button" @click="resultOpen = false">关闭</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost dim" type="button" @click="copyJson">复制</button>
      <button class="cx-ghost" type="button" @click="saveArtifact">保存 JSON</button>
    </template>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';

import { isAgentPreset, resolveCaps, RootDataSchema, type GlobalCaps, type RootData } from '../core/types.ts';
import Sheet from '../components/Sheet.vue';
import type { UiRole } from '../components/ui_types.ts';

/**
 * 立绘页。
 *
 * 数据：直接从父层传进来的 RootData 上读写（受控组件）；异步动作走事件。
 * props 都有兜底值，所以 store 还没接上时也能单独渲染。
 */
const props = withDefaults(
  defineProps<{ data?: RootData; roles?: UiRole[]; generating?: boolean; globalCaps?: GlobalCaps }>(),
  {
    data: () => RootDataSchema.parse({}),
    roles: () => [],
    generating: false,
    // 单测 / 独立预览没有全局清单时给一份空的：解析出来是「普通对话」
    globalCaps: () => ({ tools: [], skills: [] }),
  },
);
const emit = defineEmits<{
  generate: [];
  'open-settings': [];
  'pick-portrait': [roleId: string];
  'save-artifact': [artifactId: string];
  /** 直接改过 props.data（预设 / 需求 / 勾选 / 产物名）之后发一次，由 App.vue 落盘 */
  change: [];
}>();

/**
 * 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，
 * 缓存成普通对象引用就会一直读旧数据、改到旧对象上。
 */
const data = toRef(props, 'data');
const keyword = ref('');

/**
 * 这里所有写点都是直接改 props.data（受控组件），改完必须 emit('change') 让 App.vue 落盘。
 * ⚠️ 全局 deep watch 已经删了（一次保存 = 整份数据回传 46.7 MB），漏一次就是丢数据。
 */
function touch() {
  emit('change');
}

const preset = computed(() => data.value.presets.find(item => item.id === data.value.active_preset_id) ?? null);

const kindLabel = computed(() => {
  const item = preset.value;
  if (!item) return '未选预设';
  // 判据 = 解析后的工具集：跟随全局时算上「能力」页那份默认工具
  if (!isAgentPreset(item, props.globalCaps)) return '消息 ' + item.items.length + ' 条';
  return '工具 ' + resolveCaps(item, props.globalCaps).tools.length + ' 个';
});

const outputTag = computed(() => {
  const output = preset.value?.output ?? 'none';
  if (output === 'json') return { label: '产出 JSON', cls: 'ok' };
  if (output === 'worldbook') return { label: '产出世界书', cls: 'ok' };
  return { label: '不产出文件', cls: '' };
});

/* ---------- 角色选择 ---------- */

const filteredRoles = computed(() => {
  const needle = keyword.value.trim();
  if (!needle) return props.roles;
  return props.roles.filter(role => role.name.includes(needle) || (role.source ?? '').includes(needle));
});

function roleChecked(role: UiRole) {
  return data.value.selection.character_ids.includes(role.id);
}

function toggleRole(role: UiRole) {
  const list = data.value.selection.character_ids;
  const index = list.indexOf(role.id);
  if (index >= 0) list.splice(index, 1);
  else list.push(role.id);
  touch();
}

function selectAllRoles() {
  data.value.selection.character_ids = filteredRoles.value.map(role => role.id);
  touch();
}

function clearRoles() {
  data.value.selection.character_ids = [];
  touch();
}

/* ---------- 产物 ---------- */

const artifact = computed(() => (data.value.artifacts.length ? data.value.artifacts[data.value.artifacts.length - 1] : null));
const artifactName = ref('');
const resultOpen = ref(false);
const copied = ref(false);

watch(
  artifact,
  value => {
    artifactName.value = value?.name ?? '';
  },
  { immediate: true },
);

// 新产物出现就把弹窗顶出来（设计稿里点「生成」就弹产物）
watch(
  () => data.value.artifacts.length,
  (next, prev) => {
    if (next > (prev ?? 0)) resultOpen.value = true;
  },
);

async function copyJson() {
  const text = artifact.value?.data ?? '';
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    copied.value = false;
  }
}

function saveArtifact() {
  const item = artifact.value;
  if (!item) return;
  const name = artifactName.value.trim();
  if (name) {
    item.name = name;
    touch();
  }
  emit('save-artifact', item.id);
}
</script>