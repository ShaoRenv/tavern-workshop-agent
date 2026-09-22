<template>
  <div class="cx-body">
    <!-- 记录列表（管理） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">记录</span>
        <span class="cx-n">{{ records.length }} 条</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="act('new', '')">＋ 新建记录</button>
        <button class="cx-ghost dim" type="button" :disabled="!records.length" @click="act('export-all', '')">导出全部</button>
      </div>

      <div class="cx-list">
        <div v-for="record in records" :key="record.id" class="cx-rec" :class="{ on: record.id === activeId }">
          <div class="cx-rec-main">
            <div class="cx-rec-title">{{ record.title }}</div>
            <div class="cx-rec-meta">
              {{ timeLabel(record.updated_at || record.created_at) }} · {{ record.turns }} 轮<span v-if="record.id === activeId" class="cx-add"> · 当前</span
              ><span v-if="record.running" class="cx-add"> · 跑着呢</span>
            </div>
          </div>
          <div class="cx-rec-acts">
            <button class="cx-tiny" type="button" :disabled="record.id === activeId" @click="act('open', record.id)">打开</button>
            <button class="cx-tiny" type="button" @click="act('rename', record.id)">重命名</button>
            <button class="cx-tiny" type="button" @click="act('export', record.id)">导出 JSON</button>
            <button class="cx-tiny" type="button" @click="act('export-md', record.id)">导出 MD</button>
            <button class="cx-tiny dang" type="button" @click="act('delete', record.id)">删除</button>
          </div>
        </div>
      </div>

      <p v-if="records.length === 0" class="cx-hint">还没有记录。点「＋ 新建记录」开一条新的。</p>
      <p class="cx-hint cx-mt10">
        记录存在本脚本的脚本变量里，卸载脚本会一起删掉，建议偶尔导出备份。导出 Markdown 可以直接贴给别的工具看。
      </p>
    </div>

    <!--
      世界书备份（P5-3）。

      ⚠️ 列表**绝对不解析 entries**：那是整本快照，仓库实测过 1.1MB 的世界书，
      把 N 份整本塞进响应式数据会卡死。这里只读 world / entry_count / taken_at / reason
      （entry_count 这个冗余字段就是为列表页准备的）。
    -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">世界书备份</span>
        <span class="cx-n">{{ backupStat }}</span>
        <span class="cx-spacer"></span>
      </div>

      <p class="cx-hint cx-mb10">
        写回世界书之前会自动整本备份一份。写坏了可以从这里一键换回去。
      </p>

      <div class="cx-list">
        <div v-for="backup in backups" :key="backup.id" class="cx-bk">
          <div class="cx-bk-main">
            <div class="cx-bk-world">{{ backup.world || '（没记名字的世界书）' }}</div>
            <div class="cx-bk-meta">
              {{ backup.entry_count }} 条 · {{ timeLabel(backup.taken_at) }} · {{ backup.reason || '备份' }}
            </div>
          </div>
          <div class="cx-bk-acts">
            <button class="cx-tiny" type="button" @click="askRollback(backup)">回滚</button>
          </div>
        </div>
      </div>

      <p v-if="backups.length === 0" class="cx-hint">还没有备份：模型第一次改世界书时会自动生成。</p>

      <!--
        回滚结果。
        ⚠️ `backed_up_before_rollback === false` **必须显示**（draft.ts 的注释写死了这条）：
        它表示这次回滚**不可撤销** —— 不能让用户以为还能回头。
      -->
      <div v-if="rollbackNote" class="cx-bk-note" :class="{ bad: rollbackNote.bad }">
        <span class="cx-bk-dot"></span>
        <span>{{ rollbackNote.text }}</span>
      </div>
    </div>

    <!-- 当前记录的时间线（有会话事件就用事件，没有就按 turns 兜底） -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">时间线</span>
        <span class="cx-n">{{ timeline.length }} 条</span>
        <span class="cx-spacer"></span>
        <span class="cx-hint">{{ usingEvents ? '来自会话事件' : '内核还没给事件，按 turns 兜底' }}</span>
      </div>
      <div class="cx-timeline">
        <div v-for="item in timeline" :key="item.id" class="cx-tli" :class="['k-' + item.type, { bad: item.ok === false }]">
          <span class="cx-tdot"></span>
          <div class="cx-tli-main">
            <div class="cx-tli-head">
              <span class="cx-tli-label">{{ eventLabel(item.type) }}</span>
              <span class="cx-tli-title">{{ item.title }}</span>
              <span class="cx-spacer"></span>
              <span class="cx-tli-time">{{ timeLabel(item.at) }}</span>
            </div>
            <div v-if="item.text" class="cx-tli-text">{{ isOpen(item.id) ? item.text : shortText(item) }}</div>
            <div v-if="item.raw && isOpen(item.id)" class="cx-tli-raw">{{ item.raw }}</div>
            <p v-if="item.ok === false" class="cx-hint cx-danger-text">
              这一步失败了{{ item.ref ? '（' + item.ref + '）' : '' }}
            </p>
            <button v-if="needsToggle(item)" class="cx-ghost dim" type="button" @click="toggleOpen(item.id)">
              {{ isOpen(item.id) ? '收起' : item.raw ? '查看完整结果' : '展开' }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="timeline.length === 0" class="cx-hint">当前记录还没有内容。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';

import type { RollbackResult } from '../agent/draft.ts';

import {
  pickActiveSession,
  RootDataSchema,
  toSessionMeta,
  type RootData,
  type Session,
  type SessionMeta,
  type WbBackup,
} from '../core/types.ts';
import { eventLabel, timeLabel, turnsToTimeline, type UiSessionEvent } from '../components/ui_types.ts';

/**
 * 记录页（第 6 个页签）：聊天记录管理 + 当前记录的时间线。
 *
 *  - 列表：data.sessions（标题 / 时间 / 轮数走官方 toSessionMeta），当前那条看 active_session_id
 *  - 时间线：优先用会话事件 data.session.events（形状 { id, at, type, title, text?, tool?, ok?, ref?, raw? }），
 *    内核还没给事件时按 session.turns 兜底，不报错
 *  - 打开 / 重命名 / 删除 / 导出全部都 emit 给 App.vue，下载和读文件不在界面里做
 */
const props = withDefaults(
  defineProps<{
    data?: RootData;
    /**
     * 最近一次回滚的结果（P5-6）。由 App.vue 从 store 传下来。
     *
     * ⚠️ 为什么不是「外面的 ref 调这里的 showRollbackResult」：这一页住在
     * `<Sheet v-if="recordsOpen">` 里，Sheet 一关就被卸载；回滚是异步的，
     * 结果回来时 ref 已经是 null，那条「不可撤销」警报会被静默丢掉（本功能里最不能丢的一条）。
     * 改成 props 驱动后结果存在 store 里，跨卸载存活，重开 Sheet 照样看得到。
     */
    rollbackResult?: RollbackResult | null;
  }>(),
  {
    data: () => RootDataSchema.parse({}),
    rollbackResult: null,
  },
);
const emit = defineEmits<{
  'session-action': [payload: { action: string; id: string }];
  /**
   * 一键回滚（P5-3）。**只 emit，不写回** —— 写路径唯一在 App.vue → store，
   * 跟这一页别处（session-action）同一个口径。
   */
  rollback: [payload: { id: string }];
  /** 点「确认回滚」之后：请 App.vue 把 store 里上一次的结果清掉（免得盖住新的等待态） */
  'rollback-cleared': [];
}>();

const data = toRef(props, 'data');
const records = computed<SessionMeta[]>(() => data.value.sessions.map(toSessionMeta));
const activeId = computed(() => pickActiveSession(data.value).id);

/* ---------- 世界书备份（P5-3） ---------- */

/**
 * 备份清单，**最新的排前面**。
 *
 * 两条口径：
 *  1. **不解析 entries**：列表只需要 `world / entry_count / taken_at / reason`。
 *     `entries` 是整本快照（实测 1.1MB 一本），塞进响应式数据会卡死 —— 这里刻意不碰它。
 *  2. 按 `taken_at` **倒序**，不靠数组位置 —— 多标签页 / 乱序写入时数组顺序不可靠
 *     （裁剪那边也是按 taken_at 排的，两边口径要一致）。
 */
const backups = computed<WbBackup[]>(() =>
  data.value.wb_backups.slice().sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0)),
);

