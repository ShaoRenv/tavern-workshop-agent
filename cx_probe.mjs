// 酒馆工坊Agent · 真机探针（一条命令，不用手写 CDP 胶水）
//
// 以前跑一次探针 = 写探针文件 + 一次 pwsh 启动 + 一次 CDP 握手 + 手动 sleep 等挂载 + 再跑一次。
// 现在：node cx_probe.mjs <探针文件> [--reload]
//
// 探针文件写法（**注意必须是 async 箭头函数，不能是 module.exports**）：
//   async () => { const ctx = SillyTavern.getContext(); return { chatLen: ctx.chat.length }; }
//
// 返回值会被 JSON.stringify 后打印。抛异常会打印错误栈。
// --reload 先刷新页面并等 #cx-root-mount 就绪，再跑探针（改了代码后想验新版本时用）。
//
// 环境变量：CX_CDP_PORT（默认 9222）、CX_TAVERN_PORT（默认 8000）
import fs from 'node:fs';

const CDP_PORT = Number(process.env.CX_CDP_PORT || 9222);
const TAVERN_PORT = Number(process.env.CX_TAVERN_PORT || 8000);
const args = process.argv.slice(2);
const RELOAD = args.includes('--reload');
const file = args.find(a => !a.startsWith('--'));

if (!file) {
  console.error('用法：node cx_probe.mjs <探针文件.js> [--reload]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('找不到探针文件：' + file);
  process.exit(2);
}

/* ============================ CDP 连接 ============================ */

const targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json();
const page =
  targets.find(t => t.type === 'page' && t.url.includes(String(TAVERN_PORT))) ?? targets.find(t => t.type === 'page');
if (!page) {
  console.error('CDP 里没有可用的页面。酒馆开了吗？Chrome 带 --remote-debugging-port=' + CDP_PORT + ' 了吗？');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
  setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
});
const send = (method, params = {}) =>
  new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

/* ============================ 可选：先重载 ============================ */

if (RELOAD) {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    const r = await send('Runtime.evaluate', { expression: "!!document.getElementById('cx-root-mount')", returnByValue: true });
    if (r.result?.result?.value === true) {
      ready = true;
      break;
    }
  }
  if (!ready) console.error('[probe] 警告：60s 内没等到挂载点，可能页面报错');
}

/* ============================ 跑探针 ============================ */

const source = fs.readFileSync(file, 'utf8');
const r = await send('Runtime.evaluate', {
  expression: '(' + source + ')()',
  awaitPromise: true,
  returnByValue: true,
  timeout: 120_000,
});

if (r.result?.exceptionDetails) {
  const ex = r.result.exceptionDetails;
  console.error('[probe] 探针抛异常：' + (ex.exception?.description ?? ex.text));
  ws.close();
  process.exit(1);
}

console.log(JSON.stringify(r.result?.result?.value ?? null, null, 1));
ws.close();
