/**
 * 苍玄助手 · MCP 协议层（protocol）
 *
 * 职责：把 **JSON-RPC 2.0 over HTTP** 这篇文章译清楚，只做「报文 ↔ 对象」的转换，
 * 外加**把一切失败翻成人话**这件事。它不知道 MCP 有哪些方法、不碰任何业务。
 *
 * 为什么单独一层（而不是全塞进 client.ts）：
 *   - 报文形状（id 怎么发 / result 与 error 二选一 / 错误码含义）是**纯逻辑**，
 *     可以脱离网络、脱离宿主被单测逐条盯住；
 *   - 上层 client.ts 于是只剩「MCP 的方法与状态」这件事，两层各自能看懂。
 *
 * ⚠️ 本文件**零宿主依赖**：不 import store、不 import core/host、**绝不裸读 globalThis.fetch**。
 *    fetch 由调用方注入（能力名 'fetch'），这样它能被假 fetch 完全驱动。
 */

/* ============================ JSON-RPC 2.0 报文形状 ============================ */

/** 请求 / 通知的 JSON-RPC 版本号（协议规定就是字面量 "2.0"） */
export const JSONRPC_VERSION = '2.0';

/** 一条 JSON-RPC 请求（有 id，等回复） */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * 一条 JSON-RPC 通知（**没有 id**，不等回复）。
 *
 * 这不是「省略了 id 的请求」，而是协议里另一种报文 —— 参见 MCP 的
 * `notifications/initialized`：服务端明确不许回复它，回了反而是错。
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 错误对象（服务端按协议回的，不是网络故障） */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  /** 可选的结构化补充（MCP 用它带「这个工具不存在」之类的细节） */
  data?: unknown;
}

/** 一条 JSON-RPC 成功响应 */
export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/** 一条 JSON-RPC 失败响应 */
export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

/** 响应可能是这两种之一（解析后先判是哪一种，再往上层抛／取） */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/* ============================ 错误：McpError ============================ */

/**
 * MCP 层唯一的错误类型。
 *
 * **不变量**：任何走到上层调用方的失败都必须是 McpError，**绝不放 raw TypeError 出去**。
 * 理由：`fetch` 失败抛的是 `TypeError: Failed to fetch`，它对用户毫无信息量
 * （分不清是 CORS、断网还是地址错），对这个底座来说等于「没有上下文的一句报错」——
 * 正是要从根上消灭的那种。所以每个失败点都必须在这里被翻译成人话。
 *
 * 三个字段各司其职，别只填一个：
 *   - `code`   ：给程序判断的稳定标识（见下方 MCP_ERROR_CODES）
 *   - `detail` ：**发生了什么**（铁的事实：状态码、原始 message、解析错误位置）
 *   - `hint`   ：**该怎么办**（下一步建议，人话）
 */
export class McpError extends Error {
  /** 稳定错误码，见 MCP_ERROR_CODES */
  readonly code: string;
  /** 发生了什么 —— 事实陈述，可含原始信息 */
  readonly detail: string;
  /** 该怎么办 —— 人话的下一步建议 */
  readonly hint: string;

  constructor(code: string, detail: string, hint: string) {
    // message 拼成「detail（hint）」：日志里一行就能读懂，不必再展开字段
    super(detail + (hint ? '（' + hint + '）' : ''));
    this.name = 'McpError';
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }

  /**
   * 拼一句给界面直接显示的话。
   *
   * 故意的重复格式：许多调用点只需要一个字符串（配置落盘 / 列表行文案），
   * 与其各写一遍模板，不如由错误自己给出**统一**说法。
   */
  toUserMessage(): string {
    return this.hint ? this.detail + '；' + this.hint : this.detail;
  }
}

/**
 * 全部错误码（**稳定标识**，界面 / 测试可以按它分支，不要按 message 分支）。
 *
 * 分类口径：先按「**谁的错**」分，再按具体原因细分 ——
 * 因为用户能采取的行动完全不同：改地址 / 改密钥 / 等一会儿 / 报告服务端。
 */
