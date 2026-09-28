/**
 * B47/B49/B50 + B40：技能工具的新行为。
 *
 *  - **B50 正文不截断**：老代码 `BODY_LIMIT = 20000` 会把世界书手册（27,642 字符）砍尾巴，
 *    砍掉的正好是后半段操作细节。正文是主入口，必须完整。
 *  - **B50 参考文件分页**：一次读完 12,000 会顶满上下文；改成默认 8,000 + offset 续读。
 *  - **B47 树状 path**：`references/字段速查表.md` 这种带斜杠的路径要能读；
 *    模型只给文件名（不带 references/ 前缀）时也要能命中。
 *  - **B49 权限位**：`disable-model-invocation` 的技能，模型自己调要**被拒**并给人话。
 *  - **B40 共享纪律**：拼在正文**之前**（不是系统提示词）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createSkillTools } = await import(root + 'agent/tools_skill.ts');

/** 直接拿工具来跑：不经过注册表，只验工具自己的行为 */
function toolOf(name, options = {}) {
  const found = createSkillTools(options).find(def => def.name === name);
  assert.ok(found, name + ' 工具不存在');
  return found;
}

/** 造一个假 ctx；skills 就是本轮挂上的技能 */
function ctxWith(skills) {
  return { worlds: [], wb: {}, drafts: {}, skills };
}

const LONG_BODY = '甲'.repeat(30000);

const PLAIN = {
  id: 's1',
  name: '普通技能',
  summary: '一句话描述',
  body: '正文内容',
  files: [{ name: 'references/字段速查表.md', content: '字段表正文' }],
};

/* ============================ B50 截断 ============================ */

test('B50: skill() 正文**不截断**（30,000 字符的正文要完整给出）', async () => {
  const skill = toolOf('skill');
  const long = { ...PLAIN, id: 'long', name: '长技能', body: LONG_BODY };
  const got = await skill.run({ name: '长技能' }, ctxWith([long]));
  assert.equal(got.ok, true);
  assert.equal(got.detail.includes(LONG_BODY), true, '正文被截断了 —— 老代码的 BODY_LIMIT=20000 就是这个 bug');
  // 长度提示也要报真实字数
  assert.match(got.brief, /30000/);
});

test('B50: read_skill_file 默认分页（超长文件只给第一页 + 明确的续读指引）', async () => {
  const read = toolOf('read_skill_file');
  const big = '乙'.repeat(20000);
  const skill = { ...PLAIN, id: 'big', name: '大文件技能', files: [{ name: 'references/大文件.md', content: big }] };

  const first = await read.run({ skill: '大文件技能', file: 'references/大文件.md' }, ctxWith([skill]));
  assert.equal(first.ok, true);
  assert.equal(first.detail.includes('乙'.repeat(9000)), false, '第一页不该把 20,000 全给出来');
  assert.match(first.detail, /还有 12000 字符没读完/, '要告诉模型还剩多少');
  assert.match(first.detail, /offset=8000/, '要给出续读的确切位置');

  // 带 offset 续读，拿到第二段
  const second = await read.run({ skill: '大文件技能', file: 'references/大文件.md', offset: '8000' }, ctxWith([skill]));
  assert.equal(second.ok, true);
  assert.match(second.detail, /8000–16000/, '页码要对上');

  // 最后一段：读完就不该再说「还有」
  const last = await read.run({ skill: '大文件技能', file: 'references/大文件.md', offset: '16000' }, ctxWith([skill]));
  assert.equal(last.ok, true);
  assert.equal(last.detail.includes('没读完'), false, '读到底了不该再提示续读');
});

