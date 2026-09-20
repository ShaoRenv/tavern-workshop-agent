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
  assert.ok(!appJs.includes("type:'global'") && !appJs.includes('type:"global"'), '不该再有 global 作用域');
  assert.ok(appJs.includes('没有可用的酒馆助手脚本变量接口'), '存储报错文案应该是脚本变量版本');
  assert.ok(appJs.includes('getScriptId'), '降级链里要有 getScriptId');
});

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

