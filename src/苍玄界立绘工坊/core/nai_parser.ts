import { isPlainObject, tryParseJson } from './json_util.ts';

export interface NovelAiMeta {
  format: 'novelai-v4' | 'novelai-v3';
  document: Record<string, unknown>;
}

/**
 * 解析 NovelAI 图片元数据。
 *
 * NovelAI 把生成参数写成 `Comment` 文本块中的 JSON，另把正向提示词同时写入 `Description`。
 * - V4 及以后: JSON 内含 `v4_prompt.caption.char_captions`（角色 DNA）与 `v4_negative_prompt`
 * - V3: JSON 内含 `prompt` / `uc`，无 `v4_prompt`
 *
 * @param chunks 文本块映射
 * @returns 解析结果；若不含 NovelAI 特征则返回 null
 */
export function parseNovelAiMeta(chunks: Record<string, string>): NovelAiMeta | null {
  const software = (chunks['Software'] ?? '').toLowerCase();
  const source = chunks['Source'] ?? '';
  const title = (chunks['Title'] ?? '').toLowerCase();
  const comment = tryParseJson(chunks['Comment']);

  const looksLikeNovelAi =
    software.includes('novelai') ||
    source.toLowerCase().includes('novelai') ||
    title.includes('novelai') ||
    title.includes('generated image') ||
    (isPlainObject(comment) && ('uc' in comment || 'v4_prompt' in comment));

  if (!looksLikeNovelAi) return null;

  const document: Record<string, unknown> = isPlainObject(comment) ? { ...comment } : {};

  // Description 是 NovelAI 写入的正向提示词；Comment 缺失时它是唯一的提示词来源
  if (typeof chunks['Description'] === 'string' && chunks['Description']) {
    if (typeof document.prompt !== 'string' || !document.prompt) {
      document.prompt = chunks['Description'];
    }
    document.description = chunks['Description'];
  }
  if (source) document.source = source;
  if (chunks['Software']) document.software = chunks['Software'];

  // 扁平化 char_captions，便于默认提取规则与自定义规则都能简单命中
  const charCaptions = collectCharCaptions(document);
  if (charCaptions.length > 0) document.char_captions = charCaptions;

  // 归一化生图参数，使跨格式的默认提取规则可以统一命中 `json:params`
  document.params = collectNovelAiParams(document);

  const isV4 = Boolean(document.v4_prompt) || /v4/i.test(source);
  return { format: isV4 ? 'novelai-v4' : 'novelai-v3', document };
}

/** 收集生图参数，输出跨格式一致的字段名 */
function collectNovelAiParams(document: Record<string, unknown>): Record<string, unknown> {
  const keys = ['steps', 'scale', 'cfg_rescale', 'seed', 'width', 'height', 'sampler', 'noise_schedule', 'n_samples'];
  const params: Record<string, unknown> = {};
  for (const key of keys) {
    if (document[key] !== undefined) params[key] = document[key];
  }
  return params;
}

/** 从 V4 结构里收集所有角色 DNA 描述 */
export function collectCharCaptions(document: Record<string, unknown>): string[] {
  const v4Prompt = document.v4_prompt;
  if (!isPlainObject(v4Prompt)) return [];
  const caption = v4Prompt.caption;
  if (!isPlainObject(caption)) return [];
  const charCaptions = caption.char_captions;
  if (!Array.isArray(charCaptions)) return [];

  const result: string[] = [];
  for (const item of charCaptions) {
    if (!isPlainObject(item)) continue;
    const text = item.char_caption;
    if (typeof text === 'string' && text.trim()) result.push(text.trim());
  }
  return result;
}
