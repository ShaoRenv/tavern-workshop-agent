/**
 * 苍玄助手 · 立绘数据层（portrait）
 *
 * 这个文件把旧工程 `src/苍玄界立绘工坊/core/` 里的解析代码**原样搬了过来**
 * （旧文件全部保留不动，苍玄界立绘工坊继续可用），只做了两件事：
 *   1) 去掉模块内 import —— 现在它们是同一个文件；
 *   2) 原来直接调全局 `getScriptTrees` 的地方，改成走 storage.ts 的宿主桥。
 *
 * 下面按旧文件名分节，每节开头都标了来源文件；文件末尾是给苍玄助手用的对外接口
 * （collectCharacters / listCharacters / readPortraitMeta / parsePortraitBytes …）。
 *
 * 说明：这一层是**纯本地逻辑 + 按图床直链下载图片**，不访问任何第三方云服务。
 */
import { hostFn } from './storage.ts';

/**
 * 通过宿主桥取**脚本树**（酒馆助手专有概念）。
 *
 * ⚠️ 阶段 3.5 定案：`getScriptTrees` 在 ST 原生接口里**没有对应**。
 * 它是酒馆助手（JS-Slash-Runner）独有的抽象 —— 用于枚举「状态栏」这类脚本内嵌的图库。
 *
 * 所以扩展形态下分两种情况：
 *  - 用户**同时装了**酒馆助手 → 链的第 3 层能取到，功能照旧；
 *  - 没装 → 这里返回空数组，**明确记一次失败原因**，由 Capability 层在界面上显示
 *    「立绘图库：不可用（缺 getScriptTrees）」。
 *
 * 注释保留这段是因为：这是底座 17 个宿主依赖里**唯一一个真正需要自建/降级**的，
 * 别看到返回 [] 就以为「只是没数据」。
 */
function getScriptTreesViaHost(option: { type: string }): any[] {
  const fn = hostFn('getScriptTrees');
  if (!fn) {
    // 明确说清「不是没数据，是这个宿主没这个能力」，别让上层以为是空图库
    console.warn('[苍玄助手] 当前宿主没有 getScriptTrees（ST 原生无此能力，需装酒馆助手），脚本树图库不可用');
    return [];
  }
  try {
    const trees = fn(option);
    return Array.isArray(trees) ? trees : [];
  } catch (error) {
    console.warn('[苍玄助手] 读取脚本树失败', error);
    return [];
  }
}

/* ============================================================
 * 以下来自旧工程 core/json_util.ts（原样复制，只去掉了 import）
 * ============================================================ */

/** 宽松 JSON 解析：失败返回 null，便于对不可信元数据做容错处理 */
export function tryParseJson(text: string | undefined | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 判断是否为普通对象（排除数组与 null） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一化路径取值。
 *
 * 支持:
 * - 点号: `a.b.c`
 * - 数组下标: `a[0].b`
 * - 通配符: `a[*].b`  → 收集数组每一项的 b，用 ", " 连接
 */
export function getByPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = tokenizePath(path);
  return resolveTokens(root, tokens);
}

function tokenizePath(path: string): (string | number | '*')[] {
  const tokens: (string | number | '*')[] = [];
  for (const segment of path.split('.')) {
    const matches = segment.matchAll(/([^[\]]+)|\[(\*|\d+)\]/g);
    for (const match of matches) {
      if (match[1] !== undefined) {
        if (match[1]) tokens.push(match[1]);
      } else if (match[2] === '*') {
        tokens.push('*');
      } else if (match[2] !== undefined) {
        tokens.push(Number(match[2]));
      }
    }
  }
  return tokens;
}

function resolveTokens(current: unknown, tokens: (string | number | '*')[]): unknown {
  if (tokens.length === 0) return current;
  const [head, ...rest] = tokens;

  if (head === '*') {
    if (!Array.isArray(current)) return undefined;
    const collected: unknown[] = [];
    for (const item of current) {
      const value = resolveTokens(item, rest);
      if (value !== undefined && value !== null && value !== '') collected.push(value);
    }
    if (collected.length === 0) return undefined;
    if (collected.length === 1) return collected[0];
    return collected;
  }

  if (Array.isArray(current) && typeof head === 'number') {
    return resolveTokens(current[head], rest);
  }

  if (isPlainObject(current) && typeof head === 'string') {
    return resolveTokens(current[head], rest);
  }

  return undefined;
}

