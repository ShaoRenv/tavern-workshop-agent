/**
 * B52/B53/B57：skill 存储（ST 真文件 + 索引 + 路径编码）。
 *
 * 用**假 fetch** 驱动，不需要真酒馆 —— 这一层只认「宿主 fetch + 索引」。
 * 真机端到端另有一轮探针（写文件 → 读回 → 逐字节比对）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const store = await import(root + 'core/skill_store.ts');
const {
  SKILL_FILE_PREFIX,
  SKILL_INDEX_PATH,
  encodeSkillFile,
  skillFilePath,
  hashText,
  factoryHashOf,
  parseFrontmatter,
  frontBool,
  indexEntryFromFactory,
  parseIndex,
  emptyIndex,
  releaseSkill,
  releaseAllFactory,
  readSkillBody,
  readSkillFileContent,
  saveSkillFile,
  addUserSkillEntry,
  removeSkill,
  isSkillModified,
} = store;

/* ============================ 假酒馆文件系统 ============================ */

/**
 * 一个最小的「ST /api/files」替身：
 *   · 只实现我们真的会调的 4 个端点
 *   · **校验文件名**（照抄 ST 的白名单），中文 / 子目录当场 400 ——
 *     这是本文件最重要的一条：编码错了必须在这里就炸，而不是到真机上才 400。
 */
function fakeTavern() {
  const files = new Map();
  const calls = [];
  const badName = { status: 400, ok: false, text: async () => "Illegal character in filename" };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push(method + " " + url);
    if (method === "GET" && url === "/csrf-token") {
      const body = JSON.stringify({ token: "fake-token" });
      return { status: 200, ok: true, json: async () => ({ token: "fake-token" }), text: async () => body };
    }
    if (method === "POST" && url === "/api/files/upload") {
      const body = JSON.parse(init.body);
      const name = body.name;
      if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) return badName;
      if (name.startsWith(".")) return { status: 400, ok: false, text: async () => "Filename cannot start with ." };
      if (/\.(js|py|html|sh|ps1|sql)$/i.test(name)) return { status: 400, ok: false, text: async () => "Forbidden file extension." };
      files.set(name, Buffer.from(body.data, "base64").toString("utf8"));
      return { status: 200, ok: true, text: async () => JSON.stringify({ path: "/user/files/" + name }) };
    }
    if (method === "POST" && url === "/api/files/delete") {
      files.delete(String(JSON.parse(init.body).path).replace("/user/files/", ""));
      return { status: 200, ok: true, text: async () => "{}" };
    }
    if (method === "POST" && url === "/api/files/verify") {
      const out = {};
      for (const path of JSON.parse(init.body).urls) out[path] = files.has(String(path).replace("/user/files/", ""));
      return { status: 200, ok: true, text: async () => JSON.stringify(out) };
    }
    if (method === "GET" && url.startsWith("/user/files/")) {
      const name = url.replace("/user/files/", "");
      if (!files.has(name)) return { status: 404, ok: false, text: async () => "Not found" };
      return { status: 200, ok: true, text: async () => files.get(name) };
    }
    return { status: 404, ok: false, text: async () => "Not found" };
  };
  const deps = { getFetch: () => fetchImpl, getCsrf: async () => "fake-token" };
  return { files, calls, deps, names: () => [...files.keys()] };
}

/** 一个假的世界书 skill（形状 = 插件贡献的） */
const FACTORY = {
  id: "worldbook",
  name: "世界书工程",
  summary: "改酒馆世界书：改前看结构、改后回读",
  fromPlugin: "worldbook",
  files: [
    { path: "SKILL.md", content: "---\nname: worldbook-engineering\ndescription: 改酒馆世界书\n---\n\n# 世界书工程\n\n正文。" },
    { path: "references/字段速查表.md", content: "| 字段 | 含义 |\n|---|---|\n| key | 主关键词 |" },
    { path: "references/悬案与不确定项.md", content: "这些还没验证。" },
  ],
};

/* ============================ B53 路径编码 ============================ */

test("B53: 文件名编码只产出 ST 允许的字符（中文 / 斜杠都不许出现在文件名里）", () => {
  const names = [
    encodeSkillFile("worldbook", "SKILL.md"),
    encodeSkillFile("worldbook", "references/字段速查表.md"),
    encodeSkillFile("worldbook", "references/激活机制详解.md"),
    encodeSkillFile("worldbook", "references/悬案与不确定项.md"),
    encodeSkillFile("某个中文id", "references/子目录/带中文的文件.md"),
  ];
  for (const name of names) {
    assert.match(name, /^[a-zA-Z0-9_\-.]+$/, name + " 里有 ST 不接受的字符");
    assert.ok(name.startsWith(SKILL_FILE_PREFIX), name + " 该带 cxskill_ 前缀");
    assert.ok(!name.startsWith("."), name + " 不能以点开头");
    assert.ok(name.endsWith(".md"), name + " 该以 .md 结尾");
  }
  assert.ok(!encodeSkillFile("worldbook", "references/字段速查表.md").includes("/"), "文件名里不能有 /");
});

