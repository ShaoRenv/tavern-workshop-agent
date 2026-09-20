/**
 * 验收补充：agent/transport.ts —— 双通道选择、自动降级边界、文本协议抠取、原生请求体转写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const agent = '../../src/苍玄助手/agent/';
const {
  createTransport,
  HttpError,
  ToolsUnsupportedError,
  isToolsUnsupportedError,
  resolveEndpoint,
  plannedRoute,
  parseNativeReply,
  parseToolArguments,
  contentToText,
  toNativeTool,
  toNativeMessage,
  renderToolProtocol,
  buildTextPrompts,
  extractSystemQueries,
  collectImages,
  isAbortError,
  abortError,
  SYSTEM_QUERY_TAG,
} = await import(agent + 'transport.ts');

function settings(over = {}) {
  return { route: 'custom', url: 'https://api.test/v1', key: 'sk-1', model: 'm', stream: false, send_images: false, timeout_sec: 30, ...over };
}

function responseOf(body, over = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => body,
    ...over,
  };
}

function tools() {
  return [{ name: 'wb_read', description: '读条目', parameters: { type: 'object', properties: { uid: { type: 'string' } } } }];
}

/* ============================ 双通道选择 / 降级 ============================ */

test('transport: 走酒馆路线永远 text；plannedRoute 只看设置和已知能力', async () => {
  let fetched = 0;
  let generated = 0;
  const transport = createTransport({
    fetchImpl: async () => {
      fetched++;
      return responseOf({});
    },
    generateRawImpl: async () => {
      generated++;
      return '文本回复';
    },
  });
  const reply = await transport.chat({ messages: [{ role: 'user', content: 'x' }], settings: settings({ route: 'tavern' }) });
  assert.equal(reply.via, 'text');
  assert.equal(reply.text, '文本回复');
  assert.equal(fetched, 0);
  assert.equal(generated, 1);
  assert.equal(transport.supportsTools(), 'unknown', '没试过 native 就不知道');
  assert.equal(transport.lastVia(), 'text');

  assert.equal(plannedRoute(settings(), 'unknown'), 'native');
  assert.equal(plannedRoute(settings(), 'yes'), 'native');
  assert.equal(plannedRoute(settings(), 'no'), 'text');
  assert.equal(plannedRoute(settings({ route: 'tavern' }), 'yes'), 'text');
});

test('transport: native 成功 → supportsTools=yes，走 native 不再 fetch', async () => {
  let fetched = 0;
  const transport = createTransport({
    fetchImpl: async (url, init) => {
      fetched++;
      assert.match(url, /\/chat\/completions$/);
      assert.equal(init.method, 'POST');
      return responseOf({ choices: [{ message: { content: '好了', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'wb_read', arguments: '{}' } }] } }] });
    },
  });
  const reply = await transport.chat({ messages: [{ role: 'user', content: 'x' }], tools: tools(), settings: settings() });
  assert.equal(reply.via, 'native');
  assert.equal(transport.supportsTools(), 'yes');
  assert.equal(transport.lastVia(), 'native');
  assert.equal(fetched, 1);
});

