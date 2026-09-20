// 把 dist 里构建好的前端界面打包成「可直接导入酒馆助手」的脚本 JSON。
//
// 用法:
//   pnpm build            先生成 dist/苍玄助手/index.html
//   pnpm build:script     再生成 src/酒馆助手脚本-苍玄助手.json
//
// 产物形态与仓库里现有的「酒馆助手脚本-状态栏.json」一致，可直接在酒馆助手的脚本库里导入。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const DIST_HTML = path.join(ROOT, 'dist', '苍玄助手', 'index.html');
const FRAME_HTML = path.join(ROOT, 'tavern_script', 'frame.html');
const PANEL_JS = path.join(ROOT, 'tavern_script', 'panel.js');
const OUT_JSON = path.join(ROOT, 'src', '酒馆助手脚本-苍玄助手.json');

const SCRIPT_NAME = '苍玄助手';
// 固定脚本 id：数据存在「脚本变量」里，靠这个 id 定位。
// 如果每次打包都换随机 id，用户重新导入更新版就会变成另一个脚本，
// 原来那套预设/技能/设置看起来就像丢了。所以这里写死。
const SCRIPT_ID = 'b7c1e2d3-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
const SCRIPT_INFO =
  '苍玄助手：立绘元数据转角色预设（智绘姬 / 小白x）+ 世界书 Agent（增删改查）+ 技能。点击输入框上方的「苍玄助手」按钮打开面板；脚本只读本机数据，不调用创意工坊的云服务。';

function fail(message) {
  console.error('[build_tavern_script] ' + message);
  process.exit(1);
}

function extractBetween(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) fail('构建产物里找不到 ' + label + ' 的起始标记，可能构建方式变了');
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  if (end < 0) fail('构建产物里找不到 ' + label + ' 的结束标记');
  return text.slice(from, end);
}

for (const file of [DIST_HTML, FRAME_HTML, PANEL_JS]) {
  if (!fs.existsSync(file)) fail('缺少文件: ' + file + '（先运行 pnpm build）');
}

const html = fs.readFileSync(DIST_HTML, 'utf8');

// 构建产物是单文件形态：<script type="module">应用</script> + <style>样式</style>
const appJs = extractBetween(html, '<script type="module">', '</script>', '应用脚本')
  .replace(/\/\/# sourceMappingURL=[^\n]*/g, '')
  .trim();
const appCss = extractBetween(html, '<style>', '</style>', '样式')
  .replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, '')
  .trim();

if (!appJs) fail('应用脚本为空');
if (!appCss) fail('样式为空');

const appJsBase64 = Buffer.from(appJs, 'utf8').toString('base64');
const appCssBase64 = Buffer.from(appCss, 'utf8').toString('base64');

// 1) 组合面板 iframe 的 HTML（把应用的 JS/CSS 以 base64 内嵌，避免任何转义问题）
const frameHtml = fs
  .readFileSync(FRAME_HTML, 'utf8')
  .replaceAll('__APP_CSS_B64__', appCssBase64)
  .replaceAll('__APP_JS_B64__', appJsBase64)
  // 发布包不要外链：把两个 URL 占位符抹成空串，frame 里就会走 base64 分支
  .replaceAll('__APP_CSS_URL__', '')
  .replaceAll('__APP_JS_URL__', '');

const frameHtmlBase64 = Buffer.from(frameHtml, 'utf8').toString('base64');

// 2) 组合脚本正文（把整个 iframe HTML 再以 base64 内嵌）
const panelSource = fs.readFileSync(PANEL_JS, 'utf8');
if (!panelSource.includes('__FRAME_HTML_BASE64__')) fail('panel.js 里找不到 __FRAME_HTML_BASE64__ 占位符');
const scriptContent = panelSource.replaceAll('__FRAME_HTML_BASE64__', frameHtmlBase64);

// 3) 写出与「状态栏」同形态的脚本 JSON
const payload = {
  type: 'script',
  enabled: true,
  name: SCRIPT_NAME,
  id: SCRIPT_ID,
  info: SCRIPT_INFO,
  button: { enabled: true, buttons: [] },
  data: {},
  export_with: { data: false, button: false },
  content: scriptContent,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');

const sizeKb = (Buffer.byteLength(scriptContent, 'utf8') / 1024).toFixed(0);
console.info(
  '[build_tavern_script] 已生成 ' +
    path.relative(ROOT, OUT_JSON) +
    '（脚本正文 ' +
    sizeKb +
    ' KB；应用 JS ' +
    (appJs.length / 1024).toFixed(0) +
    ' KB，CSS ' +
    (appCss.length / 1024).toFixed(0) +
    ' KB）',
);