test("B53: 同一路径编码稳定；不同路径编码不撞", () => {
  const a = encodeSkillFile("worldbook", "references/字段速查表.md");
  const b = encodeSkillFile("worldbook", "references/字段速查表.md");
  assert.equal(a, b, "同一输入必须给同一文件名（否则用户改完就找不到了）");
  const set = new Set([
    encodeSkillFile("worldbook", "SKILL.md"),
    encodeSkillFile("worldbook", "references/字段速查表.md"),
    encodeSkillFile("worldbook", "references/激活机制详解.md"),
  ]);
  assert.equal(set.size, 3, "三个不同路径编码成了同一个文件名 —— 会互相覆盖");
});

test("B53: 未知中文段也有安全兜底（不靠映射表也能过 ST 校验）", () => {
  const name = encodeSkillFile("user", "references/我随便写的名字.md");
  assert.match(name, /^[a-zA-Z0-9_\-.]+$/);
  assert.ok(name.endsWith(".md"));
  assert.equal(name, encodeSkillFile("user", "references/我随便写的名字.md"), "用了 hash，两次必须一致");
});

test("B53: skillFilePath 拼出完整路径", () => {
  assert.equal(skillFilePath("worldbook", "SKILL.md"), "/user/files/" + encodeSkillFile("worldbook", "SKILL.md"));
});

/* ============================ B46 frontmatter ============================ */

test("B46: frontmatter 解析 name + description（Agent Skills 标准的必填两项）", () => {
  const text = "---\nname: worldbook-engineering\ndescription: 改酒馆世界书\n---\n\n# 标题\n\n正文。";
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.fields.name, "worldbook-engineering");
  assert.equal(parsed.fields.description, "改酒馆世界书");
  assert.ok(parsed.body.includes("# 标题"), "正文要保留");
  assert.ok(!parsed.body.includes("name:"), "正文里不该再有 frontmatter");
});

test("B46: 缺 frontmatter / 缺 name / 缺 description 都判不通过（不抛，给人话）", () => {
  const noFront = parseFrontmatter("# 直接就是正文");
  assert.equal(noFront.ok, false);
  assert.ok(noFront.error.includes("frontmatter"), noFront.error);

  const unclosed = parseFrontmatter("---\nname: x\n\n正文");
  assert.equal(unclosed.ok, false);
  assert.ok(unclosed.error.includes("闭合"), unclosed.error);

  const noName = parseFrontmatter("---\ndescription: 有描述没名字\n---\n正文");
  assert.equal(noName.ok, false);
  assert.ok(noName.error.includes("name"), noName.error);

  const noDesc = parseFrontmatter("---\nname: x\n---\n正文");
  assert.equal(noDesc.ok, false);
  assert.ok(noDesc.error.includes("description"), noDesc.error);
});

test("B46: 引号会被剥掉；BOM / 前置空行不影响识别", () => {
  const quoted = parseFrontmatter("---\nname: \"x-y\"\ndescription: '带空格 的 描述'\n---\n正文");
  assert.equal(quoted.ok, true, quoted.error);
  assert.equal(quoted.fields.name, "x-y");
  assert.equal(quoted.fields.description, "带空格 的 描述");

  const bom = parseFrontmatter("\uFEFF---\nname: x\ndescription: y\n---\n正文");
  assert.equal(bom.ok, true, bom.error);
});

test("B49: 权限位从 frontmatter 读（disable-model-invocation / user-invocable）", () => {
  assert.equal(frontBool({}, "disable-model-invocation", false), false, "没写 = 默认允许");
  assert.equal(frontBool({ "disable-model-invocation": "true" }, "disable-model-invocation", false), true);
  assert.equal(frontBool({ "disable-model-invocation": "false" }, "disable-model-invocation", false), false);
  assert.equal(frontBool({ "user-invocable": "no" }, "user-invocable", true), false);
  assert.equal(frontBool({ "user-invocable": "乱写的" }, "user-invocable", true), true, "认不出来就回落默认");

  const entry = indexEntryFromFactory(FACTORY);
  assert.equal(entry.disableModelInvocation, false, "世界书工程没标禁调");
  assert.equal(entry.userInvocable, true);
});

/* ============================ B52 索引 ============================ */