test('transport: 没填接口地址 / 没填模型名 / 环境没 fetch → 自动降级 text（各记一次提醒）', async () => {
  const cases = [
    { over: { url: '' }, label: '没填 url' },
    { over: { model: '' }, label: '没填 model' },
  ];
  for (const item of cases) {
    let fetched = 0;
    const notices = [];
    const transport = createTransport({
      fetchImpl: async () => {
        fetched++;
        return responseOf({});
      },
      generateRawImpl: async () => '降级回复',
      onNotice: notice => notices.push(notice),
    });
    const reply = await transport.chat({ messages: [{ role: 'user', content: 'x' }], tools: tools(), settings: settings(item.over) });
    assert.equal(reply.via, 'text', item.label);
    assert.equal(fetched, 0, item.label);
    assert.equal(transport.supportsTools(), 'no', item.label);
    assert.equal(notices.length, 1, item.label);
    assert.equal(notices[0].level, 'warn');
    assert.match(notices[0].message, /不支持原生 tools/);
  }

  const previousFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const transport = createTransport({ generateRawImpl: async () => '没有 fetch 也能跑' });
    const reply = await transport.chat({ messages: [{ role: 'user', content: 'x' }], tools: tools(), settings: settings() });
    assert.equal(reply.via, 'text');
    assert.equal(reply.text, '没有 fetch 也能跑');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('transport: 降级判定只看 400/404/405/415/422/501 + 明确提到 tool；其他错误原样抛', async () => {
  const cases = [
    { status: 400, body: '{"error":{"message":"tools is not supported"}}', degrade: true },
    { status: 422, body: 'function call not supported', degrade: true },
    { status: 400, body: '{"error":{"message":"invalid api key"}}', degrade: false },
    { status: 500, body: 'tools are broken', degrade: false },
    { status: 401, body: 'unsupported tools', degrade: false },
    { status: 404, body: 'model not found', degrade: false },
  ];
  for (const item of cases) {
    let generated = 0;
    const transport = createTransport({
      fetchImpl: async () => ({
        ok: false,
        status: item.status,
        statusText: 'x',
        text: async () => item.body,
        json: async () => ({}),
      }),
      generateRawImpl: async () => {
        generated++;
        return '文本';
      },
    });
    const promise = transport.chat({ messages: [{ role: 'user', content: 'x' }], tools: tools(), settings: settings() });
    if (item.degrade) {
      const reply = await promise;
      assert.equal(reply.via, 'text', item.status + ' ' + item.body);
      assert.equal(generated, 1);
      assert.equal(transport.supportsTools(), 'no');
    } else {
      await assert.rejects(promise, error => {
        assert.ok(error instanceof HttpError, '应该是 HttpError');
        assert.equal(error.status, item.status);
        return true;
      });
      assert.equal(generated, 0, '不许偷偷降级');
      assert.equal(transport.supportsTools(), 'unknown', '没降级就不该改能力标记');
    }
  }
  assert.equal(isToolsUnsupportedError(new ToolsUnsupportedError('x')), true);
  assert.equal(isToolsUnsupportedError(new HttpError(400, 'tool not supported')), true);
  assert.equal(isToolsUnsupportedError(new HttpError(400, 'bad request')), false);
  assert.equal(isToolsUnsupportedError(new Error('网络炸了')), false);
});

test('transport: markToolsUnsupported 幂等（只提醒一次），之后不再打 native 接口', async () => {
  let fetched = 0;
  const notices = [];
  const transport = createTransport({
    fetchImpl: async () => {
      fetched++;
      return responseOf({});
    },
    generateRawImpl: async () => '文本',
    onNotice: notice => notices.push(notice),
  });
  transport.markToolsUnsupported();
  transport.markToolsUnsupported();
  assert.equal(notices.length, 1);
  const reply = await transport.chat({ messages: [{ role: 'user', content: 'x' }], tools: tools(), settings: settings() });
  assert.equal(reply.via, 'text');
  assert.equal(fetched, 0);
});

test('transport: 中止的信号 → 抛 AbortError，不吞成降级', async () => {
  const controller = new AbortController();
  controller.abort();
  let generated = 0;
  const textTransport = createTransport({
    generateRawImpl: async () => {
      generated++;
      return '不该用到';
    },
  });
  await assert.rejects(
    textTransport.chat({ messages: [{ role: 'user', content: 'x' }], settings: settings({ route: 'tavern' }), signal: controller.signal }),
    error => {
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
  assert.equal(generated, 1, 'generateRaw 已经发出去了，回来发现中止');
  assert.equal(isAbortError(abortError()), true);
  assert.equal(isAbortError(new Error('普通错误')), false);
});

test('transport: native 400 不支持 tools 时降级，并把 tools 说明拼进文本提示词', async () => {
  let prompts = null;
  let config = null;
  const transport = createTransport({
    fetchImpl: async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'tools not supported', json: async () => ({}) }),
    generateRawImpl: async value => {
      config = value;
      prompts = value.ordered_prompts;
      return '先读一下。<SystemQuery>{"name":"wb_read","args":{"uid":"42"}}</SystemQuery>';
    },
  });
  const reply = await transport.chat({ messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '读 42' }], tools: tools(), settings: settings() });
  assert.equal(reply.via, 'text');
  assert.equal(reply.text, '先读一下。');
  assert.deepEqual(reply.tool_calls, [{ id: reply.tool_calls[0].id, name: 'wb_read', args: { uid: '42' } }]);
  assert.match(reply.tool_calls[0].id, /^call_/);
  assert.equal(config.should_silence, true);
  assert.match(String(config.generation_id), /^cx_/);
  assert.equal(prompts[0].role, 'system');
  assert.match(prompts[0].content, /可用工具/);
  assert.match(prompts[0].content, /wb_read/);
  assert.match(prompts[0].content, /JSON Schema/);
  assert.equal(config.custom_api.model, 'm');
  assert.equal(config.custom_api.source, 'openai');
});

