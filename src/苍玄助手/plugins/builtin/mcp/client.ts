/**
 * 苍玄助手 · MCP 客户端（client）
 *
 * 把 `protocol.ts` 的报文层包成**一个有状态的 MCP 客户端**：负责 initialize 握手、
 * 记住会话 id、翻页拉工具表、调工具，并把一切失败翻成人话（McpError）。
 *
 * ⚠️ **纯的一层，零宿主依赖**：
 *   - 不 import store、不 import core/host、**绝不裸读 globalThis.fetch**；
 *   - `fetchImpl` 由调用方注入（在插件装配层，能力名 'fetch' 从宿主链上取）；
 *   - 所以整层能被假 fetch 完全驱动（真机与单测走的是同一条代码路径）。
 *
 * ────────────────────── 冻结接口（task-38，消费者：native-adapter 的 connection.ts）──────────────────────
 *   createMcpClient({ url, headers?, fetchImpl, timeoutMs? })
 *     → { initialize(), listTools(), callTool(name, args), close() }
 *   McpError extends Error { code, detail, hint }
 *   McpToolInfo { name, description?, inputSchema }
 *   callTool → { text, isError, raw }
 * 这份签名**不许改**；要改先找 Lead（接口由两个消费者共用）。
 */
import {
  MCP_ERROR_CODES,
  McpError,
  createIdGenerator,
  errorAborted,
  errorConfig,
  errorFromNetwork,
  errorFromRpc,
  errorFromStatus,
  errorTimeout,
  isAbortLike,
  makeNotification,
  makeRequest,
  parseResponseText,
  safeStringify,
  type JsonRpcResponse,
} from './protocol.ts';

/**
 * 把**冻结的公开名字**从 client.ts 一并导出。
 *
 * 为什么：题面把 `McpError` / `McpToolInfo` / `createMcpClient` 列成同一组
 * 「client 的公开接口」，消费者（native-adapter 的 connection.ts）自然会
 * `import { createMcpClient, McpError } from './client.ts'`。错误类型定义在
 * protocol.ts（它才是报文层），所以这里**再导出**一次，让消费者只认一个入口，
 * 不必知道我们内部怎么分层。这是「对外收口」，没有改任何签名。
 */
export { McpError, MCP_ERROR_CODES } from './protocol.ts';
export type { McpErrorCode } from './protocol.ts';

/* ============================ 类型（冻结） ============================ */

export interface McpClientOptions {
  url: string;
  /** 额外请求头（鉴权等）；由调用方给，客户端自己不猜 */
  headers?: Record<string, string>;
  /** **注入**的 fetch —— 这一层绝不自己去摸全局（这样单测能塞假实现） */
  fetchImpl: typeof fetch;
  /** 单次请求超时（毫秒），缺省 15000 */
  timeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  initialize(): Promise<{ serverName: string; serverVersion: string; protocolVersion: string }>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; raw: unknown }>;
  close(): void;
}

/* ============================ 常量 ============================ */

/** 单次请求缺省超时：15 秒。MCP 的 initialize / tools 调用都该在这个量级内回来 */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 翻页上限（防死循环）。
 *
 * 为什么必须有：`tools/list` 由服务端给 nextCursor，**服务端如果一直回同一个 cursor**，
 * 朴素实现会永远拉下去 —— 卡死界面、打爆网络。50 页 × 每页常见 20~100 个工具
 * 已经远超任何真实服务器，撞到上限说明服务端坏了，该报错而不是继续。
 */
const MAX_TOOL_PAGES = 50;

/** 我们声明支持的 MCP 协议版本 */
const PROTOCOL_VERSION = '2025-06-18';

/** 会话 id 的响应头名（MCP Streamable HTTP 规定就是它） */
const SESSION_HEADER = 'Mcp-Session-Id';

/* ============================ 客户端 ============================ */