/** 把任意取值转为展示用文本；数组以 ", " 连接 */
export function toDisplayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(item => toDisplayText(item))
      .filter(text => text !== '')
      .join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
/* ============================================================
 * 以下来自旧工程 core/async_util.ts（原样复制，只去掉了 import）
 * ============================================================ */

/** 并发控制与通用异步小工具（纯逻辑，可单测） */

/**
 * 以受限并发对数组各项执行异步任务，并保持结果顺序与输入一致。
 *
 * 用于图片下载等 IO 密集场景：串行太慢，全并发又可能被图床限流。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { shouldStop?: () => boolean } = {},
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      if (options.shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  const runners: Promise<void>[] = [];
  const workerCount = Math.min(size, Math.max(items.length, 1));
  for (let index = 0; index < workerCount; index++) runners.push(run());
  await Promise.all(runners);

  return results;
}

/** 让出事件循环，便于界面刷新进度 */
export function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
/* ============================================================
 * 以下来自旧工程 core/png_meta.ts（原样复制，只去掉了 import）
 * ============================================================ */

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
/* ============================================================
 * 以下来自旧工程 core/fetch_image.ts（原样复制，只去掉了 import）
 * ============================================================ */

/**
 * 图片下载与本地读取。
 *
 * 设计要点：**只按图床直链下载图片本身**，不接触任何第三方云服务的 API。
 * 浏览器受同源策略限制，部分图床不允许跨域读取，因此这里把失败原因区分出来，
 * 交由界面提示用户改用「手动上传 PNG」这条一定能成功的路径。
 */

export interface FetchBytesResult {
  ok: boolean;
  bytes: Uint8Array | null;
  error: string;
  /** 是否疑似被跨域策略拦截 */
  corsBlocked: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 按 URL 下载图片字节。
 *
 * @param url 图片地址
 * @param proxyPrefix 可选的代理前缀，用于绕过图床的跨域限制；留空则直连
 */
export async function fetchImageBytes(url: string, proxyPrefix = ''): Promise<FetchBytesResult> {
  const target = url.trim();
  if (!target) return { ok: false, bytes: null, error: '图片地址为空', corsBlocked: false };

  const prefix = proxyPrefix.trim().replace(/\/+$/, '');
  const requestUrl = prefix ? prefix + '/' + target : target;

  try {
    const response = await fetch(requestUrl, { credentials: 'omit' });
    if (!response.ok) {
      return { ok: false, bytes: null, error: 'HTTP ' + response.status, corsBlocked: false };
    }
    const buffer = await response.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buffer), error: '', corsBlocked: false };
  } catch (error) {
    // fetch 抛 TypeError 通常就是跨域被拦或网络不可达
    return { ok: false, bytes: null, error: describeError(error), corsBlocked: true };
  }
}

/** 读取用户选择的本地文件（拖拽或文件选择），这条路径不受跨域限制 */
export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}
/* ============================================================
 * 以下来自旧工程 core/nai_parser.ts（原样复制，只去掉了 import）
 * ============================================================ */


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
/* ============================================================
 * 以下来自旧工程 core/a1111_parser.ts（原样复制，只去掉了 import）
 * ============================================================ */


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
/* ============================================================
 * 以下来自旧工程 core/comfyui_parser.ts（原样复制，只去掉了 import）
 * ============================================================ */


export interface ComfyUiMeta {
  document: Record<string, unknown>;
}

/**
 * 解析 ComfyUI 写入的 `prompt` / `workflow` 文本块。
 *
 * ComfyUI 本身不保存成品提示词字符串，只保存节点图。这里做尽力而为的提取：
 * 遍历节点，收集 `CLIPTextEncode` 类节点的 `inputs.text`，
 * 第一个非空文本视为正向提示词，其后若存在形似负向的文本则作为负向。
 */
