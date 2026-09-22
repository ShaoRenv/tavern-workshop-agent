/**
 * 阶段 6 · P6-5：MCP **协议客户端**（`plugins/builtin/mcp/client.ts`）。
 *
 * 全程**不给真网络**：`createMcpClient` 的 fetch 是**注入**的，塞手写 stub 即可。
 *
 * ⚠️ 本文件的头号断言目标：**失败矩阵**。这是整条链上最容易漏的一处 ——
 * 网络层的原始 `TypeError: Failed to fetch` 一旦漏出去，用户看到的是「工具崩了」，
 * 而不是「服务器 CORS 没配」。所以**每一条失败都必须是 `McpError`，且 code + hint 有内容**。
 *
 * 跑法：node --test "tests/苍玄助手/mcp_client.test.ts"
 * （不要用 pnpm，本机 pnpm 有与本工作无关的锁文件检查故障）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const { createMcpClient, McpError, MCP_ERROR_CODES } = await import(root + 'plugins/builtin/mcp/client.ts');

/* ============================ 假 fetch 工具 ============================ */

/** 最小 Response 形状（客户端只用 status / ok / text / headers） */
function res(status: number, body: string, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    async text() {
      return body;
    },
  } as unknown as Response;
}

/** JSON-RPC 成功响应 */
function ok(id: unknown, result: unknown, headers: Record<string, string> = {}) {
  return res(200, JSON.stringify({ jsonrpc: '2.0', id, result }), headers);
}

/**
 * 按 method 分派的手写 fetch stub。
 *
 * `calls` 记下每一次请求的 method / headers / body，用来断言翻页、会话复用、
 * 以及「通知失败不算错」这类跨请求性质。
 */
function makeFetch(handler: (method: string, body: any, url: string, init: any) => Response | Promise<Response>) {
  const calls: Array<{ method: string; url: string; body: any; headers: Record<string, string> }> = [];
  const impl = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const method = typeof body?.method === 'string' ? body.method : '';
    calls.push({ method, url, body, headers: { ...(init?.headers ?? {}) } });
    return handler(method, body, url, init);
  };
  return { calls, impl: impl as unknown as typeof fetch, countOf: (m: string) => calls.filter(c => c.method === m).length };
}

/** 一个「标准好服务器」：initialize + notifications/initialized + tools/list 都能答 */
function goodServer(tools: unknown[] = [{ name: 'echo' }]) {
  return makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: '测试服务器', version: '9.9' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') return ok(body.id, { tools });
    return ok(body.id, {});
  });
}

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return createMcpClient({ url: 'https://mcp.example/rpc', fetchImpl, ...over } as any);
}

/** 断言一个失败是 McpError 并且 code / hint / message 都有实际内容 */
async function expectMcpError(run: () => Promise<unknown>, label: string, expectedCode?: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, label + '：应该抛，但没抛（静默失败是最糟的）');
  assert.ok(
    caught instanceof McpError,
    label + '：必须抛 McpError，实际是 ' + (caught as Error)?.constructor?.name + '：' + String((caught as Error)?.message),
  );
  const err = caught as any;
  assert.ok(typeof err.code === 'string' && err.code.length > 0, label + '：code 要有内容');
  assert.ok(typeof err.message === 'string' && err.message.length > 0, label + '：message 要有内容');
  assert.ok(typeof err.hint === 'string' && err.hint.length > 0, label + '：hint（人话建议）要有内容 —— 用户就是靠它自救的');
  // ⚠️ 绝不许把裸 TypeError 漏出去
  assert.equal(/^TypeError/.test(err.message), false, label + '：不该是裸 TypeError：' + err.message);
  assert.equal(/Failed to fetch$/.test(err.message), false, label + '：不该把原始网络错误原文当人话');
  if (expectedCode) assert.equal(err.code, expectedCode, label + '：错误码要分对类');
  return err;
}

/* ============================ 握手与正常路径 ============================ */

test('initialize：握手成功 + 把服务端服务器名/版本带回来', async () => {
  const fake = goodServer();
  const info = await client(fake.impl).initialize();

  assert.equal(info.serverName, '测试服务器');
  assert.equal(info.serverVersion, '9.9');
  assert.equal(info.protocolVersion, '2025-06-18');
  assert.equal(fake.countOf('initialize'), 1);
  // initialize 之后要发 notifications/initialized（MCP 规定的握手第二步）
  assert.equal(fake.countOf('notifications/initialized'), 1, '握手第二步要发出去');
});

