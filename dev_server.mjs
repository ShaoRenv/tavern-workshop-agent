// 苍玄助手 · 本地开发服务器（自动推送）
//
// 它把 dist/ 里最新的构建组装成「酒馆助手脚本正文」，通过 HTTP 暴露出来。
// 酒馆里导入的「苍玄助手（开发版）」脚本，正文只有一行动态 import，就指向这里。
// 于是：改代码 → pnpm dev → 刷新酒馆 = 新版本。不用打包、不用重新导入 JSON。
//
//   node dev_server.mjs              只起服务器
//   node dev_server.mjs --watch      顺便跑 webpack --watch
//   node dev_server.mjs --emit-json  只生成开发版脚本 JSON 然后退出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.CX_DEV_PORT || 8787);
// 酒馆助手「实时监听器」默认端口：顺手也开上，省得去改设置
const EXTRA_PORT = Number(process.env.CX_LISTENER_PORT || 6621);
const DIST_HTML = path.join(ROOT, 'dist', '苍玄助手', 'index.html');
const FRAME_HTML = path.join(ROOT, 'tavern_script', 'frame.html');
const PANEL_JS = path.join(ROOT, 'tavern_script', 'panel.js');
const DEV_JSON = path.join(ROOT, 'src', '酒馆助手脚本-苍玄助手-开发版.json');
const DEV_SCRIPT_NAME = '苍玄助手（开发版）';
// 开发版故意用独立 id：和正式版分开，脚本变量互不影响，正式数据不会被开发版写坏。
const DEV_SCRIPT_ID = 'c8f3a1d2-5b6e-4c7a-9d18-2e4f6a8b0c11';
const DEV_SCRIPT_INFO =
  '开发版：正文从本机开发服务器拉取最新构建，改代码后刷新酒馆即生效。' +
  '数据存在本脚本自己的脚本变量里，与正式版互不影响。需要先在项目目录运行 pnpm dev。';

/** 本机的局域网 IPv4：手机上的酒馆要靠它找到这个开发服务器 */
function lanHost() {
  const nets = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      all.push({ name, address: info.address });
    }
  }
  const prefer = all.find(i => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(i.address));
  return (prefer || all[0] || { address: '127.0.0.1' }).address;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function extractBetween(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error('构建产物里找不到 ' + label + ' 的起始标记（先跑一次 pnpm build:dev）');
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  if (end < 0) throw new Error('构建产物里找不到 ' + label + ' 的结束标记');
  return text.slice(from, end).trim();
}

function readBuild() {
  if (!fs.existsSync(DIST_HTML)) {
    throw new Error('还没有构建产物：先跑一次 pnpm build:dev（或让 --watch 先跑起来）');
  }
  const html = fs.readFileSync(DIST_HTML, 'utf8');
  return {
    js: extractBetween(html, '<script type="module">', '</script>', '应用脚本'),
    css: extractBetween(html, '<style>', '</style>', '样式'),
    builtAt: fs.statSync(DIST_HTML).mtime,
  };
}

// 开发版的面板 HTML：JS/CSS 走外链（有 source map、没有 base64 膨胀）
// 局域网调试：面板里的 app.js / app.css 必须指向「手机访问时用的那个地址」，
// 所以这里用请求自带的 Host 头拼绝对地址 —— 本机用 127.0.0.1、手机用局域网 IP 都能拿到。
function buildFrame(stamp, host) {
  const base = 'http://' + (host || '127.0.0.1:' + PORT);
  return fs
    .readFileSync(FRAME_HTML, 'utf8')
    .replaceAll('__APP_CSS_B64__', '')
    .replaceAll('__APP_JS_B64__', '')
    .replaceAll('__APP_CSS_URL__', base + '/app.css?t=' + stamp)
    .replaceAll('__APP_JS_URL__', base + '/app.js?t=' + stamp);
}

// 酒馆助手脚本正文：把面板 HTML 塞进 panel.js 的占位符
function buildPanelScript(stamp, host) {
  const frameBase64 = Buffer.from(buildFrame(stamp, host), 'utf8').toString('base64');
  const panel = fs.readFileSync(PANEL_JS, 'utf8');
  if (!panel.includes('__FRAME_HTML_BASE64__')) {
    throw new Error('tavern_script/panel.js 里找不到 __FRAME_HTML_BASE64__ 占位符');
  }
  return panel.replaceAll('__FRAME_HTML_BASE64__', frameBase64);
}

