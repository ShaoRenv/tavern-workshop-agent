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
//   成功 = 一行；失败 = 全文。webpack 那几百行日志成功时一个字都不打。
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

const t0 = Date.now();
const log = (...a) => console.info('[deploy]', ...a);

/* ============================ 构建 ============================ */

function runWebpack() {
  return new Promise((resolve, reject) => {
    const args = [path.join(ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js'), '--mode', 'development'];
    if (WATCH) args.push('--watch');
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    // 成功时整段吞掉，只留最后一行统计；失败时原样吐出来
    let out = '';
    let err = '';
    let failed = false;

    const onChunk = (buf, isErr) => {
      const text = buf.toString();
      if (isErr) err += text;
      else out += text;
      // webpack --watch 每次编译完成都会打 'compiled ... in Nms'
      const m = text.match(/compiled .* in \d+\s*ms/);
      if (!m) return;
      const line = (text.match(/.*compiled .* in \d+\s*ms.*/) ?? [''])[0].trim();
      const bad = /(\d+) error/.exec(line);
      if (bad && bad[1] !== '0') {
        failed = true;
        console.error('[deploy] 构建失败：');
        console.error((err || out).slice(-6000));
        if (!WATCH) reject(new Error('构建失败'));
        return;
      }
      deploy()
        .then(() => {
          if (!WATCH) resolve();
        })
        .catch(e => {
          console.error('[deploy] 部署失败:', e.message);
          if (!WATCH) reject(e);
        });
    };

    child.stdout.on('data', b => onChunk(b, false));
    child.stderr.on('data', b => onChunk(b, true));
    child.on('exit', code => {
      if (!WATCH) {
        if (code !== 0 && !failed) reject(new Error('webpack 退出码 ' + code + '\n' + (err || out).slice(-4000)));
        else resolve();
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

async function deploy() {
  if (!fs.existsSync(DIST)) {
    console.error('[deploy] 没有构建产物：' + DIST);
    return;
  }
  fs.mkdirSync(TARGET, { recursive: true });

  // 1) 先清目标目录里的旧 chunk —— 必须在新文件拷进去**之前**，否则可能误删刚拷的
  const stale = pruneStale(TARGET);

  // 2) 拷贝当前这一套（manifest.json 由 webpack 抄进 dist，这里连它一起同步）
  const files = fs.readdirSync(DIST).filter(f => !f.endsWith('.map'));
  for (const f of files) fs.copyFileSync(path.join(DIST, f), path.join(TARGET, f));

  log(((Date.now() - t0) / 1000).toFixed(1) + 's → ' + files.length + ' files' + (stale ? ' (清 ' + stale + ' 旧 chunk)' : ''));
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
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
  });
  const send = (method, params = {}) =>
    new Promise(res => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });

  // 轮询等挂载完成 —— 以前是「手动 sleep 16-18s」，现在按实际就绪时间返回
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', { expression: "!!document.getElementById('cx-root-mount')", returnByValue: true });
    if (r.result?.result?.value === true) {
      ready = true;
      break;
    }
  }
  ws.close();
  log(ready ? '酒馆已重载并就绪（总 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）' : '酒馆已重载，但 60s 内没等到挂载点（多半是页面报错）');
}

/* ============================ 入口 ============================ */

log('目标：' + TARGET);
log(WATCH ? '开始构建（watch 模式，改代码自动生效）…' : '开始构建…');
await runWebpack().catch(e => {
  console.error('[deploy] ' + e.message);
  process.exit(1);
});