test('transport: 文本通道没有 generateRaw 时明确报错；回复是对象时取 content', async () => {
  const transport = createTransport({});
  const previousGenerate = globalThis.generateRaw;
  delete globalThis.generateRaw;
  try {
    await assert.rejects(
      transport.chat({ messages: [{ role: 'user', content: 'x' }], settings: settings({ route: 'tavern' }) }),
      /文本通道不可用/,
    );
    const withObject = createTransport({ generateRawImpl: async () => ({ content: [{ type: 'text', text: '数组内容' }] }) });
    const reply = await withObject.chat({ messages: [{ role: 'user', content: 'x' }], settings: settings({ route: 'tavern' }) });
    assert.equal(reply.text, '数组内容');
    assert.deepEqual(reply.tool_calls, []);
  } finally {
    if (previousGenerate !== undefined) globalThis.generateRaw = previousGenerate;
  }
});

/* ============================ SystemQuery 抠取 ============================ */

test('transport: extractSystemQueries 抠标记、剥正文、认多种字段名', () => {
  const own = '<' + SYSTEM_QUERY_TAG + '>';
  const text = [
    '前文',
    own + '{"name":"wb_search","args":{"keyword":"甲"}}' + own.replace('<', '</'),
    '中段',
    own + '{"tool":"wb_read","arguments":"{\\"uid\\":\\"1\\"}"}' + own.replace('<', '</'),
    own + '{"name":"entry_edit","parameters":{"x":1}}' + own.replace('<', '</'),
    own + '{"name":"entry_create","uid":"9"}' + own.replace('<', '</'),
    '后文',
  ].join('\n');
  const result = extractSystemQueries(text);
  assert.equal(result.queries.length, 4);
  assert.deepEqual(result.queries.map(query => query.name), ['wb_search', 'wb_read', 'entry_edit', 'entry_create']);
  assert.deepEqual(result.queries[0].args, { keyword: '甲' });
  assert.deepEqual(result.queries[1].args, { uid: '1' }, 'arguments 字符串也要解');
  assert.deepEqual(result.queries[2].args, { x: 1 });
  assert.deepEqual(result.queries[3].args, { uid: '9' }, '没给 args 时把其余字段当 args');
  assert.match(result.text, /^前文\n{2}中段/);
  assert.match(result.text, /后文$/);
  assert.ok(!result.text.includes('SystemQuery'), '标记要从正文里剥干净');
});

test('transport: extractSystemQueries 对坏 JSON / 没名字 / 围栏代码块的处理', () => {
  const own = '<' + SYSTEM_QUERY_TAG + '>';
  const bad = extractSystemQueries(own + '{坏 JSON}' + own.replace('<', '</'));
  assert.deepEqual(bad.queries, []);
  assert.equal(bad.text, '', '坏标记也要从正文剥掉（不留给用户看）');

  const noName = extractSystemQueries(own + '{"args":{"a":1}}' + own.replace('<', '</'));
  assert.deepEqual(noName.queries, []);

  const fenced = extractSystemQueries(own + '\n\u0060\u0060\u0060json\n{"name":"submit","args":{}}\n\u0060\u0060\u0060\n' + own.replace('<', '</'));
  assert.deepEqual(fenced.queries.map(query => query.name), ['submit'], '围栏代码块要能剥');

  assert.deepEqual(extractSystemQueries('没有标记').queries, []);
  assert.equal(extractSystemQueries('没有标记').text, '没有标记');
});

