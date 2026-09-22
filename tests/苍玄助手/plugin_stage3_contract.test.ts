/**
 * 阶段 3 · T3-7：三条硬规矩的源码级 / 注册表级断言。
 *
 * 对应 reports/苍玄助手-底座化实施计划.md §17.3 的验收与 §5 的硬规矩：
 *  ① 插件之间**零 import**（依赖只能 plugins → core / agent）；
 *  ② 顶栏恰好 **3 格（对话 / 世界书 / 设置）**，关掉世界书 → 2 格；
 *  ③ 插件贡献的东西「**关掉即消失**」——页面 / 工具 / 宏三层都要成立。
 *
 * 跑法：node --test "tests/苍玄助手/*.test.ts"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly, importSpecifiers, resolveWithinBuiltin } from './_helpers.ts';

const srcRoot = fileURLToPath(new URL('../../src/苍玄助手/', import.meta.url));
const builtinDir = join(srcRoot, 'plugins', 'builtin');

const { availablePages, pluginPages, allPages } = await import('../../src/苍玄助手/plugins/registry.ts');
const { PLUGIN_MANIFESTS } = await import('../../src/苍玄助手/plugins/registry.ts');
const { CORE_PAGES } = await import('../../src/苍玄助手/core/pages.ts');
const { TAB_ID_ALIASES } = await import('../../src/苍玄助手/core/types.ts');

/** 递归列出目录下所有文件（相对 src/苍玄助手 的 posix 路径），未排序由调用方排 */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(relative(srcRoot, full).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 从「src/苍玄助手 下的一个文件」出发解析相对 specifier，得到相对 src/苍玄助手 的 posix 路径。
 *
 * 例：file = 'plugins/builtin/cangxuan/manifest.ts'，specifier = '../../types.ts'
 *     → 'plugins/types.ts'（先补到「文件所在目录」，再逐段吃掉 ..）
 */
function resolveFromSrcFile(file: string, specifier: string): string {
  const parts = file.split('/').slice(0, -1); // 文件所在目录
  const clean = specifier.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** 注册表函数只依赖 plugin_state 那一小块 */
function state(plugin_state = {}) {
  return { plugin_state };
}

/* ==================== ① 插件之间零 import ==================== */

test('硬规矩①：plugins/builtin/*/ 下不许出现跨插件的 import（目录 = 插件边界）', () => {
  const files = walkFiles(builtinDir).filter(file => /\.(ts|vue)$/.test(file)).sort();
  assert.ok(files.length > 0, 'plugins/builtin/ 下应该有内置插件文件');

  const owners = new Set(
    files
      .map(file => file.replace(/^.*?plugins\/builtin\//, '').split('/')[0])
      .filter(part => part && part !== 'index.ts'),
  );
  // 阶段 6 起是**四个**：mcp 也是自包含目录（运行时从远端拉工具，contributes.tools 为空）
  assert.deepEqual(
    [...owners].sort(),
    ['cangxuan', 'image', 'mcp', 'worldbook'].sort(),
    '内置插件就是这四个自包含目录',
  );

  const violations: string[] = [];
  for (const file of files) {
    if (file === 'plugins/builtin/index.ts') continue; // 汇总表：它**必须** import 各插件目录，单独在下面钉
    const owner = file.replace(/^.*?plugins\/builtin\//, '').split('/')[0];
    for (const { specifier, line } of importSpecifiers(readFileSync(join(srcRoot, file), 'utf8'))) {
      // 从「这个文件所属的插件目录」出发解析，看会不会落到**别的插件目录**里
      const target = resolveWithinBuiltin('plugins/builtin/' + owner, specifier);
      if (!target) continue;
      const other = target.split('/')[0];
      if (other !== owner) violations.push(file + ':' + line + ' → ' + specifier + '（跨到 ' + other + '）');
    }
  }
  assert.deepEqual(violations, [], '插件之间零 import：\n' + violations.join('\n'));

  // 唯一允许「同时提到三个插件」的文件是汇总表，它只 import 各自的 manifest
  const aggregator = importSpecifiers(readFileSync(join(builtinDir, 'index.ts'), 'utf8'));
  assert.deepEqual(
    aggregator.map(item => item.specifier).sort(),
    ['../types.ts', './cangxuan/manifest.ts', './image/manifest.ts', './mcp/manifest.ts', './worldbook/manifest.ts'],
    'plugins/builtin/index.ts 是全工程唯一列出内置插件的地方，且只 import 各目录的 manifest + 契约类型',
  );
  // 四个 manifest 都在，且**没有**插件目录被漏掉
  assert.deepEqual(
    aggregator.filter(item => item.specifier.endsWith('/manifest.ts')).map(item => item.specifier).sort(),
    ['./cangxuan/manifest.ts', './image/manifest.ts', './mcp/manifest.ts', './worldbook/manifest.ts'],
    '四个内置插件一个不多一个不少',
  );
});

test('硬规矩①：插件目录的相对 import 只许落在 core / agent / plugins（**不许**碰宿主外壳）', () => {
  const files = walkFiles(builtinDir).filter(file => /\.(ts|vue)$/.test(file) && file !== 'plugins/builtin/index.ts').sort();
  // Lead 口径（阶段 3）：插件是**自包含目录**，只许往 core / agent / 契约指。
  // components / views / stores / App.vue 都是**宿主外壳** —— 插件依赖它们就等于
  // 「宿主换壳会连坐」，阶段 6 的外部插件也不该有这种特权。
  const allowedTop = new Set(['core', 'agent', 'run', 'plugins']);
  const offenders: string[] = [];

  for (const file of files) {
    for (const { specifier, line } of importSpecifiers(readFileSync(join(srcRoot, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue; // 裸包名（vue / pinia / zod）不受约束
      const target = resolveFromSrcFile(file, specifier);
      const top = target.split('/')[0];
      if (!allowedTop.has(top)) offenders.push(file + ':' + line + ' → ' + specifier + '（落到 ' + top + '/）');
    }
  }
  assert.deepEqual(offenders, [], '插件的依赖只能往 core / agent，别反向依赖宿主外壳：\n' + offenders.join('\n'));

  // 钉死四条最要命的：插件不许碰 store、不许碰 App.vue、不许碰宿主的 views / components
  for (const file of files) {
    const code = codeOnly(readFileSync(join(srcRoot, file), 'utf8'));
    assert.equal(/stores\/app\.ts/.test(code), false, file + ' 不许 import store');
    assert.equal(/useAppStore/.test(code), false, file + ' 不许用 useAppStore');
    assert.equal(/\bApp\.vue\b/.test(code), false, file + ' 不许依赖 App.vue');
    assert.equal(/\/views\//.test(code), false, file + ' 不许依赖宿主的 views/');
    assert.equal(/\/components\//.test(code), false, file + ' 不许依赖宿主的 components/（UI 类型要在插件本地声明或去 core）');
  }
});

/** 扫描器自身的防回归：它一旦把模板 / 注释算成依赖，上面两条断言就会「假红 / 假绿」 */
test('扫描器自检：注释、模板正文、style 里的 import 不算依赖；真 import 行号对得上', () => {
  const vue = [
    '<script setup lang="ts">',
    "import Page from '../worldbook/Page.vue';",
    '</script>',
    '<template>',
    "  <!-- import { y } from '../image/nai.ts'; -->",
    "  <div>import { z } from '../cangxuan/tools.ts';</div>",
    '</template>',
  ].join('\n');
  assert.deepEqual(
    importSpecifiers(vue),
    [{ specifier: '../worldbook/Page.vue', line: 2 }],
    '模板正文 / 注释里的 import 不算数，只有 script 块里的算',
  );

  // 四种写法都要抓得到（阶段 3 的源码里四种都可能出现）
  const ts = [
    "import a from './a.ts';",
    "import type { T } from '../../core/ports.ts';",
    "import './side-effect.ts';",
    "export { b } from './b.ts';",
    "const c = await import('./c.ts');",
    "// import d from './d.ts';",
  ].join('\n');
  assert.deepEqual(
    importSpecifiers(ts).map(item => item.specifier),
    ['./a.ts', '../../core/ports.ts', './side-effect.ts', './b.ts', './c.ts'],
  );
  assert.deepEqual(importSpecifiers(ts).map(item => item.line), [1, 2, 3, 4, 5], '行号要准（报错时才定位得到）');

  // 跨插件路径解析：吃 .. 到 builtin 根外面 = 不是跨插件（那是去 core）
  assert.equal(resolveWithinBuiltin('plugins/builtin/cangxuan', '../worldbook/manifest.ts'), 'worldbook/manifest.ts');
  assert.equal(resolveWithinBuiltin('plugins/builtin/cangxuan/lib', '../../worldbook/tools.ts'), 'worldbook/tools.ts');
  assert.equal(resolveWithinBuiltin('plugins/builtin/cangxuan', '../../types.ts'), null);
  assert.equal(resolveWithinBuiltin('plugins/builtin/cangxuan', '../../core/ports.ts'), null);
  assert.equal(resolveWithinBuiltin('plugins/builtin/cangxuan', './macros.ts'), null, '自己目录不算跨插件');
  assert.equal(resolveWithinBuiltin('plugins/builtin/image', 'vue'), null, '裸包名不是插件路径');
});

/* ==================== ② 顶栏恰好 3 格 ==================== */

test('硬规矩②：顶栏恰好 3 格 —— 对话 / 世界书 / 设置（苍玄助手去页面了）', () => {
  assert.deepEqual(
    availablePages(state()).map(page => [page.id, page.title, page.order, page.owner]),
    [
      ['chat', '对话', 10, 'base'],
      ['worldbook', '世界书', 30, 'worldbook'],
      ['settings', '设置', 90, 'base'],
    ],
    '阶段 3 的顶栏就是对话 / 世界书 / 设置',
  );

  // 苍玄助手插件**没有页面**（它的活：读 → 工具，生成 → 对话页跑预设）
  const cangxuan = PLUGIN_MANIFESTS.find(manifest => manifest.id === 'cangxuan');
  assert.ok(cangxuan, '苍玄助手插件要在');
  assert.equal(cangxuan.contributes.pages, undefined, '苍玄助手不贡献页面');

  const ids = availablePages(state()).map(page => page.id);
  for (const gone of ['portraits', 'records', 'capability']) {
    assert.equal(ids.includes(gone), false, gone + ' 不该再占顶栏');
  }

  // 老数据里的 active_tab = portraits 也要兜到真页面上（不是「第一个可用页」）
  assert.equal(TAB_ID_ALIASES.portraits, 'chat', '老「立绘」页名兜到对话页');

  assert.deepEqual(CORE_PAGES.map(page => [page.id, page.order]), [['chat', 10], ['settings', 90]]);
});

test('硬规矩②：关掉世界书 → 顶栏 2 格（对话 / 设置）；重开就回来', () => {
  const off = state({ worldbook: { enabled: false } });
  assert.deepEqual(availablePages(off).map(page => page.id), ['chat', 'settings'], '关掉世界书只剩核心两页');
  assert.equal(availablePages(off).length, 2);
  assert.deepEqual(pluginPages(off), [], '没开着的插件贡献页面 → 一张都没有');

  const on = state({ worldbook: { enabled: true } });
  assert.deepEqual(availablePages(on).map(page => page.id), ['chat', 'worldbook', 'settings']);
  assert.equal(availablePages(on).length, 3);

  // 关掉苍玄助手**不改**顶栏：它本来就没有页面（这条最容易写错成「4 → 3」）
  assert.deepEqual(
    availablePages(state({ cangxuan: { enabled: false } })).map(page => page.id),
    ['chat', 'worldbook', 'settings'],
    '苍玄助手没有页面 → 关掉它顶栏不变',
  );

  // allPages 与顶栏在阶段 3 相等（还没有 inTabbar:false 的插件内容页，那是阶段 5 MCP）
  assert.deepEqual(allPages(state()).map(page => page.id), availablePages(state()).map(page => page.id));
});
/* ==================== ⭐新性质②：mcp 是唯一「工具靠运行时注册」的插件 ==================== */

test('⭐mcp 的 contributes.tools 必须是**空数组**（工具是运行时从远端拉的，不能写死在 manifest 里）', async () => {
  const { pluginManifest, runtimeToolsOf } = await import('../../src/苍玄助手/plugins/registry.ts');
  const mcp = pluginManifest('mcp');

  assert.ok(
    Array.isArray(mcp.contributes.tools),
    'tools 要显式声明成数组（不是 undefined）—— 这是「静态工具为空」这件事的书面表达',
  );
  assert.deepEqual(
    mcp.contributes.tools,
    [],
    'mcp 的工具**全部**来自 registerRuntimeTools（tools/list 拉回来的）；写死进 manifest 说明有人把远端工具当静态的写了',
  );

  // 运行时注册通道才是它真正的工具来源（还没连服务器时当然是空的）
  assert.deepEqual(runtimeToolsOf('mcp'), [], '没连任何服务器时，运行时工具为空');

  // 其余三个内置插件是**静态声明**型：静态工具不许为空（否则它们的工具就凭空没了）
  for (const id of ['cangxuan', 'worldbook', 'image']) {
    assert.ok(
      (pluginManifest(id).contributes.tools ?? []).length > 0,
      id + ' 是静态声明型插件，contributes.tools 不该为空',
    );
  }
});

test('源码级：当前只有 mcp 一个插件用 registerRuntimeTools（别的插件不许偷用运行时通道）', () => {
  // ⚠️ walkFiles 返回的已经是**相对 src/苍玄助手**的 posix 路径，不要再 join srcRoot
  const files = walkFiles(builtinDir)
    .filter(file => /\.(ts|vue)$/.test(file))
    .filter(file => /registerRuntimeTools\s*\(/.test(codeOnly(readFileSync(join(srcRoot, file), 'utf8'))))
    .map(file => file.replace(/^.*plugins\/builtin\//, '').split('/')[0]);
  assert.deepEqual([...new Set(files)], ['mcp'], '运行时注册当前只有 MCP 需要（阶段 5 的设计就是它一个）');
});
/* ==================== ⭐宿主外壳的「真牙齿」：字面量扫描 ==================== */

/**
 * 扫一段源码里所有指向宿主外壳的**字面量**（不只是静态 import）。
 *
 * 为什么需要这一层：上面那条闸用的是 `importSpecifiers`，只认
 *   `import x from '...'` / `export ... from '...'` / `import('...')`
 * 这几种**语法形态**。但只要把 import 挪成
 *   `const mod = await import('../../../components/' + name)`
 * 或
 *   `const p = '../../../components/Sw.vue'`
 * 静态 import 那条闸就抓不到了 —— 而插件的**自包含性**照样被破坏。
 *
 * 这条是「口径的真牙齿」：插件目录里**不许出现 components/ 这个字面量**
 * （`views/` / `stores/` 同理）。外部插件只有「自包含目录 + manifest + 运行时 host」，
 * 放行宿主外壳等于给未来的外部插件留一条走不通的路。
 *
 * ⚠️ 先 `codeOnly` 剥注释再扫：注释里举例提到 `components/` 不算违规，
 * 否则以后写解释性注释都要绕着走（本文件自己就大量提到它）。
 */
function shellLiterals(text: string): string[] {
  const code = codeOnly(text);
  const out: string[] = [];
  for (const shell of ['components', 'views', 'stores']) {
    // 形状：可选的 ./ 前缀 + 若干 ../ + shell 目录名，后面跟 / 或引号
    const pattern = new RegExp("(?:\\.\\./)*\\.?\\/?" + shell + "\\/", 'g');
    for (const match of code.matchAll(pattern)) {
      out.push(match[0]);
    }
  }
  return out;
}

/** 反例自检用：跑一段假源码，返回它被抓到的外壳字面量 */
function probeShell(src: string): string[] {
  return shellLiterals(src);
}

test('⭐源码级（真牙齿）：插件目录里不许出现宿主外壳的**字面量**（静态/动态 import、拼路径都算）', () => {
  const files = walkFiles(builtinDir).filter(file => /\.(ts|vue)$/.test(file) && file !== 'plugins/builtin/index.ts').sort();
  assert.ok(files.length > 5, '要真的扫到插件文件（否则这条是空转）');

  const offenders: string[] = [];
  for (const file of files) {
    for (const literal of shellLiterals(readFileSync(join(srcRoot, file), 'utf8'))) {
      offenders.push(file + ' → ' + literal);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '插件目录里出现了指向宿主外壳的字面量（components/ views/ stores/）——\n' +
      '插件必须是自包含目录（外部插件只有「自包含目录 + manifest + 运行时 host」）：\n' +
      offenders.join('\n'),
  );
});

test('⭐真牙齿闸的反例自检：静态 import / 动态 import / 拼路径**三种都抓得住**，纯注释**不误报**', () => {
  // ① 静态 import —— 老闸也能抓，这里确认新闸没退化
  assert.deepEqual(
    probeShell("import Sw from '../../../components/Sw.vue';"),
    ['../../../components/'],
    '静态 import 要被抓到',
  );

  // ② ⭐动态 import —— 这正是老闸（只认语法形态）漏掉的那种
  assert.deepEqual(
    probeShell("const mod = await import('../../../components/ui_types.ts');"),
    ['../../../components/'],
    '动态 import 必须也被抓到（把 import 挪去动态不能绕过闸）',
  );

  // ③ ⭐路径字符串拼接 —— 最隐蔽的一种：根本不是 import 语句
  assert.deepEqual(
    probeShell("const dir = '../../../components/';"),
    ['../../../components/'],
    '拼路径的字面量也要抓到',
  );
  assert.deepEqual(
    probeShell("const file = '../../../components/' + name + '.vue';"),
    ['../../../components/'],
    '拼接形态同样要抓到',
  );

  // ④ 三种外壳目录都要覆盖
  for (const shell of ['components', 'views', 'stores']) {
    assert.deepEqual(probeShell("x = '../../" + shell + "/y';"), ['../../' + shell + '/'], shell + ' 要被扫到');
  }

  // ⑤ ⚠️ **不误报**：只在注释里提 components/ 不算违规
  assert.deepEqual(probeShell('// 这里以前 import 过 ../../../components/Sw.vue，后来改成自包含了'), [], '行注释里提到不算违规');
  assert.deepEqual(probeShell('/* 举例：不要把 ../../components/ 写进插件 */'), [], '块注释里提到不算违规');
  assert.deepEqual(probeShell('<!-- 模板注释：components/ 是宿主外壳 -->'), [], 'HTML 注释里提到不算违规');

  // ⑥ 不误报：合法路径不该被当成外壳
  assert.deepEqual(probeShell("import x from '../../../core/types.ts';"), [], 'core/ 是允许的');
  assert.deepEqual(probeShell("import y from './Switch.vue';"), [], '同目录自包含零件是允许的');
  assert.deepEqual(probeShell("const 组件 = '../../../componentsX/y';"), [], '前缀相同的别的目录名不算（componentsX ≠ components）');
});
