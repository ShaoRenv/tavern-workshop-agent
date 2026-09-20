import type { JsonTemplateData, LlmPresetData, WorldbookPresetData } from './schema.ts';
import { extractJson } from '../core/llm_extract.ts';
import { mergeCharacterDocuments, type MergeTarget, type MergeOutcome } from '../core/merge.ts';
import { getByPath, isPlainObject } from '../core/json_util.ts';

/**
 * LLM 执行引擎。
 *
 * 关键设计：**生成函数由外部注入**（GenerateFn）。
 * - 运行时注入真正调用酒馆 generateRaw 的实现
 * - 测试时注入假实现，于是分批、重试、断点、合并这些逻辑都能离线验证，不用烧 token
 */

/** 一次生成的请求描述（与酒馆 API 解耦） */
export interface GenerateRequest {
  systemPrompt: string;
  userInput: string;
  temperature: number;
  /** 期望的结构化输出约束，交给酒馆的 json_schema 使用 */
  jsonSchema?: unknown;
}

export type GenerateFn = (request: GenerateRequest) => Promise<string>;

export interface JobRole {
  name: string;
  /** 已按用户配置渲染好的元数据文本 */
  metaText: string;
  imageUrl: string;
}

export interface JobFailure {
  name: string;
  error: string;
}

export interface JobProgress {
  completed: number;
  total: number;
  /** 本批处理的角色名 */
  batch: string[];
  failures: JobFailure[];
  logs: string[];
}

export interface CancellationSignal {
  aborted: boolean;
}

/** 把角色清单切成批次 */
export function chunkRoles(roles: JobRole[], batchSize: number): JobRole[][] {
  const size = Math.max(1, Math.floor(batchSize) || 1);
  const batches: JobRole[][] = [];
  for (let index = 0; index < roles.length; index += size) {
    batches.push(roles.slice(index, index + size));
  }
  return batches;
}

/** 组装单批次的 user_input */
export function buildPortraitUserInput(
  batch: JobRole[],
  preset: LlmPresetData,
  template: JsonTemplateData,
): string {
  const sections: string[] = [];

  if (preset.instruction.trim()) sections.push(preset.instruction.trim());
  if (template.schema_note.trim()) sections.push('===== 输出格式要求 =====\n' + template.schema_note.trim());
  if (template.skeleton.trim()) sections.push('===== JSON 模板（严格照此结构）=====\n' + template.skeleton.trim());
  if (preset.few_shot.trim()) sections.push('===== 参考示例 =====\n' + preset.few_shot.trim());

  // 注意：这里刻意不使用【】包裹角色名——元数据里本来就有【字段名】标记，
  // 世界书正文里也常出现【角色名】对白，用【】会造成无法区分。
  const blocks = batch.map(role => '===== 角色：' + role.name + ' =====\n' + role.metaText.trim());
  sections.push('===== 待处理角色 =====\n' + blocks.join('\n\n'));
  sections.push('请只输出 JSON。');

  return sections.join('\n\n');
}

/** 解析生成器返回的文本，并合并进既有文档 */
export function mergeGeneratedReply(
  reply: string,
  preset: LlmPresetData,
  existingDocument: Record<string, unknown>,
  target: MergeTarget,
  template: JsonTemplateData,
): { outcome: MergeOutcome | null; error: string } {
  const extracted = extractJson(reply, preset.reply_extract);
  if (!extracted.ok) return { outcome: null, error: extracted.error ?? '提取 JSON 失败' };

  const outcome = mergeCharacterDocuments(existingDocument, extracted.value, {
    target,
    conflict: preset.conflict,
    key_prefix: template.key_prefix,
  });
  return { outcome, error: '' };
}
export interface PortraitRunResult {
  document: Record<string, unknown>;
  added: string[];
  updated: string[];
  skipped: string[];
  failures: JobFailure[];
  batchCount: number;
  logs: string[];
  aborted: boolean;
}

export interface RunPortraitOptions {
  roles: JobRole[];
  preset: LlmPresetData;
  template: JsonTemplateData;
  target: MergeTarget;
  /** 既有的插件文档；传空对象表示从零开始 */
  existingDocument: Record<string, unknown>;
  generate: GenerateFn;
  onProgress?: (progress: JobProgress) => void;
  signal?: CancellationSignal;
  /** 断点续跑：这些角色会被跳过 */
  skipNames?: string[];
}

/**
 * 分批把立绘元数据交给 LLM 转换，并合并进目标文档。
 *
 * 失败策略：整批重试 max_retries 次；仍失败则降级为逐角色单独重试，
 * 尽量避免「一个角色拖垮整批」。
 */