/**
 * 建一个 MCP 客户端。
 *
 * 无状态的一层之上只保留三样「会话内事实」：`sessionId`（服务端给的）、
 * `closed`（close 之后不再发请求）、`nextId`（请求号）。
 * 除这三样之外什么都不缓存 —— 工具表每次 listTools 重新拉，
 * 免得用户改了服务端却看到一份陈旧的清单。
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const url = typeof options?.url === 'string' ? options.url.trim() : '';
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  const fetchImpl = options?.fetchImpl;
  const timeoutMs =
    typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  /** 服务端在 initialize 响应头里给的会话 id；给了后续请求都要带回 */
  let sessionId = '';
  /** close 之后一切请求直接拒（幂等关闭，不是错误） */
  let closed = false;
  const nextId = createIdGenerator('mcp');

  /* ---------------------------- 内部：配置校验 ---------------------------- */

  function ensureUsable(method: string): void {
    if (closed) {
      throw new McpError(
        MCP_ERROR_CODES.ABORTED,
        '这个连接已经关闭了，不能再' + method,
        '重新连接这个服务器即可',
      );
    }
    if (!url) {
      throw errorConfig('这个 MCP 服务器没有填 URL', '在服务器设置里填上它的地址（多数是 /mcp 或 /sse）');
    }
    if (typeof fetchImpl !== 'function') {
      throw errorConfig(
        '没有可用的 fetch —— 当前环境取不到网络能力',
        '这是宿主环境的问题（浏览器不支持或已被禁用），换个环境或在宿主里放开 fetch',
      );
    }
  }

  /* ---------------------------- 内部：HTTP 往返 ---------------------------- */

  /**
   * 发一条 JSON-RPC 报文，拿回解析后的响应。
   *
   * 这里收口**全部**失败路径，保证「抛出去的一定是 McpError」：
   *   ① 配置不对 / 已关闭   → 直接 McpError
   *   ② fetch 抛异常        → 区分「超时」与「网络层」两种，各自人话
   *   ③ HTTP 非 2xx         → 按状态码翻（401/403、404、5xx…）
   *   ④ 响应体坏            → JSON / 形状问题（protocol.parseResponseText 负责）
   *   ⑤ JSON-RPC error 对象 → 按协议错误码翻
   */
  async function send(method: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // MCP Streamable HTTP 要求客户端声明接受这两种（服务端可能回 JSON 或 SSE 流）
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      // ⚠️ 这一句是整条链上最要紧的分支：raw `TypeError: Failed to fetch` 绝不能漏出去
      if (timedOut) throw errorTimeout(url, timeoutMs, method);
      if (isAbortLike(error)) throw errorAborted(method);
      throw errorFromNetwork(error, url, method);
    }

    // 服务端可能在任何响应里**首次**下发会话 id（实测常见于 initialize）
    const gotSession = readSessionHeader(response);

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      clearTimeout(timer);
      throw new McpError(
        MCP_ERROR_CODES.NETWORK,
        '读取 ' + method + ' 的响应体时失败：' + (error instanceof Error ? error.message : String(error)),
        '连接在传输中被中断了；重试一次，若持续发生要查网络或服务端',
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      // 404 带过 session = 会话过期（见 protocol.errorFromStatus）；这里把「之前有没有 session」告诉它
      const hadSession = sessionId !== '';
      const failure = errorFromStatus(response.status, text, hadSession, method);
      // 会话过期时把本地 session 清掉，下一次重连就不会继续带着坏 id
      if (failure.code === MCP_ERROR_CODES.SESSION_EXPIRED) sessionId = '';
      throw failure;
    }

    // 成功响应：先把服务端给的会话 id 记下来（initialize 就靠这一步）
    if (gotSession) sessionId = gotSession;

    const parsed: JsonRpcResponse = parseResponseText(text, response.status);
    if ('error' in parsed) throw errorFromRpc(parsed.error, method);
    return parsed.result;
  }

  /** 读 Mcp-Session-Id 响应头（拿不到就返回空串，不抛） */
  function readSessionHeader(response: Response): string {
    try {
      const value = response.headers?.get?.(SESSION_HEADER);
      return typeof value === 'string' ? value.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * 发一条**通知**（无 id，不等回复）。
   *
   * 口径（题面第 1 条）：`notifications/initialized` 失败**不算错** ——
   * 它只是告诉服务端「我准备好了」，服务端没回执也不影响后续 tools 调用。
   * 但失败要**记下来**（warn），不能静默：真机上排查「服务端行为怪」时，
   * 「这条通知到底发出去没有」是第一手线索。
   */
  async function sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    try {
      await send(method, makeNotification(method, params));
    } catch (error) {
      const why = error instanceof McpError ? error.toUserMessage() : safeStringify(error);
      console.warn('[苍玄界] MCP 通知 ' + method + ' 发送失败（不影响后续调用）：' + why);
    }
  }

  /* ---------------------------- 公开：initialize ---------------------------- */

  /**
   * MCP 握手：`initialize` → `notifications/initialized`。
   *
   * 返回服务端自报的名字 / 版本 / 协议版本（界面用来显示「连上了谁」）。
   * 协议版本不匹配**只 warn 不拦**：MCP 的版本协商本来就是宽松的，
   * 而且我们只用到 tools 那几个方法 —— 因为版本号对不上就拒绝连接，
   * 会让「服务端升了个小版本」变成用户那边突然不可用，那是更糟的失败。
   */
  async function initialize(): Promise<{ serverName: string; serverVersion: string; protocolVersion: string }> {
    ensureUsable('初始化连接');

    const result = await send('initialize', makeRequest(nextId(), 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // 我们只用工具；声明出来让服务端知道别推别的
      capabilities: { tools: {} },
      clientInfo: { name: '苍玄界', version: '0.1' },
    }));

    const info = isRecord(result) ? result : {};
    const serverInfo = isRecord(info.serverInfo) ? info.serverInfo : {};
    const serverVersion = typeof serverInfo.version === 'string' ? serverInfo.version : '';
    const negotiated = typeof info.protocolVersion === 'string' ? info.protocolVersion : '';

    if (negotiated && negotiated !== PROTOCOL_VERSION) {
      console.warn(
        '[苍玄界] MCP 协议版本不一致：服务端 ' + negotiated + '，客户端 ' + PROTOCOL_VERSION +
          '（继续按现有版本调用工具；若工具调用异常，先怀疑这里）',
      );
    }

    // 握手第二步：告诉服务端「这些通知收完了，我开始干活」。
    // 失败了也不算错（见 sendNotification），但真机上这一步缺了有些服务端会拒后续请求，所以要发。
    await sendNotification('notifications/initialized');

    return {
      serverName: typeof serverInfo.name === 'string' ? serverInfo.name : '',
      serverVersion,
      protocolVersion: negotiated,
    };
  }

  /* ---------------------------- 公开：listTools ---------------------------- */

  /**
   * 拉全部远端工具，**自动按 nextCursor 翻页**。
   *
   * 两层防线：
   *   ① `MAX_TOOL_PAGES` 硬上限 —— 服务端反复回同一个 cursor 时不会死循环；
   *   ② cursor 与上一页相同**立刻**判错 —— 上限定在 50 页是为了兜底，
   *      真正能识别「原地打转」的是这一条，它让坏服务端在第一页就被抓出来，
   *      而不是白拉 50 页再报一个含糊的超限错误。
   * 另外按名字去重：服务端翻页时重叠返回不该让同一个工具出现两次
   * （上层包装成 ToolDef 时会因重名被拒，那会变成用户看不懂的「工具不见了」）。
   */
  async function listTools(): Promise<McpToolInfo[]> {
    ensureUsable('读取工具列表');

    const out: McpToolInfo[] = [];
    const seen = new Set<string>();
    let cursor = '';
    let pages = 0;

    for (;;) {
      if (pages >= MAX_TOOL_PAGES) {
        throw new McpError(
          MCP_ERROR_CODES.BAD_RESPONSE,
          '这个服务器的工具列表翻了 ' + MAX_TOOL_PAGES + ' 页还没结束（疑似游标不前进）',
          '服务端的 tools/list 游标实现有问题；先确认它是不是标准 MCP 服务',
        );
      }

      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const result = await send('tools/list', makeRequest(nextId(), 'tools/list', params));
      pages += 1;

      const page = isRecord(result) ? result : {};
      const list = Array.isArray(page.tools) ? page.tools : [];
      for (const item of list) {
        const tool = normalizeTool(item);
        if (!tool) continue;
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        out.push(tool);
      }

      const next = typeof page.nextCursor === 'string' ? page.nextCursor.trim() : '';
      if (!next) break;
      if (next === cursor) {
        // 原地打转：再拉一次还是同一页 —— 直接判错，别把「坏服务端」拖成 50 页
        throw new McpError(
          MCP_ERROR_CODES.BAD_RESPONSE,
          '这个服务器的工具列表游标没有前进（一直返回同一个 nextCursor：' + next + '）',
          '服务端的 tools/list 实现有问题，它会让我们无限翻页；先确认它是不是标准 MCP 服务',
        );
      }
      cursor = next;
    }

    return out;
  }

  /** 归一化一个远端工具描述（名字不合法就丢掉 —— 没名字的工具进不了工具表） */
  function normalizeTool(item: unknown): McpToolInfo | null {
    if (!isRecord(item)) return null;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) return null;
    const description = typeof item.description === 'string' ? item.description : '';
    // inputSchema 缺省给一个「接受任意对象」的空 schema：
    // 有些服务端不提供 schema，若这里给 undefined，上层包装 ToolDef 时会是 null，
    // 模型侧看到 null 参数会不敢调 —— 空对象至少语义是「自由参数」。
    const inputSchema =
      isRecord(item.inputSchema) && Object.keys(item.inputSchema).length > 0
        ? item.inputSchema
        : { type: 'object', properties: {} };
    const info: McpToolInfo = { name, inputSchema };
    if (description) info.description = description;
    return info;
  }

  /* ---------------------------- 公开：callTool ---------------------------- */

  /**
   * 调一个远端工具。
   *
   * 返回形状（冻结）：`{ text, isError, raw }`
   *   - `text`   ：把 content[] 拼成一段人话文本（给模型 / 界面直接用）
   *   - `isError`：**服务端自己说的**「这次调用业务上失败了」（MCP 的 tool result 带的标记），
   *                 与「请求本身失败（抛 McpError）」是两回事 —— 前者是工具执行结果，
   *                 后者是连接/协议故障。上层要能区分，所以不合并成一种。
   *   - `raw`    ：原始 result，给界面展开细节 / 将来支持结构化内容用。
   */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; raw: unknown }> {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!toolName) {
      throw errorConfig('要调用的工具没有名字', '这是内部错误：调用方应传远端工具名');
    }
    ensureUsable('调用工具 ' + toolName);

    const params = { name: toolName, arguments: isRecord(args) ? args : {} };
    const result = await send('tools/call', makeRequest(nextId(), 'tools/call', params));

    const bag = isRecord(result) ? result : {};
    const content = Array.isArray(bag.content) ? bag.content : [];
    return {
      text: renderContent(content),
      // MCP 的 tool result 用 isError 表示「工具执行失败」，原样透出，不在这里翻成异常
      isError: bag.isError === true,
      raw: result,
    };
  }

  /**
   * 把 MCP 的 `content[]` 拼成一段文本。
   *
   * 口径：text 取正文；**其它类型（image / resource / audio…）给一句占位说明**，
   * 而不是丢掉 —— 丢掉会让模型以为「工具什么都没返回」，进而编造结果；
   * 说清「这里有一张图但没法给你看」才是诚实的。
   * 空数组时返回空串（由上层决定怎么表述「成功但没内容」）。
   */
  function renderContent(content: unknown[]): string {
    const parts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) {
        const plain = safeStringify(item, 200);
        if (plain) parts.push(plain);
        continue;
      }
      const type = typeof item.type === 'string' ? item.type : '';
      if (type === 'text') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) parts.push(text);
        continue;
      }
      if (type === 'image') {
        // 写成「一张图片（image/png）」而不是「一张image/png」：前者是人话，后者是把字段名贴进了句子
        const mime = typeof item.mimeType === 'string' && item.mimeType ? '（' + item.mimeType + '）' : '';
        parts.push('（工具返回了一张图片' + mime + '，当前通道只能传文本，这里看不到内容）');
        continue;
      }
      if (type === 'resource') {
        const uri = isRecord(item.resource) && typeof item.resource.uri === 'string' ? item.resource.uri : '';
        parts.push('（工具返回了一个资源' + (uri ? '：' + uri : '') + '，当前通道只能传文本）');
        continue;
      }
      if (type === 'audio') {
        parts.push('（工具返回了一段音频，当前通道只能传文本）');
        continue;
      }
      // 未知类型也别吞：宁可显示一段结构化摘要，也不要让模型以为「什么都没发生」
      const summary = safeStringify(item, 200);
      if (summary) parts.push('（工具返回了 ' + (type || '未知类型') + ' 内容：' + summary + '）');
    }
    return parts.join('\n');
  }

  /* ---------------------------- 公开：close ---------------------------- */

  /**
   * 关闭连接（**幂等**）。
   *
   * 这一层是 HTTP 无状态请求，没有长连接要断；close 的语义是
   * 「这个客户端实例作废」——之后任何调用都直接拒（ABORTED），
   * 免得用户点了断开、后台还有个 in-flight 请求把工具又注册回来。
   * 重复调用不报错（题面第 6 条）。
   */
  function close(): void {
    closed = true;
    sessionId = '';
  }

  return { initialize, listTools, callTool, close };
}

/* ============================ 小工具 ============================ */

/** 纯对象判断（排除数组与 null） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
