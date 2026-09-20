import type { ImageMeta } from './meta_types.ts';
import { getByPath, toDisplayText } from './json_util.ts';

/**
 * 单个提取字段的配置。
 *
 * `paths` 是候选路径列表，按顺序取第一个命中的值，因此可以同时兼容
 * NovelAI / A1111 / ComfyUI 等不同格式。
 *
 * 路径前缀:
 * - `json:`  取归一化文档中的字段，如 `json:v4_prompt.caption.char_captions[*].char_caption`
 * - `chunk:` 取 PNG 原始文本块，如 `chunk:Description`
 */
export interface ExtractField {
  id: string;
  label: string;
  enabled: boolean;
  paths: string[];
}

/** 可自定义的元数据提取规则 */
export interface ExtractRule {
  id: string;
  name: string;
  builtin: boolean;
  /** 每个字段的渲染模板，占位符: {{label}} {{value}} */
  field_template: string;
  /** 整体前缀 */
  header: string;
  /** 整体后缀 */
  footer: string;
  fields: ExtractField[];
}

export interface ExtractedField {
  id: string;
  label: string;
  value: string;
  /** 实际命中的路径，空字符串表示未命中 */
  matchedPath: string;
}

export interface ExtractResult {
  fields: ExtractedField[];
  /** 渲染后可直接拼进提示词的文本 */
  text: string;
  /** 未命中的字段标签，用于界面提示降级情况 */
  missing: string[];
}

/** 按路径取值：支持 json:/chunk: 前缀 */
export function resolvePath(meta: ImageMeta, path: string): unknown {
  const separator = path.indexOf(':');
  if (separator < 0) return undefined;
  const scheme = path.slice(0, separator);
  const rest = path.slice(separator + 1);

  if (scheme === 'json') return getByPath(meta.document, rest);
  if (scheme === 'chunk') return meta.chunks[rest];
  return undefined;
}

/** 按规则提取字段，并按模板渲染 */
export function extractFields(meta: ImageMeta, rule: ExtractRule): ExtractResult {
  const fields: ExtractedField[] = [];
  const missing: string[] = [];

  for (const field of rule.fields) {
    if (!field.enabled) continue;

    let value = '';
    let matchedPath = '';
    for (const path of field.paths) {
      const candidate = toDisplayText(resolvePath(meta, path));
      if (candidate.trim()) {
        value = candidate.trim();
        matchedPath = path;
        break;
      }
    }

    if (!value) missing.push(field.label);
    fields.push({ id: field.id, label: field.label, value, matchedPath });
  }

  return { fields, text: renderExtract(fields, rule), missing };
}

/** 用字段模板渲染出最终文本 */
export function renderExtract(fields: ExtractedField[], rule: ExtractRule): string {
  const parts = fields
    .filter(field => field.value)
    .map(field =>
      rule.field_template.replaceAll('{{label}}', field.label).replaceAll('{{value}}', field.value),
    );

  if (parts.length === 0) return '';

  const blocks = [rule.header, ...parts, rule.footer].filter(part => part.trim() !== '');
  return blocks.join('\n\n');
}

/** 内置默认提取规则：char_caption 与 prompt 优先，其余为常见补充 */
export function createDefaultExtractRule(): ExtractRule {
  return {
    id: 'builtin-default',
    name: '默认（char_caption + prompt）',
    builtin: true,
    field_template: '【{{label}}】\n{{value}}',
    header: '',
    footer: '',
    fields: [
      {
        id: 'char_caption',
        label: '角色DNA（char_caption）',
        enabled: true,
        paths: [
          'json:char_captions',
          'json:positive_texts',
          'json:v4_prompt.caption.char_captions[*].char_caption',
        ],
      },
      {
        id: 'prompt',
        label: '完整提示词（prompt）',
        enabled: true,
        paths: ['json:prompt', 'chunk:Description'],
      },
      {
        id: 'uc',
        label: '负向提示词（uc）',
        enabled: true,
        paths: ['json:uc', 'json:negative_prompt', 'json:v4_negative_prompt.caption.base_caption'],
      },
      {
        id: 'base_caption',
        label: '场景与画风（base_caption）',
        enabled: false,
        paths: ['json:v4_prompt.caption.base_caption'],
      },
      {
        id: 'params',
        label: '生图参数',
        enabled: false,
        paths: ['json:params', 'chunk:Source'],
      },
    ],
  };
}
