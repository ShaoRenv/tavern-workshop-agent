/**
 * PNG 文本块边界测试 —— 手工构造字节流，覆盖 tEXt / zTXt / iTXt 与容错路径。
 *
 * 真实立绘（NovelAI）只写 tEXt，压缩块路径此前没有覆盖，这里用 zlib 手工造数据：
 * - zTXt: keyword \0 method(1) + zlib 压缩文本
 * - iTXt: keyword \0 flag(1) method(1) langTag \0 translatedKeyword \0 text（可压缩）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  isPng,
  parsePngTextChunks,
  chunksToMap,
} from '../../src/苍玄界立绘工坊/core/png_meta.ts';
import { buildImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';
import { extractFields, createDefaultExtractRule } from '../../src/苍玄界立绘工坊/core/extractor.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const encoder = new TextEncoder();

/** 4 字节大端长度 */
const uint32BE = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** 按顺序拼接字节片段 */
function joinBytes(parts: Array<number[] | Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part as Uint8Array, offset);
    offset += part.length;
  }
  return out;
}

/** 组装一个 chunk；CRC 默认全 0，用来验证解析器不做 CRC 校验 */
function chunk(type: string, data: number[] | Uint8Array, crc: number[] = [0, 0, 0, 0]): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return joinBytes([uint32BE(bytes.length), [...type].map(char => char.charCodeAt(0)), bytes, crc]);
}

const tEXt = (keyword: string, text: string): Uint8Array =>
  chunk('tEXt', joinBytes([encoder.encode(keyword), [0], encoder.encode(text)]));

const zTXt = (keyword: string, text: string): Uint8Array =>
  chunk('zTXt', joinBytes([encoder.encode(keyword), [0], [0], zlib.deflateSync(Buffer.from(text, 'utf-8'))]));

interface ITextOptions {
  compressed?: boolean;
  language?: string;
  translated?: string;
}

const iTXt = (keyword: string, text: string, options: ITextOptions = {}): Uint8Array => {
  const { compressed = false, language = '', translated = '' } = options;
  const payload = compressed ? zlib.deflateSync(Buffer.from(text, 'utf-8')) : encoder.encode(text);
  return chunk(
    'iTXt',
    joinBytes([
      encoder.encode(keyword),
      [0],
      [compressed ? 1 : 0, 0],
      encoder.encode(language),
      [0],
      encoder.encode(translated),
      [0],
      payload,
    ]),
  );
};

const IEND = chunk('IEND', new Uint8Array(0));

/** 签名 + 给定块序列 */
const png = (...chunks: Uint8Array[]): Uint8Array => joinBytes([new Uint8Array(SIGNATURE), ...chunks]);

const mapOf = async (bytes: Uint8Array): Promise<Record<string, string>> =>
  chunksToMap(await parsePngTextChunks(bytes));

const A1111_PARAMETERS = [
  'masterpiece, 1girl',
  'Negative prompt: lowres, bad hands',
  'Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 1',
].join('\n');

// ============================================================
// tEXt
// ============================================================

test('tEXt：关键字与文本（含中文与 emoji）都能解析', async () => {
  const bytes = png(tEXt('Title', '中文标题 😀'), IEND);
  assert.equal(isPng(bytes), true);
  assert.deepEqual(await parsePngTextChunks(bytes), [{ type: 'tEXt', keyword: 'Title', text: '中文标题 😀' }]);
});

test('tEXt 缺少关键字分隔符时跳过该块而不抛异常', async () => {
  const broken = chunk('tEXt', encoder.encode('没有 NUL 分隔符'));
  const chunks = await parsePngTextChunks(png(broken, tEXt('Ok', '有值'), IEND));
  assert.deepEqual(chunks.map(item => item.keyword), ['Ok']);
});

// ============================================================
// zTXt
// ============================================================

test('zTXt：zlib 压缩文本被正确解压', async () => {
  const text = 'zTXt 里的压缩中文内容，包含换行\n第二行与 "引号" 和 emoji 😀';
  const map = await mapOf(png(zTXt('Comment', text), IEND));
  assert.equal(map['Comment'], text);
});

test('zTXt 只有关键字与压缩方法字节时返回空文本', async () => {
  const empty = chunk('zTXt', joinBytes([encoder.encode('K'), [0], [0]]));
  assert.deepEqual(await parsePngTextChunks(png(empty, IEND)), [{ type: 'zTXt', keyword: 'K', text: '' }]);
});

test('zTXt 压缩数据损坏时只跳过该块，后续块仍能解析', async () => {
  const broken = chunk('zTXt', joinBytes([encoder.encode('Bad'), [0], [0], [1, 2, 3, 4]]));
  assert.deepEqual(await mapOf(png(broken, tEXt('Ok', 'yes'), IEND)), { Ok: 'yes' });
});

// ============================================================
// iTXt
// ============================================================

test('iTXt：未压缩文本直接解析', async () => {
  assert.deepEqual(await parsePngTextChunks(png(iTXt('Description', '未压缩的提示词'), IEND)), [
    { type: 'iTXt', keyword: 'Description', text: '未压缩的提示词' },
  ]);
});

test('iTXt：压缩文本（compressionFlag=1）被正确解压', async () => {
  const text = 'iTXt 压缩内容\n含换行与中文';
  const map = await mapOf(png(iTXt('Comment', text, { compressed: true }), IEND));
  assert.equal(map['Comment'], text);
});

