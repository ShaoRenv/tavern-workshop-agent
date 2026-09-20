/**
 * 会话循环：预设 + 用户这一轮的话 → 渲染消息 → 请求 → 执行 tool_calls → 结果塞回去 → 再来。
 *
 * 停止条件：没有 tool_calls / 调了 submit / 到 max_rounds / 用户点停（AbortSignal）。
 *
 * 转写用标准形状（system + user + assistant(tool_calls) + tool），不伪造 assistant 寒暄：
 * 助手回合里放的都是模型真返回的文本和真发起的调用。
 *
 * 每轮新增的 Turn / ToolCall 都通过 onEvent 回调吐给 UI，UI 靠它实时画卡片：
 *   round → turn(user) → [delta...] → turn(assistant, 里面带 pending 的 calls)
 *         → tool_call(start) → tool_call(done) → turn(tool) → ... → done
 */
import type {
  LlmMessage,
  LlmPort,
  ToolContext,
  ToolContextNote,
  ToolDef,
  ToolErrorCode,
  ToolGuard,
  ToolResult,
  ToolSpec,
} from '../core/ports.ts';
import type { ApiSettings, ToolCall, Turn } from '../core/types.ts';
import { nowMs, uid } from '../core/types.ts';
import { createToolGuards, pruneForModel } from './guards.ts';
import { runToolPipeline } from './pipeline.ts';
import { isAbortError } from './transport.ts';

export type LoopStopReason = 'submit' | 'no_tool_calls' | 'max_rounds' | 'aborted' | 'error';

export type LoopEvent =
  | { type: 'turn'; turn: Turn }
  | {
      type: 'tool_call';
      call: ToolCall;
      status: 'start' | 'done';
      round: number;
      /** 失败分类（失败时给；UI / 记录页按它分流，别靠文案猜） */
      code?: ToolErrorCode;
      /** 守卫给模型的附加上下文（已作为合成消息塞进转写） */
      contexts?: ToolContextNote[];
      /** detail 被修剪过：给模型的那份是修剪版，call.detail 仍是原文 */
      pruned?: ToolResult['pruned'];
      /** after 守卫之前的原文（会话日志 / 回放用） */
      raw_detail?: string;
    }
  | { type: 'round'; round: number; max_rounds: number }
  | { type: 'delta'; text: string; round: number; turnId: string }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'done'; reason: LoopStopReason; round: number; via: 'native' | 'text' | '' }
  | { type: 'error'; message: string; round: number };

export interface AgentLoopInput {
  transport: LlmPort;
  /** 全部工具定义（ToolRegistry.defs） */
  tools: ToolDef[];
  /** 本轮允许调用的工具名；不传 = 全给 */
  enabled_tools?: string[];
  settings: ApiSettings;
  /** 系统提示词（宏已经替完了）。给了 prefix 就不看它 */
  system: string;
  /**
   * 预设本体渲染出来的完整前缀（v4：items + 特殊层原生展开 + 追加的系统段）。
   *
   * 给了它就代替 system 那一条；history / user 照旧接在它后面。
   * 特殊层里的「上下文」已经把历史原生展开进 prefix，runner 那边不会再补一次。
   */
  prefix?: LlmMessage[];
  /** 用户这一轮说的话 */
  user?: string;
  user_images?: string[];
  /** 之前的标准转写（不含 system）；界面把历史 Turn 用 turnsToMessages() 转过来 */
  history?: LlmMessage[];
  /** 工具执行上下文（世界书范围、草稿仓、技能、生图、问用户） */
  context: ToolContext;
  max_rounds?: number;
  signal?: AbortSignal;
  /** 每轮的新增内容都从这里吐给 UI */
  onEvent?: (event: LoopEvent) => void;
  /**
   * 工具守卫（observe / prune / repeat …）。不传 = 默认装配 prune + repeat；
   * 想要 observe-guard（改写前必须先读）就从 registry.guards() 拿，那里带着世界书端口。
   */
  guards?: ToolGuard[];
}

export interface AgentLoopResult {
  reason: LoopStopReason;
  rounds: number;
  turns: Turn[];
  messages: LlmMessage[];
  /** submit 带来的收尾说明 */
  submit_result: string;
  via: 'native' | 'text' | '';
  error?: string;
}

const DEFAULT_MAX_ROUNDS = 12;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

/**
 * 历史 Turn → 标准转写。
 *
 * 关键点：assistant 轮次里的 calls 自带结果（ok / brief / detail / images），
 * 所以哪怕界面上没存 tool 轮次，转写依然合法（有 tool_calls 就有配对的 tool 消息）；
 * 反过来，如果 tool 轮次也在（loop 自己会发），同 id 的 call 不会重复转写。
 */
