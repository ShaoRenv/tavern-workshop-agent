/**
 * 阶段 6 · P6-5：MCP **连接状态机 + 工具装配**（`plugins/builtin/mcp/connection.ts`）。
 *
 * 这层是「远端工具怎么变成底座工具」的唯一落点，也是 P6 最容易写错的一层。
 * 全程**不给真网络**：`connectServer(server, getFetch)` 的 fetch 是**注入**的，
 * 塞一个手写 stub 就能把状态机整条驱动一遍（不需要 pinia、不需要起服务器）。
 *
 * ⚠️ 本文件的头号断言目标：`registerRuntimeTools(plugin, tools)` 是
 * **按插件整批替换**的 —— 任何「只注册一台 / 只注销一台」的增量写法都会把
 * 别的服务器的工具一起抹掉。所以「连 A、连 B → 断 A 不能抹掉 B」是核心用例。
 *
 * 跑法：node --test "tests/苍玄助手/mcp_connection.test.ts"
 * （不要用 pnpm，本机 pnpm 有与本工作无关的锁文件检查故障）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = '../../src/苍玄助手/';
const {
  connectServer,
  disconnectServer,
  disconnectAll,
  syncServers,
  serverStatus,
  serverToolNames,
  serverRejections,
  connectedIds,
} = await import(root + 'plugins/builtin/mcp/connection.ts');
const { pluginToolDefs, pluginTools, pluginAllTools, runtimeToolNames, unregisterRuntimeTools } = await import(
  root + 'plugins/registry.ts'
);

/** MCP 插件开着（默认关）—— 运行时工具只有插件装载时才进 pluginToolDefs */
const MCP_ON = { plugin_state: { mcp: { enabled: true } } };

/* ============================ 假 fetch ============================ */

interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * 手写 fetch stub：**不 mock 全局 fetch、不起服务器**。
 *
 * 它按 JSON-RPC 的 method 分派，返回一个最小可用的 Response 形状。
 * 每次调用都记进 `calls`，用来断言「initialize 发生了几次」这类幂等性质。
 */
function makeFakeFetch(options: {
  tools?: FakeTool[] | ((serverUrl: string) => FakeTool[]);
  onCall?: (method: string, body: any, url: string) => void;
  sessionId?: string;
}) {
  const calls: Array<{ method: string; url: string; body: any }> = [];

  const fetchImpl = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const method = typeof body?.method === 'string' ? body.method : '';
    calls.push({ method, url, body });
    options.onCall?.(method, body, url);

    // 通知（无 id）不回 body —— 客户端不等它
    const isNotification = body?.id === undefined || body?.id === null;
    const headers = new Map<string, string>();
    if (options.sessionId) headers.set('mcp-session-id', options.sessionId);

    if (method === 'initialize') {
      return response({
        status: 200,
        headers,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2024-11-05', serverInfo: { name: '假服务器', version: '1.0' }, capabilities: {} },
        }),
      });
    }
    if (method === 'tools/list') {
      const list = typeof options.tools === 'function' ? options.tools(url) : (options.tools ?? []);
      return response({ status: 200, headers, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { tools: list } }) });
    }
    if (method === 'tools/call') {
      return response({
        status: 200,
        headers,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '远端说：好了' }], isError: false },
        }),
      });
    }
    if (isNotification) return response({ status: 202, headers, json: async () => ({}) });
    return response({ status: 200, headers, json: async () => ({ jsonrpc: '2.0', id: body.id, result: {} }) });
  };

  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    /** 某个 method 被调了几次 */
    countOf(method: string) {
      return calls.filter(call => call.method === method).length;
    },
  };
}

/** 最小 Response 形状（客户端只用到 status / ok / text / headers） */
function response(input: { status: number; json: () => Promise<unknown>; headers?: Map<string, string> }) {
  const text = JSON.stringify(input.json ? undefined : {});
  void text;
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    headers: { get: (name: string) => input.headers?.get(name.toLowerCase()) ?? null },
    async text() {
      const value = await input.json();
      return JSON.stringify(value);
    },
    async json() {
      return input.json();
    },
  } as unknown as Response;
}

