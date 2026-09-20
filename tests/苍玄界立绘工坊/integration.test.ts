/**
 * 端到端集成测试 —— 全部使用真实数据，只有 LLM 调用被替换为确定性假实现。
 *
 * 链路：真实立绘 PNG → PNG 块解析 → 元数据识别 → 字段提取
 *      → 引擎分批 → 抽取 JSON → 合并进真实插件格式。
 * 另含：真实世界书 → 势力树 → 候选角色 → 世界书产出组装。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parsePngTextChunks } from '../../src/苍玄界立绘工坊/core/png_meta.ts';
import { buildImageMeta } from '../../src/苍玄界立绘工坊/core/meta_types.ts';
import { extractFields, createDefaultExtractRule } from '../../src/苍玄界立绘工坊/core/extractor.ts';
import { runPortraitBatches, type GenerateRequest } from '../../src/苍玄界立绘工坊/llm/engine.ts';
import { createBuiltinTemplates, createBuiltinLlmPresets } from '../../src/苍玄界立绘工坊/llm/presets_builtin.ts';
import { parseFactionOverview, collectCharacterCandidates, buildCharacterIndex } from '../../src/苍玄界立绘工坊/core/worldbook_source.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));

const zhiTemplate = createBuiltinTemplates().find(t => t.target === 'zhihatsuki')!;
const zhiPreset = createBuiltinLlmPresets().find(p => p.target === 'zhihatsuki')!;

test('端到端：真实立绘 → 元数据提取 → 引擎 → 合并进真实智绘姬文档', async () => {
  // 1) 真实立绘
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, '潮听澜-立绘.png')));
  const chunks = await parsePngTextChunks(bytes);
  const meta = buildImageMeta(chunks);
  assert.equal(meta.format, 'novelai-v4');

  // 2) 按默认规则提取（char_caption + prompt）
  const extracted = extractFields(meta, createDefaultExtractRule());
  assert.ok(extracted.text.includes('short dark blue hair'), '提取文本应含角色 DNA');
  assert.ok(extracted.text.includes('【角色DNA（char_caption）】'));

  // 3) 引擎：假 LLM 把提取到的角色 DNA 原样透传成智绘姬结构
  const seen: string[] = [];
  const generate = async (request: GenerateRequest) => {
    const names = [...request.userInput.matchAll(/===== 角色：(.+?) =====/g)].map(m => m[1]);
    seen.push(...names);
    assert.ok(request.userInput.includes('short dark blue hair'), 'user_input 必须带上真实角色 DNA');
    const characters: Record<string, unknown> = {};
    for (const name of names) {
      characters['[苍玄界]' + name] = {
        nameCN: name,
        nameEN: 'chao tinglan',
        characterTraits: 'brave, adventurous, sharp',
        facialFeatures: 'short dark blue hair, sharp eyes',
        outfits: ['[苍玄界]海潮轻甲短打套装'],
      };
    }
    return JSON.stringify({
      characters,
      outfits: { '[苍玄界]海潮轻甲短打套装': { nameCN: '海潮轻甲短打套装', owner: 'chao tinglan' } },
    });
  };

  // 4) 合并进真实的智绘姬导出文件
  const existing = readFixture('st-chatu8-角色-全部.json');
  const beforeKeys = Object.keys(existing.characters);

  const result = await runPortraitBatches({
    roles: [{ name: '潮听澜', metaText: extracted.text, imageUrl: '' }],
    preset: { ...zhiPreset, batch_size: 1, max_retries: 0 },
    template: zhiTemplate,
    target: 'zhihatsuki',
    existingDocument: existing,
    generate,
  });

  assert.deepEqual(seen, ['潮听澜']);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.added, ['潮听澜']);

  const characters = result.document.characters as Record<string, any>;
  assert.ok('[苍玄界]潮听澜' in characters);
  assert.match(characters['[苍玄界]潮听澜'].facialFeatures, /short dark blue hair/);

  // 既有角色一个都不能少
  for (const key of beforeKeys) assert.ok(key in characters, '既有角色应保留: ' + key);

  const outfits = result.document.outfits as Record<string, any>;
  assert.ok('[苍玄界]海潮轻甲短打套装' in outfits);
  assert.equal(outfits['[苍玄界]海潮轻甲短打套装'].owner, 'chao tinglan');

  // 产出必须仍是合法 JSON，可直接写文件给插件导入
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.document)));
});

test('端到端：真实立绘 → 小白x 目标格式', async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, '潮听澜-立绘.png')));
  const meta = buildImageMeta(await parsePngTextChunks(bytes));
  const extracted = extractFields(meta, createDefaultExtractRule());

  const xiaoTemplate = createBuiltinTemplates().find(t => t.target === 'xiaobaix')!;
  const xiaoPreset = createBuiltinLlmPresets().find(p => p.target === 'xiaobaix')!;

  const generate = async (request: GenerateRequest) => {
    const names = [...request.userInput.matchAll(/===== 角色：(.+?) =====/g)].map(m => m[1]);
    return JSON.stringify({
      characters: names.map(name => ({ id: '', name, type: 'girl', appearance: 'short dark blue hair,', negativeTags: 'long hair', outfits: [{ name: '常服', tags: 'dark cyan short garment' }] })),
    });
  };

  const existing = readFixture('小白x角色提示词.json');
  const result = await runPortraitBatches({
    roles: [{ name: '潮听澜', metaText: extracted.text, imageUrl: '' }],
    preset: { ...xiaoPreset, batch_size: 1, max_retries: 0 },
    template: xiaoTemplate,
    target: 'xiaobaix',
    existingDocument: existing,
    generate,
  });

  const characters = result.document.characters as any[];
  // 潮听澜在真实的 174 人名单里已存在，因此默认 overwrite 是「更新」而不是「新增」，数量不变
  assert.equal(existing.characters.length, 174);
  assert.equal(characters.length, existing.characters.length, '同名角色应被更新而不是重复插入');
  assert.deepEqual(result.updated, ['潮听澜']);
  assert.deepEqual(result.added, []);

  const updated = characters.filter((item: any) => item.name === '潮听澜');
  assert.equal(updated.length, 1, '不应出现重复的潮听澜');
  assert.equal(updated[0].appearance, 'short dark blue hair,');
  assert.equal(result.document.type, 'novel-draw-characters');
  assert.equal(result.document.version, 3);
});

test('端到端：小白x 新增一个不在名单里的角色会追加并生成 id', async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, '潮听澜-立绘.png')));
  const meta = buildImageMeta(await parsePngTextChunks(bytes));
  const extracted = extractFields(meta, createDefaultExtractRule());

  const xiaoTemplate = createBuiltinTemplates().find(t => t.target === 'xiaobaix')!;
  const xiaoPreset = createBuiltinLlmPresets().find(p => p.target === 'xiaobaix')!;

  const generate = async (request: GenerateRequest) => {
    const names = [...request.userInput.matchAll(/===== 角色：(.+?) =====/g)].map(m => m[1]);
    return JSON.stringify({
      characters: names.map(name => ({ id: '', name, type: 'girl', appearance: 'x,', outfits: [] })),
    });
  };

  const existing = readFixture('小白x角色提示词.json');
  const result = await runPortraitBatches({
    roles: [{ name: '全新角色甲', metaText: extracted.text, imageUrl: '' }],
    preset: { ...xiaoPreset, batch_size: 1, max_retries: 0 },
    template: xiaoTemplate,
    target: 'xiaobaix',
    existingDocument: existing,
    generate,
  });

  const characters = result.document.characters as any[];
  assert.equal(characters.length, existing.characters.length + 1);
  const created = characters.find((item: any) => item.name === '全新角色甲');
  assert.match(created.id, /^char-\d+-[a-z0-9]+$/);
  assert.deepEqual(result.added, ['全新角色甲']);
});

test('端到端：真实世界书 → 势力树 → 角色候选 → 蓝灯条目组装', () => {
  const worldbook = readFixture('苍玄界世界书.json');
  const entries = Object.values(worldbook.entries).map((entry: any) => ({
    name: entry.comment,
    content: entry.content,
    enabled: !entry.disable,
    keys: entry.key,
  }));
  assert.equal(entries.length, 219);

  // 势力树
  const overview = entries.find(entry => (entry as any).name === '苍玄界势力概览')!;
  const factions = parseFactionOverview((overview as any).content);
  assert.ok(factions.length >= 18);
  const tianjian = factions.find(faction => faction.name === '天剑宗')!;
  assert.ok(tianjian.members.includes('江念'));

  // 候选角色：按势力带出的人物应能关联到条目
  const index = buildCharacterIndex(entries as any);
  const candidates = collectCharacterCandidates(entries as any, { includeLiteList: false });
  const jiangnian = candidates.find(candidate => candidate.name === '江念')!;
  assert.ok(jiangnian, '应能收集到江念');
  assert.ok(index.has('江念'), '江念应能在索引里找到');

  // 组装一个蓝灯条目（模拟界面上「创建新世界书」）
  const lines = ['**江念**｜天剑宗无情道弟子。女，18岁，炼气三层，天剑宗。天真话多，热情自来熟。'];
  const entry = {
    name: '全角色蓝灯精简',
    content: lines.join('\n'),
    enabled: true,
    strategy: { type: 'constant' as const, keys: [] as string[], keys_secondary: { logic: 'and_any' as const, keys: [] }, scan_depth: 'same_as_global' as const },
    position: { type: 'before_character_definition' as const, role: 'system' as const, depth: 4, order: 100 },
  };
  assert.equal(entry.strategy.type, 'constant', '默认应为蓝灯');
  assert.deepEqual(entry.strategy.keys, [], '默认不带触发词');
  assert.doesNotThrow(() => JSON.stringify(entry));
});