export const MCP_ERROR_CODES = {
  /** 网络层就没出去（断网 / 被 CORS 挡 / 证书）—— 用户改不了服务端，只能查环境 */
  NETWORK: 'MCP_NETWORK',
  /** 超时（自己掐的 AbortController）—— 建议加大 timeoutMs 或查服务端 */
  TIMEOUT: 'MCP_TIMEOUT',
  /** 主动取消（用户点了断开）—— 不是错，但也要有码 */
  ABORTED: 'MCP_ABORTED',
  /** 401 / 403：鉴权问题，改 headers */
  AUTH: 'MCP_AUTH',
  /** 404：地址不对，或会话过期（见 SESSION_EXPIRED） */
  NOT_FOUND: 'MCP_NOT_FOUND',
  /** 404 且当时带着 Mcp-Session-Id → 会话过期，重连即可 */
  SESSION_EXPIRED: 'MCP_SESSION_EXPIRED',
  /** 5xx：服务端坏了，不是我们的问题 */
  SERVER: 'MCP_SERVER',
  /** 4xx 其它：请求本身有问题 */
  BAD_REQUEST: 'MCP_BAD_REQUEST',
  /** 响应不是合法 JSON */
  BAD_JSON: 'MCP_BAD_JSON',
  /** 响应是 JSON 但不是 JSON-RPC 响应（形状不对） */
  BAD_RESPONSE: 'MCP_BAD_RESPONSE',
  /** 服务端按协议回了 JSON-RPC error 对象 */
  RPC_ERROR: 'MCP_RPC_ERROR',
  /** 配置或用法问题（url 空 / 参数不合法） */
  CONFIG: 'MCP_CONFIG',
} as const;

/** MCP_ERROR_CODES 的值联合类型 */
export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/* ============================ 请求号分配 ============================ */

/**
 * 单调递增的请求 id。
 *
 * 为什么不用随机数：调试日志里 id 顺序可读（1、2、3…），
 * 而且同一连接内**绝不可能撞号** —— 撞号会让「回复对应哪个请求」这件事失去意义。
 * 每个 client 实例自己持有一个（见 client.ts），进程内不复用全局计数器：
 * 多个服务器的日志混在一起时，各自从 1 数起反而好读。
 */
export function createIdGenerator(prefix = 'cx'): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return prefix + '-' + seq;
  };
}

/* ============================ 报文构造 ============================ */

/** 造一条请求（有 id） */
export function makeRequest(id: string | number, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const out: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params !== undefined) out.params = params;
  return out;
}

/**
 * 造一条通知（**没有 id**）。
 *
 * ⚠️ 这里刻意不写 `id: undefined` —— `JSON.stringify` 会把 undefined 的键整个丢掉，
 * 结果「看起来一样」，但一旦有人改成显式 null 就变成了「id=null 的请求」，
 * 服务端会**等一个永远不会来的回复**。少写一个键，就少一个能被改错的地方。
 */
export function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  const out: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) out.params = params;
  return out;
}

/** 这条响应是不是失败响应（类型收窄用） */
export function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return typeof (response as JsonRpcFailure).error === 'object' && (response as JsonRpcFailure).error !== null;
}

/* ============================ 响应解析 ============================ */

/** 纯对象判断（排除数组与 null） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析响应体文本 → JsonRpcResponse。
 *
 * 三种失败都翻成 McpError（**不抛 SyntaxError**）：
 *   - 不是 JSON            → BAD_JSON
 *   - 是 JSON 但不是对象   → BAD_RESPONSE
 *   - 既没有 result 也没有 error → BAD_RESPONSE（半截响应，不能当成功）
 *
 * @param text 响应体原文
 * @param status HTTP 状态码（只用于 detail 文案，判定已在 transport 层做过）
 */
