/**
 * 内容落地：`reports/世界书skill-适配稿/` 的 6 个 md 必须**逐字节**等于
 * `src/苍玄助手/plugins/builtin/worldbook/skills/世界书工程/content.ts` 里的字符串。
 *
 * 为什么要有这条闸：用户对 skill 内容的硬要求是「**原文搬运 + 平台适配**，不是 AI 重写」。
 * 中间任何一环被「顺手润色一下」，这条测试当场打回 —— 这是唯一能自动化的证据。
 *
 * 校验基准是 src 里那份 .md（生成器同时写的），不是 reports/ ——
 * 因为发布出去的是 src，reports/ 是过程文档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 用 import.meta.url 定位，别用相对路径字符串 —— readFileSync 是相对 cwd 解析的（真踩过） */
const base = new URL('../../src/苍玄助手/plugins/builtin/worldbook/skills/世界书工程/', import.meta.url);
const root = fileURLToPath(base);
const content = await import(new URL('content.ts', base).href);

/** [相对路径, 导出的常量名] —— 顺序与生成器一致 */
const FILES = [
  ['SKILL.md', 'SKILL_MD'],
  ['references/字段速查表.md', 'REF_FIELDS'],
  ['references/激活机制详解.md', 'REF_ACTIVATION'],
  ['references/注入位置与顺序.md', 'REF_POSITION'],
  ['references/条目范式与范例.md', 'REF_PATTERNS'],
  ['references/悬案与不确定项.md', 'REF_OPEN_ISSUES'],
];

test('skill 内容：6 个文件都在，且 content.ts 与 .md 原文逐字节一致（防「AI 顺手改写」）', () => {
  for (const [rel, name] of FILES) {
    const disk = readFileSync(join(root, rel), 'utf8');
    assert.equal(typeof content[name], 'string', name + ' 没导出成字符串');
    assert.equal(content[name], disk, rel + ' 的 content.ts 副本与 .md 原文不一致 —— 内容被改写过');
  }
});

test('skill 内容：总量对得上（5.2 万字节，防「搬着搬着丢了一个文件」）', () => {
  // ⚠️ 按**字节**算，不是 .length：中文一个字是 1 个 UTF-16 码元但 3 个 UTF-8 字节，
  // 用 .length 当阈值会误判成「搬漏了」（实测 32,789 码元 vs 52,339 字节）。
  const total = FILES.reduce((sum, [rel]) => sum + Buffer.byteLength(readFileSync(join(root, rel), 'utf8'), 'utf8'), 0);
  assert.ok(total > 45000, 'skill 内容总量只有 ' + total + ' 字节，明显搬漏了');
  // 正文 + 5 个 references 一个都不能少
  assert.equal(FILES.length, 6);
});

test('skill 内容：SKILL.md 有 Agent Skills 标准要求的 frontmatter（name + description）', () => {
  const skill = content.SKILL_MD;
  assert.ok(skill.startsWith('---'), 'SKILL.md 必须以 frontmatter 分隔符开头');
  const end = skill.indexOf('\n---', 3);
  assert.ok(end > 0, 'frontmatter 没有闭合的 ---');
  const front = skill.slice(3, end);
  assert.match(front, /^name:\s*\S+/m, 'frontmatter 缺 name');
  assert.match(front, /^description:\s*\S+/m, 'frontmatter 缺 description');
});

test('skill 内容：来源声明与许可必须在正文里看得见（PolyForm 的要求）', () => {
  const skill = content.SKILL_MD;
  assert.match(skill, /PolyForm Noncommercial/i, 'SKILL.md 里丢了许可声明');
  assert.match(skill, /LiarMTTT/, 'SKILL.md 里丢了版权归属');
});
