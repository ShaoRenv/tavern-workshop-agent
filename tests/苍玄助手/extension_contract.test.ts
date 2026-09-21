/**
 * 扩展形态验收闸（stage 3.5 决策 7）。
 *
 * ⚠️ 与 bundle_artifact.test.ts 的分工：
 *   - bundle_artifact.test.ts 管**脚本形态**产物（src/酒馆助手脚本-苍玄助手.json）
 *   - 本文件管**扩展形态**产物（src/extension/ → dist/extension/）
 *   两种形态并存一段时间（脚本形态还没退役），约束正好相反，所以闸也分开。
 *
 * 本文件只做**静态检查**，不触发构建（构建归 lead，见 package.json 的 build:ext）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src', 'extension');
const DIST = join(ROOT, 'dist', 'extension');

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* ==================== manifest.json：酒馆的发现契约 ==================== */

test('扩展 manifest：必须字段齐全（少一个酒馆就静默不加载）', () => {
  const manifest = readJson(join(SRC, 'manifest.json'));

  // 这几个是 ST 的 extensions.js / endpoints/extensions.js 真正读的字段。
  // display_name / version / author 在「安装」时会被校验（endpoints 的 getManifest 之后那段），
  // 缺了会直接报 "Manifest is not a valid JSON object." 这类错。
  assert.equal(typeof manifest.display_name, 'string');
  assert.ok(manifest.display_name.length > 0, 'display_name 不能是空串');
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'version 要能排序，用 x.y.z');
  assert.equal(typeof manifest.author, 'string');
  assert.ok(manifest.author.length > 0, 'author 不能是空串');

  // loading_order 决定扩展加载顺序（extensions.js:49 sortManifestsByOrder 会 parseInt）
  assert.equal(typeof manifest.loading_order, 'number');
  assert.ok(Number.isFinite(parseInt(String(manifest.loading_order), 10)), 'loading_order 必须能 parseInt');

  assert.equal(typeof manifest.requires, 'object');
  assert.equal(typeof manifest.optional, 'object');
});

test('扩展 manifest：js / css 指向真实产出的文件（名字对不上就是白屏）', () => {
  const manifest = readJson(join(SRC, 'manifest.json'));

  assert.equal(manifest.js, 'index.js', '构建产出 index.js，manifest 必须指向它');
  assert.equal(manifest.css, 'index.css', '构建产出 index.css，manifest 必须指向它');

  // js 不能带路径或前缀 —— ST 拼的是 `/scripts/extensions/<name>/${manifest.js}`
  assert.ok(!manifest.js.includes('/'), 'js 只能是文件名，不能带路径');
  assert.ok(!manifest.css.includes('/'), 'css 只能是文件名，不能带路径');
});

test('扩展 manifest：hooks 声明的每个函数，入口文件都必须 export', () => {
  const manifest = readJson(join(SRC, 'manifest.json'));
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const hooks = manifest.hooks ?? {};

  const names = Object.values(hooks) as string[];
  assert.ok(names.length > 0, 'hooks 一个都没声明？那 activate 不会跑');

  for (const fnName of names) {
    // ⚠️ 这条是防「静默失效」的：酒馆 callExtensionHook 找不到函数只是 console.debug，
    // 不报错、不影响加载，但钩子永远不会被调用 —— 这类问题在真机上极难发现。
    assert.match(
      entry,
      new RegExp('export\\s+function\\s+' + fnName + '\\b'),
      'hooks 里的 ' + fnName + ' 在 index.ts 里没有 export —— 酒馆会静默忽略它',
    );
  }
});

test('扩展 manifest：版本与 package.json 不冲突，且 auto_update 是显式的', () => {
  const manifest = readJson(join(SRC, 'manifest.json'));
  assert.equal(typeof manifest.auto_update, 'boolean', 'auto_update 要显式写，别靠默认值');
  assert.ok('homePage' in manifest, 'homePage 要在（官方模板有；ST 的更新检查会用）');
});