export function parseResponseText(text: string, status = 200): JsonRpcResponse {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') {
    throw new McpError(
      MCP_ERROR_CODES.BAD_JSON,
      '服务器返回了空响应（HTTP ' + status + '）',
      '这个地址可能不是 MCP 的服务端点；确认它接受 POST 的 JSON-RPC 请求',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // 原文截断，避免把一整个 HTML 错误页糊到界面上
    const preview = raw.slice(0, 120).replace(/\s+/g, ' ');
    throw new McpError(
      MCP_ERROR_CODES.BAD_JSON,
      '服务器返回的不是 JSON（HTTP ' + status + '）：' + preview +
        (error instanceof Error ? '（解析失败：' + error.message + '）' : ''),
      '常见原因：地址填成了网页地址（返回 HTML），或服务端报错时回了纯文本；确认 URL 指向 MCP 端点',
    );
  }

  if (!isRecord(parsed)) {
    throw new McpError(
      MCP_ERROR_CODES.BAD_RESPONSE,
      '服务器返回的 JSON 不是对象（是 ' + (Array.isArray(parsed) ? '数组' : typeof parsed) + '）',
      'MCP 端点必须返回 JSON-RPC 对象；确认这个地址不是别的服务的接口',
    );
  }

  // 有 error 字段 → 失败响应（即使同时有 result 也以 error 为准，协议不允许两者并存）
  if (isRecord(parsed.error)) {
    const err = parsed.error as unknown as JsonRpcErrorObject;
    return {
      jsonrpc: JSONRPC_VERSION,
      id: (parsed.id as string | number | null) ?? null,
      error: {
        code: typeof err.code === 'number' ? err.code : -32000,
        message: typeof err.message === 'string' ? err.message : String(err.message ?? '未知错误'),
        data: err.data,
      },
    };
  }

  if (!('result' in parsed)) {
    throw new McpError(
      MCP_ERROR_CODES.BAD_RESPONSE,
      '服务器返回的 JSON-RPC 响应里既没有 result 也没有 error',
      '这通常不是标准 MCP 服务端点；确认地址与传输方式（http / sse）填对了',
    );
  }

  return {
    jsonrpc: JSONRPC_VERSION,
    id: (parsed.id as string | number) ?? 0,
    result: parsed.result,
  };
}

/* ============================ 失败响应 → 人话 ============================ */

/**
 * JSON-RPC 标准错误码的人话表。
 *
 * 按 JSON-RPC 2.0 规范：-32700 ~ -32603 是协议保留段，-32000 以下是实现自定义段；
 * MCP 用 -32602（参数不合法）报「这个工具不存在 / 参数不对」这类事。
 */
const RPC_ERROR_HINTS: Record<number, string> = {
  [-32700]: '服务端没读懂请求（JSON 解析失败），通常是协议版本或编码不一致',
  [-32600]: '服务端认为请求格式不合法；确认这个地址支持 JSON-RPC 2.0',
  [-32601]: '服务端没有这个方法；可能它不支持 MCP，或协议版本对不上',
  [-32602]: '参数不合法 —— 若是调工具，通常是这个工具名在服务端不存在，或参数不符合它的 schema',
  [-32603]: '服务端内部错误，重试一次；持续失败要看服务端日志',
};

/**
 * 把 JSON-RPC error 对象翻成 McpError。
 *
 * `method` 只用于把话说清（「调工具 X 失败」比「调用失败」有用得多）。
 */
export function errorFromRpc(error: JsonRpcErrorObject, method?: string): McpError {
  const where = method ? '调用 ' + method + ' 失败' : '服务端返回错误';
  const hint =
    RPC_ERROR_HINTS[error.code] ??
    (error.code >= -32099 && error.code <= -32000
      ? '这是服务端自定义的错误码，含义要看该服务自己的文档'
      : '这是服务端返回的错误，检查它的输入是否符合要求');
  // data 常常带着服务端自己的补充说明，有就带上 —— 那是定位问题的第一手材料
  const extra = error.data === undefined ? '' : '；服务端补充：' + safeStringify(error.data);
  return new McpError(MCP_ERROR_CODES.RPC_ERROR, where + '：' + error.message + '（code ' + error.code + '）' + extra, hint);
}

/** 安全 stringify（循环引用 / 超长都别炸、别糊屏） */
export function safeStringify(value: unknown, max = 300): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ============================ HTTP 层错误分类 ============================ */

/**
 * 按 HTTP 状态码翻成 McpError。
 *
 * @param status   HTTP 状态码
 * @param body     响应体原文（截断进 detail，给用户线索）
 * @param hadSession 这次请求有没有带 Mcp-Session-Id（决定 404 是「地址错」还是「会话过期」）
 * @param method   调用方法（进 detail）
 */
