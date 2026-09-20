<template>
  <div class="cx-body">
    <!-- 顶栏：Agent｜聊天 + 记录（⋯）+ 对话设置 -->
    <div class="cx-blk cx-pb10">
      <div class="cx-frow">
        <SegBar :model-value="session.mode" :items="MODE_ITEMS" variant="mode" class="cx-modebar-grow" @update:model-value="onModeChange" />
        <!-- 记录不占页面（阶段 2）：收进这张 Sheet -->
        <button class="cx-iconbtn" type="button" title="记录" @click="recordsOpen = true">⋯</button>
        <button class="cx-iconbtn" type="button" title="对话设置" @click="settingsOpen = true">⚙</button>
      </div>
    </div>

    <!-- 草稿条 -->
    <div v-if="data.drafts.length" class="cx-blk cx-pt10 cx-pb10">
      <div class="cx-draftbar">
        <span class="cx-d"></span>
        <span class="cx-x">草稿 · {{ data.drafts.length }} 处改动</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="diffOpen = true">看 diff</button>
        <button class="cx-ghost" type="button" @click="emit('save-drafts')">保存</button>
      </div>
    </div>

    <!-- 消息 -->
    <div class="cx-blk">
      <div class="cx-chat">
        <template v-for="row in rows" :key="row.key">
          <div v-if="row.kind === 'bubble'" class="cx-m" :class="row.turn.role === 'user' ? 'u' : 'a'">
            <span v-if="row.turn.role === 'assistant'" class="cx-who">{{ assistantName }}</span>
            <template v-if="row.turn.text">{{ row.turn.text }}</template>
            <img
              v-for="(image, index) in row.turn.images"
              :key="index"
              class="cx-mimg"
              :src="image"
              :alt="row.turn.role === 'user' ? '上传的图' : '图'"
            />
          </div>
          <ToolGroup v-else :calls="row.calls" :running="session.running" :is-last="row.isLast" @retry="emit('retry-image', $event)" />
        </template>

        <!-- 文本通道没有流式增量，跑着就先给个占位 -->
        <div v-if="pending" class="cx-m a">
          <span class="cx-who">{{ assistantName }}</span>
          <span class="cx-pending">生成中…</span>
        </div>
        <div ref="bottomEl"></div>
      </div>
      <p v-if="session.turns.length === 0" class="cx-hint">还没有消息。选好预设和世界书，说点什么就开工。</p>
    </div>
  </div>

  <!-- 状态行 + 输入 -->
  <div class="cx-statusbar" :class="{ on: session.running }">
    <span class="cx-sdot"></span>
    <span>{{ session.running ? '运行中 · 第 ' + session.round + ' 轮' : '就绪' }}</span>
    <span class="cx-spacer"></span>
    <span v-if="data.drafts.length" class="cx-hint">草稿 {{ data.drafts.length }} 处</span>
  </div>
  <div class="cx-composer">
    <button class="cx-ibtn" type="button" title="加图片 / 附件" @click="pickFiles">＋</button>
    <input ref="fileEl" class="cx-hidden" type="file" multiple accept="image/*" @change="onFiles" />
    <input v-model="text" type="text" :placeholder="session.running ? '跑着呢，可以先把话打好…' : '说点什么…'" @keydown.enter.prevent="submit" />
    <button v-if="session.running" class="cx-send cx-stop" type="button" @click="emit('stop')">停止</button>
    <button v-else class="cx-send" type="button" :disabled="!text.trim()" @click="submit">发送</button>
  </div>

  <!-- 对话设置：切聊天 / 切预设 / 删对话（都只发事件，数据层还是 store） -->
  <Sheet v-if="settingsOpen" title="对话设置" @close="settingsOpen = false">
    <template #head>
      <span class="cx-tag">{{ sessionRows.length }} 条记录</span>
    </template>

    <span class="cx-lab">切换聊天</span>
    <div class="cx-list">
      <button
        v-for="meta in sessionRows"
        :key="meta.id"
        class="cx-specrow"
        :class="{ on: meta.id === data.active_session_id }"
        type="button"
        @click="openChat(meta.id)"
      >
        <div class="cx-tn2">
          {{ meta.title }}<span v-if="meta.id === data.active_session_id" class="cx-tag ok">当前</span>
        </div>
        <div class="cx-td">{{ meta.turns }} 轮 · {{ timeLabel(meta.updated_at) }}</div>
      </button>
    </div>
    <p v-if="sessionRows.length === 0" class="cx-hint">还没有聊天记录。</p>
    <div class="cx-macros cx-mt10">
      <button class="cx-chip" type="button" @click="runSessionAction('new', '')">＋ 新建</button>
      <button class="cx-chip" type="button" @click="runSessionAction('rename', data.active_session_id)">✎ 改名当前</button>
      <button class="cx-chip" type="button" @click="runSessionAction('export', data.active_session_id)">导出当前</button>
    </div>

    <span class="cx-lab cx-mt16">切换预设</span>
    <select :value="data.active_preset_id" @change="onPresetChange">
      <option value="">（没选预设）</option>
      <option v-for="item in data.presets" :key="item.id" :value="item.id">{{ item.name }}</option>
    </select>

    <span class="cx-lab cx-mt16">删除</span>
    <button class="cx-tiny dang" type="button" @click="runSessionAction('delete', data.active_session_id)">删除当前对话</button>
    <p class="cx-hint cx-mt6">删当前这条会自动退到下一条；删到只剩一条会自动补一条空白对话。</p>

    <template #footer>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="settingsOpen = false">关闭</button>
    </template>
  </Sheet>

  <!-- diff 弹窗 -->
  <Sheet v-if="diffOpen" :title="'草稿改动 · ' + data.drafts.length + ' 处'" @close="diffOpen = false">
    <template #head>
      <span class="cx-tag" :class="data.drafts.length ? 'ok' : ''">{{ data.drafts.length ? '未保存' : '没有改动' }}</span>
    </template>
    <div v-for="draft in data.drafts" :key="draft.id">
      <span class="cx-lab">{{ draftLabel(draft) }}</span>
      <div class="cx-diff">
        <div v-for="(line, index) in diffLines(draft)" :key="index" :class="line.cls">{{ line.text }}</div>
      </div>
    </div>
    <p v-if="data.drafts.length === 0" class="cx-hint">Agent 还没往草稿里放过东西。</p>
    <div class="cx-hint">保存 = 写回酒馆世界书；也可以导出 JSON 先留着。</div>
    <template #footer>
      <button class="cx-ghost dim" type="button" @click="diffOpen = false">关闭</button>
      <span class="cx-spacer"></span>
      <button class="cx-ghost dim" type="button" :disabled="!data.drafts.length" @click="emit('export-drafts')">导出 JSON</button>
      <button class="cx-ghost" type="button" :disabled="!data.drafts.length" @click="emit('save-drafts')">全部保存</button>
    </template>
  </Sheet>

  <!-- 记录：记录页不再占顶栏（阶段 2），整份收进这张 Sheet；
       会话动作还是走 App.vue → store，Sheet 里不直接改数据 -->
  <Sheet v-if="recordsOpen" title="记录" @close="recordsOpen = false">
    <RecordsView :data="data" @session-action="emit('session-action', $event)" />
    <template #footer>
      <span class="cx-spacer"></span>
      <button class="cx-ghost" type="button" @click="recordsOpen = false">关闭</button>
    </template>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';