export function parseComfyUiMeta(chunks: Record<string, string>): ComfyUiMeta | null {
  const promptJson = tryParseJson(chunks['prompt']);
  const workflowJson = tryParseJson(chunks['workflow']);

  const nodes = isPlainObject(promptJson) ? promptJson : null;
  if (!nodes) return null;

  const texts = collectClipTexts(nodes);
  if (texts.length === 0) {
    // 是 ComfyUI 图但没有可直接使用的文本节点
    return { document: { comfyui_prompt: nodes, workflow: workflowJson ?? null, texts: [] } };
  }

  const positive = texts[0];
  const negative = texts.length > 1 ? texts[texts.length - 1] : '';
  const negativeTexts = texts.length > 1 ? [negative] : [];

  return {
    document: {
      prompt: positive,
      uc: negative,
      negative_prompt: negative,
      // 分开暴露正/负向：默认提取规则的 char_caption 只应命中正向，
      // 否则角色 DNA 会把负向质量词一并拼进去。
      positive_texts: [positive],
      negative_texts: negativeTexts,
      // 保留全部文本（含负向），供用户自定义规则使用
      texts,
      comfyui_prompt: nodes,
      workflow: workflowJson ?? null,
    },
  };
}

/** 从 ComfyUI 节点图中收集文本编码节点的文本 */
function collectClipTexts(nodes: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const node of Object.values(nodes)) {
    if (!isPlainObject(node)) continue;
    const classType = String(node.class_type ?? '');
    if (!/clip.?text.?encode/i.test(classType)) continue;
    const inputs = node.inputs;
    if (!isPlainObject(inputs)) continue;
    // CLIPTextEncode 用 text；CLIPTextEncodeSDXL 用 text_g / text_l，两个都要收
    for (const key of ['text', 'text_g', 'text_l']) {
      const value = inputs[key];
      if (typeof value === 'string' && value.trim()) texts.push(value.trim());
    }
  }
  return texts;
}
/* ============================================================
 * 以下来自旧工程 core/meta_types.ts（原样复制，只去掉了 import）
 * ============================================================ */


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
/* ============================================================
 * 以下来自旧工程 core/extractor.ts（原样复制，只去掉了 import）
 * ============================================================ */


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
/* ============================================================
 * 以下来自旧工程 core/statusbar_scrape.ts（原样复制，只去掉了 import）
 * ============================================================ */

/**
 * 从状态栏脚本文本中抠出内置角色图库。
 *
 * 状态栏脚本正文里有一段 base64 编码的 HTML，真正的图库代码在其中：
 * - `const npcList = [{ name: "沈慕微", defaultImg: "https://...", portraitImg: "https://..." }, ...]`
 * - `const fixedSectMap = { "沈慕微": "天剑宗", ... }`
 *
 * 这里只做**本地文本解析**，不发起任何网络请求，也不接触创意工坊的云服务。
 */

export interface BuiltinRole {
  name: string;
  sect: string;
  defaultImg: string;
  portraitImg: string;
  source: 'statusbar_builtin';
}

/** 把 base64 按 UTF-8 解码（HTML 内含中文） */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 从脚本文本里取出被 base64 编码的 HTML。
 *
 * @param scriptText 状态栏脚本的 content 文本，或状态栏脚本 JSON 的原文
 * @returns 解码后的 HTML；找不到则返回 null
 */
export function extractEmbeddedHtml(scriptText: string): string | null {
  // 兼容两种输入：脚本 content 原文（引号为 "），以及脚本 JSON 文件原文（引号被转义为 \"）
  const match =
    scriptText.match(/STATUS_HTML_BASE64\s*=\s*"([A-Za-z0-9+/=]+)"/) ??
    scriptText.match(/STATUS_HTML_BASE64\s*=\s*\\"([A-Za-z0-9+/=]+)\\"/);
  if (!match) return null;
  try {
    return base64ToUtf8(match[1]);
  } catch {
    return null;
  }
}

/** 从形如 `{ name: "x", defaultImg: "y" }` 的对象文本里取某个字段 */
function readProperty(objectText: string, key: string): string {
  // 用字符串拼接构造正则，避免模板字符串与引号字符互相干扰
  const pattern = '\\b' + key + '\\s*:\\s*["\']([^"\']*)\\s*["\']';
  const match = objectText.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
}

