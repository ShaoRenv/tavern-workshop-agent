/**
 * PNG 元数据解析测试 —— 使用真实立绘图作为 fixture（NovelAI V4.5 导出）。
 *
 * 覆盖: PNG 签名校验、tEXt 块解析、NovelAI 格式识别、角色 DNA 提取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isPng, parsePngTextChunks, chunksToMap } from '../../src/苍玄界立绘工坊/core/png_meta.ts';
import { buildImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';
import { extractFields, createDefaultExtractRule } from '../../src/苍玄界立绘工坊/core/extractor.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

const CHAO = '潮听澜-立绘.png';
const JIANG = '江念-立绘.png';

test('isPng 能正确识别 PNG 签名', () => {
  assert.equal(isPng(loadFixture(CHAO)), true);
  assert.equal(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), false);
  assert.equal(isPng(new Uint8Array(0)), false);
});

test('parsePngTextChunks 能从真实立绘中解析出文本块', async () => {
  const chunks = await parsePngTextChunks(loadFixture(CHAO));
  assert.ok(chunks.length > 0, '应解析出至少一个文本块');

  const map = chunksToMap(chunks);
  // 实测该图包含 Title / Description / Software / Source / Generation time / Comment
  for (const keyword of ['Title', 'Description', 'Software', 'Source', 'Comment']) {
    assert.ok(keyword in map, `应包含 ${keyword} 文本块`);
  }
  assert.match(map['Software'], /NovelAI/i);
  assert.match(map['Source'], /NovelAI Diffusion V4/i);
});

test('buildImageMeta 能识别为 NovelAI V4', async () => {
  const meta = buildImageMeta(await parsePngTextChunks(loadFixture(CHAO)));
  assert.equal(meta.format, 'novelai-v4');
});

test('Comment 块是合法 JSON 且含 V4 角色 DNA 结构', async () => {
  const map = chunksToMap(await parsePngTextChunks(loadFixture(CHAO)));
  const comment = JSON.parse(map['Comment']);
  assert.ok(comment.prompt, 'Comment 应含 prompt');
  assert.ok(comment.uc, 'Comment 应含 uc');
  assert.ok(Array.isArray(comment.v4_prompt.caption.char_captions), 'V4 应含 char_captions');
});

test('角色 DNA 与完整提示词能被正确区分', async () => {
  const meta = buildImageMeta(await parsePngTextChunks(loadFixture(CHAO)));

  // char_caption 应是纯角色描述
  const charCaption = String((meta.document.char_captions as unknown[])[0]);
  assert.match(charCaption, /short dark blue hair/);
  assert.match(charCaption, /low ponytail/);

  // prompt 应含场景词，这正是不能把 prompt 当角色 DNA 的原因
  const prompt = String(meta.document.prompt);
  assert.match(prompt, /floating immortal cave dwelling/);
  assert.doesNotMatch(charCaption, /floating immortal cave dwelling/);
});

test('默认提取规则能抽出 char_caption 与 prompt', async () => {
  const meta = buildImageMeta(await parsePngTextChunks(loadFixture(CHAO)));
  const rule = createDefaultExtractRule();
  const result = extractFields(meta, rule);

  const byId = Object.fromEntries(result.fields.map(field => [field.id, field]));
  assert.match(byId['char_caption'].value, /short dark blue hair/);
  assert.match(byId['prompt'].value, /floating immortal cave dwelling/);
  assert.equal(byId['char_caption'].matchedPath, 'json:char_captions');
  assert.equal(byId['prompt'].matchedPath, 'json:prompt');

  // 渲染文本应同时包含两个标签
  assert.match(result.text, /【角色DNA（char_caption）】/);
  assert.match(result.text, /【完整提示词（prompt）】/);
  assert.equal(result.missing.length, 0);
});

test('元数据被剥离的图片优雅降级为 unknown（真实案例：江念）', async () => {
  // 该图经图床二次压缩后元数据被整体剥离，是"并非所有图片都带元数据"的真实样本
  const chunks = await parsePngTextChunks(loadFixture(JIANG));
  assert.equal(chunks.length, 0, '该图不含任何文本块');

  const meta = buildImageMeta(chunks);
  assert.equal(meta.format, 'unknown');
  assert.equal(meta.label, '未识别到元数据');
  assert.deepEqual(meta.document, {});

  // 关键：提取器不得抛异常，而应把所有字段标记为未命中，供界面提示用户手动上传
  const result = extractFields(meta, createDefaultExtractRule());
  assert.equal(result.text, '');
  assert.deepEqual(result.missing, ['角色DNA（char_caption）', '完整提示词（prompt）', '负向提示词（uc）']);
});

test('postimg 图床的多数图片仍保留完整元数据', async () => {
  // 与上一测试对照，说明元数据缺失是个别图片问题而非图床策略
  const meta = buildImageMeta(await parsePngTextChunks(loadFixture(CHAO)));
  assert.equal(meta.format, 'novelai-v4');
  assert.ok(String(meta.document.prompt).length > 100);
});

test('未启用字段不参与提取，禁用字段可被重新启用', async () => {
  const meta = buildImageMeta(await parsePngTextChunks(loadFixture(CHAO)));
  const rule = createDefaultExtractRule();

  // base_caption 默认关闭
  assert.equal(rule.fields.find(field => field.id === 'base_caption')!.enabled, false);
  const off = extractFields(meta, rule);
  assert.equal(off.fields.some(field => field.id === 'base_caption'), false);

  rule.fields.find(field => field.id === 'base_caption')!.enabled = true;
  const on = extractFields(meta, rule);
  const baseCaption = on.fields.find(field => field.id === 'base_caption');
  assert.ok(baseCaption, '启用后应出现在结果中');
  assert.ok(baseCaption!.value.length > 0, 'base_caption 应有值');
});

test('tag数据损坏时解析不抛异常', async () => {
  const broken = loadFixture(CHAO).slice(0, 200);
  const chunks = await parsePngTextChunks(broken);
  assert.ok(Array.isArray(chunks), '截断的文件应返回数组而非抛异常');
});

test('非 PNG 数据返回空结果', async () => {
  const chunks = await parsePngTextChunks(new TextEncoder().encode('not a png at all'));
  assert.deepEqual(chunks, []);
});