// 「苍玄助手（开发版）」的正文放在 tavern_script/dev_loader.js 里（独立文件，好改好读），
// 这里只把 __PORT__ 换成实际端口。
function devScriptContent() {
  const file = path.join(ROOT, 'tavern_script', 'dev_loader.js');
  if (!fs.existsSync(file)) throw new Error('缺少 tavern_script/dev_loader.js');
  return fs
    .readFileSync(file, 'utf8')
    .replaceAll('__HOST__', lanHost())
    .replaceAll('__PORT__', String(PORT));
}


function devScriptPayload() {
  return {
    type: 'script',
    enabled: true,
    name: DEV_SCRIPT_NAME,
    id: DEV_SCRIPT_ID,
    info: DEV_SCRIPT_INFO,
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: false, button: false },
    content: devScriptContent(),
  };
}

function send(res, status, type, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': type });
  res.end(body);
}

function statusText() {
  const build = readBuild();
  return {
    ok: true,
    port: PORT,
    built_at: build.builtAt.toISOString(),
    js_kb: Math.round(build.js.length / 1024),
    css_kb: Math.round(build.css.length / 1024),
  };
}

function homePage() {
  let status;
  try {
    status = statusText();
  } catch (error) {
    return '<h1>苍玄助手 · 开发服务器</h1><p style="color:#b91c1c">' + String(error.message || error) + '</p>';
  }
  return [
    '<!DOCTYPE html><meta charset="utf-8"><title>苍玄助手 · 开发服务器</title>',
    '<style>body{font:14px/1.7 system-ui;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#0f172a}',
    'code{background:#f1f5f9;padding:.1em .35em;border-radius:4px}</style>',
    '<h1>苍玄助手 · 开发服务器</h1>',
    '<p>端口 <code>' + PORT + '</code> · 当前构建 ' + status.built_at +
      '（JS ' + status.js_kb + ' KB / CSS ' + status.css_kb + ' KB）</p>',
    '<ol><li>酒馆助手 → 脚本库 → 导入 <code>src/酒馆助手脚本-苍玄助手-开发版.json</code></li>',
    '<li>确保这个脚本是开着的，然后刷新酒馆页面</li>',
    '<li>每次改完代码，webpack --watch 重新构建后，刷新酒馆即生效</li></ol>',
    '<p>可以直接看：<a href="/panel.js">/panel.js</a> · <a href="/frame.html">/frame.html</a> · ' +
      '<a href="/app.js">/app.js</a> · <a href="/status">/status</a> · ' +
      '<a href="/reload">手动推送一次重载</a></p>',
  ].join('');
}

const server = http.createServer((req, res) => {
  const route = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  try {
    if (route === '/panel.js' || route === '/script.js') {
      const from = req.headers.origin || req.headers.referer || '(没带来源)';
      const code = buildPanelScript(Date.now(), req.headers.host);
      console.info('[dev] 有人来拿面板了 ← ' + from + '（' + code.length + ' 字节）');
      return send(res, 200, 'text/javascript; charset=utf-8', code);
    }
    if (route === '/probe') {
      console.info('[dev] 探测请求 ← ' + (req.headers.origin || req.headers.referer || '(没带来源)'));
      return send(res, 200, 'text/plain; charset=utf-8', 'ok');
    }
    if (route === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', readBuild().js);
    if (route === '/app.css') return send(res, 200, 'text/css; charset=utf-8', readBuild().css);
    if (route === '/frame.html') return send(res, 200, 'text/html; charset=utf-8', buildFrame(Date.now(), req.headers.host));
    if (route === '/script.json') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(devScriptPayload(), null, 2));
    if (route === '/status') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(statusText(), null, 2));
    if (route === '/reload') {
      pushToTavern('手动点了 /reload');
      return send(res, 200, 'text/plain; charset=utf-8', 'ok');
    }
    if (route === '/') return send(res, 200, 'text/html; charset=utf-8', homePage());
    return send(res, 404, 'text/plain; charset=utf-8', '没有这个地址');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[dev] ' + message);
    return send(res, 500, 'text/plain; charset=utf-8', '苍玄助手开发服务器出错：' + message);
  }
});