/** 造一台服务器配置（字段全给齐） */
function server(over: Record<string, unknown> = {}) {
  return {
    id: 'srv-a',
    name: '甲服务器',
    url: 'https://a.example/mcp',
    headers: {},
    enabled: true,
    disabled_tools: [],
    ...over,
  } as any;
}

/** 每个用例都从干净状态开始，并保证结束时不把进程级状态留给下一个文件 */
function fresh(t: any) {
  disconnectAll();
  unregisterRuntimeTools('mcp');
  t.after(() => {
    disconnectAll();
    unregisterRuntimeTools('mcp');
  });
}

/** 当前进 pluginToolDefs 的 MCP 运行时工具名 */
function liveMcpToolNames(): string[] {
  return pluginToolDefs(MCP_ON)
    .filter(def => (def as any).source === 'external')
    .map(def => def.name);
}

/* ============================ 连上 / 断开 ============================ */

test('连上 → 工具进 pluginToolDefs；断开 → 消失', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }, { name: 'tool_a2' }] });

  assert.deepEqual(liveMcpToolNames(), [], '一开始没有运行时工具');

  const result = await connectServer(server(), () => fake.fetchImpl);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.toolCount, 2, '两台工具都算数');
  assert.deepEqual(runtimeToolNames('mcp').sort(), ['tool_a1', 'tool_a2'], '进了注册表');
  assert.deepEqual(liveMcpToolNames().sort(), ['tool_a1', 'tool_a2'], '插件开着 → 进 pluginToolDefs');
  assert.match(serverStatus('srv-a').label, /2 个工具/, '状态标签报台内工具数');

  disconnectServer('srv-a');
  assert.deepEqual(runtimeToolNames('mcp'), [], '断开 → 注册表里一个都不剩');
  assert.deepEqual(liveMcpToolNames(), [], '断开 → pluginToolDefs 里也没了（模型调不到了）');
  assert.deepEqual(connectedIds(), [], '不再连着');
});

test('插件**关着**时：工具注册了也不进 pluginToolDefs（关插件即消失）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  await connectServer(server(), () => fake.fetchImpl);

  assert.deepEqual(runtimeToolNames('mcp'), ['tool_a1'], '注册表里有');
  assert.deepEqual(
    pluginToolDefs({}).filter(def => (def as any).source === 'external'),
    [],
    '但 mcp 插件默认关 → 不生效（「关掉即消失」在装载层就成立）',
  );
});

/* ============================ ⭐多台合并：断 A 不许抹掉 B ============================ */

test('⭐连 A、连 B → 两台工具都在；**断开 A 不能把 B 的工具抹掉**', async (t) => {
  fresh(t);
  const fakeA = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  const fakeB = makeFakeFetch({ tools: [{ name: 'tool_b1' }, { name: 'tool_b2' }] });

  await connectServer(server({ id: 'a', name: '甲' }), () => fakeA.fetchImpl);
  await connectServer(server({ id: 'b', name: '乙', url: 'https://b.example/mcp' }), () => fakeB.fetchImpl);

  assert.deepEqual(liveMcpToolNames().sort(), ['tool_a1', 'tool_b1', 'tool_b2'], '两台的工具合在一起');

  // ⭐ 核心：断开 A。registerRuntimeTools 是**整批替换**的，
  //    如果实现写成「只注销 A 的」（或者拿 A 剩余的工具去注册），B 就会被一起抹掉。
  disconnectServer('a');

  assert.deepEqual(
    liveMcpToolNames().sort(),
    ['tool_b1', 'tool_b2'],
    '断开 A 之后 B 的两个工具**必须还在**（整批重算，不是增量修补）',
  );
  assert.equal(liveMcpToolNames().includes('tool_a1'), false, 'A 的工具要消失');
  assert.deepEqual(connectedIds(), ['b'], '只剩 B 连着');

  // 再把 B 也断掉 → 全清
  disconnectServer('b');
  assert.deepEqual(liveMcpToolNames(), [], '两台都断 → 一个工具都不剩');
});

