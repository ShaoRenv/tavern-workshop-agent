import { defineStore } from 'pinia';
import { computed, ref, watchEffect } from 'vue';
import { klona } from 'klona';

import {
  JsonTemplateSchema,
  LlmPresetSchema,
  MetaExtractRuleSchema,
  SettingsSchema,
  TaskStateSchema,
  WorkshopDataSchema,
  WorldbookPresetSchema,
  type JsonTemplateData,
  type LlmPresetData,
  type MetaExtractRuleData,
  type WorldbookPresetData,
  type WorkshopData,
} from '../llm/schema.ts';
import { isPlainObject } from '../core/json_util.ts';
import {
  createBuiltinLlmPresets,
  createBuiltinMetaExtractRules,
  createBuiltinTemplates,
  createBuiltinWorldbookPresets,
} from '../llm/presets_builtin.ts';
import { collectGallery, pickImageUrl, type GalleryRole, type RoleSource } from '../core/gallery_source.ts';
import { parsePngTextChunks } from '../core/png_meta.ts';
import { buildImageMeta } from '../core/meta_types.ts';
import { extractFields } from '../core/extractor.ts';
import { fetchImageBytes, readFileAsBytes } from '../core/fetch_image.ts';
import { mapWithConcurrency } from '../core/async_util.ts';
import { mergeCharacterDocuments, type MergeTarget } from '../core/merge.ts';
import { parseFactionOverview, splitWorldbookSections } from '../core/worldbook_source.ts';
import {
  runPortraitBatches,
  runWorldbookBatches,
  type GenerateRequest,
  type JobFailure,
  type JobProgress,
  type JobRole,
  type WorldbookJobCharacter,
} from '../llm/engine.ts';

/** 全局变量存储键：预设与设置对所有角色卡/聊天共享 */
export const STORAGE_KEY = 'cx_portrait_workshop_v1';

export type ParseStatus = 'idle' | 'fetching' | 'ok' | 'no-metadata' | 'cors' | 'error' | 'manual';

export const PARSE_STATUS_LABELS: Record<ParseStatus, string> = {
  idle: '待解析',
  fetching: '解析中',
  ok: '解析成功',
  'no-metadata': '无元数据',
  cors: '跨域被拦截',
  error: '解析失败',
  manual: '手动上传',
};

export interface RoleRow {
  name: string;
  sect: string;
  source: RoleSource;
  defaultImg: string;
  portraitImg: string;
  profile: string;
  selected: boolean;
  status: ParseStatus;
  /** 元数据格式的中文描述 */
  formatLabel: string;
  /** 命中的图片地址 */
  usedUrl: string;
  /** 按当前规则提取出的文本 */
  extractedText: string;
  /** 未命中的字段标签 */
  missing: string[];
  error: string;
}

function toRow(role: GalleryRole): RoleRow {
  return {
    name: role.name,
    sect: role.sect,
    source: role.source,
    defaultImg: role.defaultImg,
    portraitImg: role.portraitImg,
    profile: role.profile,
    selected: false,
    status: 'idle',
    formatLabel: '',
    usedUrl: pickImageUrl(role),
    extractedText: '',
    missing: [],
    error: '',
  };
}

/** 逐项校验数组，只丢弃损坏的条目而不是整包丢弃 */
function keepValidItems<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  list: unknown,
  label: string,
): T[] {
  if (!Array.isArray(list)) return [];
  const kept: T[] = [];
  let dropped = 0;
  for (const item of list) {
    const result = schema.safeParse(item);
    if (result.success) kept.push(result.data);
    else dropped += 1;
  }
  if (dropped > 0) console.warn(`[苍玄界立绘工坊] ${label}: 丢弃了 ${dropped} 个损坏条目`);
  return kept;
}