test("B52: parseIndex 收得住坏数据（缺字段 / 不是数组 / 空项）", () => {
  assert.deepEqual(parseIndex(null).skills, []);
  assert.deepEqual(parseIndex({}).skills, []);
  assert.deepEqual(parseIndex({ skills: "nope" }).skills, []);
  assert.deepEqual(parseIndex({ skills: [null, {}, { id: "" }] }).skills, [], "没 id 的条目丢掉");

  const one = parseIndex({ skills: [{ id: "a", name: "A" }] });
  assert.equal(one.skills.length, 1);
  assert.equal(one.skills[0].id, "a");
  assert.equal(one.skills[0].enabled, true, "缺 enabled 默认开");
  assert.deepEqual(one.skills[0].files, []);
});

test("B52: indexEntryFromFactory 从出厂内容算出索引项（含每个文件的 hash）", () => {
  const entry = indexEntryFromFactory(FACTORY);
  assert.equal(entry.id, "worldbook");
  assert.equal(entry.name, "世界书工程");
  assert.equal(entry.fromPlugin, "worldbook");
  assert.equal(entry.files.length, 3, "SKILL.md + 2 个 references");
  assert.equal(entry.files[0].path, "SKILL.md");
  assert.ok(entry.files[0].file.startsWith(SKILL_FILE_PREFIX));
  assert.equal(entry.files[0].hash, hashText(FACTORY.files[0].content));
  assert.equal(entry.factoryHash, factoryHashOf(FACTORY));
});

/* ============================ B54 释放 / 恢复默认 ============================ */

test("B54: 首次释放 → 每个文件都写进 /user/files/，文件名过 ST 校验", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  const result = await releaseSkill(box.deps, FACTORY, index);

  assert.equal(result.errors.length, 0, result.errors.join(";"));
  assert.equal(result.written, 3, "三个文件都该写");
  assert.equal(index.skills.length, 1, "索引里该有这一项");
  assert.equal(box.names().length, 3, "假酒馆里该有三个文件");
  for (const file of FACTORY.files) {
    const name = encodeSkillFile(FACTORY.id, file.path);
    assert.equal(box.files.get(name), file.content, file.path + " 写进去的内容变了");
  }
});

test("B54: 再释放一次（没改过）→ 跳过不写，省一次写盘", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);
  const before = box.calls.length;

  const again = await releaseSkill(box.deps, FACTORY, index);
  assert.equal(again.written, 0, "内容没变不该重写");
  assert.equal(again.skipped, 3, "三个都该跳过");
  assert.ok(box.calls.length > before, "仍然要读一次确认文件还在（可能被外面删了）");
});

test("B54: 用户改过 → 再释放不覆盖用户的改动（只有 force 才覆盖）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  await saveSkillFile(box.deps, index, "worldbook", "SKILL.md", "用户改过的正文");
  assert.equal(box.files.get(encodeSkillFile("worldbook", "SKILL.md")), "用户改过的正文");

  const again = await releaseSkill(box.deps, FACTORY, index);
  assert.equal(box.files.get(encodeSkillFile("worldbook", "SKILL.md")), "用户改过的正文", "普通释放不许冲掉用户的编辑");
  assert.equal(again.written, 0, "用户改过的那份不算「要重写」");

  const forced = await releaseSkill(box.deps, FACTORY, index, { force: true });
  assert.equal(forced.written, 3, "force 要全写");
  assert.equal(box.files.get(encodeSkillFile("worldbook", "SKILL.md")), FACTORY.files[0].content, "恢复默认该把出厂内容放回去");
});

test("B54: 恢复默认不动用户关掉的开关（enabled 保留）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);
  index.skills[0].enabled = false;

  await releaseSkill(box.deps, FACTORY, index, { force: true });
  assert.equal(index.skills[0].enabled, false, "恢复默认不该把技能重新打开");
});

test("B54: 文件被外面删了 → 下次释放会补回来（不能只信索引的 hash）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  box.files.delete(encodeSkillFile("worldbook", "SKILL.md"));
  const again = await releaseSkill(box.deps, FACTORY, index);
  assert.equal(again.written, 1, "缺的那个要补回来");
  assert.ok(box.files.has(encodeSkillFile("worldbook", "SKILL.md")));
});

test("B54: releaseAllFactory 批量释放", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  const second = {
    id: "other",
    name: "另一个技能",
    summary: "x",
    fromPlugin: "other",
    files: [{ path: "SKILL.md", content: "---\nname: other\ndescription: y\n---\n正文" }],
  };
  const result = await releaseAllFactory(box.deps, [FACTORY, second], index);
  assert.equal(result.written, 4, "3 + 1");
  assert.equal(index.skills.length, 2);
});

/* ============================ 读 / 写 / 删 ============================ */

