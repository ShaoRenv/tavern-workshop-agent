/** 验证 use_json_schema 只使用用户显式提供的 JSON Schema，绝不把模板骨架当成 schema */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPortraitBatches, type GenerateRequest } from '../../src/苍玄界立绘工坊/llm/engine.ts';
import { createBuiltinTemplates, createBuiltinLlmPresets } from '../../src/苍玄界立绘工坊/llm/presets_builtin.ts';

const template = createBuiltinTemplates().find(t => t.target === 'zhihatsuki')!;
const preset = createBuiltinLlmPresets().find(p => p.target === 'zhihatsuki')!;

test('默认不带 jsonSchema（模板骨架不是 schema）', async () => {
  let seen: unknown = 'unset';
  await runPortraitBatches({
    roles: [{ name: '甲', metaText: 'x', imageUrl: '' }],
    preset: { ...preset, batch_size: 1, max_retries: 0 },
    template,
    target: 'zhihatsuki',
    existingDocument: {},
    generate: async (request: GenerateRequest) => {
      seen = request.jsonSchema;
      return JSON.stringify({ characters: { '[苍玄界]甲': { nameCN: '甲' } } });
    },
  });
  assert.equal(seen, undefined, '未开启时不应传 jsonSchema');
});

test('开启后传入的是用户填写的 schema 文本', async () => {
  let seen: unknown = 'unset';
  const schemaText = JSON.stringify({ type: 'object', properties: { characters: { type: 'object' } } });
  await runPortraitBatches({
    roles: [{ name: '甲', metaText: 'x', imageUrl: '' }],
    preset: { ...preset, batch_size: 1, max_retries: 0, use_json_schema: true },
    template: { ...template, json_schema_text: schemaText },
    target: 'zhihatsuki',
    existingDocument: {},
    generate: async (request: GenerateRequest) => {
      seen = request.jsonSchema;
      return JSON.stringify({ characters: { '[苍玄界]甲': { nameCN: '甲' } } });
    },
  });
  assert.deepEqual(seen, JSON.parse(schemaText));
});

test('schema 文本非法时降级为不传，而不是崩溃', async () => {
  let seen: unknown = 'unset';
  await runPortraitBatches({
    roles: [{ name: '甲', metaText: 'x', imageUrl: '' }],
    preset: { ...preset, batch_size: 1, max_retries: 0, use_json_schema: true },
    template: { ...template, json_schema_text: '{不是合法 JSON' },
    target: 'zhihatsuki',
    existingDocument: {},
    generate: async (request: GenerateRequest) => {
      seen = request.jsonSchema;
      return JSON.stringify({ characters: { '[苍玄界]甲': { nameCN: '甲' } } });
    },
  });
  assert.equal(seen, undefined);
});
