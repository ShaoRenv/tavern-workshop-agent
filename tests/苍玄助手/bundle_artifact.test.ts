/**
 * 验收补充：打包产物 src/酒馆助手脚本-苍玄助手.json 的静态校验。
 *
 * 校验链路：JSON 合法 → 顶层字段 → content 无残留构建占位符 → node --check 语法 →
 * FRAME_HTML_BASE64 解出 iframe HTML → APP_JS_B64 解出真实应用 JS（含苍玄助手代码）。
 * 注意：这里只检查产物本身，不触发构建（build 归 lead）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BUNDLE = 'src/酒馆助手脚本-苍玄助手.json';

function readBundle() {
  return JSON.parse(readFileSync(BUNDLE, 'utf8'));
}

function nodeCheck(source, name) {
  const dir = mkdtempSync(join(tmpdir(), 'cx-check-'));
  const file = join(dir, name);
  writeFileSync(file, source, 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

const bundle = readBundle();
const frameHtml = Buffer.from(/const FRAME_HTML_BASE64 = '([^']+)'/.exec(bundle.content)?.[1] ?? '', 'base64').toString('utf8');
const appJs = Buffer.from(/(?:const|var|let)\s+APP_JS_B64\s*=\s*['"]([^'"]+)['"]/.exec(frameHtml)?.[1] ?? '', 'base64').toString('utf8');
const appCss = Buffer.from(/(?:const|var|let)\s+APP_CSS_B64\s*=\s*['"]([^'"]+)['"]/.exec(frameHtml)?.[1] ?? '', 'base64').toString('utf8');

test('bundle: 文件存在且是合法 JSON，顶层字段正确', () => {
  assert.equal(typeof bundle, 'object');
  assert.equal(bundle.type, 'script');
  assert.equal(bundle.enabled, true);
  assert.equal(bundle.name, '苍玄助手');
  assert.match(bundle.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof bundle.info, 'string');
  assert.ok(bundle.info.includes('苍玄助手'));
  assert.equal(typeof bundle.content, 'string');
  assert.ok(bundle.content.length > 100000, 'content 太小，八成没内联构建产物');
  assert.deepEqual(bundle.button, { enabled: true, buttons: [] });
});

test('bundle: content 里没有残留的构建占位符', () => {
  // panel.js / frame.html 里的运行时桥名不是占位符
  const allowed = new Set(['__CX_HOST_API__', '__CX_HOST_READY__']);
  const tokens = [...new Set(bundle.content.match(/__[A-Z0-9_]{3,}__/g) ?? [])].filter(token => !allowed.has(token));
  assert.deepEqual(tokens, [], '有没替换掉的构建占位符');
  assert.ok(!bundle.content.includes('__FRAME_HTML_BASE64__'));
  assert.ok(!bundle.content.includes('__APP_JS_B64__'));
  assert.ok(!bundle.content.includes('__APP_CSS_B64__'));
  // 只扫**代码**里的宏占位符：注释里的 `{{宏名}}` 是说明文字（比如讲「插件贡献的宏」时举的例子），
  // 不是没渲染的残留。用 codeOnly 剥掉注释再扫 —— 否则写一句注释就把这道闸弄红了（验收 F-V3 的误报）。
  const code = bundle.content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
  assert.deepEqual([...new Set(code.match(/\{\{[^{}]{0,60}\}\}/g) ?? [])], [], '还有 {{宏}} 没渲染');
});

test('bundle: content 本身通过 node --check（导入酒馆前至少语法合法）', () => {
  assert.equal(/^\s*(import|export)\s/m.test(bundle.content), false, 'content 是普通脚本，不能有顶层 import/export');
  nodeCheck(bundle.content, 'content.js');
});

test('bundle: base64 链路解得出真实 iframe HTML / app JS / app CSS', () => {
  assert.ok(frameHtml.startsWith('<!DOCTYPE html>'), 'FRAME_HTML_BASE64 没解出 HTML');
  assert.ok(frameHtml.includes('__CX_HOST_API__'), 'iframe HTML 里应该有宿主桥');
  assert.ok(frameHtml.includes('cxBase64ToText'), 'iframe HTML 里应该有 base64 解码函数');
  assert.ok(appJs.length > 50000, 'app JS 太小：' + appJs.length);
  assert.ok(appCss.length > 1000, 'app CSS 太小：' + appCss.length);
  assert.ok(!appJs.includes('sourceMappingURL'), '构建时应剥掉 sourceMappingURL');
});

test('bundle: 内联的 app JS 真的是苍玄助手（不是别的工程的界面）', () => {
  for (const marker of ['苍玄助手', 'entry_edit', 'wb_search', 'create_skill', 'gen_image', 'read_skill_file', 'ask_user', 'cx_assistant_v1']) {
    assert.ok(appJs.includes(marker), 'app JS 里找不到 ' + marker);
  }
  assert.ok(appJs.length > 100000);
});

test('bundle: 面板里没有残留「苍玄界立绘工坊」（回归 task-9 的 P2-2）', () => {
  assert.ok(!bundle.content.includes('立绘工坊'), 'content 里还有别的产品名');
  assert.ok(!frameHtml.includes('立绘工坊'), 'iframe HTML 里还有别的产品名');
  assert.ok(!appJs.includes('立绘工坊'), 'app JS 里还有别的产品名');
  const title = (/<title>([^<]*)<\/title>/.exec(frameHtml) ?? [])[1];
  assert.equal(title, '苍玄助手', 'iframe 面板标题应该叫苍玄助手');
});

test('bundle: 内联的 app JS 带上了脚本变量存储（type: script + __CX_SCRIPT_ID__）', () => {
  assert.ok(appJs.includes('__CX_SCRIPT_ID__'), '没打进去 script id 解析链');
  assert.ok(appJs.includes("type:'script'") || appJs.includes('type:"script"'), '没打进去脚本作用域');

  /*
   * 存储失败的报错文案：**从源码现取，不写死**；口径是「源码里**所有** `保存失败：…` 片段，
   * 产物里都必须找得到」。
   *
   * ## 为什么从源码现取
   *
   * 这条原来写死了「没有可用的酒馆助手脚本变量接口」。阶段 3.5 扩展化时那句文案被改成
   * 形态无关的「没有可用的变量写入接口」（存储现在两形态通用），**断言没跟着改 → 过期红**
   * （独立验收抓到，当时跑的 507/507 是拿**旧构建产物**跑的 —— 假绿一次，别再写死文案）。
   *
   * 现取还有个额外好处：它顺带成了「**有没有重新 build**」的闸 ——
   * 源码改了文案却忘了重新构建，产物里的字还是旧的，这条就会红。
   * 跑测试前先 `pnpm build`（它会重新生成 src/酒馆助手脚本-苍玄助手.json）。
   *
   * ## 为什么是「全部匹配」而不是「第一个匹配」（task-27 收紧）
   *
   * 旧版只长了一半的牙，独立验收做了四个实验，两个漏网：
   *   ① 正则 `没有可用的[^'"，（）\n]*接口` 的字符类**排除了 `（`** → 只捕获到
   *      「没有可用的变量写入接口」，**括号后的内容根本不在捕获范围内**
   *      → 在第 1 个括号后加一个字符，断言照样绿（实验①：期望红、实测绿）；
   *   ② 这句文案在 core/storage.ts 有**两处**，而 `.exec()` **只取第一处** →
   *      只改其中一处（最常见的场景！）看不见（实验③：期望红、实测绿）。
   *
   * 收紧办法有两条，这里都用了：
   *   - 字符类**不含 `（` `）`**、捕获到引号或行尾 → 括号后的内容也在范围内；
   *   - `matchAll` 取**全部** `保存失败：…` 片段 → 两处各自断言，只改一处也会红。
   * 另外断言「至少抓到 2 处」，防止有人又把它退回 `.exec()`。
   *
   * 四个实验（都不重新 build）的实测：改括号后 → **红** ✅ / 只改一处 → **红** ✅ /
   * 两处都改 → **红** ✅ / 逐字还原 → **绿** ✅。
   */
  const storageSrc = readFileSync('src/苍玄助手/core/storage.ts', 'utf8');
  /**
   * 源码里每一段 `保存失败：…` 文案（直到引号或行尾）。
   *
   * 关键点：字符类**不含 `（` `）`**，所以括号里的接口名也在捕获范围内 ——
   * 这正是旧版漏掉的那一半。遇到 `'` / `"`（字符串结束）或换行即止。
   */
  const phrases = [...storageSrc.matchAll(/保存失败：[^'"\n]*/g)].map(match => match[0].trim());

  assert.ok(phrases.length > 0, 'core/storage.ts 里找不到任何「保存失败：…」文案（正则该跟着文案更新）');
  // 两处都要被抓到 —— 只抓到一处说明又退回「只取第一处」了
  assert.ok(
    phrases.length >= 2,
    'core/storage.ts 的「保存失败：…」应该有两处（保存路径 / 另一条路径），实际抓到 ' + phrases.length + ' 处：' + JSON.stringify(phrases),
  );

  for (const phrase of phrases) {
    assert.ok(
      appJs.includes(phrase),
      '构建产物的存储报错文案与源码不一致：\n  源码：' + phrase + '\n（改动后忘了重新 build？或只改了源码没改另一处？）',
    );
  }

  assert.ok(appJs.includes('getScriptId'), '降级链里要有 getScriptId');
});

/*
 * 这里原来还有一条 assert(!appJs.includes("type:'global'"))，**已删除**。
 *
 * 它的原始意图是：老版存储只走「脚本变量」一个作用域，产物里出现 type:'global'
 * 说明有人写错了域。这条闸在阶段 3.5 之后**过期了**：
 *
 * 变量作用域适配层（core/native.ts）现在**必须**同时覆盖 local / global 两档 ——
 * 它要把 ST 原生的 variables.{local,global} 适配成底座的老「整表」语义
 * （决策 3：StoragePort 抽层；决策 2 的能力表也依赖它能探测两档）。
 * 所以 'global' 这个**字符串**出现在产物里是正确的，不是回归。
 *
 * 判据：闸拦的是「用错了域」，不是「提到了 global 这个词」。
 * 直接删掉而不是换个正则 —— 「产物里出现某字符串」本来就不能证明语义对错，
 * 真正该管的是**运行时用哪个域**，那由 core_script_scope.test.ts 按行为断言。
 */

test('bundle: 面板桥接了全部宿主接口（回归「只桥 8 / 19」那个真 bug）', () => {
  // panel.js 的 HOST_API_NAMES 必须覆盖应用要用的全部接口。
  // 少一个，那个函数在面板 iframe 里就是 undefined —— 真酒馆里实测过一次：
  // 只桥 8 个 → 世界书写不了、脚本变量拿不到 script_id（存储也废）。
  for (const name of [
    'getVariables',
    'insertOrAssignVariables',
    'replaceVariables',
    'updateVariablesWith',
    'getScriptId',
    'getScriptTrees',
    'getWorldbookNames',
    'getGlobalWorldbookNames',
    'getCharWorldbookNames',
    'getChatWorldbookName',
    'getWorldbook',
    'replaceWorldbook',
    'createWorldbook',
    'deleteWorldbook',
    'createOrReplaceWorldbook',
    'generateRaw',
    'stopAllGeneration',
    'getModelList',
    'substitudeMacros',
  ]) {
    assert.ok(bundle.content.includes("'" + name + "'"), 'panel 的桥接名单里少了 ' + name);
  }
  assert.ok(bundle.content.includes('HOST_API_NAMES'), 'panel.js 应该用数组声明桥接名单');
});

test('bundle: 阶段 2 的 4 格页面 / 「能力」并进设置 / 记录进 ⋯ Sheet 都在产物里', () => {
  const all = bundle.content + appJs + appCss;

  // A9：页面 id 与标题来自页面注册表（core/pages.ts 的核心页 + 插件 manifest 的 contributes.pages），
  // 不再是写死的页签名单。标识符会被压缩掉，所以这里断言**字符串字面量**真的进了产物。
  // 阶段 2 的 4 格：对话/设置（核心页）+ 苍玄助手(portraits)/世界书(worldbook)（插件页）
  for (const marker of ['chat', 'portraits', 'worldbook', 'settings', '对话', '设置', '苍玄助手', '世界书']) {
    assert.ok(all.includes(marker), '页面注册表里的 ' + marker + ' 应该出现在产物里');
  }

  // 记录与能力都不再占页面，但文案还在：记录 = 对话页 ⋯ 的 Sheet 标题；能力 = 设置里的一格
  for (const marker of ['记录', '能力', '接口', '预设', '数据', '工具', '技能', '插件']) {
    assert.ok(all.includes(marker), '产物里找不到 ' + marker);
  }

  // F2：来源插件关掉时的兜底行文案 + 工具错误码
  for (const marker of ['来源已停用', 'cx-multi', 'SCOPE_DENIED']) {
    assert.ok(all.includes(marker), '产物里找不到 ' + marker);
  }

  // 老页名只作为 TAB_ID_ALIASES 的键留下（兜老数据的 active_tab），不再是页面 / 一次性事件
  assert.ok(all.includes('capability') && all.includes('records'), '老页名还要留着兜老数据');
  assert.equal(all.includes('goto-capability'), false, '阶段 2 删掉了 goto-capability 跨页事件');
});