import {
  pickActiveSession,
  RootDataSchema,
  toSessionMeta,
  type DraftChange,
  type DraftKind,
  type RootData,
  type ToolCall,
  type Turn,
} from '../core/types.ts';
import SegBar from '../components/SegBar.vue';
import Sheet from '../components/Sheet.vue';
import ToolGroup from '../components/ToolGroup.vue';
import { timeLabel, type SegItem } from '../components/ui_types.ts';
import RecordsView from './RecordsView.vue';

/**
 * 对话页。
 *
 *  - Agent｜聊天 模式开关；有草稿时出现草稿条（看 diff / 保存）
 *  - 工具调用压成一行（约 28px），同一轮里连续多条在跑完后收起成「▸ N 次工具调用」
 *  - 生图卡永远展开；失败和改动默认摊开
 *  - 底部状态行（运行中 / 就绪）+ [＋][发送/停止]
 *  - 右上角 ⋯ = 记录（原「记录」页整段塞进 Sheet：记录不再占顶栏）
 */
const props = withDefaults(
  defineProps<{ data?: RootData; assistantName?: string }>(),
  {
    data: () => RootDataSchema.parse({}),
    assistantName: '苍玄 · 助手',
  },
);
const emit = defineEmits<{
  send: [text: string];
  stop: [];
  attach: [files: File[]];
  'save-drafts': [];
  'export-drafts': [];
  'retry-image': [call: ToolCall];
  /** 会话动作（新建 / 切换 / 改名 / 删除 / 导出）：数据层在 store，这里只转发给 App.vue */
  'session-action': [payload: { action: string; id: string }];
  /** 换预设 */
  'preset-change': [id: string];
  /** 切 Agent｜聊天：写路径归 store.setMode（界面不再直接改 session.mode） */
  'mode-change': [mode: 'agent' | 'chat'];
}>();

/**
 * 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，
 * 缓存成普通对象引用就会一直读旧数据、改到旧对象上。
 */
const data = toRef(props, 'data');

/**
 * 当前会话：用 core/types.ts 的官方挑选函数（sessions[active_session_id] → 第一条）。
 * store 里 data.session 是它的活别名（同一个对象引用），所以读谁都一样；
 * running / round / turns / mode 全走它，流式增量也是往这里的 text 上追加。
 */