test('iTXt：languageTag 与 translatedKeyword 被跳过，不混入正文', async () => {
  const bytes = png(iTXt('Description', '提示词正文', { language: 'zh-CN', translated: '描述' }), IEND);
  assert.deepEqual(await parsePngTextChunks(bytes), [
    { type: 'iTXt', keyword: 'Description', text: '提示词正文' },
  ]);
});

test('iTXt 缺少 translatedKeyword 终止符时跳过该块', async () => {
  const broken = chunk('iTXt', joinBytes([encoder.encode('K'), [0], [0, 0], encoder.encode('zh'), [0]]));
  assert.deepEqual(await parsePngTextChunks(png(broken, IEND)), []);
});

// ============================================================
// 结构容错
// ============================================================

test('一个文件中混合 tEXt / zTXt / iTXt，未知块被忽略且不影响后续块', async () => {
  const unknown = chunk('juNK', encoder.encode('未知块内容'));
  const bytes = png(tEXt('A', 'a'), unknown, zTXt('B', 'b'), unknown, iTXt('C', 'c'), IEND);
  const chunks = await parsePngTextChunks(bytes);
  assert.deepEqual(
    chunks.map(item => item.type + ':' + item.keyword + '=' + item.text),
    ['tEXt:A=a', 'zTXt:B=b', 'iTXt:C=c'],
  );
});

test('IEND 之后的文本块不再解析', async () => {
  const chunks = await parsePngTextChunks(png(tEXt('A', 'a'), IEND, tEXt('After', '不应被读到')));
  assert.deepEqual(chunks.map(item => item.keyword), ['A']);
});

test('同名关键字两个块都被解析，chunksToMap 以第一个为准', async () => {
  const chunks = await parsePngTextChunks(png(tEXt('K', 'first'), tEXt('K', 'second'), IEND));
  assert.equal(chunks.length, 2, '解析阶段不应丢块');
  assert.equal(chunksToMap(chunks)['K'], 'first');
});

test('关键字含非 ASCII 且 CRC 为任意值时仍能解析（解析器不校验 CRC）', async () => {
  const custom = chunk(
    'tEXt',
    joinBytes([encoder.encode('标题'), [0], encoder.encode('内容')]),
    [0xde, 0xad, 0xbe, 0xef],
  );
  assert.deepEqual(await parsePngTextChunks(png(custom, IEND)), [
    { type: 'tEXt', keyword: '标题', text: '内容' },
  ]);
});

test('声明长度越界的块使解析安全停止，不抛异常', async () => {
  const bogus = joinBytes([uint32BE(0x7fffffff), [...'tEXt'].map(char => char.charCodeAt(0)), encoder.encode('x')]);
  assert.deepEqual(await parsePngTextChunks(png(bogus, tEXt('After', 'x'), IEND)), []);
});

test('非 PNG 数据、只有签名的数据、空数据都返回空数组', async () => {
  assert.equal(isPng(new Uint8Array(SIGNATURE)), true, '签名本身是合法 PNG 前缀');
  assert.deepEqual(await parsePngTextChunks(encoder.encode('not a png')), []);
  assert.deepEqual(await parsePngTextChunks(new Uint8Array(SIGNATURE)), []);
  assert.deepEqual(await parsePngTextChunks(new Uint8Array(0)), []);
});

test('截断的 PNG 不抛异常，返回已解析到的部分', async () => {
  const full = png(tEXt('A', 'aa'), tEXt('B', 'bb'), IEND);
  for (const length of [8, 20, 30, 40, full.length - 1]) {
    const partial = await parsePngTextChunks(full.slice(0, length));
    assert.ok(Array.isArray(partial), '截断长度 ' + length + ' 应返回数组');
  }
});

// ============================================================
// 端到端
// ============================================================

test('端到端：手工构造的 zTXt parameters PNG 能识别为 A1111 并提取提示词', async () => {
  const bytes = png(tEXt('Software', 'AUTOMATIC1111'), zTXt('parameters', A1111_PARAMETERS), IEND);
  const chunks = await parsePngTextChunks(bytes);
  const meta = buildImageMeta(chunks);
  assert.equal(meta.format, 'a1111');

  const result = extractFields(meta, createDefaultExtractRule());
  const byId = Object.fromEntries(result.fields.map(field => [field.id, field]));
  assert.equal(byId['prompt'].value, 'masterpiece, 1girl');
  assert.equal(byId['prompt'].matchedPath, 'json:prompt');
  assert.equal(byId['uc'].value, 'lowres, bad hands');
  assert.deepEqual(result.missing, ['角色DNA（char_caption）']);
});

test('端到端：手工构造的压缩 iTXt prompt PNG 能识别为 ComfyUI', async () => {
  const graph = {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres' } },
  };
  const bytes = png(tEXt('Software', 'ComfyUI'), iTXt('prompt', JSON.stringify(graph), { compressed: true }), IEND);
  const meta = buildImageMeta(await parsePngTextChunks(bytes));
  assert.equal(meta.format, 'comfyui');

  const result = extractFields(meta, createDefaultExtractRule());
  const byId = Object.fromEntries(result.fields.map(field => [field.id, field]));
  assert.equal(byId['prompt'].value, 'masterpiece, 1girl');
  assert.equal(byId['uc'].value, 'lowres');
});
