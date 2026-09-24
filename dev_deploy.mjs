// 酒馆工坊Agent · 一键部署（开发闭环）
//
// 解决什么：以前「改代码 → 生效」要 7 步（production 构建 → 删旧 chunk → 复制 5 个文件 →
// 刷新 → 等 16-18s → 探针），每步一次往返，每步输出全进上下文。
// 这个脚本把它压成一条命令：**改代码 → 自动生效**。
//
//   node dev_deploy.mjs            构建一次 + 部署 + 重载酒馆
//   node dev_deploy.mjs --watch    盯着源码，改了自动重新构建 + 部署 + 重载
//   node dev_deploy.mjs --no-reload 只构建部署，不动浏览器
//
// 输出口径（**这是省 token 的关键，别改**）：
//   成功 = 一行；失败 = 尾部一小段。webpack 那几百行日志成功时一个字都不打。
//
// ── 为什么盯产物目录、而不是解析 webpack 日志 ──
// webpack.config.ts 导出的是 **11 个入口**（示例 / 脚本 / 前端界面 / 扩展…），每个 compiler
// 各打一行 `compiled ... in N ms`。按「看到完成行就部署」会在**扩展那个入口还没编译完**时
// 就拷文件 —— index.js 引用着还不存在的 chunk，正好是「更新后白屏」那个经典事故。
// 所以判定口径改成：**dist/extension/index.js 变了才部署**，这是唯一不会误判的信号。
//
// 依赖：Node 24（原生 WebSocket / fetch）。CDP 端口默认 9222，可用 CX_CDP_PORT 覆盖。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const DIST = path.join(ROOT, 'dist', 'extension');

/** 酒馆实际加载的那份扩展（GitHub 全局安装；不是 data/default-user/extensions 里那个） */
const TARGET =
  process.env.CX_DEPLOY_TARGET ??
  path.join('C:', 'SillyTavern-1.18.0', 'public', 'scripts', 'extensions', 'third-party', 'tavern-workshop-agent');

const CDP_PORT = Number(process.env.CX_CDP_PORT || 9222);
const WATCH = process.argv.includes('--watch');
const NO_RELOAD = process.argv.includes('--no-reload');

const log = (...a) => console.info('[deploy]', ...a);

/**
 * 最近一次编译是否失败。
 *
 * ⚠️ 必须拦住：webpack 在 development 模式下**即使编译报错也会 emit**（产物是半成品，
 * index.js 可能引用着没写出的 chunk）。只靠「产物目录变了」会把这半套拷进酒馆 ——
 * 正是「更新后白屏」。所以失败时只报错、不部署，酒馆里继续跑上一版。
 */
let buildError = null;

/** 最后一次源码改动时刻 —— 用来报「改代码 → 生效」的真实延迟 */
let lastChangeAt = 0;
if (WATCH) {
  try {
    fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => {
      lastChangeAt = Date.now();
    });
  } catch (e) {
    log('（源码监听失败，计时会不准：' + e.message + '）');
  }
}

/* ============================ 构建 ============================ */

const webpackBin = path.join(ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js');

function runWebpack() {
  return new Promise((resolve, reject) => {
    const args = [webpackBin, '--mode', 'development'];
    if (WATCH) args.push('--watch');
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    // 成功时整段吞掉；失败时只吐尾部一小段
    const tail = [];
    const remember = text => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // 这几类是环境噪音（pnpm 11 的脚本转发、Node 弃用警告），不是构建问题
        if (/DeprecationWarning|MaxListenersExceededWarning|NO_COLOR|trace-warnings/.test(line)) continue;
        tail.push(line);
      }
      while (tail.length > 60) tail.shift();
    };

    let failed = false;
    const reportFailure = () => {
      console.error('[deploy] 构建失败（这次不部署，酒馆里还是上一版）：');
      console.error(tail.slice(-25).join('\n'));
    };
    const onChunk = (buf, isErr) => {
      const text = buf.toString();
      remember(text);
      // 精确匹配 webpack 的总结行：`compiled successfully` / `compiled with N error(s)`
      const summary = text.match(/compiled (successfully|with \d+ errors?) in \d+ ms/);
      if (!summary) return;
      if (summary[1] !== 'successfully') {
        failed = true;
        buildError = summary[0];
        reportFailure();
        if (!WATCH) reject(new Error('构建失败'));
        return;
      }
      // 成功：清掉上一次的错误标记（watch 模式下要能自己恢复）
      buildError = null;
      if (!WATCH) {
        // 单次模式：编译完就部署（不用等产物 watcher）
        deploy()
          .then(resolve)
          .catch(reject);
      }
      // watch 模式：这里**不做任何事**，交给产物 watcher（见下）
    };

    child.stdout.on('data', b => onChunk(b, false));
    child.stderr.on('data', b => onChunk(b, true));
    child.on('exit', code => {
      if (WATCH) return;
      if (code !== 0 && !failed) {
        console.error('[deploy] webpack 退出码 ' + code + '：');
        console.error(tail.slice(-25).join('\n'));
        reject(new Error('构建失败'));
      } else if (code === 0 && !failed) {
        resolve();
      }
    });
  });
}

/* ============================ 部署 ============================ */