const session = computed(() => pickActiveSession(data.value));

const MODE_ITEMS: SegItem[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'chat', label: '聊天' },
];

const text = ref('');
const diffOpen = ref(false);
const settingsOpen = ref(false);
/** 记录 Sheet（原「记录」页的内容） */
const recordsOpen = ref(false);

/** 会话列表（轻量元信息）：标题 / 轮数 / 更新时间 */
const sessionRows = computed(() => data.value.sessions.map(toSessionMeta));

/** 切换聊天：切完就把 Sheet 收掉 */
function openChat(id: string) {
  if (id !== data.value.active_session_id) runSessionAction('open', id);
  settingsOpen.value = false;
}

/** 会话动作只转发；「删除」是危险动作，收掉 Sheet 让用户看清结果 */
function runSessionAction(action: string, id: string) {
  emit('session-action', { action, id });
  if (action === 'delete' || action === 'new') settingsOpen.value = false;
}

function onPresetChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('preset-change', target.value);
}

/** Agent｜聊天：只发事件，改由 App.vue 调 store.setMode（store 内部会落盘） */
function onModeChange(value: string) {
  if (value === 'agent' || value === 'chat') emit('mode-change', value);
}
const fileEl = ref<HTMLInputElement | null>(null);
const bottomEl = ref<HTMLElement | null>(null);

/* ---------- 渲染行：气泡 + 连续工具调用段 ---------- */

interface BubbleRow {
  kind: 'bubble';
  key: string;
  turn: Turn;
}

interface CallsRow {
  kind: 'calls';
  key: string;
  calls: ToolCall[];
  /** 最后一段：跑完由它负责收起 */
  isLast: boolean;
}

type ChatRow = BubbleRow | CallsRow;

const rows = computed<ChatRow[]>(() => {
  const out: ChatRow[] = [];
  let bucket: ToolCall[] = [];
  let bucketKey = '';

  const flush = () => {
    if (!bucket.length) return;
    out.push({ kind: 'calls', key: bucketKey, calls: bucket, isLast: false });
    bucket = [];
    bucketKey = '';
  };

  for (const turn of session.value.turns) {
    if (turn.text || turn.images.length) {
      flush();
      out.push({ kind: 'bubble', key: turn.id, turn });
    }
    if (turn.calls.length) {
      if (!bucket.length) bucketKey = 'grp_' + turn.calls[0].id;
      for (const call of turn.calls) bucket.push(call);
    }
  }
  flush();

  for (let index = out.length - 1; index >= 0; index -= 1) {
    const row = out[index];
    if (row && row.kind === 'calls') {
      row.isLast = true;
      break;
    }
  }
  return out;
});

/* ---------- 流式：文字一变就重渲染 + 滚到底 ---------- */

/** 最后一个轮次的文字；流式增量会不停改它 */
const lastText = computed(() => {
  const turns = session.value.turns;
  const last = turns.length ? turns[turns.length - 1] : null;
  return last ? last.text : '';
});

/** 跑着但还没吐字（文本通道没有增量）：给个「生成中…」 */
const pending = computed(() => {
  if (!session.value.running) return false;
  const turns = session.value.turns;
  const last = turns.length ? turns[turns.length - 1] : null;
  return !(last && last.role === 'assistant' && last.text);
});

watch(
  () => [session.value.turns.length, session.value.running, lastText.value] as const,
  () => {
    void nextTick(() => bottomEl.value?.scrollIntoView({ block: 'end' }));
  },
);

/* ---------- 发送 / 附件 / 停止 ---------- */

function submit() {
  const value = text.value.trim();
  if (!value || session.value.running) return;
  emit('send', value);
  text.value = '';
}

function pickFiles() {
  fileEl.value?.click();
}

function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length) emit('attach', files);
  input.value = '';
}

/* ---------- 草稿 diff ---------- */

interface DiffLine {
  text: string;
  cls: string;
}

const KIND_LABELS: Record<DraftKind, string> = {
  create: '新建',
  edit: '改动',
  delete: '删除',
  meta: '元数据',
  worldbook: '世界书',
};

function draftLabel(draft: DraftChange) {
  return [KIND_LABELS[draft.kind], draft.world, draft.label || draft.uid].filter(part => !!part).join(' · ');
}

function diffLines(draft: DraftChange): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of (draft.before || '').split('\n')) {
    if (line.length) lines.push({ text: '− ' + line, cls: 'cx-del' });
  }
  for (const line of (draft.after || '').split('\n')) {
    if (line.length) lines.push({ text: '+ ' + line, cls: 'cx-add' });
  }
  if (lines.length === 0) lines.push({ text: '（没有正文差异，只有元数据）', cls: '' });
  return lines;
}
</script>
