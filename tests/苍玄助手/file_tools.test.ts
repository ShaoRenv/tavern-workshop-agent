/**
 * B21：`write_file` / `read_file` 工具 + `core/workspace_files.ts` 的落盘层。
 *
 * 这一层直接对着 **ST 的文件名校验**说话（`src/endpoints/assets.js:22`）：
 * 中文名 400、子目录 400、`.js/.py` 400。假替身里必须**照抄那套校验**，
 * 否则「中文文件名」这种错会一路飘到真机才炸（skill 存储那轮就是这么踩的）。
 *
 * 另一条是**越界**：`read_file` 只能读自己写的（前缀 `cx-file-`）。
 * 不加这道闸，模型能读 `/user/files/` 下任何文件 —— 包括 skill 索引和外部插件代码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  FILE_PREFIX,
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  encodeFileName,
  resolveFileName,
  isOwnFileName,
  writeWorkspaceFile,
  readWorkspaceFile,
} = await import(root + 'core/workspace_files.ts');
const { createFileTools } = await import(root + 'agent/tools_file.ts');

/**
 * 假酒馆文件系统。
 *
 * ⚠️ **照抄 ST 的三条校验**（见文件头）：中文 400 / 子目录 400 / 危险扩展名 400。
 * 这样「编码写错了」在单测里就炸，不用等到真机。
 */
