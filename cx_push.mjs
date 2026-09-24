// 酒馆工坊Agent · 一条命令推送
//
// 以前推送要 7 步：fetch → merge → 冲突了手动 checkout --ours → 重新生成产物 JSON → add → commit → push。
// 现在：node cx_push.mjs "提交信息"
//
// 顺序很重要（踩过坑）：**先提交本地 → 再 merge → 再重生成产物 → 再 push**。
// 反过来的话，工作区一脏 git 就拒绝 merge，而失败信息是空的，看起来像「莫名其妙的冲突」。
//
// 红线：**永远不 force push**。分叉了就报错让人来看。
// 输出：成功 = 一行；失败 = 尾部一小段。
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
    return { ok: false, out: ((e.stdout ?? '') + (e.stderr ?? '')).trim() };
  }
};
const log = (...a) => console.info('[push]', ...a);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();

/* ---------- 1. 先提交本地（必须在 merge 之前：工作区脏时 git 会拒绝 merge） ---------- */
const status = git('status', '--porcelain').trim();
if (!status) {
  log('工作区干净，跳过提交。');
} else {
  git('add', '-A');
  git('commit', '-m', msg);
  log('已提交本地改动。');
}

/* ---------- 2. 拉远端并对齐 ---------- */
git('fetch', 'origin');
const behind = gitTry('rev-list', '--count', 'HEAD..origin/' + branch);
const behindCount = behind.ok ? Number(behind.out.trim()) : 0;

if (behindCount > 0) {
  log('落后 origin/' + branch + ' ' + behindCount + ' 个提交，先 merge…');
  const merged = gitTry('merge', '--no-edit', 'origin/' + branch);
  if (!merged.ok) {
    // 生成的产物 JSON 冲突：取 ours 然后重生成，不让人工合并构建产物
    const conflicted = gitTry('diff', '--name-only', '--diff-filter=U');
    const files = conflicted.out.split('\n').map(s => s.trim()).filter(Boolean);
    const onlyGenerated = files.length > 0 && files.every(f => GENERATED.includes(f));
    if (!onlyGenerated) {
      console.error('[push] 需要人工处理（不是产物冲突）：');
      console.error(files.length ? files.join('\n') : merged.out.slice(-1500));
      console.error('\n处理完再跑一次这个脚本。');
      process.exit(1);
    }
    log('产物 JSON 冲突（' + files.join(', ') + '）→ 取 ours 并重新生成');
    for (const f of files) gitTry('checkout', '--ours', '--', f);
    git('add', '--', ...files);
    gitTry('commit', '--no-edit');
  }
}

/* ---------- 3. 重新生成产物（保证推上去的就是当前源码产出的） ---------- */
const buildScript = path.join(ROOT, 'build_tavern_script.mjs');
if (fs.existsSync(buildScript)) {
  try {
    execFileSync(process.execPath, [buildScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('[push] 产物生成失败：');
    console.error(((e.stdout ?? '') + (e.stderr ?? '')).toString().slice(-3000));
    process.exit(1);
  }
  // 生成结果和仓库里那份不一致 → 补一次提交
  const afterBuild = git('status', '--porcelain').trim();
  if (afterBuild) {
    git('add', '-A');
    git('commit', '-m', msg + '（重新生成产物）');
    log('产物有变化，已补提交。');
  }
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