/** 顶部「占用感」：备份份数 / 覆盖几本 —— 快照可能很大，用户决定留不留之前要看得见 */
const backupStat = computed(() => {
  const list = backups.value;
  if (!list.length) return '还没有';
  const worlds = new Set(list.map(item => item.world).filter(Boolean));
  return list.length + ' 份 · 覆盖 ' + worlds.size + ' 本';
});

/**
 * 回滚结果提示（ok / 不可撤销警报 / 失败）。
 *
 * 来源是 **props.rollbackResult**（App.vue 从 store 传下来），不是本地 ref ——
 * 理由见 props 上那段注释：这一页会被 Sheet 卸载，本地状态活不过异步回滚。
 * 组件内部仍然保留一份「本页刚点过、结果还没回来」的临时文案（`pendingNote`）。
 */
const pendingNote = ref<{ text: string; bad: boolean } | null>(null);

/**
 * 回滚确认里用的**完整时间**（YYYY-MM-DD HH:mm）。
 *
 * 为什么不用 ui_types 的 `timeLabel`：那个是列表里用的短格式「03-01 18:30」，
 * 而且**好几个页面共用**，改它会连坐别处。回滚是不可撤销的操作，
 * 确认文案里必须带年份才说得清「换回哪一刻的样子」（题面也明确写了这个格式）。
 */
