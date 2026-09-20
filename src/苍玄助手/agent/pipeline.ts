/**
 * 工具流水线：能力（ToolDef.run）与横切策略（ToolGuard）分开。
 *
 *   before（按注册顺序）→ def.run（带超时）→ after（按注册顺序）
 *
 *  - before 返回 ToolResult 就短路，不再执行 def.run；
 *  - def.run 抛错 → { ok:false, code:'TOOL_ERROR' }；
 *  - def.timeoutMs（或被工具页覆盖的 timeout_ms）用 Promise.race 包，超时 → code:'TIMEOUT'；
 *  - after 依次跑并替换结果（守卫不认识具体工具，只认 name / args / ctx / round）。
 */
import type { ToolContext, ToolDef, ToolGuard, ToolResult } from '../core/ports.ts';

export interface ToolPipelineInput {
  def: ToolDef;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** 守卫（按顺序跑）；不传 = 没有 */
  guards?: ToolGuard[];
  /** 第几轮（1 起） */
  round: number;
  /** def.run / 错误兜底之后的**原始结果**（after 守卫跑之前）；循环拿它记会话日志 */
  onRawResult?: (result: ToolResult) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 工具页覆盖的超时优先于工具自带 */
export function effectiveTimeoutMs(def: ToolDef, ctx: ToolContext): number {
  const override = ctx.tool_overrides?.[def.name]?.timeout_ms;
  if (typeof override === 'number' && override > 0) return override;
  return typeof def.timeoutMs === 'number' && def.timeoutMs > 0 ? def.timeoutMs : 0;
}

function timeoutResult(name: string, ms: number): ToolResult {
  return {
    ok: false,
    code: 'TIMEOUT',
    brief: '工具超时：' + name,
    detail: '工具「' + name + '」超过 ' + ms + ' 毫秒没返回，已经中止。换个更小的范围再试，或者直接收工。',
  };
}

async function runWithTimeout(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const timeoutMs = effectiveTimeoutMs(def, ctx);
  if (!timeoutMs) return await def.run(args, ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(() => def.run(args, ctx));
  // 输掉竞速的那一边如果晚点才 reject，别让它变成 unhandled rejection
  running.catch(() => undefined);
  try {
    return await Promise.race([
      running,
      new Promise<ToolResult>(resolve => {
        timer = setTimeout(() => resolve(timeoutResult(def.name, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 统一结果形状：守卫/工具可能只填了一部分 */
function normalize(result: ToolResult): ToolResult {
  const ok = !!result?.ok;
  const brief = typeof result?.brief === 'string' && result.brief ? result.brief : ok ? '完成' : '失败';
  const detail = typeof result?.detail === 'string' ? result.detail : brief;
  const next: ToolResult = { ok, brief, detail };
  // 只搬运工具/守卫自己给的分类；抛错和超时上面已经显式写了 code，不替它们编
  if (result?.code) next.code = result.code;
  if (result?.contexts?.length) next.contexts = result.contexts;
  if (result?.pruned) next.pruned = result.pruned;
  if (result?.images?.length) next.images = result.images;
  return next;
}

export async function runToolPipeline(input: ToolPipelineInput): Promise<ToolResult> {
  const exec = { name: input.def.name, args: input.args, ctx: input.ctx, round: input.round };
  const guards = input.guards ?? [];

  for (const guard of guards) {
    if (!guard.before) continue;
    const short = await guard.before(exec);
    if (short) return normalize(short);
  }

  let result: ToolResult;
  try {
    result = await runWithTimeout(input.def, input.args, input.ctx);
  } catch (error) {
    result = {
      ok: false,
      code: 'TOOL_ERROR',
      brief: '工具执行出错：' + input.def.name,
      detail:
        '工具「' + input.def.name + '」执行时抛错：' + errorMessage(error) + '\n换个参数或先 wb_read 看清楚再试。',
    };
  }
  input.onRawResult?.(result);

  let current = result;
  for (const guard of guards) {
    if (!guard.after) continue;
    current = await guard.after(exec, current);
  }
  return normalize(current);
}
