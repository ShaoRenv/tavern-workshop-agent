/**
 * LLM 双通道（实现 ports.ts 的 LlmPort）
 *
 *  native：自己 fetch（ApiSettings.url / key / model），请求体带 tools，解析 tool_calls。
 *  text  ：走酒馆助手的 generateRaw，把工具说明拼进提示词，从回复里抠 <SystemQuery>{...}</SystemQuery>。
 *
 * 自动降级：native 被 400/不支持 tools 打回来 → markToolsUnsupported()，本轮改走 text，
 *          返回的 LlmReply.via='text'，UI 可以据此提示「这次是文本标记模式」。
 * 多模态：只有 ApiSettings.send_images 开着，才把图片塞进请求。
 *
 * 说明：本文件的全局函数（generateRaw / substitudeMacros / stopGenerationById）都从宿主拿，
 * 不 import 任何新依赖；测试里可以用 deps 注入假实现。
 */
import type { ApiSettings } from '../core/types.ts';
import type { LlmMessage, LlmPort, LlmReply, LlmRequest, LlmToolCall, ToolSpec, ToolSupport } from '../core/ports.ts';

/* ============================ 类型 ============================ */

export interface TransportNotice {
  level: 'info' | 'warn';
  message: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;

export interface TransportDeps {
  fetchImpl?: FetchLike;
  /** 酒馆 generateRaw；不传就从 globalThis / TavernHelper 找 */
  generateRawImpl?: (config: Record<string, unknown>) => Promise<unknown>;
  /** 酒馆宏替换 substitudeMacros（官方就是拼错的）；不传就自己找，找不到就原样返回 */
  substituteMacrosImpl?: (text: string) => string;
  onNotice?: (notice: TransportNotice) => void;
}

/** 文本通道的 SystemQuery 协议名 */
export const SYSTEM_QUERY_TAG = 'SystemQuery';

/* ============================ 错误 ============================ */

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super('接口返回 ' + status + (body ? '：' + body.slice(0, 300) : ''));
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** 接口不吃原生 tools（或压根没填接口），需要改走文本通道 */
export class ToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUnsupportedError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError' || name === 'AbortSignal';
}

export function abortError(message = '已停止'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

const TOOLS_UNSUPPORTED_STATUS = [400, 404, 405, 415, 422, 501];
const TOOLS_UNSUPPORTED_HINT = /tool|function call|function_call|不支持|unsupported|not support/i;

/** native 报「不支持 tools」的判定：明确提到 tool，或者压根没填接口信息 */
export function isToolsUnsupportedError(error: unknown): boolean {
  if (error instanceof ToolsUnsupportedError) return true;
  if (error instanceof HttpError) {
    return TOOLS_UNSUPPORTED_STATUS.includes(error.status) && TOOLS_UNSUPPORTED_HINT.test(error.body);
  }
  return false;
}

/* ============================ 小工具 ============================ */

export function resolveEndpoint(url: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** OpenAI 的 content 可能是字符串，也可能是分片数组 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const object = part as Record<string, unknown>;
          return asText(object.text ?? object.content);
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const text = asText(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* 模型偶尔给半截 JSON，别炸 */
  }
  return {};
}

interface TimeoutGuard {
  signal: AbortSignal;
  isTimeout(): boolean;
  dispose(): void;
}

function withTimeout(external: AbortSignal | undefined, ms: number): TimeoutGuard {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function globalFunction<T>(name: string): T | undefined {
  const host = globalThis as unknown as Record<string, unknown>;
  try {
    const helper = host.TavernHelper as Record<string, unknown> | undefined;
    if (helper && typeof helper[name] === 'function')
      return (helper[name] as (this: unknown) => unknown).bind(helper) as T;
  } catch {
    /* 宿主没给就算了 */
  }
  if (typeof host[name] === 'function') return (host[name] as (this: unknown) => unknown).bind(globalThis) as T;
  try {
    const win = host.window as Record<string, unknown> | undefined;
    if (win && typeof win[name] === 'function') return (win[name] as (this: unknown) => unknown).bind(win) as T;
  } catch {
    /* ignore */
  }
  return undefined;
}

/* ============================ native 请求体 ============================ */

export function toNativeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  };
}

export function toNativeMessage(message: LlmMessage, sendImages: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };
  const images = sendImages && message.role !== 'tool' ? (message.images ?? []) : [];
  if (images.length) {
    out.content = [
      { type: 'text', text: message.content },
      ...images.filter(url => typeof url === 'string' && url).map(url => ({ type: 'image_url', image_url: { url } })),
    ];
  } else {
    out.content = message.content;
  }
  if (message.role === 'tool' && message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.role === 'assistant' && message.tool_calls?.length) {
    out.tool_calls = message.tool_calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }
  return out;
}