export function errorFromStatus(status: number, body: string, hadSession: boolean, method?: string): McpError {
  const where = method ? '调用 ' + method + ' 时' : '请求时';
  const preview = typeof body === 'string' ? body.slice(0, 200).replace(/\s+/g, ' ').trim() : '';
  const tail = preview ? '，服务端说：' + preview : '';

  if (status === 401 || status === 403) {
    return new McpError(
      MCP_ERROR_CODES.AUTH,
      where + '鉴权失败（HTTP ' + status + '）' + tail,
      '在服务器的 headers 里填对凭据，通常是 Authorization: Bearer <token>；确认这个 token 没过期',
    );
  }

  if (status === 404) {
    // 带过 session 还 404 = 会话没了（服务端重启 / 会话过期），重连即可 —— 与「地址写错」是两回事
    if (hadSession) {
      return new McpError(
        MCP_ERROR_CODES.SESSION_EXPIRED,
        '会话已过期（HTTP 404：服务端不认识当前的 Mcp-Session-Id）' + tail,
        '断开后重新连接这个服务器即可（服务端可能重启过）',
      );
    }
    return new McpError(
      MCP_ERROR_CODES.NOT_FOUND,
      '地址不存在（HTTP 404）' + tail,
      '确认 URL 是指向 MCP 端点（而不是站点首页）；多数 MCP 服务端点是 /mcp 或 /sse',
    );
  }

  if (status >= 500) {
    return new McpError(
      MCP_ERROR_CODES.SERVER,
      where + '服务端出错（HTTP ' + status + '）' + tail,
      '这是服务端的问题，不是配置错；稍后重试，或看服务端日志',
    );
  }

  return new McpError(
    MCP_ERROR_CODES.BAD_REQUEST,
    where + '请求被拒绝（HTTP ' + status + '）' + tail,
    '确认请求体与服务端要求一致；若服务端要求特定 header，在服务器的 headers 里补上',
  );
}

/**
 * 判断一个 fetch 抛出的异常是不是「我们自己掐的超时 / 主动取消」。
 *
 * 为什么单独一条：AbortController 触发的 `AbortError` 与「用户点了断开」是
 * **同一个异常名字**，只能靠调用方传入「是超时还是取消」来区分 —— 所以这里
 * 只负责识别，语义由调用方给（见 client.ts 的 timedOut 标记）。
 */
export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError' || name === 'AbortSignal';
}

/**
 * 把 fetch 的网络层异常翻成 McpError（**绝不放 raw TypeError 出去**）。
 *
 * `TypeError: Failed to fetch` 是浏览器里最没有信息量的一句报错：
 * 断网、CORS 被挡、DNS 解析不了、证书不对 —— 全都是它。所以这里必须
 * **把可能性列出来**，让用户有下一步可做，而不是把原文丢过去。
 */
export function errorFromNetwork(error: unknown, url: string, method?: string): McpError {
  const raw = error instanceof Error ? error.message : String(error);
  const where = method ? '调用 ' + method + ' 时' : '连接时';
  return new McpError(
    MCP_ERROR_CODES.NETWORK,
    where + '连不上 ' + url + '：' + raw,
    '可能的原因（按常见度）：① 服务端的 CORS 没放开本页面 —— 需要在 MCP 服务端允许跨域；' +
      '② 地址或端口填错、服务没起来；③ 网络 / 代理挡了这件事。' +
      '浏览器出于安全不会告诉你具体是哪一个，可以先在浏览器直接打开这个地址确认它活着',
  );
}

/** 造一个「超时」McpError（超时是我们自己掐的，文案里点明时限） */
export function errorTimeout(url: string, timeoutMs: number, method?: string): McpError {
  const where = method ? '调用 ' + method + ' 时' : '连接时';
  return new McpError(
    MCP_ERROR_CODES.TIMEOUT,
    where + '超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应）：' + url,
    '服务端可能很慢或卡住了；可以加大超时时间，或确认这个地址真的在提供服务',
  );
}

/** 造一个「已取消」McpError（用户主动断开，不是故障） */
export function errorAborted(method?: string): McpError {
  return new McpError(
    MCP_ERROR_CODES.ABORTED,
    method ? '调用 ' + method + ' 已取消' : '请求已取消',
    '这是主动取消，不是故障；需要的话重新连接即可',
  );
}

/** 造一个「配置不对」McpError */
export function errorConfig(detail: string, hint: string): McpError {
  return new McpError(MCP_ERROR_CODES.CONFIG, detail, hint);
}
