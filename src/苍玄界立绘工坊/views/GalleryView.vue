<template>
  <section class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <button class="cx-btn" :disabled="store.parsing || !!uploadingName" @click="store.refreshGallery()">
        重新采集图库
      </button>
      <button
        class="cx-btn"
        :disabled="store.parsing || !!uploadingName || store.selectedRows.length === 0"
        @click="store.parseSelected()"
      >
        解析选中元数据（{{ store.selectedRows.length }}）
      </button>
      <button class="cx-btn" :disabled="!store.parsing" @click="store.parseAbort = true">中止</button>
      <span v-if="store.parsing" class="text-[11px] text-[var(--cx-muted)]">
        解析中 {{ store.parseProgress.done }} / {{ store.parseProgress.total }}
      </span>
      <span v-if="uploadingName" class="text-[11px] text-[var(--cx-muted)]">
        正在解析「{{ uploadingName }}」的本地 PNG…
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-[11px]">
      <input v-model="keyword" class="cx-input" style="max-width: 160px" placeholder="搜索角色名" />
      <select v-model="sectFilter" class="cx-select" style="max-width: 160px">
        <option value="">全部势力</option>
        <option v-for="sect in sects" :key="sect" :value="sect">{{ sect }}</option>
      </select>
      <label class="flex items-center gap-1">
        <input v-model="onlyWithImage" type="checkbox" />
        <span>只看有图片地址</span>
      </label>
      <button class="cx-btn" @click="selectVisible(true)">全选当前</button>
      <button class="cx-btn" @click="store.selectAll(false)">清空选择</button>
      <span class="text-[var(--cx-muted)]">共 {{ store.rows.length }} 个角色</span>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <input v-model="manualName" class="cx-input" style="max-width: 140px" placeholder="角色名" />
      <input v-model="manualUrl" class="cx-input" style="max-width: 320px" placeholder="立绘图片 URL" />
      <button class="cx-btn" @click="addManual()">手动添加 / 覆盖</button>
      <span class="text-[11px] text-[var(--cx-muted)]">
        提示：跨域被拦截的图片，点该行「上传」用本地 PNG 解析（不受跨域限制）。
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-[11px]">
      <label class="flex items-center gap-1">
        <span class="text-[var(--cx-muted)]">图片并发数</span>
        <input
          v-model.number="store.data.settings.image_concurrency"
          type="number"
          min="1"
          max="16"
          class="cx-input"
          style="width: 64px"
        />
      </label>
      <label class="flex items-center gap-1" style="flex: 1; min-width: 260px">
        <span class="text-[var(--cx-muted)]">图床代理前缀</span>
        <input
          v-model="store.data.settings.proxy_prefix"
          class="cx-input"
          placeholder="留空则直连；跨域被拦时可填自己的代理地址，如 https://your-proxy/?url="
        />
      </label>
    </div>

    <p v-if="uploadError" class="text-[11px] text-[var(--cx-error)]">{{ uploadError }}</p>

    <p v-for="warning in store.galleryWarnings" :key="warning" class="text-[11px] text-[var(--cx-warn)]">
      {{ warning }}
    </p>

    <div class="cx-scroll">
      <table class="cx-table">
        <thead>
          <tr>
            <th style="width: 34px"></th>
            <th style="width: 110px">角色</th>
            <th style="width: 90px">势力</th>
            <th style="width: 80px">来源</th>
            <th style="width: 92px">解析状态</th>
            <th>元数据预览</th>
            <th style="width: 120px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.name">
            <td><input v-model="row.selected" type="checkbox" /></td>
            <td>{{ row.name }}</td>
            <td>{{ row.sect }}</td>
            <td>{{ sourceLabel(row.source) }}</td>
            <td>
              <span :style="statusStyle(row.status)">{{ statusLabel(row.status) }}</span>
              <div v-if="row.formatLabel" class="text-[10px] text-[var(--cx-muted)]">{{ row.formatLabel }}</div>
            </td>
            <td>
              <span v-if="row.extractedText" class="line-clamp-2">{{ preview(row.extractedText) }}</span>
              <span v-else-if="row.error" class="text-[var(--cx-error)]">{{ row.error }}</span>
              <span v-else class="text-[var(--cx-muted)]">—</span>
              <div v-if="row.missing.length" class="text-[10px] text-[var(--cx-warn)]">
                未命中：{{ row.missing.join('、') }}
              </div>
            </td>
            <td class="flex flex-col gap-1">
              <button class="cx-btn" @click="toggleDetail(row.name)">详情</button>
              <button class="cx-btn" :disabled="!!uploadingName" @click="pickFile(row.name)">
                {{ uploadingName === row.name ? '解析中…' : '上传' }}
              </button>
            </td>
          </tr>
          <tr v-if="visibleRows.length === 0">
            <td colspan="7" class="text-center text-[var(--cx-muted)]">
              没有匹配的角色。点「重新采集图库」从本机读取状态栏图库与创意工坊角色。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="detailRow" class="flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <strong>{{ detailRow.name }} · 提取内容</strong>
        <button class="cx-btn" @click="detailName = ''">关闭</button>
      </div>
      <div class="text-[11px] text-[var(--cx-muted)]">图片地址：{{ detailRow.usedUrl || '（无）' }}</div>
      <pre class="cx-pre" style="max-height: 240px; overflow: auto">{{ detailRow.extractedText || '（未解析出内容）' }}</pre>
    </div>

    <input
      ref="fileInput"
      class="hidden"
      type="file"
      accept="image/png,image/*"
      @change="onFileChosen"
      @cancel="onFileCancel"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import { useWorkshopStore, PARSE_STATUS_LABELS, type ParseStatus, type RoleRow } from '../stores/workshop.ts';
