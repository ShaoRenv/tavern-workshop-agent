/**
 * 阶段 3 测试用的小工具（**不是测试文件**，没有 .test.ts 后缀，不会被当用例跑）。
 *
 * 这里只收「多份测试共用」的纯函数，凡是有断言逻辑的一律留在各 .test.ts 里，
 * 免得一个 helper 把多份契约糊成一份、挂了不知道是哪条契约破了。
 */

/* ==================== 宿主能力夹具（P4-11） ==================== */

/**
 * 装上「**能力齐全的宿主**」，返回一个 restore 函数。
 *
 * ## 为什么需要它
 *
 * task-22 给内置插件补了 `contributes.requires`，于是 `loadablePlugins` 的能力闸**活了**：
 * 必需能力缺失 → 该插件整个不注册（页面 / 工具 / 宏 / 技能 / 预设全都不出）。
 * 而测试进程里**没有酒馆上下文**，什么都探不到 —— 「断言插件正常装载」的那一族会成片红。
 * 根因不是产品 bug，是**闸按设计生效了**；缺的是测试侧这个夹具。
 *
 * ## ⚠️ 为什么必须**显式调用**（不要做成 import 即生效的全局副作用）
 *
 * 能力闸的意义正是「缺能力时该被拦」。如果夹具在 import 时自动生效，
 * 「该被拦」的那些测试就会**悄悄失去意义** —— 不再是「测了拦截」，
 * 而是「测了个永远不会发生的场景」，而且**看起来还是绿的**。
 * 所以这里只导出函数，由用例自己决定装不装、什么时候摘。
 *
 * ## ⚠️ 为什么「只装 resolver」还不够
 *
 * `pluginCapabilitySkips` 开头有一句 `if (!hostIsPresent()) return []` ——
 * 「宿主还没接上」时**故意不拦**（晚绑定原则：免得扩展 activate 早于 ST 就绪时把插件判死）。
 * 所以**光换 resolver 是不生效的**：必须同时让宿主「看起来存在」，能力闸才会真正跑起来。
 * 这就是下面两个函数的分工 —— 要测「正常装载」用前者，要测「闸真的会拦」必须用后者。
 *
 * ## 用法
 *
 * ```ts
 * test('插件正常装载时 …', t => {
 *   const restore = installCapabilityGateHost();   // 能力齐全 + 宿主在位
 *   t.after(restore);
 *   // …断言页面 / 工具 / 宏都在…
 * });
 *
 * test('必需能力缺失 → 整个插件不注册', t => {
 *   const restore = installCapabilityGateHost(name => name !== 'getWorldbook');
 *   t.after(restore);
 *   // …断言 worldbook 不在 loadablePlugins、页面与 7 个工具都没了…
 * });
 * ```
 *
 * ⚠️ resolver 与宿主桥都是**进程级**全局状态，`node --test` 同进程跑多文件时可能互相污染。
 * 所以**必须**配 `t.after(restore)`。
 *
 * @param available 判定单条能力是否可用（默认全可用）
 * @returns restore 函数（还原 resolver + 宿主桥）
 */
export function installCapabilityGateHost(available: (name: string) => boolean = () => true): () => void {
  const previous = getHostBridgeFn();
  installResolverFn(name => (available(name) ? 'native' : 'none'));
  setHostBridgeFn({ getVariables: () => ({}) });
  return () => {
    installResolverFn(null);
    setHostBridgeFn(previous ?? null);
  };
}

/**
 * 只装 resolver（**不**让宿主看起来存在）。
 *
 * ⚠️ 单独用它**测不到「缺能力 → 拦」** —— 会被 `hostIsPresent()` 短路放行。
 * 它存在的意义是覆盖「宿主的宿主桥还没接上」那条路（晚绑定），
 * 以及给需要「能力齐全但宿主不可见」的场景用。
 */
export function installCapableHost(available: (name: string) => boolean = () => true): () => void {
  installResolverFn(name => (available(name) ? 'native' : 'none'));
  return () => installResolverFn(null);
}

/* --- 进程内单例模块的绑定（顶层动态 import，与各测试文件同一套 ESM 写法） --- */

const capability = await import('../../src/苍玄助手/core/capability.ts');
const storageMod = await import('../../src/苍玄助手/core/storage.ts');

const installResolverFn = capability.installCapabilityResolver as (next: ((name: string) => string) | null) => void;
const setHostBridgeFn = storageMod.setHostBridge as (bridge: unknown) => void;
const getHostBridgeFn = storageMod.getHostBridge as () => unknown;

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
/* ==================== 能力名静态闸（P5-5） ==================== */

/**
 * 剥掉 `requires` 里可选的 `?` 后缀。
 *
 * `?` 是「可选能力」的唯一表达法（见 core/capability.ts 的 evaluatePluginCapabilities），
 * 判定名字合法性时要先剥掉它。**只剥末尾一个** —— 中间带 `?` 是非法写法，
 * 由另一条闸（`?` 只能在末尾）单独管，不在这里顺手容错。
 */
export function bareCapabilityName(raw: string): string {
  return String(raw).replace(/\?$/, '');
}

/**
 * **能力名静态闸**：返回 `requires` 里那些**不在 `known` 里**的名字（人话列表）。
 *
 * 为什么要有这条闸：必需能力**写错名字** = 该插件在此环境中**整个不注册**
 * （页面 / 工具 / 宏全没），而且**只在真机宿主就绪时才发作** —— 测不出来、很难查。
 * 典型形态就是 `getWorldbooks`（多了个 s）。
 *
 * ⚠️ `known` 刻意做成**参数**，而不是在本函数里 import 能力表：
 * 这样调用方可以喂一张「**挖掉某个名字**的能力表副本」进去，
 * 从而证明这条闸**真的会因为缺名字而报错**。
 * 若在内部 import，就构造不出反例 —— 那是一条永远绿的闸，等于没有。
 * （本项目反复踩过这个坑：写不出反例的断言只给人虚假安全感。）
 *
 * 抽到 `_helpers.ts` 而不是留在某个 .test.ts 里，是因为**两份测试要共用它**：
 *   · `plugin_registry.test.ts` 用它扫真实插件清单；
 *   · `capability.test.ts` 用它验证「登记 fetch 之后声明它不再被拒」。
 * 各写一份副本就变成「我以为在测它，其实在测我自己的副本」。
 */
export function capabilityNameOffenders(
  requires: readonly unknown[],
  known: Iterable<string>,
): string[] {
  const names = new Set(known);
  const bad: string[] = [];
  for (const raw of requires) {
    const name = bareCapabilityName(String(raw));
    if (!names.has(name)) bad.push(String(raw));
  }
  return bad;
}
