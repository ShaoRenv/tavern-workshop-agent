<template>
  <section class="flex flex-col gap-2">
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1" style="min-width: 240px">
        <span class="text-[11px] text-[var(--cx-muted)]">源世界书</span>
        <select v-model="store.data.settings.source_worldbook" class="cx-select">
          <option value="">（请选择）</option>
          <option v-for="name in store.worldbookNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <button class="cx-btn" :disabled="loadingSource" @click="reload()">
        {{ loadingSource ? '载入中…' : '载入世界书' }}
      </button>
      <button class="cx-btn" :disabled="loadingSource" @click="store.refreshWorldbookNames()">刷新列表</button>
      <label class="flex flex-col gap-1" style="min-width: 220px">
        <span class="text-[11px] text-[var(--cx-muted)]">世界书预设</span>
        <select v-model="store.activeWorldbookPresetId" class="cx-select">
          <option v-for="preset in store.data.worldbook_presets" :key="preset.id" :value="preset.id">
            {{ preset.name }}{{ preset.builtin ? '（内置）' : '' }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="loadError" class="text-[11px] text-[var(--cx-error)]">{{ loadError }}</p>

    <div class="grid gap-2" style="grid-template-columns: 1fr 1fr">
      <div class="flex flex-col gap-1">
        <strong class="text-[12px]">按区块勾选</strong>
        <div class="cx-scroll" style="max-height: 220px">
          <div v-for="section in selectableSections" :key="section.title" class="flex items-center gap-2">
            <button class="cx-btn" @click="store.toggleWorldbookSection(section.names, true)">全选</button>
            <button class="cx-btn" @click="store.toggleWorldbookSection(section.names, false)">取消</button>
            <span class="text-[11px]">{{ section.title }}（{{ section.names.length }}）</span>
          </div>
          <p v-if="selectableSections.length === 0" class="text-[11px] text-[var(--cx-muted)]">
            请先载入世界书。
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <strong class="text-[12px]">按势力勾选</strong>
        <div class="cx-scroll" style="max-height: 220px">
          <div v-for="faction in store.factions" :key="faction.category + faction.name" class="flex items-center gap-2">
            <button class="cx-btn" @click="store.toggleFaction(faction.members, true)">选</button>
            <button class="cx-btn" @click="store.toggleFaction(faction.members, false)">消</button>
            <span class="text-[11px]">
              [{{ faction.category }}] {{ faction.name }}（{{ faction.members.length }}）
            </span>
          </div>
          <p v-if="store.factions.length === 0" class="text-[11px] text-[var(--cx-muted)]">
            未解析到势力树（该世界书可能没有「势力概览」条目）。
          </p>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button class="cx-btn" :disabled="store.worldbookRunning || selectedCount === 0" @click="store.runWorldbook()">
        开始生成（已选 {{ selectedCount }} 个角色）
      </button>
      <button class="cx-btn" :disabled="!store.worldbookRunning" @click="store.worldbookAbort = true">中止</button>
      <button
        class="cx-btn"
        :disabled="!store.worldbookText.trim() || store.creatingWorldbook"
        @click="createWorldbook()"
      >
        {{ store.creatingWorldbook ? '创建中…' : '创建新世界书' }}
      </button>
      <button class="cx-btn cx-btn-danger" :disabled="selectedCount === 0" @click="clearSelection()">清空已选</button>
      <span class="text-[11px] text-[var(--cx-muted)]">将创建：{{ store.resolveWorldbookName() }}</span>
    </div>

    <div v-if="store.jobProgress" class="flex flex-col gap-1">
      <div style="height: 8px; background: rgba(0,0,0,0.35); border-radius: 4px; overflow: hidden">
        <div :style="barStyle"></div>
      </div>
      <div class="text-[11px] text-[var(--cx-muted)]">
        进度 {{ store.jobProgress.completed }} / {{ store.jobProgress.total }}
      </div>
    </div>

    <p v-if="store.worldbookSummary" class="text-[12px]">{{ store.worldbookSummary }}</p>
    <p v-if="createdName" class="text-[12px] text-[var(--cx-ok)]">已创建世界书「{{ createdName }}」。</p>

    <div class="flex flex-wrap items-center gap-2">
      <label class="flex flex-col gap-1" style="min-width: 260px">
        <span class="text-[11px] text-[var(--cx-muted)]">条目名（single 模式使用）</span>
        <input v-model="entryName" class="cx-input" />
      </label>
      <span class="text-[11px] text-[var(--cx-muted)]">
        条目默认：{{ strategyLabel }} · 触发词 {{ keyCount }} 个
      </span>
    </div>

    <div v-if="store.worldbookText" class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="text-[12px]">生成结果</strong>
        <button class="cx-btn" @click="downloadText()">下载 txt</button>
        <span class="text-[11px] text-[var(--cx-muted)]">{{ store.worldbookText.length }} 字</span>
      </div>
      <textarea v-model="store.worldbookText" class="cx-textarea" style="min-height: 200px"></textarea>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { useWorkshopStore } from '../stores/workshop.ts';

const store = useWorkshopStore();
const loadError = ref('');
const createdName = ref('');

onMounted(() => {
  store.refreshWorldbookNames();
});

/**
 * 条目名同样直接读写当前预设（可写 computed），
 * 避免本地 ref + watch 在切换预设时把旧值回写进新预设。
 */
const entryName = computed({
  get: () => store.activeWorldbookPreset?.entry_name_template ?? '',
  set: value => {
    const preset = store.activeWorldbookPreset;
    if (preset) preset.entry_name_template = value;
  },
});

/** 载入源世界书是异步长任务，重复点击会并发读同一本书 */
const loadingSource = ref(false);

/** 世界书里有些条目不是角色（如 USER档案 已被禁用），默认不列出来 */
const selectableSections = computed(() =>
  store.worldbookSections
    .map(section => ({
      title: section.title,
      names: section.names.filter(name => !/^USER|用户档案|^====/.test(name)),
    }))
    .filter(section => section.names.length > 0),
);

const selectedCount = computed(() => Object.keys(store.worldbookSelection).length);

const strategyLabel = computed(() => {
  const strategy = store.activeWorldbookPreset?.entry_defaults.strategy;
  return strategy === 'selective' ? '绿灯（关键词触发）' : '蓝灯（常驻）';
});

const keyCount = computed(() => store.activeWorldbookPreset?.entry_defaults.keys.length ?? 0);

const barStyle = computed(() => {
  const progress = store.jobProgress;
  const total = progress?.total || 1;
  const percent = Math.round(((progress?.completed ?? 0) / total) * 100);
  return { width: percent + '%', height: '100%', background: 'var(--cx-accent)', transition: 'width .2s' };
});

async function reload(): Promise<void> {
  if (loadingSource.value) return;
  loadError.value = '';
  loadingSource.value = true;
  try {
    await store.loadSourceWorldbook();
  } catch (error) {
    loadError.value = '载入世界书失败: ' + (error instanceof Error ? error.message : String(error));
  } finally {
    loadingSource.value = false;
  }
}

function clearSelection(): void {
  for (const name of Object.keys(store.worldbookSelection)) {
    store.toggleWorldbookCharacter(name, false);
  }
}

async function createWorldbook(): Promise<void> {
  if (store.creatingWorldbook) return;
  createdName.value = '';
  const name = await store.createOutputWorldbook();
  if (name) createdName.value = name;
}

function downloadText(): void {
  const blob = new Blob([store.worldbookText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = store.resolveWorldbookName() + '.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<style lang="scss" scoped></style>
