#!/usr/bin/env node
/**
 * 假 MCP 服务器（开发 / 真机验收用，**不是产品代码**）。
 *
 * 为什么需要它：MCP 插件的真机验收必须有一个**真的会说话的** HTTP MCP server ——
 * 用 mock fetch 只能证明解析对，证明不了「浏览器真的能连上、CORS 真的放行、
 * initialize → tools/list → tools/call 三段真的走通」。
 *
 * 它实现了 MCP 里本插件用到的**最小子集**（JSON-RPC 2.0 over HTTP）：
 *   initialize · notifications/initialized · tools/list（带 cursor 翻页演示）· tools/call
 * 并带上**放行 CORS** 的响应头（跨源验收必需；生产里的 CORS 被挡是插件要给人话提示的场景）。
 *
 * 用法：
 *   node dev_mcp_server.mjs            # 默认 8791
 *   PORT=8899 node dev_mcp_server.mjs
 * 然后在苍玄助手的 MCP 页里填 http://127.0.0.1:8791/
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8791);

/** 两个工具：一个只读探针、一个回显。名字刻意带前缀，方便在工具表里一眼认出 */
const TOOLS = [
  {
    name: 'cx_ping',
    description: '假 MCP 的探针工具：不带参数时回一句 pong，用来验证 tools/call 通。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cx_echo',
    description: '假 MCP 的回显工具：把 msg 原样回给你，用来验证参数真的传到了远端。',
    inputSchema: {
      type: 'object',
      properties: { msg: { type: 'string', description: '要回显的文本' } },
      required: ['msg'],
    },
  },
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '600',
  };
}

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(),
    ...extra,
  });
  res.end(payload);
}

/**
 * 处理一条 JSON-RPC 消息。
 *
 * @param mode 失败模式（见 MODES）。这里只处理**在 JSON-RPC 层生效**的那几种；
 *             HTTP 层 / 非 JSON / 卡住 在 applyFailureMode 里就短路掉了。
 *             这样分工的理由：初期的模式只在「已经通了、要坏在语义上」时才有意义
 *             （比如「initialize 正常但 tools/list 报错」—— 那正是验半截失败清理的场景）。
 */
/** flaky-session 模式用来把「该回 404」这个信号传回调用方（handle 只负责决定，不负责写响应） */
let send404 = false;

function handle(message, mode = 'ok') {
  const method = message?.method;
  const id = message?.id;

  // initialize **正常**，坏在后面 —— 专门用来验「半截失败要清理干净」：
  // 服务器连上了、工具没拿到，此时插件必须**不留半截会话**（否则模型会调到没 client 的工具）。
  if (mode === 'no-tools' && method === 'tools/list') {
    console.log('[fake-mcp] 按 ?mode=no-tools 返回空工具表');
    return { body: { jsonrpc: '2.0', id, result: { tools: [] } } };
  }
  if (mode === 'tools-error' && method === 'tools/list') {
    console.log('[fake-mcp] 按 ?mode=tools-error 让 tools/list 报 JSON-RPC error');
    return { body: { jsonrpc: '2.0', id, error: { code: -32603, message: '服务器说：列工具的时候我炸了' } } };
  }
  // 会话过期：initialize 之外的请求一律 404 —— 验 errorFromStatus 的 hadSession 分支
  if (mode === 'flaky-session' && method !== 'initialize' && method !== 'notifications/initialized') {
    console.log('[fake-mcp] 按 ?mode=flaky-session 对 ' + method + ' 返回 404（会话过期）');
    send404 = true;
    return { body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Session not found' } } };
  }

  // 通知（没有 id）：按 JSON-RPC 不该回 body
  if (id === undefined || id === null) return { notification: true };

  if (method === 'initialize') {
    return {
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: message?.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cx-fake-mcp', version: '0.1' },
        },
      },
      session: randomUUID(),
    };
  }

  if (method === 'tools/list') {
    // 演示翻页：?cursor 为空返回前 1 个 + nextCursor，带 cursor 返回剩下的
    const cursor = message?.params?.cursor;
    if (!cursor) {
      return {
        body: {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS.slice(0, 1), nextCursor: 'page-2' },
        },
      };
    }
    return { body: { jsonrpc: '2.0', id, result: { tools: TOOLS.slice(1) } } };
  }

  if (method === 'tools/call') {
    const name = message?.params?.name;
    const args = message?.params?.arguments ?? {};
    if (name === 'cx_ping') {
      return { body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }], isError: false } } };
    }
    if (name === 'cx_echo') {
      return {
        body: {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'echo: ' + String(args.msg ?? '') }], isError: false },
        },
      };
    }
    return { body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '没有这个工具：' + name }], isError: true } } };
  }

  return { body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + String(method) } } };
}


/*
 * ─────────────────────────── 失败模式变体（真机验收用）───────────────────────────
 *
 * 为什么要它：MCP 连接失败时，界面上必须显示**人话**（「鉴权失败」而不是 401、
 * 「服务端出错」而不是 Internal Server Error）。而正常的那台假服务器**永远连得上**，
 * 验不了这条。所以用 `?mode=` 让它按需装死。
 *
 * ⚠️ 这一层是**纯粹为了验收**的：它把真实世界里最难复现的几种坏情况做成一开关，
 *   （真实环境里你没法让服务器随时返回 401 / 半截 JSON / 卡住不答）
 *   而不是为了在 dev 里造一堆分支。所以每种模式只做**最少够用**的那一下。
 *
 * 用法：在 MCP 页里把地址填成 `http://127.0.0.1:8791/?mode=401` 之类。
 * 不带 mode（或 mode=ok）= 原来的正常服务器。
 */
