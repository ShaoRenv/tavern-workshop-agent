/**
 * PNG 元数据解析 —— 纯逻辑，无依赖，可在 Node 与浏览器中运行。
 *
 * PNG 结构: 8 字节签名 + 若干 chunk
 * 每个 chunk: length(4, 大端) + type(4, ASCII) + data(length) + crc(4)
 *
 * 需要解析的文本块:
 * - tEXt: keyword \0 text            (keyword 与 text 均为 Latin-1，但现代工具常写 UTF-8)
 * - zTXt: keyword \0 method(1) + zlib 压缩文本
 * - iTXt: keyword \0 flag(1) method(1) langTag \0 translatedKeyword \0 text(UTF-8，可能压缩)
 */

export type PngTextChunkType = 'tEXt' | 'zTXt' | 'iTXt';

export interface PngTextChunk {
  type: PngTextChunkType;
  keyword: string;
  text: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 判断字节流是否为 PNG（校验 8 字节签名） */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** zlib 解压。浏览器与 Node 18+ 均提供 DecompressionStream。 */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream，无法解压 zTXt/iTXt 压缩块');
  }
  // 复制出独立的 ArrayBuffer，避免 Uint8Array<ArrayBufferLike> 与 BodyInit 的类型冲突
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 在 [start, end) 中查找第一个 0x00，返回其下标；找不到返回 -1 */
function indexOfNull(bytes: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let result = '';
  for (let i = start; i < start + length; i++) result += String.fromCharCode(bytes[i]);
  return result;
}

/**
 * 解析 PNG 中所有文本块。
 *
 * 对损坏或非 PNG 数据不抛异常，而是返回已成功解析的部分（容忍度优先）。
 */
export async function parsePngTextChunks(bytes: Uint8Array): Promise<PngTextChunk[]> {
  const chunks: PngTextChunk[] = [];
  if (!isPng(bytes)) return chunks;

  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // 数据越界说明文件被截断，停止解析
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      try {
        const chunk = await parseTextChunk(type as PngTextChunkType, bytes, dataStart, dataEnd);
        if (chunk) chunks.push(chunk);
      } catch {
        // 单个块解析失败不影响其他块
      }
    }

    if (type === 'IEND') break;
    // chunk 总长 = length + type(4) + length(4) + crc(4)
    offset = dataEnd + 4;
  }

  return chunks;
}

async function parseTextChunk(
  type: PngTextChunkType,
  bytes: Uint8Array,
  dataStart: number,
  dataEnd: number,
): Promise<PngTextChunk | null> {
  const keywordEnd = indexOfNull(bytes, dataStart, dataEnd);
  if (keywordEnd < 0) return null;
  const keyword = decodeUtf8(bytes.subarray(dataStart, keywordEnd));

  if (type === 'tEXt') {
    // 规范上为 Latin-1，但 NovelAI 等工具实际写入 UTF-8，故按 UTF-8 解码
    return { type, keyword, text: decodeUtf8(bytes.subarray(keywordEnd + 1, dataEnd)) };
  }

  if (type === 'zTXt') {
    const compressedStart = keywordEnd + 2; // 跳过关键字后的 \0 与压缩方法字节
    if (compressedStart >= dataEnd) return { type, keyword, text: '' };
    const text = decodeUtf8(await inflateZlib(bytes.subarray(compressedStart, dataEnd)));
    return { type, keyword, text };
  }

  // iTXt: compressionFlag(1) compressionMethod(1) languageTag\0 translatedKeyword\0 text
  const flag = bytes[keywordEnd + 1];
  const languageEnd = indexOfNull(bytes, keywordEnd + 3, dataEnd);
  if (languageEnd < 0) return null;
  const translatedEnd = indexOfNull(bytes, languageEnd + 1, dataEnd);
  if (translatedEnd < 0) return null;
  const textStart = translatedEnd + 1;
  const raw = bytes.subarray(textStart, dataEnd);
  const text = flag === 1 ? decodeUtf8(await inflateZlib(raw)) : decodeUtf8(raw);
  return { type, keyword, text };
}

/** 把文本块数组转成 keyword -> text 的映射，同名块以第一个为准 */
export function chunksToMap(chunks: PngTextChunk[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const chunk of chunks) {
    if (!(chunk.keyword in map)) map[chunk.keyword] = chunk.text;
  }
  return map;
}