export async function runPortraitBatches(options: RunPortraitOptions): Promise<PortraitRunResult> {
  const { roles, preset, template, target, generate, onProgress, signal } = options;
  const skip = new Set(options.skipNames ?? []);
  const pending = roles.filter(role => !skip.has(role.name));
  const batches = chunkRoles(pending, preset.batch_size);

  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const failures: JobFailure[] = [];
  const logs: string[] = [];
  let document = { ...options.existingDocument };
  let completed = 0;
  let batchCount = 0;
  let aborted = false;

  const emit = (batch: string[]) => {
    onProgress?.({ completed, total: pending.length, batch, failures: [...failures], logs: [...logs] });
  };

  // 只负责解析与合并，**不记录失败**：失败由调用方在所有重试耗尽后统一记录一次，
  // 否则重试会产生重复的失败条目。
  const consume = (reply: string, batch: JobRole[]): { ok: boolean; error: string } => {
    const { outcome, error } = mergeGeneratedReply(reply, preset, document, target, template);
    if (!outcome) {
      logs.push('本批解析失败: ' + error);
      return { ok: false, error };
    }

    // 关键防线：解析成功但一个角色都没产出，等同于失败。
    // 否则 LLM 回复里的占位 `{}` 会让整批被记为"成功"，界面显示"新增 0、失败 0"却什么都没生成。
    const produced = outcome.added.length + outcome.updated.length + outcome.skipped.length;
    if (produced === 0) {
      const reason = '回复中没有可合并的角色（可能是占位 JSON 或结构不符）';
      logs.push(reason);
      return { ok: false, error: reason };
    }

    document = outcome.document;
    added.push(...outcome.added);
    updated.push(...outcome.updated);
    skipped.push(...outcome.skipped);
    logs.push(...outcome.warnings);
    completed += batch.length;
    return { ok: true, error: '' };
  };

  for (const batch of batches) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    batchCount += 1;
    const names = batch.map(role => role.name);
    const request: GenerateRequest = {
      systemPrompt: preset.system_prompt,
      userInput: buildPortraitUserInput(batch, preset, template),
      temperature: preset.temperature,
      jsonSchema: preset.use_json_schema ? safeParseSchema(template.json_schema_text) : undefined,
    };

    let succeeded = false;
    let lastError = '';
    for (let attempt = 0; attempt <= preset.max_retries && !succeeded; attempt++) {
      if (signal?.aborted) break;
      if (attempt > 0) logs.push('第 ' + (attempt + 1) + ' 次尝试: ' + names.join('、'));
      try {
        const outcome = consume(await generate(request), batch);
        succeeded = outcome.ok;
        if (!outcome.ok) lastError = outcome.error;
      } catch (error) {
        lastError = describeError(error);
        logs.push('生成异常: ' + lastError);
      }
    }

    if (!succeeded && batch.length > 1) {
      // 降级时的重试预算要收紧：整批已经消耗过 (max_retries+1) 次，
      // 若逐角色再用满，单批最坏会变成 (batch_size+1)×(max_retries+1) 次生成。
      const degradeRetries = Math.min(preset.max_retries, 1);
      logs.push('批次仍失败，降级为逐角色处理（每人最多再试 ' + degradeRetries + ' 次）: ' + names.join('、'));
      for (const role of batch) {
        if (signal?.aborted) break;
        const single: GenerateRequest = {
          systemPrompt: preset.system_prompt,
          userInput: buildPortraitUserInput([role], preset, template),
          temperature: preset.temperature,
          jsonSchema: preset.use_json_schema ? safeParseSchema(template.json_schema_text) : undefined,
        };
        let done = false;
        let roleError = lastError;
        for (let attempt = 0; attempt <= degradeRetries && !done; attempt++) {
          try {
            const outcome = consume(await generate(single), [role]);
            done = outcome.ok;
            if (!outcome.ok) roleError = outcome.error;
          } catch (error) {
            roleError = describeError(error);
            logs.push('生成异常: ' + roleError);
          }
        }
        if (!done) failures.push({ name: role.name, error: roleError || '多次重试后仍失败' });
        emit([role.name]);
      }
    } else if (!succeeded) {
      failures.push({ name: batch[0].name, error: lastError || '多次重试后仍失败' });
    }

    emit(names);
  }

  // 中止可能发生在最后一批的批次内重试/降级循环里，此时不会再回到循环顶部，
  // 因此这里补一次判定，避免把"用户取消"显示成"任务完成"。
  if (signal?.aborted) aborted = true;

  return { document, added, updated, skipped, failures, batchCount, logs, aborted };
}