test('transport: buildTextPrompts 把工具结果/助手调用都摊成纯文本', () => {
  const messages = [
    { role: 'system', content: '系统 A' },
    { role: 'system', content: '  ' },
    { role: 'user', content: '用户话' },
    { role: 'assistant', content: '我看看', tool_calls: [{ id: 'c1', name: 'wb_read', args: { uid: '1' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', name: 'wb_list', args: {} }] },
    { role: 'tool', tool_call_id: 'c1', content: '条目正文' },
    { role: 'tool', content: '' },
  ];
  const prompts = buildTextPrompts(messages, tools());
  assert.equal(prompts[0].role, 'system');
  assert.match(prompts[0].content, /系统 A/);
  assert.match(prompts[0].content, /可用工具/);
  assert.deepEqual(prompts.slice(1).map(prompt => prompt.role), ['user', 'assistant', 'assistant', 'user', 'user']);
  assert.match(prompts[2].content, /<SystemQuery>\{"name":"wb_read","args":\{"uid":"1"\}\}<\/SystemQuery>/);
  assert.equal(prompts[2].content.startsWith('我看看'), true);
  assert.equal(prompts[3].content.startsWith('<SystemQuery>'), true, '助手空正文时只留标记');
  assert.equal(prompts[4].content, '【工具结果 id=c1】\n条目正文');
  assert.equal(prompts[5].content, '【工具结果】\n(空)');
  assert.equal(renderToolProtocol([]), '');
  assert.match(renderToolProtocol(tools()), /^# 可用工具/);
});

/* ============================ 原生请求 / 回复 ============================ */

test('transport: resolveEndpoint / parseToolArguments / contentToText 边界', () => {
  assert.equal(resolveEndpoint('https://api.test/v1'), 'https://api.test/v1/chat/completions');
  assert.equal(resolveEndpoint('https://api.test/v1/'), 'https://api.test/v1/chat/completions');
  assert.equal(resolveEndpoint('https://api.test/v1/chat/completions'), 'https://api.test/v1/chat/completions');
  assert.equal(resolveEndpoint('  '), '');
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(parseToolArguments('[1]'), {}, '数组不是合法参数对象');
  assert.deepEqual(parseToolArguments('{半截'), {}, '半截 JSON 不炸');
  assert.deepEqual(parseToolArguments(''), {});
  assert.equal(contentToText('abc'), 'abc');
  assert.equal(contentToText([{ type: 'text', text: 'ab' }, 'cd', { content: 'ef' }, 3]), 'abcdef');
  assert.equal(contentToText(null), '');
});

test('transport: parseNativeReply 认内容分片、过滤没名字的调用、坏参不炸', () => {
  const reply = parseNativeReply({
    choices: [
      {
        message: {
          content: [{ type: 'text', text: '前半' }, { text: '后半' }],
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'wb_read', arguments: '{"uid":"1"}' } },
            { type: 'function', function: { name: '  ' } },
            { type: 'function', function: { name: 'wb_list', arguments: '{坏' } },
          ],
        },
      },
    ],
  });
  assert.equal(reply.via, 'native');
  assert.equal(reply.text, '前半后半');
  assert.deepEqual(reply.tool_calls.map(call => call.name), ['wb_read', 'wb_list']);
  assert.deepEqual(reply.tool_calls[0].args, { uid: '1' });
  assert.deepEqual(reply.tool_calls[1].args, {});
  assert.match(reply.tool_calls[0].id, /^c1$/);
  assert.match(reply.tool_calls[1].id, /^call_/, '没 id 就自己发一个');
  assert.deepEqual(parseNativeReply({}), { text: '', tool_calls: [], via: 'native' });
});

test('transport: toNativeTool / toNativeMessage 的转写（含多模态与工具调用）', () => {
  assert.deepEqual(toNativeTool({ name: 'x', description: 'd', parameters: null }), {
    type: 'function',
    function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } },
  });

  const plain = toNativeMessage({ role: 'user', content: 'hi', images: ['data:image/png;base64,AAA'] }, false);
  assert.deepEqual(plain, { role: 'user', content: 'hi' });

  const withImages = toNativeMessage({ role: 'user', content: '看图', images: ['data:image/png;base64,AAA', '', 'http://x/y.png'] }, true);
  assert.equal(Array.isArray(withImages.content), true);
  assert.deepEqual(withImages.content, [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'image_url', image_url: { url: 'http://x/y.png' } },
  ]);

  const tool = toNativeMessage({ role: 'tool', content: '结果', tool_call_id: 'c1', images: ['data:image/png;base64,AAA'] }, true);
  assert.deepEqual(tool, { role: 'tool', content: '结果', tool_call_id: 'c1' }, '工具消息不塞图');

  const assistant = toNativeMessage(
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'wb_read', args: { uid: '1' } }, { id: 'c2', name: 'n', args: {} }] },
    false,
  );
  assert.deepEqual(assistant.tool_calls[0], { id: 'c1', type: 'function', function: { name: 'wb_read', arguments: '{"uid":"1"}' } });
  assert.equal('tool_calls' in toNativeMessage({ role: 'assistant', content: 'x' }, false), false);
});

test('transport: collectImages 只收最后几条、最多 4 张、顺序保持', () => {
  const messages = [
    { role: 'user', content: 'a', images: ['i1', 'i2'] },
    { role: 'user', content: 'b', images: ['i3', 'i4', 'i5', 'i6'] },
  ];
  assert.deepEqual(collectImages(messages), ['i3', 'i4', 'i5', 'i6'], '默认最多 4 张，按原顺序');
  assert.deepEqual(collectImages(messages, 2), ['i5', 'i6']);
  assert.deepEqual(collectImages([]), []);
});
