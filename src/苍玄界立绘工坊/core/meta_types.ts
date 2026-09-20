import type { PngTextChunk } from './png_meta.ts';
import { chunksToMap } from './png_meta.ts';
import { parseNovelAiMeta } from './nai_parser.ts';
import { parseA1111Meta } from './a1111_parser.ts';
import { parseComfyUiMeta } from './comfyui_parser.ts';

export type ImageMetaFormat = 'novelai-v4' | 'novelai-v3' | 'a1111' | 'comfyui' | 'unknown';

/**
 * 归一化后的图片元数据。
 *
 * - `document`: 供 `json:` 路径提取的结构化数据
 * - `chunks`: 原始文本块，供 `chunk:` 路径提取
 */
export interface ImageMeta {
  format: ImageMetaFormat;
  /** 格式的中文描述，用于界面展示 */
  label: string;
  document: Record<string, unknown>;
  chunks: Record<string, string>;
}

const FORMAT_LABELS: Record<ImageMetaFormat, string> = {
  'novelai-v4': 'NovelAI V4',
  'novelai-v3': 'NovelAI V3',
  a1111: 'Stable Diffusion WebUI (A1111)',
  comfyui: 'ComfyUI',
  unknown: '未识别到元数据',
};

export function labelOfFormat(format: ImageMetaFormat): string {
  return FORMAT_LABELS[format];
}

/**
 * 依次尝试各格式解析器，返回第一个成功识别的结果。
 * 全部失败时返回 `unknown`，但仍保留原始文本块以便人工查看。
 */
export function buildImageMeta(chunks: PngTextChunk[]): ImageMeta {
  const chunkMap = chunksToMap(chunks);

  const novelai = parseNovelAiMeta(chunkMap);
  if (novelai) {
    return { format: novelai.format, label: FORMAT_LABELS[novelai.format], document: novelai.document, chunks: chunkMap };
  }

  const a1111 = parseA1111Meta(chunkMap);
  if (a1111) {
    return { format: 'a1111', label: FORMAT_LABELS.a1111, document: a1111.document, chunks: chunkMap };
  }

  const comfyui = parseComfyUiMeta(chunkMap);
  if (comfyui) {
    return { format: 'comfyui', label: FORMAT_LABELS.comfyui, document: comfyui.document, chunks: chunkMap };
  }

  return { format: 'unknown', label: FORMAT_LABELS.unknown, document: {}, chunks: chunkMap };
}