function safeParseSchema(skeleton: string): unknown {
  try {
    return JSON.parse(skeleton);
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/* ------------------------------------------------------------------ */
/* 世界书生成                                                          */
/* ------------------------------------------------------------------ */

export interface WorldbookJobCharacter {
  name: string;
  /** 世界书里该角色的设定原文 */
  content: string;
}

export interface RunWorldbookOptions {
  characters: WorldbookJobCharacter[];
  preset: WorldbookPresetData;
  generate: GenerateFn;
  onProgress?: (progress: JobProgress) => void;
  signal?: CancellationSignal;
  skipNames?: string[];
  /** 已有产出（断点续跑） */
  initialText?: string;
}

export interface WorldbookRunResult {
  text: string;
  failures: JobFailure[];
  batchCount: number;
  logs: string[];
  aborted: boolean;
  completedNames: string[];
}

/** 组装世界书生成用的 user_input */
export function buildWorldbookUserInput(
  batch: WorldbookJobCharacter[],
  preset: WorldbookPresetData,
): string {
  const sections: string[] = [];
  if (preset.instruction.trim()) sections.push(preset.instruction.trim());
  if (preset.field_spec.trim()) sections.push('===== 行格式规范 =====\n' + preset.field_spec.trim());
  if (preset.few_shot.trim()) sections.push('===== 参考示例 =====\n' + preset.few_shot.trim());
  if (preset.tolerance_note.trim()) sections.push(preset.tolerance_note.trim());
  const blocks = batch.map(role => '===== 角色：' + role.name + ' =====\n' + role.content.trim());
  sections.push('===== 待处理角色 =====\n' + blocks.join('\n\n'));
  return sections.join('\n\n');
}

/** 从单批回复里取出最终文本 */
export function extractWorldbookText(reply: string, preset: WorldbookPresetData): string {
  const raw = reply.trim();
  if (preset.output_mode === 'text') return raw;

  const extracted = extractJson(reply, preset.reply_extract);
  if (!extracted.ok) return '';

  if (preset.output_json_path) {
    const value = getByPath(extracted.value, preset.output_json_path);
    return typeof value === 'string' ? value.trim() : '';
  }
  if (typeof extracted.value === 'string') return extracted.value.trim();
  if (Array.isArray(extracted.value)) return extracted.value.map(item => String(item)).join('\n');
  if (isPlainObject(extracted.value)) {
    const first = Object.values(extracted.value).find(value => typeof value === 'string');
    return typeof first === 'string' ? first : '';
  }
  return '';
}

/**
 * 分批生成世界书正文。
 *
 * 每批产出直接追加到累积文本，因此中断后可带着 partial 与 completedNames 续跑。
 */
export async function runWorldbookBatches(options: RunWorldbookOptions): Promise<WorldbookRunResult> {
  const { characters, preset, generate, onProgress, signal } = options;
  const skip = new Set(options.skipNames ?? []);
  const pending = characters.filter(character => !skip.has(character.name));
  const batches = chunkWorldbook(pending, preset.batch_size);

  const failures: JobFailure[] = [];
  const logs: string[] = [];
  const completedNames: string[] = [];
  const parts: string[] = [];
  if (options.initialText?.trim()) parts.push(options.initialText.trim());
  let completed = 0;
  let batchCount = 0;
  let aborted = false;

  for (const batch of batches) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    batchCount += 1;
    const names = batch.map(character => character.name);
    const request: GenerateRequest = {
      systemPrompt: preset.system_prompt,
      userInput: buildWorldbookUserInput(batch, preset),
      temperature: preset.temperature,
    };

    let produced = '';
    for (let attempt = 0; attempt <= preset.max_retries && !produced; attempt++) {
      if (signal?.aborted) break;
      try {
        produced = extractWorldbookText(await generate(request), preset);
      } catch (error) {
        logs.push('生成异常: ' + describeError(error));
      }
    }

    if (produced) {
      parts.push(produced);
      completedNames.push(...names);
      completed += batch.length;
    } else {
      // JSON 模式下取不出文本，多半是 output_json_path 配错，明确说出来而不是笼统报"重试失败"
      const reason =
        preset.output_mode === 'json'
          ? '未能从回复中取出文本：请检查 JSON 路径「' + (preset.output_json_path || '(未设置)') + '」与提取规则'
          : '多次重试后仍失败';
      for (const name of names) failures.push({ name, error: reason });
      logs.push('批次失败: ' + names.join('、') + ' —— ' + reason);
    }

    onProgress?.({ completed, total: pending.length, batch: names, failures: [...failures], logs: [...logs] });
  }

  return { text: parts.join('\n\n'), failures, batchCount, logs, aborted, completedNames };
}

function chunkWorldbook(items: WorldbookJobCharacter[], batchSize: number): WorldbookJobCharacter[][] {
  const size = Math.max(1, Math.floor(batchSize) || 1);
  const result: WorldbookJobCharacter[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
