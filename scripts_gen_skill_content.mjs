/**
 * 生成器：把 reports/世界书skill-适配稿/ 的 6 个 md **逐字节**搬进 src/，
 * 并生成一个不含 ?raw 的 TS 内容模块。
 *
 * 为什么要生成 .ts 而不是直接 import '....md?raw'：
 *   tests/苍玄助手/*.test.ts 是 node --test 直接跑 .ts 的（不走 webpack），
 *   而 plugins/registry.ts 被这些测试静态 import → 只要那条链上出现 ?raw，
 *   整批测试当场崩（ERR_UNKNOWN_FILE_EXTENSION）。
 *   所以内容以 .ts 字符串模块落地，md 原文同时留在 src 里当**校验基准**。
 *
 * 用法：node scripts_gen_skill_content.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = 'reports/世界书skill-适配稿';
const DST = 'src/苍玄助手/plugins/builtin/worldbook/skills/世界书工程';

const FILES = [
  ['SKILL.md', 'SKILL_MD'],
  ['references/字段速查表.md', 'REF_FIELDS'],
  ['references/激活机制详解.md', 'REF_ACTIVATION'],
  ['references/注入位置与顺序.md', 'REF_POSITION'],
  ['references/条目范式与范例.md', 'REF_PATTERNS'],
  ['references/悬案与不确定项.md', 'REF_OPEN_ISSUES'],
];

/** 把任意文本塞进模板字面量：只转义反斜杠、反引号、${ */
function toTemplateLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\$\{');
}

const parts = [];
const entries = [];
let total = 0;

for (const [rel, name] of FILES) {
  const raw = readFileSync(join(SRC, rel), 'utf8');
  total += Buffer.byteLength(raw, 'utf8');
  // 同步把 md 原文放进 src（校验基准；测试逐字节比对它和下面的字符串）
  const dstPath = join(DST, rel);
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, raw, 'utf8');
  entries.push({ rel, name, bytes: Buffer.byteLength(raw, 'utf8'), chars: raw.length });
  parts.push('export const ' + name + ' = `' + toTemplateLiteral(raw) + '`;');
}

const header = [
  '/**',
  ' * 世界书工程 skill · 出厂内容（**逐字节搬运，不许改写**）。',
  ' *',
  ' * ⚠️ 本文件由 scripts_gen_skill_content.mjs 生成，别手改 ——',
  ' * 手改会被 tests/苍玄助手/skill_content_verbatim.test.ts 当场打回。',
  ' *',
  ' * 改内容的正确姿势：改同目录的 .md 原文（那是校验基准），再跑一次生成器。',
  ' *',
  ' * 原文出处：TavernWeave 手册 A3_世界书优化 / A4_提示词与预设。',
  ' * Copyright 2026 LiarMTTT · PolyForm Noncommercial License 1.0.0',
  ' * 许可全文见仓库根 THIRD_PARTY_NOTICES.md + licenses/PolyForm-Noncommercial-1.0.0.txt',
  ' *',
  ' * 共 ' + entries.length + ' 个文件 / ' + total + ' 字节：',
].concat(entries.map(e => ' *   · ' + e.rel + '（' + e.chars + ' 字符 / ' + e.bytes + ' 字节）→ ' + e.name)).join('\n');

const out = header + '\n */\n\n' + parts.join('\n\n') + '\n';
writeFileSync(join(DST, 'content.ts'), out, 'utf8');

console.log('生成完毕：' + entries.length + ' 个 md + content.ts');
console.log('总字节 ' + total);
for (const e of entries) console.log('  ' + e.rel + '  ' + e.bytes + 'B -> ' + e.name);