test("读: 第 2 层优先；文件不在时回退出厂层（bundle 里的那份）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();

  const fromFactory = await readSkillBody(box.deps, index, [FACTORY], "worldbook");
  assert.equal(fromFactory, FACTORY.files[0].content, "没释放时回退出厂层");

  await releaseSkill(box.deps, FACTORY, index);
  await saveSkillFile(box.deps, index, "worldbook", "SKILL.md", "用户版");
  const fromUser = await readSkillBody(box.deps, index, [FACTORY], "worldbook");
  assert.equal(fromUser, "用户版", "释放过就读用户那份");

  box.files.delete(encodeSkillFile("worldbook", "SKILL.md"));
  const fallback = await readSkillBody(box.deps, index, [FACTORY], "worldbook");
  assert.equal(fallback, FACTORY.files[0].content, "用户那份没了要回退出厂层");
});

test("读: 参考文件按树状 path 找；找不到返回 null（调用方据此报可读清单）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  const hit = await readSkillFileContent(box.deps, index, [FACTORY], "worldbook", "references/字段速查表.md");
  assert.equal(hit, FACTORY.files[1].content);

  const miss = await readSkillFileContent(box.deps, index, [FACTORY], "worldbook", "references/不存在.md");
  assert.equal(miss, null);
});

test("写: saveSkillFile 同时更新索引里的 hash（「用户改过没有」的唯一判据）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  await saveSkillFile(box.deps, index, "worldbook", "SKILL.md", "改过的新内容");
  const record = index.skills[0].files.find(file => file.path === "SKILL.md");
  assert.equal(record.hash, hashText("改过的新内容"), "hash 要跟着更新");
  assert.equal(record.hash === hashText(FACTORY.files[0].content), false, "和出厂版不同了");
});

test("写: saveSkillFile 对新文件也管用（用户给技能加一个参考文件）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  await saveSkillFile(box.deps, index, "worldbook", "references/我自己加的.md", "新内容");
  assert.equal(index.skills[0].files.length, 4, "索引里该多一条");
  assert.equal(box.files.get(encodeSkillFile("worldbook", "references/我自己加的.md")), "新内容");
});

test("写: 索引里没这个技能 → saveSkillFile 报错（不静默丢）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await assert.rejects(() => saveSkillFile(box.deps, index, "不存在", "SKILL.md", "x"), /索引里没有这个技能/);
});

test("删: 插件带的技能删不掉；用户自建的删得掉（连带删文件）", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);

  const builtin = await removeSkill(box.deps, index, "worldbook");
  assert.equal(builtin.ok, false, "插件带的删不掉");
  assert.ok(builtin.error.includes("恢复默认"), "要告诉用户正确的做法");

  const entry = addUserSkillEntry(index, { id: "mine", name: "我的技能", summary: "x" });
  assert.equal(entry.fromPlugin, "", "用户自建的 fromPlugin 为空");
  await saveSkillFile(box.deps, index, "mine", "SKILL.md", "我的正文");
  assert.ok(box.files.has(encodeSkillFile("mine", "SKILL.md")));

  const mine = await removeSkill(box.deps, index, "mine");
  assert.equal(mine.ok, true);
  assert.equal(index.skills.some(item => item.id === "mine"), false, "索引里要移除");
  assert.equal(box.files.has(encodeSkillFile("mine", "SKILL.md")), false, "文件也要删掉");
});

test("isSkillModified: 出厂指纹变了 = 用户该看到「已改过」", async () => {
  const box = fakeTavern();
  const index = emptyIndex();
  await releaseSkill(box.deps, FACTORY, index);
  assert.equal(isSkillModified(index.skills[0], FACTORY), false, "刚释放 = 没改过");

  const upgraded = { ...FACTORY, files: FACTORY.files.map(file => file.path === "SKILL.md" ? { ...file, content: file.content + "\n新增一段" } : file) };
  assert.equal(isSkillModified(index.skills[0], upgraded), true, "出厂升级后要能看出差异");
});

test("工厂: factoryHashOf 对内容敏感、对文件顺序不敏感", () => {
  const a = factoryHashOf(FACTORY);
  const shuffled = { ...FACTORY, files: [FACTORY.files[2], FACTORY.files[0], FACTORY.files[1]] };
  assert.equal(factoryHashOf(shuffled), a, "文件顺序不该影响指纹（按 path 排序）");

  const changed = { ...FACTORY, files: FACTORY.files.map((file, i) => i === 0 ? { ...file, content: file.content + "x" } : file) };
  assert.notEqual(factoryHashOf(changed), a, "改一个字指纹就要变");
});

test("索引文件：走 /user/files/cx_skills_index.json，名字过 ST 校验", () => {
  assert.equal(SKILL_INDEX_PATH, "/user/files/cx_skills_index.json");
  assert.match("cx_skills_index.json", /^[a-zA-Z0-9_\-.]+$/);
});