const args = process.argv.slice(2);

if (args.includes('--emit-json')) {
  fs.writeFileSync(DEV_JSON, JSON.stringify(devScriptPayload(), null, 2), 'utf8');
  console.info('[dev] 已生成 ' + path.relative(ROOT, DEV_JSON));
  process.exit(0);
}

/* ---------------- 推送到端口：酒馆助手的「实时监听器」 ---------------- */
// 酒馆助手 → 开发者 → 实时监听器 连的就是一个 socket.io 服务；
// 收到 iframe_updated / script_iframe_updated 时它会重载所有脚本 iframe。
// 我们把这个服务端实现出来，于是 webpack 一重新构建，酒馆里就自动换新代码。
const ioServers = [];

function attachListener(httpServer, port) {
  const io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: 1e11 });
  ioServers.push(io);
  io.on('connect', socket => {
    console.info('[dev] 酒馆连上监听器了（端口 ' + port + '）');
    socket.on('disconnect', reason => console.info('[dev] 监听器断开：' + reason));
  });
  return io;
}

function connectedCount() {
  return ioServers.reduce((sum, io) => sum + io.sockets.sockets.size, 0);
}

/** 让酒馆重载所有脚本 iframe —— 这就是「推送」 */
function pushToTavern(reason) {
  const count = connectedCount();
  ioServers.forEach(io => {
    try {
      io.emit('script_iframe_updated');
      io.emit('iframe_updated');
    } catch (error) {
      /* 推送失败不该弄死服务器 */
    }
  });
  console.info('[dev] 已推送重载（' + reason + '；连着 ' + count + ' 个酒馆页面）');
}

// 盯住构建产物：webpack --watch 一写出新文件就推送
let pushTimer = null;
function watchBuild() {
  const dir = path.dirname(DIST_HTML);
  if (!fs.existsSync(dir)) {
    console.warn('[dev] dist/苍玄助手 还不存在，先跑一次构建；自动推送暂时没开');
    return;
  }
  try {
    fs.watch(dir, (event, filename) => {
      const name = String(filename || '');
      if (name && name.indexOf('index.html') < 0) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => pushToTavern('构建产物更新'), 400);
    });
    console.info('[dev] 已盯住 dist/苍玄助手，重新构建后会自动推送重载');
  } catch (error) {
    console.warn('[dev] 盯 dist 失败：' + (error && error.message ? error.message : error));
  }
}

// 绑 0.0.0.0：手机走局域网时也必须能拿到面板（原来只绑 127.0.0.1，手机必然失败）
server.listen(PORT, '0.0.0.0', () => {
  console.info('[dev] 苍玄助手开发服务器: http://127.0.0.1:' + PORT + ' （局域网：http://' + lanHost() + ':' + PORT + '）');
  console.info('[dev] 酒馆里导入 src/酒馆助手脚本-苍玄助手-开发版.json，然后刷新一次酒馆页面');
  console.info('[dev] 想让它自动重载：酒馆助手 → 开发者 → 实时监听器，填 http://' + lanHost() + ':' + EXTRA_PORT);
});
attachListener(server, PORT);

// 顺手把酒馆助手监听器的默认端口也开上，省得你去改设置
if (EXTRA_PORT !== PORT) {
  const listenerOnly = http.createServer((req, res) => send(res, 200, 'text/plain; charset=utf-8', '苍玄助手监听器'));
  listenerOnly.on('error', error => console.warn('[dev] 端口 ' + EXTRA_PORT + ' 没起来（多半被占了）：' + error.message));
  try {
    listenerOnly.listen(EXTRA_PORT, () => console.info('[dev] 监听器端口 ' + EXTRA_PORT + ' 已开（酒馆助手的默认值）'));
    attachListener(listenerOnly, EXTRA_PORT);
  } catch (error) {
    console.warn('[dev] 监听器端口 ' + EXTRA_PORT + ' 起不来：' + error.message);
  }
}

watchBuild();

if (args.includes('--watch')) {
  console.info('[dev] 启动 webpack --watch（开发模式）…');
  const webpackBin = path.join(ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js');
  const child = spawn(process.execPath, [webpackBin, '--mode', 'development', '--watch', '--color'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.on('exit', code => console.warn('[dev] webpack --watch 退出了（code ' + code + '）'));
}