test('notifications/initialized 失败**不算错**（握手已经成功，不该因此连不上）', async () => {
  const fake = makeFetch((method, body, _url, _init) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(500, '通知炸了');
    return ok(body.id, {});
  });

  const info = await client(fake.impl).initialize();
  assert.equal(info.serverName, 's', '通知失败不该把握手判死');
});

/* ============================ ⭐失败矩阵 ============================ */

test('⭐失败矩阵：网络层炸（CORS / 连不上）→ McpError(NETWORK) 带人话，**不许裸 TypeError**', async () => {
  const fake = makeFetch(() => {
    // 浏览器里 CORS 被挡就是这个形态：fetch 直接 reject 一个 TypeError
    throw new TypeError('Failed to fetch');
  });
  const err = await expectMcpError(() => client(fake.impl).initialize(), '网络失败', MCP_ERROR_CODES.NETWORK);
  assert.match(err.hint, /网络|CORS|跨域|地址/i, 'hint 要指出可能是网络 / CORS / 地址问题');
});

test('⭐失败矩阵：401 → McpError(AUTH)，hint 指向鉴权', async () => {
  const fake = makeFetch(() => res(401, 'unauthorized'));
  const err = await expectMcpError(() => client(fake.impl).initialize(), '401', MCP_ERROR_CODES.AUTH);
  assert.match(err.hint, /Key|鉴权|令牌|Token|认证/i, 'hint 要说清是鉴权问题');
});

test('⭐失败矩阵：403 → 同样是 McpError(AUTH)（不许当成一般网络错误）', async () => {
  const fake = makeFetch(() => res(403, 'forbidden'));
  await expectMcpError(() => client(fake.impl).initialize(), '403', MCP_ERROR_CODES.AUTH);
});

test('⭐失败矩阵：404 → McpError(NOT_FOUND)，hint 提示地址写错', async () => {
  const fake = makeFetch(() => res(404, 'not found'));
  const err = await expectMcpError(() => client(fake.impl).initialize(), '404', MCP_ERROR_CODES.NOT_FOUND);
  assert.match(err.hint, /地址|URL|路径|地址栏|填/i, 'hint 要提示多半是地址填错了');
});

test('⭐失败矩阵：5xx → McpError(SERVER)，hint 说明是服务端的问题（不是用户配错）', async () => {
  for (const status of [500, 502, 503]) {
    const fake = makeFetch(() => res(status, 'boom'));
    const err = await expectMcpError(() => client(fake.impl).initialize(), String(status), MCP_ERROR_CODES.SERVER);
    assert.match(err.hint, /服务端|服务器|稍后|重试/i, status + ' 的 hint 要说清是服务端侧');
  }
});

test('⭐失败矩阵：坏 JSON → McpError(BAD_JSON)，不是 JSON.parse 的裸 SyntaxError', async () => {
  const fake = makeFetch(() => res(200, '{这不是合法 JSON'));
  const err = await expectMcpError(() => client(fake.impl).initialize(), '坏 JSON', MCP_ERROR_CODES.BAD_JSON);
  assert.match(err.hint, /JSON|格式|返回/i, 'hint 要指出返回体不是合法 JSON');
});

test('⭐失败矩阵：JSON-RPC error 对象 → McpError(RPC_ERROR) 且带上远端给的原文', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return res(200, JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found: 不认识的方法' } }));
    }
    return ok(body.id, {});
  });
  const err = await expectMcpError(() => client(fake.impl).initialize(), 'JSON-RPC error', MCP_ERROR_CODES.RPC_ERROR);
  assert.match(err.message + err.hint, /不认识的方法|Method not found/, '要把远端给的原因透出来，否则没法排查');
});

test('⭐失败矩阵：超时（AbortController）→ McpError(TIMEOUT)，且真的会中止请求', async () => {
  let sawAbort = false;
  const fake = makeFetch((_method, _body, _url, init) => {
    // 模拟「服务器一直不回」：等外部 abort
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener?.('abort', () => {
        sawAbort = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  });

  const err = await expectMcpError(
    () => client(fake.impl, { timeoutMs: 30 }).initialize(),
    '超时',
    MCP_ERROR_CODES.TIMEOUT,
  );
  assert.equal(sawAbort, true, '超时必须真的 abort 掉挂起的请求（否则连接泄漏）');
  assert.match(err.hint, /超时|网络|重试|服务端/i);
});

test('失败矩阵汇总：**每一条**都必须自带 code + hint（不许有任何一条裸漏出去）', async () => {
  // 这条是「矩阵完整性」的总闸：把上面各条的错误形态再并列跑一遍，
  // 统一断言「是 McpError 且有 code/hint」—— 防止将来有人加了一条新的错误路径却忘了分类。
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ['网络炸', () => { throw new TypeError('Failed to fetch'); }],
    ['401', () => res(401, '')],
    ['403', () => res(403, '')],
    ['404', () => res(404, '')],
    ['429', () => res(429, '')],
    ['500', () => res(500, '')],
    ['坏 JSON', () => res(200, 'xx')],
    ['空响应体', () => res(200, '')],
    ['JSON-RPC error', () => res(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }))],
  ];
  for (const [label, respond] of cases) {
    const fake = makeFetch(respond);
    await expectMcpError(() => client(fake.impl).initialize(), label);
  }
});

