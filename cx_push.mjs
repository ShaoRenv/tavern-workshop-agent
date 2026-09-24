// 酒馆工坊Agent · 一条命令推送
//
// 以前推送要 7 步：fetch → merge → 冲突了手动 checkout --ours → 重新生成产物 JSON → add → commit → push。
// 现在：node cx_push.mjs "提交信息"
//
// 它做的事：
//   1. git fetch origin
//   2. 有落后就先 merge；**生成的产物 JSON 冲突自动重生成**（构建产物不该手动合并）
//   3. 重新跑一次构建产物生成，保证推上去的就是当前源码产出的
//   4. add / commit / push
//
// 红线：**永远不 force push**。分叉了就报错让人来看。
// 输出：成功 = 一行；失败 = 全文。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
/** 生成产物：冲突时自动重建，不参与人工合并 */
const GENERATED = ['src/酒馆助手脚本-苍玄助手.json'];

const msg = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ').trim();
if (!msg) {
  console.error('用法：node cx_push.mjs "提交信息"');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitTry = (...args) => {
  try {
    return { ok: true, out: git(...args) };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};
const log = (...a) => console.info('[push]', ...a);

/* ---------- 1. 拉远端 ---------- */
log('fetch…');
git('fetch', 'origin');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
const behind = gitTry('rev-list', '--count', 'HEAD..origin/' + branch);
const behindCount = behind.ok ? Number(behind.out.trim()) : 0;

if (behindCount > 0) {
  log('落后 origin/' + branch + ' ' + behindCount + ' 个提交，先 merge…');
  const merged = gitTry('merge', '--no-edit', 'origin/' + branch);
  if (!merged.ok) {
    // 生成的产物 JSON 冲突：直接取 ours 然后重生成，不让人工合并构建产物
    const conflicted = gitTry('diff', '--name-only', '--diff-filter=U');
    const files = conflicted.out.split('\n').map(s => s.trim()).filter(Boolean);
    const onlyGenerated = files.length > 0 && files.every(f => GENERATED.includes(f));
    if (!onlyGenerated) {
      console.error('[push] 有非产物文件冲突，需要人工处理：');
      console.error(files.join('\n'));
      console.error('\n处理完再跑一次这个脚本。');
      process.exit(1);
    }
    log('产物 JSON 冲突（' + files.join(', ') + '）→ 取 ours 并重新生成');
    for (const f of files) gitTry('checkout', '--ours', '--', f);
    git('add', '--', ...files);
    gitTry('commit', '--no-edit');
  }
}

/* ---------- 2. 重新生成产物 ---------- */
const buildScript = path.join(ROOT, 'build_tavern_script.mjs');
if (fs.existsSync(buildScript)) {
  try {
    execFileSync(process.execPath, [buildScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('[push] 产物生成失败：');
    console.error(((e.stdout ?? '') + (e.stderr ?? '')).toString().slice(-3000));
    process.exit(1);
  }
}

/* ---------- 3. 提交 ---------- */
const status = git('status', '--porcelain').trim();
if (!status) {
  log('工作区是干净的，没有要提交的东西。');
} else {
  git('add', '-A');
  git('commit', '-m', msg);
}

/* ---------- 4. 推送 ---------- */
const ahead = gitTry('rev-list', '--count', 'origin/' + branch + '..HEAD');
if (ahead.ok && Number(ahead.out.trim()) === 0) {
  log('没有新提交，无需推送。');
} else {
  const pushed = gitTry('push', 'origin', branch);
  if (!pushed.ok) {
    console.error('[push] 推送失败（**不要 force push**）：');
    console.error(pushed.out.slice(-2000));
    process.exit(1);
  }
}

const head = git('rev-parse', '--short', 'HEAD').trim();
log('已推送 ' + branch + ' @ ' + head + ' — ' + msg);
