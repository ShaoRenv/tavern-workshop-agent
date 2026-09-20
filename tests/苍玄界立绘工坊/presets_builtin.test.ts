/**
 * 内置预设与模板的测试。
 *
 * 重点验证 zod 模型能正确解析、模板骨架是合法 JSON、预设引用的模板/规则都真实存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBuiltinTemplates,
  createBuiltinLlmPresets,
  createBuiltinMetaExtractRules,
  createBuiltinWorldbookPresets,
} from '../../src/苍玄界立绘工坊/llm/presets_builtin.ts';
import {
  JsonTemplateSchema,
  LlmPresetSchema,
  WorldbookPresetSchema,
  WorkshopDataSchema,
} from '../../src/苍玄界立绘工坊/llm/schema.ts';

test('内置模板有两套，且骨架都是合法 JSON', () => {
  const templates = createBuiltinTemplates();
  assert.equal(templates.length, 2);

  const ids = templates.map(t => t.id);
  assert.deepEqual(ids, ['tpl-zhihatsuki', 'tpl-xiaobaix']);

  for (const template of templates) {
    assert.doesNotThrow(() => JSON.parse(template.skeleton), template.name + ' 的骨架应是合法 JSON');
    assert.ok(template.schema_note.length > 0, template.name + ' 应有格式说明');
  }
});

test('智绘姬模板骨架包含实测的全部部位字段', () => {
  const template = createBuiltinTemplates().find(t => t.target === 'zhihatsuki')!;
  const skeleton = JSON.parse(template.skeleton);
  assert.equal(template.merge_mode, 'object_map');
  assert.equal(template.key_prefix, '[苍玄界]');

  const character = Object.values(skeleton.characters)[0] as Record<string, unknown>;
  for (const field of [
    'nameCN', 'nameEN', 'characterTraits',
    'facialFeatures', 'facialFeaturesBack',
    'upperBodySFW', 'upperBodySFWBack',
    'fullBodySFW', 'fullBodySFWBack',
    'upperBodyNSFW', 'upperBodyNSFWBack',
    'fullBodyNSFW', 'fullBodyNSFWBack',
    'outfits', 'negative', 'mediaSchemaVersion',
  ]) {
    assert.ok(field in character, '骨架应含字段 ' + field);
  }

  const outfit = Object.values(skeleton.outfits)[0] as Record<string, unknown>;
  for (const field of ['nameCN', 'nameEN', 'owner', 'upperBody', 'fullBody']) {
    assert.ok(field in outfit, '服装骨架应含字段 ' + field);
  }
});

test('小白x 模板骨架包含实测字段且 merge_mode 为数组追加', () => {
  const template = createBuiltinTemplates().find(t => t.target === 'xiaobaix')!;
  const skeleton = JSON.parse(template.skeleton);
  assert.equal(template.merge_mode, 'array_push');
  assert.equal(skeleton.type, 'novel-draw-characters');
  assert.equal(skeleton.version, 3);
  assert.ok(Array.isArray(skeleton.characters));

  const character = skeleton.characters[0];
  for (const field of ['id', 'name', 'aliases', 'type', 'appearance', 'negativeTags', 'danbooruTag', 'outfits']) {
    assert.ok(field in character, '骨架应含字段 ' + field);
  }
  assert.ok(Array.isArray(character.outfits) && 'name' in character.outfits[0] && 'tags' in character.outfits[0]);
});

test('内置元数据提取规则默认含 char_caption 与 prompt 且都启用', () => {
  const rules = createBuiltinMetaExtractRules();
  assert.equal(rules.length, 1);

  const rule = rules[0];
  const enabled = rule.fields.filter(f => f.enabled).map(f => f.id);
  assert.ok(enabled.includes('char_caption'), 'char_caption 应默认启用');
  assert.ok(enabled.includes('prompt'), 'prompt 应默认启用');

  const charCaption = rule.fields.find(f => f.id === 'char_caption')!;
  assert.ok(
    charCaption.paths.some(path => path.includes('char_captions')),
    'char_caption 应指向 NovelAI V4 的 char_captions 路径',
  );
});

test('内置 LLM 预设有两套，且引用的模板都真实存在', () => {
  const presets = createBuiltinLlmPresets();
  const templates = createBuiltinTemplates();
  const templateIds = new Set(templates.map(t => t.id));

  assert.equal(presets.length, 2);
  assert.deepEqual(presets.map(p => p.id), ['preset-zhihatsuki', 'preset-xiaobaix']);

  for (const preset of presets) {
    assert.ok(preset.system_prompt.length > 0, preset.name + ' 应有 system_prompt');
    assert.ok(preset.instruction.length > 0, preset.name + ' 应有 instruction');
    assert.equal(preset.template_mode, 'reference');
    assert.ok(templateIds.has(preset.template_id), preset.name + ' 引用的模板应存在');
  }

  assert.equal(presets[0].target, 'zhihatsuki');
  assert.equal(presets[1].target, 'xiaobaix');
  assert.notEqual(presets[0].template_id, presets[1].template_id, '两套预设应使用不同模板');
});

test('预设的模板与提取规则必须和内置资源对得上', () => {
  const presets = createBuiltinLlmPresets();
  const templateIds = new Set(createBuiltinTemplates().map(t => t.id));
  const ruleIds = new Set(createBuiltinMetaExtractRules().map(r => r.id));

  for (const preset of presets) {
    assert.ok(templateIds.has(preset.template_id), preset.id + ' 的 template_id 必须存在');
    assert.ok(ruleIds.has(preset.meta_extract_rule_id), preset.id + ' 的 meta_extract_rule_id 必须存在');
  }
});

test('内置世界书预设含容错说明与默认蓝灯', () => {
  const presets = createBuiltinWorldbookPresets();
  assert.equal(presets.length, 1);

  const preset = presets[0];
  assert.ok(preset.tolerance_note.includes('容错规则'), '应内置容错说明');
  assert.ok(preset.field_spec.includes('**'), '字段规范应含蓝灯精简的行格式示例');
  assert.equal(preset.entry_defaults.strategy, 'constant', '默认应为蓝灯');
  assert.deepEqual(preset.entry_defaults.keys, [], '默认触发词应为空');
  assert.ok(preset.worldbook_name_template.includes('{源名}'), '世界书名应可用源名变量');
});

test('zod 模型能接受一份完整的空数据并填好默认值', () => {
  const data = WorkshopDataSchema.parse({});
  assert.equal(data.version, 1);
  assert.deepEqual(data.llm_presets, []);
  assert.equal(data.settings.image_concurrency, 4);
  assert.equal(data.task.status, 'idle');
  assert.equal(data.task.kind, 'portraits');
});

test('zod 模型对脏数据做容错：缺失字段被补齐', () => {
  const preset = LlmPresetSchema.parse({ id: 'p1', name: '测试' });
  assert.equal(preset.builtin, false);
  assert.equal(preset.template_mode, 'reference');
  assert.equal(preset.reply_extract.mode, 'labeled_brace');
  assert.equal(preset.batch_size, 4);
  assert.equal(preset.conflict, 'overwrite');

  const template = JsonTemplateSchema.parse({ id: 't1', name: 'x' });
  assert.equal(template.key_prefix, '[苍玄界]');
  assert.equal(template.merge_mode, 'object_map');

  const worldbook = WorldbookPresetSchema.parse({ id: 'w1', name: 'x' });
  assert.equal(worldbook.entry_mode, 'single');
  assert.equal(worldbook.name_conflict, 'suffix');
});
