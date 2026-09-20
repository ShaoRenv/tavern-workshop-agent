/**
 * 工具流水线（agent/pipeline.ts）+ loop 接线：
 *  - before 短路 / def.run 抛错 / 超时 / after 依次替换 / onRawResult
 *  - loop：contexts 变成一条带来源前缀的合成 user 消息；修剪只作用于给模型的那份
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = 'file:///C:/tavern_helper_template-main/src/苍玄助手/';
const { runToolPipeline, effectiveTimeoutMs } = await import(root + 'agent/pipeline.ts');
const { runAgentLoop } = await import(root + 'agent/loop.ts');
const { createDraftStore } = await import(root + 'agent/draft.ts');
const { createPruneGuard } = await import(root + 'agent/guards.ts');

function makeDef(over = {}) {
  return {
    name: 'demo',
    group: 'knowledge',
    title: '演示',
    desc: '演示工具',
    model_description: '演示用',
    parameters: { type: 'object', properties: {} },
    default_on: true,
    run: async () => ({ ok: true, brief: 'ok', detail: 'done' }),
    ...over,
  };
}

function ctxOf(over = {}) {
  return { worlds: ['甲本'], drafts: createDraftStore(), skills: [], ...over };
}

const settings = { route: 'tavern', url: '', key: '', model: '', stream: false, send_images: false, timeout_sec: 30 };

/* ---------------- pipeline ---------------- */

