/**
 * 从 LLM 回复中提取 JSON。
 *
 * 具体用哪种方式由用户的预设决定，因为不同模型/提示词习惯不同：
 * - `fenced`: \`\`\`json { ... } \`\`\` 代码块
 * - `labeled_brace`: 标记名后跟花括号，如 \"JSON\"{ ... }
 * - `regex`: 用户自填正则，取第 1 个捕获组
 * - `whole`: 整段回复就是 JSON
 */
import { jsonrepair } from 'jsonrepair';
import { getByPath, tryParseJson } from './json_util.ts';

export type ExtractMode = 'fenced' | 'labeled_brace' | 'regex' | 'whole';

export interface ExtractRuleConfig {
  /** 标记名，用于 `labeled_brace` 与 `fenced` 的匹配 */
  label: string;
  mode: ExtractMode;
  /** `regex` 模式下使用的正则文本，需含至少一个捕获组 */
  custom_regex: string;
  /** 可选：只取 JSON 中的某个路径 */
  json_path: string;
}

export function createDefaultExtractRuleConfig(): ExtractRuleConfig {
  return { label: 'JSON', mode: 'fenced', custom_regex: '', json_path: '' };
}

/**
 * 找到从 `startIndex` 开始的第一段配平 JSON。
 *
 * 感知字符串与转义，避免被字符串里的花括号或引号骗到。
 */
export function findBalancedJson(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{' || char === '[') {
      depth++;
      continue;
    }

    if (char === '}' || char === ']') {
      depth--;
      if (depth <= 0) return text.slice(startIndex, i + 1);
    }
  }

  return null;
}

/** 按规则从回复中取出 JSON 文本，取不到返回 null */
export function extractJsonText(reply: string, rule: ExtractRuleConfig): string | null {
  if (!reply) return null;

  if (rule.mode === 'whole') {
    const trimmed = reply.trim();
    return trimmed || null;
  }

  if (rule.mode === 'regex') {
    if (!rule.custom_regex) return null;
    try {
      const match = reply.match(new RegExp(rule.custom_regex, 's'));
      if (!match) return null;
      return match[1] ?? match[0];
    } catch {
      return null;
    }
  }

  if (rule.mode === 'fenced') {
    // 优先带语言标注的代码块，其次任意代码块
    const patterns = [
      new RegExp('```' + escapeRegExp(rule.label) + '\\s*([\\s\\S]*?)```', 'i'),
      new RegExp('```(?:json|JSON)?([^]*?)```', 'i'),
    ];
    for (const pattern of patterns) {
      const match = reply.match(pattern);
      const candidate = match?.[1]?.trim();
      // 只接受真正的产出，避免把 text 围栏里的 "{ } 表示对象" 之类当成结果
      if (candidate && !isEmptyJsonPayload(candidate)) return candidate;
    }
    // 退化为直接找配平 JSON
    return findFirstBalanced(reply);
  }

  // labeled_brace: "JSON"{ ... } —— 先定位标记名，再从其后第一个花括号开始配平
  const label = rule.label || 'JSON';
  const labelPattern = new RegExp('["\u300c\']?' + escapeRegExp(label) + '["\u300d\']?\\s*[:：]?\\s*([\\{\\[])', 'i');
  const labelMatch = reply.match(labelPattern);
  if (labelMatch) {
    const startIndex = labelMatch.index! + labelMatch[0].length - 1;
    const balanced = findBalancedJson(reply, startIndex);
    if (balanced) return balanced;
  }

  return findFirstBalanced(reply);
}

/**
 * 判断一段 JSON 文本是否是"空产出"。
 *
 * 存在的理由：LLM 常在解释格式时写出 `{}`、`{ ... }`（经 jsonrepair 后变 `{}`）这类占位内容。
 * 若把它当成结果，整批角色会被判定为"成功但零产出"，用户看到"完成：新增 0 个、失败 0 个"却什么都没生成。
 */
export function isEmptyJsonPayload(text: string): boolean {
  const direct = tryParseJson(text);
  const value = direct !== null ? direct : safeRepair(text);
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  // 标量对"角色文档"没有意义，同样视为空产出
  return true;
}

function safeRepair(text: string): unknown {
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return null;
  }
}

/**
 * 在整段文本中找出第一个**非空**的配平 JSON。
 *
 * 扫描时保持引号感知，避免把散文里提到的 `{}` 当成结果；遇到空容器则跳过继续找下一个候选。
 */
function findFirstBalanced(text: string): string | null {
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{' || char === '[') {
      const balanced = findBalancedJson(text, i);
      if (balanced && !isEmptyJsonPayload(balanced)) return balanced;
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ExtractJsonResult {
  ok: boolean;
  value: unknown;
  /** 实际用于解析的 JSON 文本 */
  text: string;
  /** 是否用到了 jsonrepair 修复 */
  repaired: boolean;
  error?: string;
}

/**
 * 提取并解析 JSON。
 *
 * 容错策略：先严格解析，失败再用 jsonrepair 修复（处理尾逗号、单引号、缺括号等 LLM 常见问题）。
 * `json_path` 非空时会再按路径取子节点。
 */
export function extractJson(reply: string, rule: ExtractRuleConfig): ExtractJsonResult {
  const text = extractJsonText(reply, rule);
  if (!text) {
    return { ok: false, value: null, text: '', repaired: false, error: '未能从回复中定位到 JSON' };
  }

  const direct = tryParseJson(text);
  if (direct !== null) {
    return { ok: true, value: applyJsonPath(direct, rule), text, repaired: false };
  }

  try {
    const repairedValue = JSON.parse(jsonrepair(text));
    return { ok: true, value: applyJsonPath(repairedValue, rule), text, repaired: true };
  } catch (error) {
    return {
      ok: false,
      value: null,
      text,
      repaired: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyJsonPath(value: unknown, rule: ExtractRuleConfig): unknown {
  if (!rule.json_path) return value;
  const sub = getByPath(value, rule.json_path);
  return sub === undefined ? value : sub;
}