export function turnsToMessages(turns: Turn[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const emittedCalls = new Set<string>();

  const partsForCall = (call: ToolCall): { content: string; images: string[] } => ({
    content: (call.ok ? '' : '[工具执行失败] ') + (call.detail || call.brief || '(空结果)'),
    images: call.images.filter(image => typeof image === 'string' && image !== ''),
  });

  const flushImages = (images: string[]): void => {
    if (images.length) messages.push({ role: 'user', content: '（上面工具生成的图）', images });
  };

  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text, images: turn.images.length ? turn.images.slice() : undefined });
      continue;
    }
    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text,
        tool_calls: turn.calls.length
          ? turn.calls.map(call => ({ id: call.id, name: call.name, args: call.args }))
          : undefined,
      });
      const images: string[] = [];
      for (const call of turn.calls) {
        if (!call.id || emittedCalls.has(call.id)) continue;
        emittedCalls.add(call.id);
        const part = partsForCall(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: part.content });
        images.push(...part.images);
      }
      flushImages(images);
      continue;
    }
    const images: string[] = [];
    for (const call of turn.calls) {
      if (!call.id || emittedCalls.has(call.id)) continue;
      emittedCalls.add(call.id);
      const part = partsForCall(call);
      messages.push({ role: 'tool', tool_call_id: call.id, content: part.content });
      images.push(...part.images);
    }
    flushImages(images);
  }
  return messages;
}

/** 工具定义 → LlmPort 要的 ToolSpec */
export function toToolSpecs(tools: ToolDef[], enabled?: string[]): ToolSpec[] {
  const picked = !enabled || !enabled.length ? tools : tools.filter(tool => enabled.includes(tool.name));
  return picked.map(tool => ({ name: tool.name, description: tool.model_description, parameters: tool.parameters }));
}