function fakeTavern() {
  const files = new Map();
  const bad = { status: 400, ok: false, text: async () => 'Illegal character in filename' };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'POST' && url === '/csrf-token') {
      return { status: 200, ok: true, json: async () => ({ token: 't' }), text: async () => '{"token":"t"}' };
    }
    if (method === 'POST' && url === '/api/files/upload') {
      const body = JSON.parse(init.body);
      const name = body.name;
      // ⚠️ 白名单必须带 `.` —— ST 的原式是 /^[a-zA-Z0-9_\-.]+$/（assets.js:22）。
      // 我第一版漏了那个点，于是 role-preset.json 被判成非法名（测试自己抓到的）。
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return bad;
      if (name.includes('/') || name.includes(String.fromCharCode(92))) return bad;
      if (/\.(js|py|html|sh|ps1|sql)$/i.test(name)) return { status: 400, ok: false, text: async () => 'Forbidden file extension.' };
      const text = Buffer.from(body.data, 'base64').toString('utf8');
      // ⚠️ 真机行为：空内容 400（skill 那轮踩过）
      if (!text) return { status: 400, ok: false, text: async () => 'No upload data specified' };
      files.set(name, text);
      return { status: 200, ok: true, text: async () => JSON.stringify({ path: '/user/files/' + name }) };
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

/** 取一个工具 */
function toolOf(name, options = {}) {
  const found = createFileTools(options).find(def => def.name === name);
  assert.ok(found, name + ' 工具不存在');
  return found;
}
/* ============================ 文件名编码 ============================ */

test('B21: 编码后只含 ST 允许的字符（中文 / 空格 / 斜杠都不许留）', () => {
  for (const raw of ['角色预设.json', 'my file.json', 'a/b/c.json', '说明 文档.md']) {
    const { name } = resolveFileName(raw);
    assert.match(name, /^[a-zA-Z0-9_.-]+$/, raw + ' 编出来还有非法字符：' + name);
    assert.ok(name.startsWith(FILE_PREFIX), name + ' 该带前缀');
  }
});

test('B21: 纯 ASCII 名字原样保留（别为了编码把好名字也改掉）', () => {
  const { name } = resolveFileName('role-preset.json');
  assert.equal(name, FILE_PREFIX + 'role-preset.json');
});

test('B21: 子目录被拍平，且如实报告（hadDir）', () => {
  const { name, hadDir } = resolveFileName('sub/dir/file.json');
  assert.equal(hadDir, true, '要如实说拍平过');
  assert.equal(name.includes('/'), false, '落盘名里不能有斜杠');
  assert.ok(name.endsWith('file.json'), '保留最后一段：' + name);
});

test('B21: 扩展名不在白名单 → 换成 .txt，且如实报告（changedExt）', () => {
  for (const raw of ['evil.js', 'x.py', 'y.html']) {
    const { name, changedExt } = resolveFileName(raw);
    assert.ok(name.endsWith('.txt'), raw + ' 该变 .txt，实际 ' + name);
    assert.equal(changedExt, true, raw + ' 该报 changedExt');
  }
  const noext = resolveFileName('noext');
  assert.ok(noext.name.endsWith('.txt'));
  assert.equal(noext.changedExt, false, '本来就没扩展名，不算换过');
  for (const ext of ALLOWED_EXTENSIONS) {
    assert.ok(resolveFileName('a' + ext).name.endsWith(ext), ext + ' 该原样保留');
  }
});

test('B21: 空名 / 全是非法字符 → 给兜底名（不会产出空文件名）', () => {
  for (const raw of ['', '   ', '///']) {
    const { name } = resolveFileName(raw);
    assert.ok(name.length > FILE_PREFIX.length, JSON.stringify(raw) + ' 编出来太短：' + name);
    assert.match(name, /^[a-zA-Z0-9_.-]+$/);
  }
});

test('B21: encodeFileName 对同一输入稳定（两次结果必须一样）', () => {
  const a = encodeFileName('角色预设');
  const b = encodeFileName('角色预设');
  assert.equal(a, b);
  assert.match(a, /^[a-zA-Z0-9_.-]+$/);
});

/* ============================ 越界 ============================ */

test('B21: isOwnFileName 只认自己的前缀（skill 索引 / 插件代码都不许读）', () => {
  assert.equal(isOwnFileName(FILE_PREFIX + 'a.json'), true);
  assert.equal(isOwnFileName('cx_skills_index.json'), false, 'skill 索引不许读');
  assert.equal(isOwnFileName('cxskill_worldbook__SKILL.md'), false, 'skill 文件不许读');
  assert.equal(isOwnFileName('cx-plugin-abc.txt'), false, '外部插件代码不许读');
  assert.equal(isOwnFileName('random.json'), false);
});

/**
 * 越界保护是**结构性**的：`resolveFileName` 永远把名字收进 `cx-file-` 命名空间，
 * 所以「传外来名字」根本读不到外来内容 —— 它读的是自己命名空间里的同名文件。
 *
 * ⚠️ 我一开始断言「应该报『只允许读』」—— 那条断言**永远触发不到**，因为
 * 原来的实现里那个 `isOwnFileName` 检查是死代码（名字必然是加了前缀的产物）。
 * 改成断言真正该成立的性质：**读到的是自己的文件，不是外来的那个**。
 */
test('B21: readWorkspaceFile 传外来名字 → 读不到外来内容（保护是结构性的）', async () => {
  const box = fakeTavern();
  // 外面真有一个 skill 索引
  box.files.set('cx_skills_index.json', '{"skills":["机密"]}');

  const result = await readWorkspaceFile(box.deps, 'cx_skills_index.json');
  // 它去找的是 cx-file-cx_skills_index.json —— 不在，于是 missing
  assert.equal(result.ok, false);
  assert.equal(result.missing, true, '找的是自己命名空间里的同名文件，所以是「不存在」');
  assert.equal(result.text, '', '绝不能把外面那份内容读出来');

  // 就算我们自己的命名空间里真有同名文件，读到的也是**我们那份**，不是外面那份
  box.files.set('cx-file-cx_skills_index.json', '我的内容');
  const mine = await readWorkspaceFile(box.deps, 'cx_skills_index.json');
  assert.equal(mine.text, '我的内容');
  assert.equal(mine.text.includes('机密'), false, '外面那份永远读不到');
});
/* ============================ 落盘 / 读回 ============================ */

test('B21: 写进去能读回来（中文内容逐字一致）', async () => {
  const box = fakeTavern();
  const payload = JSON.stringify({ 名: '潮听澜' });
  const written = await writeWorkspaceFile(box.deps, 'role.json', payload);
  assert.equal(written.ok, true, written.error);
  assert.equal(written.path, '/user/files/' + written.name);
  const back = await readWorkspaceFile(box.deps, written.name);
  assert.equal(back.ok, true);
  assert.equal(back.text, payload, '中文要逐字节一致');
});

test('B21: 中文文件名走编码后能写进去（真机上直接写中文会 400）', async () => {
  const box = fakeTavern();
  const result = await writeWorkspaceFile(box.deps, '角色预设.json', '{}');
  assert.equal(result.ok, true, result.error);
  assert.match(result.name, /^[a-zA-Z0-9_.-]+$/, '落盘名必须是安全字符：' + result.name);
});

test('B21: 同名覆盖（写两次，读回是后一次的）', async () => {
  const box = fakeTavern();
  await writeWorkspaceFile(box.deps, 'a.json', '第一版');
  await writeWorkspaceFile(box.deps, 'a.json', '第二版');
  assert.equal(box.files.size, 1, '同名该覆盖而不是新建');
  const back = await readWorkspaceFile(box.deps, 'a.json');
  assert.equal(back.text, '第二版');
});

test('B21: 超过单文件上限 → 拒绝并说清多大', async () => {
  const box = fakeTavern();
  const huge = 'x'.repeat(MAX_FILE_BYTES + 1);
  const result = await writeWorkspaceFile(box.deps, 'big.txt', huge);
  assert.equal(result.ok, false);
  assert.match(result.error, /内容太大|上限/, result.error);
});

test('B21: 读不存在的文件 → missing=true（与「读失败」分开）', async () => {
  const box = fakeTavern();
  const result = await readWorkspaceFile(box.deps, 'nope.json');
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
  assert.equal(result.error, undefined, '不存在不算错误，是正常情况');
});

test('B21: 拿不到 fetch → 明确报「没有网络能力」（不静默）', async () => {
  const deps = { getFetch: () => null, getCsrf: async () => null };
  const w = await writeWorkspaceFile(deps, 'a.json', 'x');
  assert.equal(w.ok, false);
  assert.match(w.error, /网络能力/);
  const r = await readWorkspaceFile(deps, FILE_PREFIX + 'a.json');
  assert.equal(r.ok, false);
  assert.match(r.error, /网络能力/);
});
/* ============================ 工具层 ============================ */

test('B21: write_file 工具 —— 缺 name / 缺 content 都要拦', async () => {
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  assert.equal((await write.run({ content: 'x' }, {})).ok, false, '缺 name 要拦');
  assert.equal((await write.run({ name: 'a.json' }, {})).ok, false, '缺 content 要拦');
  // 空字符串是**合法**的 content（要存空文件），但 ST 不收空内容 → 要如实报失败
  const empty = await write.run({ name: 'empty.json', content: '' }, {});
  assert.equal(empty.ok, false, 'ST 不收空内容 —— 要如实报失败，不能假装成功');
});

test('B21: write_file 成功 → brief 报文件名与字节数，detail 说清存哪了', async () => {
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  const got = await write.run({ name: 'role.json', content: '{"a":1}' }, {});
  assert.equal(got.ok, true, got.detail);
  assert.match(got.brief, /role/);
  assert.match(got.brief, /字节/);
  assert.ok(got.detail.includes('/user/files/'), '要告诉用户文件在哪：' + got.detail);
});

test('B21: write_file 换了扩展名 / 拍平目录时，detail 要如实说明', async () => {
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  const got = await write.run({ name: 'sub/evil.js', content: 'x' }, {});
  assert.equal(got.ok, true, got.detail);
  assert.match(got.detail, /扩展名/, '要说扩展名被换过');
  assert.match(got.detail, /子目录/, '要说目录被拍平');
});

test('B21: read_file 工具 —— 读自己写的能拿到内容', async () => {
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  const read = toolOf('read_file', { fileDeps: box.deps });
  await write.run({ name: 'a.json', content: '存进去的正文' }, {});
  const got = await read.run({ name: 'a.json' }, {});
  assert.equal(got.ok, true, got.detail);
  assert.match(got.detail, /存进去的正文/);
});

test('B21: read_file 读不存在 → 给人话（提示可能名字写错）', async () => {
  const box = fakeTavern();
  const read = toolOf('read_file', { fileDeps: box.deps });
  const got = await read.run({ name: 'nope.json' }, {});
  assert.equal(got.ok, false);
  assert.match(got.detail, /没这个文件|没有/, got.detail);
});

test('B21: read_file 读 skill 索引 → 读不到（进的是我们自己的命名空间）', async () => {
  const box = fakeTavern();
  box.files.set('cx_skills_index.json', '{"skills":["机密"]}');
  const read = toolOf('read_file', { fileDeps: box.deps });
  const got = await read.run({ name: 'cx_skills_index.json' }, {});
  assert.equal(got.ok, false, '外部文件读不到');
  assert.equal(got.detail.includes('机密'), false, '绝不能泄漏外面那份内容');
});

test('B21: 两个工具都默认关 + user_initiated_only（会产出东西，按需开）', () => {
  for (const def of createFileTools()) {
    assert.equal(def.default_on, false, def.name + ' 该默认关');
    assert.equal(def.user_initiated_only, true, def.name + ' 该标「仅用户明确要求时用」');
    assert.equal(def.group, 'file');
    assert.ok(def.model_description.length >= 8, def.name + ' 说明太短');
  }
});

/* ============================ B6：JSON 落盘闭环 ============================ */

test('B6: 「产出 JSON → 存文件 → 读回确认」这条闭环走得通', async () => {
  // 这就是 B6 要的东西：模型不再只能被动等 makeArtifact，它能自己把 JSON 落盘。
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  const read = toolOf('read_file', { fileDeps: box.deps });

  const payload = JSON.stringify({ characters: { 潮听澜: { nameCN: '潮听澜' } } }, null, 2);
  const saved = await write.run({ name: 'role-preset.json', content: payload }, {});
  assert.equal(saved.ok, true, saved.detail);

  const back = await read.run({ name: 'role-preset.json' }, {});
  assert.equal(back.ok, true, back.detail);
  // 读回来的必须是**能 parse 的同一份 JSON**（落盘没把中文/引号搞坏）
  const parsed = JSON.parse(box.files.get([...box.files.keys()][0]));
  assert.equal(parsed.characters.潮听澜.nameCN, '潮听澜');
});
/* ============================ 往返（真机流程）============================ */

/**
 * ⚠️ 这条抓过一个**真 bug**：`resolveFileName` 无脑拼前缀，于是
 * `write_file` 返回 `cx-file-role.json`，拿它去 `read_file` 会变成
 * `cx-file-cx-file-role.json` —— **永远读不到**。
 *
 * 而「存完读回来确认」正是这两个工具的标准用法（B3 那条纪律也是这个精神）。
 */
test('B21: 文件名往返稳定 —— write_file 返回的名字可以直接喂给 read_file', () => {
  for (const raw of ['role.json', 'a.md', '说明.txt', 'sub/x.json', 'evil.js']) {
    const first = resolveFileName(raw).name;
    const second = resolveFileName(first).name;
    assert.equal(second, first, raw + ' → ' + first + ' → ' + second + '（前缀被拼了两次）');
  }
});

test('B21: 工具级往返 —— 存进去、用返回的名字读回来，拿到同一份内容', async () => {
  const box = fakeTavern();
  const write = toolOf('write_file', { fileDeps: box.deps });
  const read = toolOf('read_file', { fileDeps: box.deps });

  const saved = await write.run({ name: '中文名.json', content: '内容在此' }, {});
  assert.equal(saved.ok, true, saved.detail);
  // 真实文件名 = 假酒馆里唯一那个 key（brief 里那串还带着「（N 字节）」后缀，不能直接切）
  const realName = [...box.files.keys()][0];
  const back = await read.run({ name: realName }, {});
  assert.equal(back.ok, true, '用 write_file 落盘的名字读不回来：' + back.detail);
  assert.match(back.detail, /内容在此/);
});