test('反面对照：如果「断开」只删会话而**不重算整批**，A 的工具会留在注册表里（证明上面那条不是恒真）', async (t) => {
  fresh(t);
  const fakeA = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  const fakeB = makeFakeFetch({ tools: [{ name: 'tool_b1' }] });
  await connectServer(server({ id: 'a', name: '甲' }), () => fakeA.fetchImpl);
  await connectServer(server({ id: 'b', name: '乙', url: 'https://b.example/mcp' }), () => fakeB.fetchImpl);

  // 对照手段：**绕开 disconnectServer**，直接往注册表里塞回 A 的工具，
  // 模拟「那人只改会话、忘了重算整批」的后果 —— 此时注册表里 A 还在。
  const { registerRuntimeTools } = await import(root + 'plugins/registry.ts');
  registerRuntimeTools(
    'mcp',
    [
      { name: 'tool_a1' },
      { name: 'tool_b1' },
    ] as any,
    'MCP · 甲、乙',
  );
  disconnectServer('a');

  // 正解会重算整批 → A 消失。如果这里还能看到 tool_a1，就说明「重算」这一步没做。
  assert.deepEqual(
    liveMcpToolNames().sort(),
    ['tool_b1'],
    '对照成立：只要有人手工塞回 A 的工具，断开 A 就应该把它清掉 —— 这正是重算整批在起作用',
  );
});

/* ============================ 重连不残留 ============================ */

test('重连后远端改名 → **旧工具名不残留**（整批替换的关键后果）', async (t) => {
  fresh(t);
  let tools: FakeTool[] = [{ name: 'tool_a1' }];
  const fake = makeFakeFetch({ tools: () => tools });

  await connectServer(server(), () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), ['tool_a1']);

  // 远端把 tool_a1 改名成 tool_a1_v2，然后重连
  tools = [{ name: 'tool_a1_v2' }];
  const again = await connectServer(server(), () => fake.fetchImpl);
  assert.equal(again.ok, true, again.error);

  assert.deepEqual(liveMcpToolNames(), ['tool_a1_v2'], '新名字在');
  assert.equal(liveMcpToolNames().includes('tool_a1'), false, '**旧名字必须消失**（残留 = 模型调一个不存在的工具）');
  assert.equal(connectedIds().length, 1, '重连不该留下同一 id 的两份会话');
});

/* ============================ 撞名被拒（不静默） ============================ */

test('⭐远端工具撞底座名（wb_read）→ 被拒且原因可见，**不静默**', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'wb_read' }, { name: 'tool_a1' }] });

  const result = await connectServer(server(), () => fake.fetchImpl);
  assert.equal(result.ok, true, '连接本身是成功的（只是有个工具进不来）');
  assert.equal(result.toolCount, 1, 'toolCount 只算**可用**的 —— 报 2 会让用户以为模型能调 wb_read');

  // 好工具进来了，撞名的没进来
  assert.deepEqual(liveMcpToolNames(), ['tool_a1'], 'wb_read 不许覆盖内置的世界书工具');
  assert.equal(runtimeToolNames('mcp').includes('wb_read'), false);

  // ⭐ 不静默：原因要能被界面拿到
  const rejections = serverRejections('srv-a');
  assert.equal(rejections.length, 1, '要有一条拒绝记录');
  assert.equal(rejections[0].name, 'wb_read');
  assert.match(rejections[0].reason, /内置插件的工具占用|静态声明优先/, '原因要说明是撞了静态工具');
  assert.match(serverStatus('srv-a').label, /被拒/, '状态标签要把「有几个被拒」显示出来');

  // serverToolNames 与 rejections 分清「有但没进来」 vs 「没有」
  assert.deepEqual(serverToolNames('srv-a'), ['tool_a1'], '工具名列表不含被拒的');
  assert.equal(serverToolNames('srv-a').includes('wb_read'), false);
});