/** 在文本中定位 `<marker>\s*=\s*[...]` 的数组字面量内容并返回 */
function sliceArrayLiteral(text: string, marker: string): string | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bracketStart = text.indexOf('[', start);
  if (bracketStart < 0) return null;

  let depth = 0;
  for (let i = bracketStart; i < text.length; i++) {
    const char = text[i];
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) return text.slice(bracketStart + 1, i);
    }
  }
  return null;
}

/** 解析 `fixedSectMap`，得到 角色名 -> 势力 的映射 */
export function extractSectMap(html: string): Record<string, string> {
  const start = html.indexOf('fixedSectMap');
  if (start < 0) return {};

  const braceStart = html.indexOf('{', start);
  if (braceStart < 0) return {};

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd < 0) return {};

  const body = html.slice(braceStart + 1, braceEnd);
  const map: Record<string, string> = {};
  for (const match of body.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']*)["']/g)) {
    map[match[1].trim()] = match[2].trim();
  }
  return map;
}

/**
 * 从状态栏 HTML 中解析内置角色图库。
 *
 * 解析是容错的：单个对象缺字段时跳过，不影响其他角色。
 */
export function extractBuiltinRoles(html: string): BuiltinRole[] {
  const arrayBody = sliceArrayLiteral(html, 'npcList');
  if (!arrayBody) return [];

  const sectMap = extractSectMap(html);
  const roles: BuiltinRole[] = [];

  // 以顶层 "}," 切分对象，避免嵌套结构干扰（npcList 元素是扁平对象）
  for (const rawObject of arrayBody.split(/\}\s*,/)) {
    if (!rawObject.includes('name')) continue;
    const name = readProperty(rawObject, 'name');
    if (!name) continue;

    const defaultImg = readProperty(rawObject, 'defaultImg');
    const portraitImg = readProperty(rawObject, 'portraitImg') || defaultImg;
    if (!defaultImg && !portraitImg) continue;

    roles.push({
      name,
      sect: sectMap[name] || readProperty(rawObject, 'sect') || '未知',
      defaultImg,
      portraitImg,
      source: 'statusbar_builtin',
    });
  }

  return roles;
}

/** 一步到位：从状态栏脚本文本得到内置图库 */
export function scrapeStatusbarRoles(scriptText: string): BuiltinRole[] {
  const html = extractEmbeddedHtml(scriptText);
  if (!html) return [];
  return extractBuiltinRoles(html);
}
/* ============================================================
 * 以下来自旧工程 core/gallery_source.ts（原样复制，只去掉了 import）
 * ============================================================ */

/**
 * 图库采集。
 *
 * 数据来源**全部在本机**，不访问创意工坊的 Cloudflare Worker：
 * 1. `localStorage['cx_workshop_custom_roles_v1']` —— 创意工坊同步到本地的角色
 * 2. `localStorage['cx_status_custom_roles_v1']`   —— 状态栏里手动添加的角色
 * 3. 状态栏脚本文本里内嵌的 `npcList`（基础图库）—— 纯本地文本解析
 *
 * 三者按角色名合并去重，与状态栏自身的 getMergedNpcList 行为保持一致。
 */

export type RoleSource = 'statusbar_builtin' | 'workshop' | 'statusbar_manual' | 'manual';

export interface GalleryRole {
  name: string;
  sect: string;
  /** 头像 */
  defaultImg: string;
  /** 立绘（优先用于提取元数据） */
  portraitImg: string;
  /** 角色设定文本（工坊角色可能自带） */
  profile: string;
  source: RoleSource;
}

export const WORKSHOP_ROLE_STORAGE_KEY = 'cx_workshop_custom_roles_v1';
export const STATUS_ROLE_STORAGE_KEY = 'cx_status_custom_roles_v1';
/** 状态栏脚本名，用于定位内嵌的基础图库 */
export const STATUSBAR_SCRIPT_NAME = '状态栏';

export const SOURCE_LABELS: Record<RoleSource, string> = {
  statusbar_builtin: '状态栏内置',
  workshop: '创意工坊',
  statusbar_manual: '状态栏自建',
  manual: '手动添加',
};

