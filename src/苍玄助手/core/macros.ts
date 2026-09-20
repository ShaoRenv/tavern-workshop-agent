/**
 * 宏替换。顺序很重要：**先过酒馆自己的宏引擎，再换我们的自定义宏**。
 * 这样 {{roll}} {{user}} {{char}} {{time}} 这些酒馆宏白嫖，我们只管自己那几个。
 */
import type { Turn } from './types.ts';

export interface MacroData {
  /** 用户在输入框里写的 */
  demand: string;
  /** 勾选的世界书全文 */
  worldbook: string;
  /** 勾选的条目 */
  entries: string;
  /** 勾选的角色 + 立绘元数据 */
  characters: string;
  /** 当前角色名（单角色时用） */
  character_name: string;
  /** 当前角色立绘里抽出的原始文本 */
  portrait_meta: string;
  /** 本会话之前的轮次 */
  history: string;
  /** 已经生成好的产物 */
  artifact: string;
  /** 还没做完的 */
  remaining: string;
  /** 第几轮（从 0 起） */
  round: number;
  /** 本轮有没有带图 */
  has_image: boolean;
}

export function emptyMacroData(): MacroData {
  return {
    demand: '', worldbook: '', entries: '', characters: '', character_name: '',
    portrait_meta: '', history: '', artifact: '', remaining: '', round: 0, has_image: false,
  };
}

/**
 * 我们自己的宏名（不含花括号）。
 *
 * ⚠️ `上下文` 已经**弃用**（v4，reports/苍玄助手-预设与上下文.md 一）：
 * 新预设不要用它，上下文改用预设里的「上下文」特殊层，运行时原生展开成真正的消息。
 * 这里保留渲染能力只为兼容老预设 —— 老预设里写了它不至于报错 / 变空。
 */
export const OUR_MACROS = [
  '用户需求', '世界书', '已选条目', '角色列表', '角色名', '图片元数据',
  '上下文', '产物', '未完成', '轮数', '截图', '当前时间',
] as const;

type StGlobals = { substitudeMacros?: (text: string) => string };

/** 过一遍酒馆宏；宿主没有就原样返回（测试环境也能跑） */
export function applyStMacros(text: string): string {
  const g = globalThis as unknown as StGlobals;
  if (typeof g.substitudeMacros !== 'function') return text;
  try {
    return g.substitudeMacros(text);
  } catch (err) {
    console.warn('[苍玄助手] 酒馆宏替换失败，原样使用', err);
    return text;
  }
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function today(): string {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 只替换我们的宏 */
export function applyOwnMacros(text: string, d: MacroData): string {
  const table: Record<string, string> = {
    用户需求: d.demand,
    世界书: d.worldbook,
    已选条目: d.entries,
    角色列表: d.characters,
    角色名: d.character_name,
    图片元数据: d.portrait_meta,
    上下文: d.history,
    产物: d.artifact,
    未完成: d.remaining,
    轮数: String(d.round),
    截图: '',
    当前时间: today(),
  };
  let out = text;
  for (const key of Object.keys(table)) {
    out = out.split('{{' + key + '}}').join(table[key]);
  }
  return out;
}

/** 完整渲染：酒馆宏 → 我们的宏 */
export function render(text: string, d: MacroData): string {
  return applyOwnMacros(applyStMacros(text), d);
}

/** 这条消息文本里有没有我们的宏 */
export function usedMacros(text: string): string[] {
  const hit: string[] = [];
  for (const key of OUR_MACROS) {
    if (text.indexOf('{{' + key + '}}') >= 0) hit.push(key);
  }
  return hit;
}

/**
 * 历史转成文本（`{{上下文}}` 用）。
 *
 * @deprecated v4 起**弃用**：纯文本上下文是给「文本化适配」准备的，那条路不走了。
 * 新预设请用预设里的「上下文」特殊层（runner 会复用 agent/loop.ts 的 turnsToMessages
 * 原生展开成真正的消息，角色分明、不加【用户】前缀）。
 * 这个函数**不删**：老预设万一用过 `{{上下文}}`，渲染能力留着才不至于炸。
 *
 * 还在用的地方：run/runner.ts 的 buildMacroData（喂 {{上下文}} 宏）与
 * triggerWordsPass（拿最近 4 轮当触发词匹配的语料）。
 */
export function formatHistory(turns: Turn[], limit: number): string {
  const use = limit > 0 ? turns.slice(-limit) : turns;
  const out: string[] = [];
  for (const t of use) {
    const who = t.role === 'user' ? '用户' : t.role === 'assistant' ? '助手' : '工具';
    const body = t.text.trim();
    if (body) out.push('【' + who + '】' + body);
    for (const c of t.calls) {
      out.push('【工具】' + c.name + ' → ' + c.brief);
    }
  }
  return out.join('\n\n');
}

/** 条目数组转文本 */
export function formatEntries(rows: { name: string; content: string }[]): string {
  return rows.map((r) => '==== ' + r.name + ' ====\n' + r.content).join('\n\n');
}