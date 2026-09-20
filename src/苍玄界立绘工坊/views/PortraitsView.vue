<template>
  <section class="flex flex-col gap-2">
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1" style="min-width: 220px">
        <span class="text-[11px] text-[var(--cx-muted)]">LLM 预设</span>
        <select v-model="store.activePresetId" class="cx-select">
          <option v-for="preset in store.data.llm_presets" :key="preset.id" :value="preset.id">
            {{ preset.name }}{{ preset.builtin ? '（内置）' : '' }}
          </option>
        </select>
      </label>
      <label class="flex flex-col gap-1" style="min-width: 220px">
        <span class="text-[11px] text-[var(--cx-muted)]">元数据提取规则</span>
        <select v-model="store.activeMetaRuleId" class="cx-select">
          <option v-for="rule in store.data.meta_extract_rules" :key="rule.id" :value="rule.id">
            {{ rule.name }}
          </option>
        </select>
      </label>
      <label class="flex flex-col gap-1" style="min-width: 180px">
        <span class="text-[11px] text-[var(--cx-muted)]">冲突处理</span>
        <select v-model="conflict" class="cx-select">
          <option value="overwrite">覆盖同名角色</option>
          <option value="skip">跳过同名角色</option>
          <option value="rename">保留双方（改名）</option>
        </select>
      </label>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-[11px]">
      <span class="text-[var(--cx-muted)]">
        目标格式：{{ templateLabel }} · 合并方式：{{ mergeModeLabel }} · 批大小：{{ store.activePreset?.batch_size }}
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button class="cx-btn" :disabled="store.generating || jobRoles.length === 0" @click="store.runPortrait()">
        {{ store.generating ? '打包中…' : '开始打包（' + jobRoles.length + ' 个角色）' }}
      </button>
      <button class="cx-btn" :disabled="!store.generating" @click="store.stopGeneration()">中止</button>
      <button class="cx-btn" :disabled="store.generating" @click="existingFile?.click()">导入既有插件文件</button>
      <button class="cx-btn cx-btn-danger" :disabled="store.generating" @click="store.resetExistingDocument()">
        清空基底
      </button>
      <input ref="existingFile" class="hidden" type="file" accept="application/json,.json" @change="onExistingChosen" />
    </div>

    <p v-if="jobRoles.length === 0" class="text-[11px] text-[var(--cx-warn)]">
      还没有可打包的角色。请回到「立绘图库」勾选角色并点「解析选中元数据」。
    </p>

    <div v-if="store.jobProgress" class="flex flex-col gap-1">
      <div style="height: 8px; background: rgba(0,0,0,0.35); border-radius: 4px; overflow: hidden">
        <div :style="barStyle"></div>
      </div>
      <div class="text-[11px] text-[var(--cx-muted)]">
        进度 {{ store.jobProgress.completed }} / {{ store.jobProgress.total }}
        <span v-if="store.jobProgress.batch.length">· 当前批次：{{ store.jobProgress.batch.join('、') }}</span>
      </div>
    </div>

    <p v-if="store.outputSummary" class="text-[12px]">{{ store.outputSummary }}</p>

    <div v-if="store.lastFailures.length" class="flex flex-col gap-1">
      <strong class="text-[12px] text-[var(--cx-error)]">失败 {{ store.lastFailures.length }} 个</strong>
      <div class="cx-scroll" style="max-height: 120px">
        <div v-for="failure in store.lastFailures" :key="failure.name" class="text-[11px]">
          {{ failure.name }}：{{ failure.error }}
        </div>
      </div>
    </div>

    <details v-if="store.lastLogs.length">
      <summary class="cursor-pointer text-[12px]">执行日志（{{ store.lastLogs.length }} 条）</summary>
      <div class="cx-scroll" style="max-height: 140px">
        <div v-for="(log, index) in store.lastLogs" :key="index" class="text-[11px] text-[var(--cx-muted)]">
          {{ log }}
        </div>
      </div>
    </details>

    <div v-if="store.outputJson" class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="text-[12px]">导出结果</strong>
        <button class="cx-btn" @click="copyOutput()">{{ copied ? '已复制' : '复制 JSON' }}</button>
        <button class="cx-btn" @click="downloadOutput()">下载 JSON</button>
        <span class="text-[11px] text-[var(--cx-muted)]">{{ outputSize }}</span>
        <span v-if="copyError" class="text-[11px] text-[var(--cx-warn)]">{{ copyError }}</span>
      </div>
      <pre ref="outputPre" class="cx-pre" style="max-height: 260px; overflow: auto">{{ store.outputJson }}</pre>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import { useWorkshopStore } from '../stores/workshop.ts';

const store = useWorkshopStore();
const existingFile = ref<HTMLInputElement | null>(null);
const outputPre = ref<HTMLPreElement | null>(null);
const copied = ref(false);
const copyError = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 冲突处理直接读写当前预设本身（可写 computed）。
 * 旧写法用本地 ref + 双向 watch，切换预设时会把旧预设的值回写到新预设，属于竞态；这里彻底去掉中间状态。
 */
const conflict = computed({
  get: () => store.activePreset?.conflict ?? 'overwrite',
  set: value => {
    const preset = store.activePreset;
    if (preset) preset.conflict = value;
  },
});

const jobRoles = computed(() => store.buildJobRoles());

const templateLabel = computed(() => {
  const template = store.activeTemplate;
  if (!template) return '（未指定模板）';
  return template.name + '（' + template.target + '）';
});

const mergeModeLabel = computed(() => {
  const mode = store.activeTemplate?.merge_mode;
  if (mode === 'array_push') return '数组追加';
  if (mode === 'object_map') return '对象表合并';
  return '自定义';
});

const barStyle = computed(() => {
  const progress = store.jobProgress;
  const total = progress?.total || 1;
  const percent = Math.round(((progress?.completed ?? 0) / total) * 100);
  return { width: percent + '%', height: '100%', background: 'var(--cx-accent)', transition: 'width .2s' };
});

const outputSize = computed(() => {
  const bytes = new Blob([store.outputJson]).size;
  return bytes > 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
});

async function onExistingChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await store.importExistingDocument(file);
}

function markCopied(): void {
  copied.value = true;
  copyError.value = '';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1500);
}

/** 兜底一：把导出内容全选，方便用户手动 Ctrl+C */
function selectOutputText(): boolean {
  const element = outputPre.value;
  const selection = window.getSelection();
  if (!element || !selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** 兜底二：execCommand('copy')。酒馆把界面放在 iframe 里，clipboard API 常被权限策略拦掉 */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

async function copyOutput(): Promise<void> {
  const text = store.outputJson;
  if (!text) return;
  copyError.value = '';

  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      markCopied();
      return;
    } catch {
      /* 落到 execCommand 兜底 */
    }
  }
  if (copyWithTextarea(text)) {
    markCopied();
    return;
  }

  copied.value = false;
  copyError.value = selectOutputText()
    ? '剪贴板不可用：已选中导出内容，请按 Ctrl+C 复制。'
    : '复制失败：剪贴板不可用，请手动选中下方内容复制。';
}

function downloadOutput(): void {
  const name = (store.activeTemplate?.target === 'xiaobaix' ? '小白x角色提示词' : '智绘姬角色预设') + '.json';
  const blob = new Blob([store.outputJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onBeforeUnmount(() => {
  clearTimeout(copiedTimer);
});
</script>

<style lang="scss" scoped></style>
