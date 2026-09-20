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
  '用户需求', '世界书', '已选条目', '角色名',
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

/**
 * 只替换我们的宏。
 *
 * ⚠️ 阶段 3 起 `角色列表` / `图片元数据` 已从 OUR_MACROS 移除（改由苍玄助手插件贡献），
 * ⚠️ `角色列表` / `图片元数据` **不在这里**：它们随苍玄助手插件走，」关掉即消失「必须对它俩也成立。
 *
 * 曾经为了「兼容老预设」把它们留在这张表里 —— 那是个真 bug：底座无条件先替换，
 * 等插件那层想按「插件关了回空串」处理时**占位符早被换成真值了**，于是关掉插件后
 * 老预设里还会泄漏真实的角色列表 / 立绘元数据（验收 F-V1）。
 * 现在这两个宏完全由插件贡献；插件关掉 → 走 applyPluginMacros 的「名字在清单、renderer 不在」
 * 分支 → 渲染成空串。既守住「关掉即消失」，老预设也不会看到裸露的占位符。
 */
export function applyOwnMacros(text: string, d: MacroData): string {
  const table: Record<string, string> = {
    用户需求: d.demand,
    世界书: d.worldbook,
    已选条目: d.entries,
    角色名: d.character_name,
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

/**
 * 完整渲染：酒馆宏 → 我们的宏 → **插件贡献的宏**。
 *
 * 插件宏从哪来：core 不认识任何插件，所以用一个**注册口**反着接 ——
 * plugins/builtin 启动时把「当前启用插件贡献的宏」注册进来（见 registerPluginMacroSource）。
 * 这样依赖方向仍然是 plugins → core，而「关掉即消失」也成立：
 * 关掉插件 → 注册源里就没有它的宏 → 渲染退回空串。
 */
export function render(text: string, d: MacroData): string {
  return applyPluginMacros(applyOwnMacros(applyStMacros(text), d), d);
}

/* ============================ 插件贡献的宏（阶段 3） ============================ */

/** 插件宏渲染函数：拿到底座宏上下文，返回替换文本 */
export type PluginMacroRenderer = (name: string, data: MacroData) => string | undefined;

let pluginMacroSource: PluginMacroRenderer | null = null;

/**
 * 注册「插件宏」来源。
 *
 * 传 null 注销（测试用）。同一个进程只该有一个来源，后注册的覆盖前者。
 */
export function registerPluginMacroSource(source: PluginMacroRenderer | null): void {
  pluginMacroSource = source;
}

/** 收集插件声明的全部宏名（没来源就空）——界面列宏清单时用 */
export function pluginMacroNames(): string[] {
  if (!pluginMacroSource) return [];
  return pluginMacroNamesSource;
}

let pluginMacroNamesSource: string[] = [];

/**
 * 插件宏名清单（跟 renderer 一起注册）。
 *
 * ⚠️ 名字清单与 renderer **分开**存是故意的：插件被**停用**时它的宏名还在清单里
 * （renderer 返回空串 → 占位符被替换成空串，老预设不会看到裸露的 {{图片提示词}}）；
 * 只有「从来没装过任何插件」才会连名字都不知道，那时占位符原样留着。
 */
export function registerPluginMacroNames(names: string[]): void {
  pluginMacroNamesSource = names.slice();
}

/** 换掉插件贡献的宏；插件的 renderer 返回 undefined = 这个宏不归它 */
/** 注意：拿不到值（插件关了 / 没数据）一律替换成空串 —— 老预设写了这个宏也不该报错 */
function applyPluginMacros(text: string, d: MacroData): string {
  if (!pluginMacroNamesSource.length) return text;
  let out = text;
  for (const name of pluginMacroNamesSource) {
    const token = '{{' + name + '}}';
    if (out.indexOf(token) < 0) continue;
    // renderer 不在（插件被停用 / 还没注册）= 这个宏没有来源 → 空串。
    // 判据是「名字在清单里」而不是「renderer 在」：停用插件时名字仍在，
    // 所以 {{图片提示词}} 会被替换成空串，而不是留下一个裸露的占位符。
    let value = '';
    if (pluginMacroSource) {
      try {
        value = pluginMacroSource(name, d) ?? '';
      } catch (err) {
        console.warn('[苍玄助手] 插件宏 ' + name + ' 渲染失败，按空串处理', err);
        value = '';
      }
    }
    out = out.split(token).join(value);
  }
  return out;
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