test('B50: offset / limit 给垃圾值也不炸（回落默认，绝不传 NaN 下去）', async () => {
  const read = toolOf('read_skill_file');
  const skill = { ...PLAIN, id: 'x', name: 'X', files: [{ name: 'a.md', content: 'abcdef' }] };
  for (const offset of ['abc', '-5', '1e9', '', undefined]) {
    const got = await read.run({ skill: 'X', file: 'a.md', offset }, ctxWith([skill]));
    assert.equal(got.ok, true, 'offset=' + String(offset) + ' 不该让工具失败');
  }
  // limit 超大要被夹到上限（不能靠模型自律）
  const huge = await read.run({ skill: 'X', file: 'a.md', limit: '999999999' }, ctxWith([skill]));
  assert.equal(huge.ok, true);
  assert.equal(huge.detail.includes('abcdef'), true, '短文件照样读得到');
});

test('B50: 短文件一次给完，不显示页码（别为了分页把简单情况弄啰嗦）', async () => {
  const read = toolOf('read_skill_file');
  const got = await read.run({ skill: '普通技能', file: 'references/字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
  assert.match(got.detail, /字段表正文/);
  assert.equal(got.detail.includes('没读完'), false);
  // 「全文」这两个字在 detail 的表头里；brief 是给折叠态看的一行摘要
  assert.match(got.detail, /全文 5 字符/, '短文件要说是全文，别报页码');
  assert.match(got.brief, /5 字（全文）/);
});

/* ============================ B47 树状 path ============================ */

test('B47: 带树状路径的文件读得到；只给文件名也能命中（模型常偷懒）', async () => {
  const read = toolOf('read_skill_file');
  const full = await read.run({ skill: '普通技能', file: 'references/字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(full.ok, true);

  const bare = await read.run({ skill: '普通技能', file: '字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(bare.ok, true, '只给文件名也该命中（按后缀匹配）');
  assert.match(bare.detail, /字段表正文/);
});

test('B47: skill() 返回时列出参考文件，让模型知道有什么可读', async () => {
  const skill = toolOf('skill');
  const got = await skill.run({ name: '普通技能' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
  assert.match(got.detail, /references\/字段速查表\.md/, '要列出树状路径');
});

/* ============================ B49 权限位 ============================ */

test('B49: disable-model-invocation 的技能，模型自己调要被拒 + 给人话', async () => {
  const skill = toolOf('skill');
  const locked = { ...PLAIN, id: 'danger', name: '危险技能', disable_model_invocation: true };

  const got = await skill.run({ name: '危险技能' }, ctxWith([locked]));
  assert.equal(got.ok, false, '标了禁调就该拒');
  assert.match(got.brief, /只能由用户主动触发/);
  assert.match(got.detail, /disable-model-invocation/, '要说出原因，别让模型反复试');
  assert.match(got.detail, /请告诉用户/, '要给一条出路');
});

test('B49: 没标禁调的技能照常能读', async () => {
  const skill = toolOf('skill');
  const got = await skill.run({ name: '普通技能' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
});

test('B49: 不可调的技能在「找不到技能」的清单里要标注出来', async () => {
  const skill = toolOf('skill');
  const locked = { ...PLAIN, id: 'danger', name: '危险技能', disable_model_invocation: true };
  const got = await skill.run({ name: '不存在的' }, ctxWith([PLAIN, locked]));
  assert.equal(got.ok, false);
  assert.match(got.detail, /危险技能.*只能由用户主动触发/, '清单里要标出来，免得模型挨个试');
});

/* ============================ B40 共享纪律 ============================ */

test('B40: 共享纪律拼在正文**之前**（照搬上游「每个 SKILL.md 头部都有一份」）', async () => {
  const discipline = '## 共享纪律\n- 说大白话';
  const skill = toolOf('skill', { shared_discipline: discipline });
  const got = await skill.run({ name: '普通技能' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
  const at = got.detail.indexOf('共享纪律');
  const bodyAt = got.detail.indexOf('正文内容');
  assert.ok(at > 0, '纪律要在结果里');
  assert.ok(bodyAt > at, '纪律必须在正文之前');
  assert.ok(got.detail.includes('说大白话'), '纪律原文要完整给出');
});

test('B40: 纪律为空串 / 没传 → 不注入（用户清空是合法选择）', async () => {
  for (const options of [{}, { shared_discipline: '' }, { shared_discipline: '   ' }]) {
    const skill = toolOf('skill', options);
    const got = await skill.run({ name: '普通技能' }, ctxWith([PLAIN]));
    assert.equal(got.ok, true);
    assert.equal(got.detail.startsWith('技能「普通技能」正文：\n正文内容'), true, '没纪律时正文要顶头');
  }
});

test('B40: 纪律只拼在 skill() 上，read_skill_file 不重复拼（读参考文件时纪律已在上下文里）', async () => {
  const discipline = '## 共享纪律';
  const read = toolOf('read_skill_file', { shared_discipline: discipline });
  const got = await read.run({ skill: '普通技能', file: 'references/字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
  assert.equal(got.detail.includes('共享纪律'), false, '参考文件不该再拼一遍纪律（白烧 token）');
});

/* ============================ 基础契约（防回归）============================ */

test('skill(): 名字 / id / 去空格都能找到；找不到给人话清单', async () => {
  const skill = toolOf('skill');
  for (const name of ['普通技能', 's1', '  普通技能  ']) {
    const got = await skill.run({ name }, ctxWith([PLAIN]));
    assert.equal(got.ok, true, name + ' 该找得到');
  }
  const missing = await skill.run({ name: '没有的' }, ctxWith([PLAIN]));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /普通技能/, '找不到时要给出可用的清单');
  const blank = await skill.run({ name: '' }, ctxWith([PLAIN]));
  assert.equal(blank.ok, false);
});

test('read_skill_file: 只挂一个技能时可以不填 skill；多个技能必须填', async () => {
  const read = toolOf('read_skill_file');
  const only = await read.run({ file: 'references/字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(only.ok, true, '只挂一个时可以省略 skill');

  const two = await read.run({ file: 'references/字段速查表.md' }, ctxWith([PLAIN, { ...PLAIN, id: 's2', name: '第二个' }]));
  assert.equal(two.ok, false, '两个技能时必须说清读哪个');
  assert.match(two.detail, /当前可用技能/);
});

test('create_skill: 少了 name / summary 都要拦；给了就交给注入的保存器', async () => {
  const created = [];
  const make = toolOf('create_skill', { createSkill: draft => created.push(draft) });
  assert.equal((await make.run({ summary: 'x', body: 'y' }, ctxWith([]))).ok, false, '缺 name 要拦');
  assert.equal((await make.run({ name: 'x', body: 'y' }, ctxWith([]))).ok, false, '缺 summary 要拦');

  const ok = await make.run({ name: '新技能', summary: '什么时候用', body: '怎么做' }, ctxWith([]));
  assert.equal(ok.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, '新技能');
});

test('create_skill: 保存器抛错 → 工具报失败（不假装成功）', async () => {
  const make = toolOf('create_skill', { createSkill: () => { throw new Error('磁盘满了'); } });
  const got = await make.run({ name: 'x', summary: 'y', body: 'z' }, ctxWith([]));
  assert.equal(got.ok, false);
  assert.match(got.detail, /磁盘满了/);
});

test('B48: 注入的 readSkillFile 优先于 ctx.skills 里带的内容', async () => {
  const read = toolOf('read_skill_file', {
    readSkillFile: (skill, fileName) => (fileName === 'references/字段速查表.md' ? '来自文件的内容' : undefined),
  });
  const got = await read.run({ skill: '普通技能', file: 'references/字段速查表.md' }, ctxWith([PLAIN]));
  assert.equal(got.ok, true);
  assert.match(got.detail, /来自文件的内容/, '注入的读取器优先（内容真源在 ST 文件里）');
  assert.equal(got.detail.includes('字段表正文'), false, '不该回落到 ctx 里那份');
});