/** 删掉目标目录里**没被 index.js 引用**的旧 chunk（index.js 与 chunk 错配 = 更新后白屏） */
function pruneStale(out) {
  const entry = path.join(out, 'index.js');
  if (!fs.existsSync(entry)) return 0;
  const referenced = new Set(fs.readFileSync(entry, 'utf8').match(/index\.[0-9a-f]{16,}\.chunk\.js/g) ?? []);
  let removed = 0;
  for (const file of fs.readdirSync(out)) {
    if (!/\.chunk\.js(\.map)?$/.test(file)) continue;
    const base = file.replace(/\.map$/, '');
    if (referenced.has(base)) continue;
    fs.rmSync(path.join(out, file), { force: true });
    removed++;
  }
  return removed;
}

/**
 * 原子性检查：index.js 引用的 chunk 必须**已经在 dist 里**。
 * 这是「更新后白屏」的最后一道闸 —— 宁可这次不部署，也不能拷出半套产物。
 */
function artifactsComplete() {
  const entry = path.join(DIST, 'index.js');
  if (!fs.existsSync(entry)) return { ok: false, why: 'dist/extension/index.js 不存在' };
  const referenced = fs.readFileSync(entry, 'utf8').match(/index\.[0-9a-f]{16,}\.chunk\.js/g) ?? [];
  for (const name of referenced) {
    if (!fs.existsSync(path.join(DIST, name))) return { ok: false, why: 'chunk 还没写出：' + name };
  }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) return { ok: false, why: 'manifest.json 还没写出' };
  return { ok: true, why: '' };
}

let busy = false;
let pending = false;

async function deploy() {
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  try {
    do {
      pending = false;
      await deployOnce();
    } while (pending);
  } finally {
    busy = false;
  }
}

async function deployOnce() {
  if (buildError) {
    // 编译报错：产物是半成品，绝不部署（等下一次编译成功自动恢复）
    return;
  }
  const gate = artifactsComplete();
  if (!gate.ok) {
    // 产物还没写完 —— 不报错，watcher 会再来一次
    return;
  }
  fs.mkdirSync(TARGET, { recursive: true });

  // 1) 先清目标目录里的旧 chunk —— 必须在新文件拷进去**之前**
  const stale = pruneStale(TARGET);

  // 2) 拷贝当前这一套（manifest.json 由 webpack 抄进 dist，这里连它一起同步）
  const t = Date.now();
  const files = fs.readdirSync(DIST).filter(f => !f.endsWith('.map'));
  for (const f of files) fs.copyFileSync(path.join(DIST, f), path.join(TARGET, f));
  const copyMs = Date.now() - t;

  const lag = lastChangeAt ? '（改代码后 ' + ((Date.now() - lastChangeAt) / 1000).toFixed(1) + 's）' : '';
  lastChangeAt = 0;
  log('构建完成 → ' + files.length + ' files / ' + copyMs + 'ms' + (stale ? ' (清 ' + stale + ' 旧 chunk)' : '') + ' ' + lag);
  if (!NO_RELOAD) await reloadTavern();
}

/* ============================ 重载酒馆 ============================ */

/** 通过 CDP 刷新酒馆页面，并等 #cx-root-mount 出现（部署完成 = 界面已就绪） */
async function reloadTavern() {
  let targets;
  try {
    targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json();
  } catch {
    log('（CDP 未开，跳过重载）');
    return;
  }
  const page = targets.find(t => t.type === 'page' && t.url.includes('8000')) ?? targets.find(t => t.type === 'page');
  if (!page) {
    log('（没有可刷新的页面，跳过重载）');
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pendingCalls = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendingCalls.has(msg.id)) {
      pendingCalls.get(msg.id)(msg);
      pendingCalls.delete(msg.id);
    }
  });
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
    });
  } catch (e) {
    log('（' + e.message + '，跳过重载）');
    return;
  }
  const send = (method, params = {}) =>
    new Promise(res => {
      const id = ++seq;
      pendingCalls.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const reloadStart = Date.now();
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });

  // 轮询等挂载完成 —— 以前是「手动 sleep 16-18s」，现在按实际就绪时间返回
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    const r = await send('Runtime.evaluate', {
      expression: "!!document.getElementById('cx-root-mount')",
      returnByValue: true,
    });
    if (r.result?.result?.value === true) {
      ready = true;
      break;
    }
  }
  ws.close();
  const ms = ((Date.now() - reloadStart) / 1000).toFixed(1);
  log(ready ? '酒馆已重载并就绪 ' + ms + 's' : '酒馆已重载，但 60s 内没等到挂载点（多半是页面报错）');
}

/* ============================ 入口 ============================ */

log('目标：' + TARGET);

if (WATCH) {
  // 盯产物目录：index.js 一被重写就部署。这是唯一不会误判「扩展编译完了」的信号。
  let timer = null;
  let lastSeen = 0;
  fs.watch(DIST, { recursive: false }, () => {
    if (timer) clearTimeout(timer);
    // 防抖：webpack 写 index.js / chunk / manifest 是连续的几个事件
    timer = setTimeout(() => {
      const entry = path.join(DIST, 'index.js');
      const mtime = fs.existsSync(entry) ? fs.statSync(entry).mtimeMs : 0;
      if (mtime === lastSeen) return;
      lastSeen = mtime;
      deploy().catch(e => console.error('[deploy] 部署失败:', e.message));
    }, 400);
  });
  log('watch 中：改 src 下任何文件 → 自动构建 → 部署 → 重载');
}

await runWebpack().catch(e => {
  console.error('[deploy] ' + e.message);
  process.exit(1);
});
if (WATCH) {
  // 首次构建可能早于 watcher 生效，补一次
  setTimeout(() => deploy().catch(e => console.error('[deploy] 部署失败:', e.message)), 800);
}
