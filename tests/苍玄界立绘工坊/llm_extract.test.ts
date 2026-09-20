/**
 * LLM 回复中提取 JSON 的测试。
 *
 * 重点覆盖真实模型的各种“不听话”输出：带前言、多个 JSON、围栏、单引号、尾逗号、缺括号。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJson,
  extractJsonText,
  findBalancedJson,
  createDefaultExtractRuleConfig,
} from '../../src/苍玄界立绘工坊/core/llm_extract.ts';

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const fenced = (body: string) => FENCE + 'json\n' + body + '\n' + FENCE;

test('fenced 模式能抽取 json 代码块', () => {
  const reply = '好的，以下是结果：\n' + fenced('{"name":"江念","age":18}') + '\n希望有帮助。';
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'fenced' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: '江念', age: 18 });
  assert.equal(result.repaired, false);
});

test('fenced 模式在无语言标注时也能抽取', () => {
  const reply = FENCE + '\n{"a":1}\n' + FENCE;
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'fenced' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1 });
});

test('labeled_brace 模式能抽取带标记名的 JSON', () => {
  const reply = '我先说明一下思路，然后给出结果：\n"JSON"{"characters":{"[苍玄界]江念":{"nameCN":"江念"}}}\n以上。';
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
  assert.equal(result.ok, true);
  assert.equal((result.value as any).characters['[苍玄界]江念'].nameCN, '江念');
});

test('labeled_brace 模式兼容全角书名号与冒号变体', () => {
  for (const variant of ['JSON：{...}', '「JSON」{...}']) {
    const reply = variant.replace('{...}', '{"ok":true}');
    const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
    assert.equal(result.ok, true, '变体应解析成功: ' + variant);
  }
});

test('regex 模式支持自定义正则与捕获组', () => {
  const reply = '结果如下 >>>{"x":[1,2,3]}<<< 结束';
  const rule = { ...createDefaultExtractRuleConfig(), mode: 'regex' as const, custom_regex: '>>>(\\{[\\s\\S]*?\\})<<<' };
  const result = extractJson(reply, rule);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { x: [1, 2, 3] });
});

test('whole 模式把整段当作 JSON', () => {
  const result = extractJson('  {"a": 1}  ', { ...createDefaultExtractRuleConfig(), mode: 'whole' });
  assert.equal(result.ok, true);
});

test('字符串里的花括号不会打断配平', () => {
  const reply = '前言 \n"JSON"{"text":"这是一个 } 花括号 和 { 另一个","n":1}\n后记';
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
  assert.equal(result.ok, true);
  assert.equal((result.value as any).text, '这是一个 } 花括号 和 { 另一个');
});

test('前置有无关 JSON 时能找到标记名后的那一个', () => {
  const reply = '{"irrelevant":true}\n说明文字\n"JSON"{"target":"正确"}';
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
  assert.equal(result.ok, true);
  assert.equal((result.value as any).target, '正确');
});

test('jsonrepair 能修复尾逗号与单引号', () => {
  const reply = "'JSON'{'a': 1, 'b': 2,}";
  const result = extractJson(reply, { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
  assert.equal(result.ok, true);
  assert.equal(result.repaired, true, '应标记为经过修复');
  assert.deepEqual(result.value, { a: 1, b: 2 });
});

test('json_path 能只取子节点', () => {
  const reply = 'JSON{"data":{"characters":[{"name":"沈慕微"}]}}';
  const result = extractJson(reply, {
    ...createDefaultExtractRuleConfig(),
    mode: 'labeled_brace',
    json_path: 'data.characters',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ name: '沈慕微' }]);
});

test('找不到 JSON 时返回失败而非抛异常', () => {
  const result = extractJson('这里完全没有 JSON 内容。', createDefaultExtractRuleConfig());
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.error);
});

test('空回复返回失败', () => {
  const result = extractJson('', createDefaultExtractRuleConfig());
  assert.equal(result.ok, false);
});

test('完全无法修复的内容返回失败并带错误信息', () => {
  const result = extractJson('JSON{这不是合法json<<<>>>', { ...createDefaultExtractRuleConfig(), mode: 'labeled_brace' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('findBalancedJson 对未闭合内容返回 null', () => {
  assert.equal(findBalancedJson('{"a":1', 0), null);
  assert.equal(findBalancedJson('{"a":1}', 0), '{"a":1}');
});

test('extractJsonText 在 regex 模式正则非法时不抛异常', () => {
  const rule = { ...createDefaultExtractRuleConfig(), mode: 'regex' as const, custom_regex: '([' };
  assert.equal(extractJsonText('abc', rule), null);
});
