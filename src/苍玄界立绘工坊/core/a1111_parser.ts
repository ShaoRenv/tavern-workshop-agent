import { tryParseJson } from './json_util.ts';

export interface A1111Meta {
  document: Record<string, unknown>;
}

/** A1111 已知的参数键；用来把"参数行"和"提示词里的 artist: xxx"区分开 */
const KNOWN_PARAM_KEYS = new Set(
  [
    'steps',
    'sampler',
    'schedule type',
    'cfg scale',
    'distilled cfg scale',
    'seed',
    'size',
    'model hash',
    'model',
    'vae hash',
    'vae',
    'denoising strength',
    'clip skip',
    'ensd',
    'version',
    'hires upscale',
    'hires upscaler',
    'hires steps',
    'lora hashes',
    'ti hashes',
    'ngms',
    'sm',
    'sm dyn',
  ].map(key => key.toLowerCase()),
);

/**
 * 判断某一行是否是 A1111 的参数行（"Steps: 20, Sampler: ..."）。
 *
 * 参数行不一定以 `Steps:` 开头，所以先看"键: 值"对的数量，
 * 再用已知参数键兜底——避免把提示词里的 `artist: foo` 误判成参数行。
 */
function looksLikeParamsLine(line: string): boolean {
  if (/^\s*Steps\s*:\s*\d+/i.test(line)) return true;

  const pairs = [...line.matchAll(/([A-Za-z][A-Za-z0-9 _-]*)\s*:\s/g)];
  if (pairs.length < 2) return false;

  const knownCount = pairs.filter(match => KNOWN_PARAM_KEYS.has(match[1].trim().toLowerCase())).length;
  return knownCount >= 2 || (pairs.length >= 3 && knownCount >= 1);
}

/**
 * 按 ", 键: " 切分参数行，但**感知引号**。
 *
 * A1111 的 `Lora hashes: "lora_a: 11ab, lora_b: 22cd"` 值内部既含逗号又含 `键:` 形态，
 * 单纯用前瞻正则会把它切碎并伪造出 `lora_b` 字段。
 */
function splitParamsLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === ',' && !inQuote) {
      const rest = line.slice(index + 1);
      if (/^\s[A-Za-z][A-Za-z0-9 _-]*\s*:\s/.test(rest)) {
        parts.push(current);
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) parts.push(current);
  return parts;
}

/** 解析 "Steps: 20, Sampler: Euler a, CFG scale: 7" 形式的参数行 */
function parseParamsLine(line: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const part of splitParamsLine(line)) {
    const separator = part.indexOf(':');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    result[normalizeParamKey(key)] = coerceParamValue(value);
  }
  return result;
}

function normalizeParamKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, '_');
}

function coerceParamValue(value: string): unknown {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * 解析 Stable Diffusion WebUI (A1111) 的 `parameters` 文本块。
 *
 * 格式:
 * ```
 * <正向提示词>
 * Negative prompt: <负向提示词>
 * Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, Model: xxx
 * ```
 *
 * 解析结果会被归一化成与 NovelAI 相近的字段名（prompt / uc / negative_prompt），
 * 使同一套默认提取规则可跨格式复用。
 */
export function parseA1111Meta(chunks: Record<string, string>): A1111Meta | null {
  const raw = chunks['parameters'];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const lines = raw.split(/\r?\n/);

  // 参数行不一定以 "Steps:" 开头，因此从末尾往前找第一个形如参数行的行
  let paramsLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (looksLikeParamsLine(lines[index])) {
      paramsLineIndex = index;
      break;
    }
  }

  const promptLines: string[] = [];
  const negativeLines: string[] = [];
  let inNegative = false;

  const promptEnd = paramsLineIndex >= 0 ? paramsLineIndex : lines.length;
  for (let index = 0; index < promptEnd; index++) {
    const line = lines[index];
    if (/^\s*Negative prompt\s*:/i.test(line)) {
      inNegative = true;
      negativeLines.push(line.replace(/^\s*Negative prompt\s*:/i, '').trim());
      continue;
    }
    if (inNegative) negativeLines.push(line);
    else promptLines.push(line);
  }

  const prompt = promptLines.join('\n').trim();
  const negative = negativeLines.join('\n').trim();
  const params = paramsLineIndex >= 0 ? parseParamsLine(lines[paramsLineIndex]) : {};

  if (!prompt && !negative) return null;

  return {
    document: {
      params,
      // 参数放在前面展开，避免参数行里恰好出现 `Prompt:` 之类的键把正文覆盖掉
      ...params,
      prompt,
      uc: negative,
      negative_prompt: negative,
      raw_parameters: raw,
    },
  };
}

/**
 * 从 A1111 参数里尽力取出内嵌的 JSON 元数据。
 *
 * 参数里可能有多个花括号组，取**最后一个**配平组（A1111 的扩展通常把 JSON 写在行尾）。
 */
export function extractEmbeddedJson(rawParameters: string): unknown {
  const candidates = rawParameters.match(/\{[^{}]*\}/g);
  if (!candidates || candidates.length === 0) return null;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const parsed = tryParseJson(candidates[index]);
    if (parsed !== null) return parsed;
  }
  return null;
}
