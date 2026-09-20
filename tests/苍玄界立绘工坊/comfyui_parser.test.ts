/**
 * ComfyUI 节点图（PNG 的 prompt / workflow 文本块）解析测试。
 *
 * 覆盖：含 CLIPTextEncode 的节点图取正向/负向、无文本节点、非 JSON、
 * 单测节点文本类型容错、节点遍历顺序，以及与 buildImageMeta / 提取器的协作。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseComfyUiMeta } from '../../src/苍玄界立绘工坊/core/comfyui_parser.ts';
import { buildImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';
import { extractFields, createDefaultExtractRule } from '../../src/苍玄界立绘工坊/core/extractor.ts';

/** 一份典型的文生图节点图（API 形态） */
const GRAPH: Record<string, unknown> = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'animagineXL.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl, silver hair', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad hands', clip: ['4', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 28 } },
  '9': { class_type: 'SaveImage', inputs: {} },
};
const WORKFLOW = { last_node_id: 9, nodes: [] as unknown[] };

/** 把节点图塞进 prompt 文本块 */
const chunksWithGraph = (graph: unknown): Record<string, string> => ({ prompt: JSON.stringify(graph) });

test('含 CLIPTextEncode 的节点图能取出正向与负向文本', () => {
  const meta = parseComfyUiMeta(chunksWithGraph(GRAPH));
  assert.ok(meta, '应能解析出 ComfyUI 元数据');

  const doc = meta!.document;
  assert.equal(doc.prompt, 'masterpiece, 1girl, silver hair');
  assert.equal(doc.uc, 'lowres, bad hands');
  assert.equal(doc.negative_prompt, doc.uc);
  assert.deepEqual(doc.texts, ['masterpiece, 1girl, silver hair', 'lowres, bad hands']);
  assert.deepEqual(doc.comfyui_prompt, GRAPH, '原始节点图应完整保留');
});

test('prompt 与 workflow 文本块同时存在时都被解析', () => {
  const meta = parseComfyUiMeta({ prompt: JSON.stringify(GRAPH), workflow: JSON.stringify(WORKFLOW) })!;
  assert.deepEqual(meta.document.workflow, WORKFLOW);
});

test('数字字符串节点键按节点号升序遍历，正向取 2 号、负向取 10 号', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '10': { class_type: 'CLIPTextEncode', inputs: { text: 'negative text' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'positive text' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['positive text', 'negative text']);
  assert.equal(meta.document.prompt, 'positive text');
  assert.equal(meta.document.uc, 'negative text');
});

test('class_type 大小写与空格变体都能匹配', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '1': { class_type: 'clip text encode', inputs: { text: 'variant a' } },
      '2': { class_type: 'CLIPTextEncoder', inputs: { text: 'variant b' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['variant a', 'variant b']);
});

test('class_type 非字符串（数字）时不会误判，也不会抛异常', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '1': { class_type: 5, inputs: { text: '不应命中' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '应命中' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['应命中']);
});

test('没有 CLIPTextEncode 节点：texts 为空数组且不产生 prompt 字段', () => {
  const graph = { '1': { class_type: 'KSampler', inputs: { seed: 1 } } };
  const meta = parseComfyUiMeta(chunksWithGraph(graph));
  assert.ok(meta, '是 ComfyUI 图，即使没有文本节点也应返回结果');
  assert.deepEqual(meta!.document.texts, []);
  assert.equal('prompt' in meta!.document, false);
  assert.equal('uc' in meta!.document, false);
  assert.deepEqual(meta!.document.comfyui_prompt, graph, '节点图仍应保留供人工查看');
});

test('只有 workflow 没有 prompt 时返回 null（无法从中取文本）', () => {
  assert.equal(parseComfyUiMeta({ workflow: JSON.stringify(WORKFLOW) }), null);
});

test('prompt 不是 JSON / 是数组 / 是标量 / 为空时都返回 null', () => {
  assert.equal(parseComfyUiMeta({ prompt: '这不是 JSON' }), null);
  assert.equal(parseComfyUiMeta({ prompt: '[1,2,3]' }), null);
  assert.equal(parseComfyUiMeta({ prompt: '42' }), null);
  assert.equal(parseComfyUiMeta({ prompt: '"字符串"' }), null);
  assert.equal(parseComfyUiMeta({ prompt: '' }), null);
  assert.equal(parseComfyUiMeta({}), null);
});