/* ============================ 回复解析 ============================ */

let callSeq = 0;

function nextCallId(): string {
  callSeq += 1;
  return 'call_' + Date.now().toString(36) + '_' + callSeq;
}

interface RawCall {
  index: number;
  id?: string;
  name?: string;
  args?: unknown;
}

function readChoiceChunk(payload: unknown): { text: string; calls: RawCall[] } {
  const root = (payload ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  const text = contentToText(delta.content);
  const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  const calls: RawCall[] = rawCalls.map((item, index) => {
    const object = (item ?? {}) as Record<string, unknown>;
    const fn = (object.function ?? {}) as Record<string, unknown>;
    return {
      index: typeof object.index === 'number' ? object.index : index,
      id: asText(object.id) || undefined,
      name: asText(fn.name) || undefined,
      args: fn.arguments,
    };
  });
  return { text, calls };
}

export function parseNativeReply(payload: unknown): LlmReply {
  const { text, calls } = readChoiceChunk(payload);
  const tool_calls: LlmToolCall[] = calls
    .filter(call => (call.name ?? '').trim() !== '')
    .map(call => ({
      id: call.id ?? nextCallId(),
      name: (call.name ?? '').trim(),
      args: parseToolArguments(call.args),
    }));
  return { text, tool_calls, via: 'native' };
}

/* ============================ text 通道提示词 ============================ */

export interface TextPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function renderToolProtocol(tools: ToolSpec[]): string {
  if (!tools.length) return '';
  const blocks = tools.map((tool, index) => {
    let schema = '{}';
    try {
      schema = JSON.stringify(tool.parameters ?? {}, null, 0);
    } catch {
      schema = '{}';
    }
    return '## ' + (index + 1) + '. ' + tool.name + '\n' + tool.description + '\n参数 JSON Schema：' + schema;
  });
  return [
    '# 可用工具（重要）',
    '需要工具时，单独输出一行（可以连续输出多行，系统会按顺序执行）：',
    '<' + SYSTEM_QUERY_TAG + '>{"name":"工具名","args":{...}}</' + SYSTEM_QUERY_TAG + '>',
    '规矩：只输出这一行标记，不要解释它；args 必须是合法 JSON；拿到「工具结果」后继续干活；任务全部做完时调用 submit。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function renderAssistantWithCalls(message: LlmMessage): string {
  const lines = [message.content];
  for (const call of message.tool_calls ?? []) {
    lines.push(
      '<' +
        SYSTEM_QUERY_TAG +
        '>' +
        JSON.stringify({ name: call.name, args: call.args ?? {} }) +
        '</' +
        SYSTEM_QUERY_TAG +
        '>',
    );
  }
  return lines.filter(line => line && line.trim()).join('\n');
}

/** 标准转写 → generateRaw 的 ordered_prompts（工具结果和工具调用都摊成纯文本） */
export function buildTextPrompts(messages: LlmMessage[], tools: ToolSpec[]): TextPrompt[] {
  const systemParts = messages
    .filter(message => message.role === 'system')
    .map(message => message.content.trim())
    .filter(Boolean);
  const protocol = renderToolProtocol(tools);
  if (protocol) systemParts.push(protocol);
  const prompts: TextPrompt[] = [];
  if (systemParts.length) prompts.push({ role: 'system', content: systemParts.join('\n\n') });
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const label = message.tool_call_id ? '【工具结果 id=' + message.tool_call_id + '】' : '【工具结果】';
      prompts.push({ role: 'user', content: label + '\n' + (message.content || '(空)') });
      continue;
    }
    if (message.role === 'assistant') {
      const content = renderAssistantWithCalls(message);
      if (content) prompts.push({ role: 'assistant', content });
      continue;
    }
    prompts.push({ role: 'user', content: message.content });
  }
  return prompts;
}

/** 把最后几条消息里的图收集起来（多模态只在 send_images 开着时用） */
export function collectImages(messages: LlmMessage[], max = 4): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const images = messages[i].images ?? [];
    for (let j = images.length - 1; j >= 0 && out.length < max; j--) {
      const url = images[j];
      if (typeof url === 'string' && url) out.unshift(url);
    }
  }
  return out;
}

/* ============================ SystemQuery 抠取 ============================ */