function loadStoredData(): WorkshopData {
  let raw: unknown = null;
  try {
    const variables = getVariables({ type: 'global' });
    raw = variables?.[STORAGE_KEY] ?? null;
  } catch (error) {
    console.warn('[苍玄界立绘工坊] 读取存档失败，将使用默认值', error);
    raw = null;
  }

  const parsed = WorkshopDataSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  // 整包校验失败时做分区恢复：用户自建的预设/模板不能因为某一个字段越界就全部消失
  console.warn('[苍玄界立绘工坊] 存档校验失败，正按字段尽力恢复', parsed.error.issues);
  const base = WorkshopDataSchema.parse({});
  const source = isPlainObject(raw) ? raw : {};

  base.llm_presets = keepValidItems(LlmPresetSchema, source.llm_presets, 'LLM 预设');
  base.worldbook_presets = keepValidItems(WorldbookPresetSchema, source.worldbook_presets, '世界书预设');
  base.templates = keepValidItems(JsonTemplateSchema, source.templates, 'JSON 模板');
  base.meta_extract_rules = keepValidItems(MetaExtractRuleSchema, source.meta_extract_rules, '元数据规则');

  const settings = SettingsSchema.safeParse(source.settings);
  if (settings.success) base.settings = settings.data;
  const task = TaskStateSchema.safeParse(source.task);
  if (task.success) base.task = task.data;

  return base;
}

function persistData(value: WorkshopData): void {
  try {
    insertOrAssignVariables({ [STORAGE_KEY]: klona(value) }, { type: 'global' });
  } catch (error) {
    console.warn('[苍玄界立绘工坊] 保存数据失败', error);
  }
}