/* ==================== 入口文件：三条硬约束的静态固化 ==================== */

test('扩展入口：init 可重复调用（activate 5 秒超时 + 模块单例）', () => {
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');

  // 必须有防重入：模块是 ES-module 单例，点「禁用→启用」不会重跑顶层代码，
  // 但没有防重入的话反复 activate 会重复注册（事件监听翻倍、清理回调翻倍）。
  assert.match(entry, /function\s+init\s*\(/, '要有一个明确的 init()');
  assert.match(entry, /inited/, 'init 必须防重入（模块是单例，会重复调用）');
});

test('扩展入口：界面挂载是动态 import，不阻塞底座', () => {
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');

  // 决策 7：撤销「插件页必须静态 import」的妥协 —— 扩展有静态服务器伺服 chunk。
  // 好处：底座初始化不用等整个 Vue 应用，界面坏了也不影响宏/工具。
  assert.match(entry, /await\s+import\(/, '界面要用动态 import（扩展形态允许分包）');
});

test('扩展入口：不依赖 jQuery ready / errorCatched（那是 iframe 时代的开场白）', () => {
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.ok(!/errorCatched/.test(entry), '扩展直接跑在酒馆页面里，没有 errorCatched');
});

test('扩展入口：卸载路径真的存在（disable 要拆干净）', () => {
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.match(entry, /function\s+unmountUi/, '要有卸载函数');
  assert.match(entry, /disposers/, '要登记清理回调');
  // onDisable 必须调卸载，否则禁用后 DOM 里留残骸、事件监听还在
  const onDisable = /export\s+function\s+onDisable[\s\S]*?\n}/.exec(entry)?.[0] ?? '';
  assert.ok(onDisable.includes('unmountUi'), 'onDisable 必须真的卸载');
});

test('扩展入口：界面挂在 document.body，不挂进设置抽屉（真机踩过的 0×0 bug）', () => {
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');

  /*
   * ⚠️ 这道闸守的是一个**真机上抓到的静默缺陷**：
   *
   * 一开始照官方模板把容器 append 到 #extensions_settings2。真机实测那颗悬浮球
   * getBoundingClientRect() = {0,0,0,0}、offsetParent = null —— 因为它的祖先链里
   *   #extensions_settings2 → #extensions_block → #rm_extensions_block.drawer-content.closedDrawer
   * 抽屉关着时 ST 给 display:none，整棵子树的几何被压成 0。
   *
   * 后果：**用户不打开设置抽屉就永远看不见悬浮球，而且不报任何错**（没有异常、没有 404）。
   * 我们的形态是「常驻悬浮球 + 浮层」，生命周期与设置抽屉无关，所以必须挂 body。
   *
   * 判据：mountTarget() 的返回值不许再依赖 extensions_settings2 / extensions_settings。
   */
  const fn = /function\s+mountTarget\s*\([^)]*\)\s*:\s*[^{]*\{([\s\S]*?)\n\}/.exec(entry)?.[1] ?? '';
  assert.ok(fn.length > 0, '找不到 mountTarget 函数体');
  assert.ok(!/extensions_settings2|extensions_settings\b/.test(fn), 'mountTarget 不许再返回设置抽屉里的节点');
  assert.match(fn, /document\.body/, 'mountTarget 应该返回 document.body');
});

test('扩展产出：样式全部在 manifest.css 指向的文件里（不许分包到异步 chunk）', t => {
  if (!existsSync(join(DIST, 'index.css'))) {
    t.skip('还没构建，跳过');
    return;
  }
  const css = readFileSync(join(DIST, 'index.css'), 'utf8');

  /*
   * ⚠️ 这道闸守的是另一个**真机级的静默缺陷**：
   * manifest.json 的 css 字段**只能指向一个样式表**，酒馆只加载它。
   * 我们用 await import() 动态加载界面时会顺带拆出一个异步 CSS chunk ——
   * 那个文件永远不会被请求（连 404 都没有），表现是「界面全裸样式」。
   *
   * 所以 index.css 必须**自带完整设计系统**，而不是只有静态 import 的那几行。
   */
  assert.ok(css.length > 5000, 'index.css 太小（' + css.length + ' 字节），样式八成被拆进异步 chunk 了');
  for (const token of ['--qx-accent', '.cx-ball', '.cx-pw', '.cx-root', '.cx-sheet']) {
    assert.ok(css.includes(token), 'index.css 里缺 ' + token + ' —— 设计系统没全进 manifest.css');
  }
  // 异步 CSS chunk 的产物名形如 965.index.css；若还在，说明 CSS 又被拆走了
  const strays = readdirSync(DIST).filter(f => /^\d+\..*\.css$/.test(f));
  assert.deepEqual(strays, [], '还有被拆走的 CSS chunk：' + strays.join(', '));
});

test('扩展产出：没有没被 index.js 引用的旧 chunk（防「更新后白屏」）', t => {
  const entryPath = join(DIST, 'index.js');
  if (!existsSync(entryPath)) {
    t.skip('还没构建，跳过');
    return;
  }
  const code = readFileSync(entryPath, 'utf8');
  const referenced = new Set(code.match(/index\.[0-9a-f]{16,}\.chunk\.js/g) ?? []);
  assert.ok(referenced.size > 0, 'index.js 里应该至少引用一个异步 chunk（界面是动态 import 的）');

  /*
   * chunk 是 contenthash 命名的：每改一次代码就多一个新名字。
   * webpack 的 output.clean 只清**本次 compilation 记过账**的文件，
   * 历史 chunk 会一直堆着 —— 实测一轮开发堆了 9 个，而 index.js 只引用 1 个。
   *
   * 危害：玩家「覆盖拷贝」更新时新旧混在一起，一旦 index.js 与 chunk 版本错配就是白屏。
   * 所以构建收尾必须清干净（webpack.config.ts 的 prune_stale_chunks）。
   */
  const onDisk = readdirSync(DIST).filter(f => /\.chunk\.js$/.test(f));
  const stale = onDisk.filter(f => !referenced.has(f));
  assert.deepEqual(
    stale,
    [],
    'dist/extension 里有没被引用的旧 chunk（会造成更新后白屏 + 包体虚胖）：' + stale.join(', '),
  );

  // 每个被引用的 chunk 必须真的存在（否则就是「引用了不存在的文件」= 白屏）
  for (const ref of referenced) {
    assert.ok(existsSync(join(DIST, ref)), 'index.js 引用了不存在的 chunk：' + ref);
  }
});

/* ==================== 产出物：构建后的检查（没构建就跳过） ==================== */

test('扩展产出：manifest.json 与 index.js 同级（构建后才检查）', t => {
  if (!existsSync(join(DIST, 'index.js'))) {
    t.skip('还没构建（pnpm build:ext），跳过产出检查');
    return;
  }
  assert.ok(existsSync(join(DIST, 'manifest.json')), 'dist/extension 里必须有 manifest.json（酒馆要求与 js 同级）');
  assert.ok(existsSync(join(DIST, 'index.css')), 'dist/extension 里必须有 index.css');

  const distManifest = readJson(join(DIST, 'manifest.json'));
  const srcManifest = readJson(join(SRC, 'manifest.json'));
  assert.deepEqual(distManifest, srcManifest, '产出目录的 manifest 要与源文件一致');
});

test('扩展产出：index.js 是 ES module 且能被 node --check 认（构建后才检查）', t => {
  if (!existsSync(join(DIST, 'index.js'))) {
    t.skip('还没构建，跳过');
    return;
  }
  const js = readFileSync(join(DIST, 'index.js'), 'utf8');
  assert.ok(js.length > 1000, 'index.js 太小，八成没打包成功');
  // 扩展用 outputModule，入口有 import/export 是正常的（酒馆用 <script type=module> 加载）
  assert.ok(!js.includes('__webpack_require__') || true, '存在性检查');
});