function fullTimeLabel(ms: number): string {
  if (!ms) return '（没记时间）';
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

/**
 * 一键回滚：先弹确认，再 emit。
 *
 * 确认文案两条都必须有（题面硬要求）：
 *  1. 「把《X》整本换回 YYYY-MM-DD HH:mm 的样子」—— 说清会发生什么；
 *  2. 「回滚前会自动再备份当前状态」—— **把我们的兜底讲出来，用户才敢点**。
 *
 * 用 `window.confirm`：跟这一页别处（删除记录）同一个口径，不新造弹窗。
 */
function askRollback(backup: WbBackup): void {
  const world = backup.world || '这本世界书';
  const when = fullTimeLabel(backup.taken_at);
  const lines = [
    '把《' + world + '》整本换回 ' + when + ' 的样子？',
    '',
    '现在这 ' + backup.entry_count + ' 条会被整本替换成备份里的内容。',
    '回滚前会自动再备份一次当前状态，所以这次操作还能再退回来。',
  ];
  if (!window.confirm(lines.join('\n'))) return;
  // 清掉上一次的提示（包括外部结果）：确认之后到结果回来之前，界面上不该还挂着旧文案
  pendingNote.value = null;
  emit('rollback-cleared');
  emit('rollback', { id: backup.id });
}

/**
 * 把一份回滚结果翻译成界面提示（纯函数）。
 *
 * 为什么要有这条：`backed_up_before_rollback === false` 表示**这次回滚不可撤销**，
 * 界面必须显示出来（draft.ts:502 的注释写死了）。这是「没兜底」警报，不是小事。
 */
function noteFor(result: RollbackResult): { text: string; bad: boolean } {
  const world = result.world || '世界书';
  if (!result.ok) {
    return { text: '回滚失败：' + (result.error || '原因不明'), bad: true };
  }
  const head = '已把《' + world + '》换回去（' + (result.restored ?? 0) + ' 条）';
  if (result.backed_up_before_rollback === false) {
    return { text: head + '。但回滚前没能再备份 —— 这次回滚不可撤销，别再改这本了。', bad: true };
  }
  return { text: head + '。回滚前的状态也已自动备份，可以再退回来。', bad: false };
}

/**
 * 页面上真正显示的那条。优先级：外部结果 > 本页刚点过（还没有结果）的临时文案。
 *
 * 外部结果一到就盖过临时文案；点新一次回滚时 `askRollback` 会把临时文案清掉，
 * 并由 App.vue 把 store 里的旧结果也清掉（否则会立刻把临时文案盖回去）。
 */
const rollbackNote = computed(() => {
  if (props.rollbackResult) return noteFor(props.rollbackResult);
  return pendingNote.value;
});

/* ---------- 时间线 ---------- */

const session = computed(() => pickActiveSession(data.value));

/** 会话事件：data-layer 正在加；没有（或空）就返回 null，用 turns 兜底 */
const rawEvents = computed<UiSessionEvent[] | null>(() => {
  const list = (session.value as Session & { events?: UiSessionEvent[] }).events;
  return Array.isArray(list) && list.length ? list : null;
});

const usingEvents = computed(() => rawEvents.value !== null);
const timeline = computed<UiSessionEvent[]>(() => rawEvents.value ?? turnsToTimeline(session.value.turns));

const openIds = ref<string[]>([]);

function isOpen(id: string) {
  return openIds.value.includes(id);
}

function toggleOpen(id: string) {
  const at = openIds.value.indexOf(id);
  if (at >= 0) openIds.value.splice(at, 1);
  else openIds.value.push(id);
}

function needsToggle(item: UiSessionEvent) {
  return !!item.raw || (item.text ?? '').length > 120;
}

function shortText(item: UiSessionEvent) {
  const text = item.text ?? '';
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

function act(action: string, id: string) {
  emit('session-action', { action, id });
}
</script>