/** 只接受可用的图片地址 */
export function normalizeImageUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (!url) return '';
  return /^(https?:|data:image\/|blob:)/i.test(url) ? url : '';
}

/**
 * 取得宿主的 localStorage。
 *
 * ⚠️ 阶段 3.5 修正：这里原来有 parent → top → self 的**三级兜底**，
 * 那是为「面板被塞在 iframe 里、可能跨域」写的。扩展形态下**面板直接跑在酒馆页面里**，
 * parent === top === self，三级兜底是纯粹的误导性复杂度（而且每一级都要 try/catch）。
 *
 * 现在只取自身 localStorage —— 扩展与酒馆同源同窗口，这是唯一正确答案。
 * 仍然返回 null 而不是抛错：隐私模式 / 存储被禁时 localStorage 访问会抛，
 * 调用方（readStoredRoles）按「读不到」处理即可，别把立绘页整个炸掉。
 */
function hostStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (error) {
    // ⚠️ 不静默吞：读不到存储要说得出原因
    console.warn('[苍玄助手] localStorage 不可用（隐私模式？），立绘图库这次读不到', error);
    return null;
  }
}

/** 从 localStorage 读一个角色数组，容错任何异常 */
function readStoredRoles(key: string, source: RoleSource): GalleryRole[] {
  const storage = hostStorage();
  if (!storage) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(key) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const roles: GalleryRole[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    const defaultImg = normalizeImageUrl(item.defaultImg ?? item.avatar ?? item.avatarUrl);
    const portraitImg = normalizeImageUrl(item.portraitImg ?? item.portrait ?? item.portraitUrl) || defaultImg;
    if (!defaultImg && !portraitImg) continue;

    roles.push({
      name,
      sect: String(item.sect ?? item.group ?? '自定义').trim() || '自定义',
      defaultImg,
      portraitImg,
      profile: String(item.profile ?? item.lore ?? item.setting ?? item.description ?? ''),
      source,
    });
  }
  return roles;
}

/** 读取创意工坊同步到本地的角色 */
export function readWorkshopRoles(): GalleryRole[] {
  return readStoredRoles(WORKSHOP_ROLE_STORAGE_KEY, 'workshop');
}

/** 读取状态栏手动添加的角色 */
export function readStatusManualRoles(): GalleryRole[] {
  return readStoredRoles(STATUS_ROLE_STORAGE_KEY, 'statusbar_manual');
}

function toGalleryRole(role: BuiltinRole): GalleryRole {
  return {
    name: role.name,
    sect: role.sect,
    defaultImg: role.defaultImg,
    portraitImg: role.portraitImg || role.defaultImg,
    profile: '',
    source: 'statusbar_builtin',
  };
}

/** 在酒馆助手脚本树中查找状态栏脚本的正文 */
export function findStatusbarScriptText(): string {
  const optionTypes: Array<'global' | 'preset' | 'character'> = ['character', 'global', 'preset'];

  for (const type of optionTypes) {
    try {
      const trees = getScriptTreesViaHost({ type });
      for (const node of trees) {
        const scripts = 'scripts' in node && Array.isArray(node.scripts) ? node.scripts : [node];
        for (const script of scripts) {
          if (!script || typeof script !== 'object' || script.type !== 'script') continue;
          if (script.name === STATUSBAR_SCRIPT_NAME && typeof script.content === 'string') {
            return script.content;
          }
        }
      }
    } catch {
      /* 该类型不可用时继续尝试下一种 */
    }
  }
  return '';
}

/** 读取状态栏脚本内嵌的基础图库 */
export function readBuiltinRoles(): GalleryRole[] {
  const text = findStatusbarScriptText();
  if (!text) return [];
  return scrapeStatusbarRoles(text).map(toGalleryRole);
}

/**
 * 汇总全部图库。
 *
 * 合并优先级（后者覆盖前者）: 内置 < 创意工坊 < 状态栏自建。
 * 与状态栏 getMergedNpcList 的覆盖方向一致。
 */
