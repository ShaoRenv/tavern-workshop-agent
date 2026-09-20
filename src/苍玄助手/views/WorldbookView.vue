<template>
  <div class="cx-body">
    <!-- 世界书：Agent 能读改的范围 -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">世界书</span>
        <span class="cx-n">{{ data.selection.worldbook_names.length }} / {{ worlds.length }} 本</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="selectAllWorlds">全选</button>
        <button class="cx-ghost dim" type="button" @click="clearWorlds">清空</button>
      </div>
      <div class="cx-list">
        <label v-for="world in worlds" :key="world.name" class="cx-row">
          <input type="checkbox" :checked="worldChecked(world)" @change="toggleWorld(world)" />
          <span class="cx-nm">{{ world.name }}</span>
          <span v-if="world.current" class="cx-tag ok">当前启用</span>
        </label>
      </div>
      <p v-if="worlds.length === 0" class="cx-hint cx-mt8">还没读到世界书。等数据层接上 Tavern 就会列在这里。</p>
      <p class="cx-hint cx-mt8">这是 Agent 能读改的范围；它自己也能列全部世界书。</p>
    </div>

    <!-- 条目：只挑要动的那些，省 token -->
    <div class="cx-blk">
      <div class="cx-blkh">
        <span class="cx-t">条目</span>
        <span class="cx-n">{{ data.selection.entry_uid.length }} / {{ entries.length }}</span>
        <span class="cx-spacer"></span>
        <button class="cx-ghost" type="button" @click="selectAllEntries">全选</button>
        <button class="cx-ghost" type="button" @click="invertEntries">反选</button>
        <button class="cx-ghost dim" type="button" @click="clearEntries">清空</button>
      </div>
      <div class="cx-f">
        <input v-model="keyword" type="text" placeholder="搜索条目…" />
      </div>
      <div v-if="groups.length > 1" class="cx-macros cx-mb10">
        <button
          v-for="group in groups"
          :key="group.name"
          class="cx-chip"
          :class="{ on: groupChecked(group) }"
          type="button"
          @click="toggleGroup(group)"
        >
          {{ group.name }} {{ group.items.length }}
        </button>
      </div>
      <div class="cx-list">
        <template v-for="group in visibleGroups" :key="group.name">
          <label class="cx-row" :title="'整组选中 / 取消：' + group.name">
            <input type="checkbox" :checked="groupChecked(group)" @change="toggleGroup(group)" />
            <span class="cx-nm">===={{ group.name }}====（{{ group.items.length }} 项）</span>
          </label>
          <label v-for="entry in group.items" :key="entry.uid" class="cx-row sub">
            <input type="checkbox" :checked="entryChecked(entry.uid)" @change="toggleEntry(entry.uid)" />
            <span class="cx-nm">{{ entry.name }}</span>
          </label>
        </template>
      </div>
      <p v-if="entries.length === 0" class="cx-hint cx-mt8">还没读到条目。选好世界书后，数据层会把条目读出来。</p>
      <p v-else-if="visibleGroups.length === 0" class="cx-hint cx-mt8">没搜到匹配的条目。</p>
    </div>
  </div>

  <div class="cx-foot">
    <button class="cx-fill" type="button" @click="emit('goto-chat')">去对话页开工 →</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';

import { RootDataSchema, type RootData } from '../core/types.ts';
import type { UiEntry, UiWorld } from '../components/ui_types.ts';

/** 世界书页：挑世界书 + 挑条目，然后把范围交给 Agent */
const props = withDefaults(defineProps<{ data?: RootData; worlds?: UiWorld[]; entries?: UiEntry[] }>(), {
  data: () => RootDataSchema.parse({}),
  worlds: () => [],
  entries: () => [],
});
const emit = defineEmits<{ 'goto-chat': []; change: [] }>();

/**
 * 用 ref 句柄拿 data：store 重新 load 时会整个替换 data.value，
 * 缓存成普通对象引用就会一直读旧数据、改到旧对象上。
 */
const data = toRef(props, 'data');
const keyword = ref('');

/**
 * 勾选是直接改 props.data（受控组件），改完必须 emit('change') 让 App.vue 落盘。
 * ⚠️ 全局 deep watch 已经删了（那玩意一次保存要回传 46.7 MB），这里漏一次就是丢数据。
 */
function touch() {
  emit('change');
}

interface EntryGroup {
  name: string;
  items: UiEntry[];
}

/* ---------- 世界书 ---------- */

function worldChecked(world: UiWorld) {
  return data.value.selection.worldbook_names.includes(world.name);
}

function toggleWorld(world: UiWorld) {
  const list = data.value.selection.worldbook_names;
  const index = list.indexOf(world.name);
  if (index >= 0) list.splice(index, 1);
  else list.push(world.name);
  touch();
}

function selectAllWorlds() {
  data.value.selection.worldbook_names = props.worlds.map(world => world.name);
  touch();
}

function clearWorlds() {
  data.value.selection.worldbook_names = [];
  touch();
}

/* ---------- 条目 ---------- */

/** 按 group 归档；没分组的归到「其它」 */
const groups = computed<EntryGroup[]>(() => {
  const map = new Map<string, UiEntry[]>();
  for (const entry of props.entries) {
    const name = (entry.group ?? '').trim() || '其它';
    const bucket = map.get(name);
    if (bucket) bucket.push(entry);
    else map.set(name, [entry]);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

const visibleGroups = computed<EntryGroup[]>(() => {
  const needle = keyword.value.trim();
  if (!needle) return groups.value;
  const result: EntryGroup[] = [];
  for (const group of groups.value) {
    if (group.name.includes(needle)) {
      result.push(group);
      continue;
    }
    const items = group.items.filter(entry => entry.name.includes(needle));
    if (items.length) result.push({ name: group.name, items });
  }
  return result;
});

function entryChecked(uid: string) {
  return data.value.selection.entry_uid.includes(uid);
}

/** 只翻转、不发事件（批量反选时用；最后由调用方 touch 一次） */
function flipEntry(uid: string) {
  const list = data.value.selection.entry_uid;
  const index = list.indexOf(uid);
  if (index >= 0) list.splice(index, 1);
  else list.push(uid);
}

function toggleEntry(uid: string) {
  flipEntry(uid);
  touch();
}

function groupChecked(group: EntryGroup) {
  return group.items.length > 0 && group.items.every(entry => entryChecked(entry.uid));
}

function toggleGroup(group: EntryGroup) {
  const all = groupChecked(group);
  for (const entry of group.items) {
    const list = data.value.selection.entry_uid;
    const index = list.indexOf(entry.uid);
    if (all) {
      if (index >= 0) list.splice(index, 1);
    } else if (index < 0) {
      list.push(entry.uid);
    }
  }
  touch();
}

function selectAllEntries() {
  data.value.selection.entry_uid = visibleGroups.value.flatMap(group => group.items.map(entry => entry.uid));
  touch();
}

function invertEntries() {
  // 一次反选只发一次 change，别让 store 的防抖被上百次调用重排
  for (const entry of props.entries) flipEntry(entry.uid);
  touch();
}

function clearEntries() {
  data.value.selection.entry_uid = [];
  touch();
}
</script>