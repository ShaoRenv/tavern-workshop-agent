/**
 * B40 共享纪律：**关掉**这条路（真机踩出来的两个 bug）。
 *
 * 背景：ST 的 `/api/files/upload` **拒收空内容**（实测 400 `No upload data specified`）。
 * 于是「用户想把纪律清空」没法用一个空文件表达，连带出两个真 bug：
 *
 *   ① 界面上「恢复出厂文本」按钮的实现是**清空草稿** ——
 *      而清空表达的是「关掉纪律」，跟按钮承诺的正好相反。
 *   ② 清空后点保存会走 `writeTextFile(空串)` → ST 400 → 静默失败，
 *      文件里还是上一次的内容。
 *
 * 修法：索引里加 `disciplineOff` 布尔位；空串 = 删文件 + 置位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  DEFAULT_SHARED_DISCIPLINE,
  SKILL_DISCIPLINE_PATH,
  emptyIndex,
  parseIndex,
  readSharedDiscipline,
  writeSharedDiscipline,
} = await import(root + 'core/skill_store.ts');

/** 假酒馆文件系统：**照抄 ST 对空内容的拒绝**（这正是 bug 的来源） */
function fakeTavern() {
  const files = new Map();
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'POST' && url === '/api/files/upload') {
      const body = JSON.parse(init.body);
      const text = Buffer.from(body.data, 'base64').toString('utf8');
      // ⚠️ 真机行为：空内容 400
      if (!text) return { status: 400, ok: false, text: async () => 'No upload data specified' };
      files.set(body.name, text);
      return { status: 200, ok: true, text: async () => JSON.stringify({ path: '/user/files/' + body.name }) };
    }
    if (method === 'POST' && url === '/api/files/delete') {
      files.delete(String(JSON.parse(init.body).path).replace('/user/files/', ''));
      return { status: 200, ok: true, text: async () => '{}' };
    }
    if (method === 'GET' && url.startsWith('/user/files/')) {
      const name = url.replace('/user/files/', '');
      if (!files.has(name)) return { status: 404, ok: false, text: async () => 'Not found' };
      return { status: 200, ok: true, text: async () => files.get(name) };
    }
    return { status: 404, ok: false, text: async () => 'Not found' };
  };
  return { files, deps: { getFetch: () => fetchImpl, getCsrf: async () => 't' } };
}

test('B40: 没动过 → 读出**出厂默认**（不是空）', async () => {
  const box = fakeTavern();
  const got = await readSharedDiscipline(box.deps, emptyIndex());
  assert.equal(got.text, DEFAULT_SHARED_DISCIPLINE);
  assert.equal(got.off, false);
  assert.equal(got.fromUser, false);
  assert.match(got.text, /沟通与引导/);
});

test('B40: 用户改过 → 读用户那份', async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await writeSharedDiscipline(box.deps, '## 我自己的纪律', index);

  const got = await readSharedDiscipline(box.deps, index);
  assert.equal(got.text, '## 我自己的纪律');
  assert.equal(got.fromUser, true);
  assert.equal(got.off, false);
});

test('B40: 清空 = **关掉**（删文件 + 置 disciplineOff），不是写空文件', async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await writeSharedDiscipline(box.deps, '## 先写一份', index);
  assert.equal(box.files.size, 1, '先得真有一份');

  // 清空
  await writeSharedDiscipline(box.deps, '', index);
  assert.equal(index.disciplineOff, true, '要置位');
  assert.equal(box.files.size, 0, '文件该被删掉（空内容 ST 不收，只能删）');

  const got = await readSharedDiscipline(box.deps, index);
  assert.equal(got.text, '', '关掉 = 不注入任何纪律');
  assert.equal(got.off, true);
  assert.notEqual(got.text, DEFAULT_SHARED_DISCIPLINE, '关掉之后**不该**回落到出厂默认');
});

test('B40: 关掉之后又写一份 → 重新打开，读出新的那份', async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await writeSharedDiscipline(box.deps, '', index);
  assert.equal(index.disciplineOff, true);

  await writeSharedDiscipline(box.deps, '## 重新打开', index);
  assert.equal(index.disciplineOff, false, '写非空要清掉关掉位');
  const got = await readSharedDiscipline(box.deps, index);
  assert.equal(got.text, '## 重新打开');
});

test('B40: 只给空白（空格 / 换行）也算关掉（别被空白骗过去）', async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  for (const blank of ['   ', '\n\n', ' \t ']) {
    const fresh = emptyIndex();
    await writeSharedDiscipline(box.deps, blank, fresh);
    assert.equal(fresh.disciplineOff, true, JSON.stringify(blank) + ' 该被当成关掉');
  }
});

test('B40: disciplineOff 要能存进索引文件再读回来（不然重启就忘了）', async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await writeSharedDiscipline(box.deps, '', index);

  const roundTrip = parseIndex(JSON.parse(JSON.stringify(index)));
  assert.equal(roundTrip.disciplineOff, true, '序列化一圈要保住这一位');

  const got = await readSharedDiscipline(box.deps, roundTrip);
  assert.equal(got.off, true);
  assert.equal(got.text, '');
});

test('B40: 索引里没有这一位（老数据）→ 按「没关」处理', async () => {
  const box = fakeTavern();
  const old = parseIndex({ version: 1, skills: [] });
  assert.equal(old.disciplineOff, false);
  const got = await readSharedDiscipline(box.deps, old);
  assert.equal(got.text, DEFAULT_SHARED_DISCIPLINE, '老数据要回落到出厂默认，不是空');
});

test('B40: 出厂默认文本不是空的，且带着来源声明', () => {
  assert.ok(DEFAULT_SHARED_DISCIPLINE.trim().length > 200, '出厂纪律不该是个空壳');
  assert.match(DEFAULT_SHARED_DISCIPLINE, /沟通与引导/);
  assert.match(DEFAULT_SHARED_DISCIPLINE, /大白话/, '要真的是那 6 条通用规则');
  assert.equal(SKILL_DISCIPLINE_PATH, '/user/files/cx_skills_discipline.md');
});