test('workflow 损坏时不影响 prompt 的解析', () => {
  const meta = parseComfyUiMeta({ prompt: JSON.stringify(GRAPH), workflow: '{坏 JSON' })!;
  assert.equal(meta.document.prompt, 'masterpiece, 1girl, silver hair');
  assert.equal(meta.document.workflow, null);
});

test('空文本 / 非字符串 text / inputs 非对象 / 缺 inputs 的节点都被忽略', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '   ' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 123 } },
      '4': { class_type: 'CLIPTextEncode', inputs: 5 },
      '5': { class_type: 'CLIPTextEncode' },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '唯一有效文本' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['唯一有效文本']);
  assert.equal(meta.document.prompt, '唯一有效文本');
  assert.equal(meta.document.uc, '', '只有一个文本节点时负向为空串');
});

test('节点值不是对象（数组 / null）时跳过', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '1': [1, 2, 3],
      '2': null,
      '3': { class_type: 'CLIPTextEncode', inputs: { text: ' 有效 ' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['有效'], '文本应被 trim');
});

test('三个文本节点时正向取第一个、负向取最后一个（中间节点被忽略）', () => {
  const meta = parseComfyUiMeta(
    chunksWithGraph({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'pos' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'mid' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'neg' } },
    }),
  )!;
  assert.deepEqual(meta.document.texts, ['pos', 'mid', 'neg'], '全部文本仍保留在 texts 里');
  assert.equal(meta.document.prompt, 'pos');
  assert.equal(meta.document.uc, 'neg');
});

test('CLIPTextEncodeSDXL 的 text_g / text_l 能被取到', () => {
  // 回归：SDXL 双文本节点用 text_g / text_l 而不是 text，早期实现只认 inputs.text 导致取不到
  const meta = parseComfyUiMeta(
    chunksWithGraph({ '6': { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'global', text_l: 'local' } } }),
  )!;
  assert.deepEqual(meta.document.texts, ['global', 'local']);
  assert.equal(meta.document.prompt, 'global');
});

test('buildImageMeta 识别 ComfyUI 并保留文本块映射', () => {
  const meta = buildImageMeta([{ type: 'tEXt', keyword: 'prompt', text: JSON.stringify(GRAPH) }]);
  assert.equal(meta.format, 'comfyui');
  assert.equal(meta.label, 'ComfyUI');
  assert.equal(meta.chunks['prompt'], JSON.stringify(GRAPH));
});

test('只有 workflow 文本块时 buildImageMeta 判定为 unknown', () => {
  const meta = buildImageMeta([{ type: 'tEXt', keyword: 'workflow', text: JSON.stringify(WORKFLOW) }]);
  assert.equal(meta.format, 'unknown');
});

test('没有文本节点的 ComfyUI 图仍被识别为 comfyui（供界面提示手动处理）', () => {
  const meta = buildImageMeta([
    { type: 'tEXt', keyword: 'prompt', text: JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }) },
  ]);
  assert.equal(meta.format, 'comfyui');
  assert.deepEqual(meta.document.texts, []);
});

test('默认提取规则复用 ComfyUI 的 prompt / uc，且 char_caption 只取正向', () => {
  const meta = buildImageMeta([{ type: 'tEXt', keyword: 'prompt', text: JSON.stringify(GRAPH) }]);
  const result = extractFields(meta, createDefaultExtractRule());
  const byId = Object.fromEntries(result.fields.map(field => [field.id, field]));

  assert.equal(byId['prompt'].value, 'masterpiece, 1girl, silver hair');
  assert.equal(byId['prompt'].matchedPath, 'json:prompt');
  assert.equal(byId['uc'].value, 'lowres, bad hands');
  assert.equal(byId['uc'].matchedPath, 'json:uc');

  // 回归：早期 char_caption 的候选路径是 json:texts，会把负向质量词一并拼进角色 DNA
  assert.equal(byId['char_caption'].matchedPath, 'json:positive_texts');
  assert.equal(byId['char_caption'].value, 'masterpiece, 1girl, silver hair');
  assert.doesNotMatch(byId['char_caption'].value, /lowres/, '角色 DNA 不得混入负向提示词');
  assert.deepEqual(result.missing, []);
});