export interface ExtractedQuery {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

function normalizeQueryObject(parsed: unknown): { name: string; args: Record<string, unknown> } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { name: '', args: {} };
  const object = parsed as Record<string, unknown>;
  const name = asText(object.name ?? object.tool ?? object.function ?? object.tool_name).trim();
  let args: unknown = object.args ?? object.arguments ?? object.parameters ?? object.input ?? object.params;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      args = undefined;
    }
  }
  const consumed = new Set([
    'name',
    'tool',
    'function',
    'tool_name',
    'args',
    'arguments',
    'parameters',
    'input',
    'params',
  ]);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!consumed.has(key)) rest[key] = value;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = Object.keys(rest).length ? rest : {};
  return { name, args: args as Record<string, unknown> };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/** 从文本里抠 <SystemQuery>{...}</SystemQuery>，返回值里 text 是剥掉标记后的正文 */
export function extractSystemQueries(text: string): { queries: ExtractedQuery[]; text: string } {
  const source = String(text ?? '');
  const pattern = new RegExp('<' + SYSTEM_QUERY_TAG + '\\b[^>]*>([\\s\\S]*?)</' + SYSTEM_QUERY_TAG + '>', 'gi');
  const queries: ExtractedQuery[] = [];
  let cleaned = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    cleaned += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const raw = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(raw)) as unknown;
    } catch {
      parsed = undefined;
    }
    const normalized = normalizeQueryObject(parsed);
    if (normalized.name) queries.push({ name: normalized.name, args: normalized.args, raw: raw.trim() });
  }
  cleaned += source.slice(cursor);
  return { queries, text: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

/* ============================ 传输实现 ============================ */

export class LlmTransport implements LlmPort {
  private support: ToolSupport = 'unknown';
  private route: 'native' | 'text' = 'text';
  private readonly deps: TransportDeps;

  constructor(deps: TransportDeps = {}) {
    this.deps = deps;
  }

  supportsTools(): ToolSupport {
    return this.support;
  }

  markToolsUnsupported(): void {
    if (this.support === 'no') return;
    this.support = 'no';
    this.notify('warn', '接口不支持原生 tools，已自动切到文本标记通道');
  }

  /** 叫一次接口实际走的通道（UI 提示用） */
  lastVia(): 'native' | 'text' {
    return this.route;
  }

  /** 酒馆宏替换（官方拼写就是 substitudeMacros） */
  substituteMacros(text: string): string {
    const fn = this.deps.substituteMacrosImpl ?? globalFunction<(text: string) => string>('substitudeMacros');
    if (typeof fn !== 'function') return text;
    try {
      const out = fn(text);
      return typeof out === 'string' ? out : text;
    } catch {
      return text;
    }
  }

  async chat(req: LlmRequest): Promise<LlmReply> {
    const wantNative = req.settings.route === 'custom' && this.support !== 'no';
    if (wantNative) {
      try {
        const reply = await this.chatNative(req);
        this.support = 'yes';
        this.route = 'native';
        return reply;
      } catch (error) {
        if (isAbortError(error) || req.signal?.aborted) throw error;
        if (isToolsUnsupportedError(error)) {
          this.markToolsUnsupported();
          const reply = await this.chatText(req);
          this.route = 'text';
          return reply;
        }
        throw error;
      }
    }
    const reply = await this.chatText(req);
    this.route = 'text';
    return reply;
  }

  private notify(level: TransportNotice['level'], message: string): void {
    try {
      this.deps.onNotice?.({ level, message });
    } catch {
      /* UI 抛错不影响传输 */
    }
  }

  private fetchImpl(): FetchLike | undefined {
    if (this.deps.fetchImpl) return this.deps.fetchImpl;
    const host = globalThis as unknown as Record<string, unknown>;
    return typeof host.fetch === 'function' ? (host.fetch as unknown as FetchLike) : undefined;
  }

  /** 原生通道：自己 fetch，带 tools */
  async chatNative(req: LlmRequest): Promise<LlmReply> {
    const settings: ApiSettings = req.settings;
    if (!settings.url.trim()) throw new ToolsUnsupportedError('没有填接口地址，改走酒馆文本通道');
    if (!settings.model.trim()) throw new ToolsUnsupportedError('没有填模型名，改走酒馆文本通道');
    const fetcher = this.fetchImpl();
    if (!fetcher) throw new ToolsUnsupportedError('当前环境没有 fetch，改走酒馆文本通道');

    const tools = req.tools ?? [];
    const stream = !!settings.stream;
    const body: Record<string, unknown> = {
      model: settings.model.trim(),
      messages: req.messages.map(message => toNativeMessage(message, settings.send_images)),
      stream,
    };
    if (tools.length) {
      body.tools = tools.map(toNativeTool);
      body.tool_choice = 'auto';
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.key.trim()) headers.Authorization = 'Bearer ' + settings.key.trim();

    const guard = withTimeout(req.signal, Math.max(1, settings.timeout_sec) * 1000);
    try {
      const response = await fetcher(resolveEndpoint(settings.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: guard.signal,
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          detail = response.statusText ?? '';
        }
        throw new HttpError(response.status, detail);
      }
      if (stream) return await this.readStream(response, req.onDelta);
      const data = await response.json();
      return parseNativeReply(data);
    } catch (error) {
      if (guard.isTimeout() && !req.signal?.aborted) {
        throw new Error(
          '接口超时（' +
            Math.max(1, settings.timeout_sec) +
            ' 秒）：' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      throw error;
    } finally {
      guard.dispose();
    }
  }

  /** 流式：SSE 增量拼文本 + 拼 tool_calls；不是 SSE 就退回整包 JSON */
  private async readStream(response: FetchResponseLike, onDelta?: (text: string) => void): Promise<LlmReply> {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const data = await response.json();
      return parseNativeReply(data);
    }
    const decoder = new TextDecoder();
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let buffer = '';
    let rawAll = '';
    let text = '';
    let sawSse = false;

    const consume = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return;
      if (!trimmed.toLowerCase().startsWith('data:')) return;
      sawSse = true;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        return;
      }
      const chunk = readChoiceChunk(parsed);
      if (chunk.text) {
        text += chunk.text;
        onDelta?.(chunk.text);
      }
      for (const call of chunk.calls) {
        const current = calls.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id) current.id = call.id;
        if (call.name) current.name = call.name;
        if (typeof call.args === 'string') current.args += call.args;
        else if (call.args && typeof call.args === 'object') current.args += JSON.stringify(call.args);
        calls.set(call.index, current);
      }
    };

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const piece = decoder.decode(chunk.value ?? new Uint8Array(0), { stream: true });
      rawAll += piece;
      buffer += piece;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);

    if (!sawSse) {
      try {
        return parseNativeReply(JSON.parse(rawAll) as unknown);
      } catch {
        return { text: rawAll.trim(), tool_calls: [], via: 'native' };
      }
    }
    const tool_calls: LlmToolCall[] = Array.from(calls.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([, call]) => ({ id: call.id || nextCallId(), name: call.name.trim(), args: parseToolArguments(call.args) }))
      .filter(call => call.name !== '');
    return { text, tool_calls, via: 'native' };
  }

  /** 文本通道：走 generateRaw，工具说明进提示词 */
  async chatText(req: LlmRequest): Promise<LlmReply> {
    const generateRaw =
      this.deps.generateRawImpl ?? globalFunction<(config: Record<string, unknown>) => Promise<unknown>>('generateRaw');
    if (typeof generateRaw !== 'function') {
      throw new Error('文本通道不可用：当前环境没有酒馆助手的 generateRaw');
    }
    const substituted: LlmMessage[] = req.messages.map(message => ({
      ...message,
      content: this.substituteMacros(message.content),
    }));
    const prompts = buildTextPrompts(substituted, req.tools ?? []);
    const images = req.settings.send_images ? collectImages(substituted, 4) : [];
    const generationId = 'cx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const config: Record<string, unknown> = {
      generation_id: generationId,
      should_silence: true,
      ordered_prompts: prompts,
    };
    if (images.length) config.image = images;
    if (req.settings.url.trim() && req.settings.model.trim()) {
      config.custom_api = {
        apiurl: req.settings.url.trim(),
        key: req.settings.key,
        model: req.settings.model.trim(),
        source: 'openai',
      };
    }

    const stop = globalFunction<(id: string) => void>('stopGenerationById');
    const onAbort = () => {
      try {
        stop?.(generationId);
      } catch {
        /* ignore */
      }
    };
    req.signal?.addEventListener('abort', onAbort);
    let raw: unknown;
    try {
      raw = await generateRaw(config);
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
    if (req.signal?.aborted) throw abortError();

    const full =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? contentToText((raw as Record<string, unknown>).content)
          : '';
    const extracted = extractSystemQueries(full);
    const tool_calls: LlmToolCall[] = extracted.queries.map(query => ({
      id: nextCallId(),
      name: query.name,
      args: query.args,
    }));
    return { text: extracted.text, tool_calls, via: 'text' };
  }
}

export function createTransport(deps: TransportDeps = {}): LlmTransport {
  return new LlmTransport(deps);
}

/** 给 UI 用：这次该走哪条通道（还没试过 tools 时按设置猜） */
export function plannedRoute(settings: ApiSettings, support: ToolSupport): 'native' | 'text' {
  if (settings.route !== 'custom') return 'text';
  return support === 'no' ? 'text' : 'native';
}