function pendingCall(name: string, id: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args, ok: true, brief: '执行中…', detail: '', images: [], at: nowMs() };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const emit = (event: LoopEvent): void => {
    try {
      input.onEvent?.(event);
    } catch {
      /* UI 抛错不能弄死循环 */
    }
  };

  const turns: Turn[] = [];
  const messages: LlmMessage[] = [];
  const maxRounds = Math.max(1, Math.floor(input.max_rounds ?? DEFAULT_MAX_ROUNDS));
  const toolMap = new Map(input.tools.map(tool => [tool.name, tool]));
  const specs = toToolSpecs(input.tools, input.enabled_tools);
  let via: 'native' | 'text' | '' = '';
  let submitResult = '';
  let lastVia: 'native' | 'text' | '' = '';

  const finish = (reason: LoopStopReason, round: number, error?: string): AgentLoopResult => {
    if (error) emit({ type: 'error', message: error, round });
    emit({ type: 'done', reason, round, via });
    const result: AgentLoopResult = {
      reason,
      rounds: round,
      turns,
      messages,
      submit_result: submitResult,
      via,
      ...(error ? { error } : {}),
    };
    return result;
  };

  // 预设本体（含特殊层展开）优先；没有就退回单条 system
  if (input.prefix?.length) {
    for (const message of input.prefix) messages.push({ ...message });
  } else if (input.system.trim()) {
    messages.push({ role: 'system', content: input.system });
  }
  for (const message of input.history ?? []) messages.push({ ...message });

  if (typeof input.user === 'string' && input.user.trim() !== '') {
    const userTurn: Turn = {
      id: uid('turn'),
      role: 'user',
      text: input.user,
      images: input.user_images?.slice() ?? [],
      calls: [],
      at: nowMs(),
    };
    turns.push(userTurn);
    emit({ type: 'turn', turn: userTurn });
    messages.push({ role: 'user', content: input.user, images: userTurn.images.length ? userTurn.images : undefined });
  }

  if (aborted(input.signal)) return finish('aborted', 0);

  // 守卫在整轮对话里共用（repeat 计数要跨模型轮次累加）；不传就默认装 prune + repeat
  const guards = input.guards?.length ? input.guards : createToolGuards().guards;

  for (let round = 1; round <= maxRounds; round++) {
    if (aborted(input.signal)) return finish('aborted', round - 1);
    emit({ type: 'round', round, max_rounds: maxRounds });

    // 本轮的助手轮次先建好：流式时第一段增量就把轮次推给 UI，
    // UI 才能拿到 turnId 一边收一边显示（文本通道不会调 onDelta，所以只走最后那一次）
    const assistantTurn: Turn = {
      id: uid('turn'),
      role: 'assistant',
      text: '',
      images: [],
      calls: [],
      at: nowMs(),
    };
    let assistantPublished = false;
    const publishAssistant = (): void => {
      if (assistantPublished) return;
      assistantPublished = true;
      turns.push(assistantTurn);
      emit({ type: 'turn', turn: assistantTurn });
    };

    let reply;
    try {
      reply = await input.transport.chat({
        messages,
        tools: specs.length ? specs : undefined,
        settings: input.settings,
        signal: input.signal,
        onDelta: text => {
          if (!text) return;
          assistantTurn.text += text;
          publishAssistant();
          emit({ type: 'delta', text, round, turnId: assistantTurn.id });
        },
      });
    } catch (error) {
      if (isAbortError(error) || aborted(input.signal)) return finish('aborted', round - 1);
      return finish('error', round - 1, errorMessage(error));
    }

    via = reply.via;
    if (reply.via === 'text' && lastVia !== 'text' && specs.length) {
      emit({
        type: 'notice',
        level: 'warn',
        message: '这次走的是文本标记通道：工具调用是从回复里的 SystemQuery 抠出来的',
      });
    }
    lastVia = reply.via;

    const calls = (reply.tool_calls ?? []).map(call => ({
      id: call.id || uid('call'),
      name: call.name,
      args: call.args ?? {},
    }));

    // 最终文本以 reply 为准（流式拼出来的可能少最后一段）；工具卡挂到这个已经发出去的轮次上
    assistantTurn.text = reply.text || assistantTurn.text;
    assistantTurn.calls = calls.map(call => pendingCall(call.name, call.id, call.args));
    publishAssistant();

    messages.push({
      role: 'assistant',
      content: reply.text ?? '',
      tool_calls: calls.length ? calls.map(call => ({ id: call.id, name: call.name, args: call.args })) : undefined,
    });

    if (!calls.length) return finish('no_tool_calls', round);

    let submitted = false;
    for (const call of calls) {
      if (aborted(input.signal)) return finish('aborted', round);
      emit({ type: 'tool_call', call: pendingCall(call.name, call.id, call.args), status: 'start', round });

      const def = toolMap.get(call.name);
      let result: ToolResult;
      let rawDetail = '';
      if (!def) {
        result = {
          ok: false,
          code: 'UNKNOWN_TOOL',
          brief: '没有这个工具：' + call.name,
          detail: '未知工具「' + call.name + '」。可用工具：' + specs.map(spec => spec.name).join('、'),
        };
      } else {
        try {
          // 一律走流水线：before 守卫可以短路，def.run 有超时，after 守卫改结果
          result = await runToolPipeline({
            def,
            args: call.args,
            ctx: input.context,
            guards,
            round,
            onRawResult: raw => {
              rawDetail = typeof raw?.detail === 'string' ? raw.detail : '';
            },
          });
        } catch (error) {
          if (isAbortError(error) || aborted(input.signal)) return finish('aborted', round);
          result = {
            ok: false,
            code: 'TOOL_ERROR',
            brief: '工具执行出错：' + call.name,
            detail:
              '工具「' + call.name + '」执行时抛错：' + errorMessage(error) + '\n换个参数或先 wb_read 看清楚再试。',
          };
        }
      }
      if (aborted(input.signal)) return finish('aborted', round);

      const record: ToolCall = {
        id: call.id,
        name: call.name,
        args: call.args,
        ok: result.ok,
        brief: result.brief || (result.ok ? '完成' : '失败'),
        detail: result.detail,
        images: result.images?.slice() ?? [],
        at: nowMs(),
      };
      emit({
        type: 'tool_call',
        call: record,
        status: 'done',
        round,
        ...(result.code ? { code: result.code } : {}),
        ...(result.contexts?.length ? { contexts: result.contexts } : {}),
        ...(result.pruned ? { pruned: result.pruned } : {}),
        ...(result.pruned ? { raw_detail: rawDetail } : {}),
      });

      const toolTurn: Turn = {
        id: uid('turn'),
        role: 'tool',
        text: '',
        images: record.images,
        calls: [record],
        at: nowMs(),
      };
      turns.push(toolTurn);
      emit({ type: 'turn', turn: toolTurn });

      // 只有给模型的这份修剪；call.detail 保留原文（会话日志 / 记录页 / 导出读它）
      messages.push({
        role: 'tool',
        tool_call_id: record.id,
        content: pruneForModel((record.ok ? '' : '[工具执行失败] ') + (record.detail || record.brief || '(空结果)')),
      });
      if (result.contexts?.length) {
        // 守卫的附加建议：一条带来源前缀的合成 user 消息，工具结果本体一字不改
        messages.push({
          role: 'user',
          content: result.contexts
            .map(note => '【' + note.source + '】' + (note.summary ? note.summary + '\n' : '') + note.text)
            .join('\n\n'),
        });
      }
      if (record.images.length) {
        messages.push({
          role: 'user',
          content: '（工具 ' + record.name + ' 生成的图，共 ' + record.images.length + ' 张）',
          images: record.images.slice(),
        });
      }

      if (call.name === 'submit' && record.ok) {
        submitted = true;
        submitResult = record.detail || record.brief;
      }
    }
    if (submitted) return finish('submit', round);
  }

  return finish('max_rounds', maxRounds);
}

/** 把最后一条 assistant 的发言文本取出来（UI 有时只要这个） */
export function lastAssistantText(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant' && turns[i].text.trim()) return turns[i].text;
  }
  return '';
}

/** 本次跑了多少张图（UI 摘要用） */
export function countImages(turns: Turn[]): number {
  let total = 0;
  for (const turn of turns) {
    for (const call of turn.calls) total += call.images.length;
  }
  return total;
}
