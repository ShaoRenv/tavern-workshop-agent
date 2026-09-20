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

import {
  pickActiveSession,
  RootDataSchema,
  toSessionMeta,
  type RootData,
  type Session,
  type SessionMeta,
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
const props = withDefaults(defineProps<{ data?: RootData }>(), {
  data: () => RootDataSchema.parse({}),
});
const emit = defineEmits<{
  'session-action': [payload: { action: string; id: string }];
}>();

const data = toRef(props, 'data');
const records = computed<SessionMeta[]>(() => data.value.sessions.map(toSessionMeta));
const activeId = computed(() => pickActiveSession(data.value).id);

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