/* ============================ close 语义 ============================ */

test('close 之后一切请求直接被拒（McpError(ABORTED)），不是静默失败', async () => {
  const fake = goodServer();
  const c = client(fake.impl);
  await c.initialize();
  const before = fake.calls.length;

  c.close();
  await expectMcpError(() => c.listTools(), 'close 后 listTools', MCP_ERROR_CODES.ABORTED);
  assert.equal(fake.calls.length, before, 'close 之后不该再发请求出去');
});

test('close 是幂等的（调两次不炸）', async () => {
  const fake = goodServer();
  const c = client(fake.impl);
  await c.initialize();
  c.close();
  c.close();
  c.close();
});

test('缺 url / 没有 fetch → McpError(CONFIG)，且在发请求前就拦住', async () => {
  const fake = goodServer();
  await expectMcpError(() => createMcpClient({ url: '  ', fetchImpl: fake.impl } as any).initialize(), '缺 url', MCP_ERROR_CODES.CONFIG);
  await expectMcpError(() => createMcpClient({ url: 'https://x', fetchImpl: undefined } as any).initialize(), '没有 fetch', MCP_ERROR_CODES.CONFIG);
  assert.equal(fake.calls.length, 0, '配置不对时不该发出任何请求');
});

/* ============================ tools/list 翻页 ============================ */

test('tools/list：按 nextCursor **翻页合并**，且按名字去重', async () => {
  let page = 0;
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') {
      page += 1;
      if (page === 1) return ok(body.id, { tools: [{ name: 't1' }, { name: 't2' }], nextCursor: 'c1' });
      if (page === 2) return ok(body.id, { tools: [{ name: 't2' }, { name: 't3' }], nextCursor: 'c2' }); // t2 重叠返回
      return ok(body.id, { tools: [{ name: 't4' }] }); // 没有 nextCursor → 结束
    }
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  const tools = await c.listTools();

  assert.deepEqual(tools.map(t => t.name), ['t1', 't2', 't3', 't4'], '三页按顺序合并，重叠的 t2 只留一份');
  assert.equal(fake.countOf('tools/list'), 3, '真的翻了三页');
  // 第一页不带 cursor，后续要带上一页给的
  const listCalls = fake.calls.filter(call => call.method === 'tools/list');
  assert.deepEqual(listCalls.map(call => call.body.params?.cursor), [undefined, 'c1', 'c2'], 'cursor 要按上一页的 nextCursor 传');
});

test('tools/list：服务端原地打转（nextCursor 不变）→ 直接报错，别白翻 50 页', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') return ok(body.id, { tools: [{ name: 'loop1' }], nextCursor: 'same' });
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  await expectMcpError(() => c.listTools(), '游标不前进', MCP_ERROR_CODES.BAD_RESPONSE);

  // 关键：要在**前几页**就抓到，而不是拉满上限
  assert.ok(fake.countOf('tools/list') <= 3, '要尽早判错，实际翻了 ' + fake.countOf('tools/list') + ' 页');
});

test('tools/list：没名字 / 非对象的条目被丢掉，不炸也不产出坏工具', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') return ok(body.id, { tools: [{ name: 'good' }, { name: '   ' }, null, '字符串', { 没有name: 1 }] });
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  const tools = await c.listTools();
  assert.deepEqual(tools.map(t => t.name), ['good'], '只有合法名字的留下');
});

test('tools/list：不给 inputSchema 时给合法空壳（不能是 undefined / null）', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') return ok(body.id, { tools: [{ name: 'noSchema' }] });
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  const [tool] = await c.listTools();
  assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', '要给对象');
  assert.equal((tool.inputSchema as any).type, 'object', '空壳也必须是合法 JSON Schema');
});

/* ============================ tools/call ============================ */