export function collectGallery(): { roles: GalleryRole[]; warnings: string[] } {
  const warnings: string[] = [];
  const map = new Map<string, GalleryRole>();

  const builtin = readBuiltinRoles();
  if (builtin.length === 0) {
    warnings.push('未找到状态栏脚本或其内嵌图库，基础图库为空（可手动粘贴 URL 补充）');
  }
  for (const role of builtin) map.set(role.name, role);

  const workshop = readWorkshopRoles();
  for (const role of workshop) map.set(role.name, role);

  const manual = readStatusManualRoles();
  for (const role of manual) map.set(role.name, role);

  return { roles: [...map.values()], warnings };
}

/** 取用于提取元数据的图片地址：优先立绘，其次头像 */
export function pickImageUrl(role: GalleryRole): string {
  return role.portraitImg || role.defaultImg;
}
/* ============================ 对外接口（苍玄助手用这套） ============================ */

/** 图库角色 + 提取元数据要用的图地址 */
export interface GalleryCharacter extends GalleryRole {
  /** 提取元数据用的图地址（优先立绘，其次头像；可能为空 = 该角色只有文字设定） */
  imageUrl: string;
}

export interface GallerySnapshot {
  characters: GalleryCharacter[];
  /** 采集过程中的提示（例如没找到状态栏脚本），界面可直接显示 */
  warnings: string[];
}

/**
 * 采集全部可选角色：状态栏内置 → 创意工坊 → 状态栏自建（后者覆盖前者）。
 *
 * 纯本地读取，不发起网络请求。同步函数：酒馆助手的 getScriptTrees 本来就是同步的。
 */
export function collectCharacters(): GallerySnapshot {
  const { roles, warnings } = collectGallery();
  return {
    warnings,
    characters: roles.map(role => ({ ...role, imageUrl: pickImageUrl(role) })),
  };
}

/** 只要角色列表（界面列表 / 工具参数用） */
export function listCharacters(): GalleryCharacter[] {
  return collectCharacters().characters;
}

/** 按角色名找一条（重名时取合并后的那一条，与图库一致） */
export function findCharacter(name: string): GalleryCharacter | null {
  const target = String(name ?? '').trim();
  if (!target) return null;
  return listCharacters().find(character => character.name === target) ?? null;
}

/* ---------------------------- 元数据解析结果 ---------------------------- */

export interface PortraitMetaResult {
  /** 解析是否成功（有 PNG 且能读到字节就算走到这一步） */
  ok: boolean;
  /** 角色名（批量解析时对应回去用） */
  name: string;
  /** 实际用的图片地址；本地上传时为空串 */
  url: string;
  /** 失败原因（ok=true 时为空串） */
  error: string;
  /** 是否疑似被跨域策略拦截：界面据此提示改用「上传本地 PNG」 */
  corsBlocked: boolean;
  /** 归一化元数据（novelai-v4/v3、a1111、comfyui、unknown） */
  meta?: ImageMeta;
  /** 按提取规则渲染出的字段与文本 */
  extracted?: ExtractResult;
  /** PNG 里实际存在的文本块关键字，方便排查「有图但没元数据」 */
  chunkKeys: string[];
}

function failedResult(name: string, url: string, error: string, corsBlocked: boolean): PortraitMetaResult {
  return { ok: false, name, url, error, corsBlocked, chunkKeys: [] };
}

/** 解析本机 PNG 字节：上传路径与下载路径共用这一条链路 */
export async function parsePortraitBytes(
  bytes: Uint8Array,
  options: { name?: string; url?: string; rule?: ExtractRule } = {},
): Promise<PortraitMetaResult> {
  const name = options.name ?? '';
  const url = options.url ?? '';

  if (!isPng(bytes)) {
    return failedResult(name, url, '这不是 PNG 文件（缺少 PNG 签名）', false);
  }

  const rule = options.rule ?? createDefaultExtractRule();
  const chunks = await parsePngTextChunks(bytes);
  const meta = buildImageMeta(chunks);

  return {
    ok: true,
    name,
    url,
    error: '',
    corsBlocked: false,
    meta,
    extracted: extractFields(meta, rule),
    chunkKeys: Object.keys(meta.chunks),
  };
}