const MODES = {
  ok: '正常：能连上、能列工具、能调用（默认）',
  401: '鉴权失败：所有 POST 返回 401 —— 验「鉴权」那句人话',
  403: '无权限：所有 POST 返回 403 —— 与 401 同类但分开，方便看文案区分',
  500: '服务端出错：所有 POST 返回 500 —— 验「服务端的问题，不是配置错」',
  404: '地址不对：所有 POST 返回 404 —— 验「地址可能填错」',
  'bad-json': '响应不是 JSON（半截 HTML / 纯文本）—— 验「解析失败」那句人话',
  'rpc-error': 'HTTP 200 但 body 是 JSON-RPC error（不是 HTTP 错误）—— 验另一条翻法',
  slow: '卡住不答（默认 20 秒）—— 验超时。可用 ?mode=slow&ms=3000 调短',
  'no-tools': '连得上但 tools/list 返回空 —— 验「连上了但一个工具都没有」的界面',
  'tools-error': 'initialize 正常、tools/list 报 JSON-RPC error —— 验半截失败的清理',
  'flaky-session': '第一次 404（会话过期）→ 验「会话过期」那句人话',
};

/** 从 query 里取 mode（缺省 ok） */
function modeOf(url) {
  const q = new URL(url, 'http://127.0.0.1').searchParams;
  return (q.get('mode') || 'ok').toLowerCase();
}

/** 卡住不答的毫秒数（仅 slow 用；缺省 20 秒，够触发插件的 15 秒超时） */
function slowMsOf(url) {
  const q = new URL(url, 'http://127.0.0.1').searchParams;
  const n = Number(q.get('ms'));
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/**
 * 按模式短路。返回 true 表示「已经处理完了」，调用方直接 return。
 *
 * 特意把「HTTP 层失败」和「JSON-RPC 层失败」分开：
 * 它们在插件里走**两条不同的翻法**（errorFromStatus vs errorFromRpc），
 * 只测一条会漏掉另一条。
 */
function applyFailureMode(req, res, mode, raw) {
  if (mode === 'ok') return false;

  if (mode === '401' || mode === '403' || mode === '500' || mode === '404') {
    console.log('[fake-mcp] 按 ?mode=' + mode + ' 故意返回 ' + mode);
    send(res, Number(mode), { error: '这是 ?mode=' + mode + ' 故意造的失败（真机验收用）' });
    return true;
  }

  if (mode === 'bad-json') {
    console.log('[fake-mcp] 按 ?mode=bad-json 返回非 JSON');
    // 症状：真实世界里常见于「地址填成了网页而不是 MCP 端点」
    const html = '<!DOCTYPE html><html><body>Hi, this is a normal web page, not an MCP endpoint.</body></html>';
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(html),
      ...corsHeaders(),
    });
    res.end(html);
    return true;
  }

  if (mode === 'rpc-error') {
    console.log('[fake-mcp] 按 ?mode=rpc-error 返回 JSON-RPC error');
    let id = null;
    try {
      id = JSON.parse(raw)?.id ?? null;
    } catch {
      // 坏 JSON 也照样回一个 rpc error；id 用 null 即可
    }
    send(res, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: '服务器说：这个能力我没实现' } });
    return true;
  }

  if (mode === 'slow') {
    const ms = slowMsOf(req.url);
    console.log('[fake-mcp] 按 ?mode=slow 卡住 ' + ms + 'ms 不答');
    // 不 res.end —— 让客户端的 AbortController 先超时。故意不清理定时器：
    // 这是假服务器，进程退出就没了；而「迟到的响应」正是超时场景的真实形态。
    setTimeout(() => {
      try {
        send(res, 200, { jsonrpc: '2.0', id: null, result: {} });
      } catch {
        // 连接可能已经被客户端掐了，忽略
      }
    }, ms);
    return true;
  }

  return false; // 其余模式（no-tools / tools-error / flaky-session）在 handle 里处理
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === 'GET') {
    // /modes：列出所有失败模式 + 可直接复制的地址（真机验收时不用翻脚本）
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/modes') {
      const base = 'http://127.0.0.1:' + PORT + '/';
      send(res, 200, {
        base,
        modes: Object.entries(MODES).map(([mode, desc]) => ({
          mode,
          desc,
          url: mode === 'ok' ? base : base + '?mode=' + mode,
        })),
      });
      return;
    }
    // 健康检查 / 真机里手动打开看服务在不在（带上当前模式，方便确认地址填对没）
    send(res, 200, {
      ok: true,
      server: 'cx-fake-mcp',
      mode: modeOf(req.url),
      tools: TOOLS.map(tool => tool.name),
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: '只收 POST' });
    return;
  }

  const mode = modeOf(req.url);

  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    // 失败模式短路：HTTP 层 / 非 JSON / 卡住，都在解析之前处理
    if (applyFailureMode(req, res, mode, raw)) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '坏 JSON：' + error.message } });
      return;
    }
    send404 = false;
    const { body, session, notification } = handle(message, mode);
    if (send404) {
      // 会话过期：真 ST 里这是 404 + Mcp-Session-Id 已失效 → 插件该报「会话过期」
      send(res, 404, body);
      return;
    }
    console.log(
      '[fake-mcp]',
      message.method ?? '(no method)',
      mode === 'ok' ? '' : '(mode=' + mode + ')',
      '->',
      notification ? '204 (notification)' : '200',
    );
    if (notification) {
      res.writeHead(202, { ...corsHeaders(), 'Content-Length': '0' });
      res.end();
      return;
    }
    send(res, 200, body, session ? { 'Mcp-Session-Id': session } : {});
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[fake-mcp] listening on http://127.0.0.1:' + PORT + '/');
});