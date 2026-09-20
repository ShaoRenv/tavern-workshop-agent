/**
 * agent-core 端到端：registry + transport(text) + loop + draft + 真 WorldbookPort（假数据）全链路，不依赖 UI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const base = '../../src/苍玄助手/agent/';
const { DraftStore } = await import(base + 'draft.ts');
const { createRegistry } = await import(base + 'registry.ts');
const { createTransport } = await import(base + 'transport.ts');
const { runAgentLoop } = await import(base + 'loop.ts');

function entry(uid, name, content) {
  return {
    uid,
    name,
    content,
    enabled: true,
    strategy: 'selective',
    keys: [name],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
    position: 0,
    depth: 4,
    order: 100,
    extra: { keep: uid },
  };
}

function makePort(seed) {
  const worlds = new Map(Object.entries(seed));
  const port = {
    writes: [],
    async list() {
      return [...worlds.keys()];
    },
    async current() {
      return [...worlds.keys()];
    },
    async readAll(w) {
      return structuredClone(worlds.get(w) ?? []);
    },
    async readByUid(w, uids) {
      return (worlds.get(w) ?? []).filter(e => uids.includes(e.uid)).map(e => structuredClone(e));
    },
    async search(ws, keyword) {
      const hits = [];
      for (const w of ws) {
        for (const e of worlds.get(w) ?? []) {
          if (e.content.includes(keyword) || e.name.includes(keyword)) {
            hits.push({ world: w, uid: e.uid, name: e.name, snippet: e.content.slice(0, 12), hits: 1 });
          }
        }
      }
      return hits;
    },
    async createWorldbook() {},
    async deleteWorldbook() {},
    async writeAll(w, entries) {
      port.writes.push({ world: w, entries });
      worlds.set(w, entries.map(e => structuredClone(e)));
    },
  };
  return port;
}

test('端到端：文本通道 → 检索 → 草稿改条目 → submit → 落地 writeAll', async () => {
  const port = makePort({ 天枢阁: [entry('42', '天枢阁', '天枢阁总部在苍梧山，掌门为凌霄真人')] });
  const drafts = new DraftStore();
  const registry = createRegistry(port);

  // 假酒馆生成：三轮，模型完全按 SystemQuery 协议输出
  let round = 0;
  const generateRawImpl = async config => {
    round++;
    assert.equal(config.should_silence, true);
    assert.ok(Array.isArray(config.ordered_prompts));
    if (round === 1) {
      return '先搜一下。<SystemQuery>{"name":"wb_search","args":{"keyword":"天枢阁"}}</SystemQuery>';
    }
    if (round === 2) {
      return [
        '读一下再看。',
        '<SystemQuery>{"name":"wb_read","args":{"uid":"42"}}</SystemQuery>',
        '<SystemQuery>{"name":"entry_edit","args":{"uid":"42","old_string":"总部在苍梧山","new_string":"总部位于苍梧山巅"}}</SystemQuery>',
      ].join('\n');
    }
    return '总部位置补清楚了。<SystemQuery>{"name":"submit","args":{"summary":"补了天枢阁总部位置"}}</SystemQuery>';
  };

  const transport = createTransport({ generateRawImpl });
  const ctx = {
    worlds: ['天枢阁'],
    drafts,
    skills: [],
  };
  const events = [];
  const result = await runAgentLoop({
    transport,
    tools: registry.defs,
    settings: { route: 'tavern', url: '', key: '', model: '', stream: false, send_images: false, timeout_sec: 30 },
    system: '你是苍玄界世界书整理助手。改之前先读。',
    user: '把总部位置写清楚',
    context: ctx,
    max_rounds: 8,
    onEvent: event => events.push(event),
  });

  assert.equal(result.reason, 'submit', JSON.stringify(result.error));
  assert.equal(result.via, 'text');
  assert.equal(round, 3);
  assert.equal(port.writes.length, 0, '草稿阶段不许写回真数据');
  assert.equal(drafts.count(), 1);
  const change = drafts.list()[0];
  assert.equal(change.kind, 'edit');
  assert.equal(change.after, '天枢阁总部位于苍梧山巅，掌门为凌霄真人');
  const diff = drafts.diffs()[0];
  assert.equal(diff.stat.add, 1);
  assert.equal(diff.stat.del, 1);
  assert.match(diff.text, /^\+ 天枢阁总部位于苍梧山巅/m);

  // 用户点「保存」
  const report = await drafts.apply(port);
  assert.equal(report.ok, true);
  assert.equal(port.writes.length, 1);
  assert.equal(port.writes[0].entries[0].content, '天枢阁总部位于苍梧山巅，掌门为凌霄真人');
  assert.equal(port.writes[0].entries[0].extra.keep, '42');
  assert.equal(drafts.count(), 0);

  // 事件流够 UI 画卡片：轮次、工具卡 start/done、Turn、text 通道提醒
  const toolStarts = events.filter(e => e.type === 'tool_call' && e.status === 'start');
  const toolDone = events.filter(e => e.type === 'tool_call' && e.status === 'done');
  assert.equal(toolStarts.length, 4, '三次工具调用共 4 个 start（第 2 轮两个）');
  assert.equal(toolDone.length, 4);
  assert.ok(toolDone.every(e => e.call.brief.length > 0));
  assert.ok(events.some(e => e.type === 'notice' && /文本标记/.test(e.message)));
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  const turnRoles = events.filter(e => e.type === 'turn').map(e => e.turn.role);
  assert.deepEqual(turnRoles, ['user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant', 'tool']);
});