test('pipeline：before 返回结果就短路，def.run 不被调用', async () => {
  let ran = 0;
  const def = makeDef({
    run: async () => {
      ran++;
      return { ok: true, brief: 'ok', detail: 'done' };
    },
  });
  const guard = {
    name: 'gate',
    before: () => ({ ok: false, code: 'SCOPE_DENIED', brief: '不许动', detail: '越权了' }),
  };
  const result = await runToolPipeline({ def, args: {}, ctx: ctxOf(), guards: [guard], round: 1 });
  assert.equal(ran, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(result.detail, '越权了');
});

test('pipeline：def.run 抛错 → TOOL_ERROR；after 守卫能替换结果', async () => {
  const boom = makeDef({
    run: async () => {
      throw new Error('炸了');
    },
  });
  const failed = await runToolPipeline({ def: boom, args: {}, ctx: ctxOf(), round: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'TOOL_ERROR');
  assert.match(failed.detail, /炸了/);

  const order = [];
  const def = makeDef();
  const result = await runToolPipeline({
    def,
    args: { a: 1 },
    ctx: ctxOf(),
    round: 2,
    guards: [
      {
        name: 'after-1',
        after: (input, current) => {
          order.push('after-1:' + input.round);
          return { ...current, contexts: [{ source: 'after-1', summary: 's1', text: 't1' }] };
        },
      },
      {
        name: 'after-2',
        after: (input, current) => {
          order.push('after-2');
          return {
            ...current,
            detail: current.detail + '|2',
            contexts: [...(current.contexts ?? []), { source: 'after-2', summary: 's2', text: 't2' }],
          };
        },
      },
    ],
  });
  assert.deepEqual(order, ['after-1:2', 'after-2']);
  assert.equal(result.detail, 'done|2');
  assert.deepEqual(
    result.contexts.map(note => note.source),
    ['after-1', 'after-2'],
  );
});

test('pipeline：失败结果保留工具自己给的 code，不替它编分类', async () => {
  const plainFail = makeDef({ run: async () => ({ ok: false, brief: '没找到', detail: '没有这条' }) });
  const result = await runToolPipeline({ def: plainFail, args: {}, ctx: ctxOf(), round: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, undefined, '工具没分类就别硬编成 TOOL_ERROR');
  const coded = makeDef({ run: async () => ({ ok: false, code: 'NOT_FOUND', brief: '没找到', detail: '没有这条' }) });
  assert.equal((await runToolPipeline({ def: coded, args: {}, ctx: ctxOf(), round: 1 })).code, 'NOT_FOUND');
});

test('pipeline：超时 → TIMEOUT；工具自带 timeoutMs 与工具页覆盖都认；onRawResult 给 after 之前的原文', async () => {
  const slow = makeDef({
    name: 'slow',
    timeoutMs: 30,
    run: () => new Promise(() => {}),
  });
  assert.equal(effectiveTimeoutMs(slow, ctxOf()), 30);
  assert.equal(effectiveTimeoutMs(slow, ctxOf({ tool_overrides: { slow: { timeout_ms: 15 } } })), 15);
  const timedOut = await runToolPipeline({ def: slow, args: {}, ctx: ctxOf(), round: 1 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'TIMEOUT');
  assert.match(timedOut.detail, /超过 30 毫秒/);

  const fast = makeDef({ timeoutMs: 200, run: async () => ({ ok: true, brief: '快', detail: '好了' }) });
  assert.equal((await runToolPipeline({ def: fast, args: {}, ctx: ctxOf(), round: 1 })).ok, true);
  // 没有 timeoutMs 就不包超时（工具页覆盖也不该管用）
  const noTimeout = makeDef({ run: async () => ({ ok: true, brief: '快', detail: '好了' }) });
  assert.equal(
    (
      await runToolPipeline({
        def: noTimeout,
        args: {},
        ctx: ctxOf({ tool_overrides: { demo: { timeout_ms: 1 } } }),
        round: 1,
      })
    ).ok,
    true,
  );

  const seenRaw = [];
  const overridden = makeDef({ run: async () => ({ ok: true, brief: 'b', detail: '原始 detail' }) });
  const result = await runToolPipeline({
    def: overridden,
    args: {},
    ctx: ctxOf(),
    round: 1,
    onRawResult: raw => seenRaw.push(raw.detail),
    guards: [{ name: 'wipe', after: (_input, current) => ({ ...current, detail: '被守卫改过' }) }],
  });
  assert.deepEqual(seenRaw, ['原始 detail'], 'onRawResult 要给守卫之前的原文');
  assert.equal(result.detail, '被守卫改过');
});

/* ---------------- loop 接线 ---------------- */

function scriptedTransport(replies) {
  const requests = [];
  let index = 0;
  return {
    requests,
    supportsTools: () => 'yes',
    markToolsUnsupported: () => {},
    async chat(req) {
      requests.push({ ...req, messages: req.messages.slice() });
      const reply = replies[Math.min(index, replies.length - 1)];
      index++;
      return reply;
    },
  };
}

test('loop：守卫的 contexts 变成合成 user 消息；修剪只作用于给模型的那份', async () => {
  const huge = 'A'.repeat(9000);
  const tool = makeDef({
    name: 'wb_read',
    run: async () => ({ ok: true, brief: '读完了', detail: huge }),
  });
  const noteGuard = {
    name: 'test-guard',
    after: (_input, current) => ({
      ...current,
      contexts: [{ source: 'test-guard', summary: '一句建议', text: '换个方法试试。' }],
    }),
  };
  const transport = scriptedTransport([
    { text: '先读', tool_calls: [{ id: 'c1', name: 'wb_read', args: { world: '甲本' } }], via: 'native' },
    { text: '收工', tool_calls: [], via: 'native' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    transport,
    tools: [tool],
    settings,
    system: '你是助手',
    user: '看看',
    context: ctxOf(),
    guards: [createPruneGuard(), noteGuard],
    onEvent: event => events.push(event),
  });

  assert.equal(result.reason, 'no_tool_calls');
  const toolMessage = result.messages.find(message => message.role === 'tool');
  assert.ok(toolMessage, '要有 tool 消息');
  assert.ok(toolMessage.content.length < 9000, '给模型的那份要修剪');
  assert.match(toolMessage.content, /\[\.\.\. 中间已修剪 \.\.\.\]/);
  const contextMessage = result.messages.find(
    message => message.role === 'user' && message.content.startsWith('【test-guard】'),
  );
  assert.ok(contextMessage, '守卫的建议要作为一条带来源前缀的合成 user 消息');
  assert.match(contextMessage.content, /换个方法试试/);
  // 合成消息必须紧跟在 tool 消息之后
  assert.equal(result.messages[result.messages.indexOf(toolMessage) + 1], contextMessage);

  // call.detail 是原文（会话日志读它）；loop 里定稿的记录挂在 tool 轮次上
  const callTurn = result.turns.find(turn => turn.role === 'tool' && turn.calls[0]?.name === 'wb_read');
  assert.ok(callTurn, '要有 tool 轮次');
  assert.equal(callTurn.calls[0].detail.length, 9000, 'call.detail 保留原文');
  assert.equal(toolMessage.content.includes('【test-guard】'), false, '建议不进 tool 消息本体');

  // 事件带 code / contexts / pruned / raw_detail
  const doneEvent = events.find(event => event.type === 'tool_call' && event.status === 'done');
  assert.ok(doneEvent);
  assert.deepEqual(doneEvent.pruned, {
    original_chars: 9000,
    kept_chars: 4096 + '\n\n[... 中间已修剪 ...]\n\n'.length + 1024,
  });
  assert.equal(doneEvent.raw_detail.length, 9000);
  assert.equal(doneEvent.contexts[0].source, 'test-guard');
});

test('loop：失败结果带 code；未知工具走 UNKNOWN_TOOL 且不炸', async () => {
  const failTool = makeDef({
    name: 'wb_read',
    run: async () => ({ ok: false, code: 'NOT_FOUND', brief: '找不到', detail: '没有这条' }),
  });
  const transport = scriptedTransport([
    { text: '', tool_calls: [{ id: 'c1', name: 'wb_read', args: {} }], via: 'native' },
    { text: '', tool_calls: [{ id: 'c2', name: '不存在', args: {} }], via: 'native' },
    { text: '收工', tool_calls: [], via: 'native' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    transport,
    tools: [failTool],
    settings,
    system: 's',
    user: 'u',
    context: ctxOf(),
    onEvent: event => events.push(event),
  });
  assert.equal(result.reason, 'no_tool_calls');
  const codes = events.filter(event => event.type === 'tool_call' && event.status === 'done').map(event => event.code);
  assert.deepEqual(codes, ['NOT_FOUND', 'UNKNOWN_TOOL'], '工具自己给的分类要原样落到事件上');
  const call = result.turns.find(turn => turn.role === 'tool' && turn.calls[0]?.name === '不存在');
  assert.equal(call.calls[0].ok, false);
});