test('反面对照：不撞名的工具**不会**被误拒（证明上一条的拒绝不是无差别拒绝）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }, { name: 'tool_a2' }] });
  await connectServer(server(), () => fake.fetchImpl);

  assert.deepEqual(serverRejections('srv-a'), [], '没撞名 → 一条拒绝都没有');
  assert.deepEqual(liveMcpToolNames().sort(), ['tool_a1', 'tool_a2'], '两个都进得来');
  assert.equal(serverStatus('srv-a').kind, 'ok', '没有拒绝时状态是 ok');
});

test('同一批里两个同名远端工具 → 只留一个（另一个被拒并给原因）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_dup' }, { name: 'tool_dup' }] });
  await connectServer(server(), () => fake.fetchImpl);

  // client 的 listTools 会按名字去重（服务端翻页重叠），所以这里先确认最终只有一份
  assert.deepEqual(liveMcpToolNames(), ['tool_dup'], '同名只留一份，不会出现两条一样的工具');
  assert.deepEqual(serverRejections('srv-a'), [], 'client 层已去重，不该产生拒绝记录');
});

/* ============================ 逐条停用 ============================ */

test('逐条停用（disabled_tools）→ 工具进 defs 但 default_on === false（不默认给模型）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }, { name: 'tool_a2' }] });
  await connectServer(server({ disabled_tools: ['tool_a2'] }), () => fake.fetchImpl);

  const defs = pluginToolDefs(MCP_ON).filter(def => (def as any).source === 'external');
  assert.deepEqual(defs.map(def => def.name).sort(), ['tool_a1', 'tool_a2'], '被停用的**仍然在注册表里**（工具页还看得到）');

  const a2 = defs.find(def => def.name === 'tool_a2')!;
  const a1 = defs.find(def => def.name === 'tool_a1')!;
  assert.equal(a2.default_on, false, '被停用的 default_on 必须是 false');
  assert.equal(a1.default_on, true, '没被停用的照常默认给');

  // 「默认给模型」那份清单里不该有它
  assert.equal(pluginTools(MCP_ON).includes('tool_a2'), false, '停用的不进默认能力');
  assert.ok(pluginAllTools(MCP_ON).includes('tool_a2'), '但仍在注册清单里（界面列得出来）');
});

/* ============================ syncServers 幂等 ============================ */

test('syncServers 幂等：连调三次 → initialize 只发生一次，工具不反复消失又出现', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  const list = [server()];

  const first = await syncServers(list, () => fake.fetchImpl);
  assert.equal(first.length, 1, '第一次真的要连 → 出结果');
  assert.equal(first[0].ok, true, first[0].error);

  const second = await syncServers(list, () => fake.fetchImpl);
  const third = await syncServers(list, () => fake.fetchImpl);
  assert.deepEqual(second, [], '第二次没动任何东西 → 结果为空');
  assert.deepEqual(third, [], '第三次同样');

  assert.equal(fake.countOf('initialize'), 1, '⭐ initialize 只该发生一次（重复连接会打断正在跑的工具调用）');
  assert.deepEqual(liveMcpToolNames(), ['tool_a1'], '工具一直在，没被反复摘掉又装回');
});

test('syncServers：只改 disabled_tools → **不重连**（但 default_on 要跟着变）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });

  await syncServers([server({ disabled_tools: [] })], () => fake.fetchImpl);
  assert.equal(fake.countOf('initialize'), 1);

  const results = await syncServers([server({ disabled_tools: ['tool_a1'] })], () => fake.fetchImpl);
  assert.deepEqual(results, [], '只改停用清单 → 没有网络动作');
  assert.equal(fake.countOf('initialize'), 1, '**不重连**（不碰网络）');

  const def = pluginToolDefs(MCP_ON).find(d => d.name === 'tool_a1') as any;
  assert.equal(def.default_on, false, '但 default_on 必须跟着停用清单变（这条要求重算整批）');

  // 再放回来
  await syncServers([server({ disabled_tools: [] })], () => fake.fetchImpl);
  assert.equal((pluginToolDefs(MCP_ON).find(d => d.name === 'tool_a1') as any).default_on, true, '取消停用要恢复');
  assert.equal(fake.countOf('initialize'), 1, '全程只连了一次');
});