/** 首次运行时填入内置预设与模板；返回是否有改动 */
export function seedBuiltins(data: WorkshopData): boolean {
  let changed = false;
  if (data.templates.length === 0) {
    data.templates = createBuiltinTemplates();
    changed = true;
  }
  if (data.meta_extract_rules.length === 0) {
    data.meta_extract_rules = createBuiltinMetaExtractRules();
    changed = true;
  }
  if (data.llm_presets.length === 0) {
    data.llm_presets = createBuiltinLlmPresets();
    changed = true;
  }
  if (data.worldbook_presets.length === 0) {
    data.worldbook_presets = createBuiltinWorldbookPresets();
    changed = true;
  }
  return changed;
}
export const useWorkshopStore = defineStore('cx-portrait-workshop', () => {
  /* ---------------- 持久化数据 ---------------- */

  const data = ref<WorkshopData>(loadStoredData());
  seedBuiltins(data.value);
  // klona 会递归读取 data 的每一个嵌套属性，因此 watchEffect 能追踪到深层字段
  // （例如 settings.source_worldbook = ... 这种直接改嵌套对象的写法）；保留该写法。
  watchEffect(() => persistData(klona(data.value)));

  /* ---------------- 图库 ---------------- */

  const rows = ref<RoleRow[]>([]);
  const galleryWarnings = ref<string[]>([]);
  const selectedRows = computed(() => rows.value.filter(row => row.selected));

  /** 重新采集图库；尽量保留已有的勾选与解析结果 */
  function refreshGallery(): void {
    const previous = new Map(rows.value.map(row => [row.name, row]));
    const collected = collectGallery();
    galleryWarnings.value = collected.warnings;
    rows.value = collected.roles.map(role => {
      const row = toRow(role);
      const old = previous.get(row.name);
      if (old) {
        row.selected = old.selected;
        row.status = old.status;
        row.formatLabel = old.formatLabel;
        row.extractedText = old.extractedText;
        row.missing = old.missing;
        row.error = old.error;
        if (old.usedUrl) row.usedUrl = old.usedUrl;
      }
      return row;
    });
  }

  function selectAll(value: boolean, predicate?: (row: RoleRow) => boolean): void {
    for (const row of rows.value) {
      if (!predicate || predicate(row)) row.selected = value;
    }
  }

  /** 手动补充一个角色（粘贴 URL） */
  function addManualRole(name: string, url: string, sect = '手动'): RoleRow | null {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) return null;
    const existing = rows.value.find(row => row.name === trimmedName);
    if (existing) {
      existing.usedUrl = trimmedUrl;
      existing.defaultImg = trimmedUrl;
      existing.status = 'idle';
      return existing;
    }
    const created: RoleRow = {
      name: trimmedName,
      sect,
      source: 'manual',
      defaultImg: trimmedUrl,
      portraitImg: trimmedUrl,
      profile: '',
      selected: true,
      status: 'idle',
      formatLabel: '',
      usedUrl: trimmedUrl,
      extractedText: '',
      missing: [],
      error: '',
    };
    rows.value.push(created);
    return created;
  }
  /* ---------------- 预设与模板选择 ---------------- */

  const activePresetId = ref<string>(data.value.llm_presets[0]?.id ?? '');
  const activeWorldbookPresetId = ref<string>(data.value.worldbook_presets[0]?.id ?? '');
  const activeMetaRuleId = ref<string>('builtin-default');

  const activePreset = computed<LlmPresetData | null>(() => {
    const presets = data.value.llm_presets;
    return presets.find(preset => preset.id === activePresetId.value) ?? presets[0] ?? null;
  });

  const activeWorldbookPreset = computed<WorldbookPresetData | null>(() => {
    const presets = data.value.worldbook_presets;
    return presets.find(preset => preset.id === activeWorldbookPresetId.value) ?? presets[0] ?? null;
  });

  /** 解析预设实际使用的 JSON 模板：内嵌优先，其次按 id 引用模板库 */
  const activeTemplate = computed<JsonTemplateData | null>(() => {
    const preset = activePreset.value;
    if (!preset) return null;
    if (preset.template_mode === 'embedded' && preset.embedded_template) return preset.embedded_template;
    return (
      data.value.templates.find(template => template.id === preset.template_id) ??
      data.value.templates[0] ??
      null
    );
  });

  /* ---------------- 元数据解析 ---------------- */

  const activeMetaRule = computed<MetaExtractRuleData>(() => {
    // 优先取用户在下拉框里的显式选择，其次跟随预设，最后退回第一条内置规则
    const id = activeMetaRuleId.value || activePreset.value?.meta_extract_rule_id || 'builtin-default';
    return (
      data.value.meta_extract_rules.find(rule => rule.id === id) ??
      data.value.meta_extract_rules[0] ??
      createBuiltinMetaExtractRules()[0]
    );
  });

  /** 用给定的字节解析一行，并把结果写回该行 */
  async function parseRowWithBytes(row: RoleRow, bytes: Uint8Array, status: ParseStatus): Promise<void> {
    try {
      const chunks = await parsePngTextChunks(bytes);
      const meta = buildImageMeta(chunks);
      const extracted = extractFields(meta, activeMetaRule.value);
      row.formatLabel = meta.label;
      row.extractedText = extracted.text;
      row.missing = extracted.missing;
      row.error = '';
      row.status = meta.format === 'unknown' ? 'no-metadata' : status;
    } catch (error) {
      row.status = 'error';
      row.error = error instanceof Error ? error.message : String(error);
    }
  }

  const parsing = ref(false);
  const parseAbort = ref(false);
  const parseProgress = ref({ done: 0, total: 0 });

  /** 批量解析选中角色的立绘元数据 */
  async function parseSelected(): Promise<void> {
    const targets = selectedRows.value;
    if (targets.length === 0 || parsing.value) return;

    // 关键：上一轮的「中止」标记必须在这里清掉，否则新的一轮会被 shouldStop 立刻拦停。
    parseAbort.value = false;
    parsing.value = true;
    parseProgress.value = { done: 0, total: targets.length };
    for (const row of targets) row.status = 'fetching';

    try {
      await mapWithConcurrency(
        targets,
        data.value.settings.image_concurrency,
        async row => {
          try {
            if (!row.usedUrl) {
              row.status = 'error';
              row.error = '没有可用的图片地址';
              return;
            }
            const fetched = await fetchImageBytes(row.usedUrl, data.value.settings.proxy_prefix);
            if (!fetched.ok || !fetched.bytes) {
              row.status = fetched.corsBlocked ? 'cors' : 'error';
              row.error = fetched.error;
              return;
            }
            await parseRowWithBytes(row, fetched.bytes, 'ok');
          } finally {
            // 成功 / 跳过 / 失败都要推进进度，否则进度条会卡在中间不动
            parseProgress.value = { done: parseProgress.value.done + 1, total: targets.length };
          }
        },
        { shouldStop: () => parseAbort.value },
      );
    } finally {
      parsing.value = false;
    }
  }

  /** 手动上传本地 PNG（绕过跨域限制，一定能拿到元数据） */
  async function attachLocalFile(row: RoleRow, file: File): Promise<void> {
    row.status = 'fetching';
    row.error = '';
    try {
      const bytes = await readFileAsBytes(file);
      await parseRowWithBytes(row, bytes, 'manual');
    } catch (error) {
      row.status = 'error';
      row.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  /* ---------------- LLM 生成 ---------------- */

  /**
   * 真正调用酒馆生成。这里刻意用 generateRaw + ordered_prompts：
   * 不携带酒馆当前预设，提示词完全由用户自己的预设决定，互不干扰。
   */
  async function tavernGenerate(request: GenerateRequest): Promise<string> {
    const result = await generateRaw({
      should_silence: true,
      ordered_prompts: [
        { role: 'system', content: request.systemPrompt || '你是一个精确的数据转换器，只输出要求的内容。' },
        { role: 'user', content: request.userInput },
      ],
      // 只接受真正的 JSON Schema 对象：模板里填了 "5" 或数组时不能硬塞给酒馆
      ...(request.jsonSchema && typeof request.jsonSchema === 'object' && !Array.isArray(request.jsonSchema)
        ? { json_schema: { name: 'workshop_output', value: request.jsonSchema as Record<string, unknown> } }
        : {}),
    });
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  const generating = ref(false);
  const generateAbort = ref(false);
  const jobProgress = ref<JobProgress | null>(null);
  const lastFailures = ref<JobFailure[]>([]);
  const lastLogs = ref<string[]>([]);

  /** 导出用的既有插件文档（可选：由用户导入） */
  const existingDocument = ref<Record<string, unknown>>({});
  const outputJson = ref('');
  const outputSummary = ref('');

  /** 把选中的行整理成引擎需要的角色任务 */
  function buildJobRoles(): JobRole[] {
    return selectedRows.value
      .filter(row => row.extractedText.trim())
      .map(row => ({ name: row.name, metaText: row.extractedText, imageUrl: row.usedUrl }));
  }

  /** 把「模板目标 / 预设目标」收敛成一个确定可用的合并目标 */
  function resolveMergeTarget(): MergeTarget {
    const template = activeTemplate.value;
    const preset = activePreset.value;
    const candidate =
      template && template.target !== 'custom' ? template.target : (preset?.target ?? 'zhihatsuki');
    return candidate === 'xiaobaix' ? 'xiaobaix' : 'zhihatsuki';
  }

  /** 执行立绘打包 */
  async function runPortrait(): Promise<void> {
    const preset = activePreset.value;
    const template = activeTemplate.value;
    if (!preset || !template || generating.value) return;

    const roles = buildJobRoles();
    if (roles.length === 0) {
      outputSummary.value = '没有可处理的角色：请先在「立绘图库」中勾选并成功解析元数据。';
      return;
    }

    generating.value = true;
    generateAbort.value = false;
    jobProgress.value = { completed: 0, total: roles.length, batch: [], failures: [], logs: [] };

    try {
      const target = resolveMergeTarget();
      const result = await runPortraitBatches({
        roles,
        preset,
        template,
        target,
        existingDocument: existingDocument.value,
        generate: tavernGenerate,
        onProgress: progress => {
          jobProgress.value = progress;
          lastLogs.value = progress.logs;
        },
        signal: { get aborted() { return generateAbort.value; } },
      });

      existingDocument.value = result.document;
      outputJson.value = JSON.stringify(result.document, null, 2);
      lastFailures.value = result.failures;
      lastLogs.value = result.logs;
      outputSummary.value = result.aborted
        ? '已中止。'
        : '完成：新增 ' + result.added.length + ' 个，覆盖 ' + result.updated.length + ' 个，跳过 ' + result.skipped.length + ' 个，失败 ' + result.failures.length + ' 个。';
    } catch (error) {
      outputSummary.value = '执行失败: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      generating.value = false;
    }
  }

  /**
   * 中止本界面的生成任务。
   * 必须只在确实有任务在跑时调用 stopAllGeneration()——否则会打断用户在别处（例如聊天）的生成。
   */
  function stopGeneration(): void {
    if (generating.value) {
      generateAbort.value = true;
      try {
        stopAllGeneration();
      } catch {
        /* 酒馆侧已经没有生成时忽略 */
      }
      return;
    }
    if (worldbookRunning.value) {
      worldbookAbort.value = true;
      try {
        stopAllGeneration();
      } catch {
        /* 同上 */
      }
    }
  }
  /* ---------------- 世界书生成 ---------------- */

  const worldbookNames = ref<string[]>([]);
  const worldbookEntries = ref<{ name: string; content: string; enabled: boolean }[]>([]);
  const worldbookSections = ref<{ title: string; names: string[] }[]>([]);
  const factions = ref<{ category: string; name: string; members: string[] }[]>([]);
  /** 待生成的角色名 -> 设定原文 */
  const worldbookSelection = ref<Record<string, string>>({});
  const worldbookText = ref('');
  const worldbookSummary = ref('');
  const worldbookRunning = ref(false);
  const worldbookAbort = ref(false);
  /** 「创建新世界书」进行中：防止连点创建出多本同名世界书 */
  const creatingWorldbook = ref(false);

  /** 读取当前酒馆里的世界书列表 */
  function refreshWorldbookNames(): void {
    try {
      worldbookNames.value = getWorldbookNames();
      const settings = data.value.settings;
      if (!settings.source_worldbook && worldbookNames.value.length > 0) {
        // 优先选中名字里带「苍玄界」的世界书
        settings.source_worldbook =
          worldbookNames.value.find(name => name.includes('苍玄界')) ?? worldbookNames.value[0];
      }
    } catch (error) {
      console.warn('[苍玄界立绘工坊] 读取世界书列表失败', error);
    }
  }

  /** 加载选中的源世界书并解析出区块与势力树 */
  async function loadSourceWorldbook(): Promise<void> {
    const name = data.value.settings.source_worldbook;
    if (!name) return;

    const entries = await getWorldbook(name);
    const list = entries.map(entry => ({
      name: entry.name,
      content: entry.content ?? '',
      enabled: entry.enabled !== false,
    }));
    worldbookEntries.value = list;

    const sections = splitWorldbookSections(list);
    worldbookSections.value = sections.map(section => ({
      title: section.title || '(未分组)',
      names: section.entries.map(entry => entry.name),
    }));

    // 精确优先：早期用 includes('势力') 宽松匹配，世界书里更靠前的含"势力"字样的条目会被选错。
    // 这里先按标题精确/最接近匹配，再用正文是否真的像势力树来兜底。
    const overview =
      list.find(entry => entry.name.includes('势力概览') && parseFactionOverview(entry.content).length > 0) ??
      list.find(entry => entry.name.includes('势力') && parseFactionOverview(entry.content).length > 0);
    factions.value = overview
      ? parseFactionOverview(overview.content).map(faction => ({
          category: faction.category,
          name: faction.name,
          members: faction.members,
        }))
      : [];
  }

  /** 勾选/取消一个角色（按名字关联到条目正文） */
  function toggleWorldbookCharacter(name: string, selected: boolean): void {
    const next = { ...worldbookSelection.value };
    if (selected) {
      const entry = worldbookEntries.value.find(item => item.name === name);
      next[name] = entry?.content ?? '';
    } else {
      delete next[name];
    }
    worldbookSelection.value = next;
  }

  /** 按区块整批勾选 */
  function toggleWorldbookSection(names: string[], selected: boolean): void {
    for (const name of names) toggleWorldbookCharacter(name, selected);
  }

  /** 按势力勾选其全部人物 */
  function toggleFaction(members: string[], selected: boolean): void {
    for (const name of members) toggleWorldbookCharacter(name, selected);
  }

  async function runWorldbook(): Promise<void> {
    const preset = activeWorldbookPreset.value;
    if (!preset || worldbookRunning.value) return;

    const characters: WorldbookJobCharacter[] = Object.entries(worldbookSelection.value)
      .filter(([, content]) => content.trim())
      .map(([name, content]) => ({ name, content }));

    if (characters.length === 0) {
      worldbookSummary.value = '请先在左侧勾选要纳入的角色或势力。';
      return;
    }

    worldbookRunning.value = true;
    worldbookAbort.value = false;
    jobProgress.value = { completed: 0, total: characters.length, batch: [], failures: [], logs: [] };

    try {
      const result = await runWorldbookBatches({
        characters,
        preset,
        generate: tavernGenerate,
        onProgress: progress => {
          jobProgress.value = progress;
          lastLogs.value = progress.logs;
        },
        signal: { get aborted() { return worldbookAbort.value; } },
        initialText: worldbookText.value,
      });

      worldbookText.value = result.text;
      lastFailures.value = result.failures;
      lastLogs.value = result.logs;
      worldbookSummary.value = result.aborted
        ? '已中止，可再次点击继续（已完成部分会保留）。'
        : '完成：成功 ' + result.completedNames.length + ' 个角色，失败 ' + result.failures.length + ' 个。';
    } catch (error) {
      worldbookSummary.value = '执行失败: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      worldbookRunning.value = false;
    }
  }

  /** 计算新世界书名称（永远新建，不覆盖既有世界书） */
  function resolveWorldbookName(): string {
    const preset = activeWorldbookPreset.value;
    const source = data.value.settings.source_worldbook || '苍玄界';
    const base = (preset?.worldbook_name_template ?? '{源名} · 全角色蓝灯精简')
      .replaceAll('{源名}', source)
      .replaceAll('{日期}', new Date().toLocaleDateString('zh-CN').replace(/\//g, '-'));

    const taken = new Set(worldbookNames.value);
    if (!taken.has(base)) return base;
    if (preset?.name_conflict === 'timestamp') return base + ' · ' + Date.now();
    for (let index = 2; index < 1000; index++) {
      const candidate = base + ' (' + index + ')';
      if (!taken.has(candidate)) return candidate;
    }
    return base + ' · ' + Date.now();
  }

  /** 把生成结果写成一个**全新的**世界书 */
  async function createOutputWorldbook(): Promise<string> {
    const preset = activeWorldbookPreset.value;
    const content = worldbookText.value.trim();
    if (!preset || !content || creatingWorldbook.value) return '';

    creatingWorldbook.value = true;
    try {
      const name = resolveWorldbookName();
      const defaults = preset.entry_defaults;
      // 单条目模式：所有角色内容汇总进一个蓝灯条目
      await createOrReplaceWorldbook(
        name,
        [
          {
            name: preset.entry_name_template || '全角色蓝灯精简',
            content,
            enabled: true,
            strategy: {
              type: defaults.strategy,
              keys: defaults.keys,
              keys_secondary: { logic: 'and_any', keys: [] },
              scan_depth: 'same_as_global',
            },
            position: {
              type: defaults.position_type,
              role: 'system',
              depth: defaults.depth,
              order: defaults.order,
            },
          },
        ],
        { render: 'debounced' },
      );

      refreshWorldbookNames();
      return name;
    } finally {
      creatingWorldbook.value = false;
    }
  }
  /* ---------------- 预设 / 模板 / 规则的增删改查 ---------------- */

  function upsertLlmPreset(preset: LlmPresetData): void {
    const index = data.value.llm_presets.findIndex(item => item.id === preset.id);
    if (index >= 0) data.value.llm_presets[index] = preset;
    else data.value.llm_presets.push(preset);
  }

  function removeLlmPreset(id: string): void {
    const target = data.value.llm_presets.find(item => item.id === id);
    if (!target || target.builtin) return;
    data.value.llm_presets = data.value.llm_presets.filter(item => item.id !== id);
    if (activePresetId.value === id) activePresetId.value = data.value.llm_presets[0]?.id ?? '';
  }

  function upsertWorldbookPreset(preset: WorldbookPresetData): void {
    const index = data.value.worldbook_presets.findIndex(item => item.id === preset.id);
    if (index >= 0) data.value.worldbook_presets[index] = preset;
    else data.value.worldbook_presets.push(preset);
  }

  function removeWorldbookPreset(id: string): void {
    const target = data.value.worldbook_presets.find(item => item.id === id);
    if (!target || target.builtin) return;
    data.value.worldbook_presets = data.value.worldbook_presets.filter(item => item.id !== id);
    if (activeWorldbookPresetId.value === id) {
      activeWorldbookPresetId.value = data.value.worldbook_presets[0]?.id ?? '';
    }
  }

  function upsertTemplate(template: JsonTemplateData): void {
    const index = data.value.templates.findIndex(item => item.id === template.id);
    if (index >= 0) data.value.templates[index] = template;
    else data.value.templates.push(template);
  }

  function removeTemplate(id: string): void {
    const target = data.value.templates.find(item => item.id === id);
    if (!target || target.builtin) return;
    data.value.templates = data.value.templates.filter(item => item.id !== id);
  }

  function upsertMetaRule(rule: MetaExtractRuleData): void {
    const index = data.value.meta_extract_rules.findIndex(item => item.id === rule.id);
    if (index >= 0) data.value.meta_extract_rules[index] = rule;
    else data.value.meta_extract_rules.push(rule);
  }

  function removeMetaRule(id: string): void {
    const target = data.value.meta_extract_rules.find(item => item.id === id);
    if (!target || target.builtin) return;
    data.value.meta_extract_rules = data.value.meta_extract_rules.filter(item => item.id !== id);
    if (activeMetaRuleId.value === id) activeMetaRuleId.value = 'builtin-default';
  }

  /** 生成一个不会与既有数据冲突的 id */
  function makeId(prefix: string, taken: string[]): string {
    for (let index = 1; index < 10000; index++) {
      const candidate = prefix + '-' + index;
      if (!taken.includes(candidate)) return candidate;
    }
    return prefix + '-' + Date.now();
  }

  /** 载入用户提供的既有插件文件，作为合并基底 */
  async function importExistingDocument(file: File): Promise<boolean> {
    try {
      const parsed = JSON.parse(await file.text());
      if (typeof parsed !== 'object' || parsed === null) return false;
      existingDocument.value = parsed as Record<string, unknown>;
      outputJson.value = JSON.stringify(parsed, null, 2);
      outputSummary.value = '已载入既有文件，后续生成的将合并进它。';
      return true;
    } catch (error) {
      outputSummary.value = '读取文件失败: ' + (error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  function resetExistingDocument(): void {
    existingDocument.value = {};
    outputJson.value = '';
    outputSummary.value = '已清空，将从零开始生成。';
  }

  /** 合并进既有文档（用于预览最终结果，不发起生成） */
  function previewMerge(incoming: unknown): string {
    const preset = activePreset.value;
    const template = activeTemplate.value;
    if (!preset || !template) return '';
    const target = resolveMergeTarget();
    const outcome = mergeCharacterDocuments(existingDocument.value, incoming, {
      target,
      conflict: preset.conflict,
      key_prefix: template.key_prefix,
    });
    return JSON.stringify(outcome.document, null, 2);
  }
  /* ---------------- 界面卸载（pagehide）时的清理 ---------------- */

  // 切换角色卡 / 关闭酒馆时，前端界面所在的文档会被卸载，此时 pagehide 触发：
  // 1) 立刻落盘一次，避免最后一次编辑的 watchEffect 刷新还没执行就被销毁；
  // 2) 给所有进行中的任务打上中止标记，避免留下「界面已走、任务仍在」的悬挂状态。
  //    这里刻意不调用 stopAllGeneration()：任务随界面销毁自行结束，不该打断用户在别处的生成。
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      persistData(klona(data.value));
      parseAbort.value = true;
      generateAbort.value = true;
      worldbookAbort.value = true;
    });
  }

  return {
    // 数据
    data,
    // 图库
    rows,
    galleryWarnings,
    selectedRows,
    refreshGallery,
    selectAll,
    addManualRole,
    // 解析
    parsing,
    parseProgress,
    parseAbort,
    parseSelected,
    attachLocalFile,
    activeMetaRule,
    activeMetaRuleId,
    // 预设与模板
    activePresetId,
    activePreset,
    activeTemplate,
    activeWorldbookPresetId,
    activeWorldbookPreset,
    upsertLlmPreset,
    removeLlmPreset,
    upsertWorldbookPreset,
    removeWorldbookPreset,
    upsertTemplate,
    removeTemplate,
    upsertMetaRule,
    removeMetaRule,
    makeId,
    // 生成
    generating,
    generateAbort,
    jobProgress,
    lastFailures,
    lastLogs,
    runPortrait,
    stopGeneration,
    buildJobRoles,
    // 导出
    existingDocument,
    outputJson,
    outputSummary,
    importExistingDocument,
    resetExistingDocument,
    previewMerge,
    // 世界书
    worldbookNames,
    worldbookEntries,
    worldbookSections,
    factions,
    worldbookSelection,
    worldbookText,
    worldbookSummary,
    worldbookRunning,
    worldbookAbort,
    creatingWorldbook,
    refreshWorldbookNames,
    loadSourceWorldbook,
    toggleWorldbookCharacter,
    toggleWorldbookSection,
    toggleFaction,
    runWorldbook,
    resolveWorldbookName,
    createOutputWorldbook,
  };
});