/**
 * 读某个角色的立绘图元数据。
 *
 * 流程：图库取地址 → 按直链下载 PNG → 解析文本块 → 按规则提取 → 返回结构化结果。
 * 跨域被拦时 corsBlocked = true，界面应提示用户改用 `readPortraitMetaFromFile`。
 *
 * @param name 角色名（在 listCharacters() 里查图地址）
 * @param options.imageUrl 直接指定图片地址（覆盖图库里的地址）
 * @param options.rule 自定义提取规则，默认是 char_caption + prompt
 * @param options.proxyPrefix 可选图片代理前缀；留空则直连图床
 */
export async function readPortraitMeta(
  name: string,
  options: { imageUrl?: string; rule?: ExtractRule; proxyPrefix?: string } = {},
): Promise<PortraitMetaResult> {
  const character = findCharacter(name);
  const url = String(options.imageUrl ?? character?.imageUrl ?? '').trim();

  if (!url) {
    return failedResult(name, '', '没有可用的图片地址（该角色只有文字设定）', false);
  }

  const fetched = await fetchImageBytes(url, options.proxyPrefix ?? '');
  if (!fetched.ok || !fetched.bytes) {
    return failedResult(name, url, fetched.error || '图片下载失败', fetched.corsBlocked);
  }

  return parsePortraitBytes(fetched.bytes, { name, url, rule: options.rule });
}

/**
 * 解析用户上传的本地 PNG 文件。
 *
 * 这条路径不受跨域限制，**一定**能读到图床二次压缩后仍在的元数据，
 * 是界面上的兜底手段。
 */
export async function readPortraitMetaFromFile(
  file: File,
  name = '',
  options: { rule?: ExtractRule } = {},
): Promise<PortraitMetaResult> {
  try {
    const bytes = await readFileAsBytes(file);
    return parsePortraitBytes(bytes, { name: name || file.name, url: '', rule: options.rule });
  } catch (error) {
    return failedResult(name || file.name, '', error instanceof Error ? error.message : String(error), false);
  }
}

/**
 * 批量解析多个角色（并发受限，避免被图床限流）。
 *
 * @param names 角色名列表
 * @param options.concurrency 并发数，默认 4
 * @param options.shouldStop 返回 true 时不再取新任务（用户点「停止」）；
 *   被中止时**只返回已经跑完的结果**（不会留空洞），下游按 result.name 对应回角色
 * @param options.onOne 每完成一个就回调一次，界面靠它实时更新进度
 */
export async function readPortraitsMeta(
  names: string[],
  options: {
    concurrency?: number;
    rule?: ExtractRule;
    proxyPrefix?: string;
    shouldStop?: () => boolean;
    onOne?: (result: PortraitMetaResult, index: number) => void;
  } = {},
): Promise<PortraitMetaResult[]> {
  const limit = Math.max(1, Math.floor(options.concurrency ?? 4) || 4);
  const results = await mapWithConcurrency(
    names,
    limit,
    async (name, index) => {
      const result = await readPortraitMeta(name, { rule: options.rule, proxyPrefix: options.proxyPrefix });
      options.onOne?.(result, index);
      return result;
    },
    { shouldStop: options.shouldStop },
  );
  // 被中止时后面的槽位是空的，过滤掉，别把 undefined 丢给界面
  return results.filter((item): item is PortraitMetaResult => item !== undefined);
}

/** 把解析结果里「命中/未命中」的字段拼成一行给人看的摘要（界面用） */
export function describePortraitResult(result: PortraitMetaResult): string {
  if (!result.ok) return result.corsBlocked ? '跨域被拦截，请改用「上传」本地 PNG' : '解析失败：' + result.error;
  const format = result.meta?.label ?? '未知格式';
  const missing = result.extracted?.missing ?? [];
  if (result.chunkKeys.length === 0) return format + ' · PNG 里没有文本块（图床可能已剥离元数据）';
  if (missing.length === 0) return format + ' · ' + result.chunkKeys.length + ' 个文本块，字段齐全';
  return format + ' · ' + result.chunkKeys.length + ' 个文本块，缺：' + missing.join('、');
}