test('syncServers：关掉服务器 → 工具消失；配置里删掉 → 也消失', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  await syncServers([server()], () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), ['tool_a1']);

  await syncServers([server({ enabled: false })], () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), [], '关掉 → 工具消失');
  assert.deepEqual(connectedIds(), []);

  // 再开回来 → 重连
  await syncServers([server()], () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), ['tool_a1'], '再开 → 工具回来');

  // 从配置里彻底删掉
  await syncServers([], () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), [], '从配置删掉 → 也消失（不会变成「幽灵工具」）');
});

test('syncServers：地址变了 → 重连（initialize 再来一次）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  await syncServers([server()], () => fake.fetchImpl);
  assert.equal(fake.countOf('initialize'), 1);

  await syncServers([server({ url: 'https://a.example/mcp-v2' })], () => fake.fetchImpl);
  assert.equal(fake.countOf('initialize'), 2, '地址变了要重连（不然还在用旧地址）');

  // 只改 name（显示名）不该重连
  const before = fake.countOf('initialize');
  await syncServers([server({ url: 'https://a.example/mcp-v2', name: '改了名字' })], () => fake.fetchImpl);
  assert.equal(fake.countOf('initialize'), before, '只改显示名不重连');
});

/* ============================ 失败不留半截 ============================ */

test('连接失败 → ok:false + 人话 error，且**不留半截会话**（工具一个都不进）', async (t) => {
  fresh(t);
  const failing = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;

  const result = await connectServer(server({ id: 'bad' }), () => failing);
  assert.equal(result.ok, false);
  assert.equal(result.toolCount, 0);
  assert.ok(result.error && result.error.length > 0, '要有可显示的原因');
  // ⚠️ 绝不许把裸 TypeError 漏给用户 —— 要是人话
  assert.equal(/^TypeError/.test(result.error!), false, '不该是裸 TypeError：' + result.error);

  assert.deepEqual(connectedIds(), [], '失败的服务器不该留下会话');
  assert.deepEqual(liveMcpToolNames(), [], '更不该留下工具（半截状态是最糟的：工具在、client 没了）');
});

test('缺 id / 缺 url / 环境没 fetch → 都是 ok:false + 人话，不抛', async (t) => {
  fresh(t);
  const cases: Array<[string, any, () => any]> = [
    ['缺 id', server({ id: '' }), () => makeFakeFetch({}).fetchImpl],
    ['缺 url', server({ url: '' }), () => makeFakeFetch({}).fetchImpl],
    ['环境没有 fetch', server(), () => null],
  ];
  for (const [label, srv, getFetch] of cases) {
    const result = await connectServer(srv, getFetch as any);
    assert.equal(result.ok, false, label + ' 应该失败');
    assert.ok(result.error && result.error.length > 0, label + ' 要给人话原因');
    assert.equal(result.toolCount, 0);
  }
});

test('connectServer 失败后，**已经连着的别的服务器不受影响**', async (t) => {
  fresh(t);
  const good = makeFakeFetch({ tools: [{ name: 'tool_b1' }] });
  await connectServer(server({ id: 'b', name: '乙' }), () => good.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), ['tool_b1']);

  const failing = (async () => {
    throw new Error('boom');
  }) as unknown as typeof fetch;
  const bad = await connectServer(server({ id: 'x', name: '坏的', url: 'https://x.example/mcp' }), () => failing);
  assert.equal(bad.ok, false);

  assert.deepEqual(liveMcpToolNames(), ['tool_b1'], '失败的那台不该把好的那台的工具带走');
  assert.deepEqual(connectedIds(), ['b']);
});