import { SOURCE_LABELS } from '../core/gallery_source.ts';

const store = useWorkshopStore();

const keyword = ref('');
const sectFilter = ref('');
const onlyWithImage = ref(false);
const manualName = ref('');
const manualUrl = ref('');
const detailName = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
/** 待上传的目标角色名；取消选择、解析结束、组件卸载都必须清掉，避免残留到下一次 */
const pendingUploadName = ref('');
/** 正在解析本地 PNG 的角色名（空字符串表示空闲） */
const uploadingName = ref('');
const uploadError = ref('');

const sects = computed(() => [...new Set(store.rows.map(row => row.sect))].sort());

const visibleRows = computed(() =>
  store.rows.filter(row => {
    if (keyword.value && !row.name.includes(keyword.value.trim())) return false;
    if (sectFilter.value && row.sect !== sectFilter.value) return false;
    if (onlyWithImage.value && !row.usedUrl) return false;
    return true;
  }),
);

const detailRow = computed<RoleRow | null>(() =>
  detailName.value ? (store.rows.find(row => row.name === detailName.value) ?? null) : null,
);

function sourceLabel(source: RoleRow['source']): string {
  return SOURCE_LABELS[source] ?? source;
}

function statusLabel(status: ParseStatus): string {
  return PARSE_STATUS_LABELS[status] ?? status;
}

function statusStyle(status: ParseStatus) {
  if (status === 'ok' || status === 'manual') return { color: 'var(--cx-ok)' };
  if (status === 'no-metadata' || status === 'cors') return { color: 'var(--cx-warn)' };
  if (status === 'error') return { color: 'var(--cx-error)' };
  return { color: 'var(--cx-muted)' };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat;
}

function toggleDetail(name: string): void {
  detailName.value = detailName.value === name ? '' : name;
}

function selectVisible(value: boolean): void {
  for (const row of visibleRows.value) row.selected = value;
}

function addManual(): void {
  const created = store.addManualRole(manualName.value, manualUrl.value);
  if (created) {
    manualName.value = '';
    manualUrl.value = '';
  }
}

function pickFile(name: string): void {
  if (uploadingName.value) return;
  pendingUploadName.value = name;
  uploadError.value = '';
  fileInput.value?.click();
}

/** 用户在文件对话框里点了「取消」：清掉待上传目标，避免下次点上传时误用旧目标 */
function onFileCancel(): void {
  pendingUploadName.value = '';
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';

  const name = pendingUploadName.value;
  // 无论成功、失败还是取消，都不留下待上传目标
  pendingUploadName.value = '';
  if (!file || !name) return;

  const row = store.rows.find(item => item.name === name);
  if (!row) return;

  uploadingName.value = name;
  uploadError.value = '';
  try {
    await store.attachLocalFile(row, file);
  } catch (error) {
    uploadError.value = '「' + name + '」解析失败: ' + (error instanceof Error ? error.message : String(error));
  } finally {
    uploadingName.value = '';
  }
}

onBeforeUnmount(() => {
  pendingUploadName.value = '';
  uploadingName.value = '';
});
</script>

<style lang="scss" scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