test('tools/call：content[] 拼接成一段文本；isError 标记透传', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/call') {
      return ok(body.id, {
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
          { type: 'image', data: 'xxx' },
          { type: 'text', text: '第三段' },
        ],
        isError: false,
      });
    }
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  const result = await c.callTool('echo', { a: 1 });

  assert.equal(result.isError, false);
  assert.match(result.text, /第一段/, 'text 段要拼进来');
  assert.match(result.text, /第二段/);
  assert.match(result.text, /第三段/);
  assert.ok(result.text.indexOf('第一段') < result.text.indexOf('第二段'), '顺序要保持');
  assert.ok(result.raw, 'raw 要原样带回来给界面展开');
});

test('tools/call：服务端说 isError:true → isError 透传（与「请求失败」是两回事）', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/call') return ok(body.id, { content: [{ type: 'text', text: '业务上失败了' }], isError: true });
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  const result = await c.callTool('echo', {});
  assert.equal(result.isError, true, '这是工具执行结果，不是连接故障 —— 不能翻成异常');
  assert.match(result.text, /业务上失败了/);
});

test('tools/call：失败（5xx）照样是 McpError，不是返回一个空结果', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/call') return res(500, 'boom');
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();
  await expectMcpError(() => c.callTool('echo', {}), 'tools/call 5xx', MCP_ERROR_CODES.SERVER);
});

/* ============================ Mcp-Session-Id 复用 ============================ */

test('Mcp-Session-Id：initialize 响应头里给的会话 id，后续请求都要带回', async () => {
  const fake = makeFetch((method, body) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} }, { 'Mcp-Session-Id': 'sess-123' });
    }
    if (method === 'notifications/initialized') return res(202, '');
    if (method === 'tools/list') return ok(body.id, { tools: [{ name: 'echo' }] });
    return ok(body.id, {});
  });

  const c = client(fake.impl);
  await c.initialize();

  // initialize 自己**不带**会话 id（那时还没有）
  const initCall = fake.calls.find(call => call.method === 'initialize')!;
  assert.equal(initCall.headers['Mcp-Session-Id'], undefined, 'initialize 时还没有会话 id');

  await c.listTools();
  const listCall = fake.calls.find(call => call.method === 'tools/list')!;
  assert.equal(listCall.headers['Mcp-Session-Id'], 'sess-123', '后续请求要复用服务端给的会话 id');
  assert.equal(listCall.headers['Content-Type'], 'application/json');
  assert.match(listCall.headers['Accept'] ?? '', /application\/json/, '要声明接受 JSON');
  assert.match(listCall.headers['Accept'] ?? '', /text\/event-stream/, 'MCP Streamable HTTP 要求也声明 SSE');
});

test('自定义请求头（鉴权）每次请求都带上，且不与协议头打架', async () => {
  const fake = goodServer();
  const c = createMcpClient({
    url: 'https://mcp.example/rpc',
    fetchImpl: fake.impl,
    headers: { Authorization: 'Bearer secret-token' },
  } as any);
  await c.initialize();
  await c.listTools();

  for (const call of fake.calls) {
    if (call.method === 'notifications/initialized') continue;
    assert.equal(call.headers.Authorization, 'Bearer secret-token', call.method + ' 要带鉴权头');
  }
});

test('404 带过会话 id → 会话过期口径（清掉本地 id，下次不带坏 id）', async () => {
  let phase = 0;
  const fake = makeFetch((method, body, _url, init) => {
    if (method === 'initialize') {
      return ok(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '1' }, capabilities: {} }, { 'Mcp-Session-Id': 'sess-1' });
    }
    if (method === 'notifications/initialized') return res(202, '');
    phase += 1;
    if (phase === 1) {
      // 拿着会话 id 去请求 → 服务端说过期了
      assert.equal(init.headers?.['Mcp-Session-Id'] ?? init.headers?.get?.('Mcp-Session-Id'), 'sess-1');
      return res(404, 'session expired');
    }
    // 第二次：本地 id 已被清掉，不该再带上那个坏 id
    const sent = init.headers?.['Mcp-Session-Id'];
    assert.equal(sent, undefined, '过期后要清掉本地会话 id，别一直带着坏 id 重试');
    return ok(body.id, { tools: [{ name: 'echo' }] });
  });

  const c = client(fake.impl);
  await c.initialize();
  await expectMcpError(() => c.listTools(), '会话过期');
  // 再试一次应当不带旧 id（service 侧清掉后不再沿用）
  const tools = await c.listTools();
  assert.deepEqual(tools.map(t => t.name), ['echo']);
});