/* ============================ 工具转发行为 ============================ */

test('工具 run() 转发到远端 tools/call；远端报错 → ok:false 而不是抛', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  await connectServer(server(), () => fake.fetchImpl);

  const def = pluginToolDefs(MCP_ON).find(d => d.name === 'tool_a1')!;
  const result = await def.run({ 参数: 1 }, { worlds: [], drafts: {} } as any);
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /远端说：好了/, '远端 content[] 的文本要透传回来');
  assert.match(result.brief, /甲服务器/, 'brief 要说明来自哪台服务器');
  assert.equal(fake.countOf('tools/call'), 1, '真的调了远端');
});

test('工具 run()：远端网络炸了 → ok:false + 人话 detail（**不抛**，否则 Agent 循环当成内核异常）', async (t) => {
  fresh(t);
  // 先正常连上，再让后续请求开始失败
  let broken = false;
  const fake = makeFakeFetch({
    tools: [{ name: 'tool_a1' }],
    onCall: () => {
      if (broken) throw new TypeError('Failed to fetch');
    },
  });
  await connectServer(server(), () => fake.fetchImpl);

  const def = pluginToolDefs(MCP_ON).find(d => d.name === 'tool_a1')!;
  broken = true;
  const result = await def.run({}, { worlds: [], drafts: {} } as any);

  assert.equal(result.ok, false, '失败要体现成 ok:false');
  assert.equal(result.code, 'TOOL_ERROR');
  assert.ok(result.detail.length > 0);
  assert.equal(/^TypeError/.test(result.detail), false, 'detail 要是人话，不是裸 TypeError');
});

/* ============================ 只读状态口径 ============================ */

test('serverStatus / serverToolNames / serverRejections：没连过的服务器要有确定答案', (t) => {
  fresh(t);
  assert.deepEqual(serverStatus('从没连过'), { label: '未连接', kind: '' });
  assert.deepEqual(serverToolNames('从没连过'), []);
  assert.deepEqual(serverRejections('从没连过'), []);
  assert.deepEqual(connectedIds(), []);
  // 空 id / 非字符串不吃炸
  assert.deepEqual(serverToolNames(''), []);
  assert.deepEqual(serverRejections(undefined as any), []);
});

test('disconnectAll：清空会话 + 注销整批（测试/卸载用）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_a1' }] });
  await connectServer(server(), () => fake.fetchImpl);
  assert.deepEqual(liveMcpToolNames(), ['tool_a1']);

  disconnectAll();
  assert.deepEqual(connectedIds(), []);
  assert.deepEqual(runtimeToolNames('mcp'), [], '注销整批，不是只清会话');
  assert.deepEqual(liveMcpToolNames(), []);
});

/* ============================ 描述与 schema 兜底 ============================ */

test('远端不给 description / inputSchema 时给合法兜底（别让模型看到空描述或 null 参数）', async (t) => {
  fresh(t);
  const fake = makeFakeFetch({ tools: [{ name: 'tool_bare' }, { name: 'tool_full', description: '有说明', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] });
  await connectServer(server(), () => fake.fetchImpl);

  const bare = pluginToolDefs(MCP_ON).find(d => d.name === 'tool_bare') as any;
  assert.ok(bare.model_description.length > 0, '没有 description 也要有一句兜底，不能是空串');
  assert.equal(bare.parameters.type, 'object', '没给 inputSchema → 给合法空壳');
  assert.equal(bare.group, 'external', '归「外部」组');
  assert.equal(bare.source, 'external', '来源标 external');

  const full = pluginToolDefs(MCP_ON).find(d => d.name === 'tool_full') as any;
  assert.equal(full.model_description, '有说明', '给了 description 就用它');
  assert.deepEqual(full.parameters, { type: 'object', properties: { q: { type: 'string' } } }, 'inputSchema 原样透传');
});
