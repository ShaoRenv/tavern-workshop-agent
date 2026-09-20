/**
 * 阶段 3 测试用的小工具（**不是测试文件**，没有 .test.ts 后缀，不会被当用例跑）。
 *
 * 这里只收「多份测试共用」的纯函数，凡是有断言逻辑的一律留在各 .test.ts 里，
 * 免得一个 helper 把多份契约糊成一份、挂了不知道是哪条契约破了。
 */

/** 换行统一成 \n，免得 Windows 的 \r 干扰行级正则 */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 剥掉注释，只留**真正会跑的代码**。
 *
 * 源码级断言必须过这一道：文件头注释里写「不许 import 别的插件」、
 * 或者注释里举例 `../cangxuan/manifest.ts`，都不该被算成真 import。
 * （口径照抄 plugin_registry.test.ts 的 codeOnly。block 保留字符数，
 *   方便报错时说清「第几行」——行号不变才好定位。）
 */
export function codeOnly(text: string): string {
  return normalize(text)
    .replace(/<!--[\s\S]*?-->/g, block => blankOut(block))
    .replace(/\/\*[\s\S]*?\*\//g, block => blankOut(block))
    .replace(/(^|[^:])\/\/[^\n]*/g, (all, head: string) => head);
}

/** 把一段（注释）换成等长的空白，只留换行 —— 行号与列号都不会漂 */
function blankOut(block: string): string {
  return block.replace(/[^\n]/g, ' ');
}

/**
 * 抽出源码里所有的 import / export ... from / 动态 import() 的模块路径。
 *
 * 覆盖四种写法（阶段 3 的源码里四种都可能出现）：
 *   import x from 'p'          /  import { a } from 'p'  /  import 'p'
 *   export { x } from 'p'      /  export * from 'p'
 *   const x = await import('p') / import('p')
 * 返回 { specifier, line }，行号从 1 起。
 */
export function importSpecifiers(text: string): Array<{ specifier: string; line: number }> {
  const code = codeOnly(stripTemplates(text));
  const out: Array<{ specifier: string; line: number }> = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      out.push({ specifier: match[1], line: lineOf(code, match.index ?? 0) });
    }
  }
  return out;
}

/**
 * .vue 文件只留 <script> 块。
 *
 * 模板里的正文可能**刚好长得像 import**（代码示例、文档、it 里面的字符串），
 * 那不该被算成真依赖。同时把 <template> / <style> 换成等长空白，行号不漂。
 * .ts 文件原样返回。
 */
export function stripTemplates(text: string): string {
  const src = normalize(text);
  if (!/<script|\n/.test(src)) return src;
  return src.replace(/<(template|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, block => blankOut(block));
}

/** 下标 → 行号（1 起） */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** 把 specifier 归一化：只留路径部分，统一成 / 分隔（去掉 ./ 前缀） */
export function cleanSpecifier(specifier: string): string {
  return specifier.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 从「某个插件的根目录」出发解析一个相对 specifier，得到它相对 plugins/builtin/ 的路径。
 *
 * root 是「这个文件所属的插件目录」：
 *     root = 'plugins/builtin/cangxuan'（或 cangxuan/ 下任意深度）
 *     root = 'plugins/builtin'         —— 汇总表 index.ts 自己不属于任何插件目录
 * 返回值 = 解析后相对 plugins/builtin/ 的路径；跑到 builtin 外面（去 core / agent）返回 null。
 * 例：root = 'plugins/builtin/cangxuan'，specifier = '../worldbook/manifest.ts' → 'worldbook/manifest.ts'
 *     root = 'plugins/builtin'，         specifier = './worldbook/manifest.ts' → 'worldbook/manifest.ts'
 *     root = 'plugins/builtin/cangxuan'，specifier = '../types.ts'             → null（去 plugins 顶层）
 *     root = 'plugins/builtin'，         specifier = '../types.ts'             → null
 * 只处理相对路径；裸包名（vue / pinia）与绝对路径返回 null。
 */
export function resolveWithinBuiltin(root: string, specifier: string): string | null {
  const clean = cleanSpecifier(specifier);
  if (!clean.startsWith('.')) return null;
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const prefix = ['plugins', 'builtin'];
  for (let i = 0; i < prefix.length; i++) {
    // 往上跳太多（跑到 plugins/ 之外 / 工程根）→ 那不是跨插件，交给别的约束管
    if (i >= parts.length || parts[i] !== prefix[i]) return null;
  }
  const rest = parts.slice(prefix.length);
  return rest.length ? rest.join('/') : null;
}