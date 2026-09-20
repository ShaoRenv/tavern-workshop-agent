/**
 * 跑一次生成 / 跑一次 Agent 会话。
 *
 * 契约（**别改这个签名**，App.vue 直接依赖）：
 *  - 这里不碰 store，一切通过参数进出，方便单测
 *  - runPlain：普通预设，按 items 渲染一次消息序列 → 请求 → 抠 JSON → 回一个 Turn
 *  - runAgent：Agent 预设，标准工具循环，每步通过回调吐给 UI
 *  - v4：预设本体统一是 `preset.items`（普通消息 + 特殊层）；特殊层里的上下文复用
 *    agent/loop.ts 的 turnsToMessages **原生展开**，不再走 formatHistory 的文本转写
 *  - v4：两级能力启用见 core/types.ts 的 resolveCaps
 *    （use_global_caps = 跟随全局 / 只用预设自己的；isAgentPreset 也按解析后的工具集判）
 *  - 草稿只落不进库，saveDrafts() 才 writeAll 落地
 *
 * 实现里会用到的现成件：
 *  agent/loop.ts runAgentLoop / turnsToMessages / toToolSpecs
 *  agent/transport.ts createTransport / LlmTransport
 *  agent/registry.ts createRegistry
 *  agent/draft.ts DraftStore
 *  core/macros.ts render() 先替酒馆宏再替我们的宏
 *  core/worldbook.ts createWorldbookPort()
 *
 * 实现约定（写给接线的人）：
 *  1. 用户轮次不重复记：App 在 onSend 里已经把这条用户消息 append 进 session.turns 了
 *     （history 里就有），所以只有当 history 末尾不是同一条用户消息时，runner 才 onTurn 补一条。
 *  2. 工具卡挂在 **assistant 轮次的 calls** 上（ChatView 对每条 turn 都渲染 turn.calls，
 *     再单独发 tool 轮次会重复出卡）。工具跑的时候 runner 就地改那几个 call 对象并调
 *     onToolUpdate(turnId, callIndex, call)；tool 轮次不透传，但 history 转写仍合法
 *     —— loop.ts 的 turnsToMessages 会从 assistant 的 calls 里重建 tool 消息。
 *  3. 草稿镜像进 args.data.drafts（UI 的草稿条/diff 弹窗读的是 RootData.drafts），
 *     DraftStore 本体在 createRunner() 里建一次、长期持有，saveDrafts() 才有东西可应用。
 */
import { createDraftStore, describeChange, formatDiff } from '../agent/draft.ts';
import { runAgentLoop, turnsToMessages, type AgentLoopResult, type LoopEvent } from '../agent/loop.ts';
import { createRegistry, resolveToolDefs } from '../agent/registry.ts';
import { skillCatalogText } from '../agent/tools_skill.ts';
import { buildScopePrompt } from '../agent/tools_worldbook.ts';
import { createTransport } from '../agent/transport.ts';
import { createDraftView } from '../agent/wb_view.ts';
import type { LlmMessage, ToolOverrideMap, WorldbookPort } from '../core/ports.ts';
import { pluginAllTools, toolOwner } from '../plugins/registry.ts';
import type { PluginStateHost } from '../plugins/types.ts';
import { emptyMacroData, formatEntries, formatHistory, render, type MacroData } from '../core/macros.ts';
import {
  nowMs,
  pickActiveSession,
  resolveCaps,
  uid,
  type Artifact,
  type Preset,
  type PresetItem,
  type PresetMessage,
  type RootData,
  type Skill,
  type Turn,
} from '../core/types.ts';
import { createWorldbookPort } from '../core/worldbook.ts';

export interface RunArgs {
  data: RootData;
  /** 本轮用户说的话（普通预设时就是用户需求） */
  input: string;
  /** 本轮附的图（dataURL） */
  images?: string[];
  preset: Preset;
  /** 已经有的轮次，Agent 续跑时用 */
  history: Turn[];
  signal: AbortSignal;
  /** 新的一轮（用户或助手或工具结果） */
  onTurn: (turn: Turn) => void;
  /** 某个轮次里的工具卡更新了（开始/结束） */
  onToolUpdate: (turnId: string, callIndex: number, call: Turn['calls'][number]) => void;
  /**
   * 流式增量（可选）：原生通道逐段吐，文本通道**不发声**。
   * turnId 就是已经通过 onTurn 发出去的那条 assistant 轮次，UI 直接往它上面追加就行。
   */
  onDelta?: (turnId: string, delta: string) => void;
  /** 检测到产物 */
  onArtifact: (artifact: Artifact) => void;
  /** 提示（例如「这轮走的文本通道」） */
  onNotice: (text: string) => void;
  /**
   * 生图：交给插件层注入（插件没开 / 没配好时这里是 undefined，
   * gen_image 会直接回一句「生图接口没接上」，不会瞎发请求）。
   * 一次调用出一张，张数由 tools_image 那边循环 + 插件页的「一次最多几张」封顶。
   */
  genImage?: (prompt: string, negative: string) => Promise<string[]>;
}

export interface RunResult {
  turns: Turn[];
  /** 用的是哪个通道 */
  via: 'native' | 'text';
  /** 有没有跑完 */
  done: boolean;
}

export interface Runner {
  runPlain(args: RunArgs): Promise<RunResult>;
  runAgent(args: RunArgs): Promise<RunResult>;
  /** 草稿落地：把草稿写回世界书 */
  saveDrafts(): Promise<{ applied: number; failed: number }>;
  /** 草稿导出成 diff 文本 */
  exportDrafts(): string;
  /** 丢弃草稿 */
  dropDrafts(): void;
  /** 草稿条数 */
  draftCount(): number;
}

/* ============================ 小工具 ============================ */

const HISTORY_LIMIT = 12;
const ENTRY_TEXT_LIMIT = 200_000;
const ENTRY_UID_LIMIT = 60;

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function stamp(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes())
  );
}

/** 整段/围栏/第一个平衡块，三种姿势抠 JSON */
function extractJson(text: string): { value: unknown; raw: string } | null {
  const source = String(text ?? '').trim();
  if (!source) return null;
  const direct = tryParseJson(source);
  if (direct) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fence) {
    const inner = tryParseJson(fence[1].trim());
    if (inner) return inner;
  }
  for (const pair of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = source.indexOf(pair[0]);
    if (start < 0) continue;
    const end = balancedEnd(source, start, pair[0], pair[1]);
    if (end > start) {
      const hit = tryParseJson(source.slice(start, end + 1));
      if (hit) return hit;
    }
  }
  return null;
}

function tryParseJson(text: string): { value: unknown; raw: string } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object') return null;
    return { value, raw: text };
  } catch {
    return null;
  }
}

/** 从 open 位置找配对的 close，字符串和转义都跳过 */
function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ============================ 宏数据 ============================ */

/**
 * 拼 MacroData。拿得到的就填，拿不到留空串：
 *  - 世界书 = 本轮选中的世界书名（Agent 的读写范围；正文靠工具读，不塞提示词）
 *  - 已选条目 = 选中条目的正文（走 WorldbookPort 读，失败就空串）
 *  - 角色列表 / 角色名 = selection.character_ids
 *  - 上下文 = history 转文本；产物 = 最近一个产物
 */
/**
 * 这一轮**真正可用**的工具定义：底座自己的全给，插件注册的只在「插件开着」时给。
 *
 * 「关掉即消失」有三层，缺一层就露馅（验收 F-A）：
 *   ① 界面 —— App.vue 用 pluginTools / pluginAllTools 算清单与来源标签；
 *   ② 显示用能力 —— App.vue 的 globalCaps；
 *   ③ **运行时这一层**（这里）：关掉的插件，它的工具连 ToolDef 都不进这一轮，
 *      否则模型照样能调、界面却写着「来源已停用」，两边打脸。
 *
 * 注意用 pluginAllTools（插件注册的全部工具）而不是 pluginTools：
 * 按需工具（世界书的 entry_meta）_def_ 要在，能不能发由 resolveCaps 按 default_on 决定。
 */
export function liveToolDefs<T extends { name: string }>(defs: T[], state: PluginStateHost): T[] {
  const fromPlugins = new Set(pluginAllTools(state));
  return defs.filter(def => toolOwner(def.name) === 'base' || fromPlugins.has(def.name));
}
async function buildMacroData(
  args: RunArgs,
  extra: { round: number; hasImage: boolean; artifact?: string },
  port: WorldbookPort | null,
): Promise<MacroData> {
  const data = emptyMacroData();
  const selection = args.data.selection;
  data.demand = args.input ?? '';
  data.round = extra.round;
  data.has_image = extra.hasImage;
  data.worldbook = selection.worldbook_names.join('、');
  data.entries = await loadEntriesText(args.data, port);
  data.characters = selection.character_ids.join('、');
  data.character_name = selection.character_ids.length === 1 ? selection.character_ids[0] : '';
  data.history = formatHistory(args.history, HISTORY_LIMIT);
  data.artifact = extra.artifact ?? lastArtifactText(args.data);
  return data;
}

async function loadEntriesText(data: RootData, port: WorldbookPort | null): Promise<string> {
  const uids = data.selection.entry_uid.slice(0, ENTRY_UID_LIMIT);
  const worlds = data.selection.worldbook_names;
  if (!port || !uids.length || !worlds.length) return '';
  try {
    const rows: { name: string; content: string }[] = [];
    for (const world of worlds) {
      const found = await port.readByUid(world, uids);
      for (const entry of found) rows.push({ name: entry.name, content: entry.content });
    }
    if (!rows.length) return '';
    const text = formatEntries(rows);
    return text.length > ENTRY_TEXT_LIMIT ? text.slice(0, ENTRY_TEXT_LIMIT) + '\n…（已选条目太长，截断了）' : text;
  } catch (error) {
    console.warn('[苍玄助手] 读已选条目失败，{{已选条目}} 留空', error);
    return '';
  }
}

function lastArtifactText(data: RootData): string {
  const last = data.artifacts[data.artifacts.length - 1];
  return last ? last.data.slice(0, 20_000) : '';
}

/* ============================ 触发条件（只对普通消息条目生效） ============================ */

function triggerPass(message: PresetMessage, args: RunArgs, hasImage: boolean, hasAssistant: boolean): boolean {
  switch (message.trigger) {
    case 'has_worldbook':
      return args.data.selection.worldbook_names.length > 0;
    case 'has_portrait':
      return args.data.selection.character_ids.length > 0;
    case 'has_image':
      return hasImage;
    case 'first_round':
      return !hasAssistant;
    case 'not_first_round':
      return hasAssistant;
    default:
      return true;
  }
}

function triggerWordsPass(message: PresetMessage, args: RunArgs): boolean {
  const words = message.trigger_words
    .split(/[,，\n]/)
    .map(word => word.trim())
    .filter(Boolean);
  if (!words.length) return true;
  const haystack = (args.input + '\n' + formatHistory(args.history, 4)).toLowerCase();
  return words.some(word => haystack.includes(word.toLowerCase()));
}

/* ============================ 预设 items → 消息序列 ============================ */

interface BodyBuild {
  /** items 渲染出来的消息（特殊层已就地展开；不含追加的系统段、不含隐式历史） */
  messages: LlmMessage[];
  /** 本轮用户需求已经在序列里了（{{用户需求}} 宏渲染进去了，或有 user 特殊层） */
  demandPlaced: boolean;
  /** 有启用的「上下文」特殊层：历史已经由它原生展开，不要再补一次 */
  hasContextLayer: boolean;
}

/**
 * 预设本体（items）→ 消息序列。
 *
 * 逐条按顺序处理：
 *  - `{type:'message'}`：启用 / 触发条件过滤 → 渲染宏 → push（content 空的跳过）
 *  - `{type:'special', kind:'context'}`：**原生展开**当前会话历史
 *    （复用 agent/loop.ts 的 turnsToMessages，按原角色插在这个位置）
 *  - `{type:'special', kind:'user'}`：展开成一条 `role:'user'` 的消息，
 *    内容就是 {{用户需求}} 的取值（= 本轮 input）
 *
 * 纯函数（历史转写是纯的），除了 render。
 */
function buildItemMessages(args: RunArgs, macroData: MacroData, hasImage: boolean): BodyBuild {
  const hasAssistant = args.history.some(turn => turn.role === 'assistant');
  const demand = (args.input ?? '').trim();
  const messages: LlmMessage[] = [];
  let demandPlaced = false;
  let hasContextLayer = false;

  for (const item of (args.preset.items ?? []) as PresetItem[]) {
    if (!item.enabled) continue;

    if (item.type === 'special') {
      if (item.kind === 'user') {
        if (demand === '') continue;
        demandPlaced = true;
        // 上一条已经是同一条需求就不再补：预设里同时放了「上下文」+「用户需求」时，
        // 历史末尾那条就是本轮需求（界面先把它记进 turns 了），补一条一模一样的会变成两条。
        if (!isDemandUserMessage(messages[messages.length - 1], demand)) {
          messages.push({ role: 'user', content: args.input });
        }
      } else {
        hasContextLayer = true;
        messages.push(...turnsToMessages(args.history));
      }
      continue;
    }

    if (!triggerPass(item, args, hasImage, hasAssistant)) continue;
    if (!triggerWordsPass(item, args)) continue;
    if (item.content.includes('{{用户需求}}')) demandPlaced = true;
    const content = render(item.content, macroData);
    if (!content.trim()) continue;
    // 本体里已经把这一轮的话写进去了（宏或原文），就不要再补一条 user
    if (demand !== '' && content.includes(demand)) demandPlaced = true;
    messages.push({ role: item.role, content });
  }

  return { messages, demandPlaced, hasContextLayer };
}

/** 这条消息是不是「就是本轮用户需求」的那条 user 消息 */
function isDemandUserMessage(message: LlmMessage | undefined, demand: string): boolean {
  return !!message && message.role === 'user' && message.content === demand;
}

/** 序列开头连续有几条 system（追加的系统段插在这后面） */
function leadingSystemCount(messages: LlmMessage[]): number {
  let count = 0;
  while (count < messages.length && messages[count].role === 'system') count++;
  return count;
}

/**
 * 普通预设：预设本体 + 补最后一条用户输入。
 *
 * 和 v3 的区别只有一个：本体从 `preset.messages` 换成了 `preset.items`（可含特殊层）。
 * 这里**不隐式塞历史** —— 普通预设要历史就在预设里放一个「上下文」特殊层。
 */
function buildPlainMessages(args: RunArgs, macroData: MacroData, hasImage: boolean): LlmMessage[] {
  const built = buildItemMessages(args, macroData, hasImage);
  const messages = built.messages;
  const input = (args.input ?? '').trim();
  const inputInMessages = input !== '' && messages.some(msg => msg.content.includes(input));
  if (input && !built.demandPlaced && !inputInMessages) messages.push({ role: 'user', content: args.input });
  return messages;
}

function makeArtifact(preset: Preset, found: { value: unknown; raw: string }): Artifact {
  const kind = preset.output === 'worldbook' ? 'worldbook' : 'json';
  return {
    id: uid('artifact'),
    kind,
    name: (preset.name || '苍玄助手') + '-' + stamp() + '.json',
    data: JSON.stringify(found.value, null, 2),
    at: nowMs(),
  };
}

/** history 末尾已经是同一条用户消息就算了（App 在 onSend 里已经记过） */
function pendingUserTurn(args: RunArgs): Turn | null {
  const text = (args.input ?? '').trim();
  if (!text) return null;
  const last = args.history.length ? args.history[args.history.length - 1] : null;
  if (last && last.role === 'user' && last.text.trim() === text) return null;
  return {
    id: uid('turn'),
    role: 'user',
    text: args.input,
    images: args.images?.slice() ?? [],
    calls: [],
    at: nowMs(),
  };
}

/* ============================ Agent 预设 ============================ */

/**
 * 追加的三条系统段（文案与相对顺序**不要改**）：
 *  - 本次可操作范围（能读改哪些世界书；不说清楚模型就会瞎试）
 *  - 轮数预算（让它自己规划：先读、只改该改的、做完 submit）
 *  - 技能清单（只有名字和一句话描述）
 */
async function buildSystemBlocks(skills: Skill[], worlds: string[], wb: WorldbookPort, maxRounds: number): Promise<LlmMessage[]> {
  const blocks: LlmMessage[] = [
    // 范围静态写死：只出现范围内的世界书名 + 实际条目数/启用数，范围外的一个字都不写
    { role: 'system', content: '# 本次可操作范围\n' + (await buildScopePrompt(wb, worlds)) },
    {
      role: 'system',
      content:
        '# 轮数预算\n你最多有 ' +
        maxRounds +
        ' 轮（每请求一次模型算一轮）。请规划好：先读要改的条目，只改该改的地方，做完调 submit 收工。',
    },
  ];
  if (skills.length) {
    blocks.push({
      role: 'system',
      content:
        '# 可用技能\n需要专门手法时，先调 skill("名字") 读它的正文，再按里面的规矩干活。\n' + skillCatalogText(skills),
    });
  }
  return blocks;
}

/**
 * Agent 预设的完整前缀 = 预设本体（items，特殊层就地展开）
 *                       + 三条系统段（插在开头那段连续 system 后面）
 *                       + 历史（预设里没放「上下文」特殊层时补上，别把对话记忆弄丢）
 *
 * 形状（顺序不能乱）：
 *   system(预设自己的) → system(# 本次可操作范围) → system(# 轮数预算) → system(# 可用技能)
 *   → 上下文特殊层展开的原生历史 / 隐式历史 → user(本轮需求) → agent 循环自己追加的…
 */
async function buildAgentPrefix(
  args: RunArgs,
  macroData: MacroData,
  skills: Skill[],
  worlds: string[],
  wb: WorldbookPort,
  maxRounds: number,
  hasImage: boolean,
): Promise<{ prefix: LlmMessage[]; demandPlaced: boolean }> {
  const body = buildItemMessages(args, macroData, hasImage);
  const at = leadingSystemCount(body.messages);
  const blocks = await buildSystemBlocks(skills, worlds, wb, maxRounds);
  // 有「上下文」特殊层就以它为准（它已经把历史原生展开了），否则在系统段后面补一次
  const history = body.hasContextLayer ? [] : turnsToMessages(args.history);
  return {
    prefix: [...body.messages.slice(0, at), ...blocks, ...history, ...body.messages.slice(at)],
    demandPlaced: body.demandPlaced,
  };
}

function attachSkill(
  data: RootData,
  draft: { name: string; summary: string; body: string; files: { name: string; content: string }[] },
): void {
  const skill: Skill = {
    id: uid('skill'),
    name: draft.name,
    summary: draft.summary,
    body: draft.body,
    files: draft.files.map(file => ({ name: file.name, content: file.content })),
    enabled: false,
    builtin: false,
  };
  data.skills.push(skill);
}

/* ============================ Runner ============================ */

export function createRunner(): Runner {
  /** 长期持有的草稿仓：runAgent 往里写，saveDrafts() 才落地 */
  const drafts = createDraftStore();
  let lastData: RootData | null = null;
  let port: WorldbookPort | null = null;
  let view: WorldbookPort | null = null;

  /** 真实端口：只给 saveDrafts() 落地用 */
  const getPort = (): WorldbookPort => {
    if (!port) port = createWorldbookPort();
    return port;
  };

  /** 草稿视图：工具层读写都走它（读到的就是「改后」的样子） */
  const getView = (): WorldbookPort => {
    if (!view) view = createDraftView(getPort(), drafts);
    return view;
  };

  /** v3 起真正的会话在 sessions[] 里；根上的 session 只是兼容壳 */
  const liveSession = (data: RootData): RootData['session'] => {
    const session = pickActiveSession(data);
    return data.sessions.includes(session) ? session : data.session;
  };

  const liveSessionId = (data: RootData): string => {
    const session = liveSession(data);
    return typeof session?.id === 'string' ? session.id : '';
  };

  const liveTurns = (data: RootData): Turn[] => liveSession(data).turns;

  /** 草稿镜像进 RootData.drafts，界面草稿条/diff 弹窗读的就是它 */
  const syncDrafts = (target: RootData | null): void => {
    if (!target) return;
    try {
      target.drafts = drafts.list();
    } catch (error) {
      console.warn('[苍玄助手] 草稿同步到界面失败', error);
    }
  };

  return {
    async runPlain(args: RunArgs): Promise<RunResult> {
      lastData = args.data;
      const hasImage = !!args.images?.length;
      const macroData = await buildMacroData(args, { round: 0, hasImage }, getPort());
      const messages = buildPlainMessages(args, macroData, hasImage);
      if (!messages.length) throw new Error('这个普通预设一条要发的消息都没有（检查启用状态和触发条件）');

      const transport = createTransport({ onNotice: notice => args.onNotice(notice.message) });
      const reply = await transport.chat({ messages, settings: args.data.api, signal: args.signal });

      const turns: Turn[] = [];
      const userTurn = pendingUserTurn(args);
      if (userTurn) {
        turns.push(userTurn);
        args.onTurn(userTurn);
      }
      const assistantTurn: Turn = {
        id: uid('turn'),
        role: 'assistant',
        text: reply.text,
        images: [],
        calls: [],
        at: nowMs(),
      };
      turns.push(assistantTurn);
      args.onTurn(assistantTurn);

      if (args.preset.output !== 'none') {
        const found = extractJson(reply.text);
        if (found) args.onArtifact(makeArtifact(args.preset, found));
        else args.onNotice('这次回复里没有可解析的 JSON，没有产物（预设要求产出 ' + args.preset.output + '）');
      }
      return { turns, via: reply.via, done: !args.signal.aborted };
    },

    async runAgent(args: RunArgs): Promise<RunResult> {
      lastData = args.data;
      const hasImage = !!args.images?.length;
      const port = getPort();
      // 工具层用草稿视图：create 后能立刻 edit、同条二次编辑不丢改动、改完 wb_read 看到新内容
      const view = getView();
      drafts.setSessionId(liveSessionId(args.data));
      const macroData = await buildMacroData(args, { round: 0, hasImage }, port);
      const registry = createRegistry(view, {
        createSkill: draft => {
          attachSkill(args.data, draft);
          syncDrafts(args.data);
        },
      });
      // 守卫默认装上（observe + prune + repeat）；新用户消息 = 新一轮，先把计数和观察清零
      const guards = registry.guards();
      guards.reset();
      const overrides = (args.data.tool_overrides ?? {}) as ToolOverrideMap;
      const toolDefs = resolveToolDefs(liveToolDefs(registry.defs, args.data), overrides);
      const maxRounds = args.preset.max_rounds || args.data.gen.max_rounds;
      const transport = createTransport();
      // 两级能力：预设自己的 vs 跟随「能力」页的全局默认（口径 = core/types.ts 的 resolveCaps）
      const caps = resolveCaps(args.preset, { tools: toolDefs, skills: args.data.skills });
      const skills = caps.skills;
      const prefix = await buildAgentPrefix(
        args,
        macroData,
        skills,
        args.data.selection.worldbook_names,
        port,
        maxRounds,
        hasImage,
      );

      const forwarded: Turn[] = [];
      const callSlots = new Map<string, { turn: Turn; index: number }>();

      /**
       * 找这个 call 挂在哪条轮次的第几个位置。
       * 流式时 assistant 轮次先发出去、calls 是回复到了才挂上的，
       * 所以这里除了事件里登记的槽位，还要按 call id 在已发出的轮次里兜底找一次。
       */
      const resolveSlot = (callId: string): { turn: Turn; index: number } | null => {
        const known = callSlots.get(callId);
        if (known) return known;
        for (let i = forwarded.length - 1; i >= 0; i--) {
          const turn = forwarded[i];
          if (turn.role !== 'assistant' || !turn.calls.length) continue;
          const index = turn.calls.findIndex(call => call.id === callId);
          if (index >= 0) {
            const slot = { turn, index };
            callSlots.set(callId, slot);
            return slot;
          }
        }
        return null;
      };

      /**
       * 工具卡更新：先就地改 raw 对象（调用方手里的 turn 引用 / 单测能看到），
       * 再通过 args.data 的响应式代理把同一个下标重写一遍 —— 不这么做 Vue 收不到通知，
       * 卡片不会刷新、store 的 deep watch 也不会落盘。
       */
      const publishCall = (update: Turn['calls'][number]): void => {
        const slot = resolveSlot(update.id);
        if (!slot) return;
        const target = slot.turn.calls[slot.index];
        const merged = { ...(target ?? update), ...update } as Turn['calls'][number];
        Object.assign(target, update);
        let live: Turn['calls'][number] = target;
        try {
          const found = liveTurns(args.data).find(turn => turn.id === slot.turn.id);
          if (found && found.calls[slot.index]) {
            found.calls[slot.index] = merged;
            live = found.calls[slot.index];
          }
        } catch (error) {
          console.warn('[苍玄助手] 刷新界面工具卡失败', error);
        }
        args.onToolUpdate(slot.turn.id, slot.index, live);
      };

      const onEvent = (event: LoopEvent): void => {
        if (event.type === 'turn') {
          const turn = event.turn;
          if (turn.role === 'tool') return; // 工具卡挂 assistant 轮的 calls，避免重复出卡
          forwarded.push(turn);
          args.onTurn(turn);
          if (turn.role === 'assistant') {
            turn.calls.forEach((call, index) => callSlots.set(call.id, { turn, index }));
            if (args.preset.output === 'json' && turn.text) {
              const found = extractJson(turn.text);
              if (found) args.onArtifact(makeArtifact(args.preset, found));
            }
          }
          return;
        }
        if (event.type === 'delta') {
          // 原生通道的流式增量；文本通道不会发这个事件
          args.onDelta?.(event.turnId, event.text);
          return;
        }
        if (event.type === 'tool_call') {
          publishCall(event.call);
          if (event.status === 'done') syncDrafts(args.data);
          return;
        }
        if (event.type === 'notice') {
          args.onNotice(event.message);
          return;
        }
        if (event.type === 'round') {
          try {
            liveSession(args.data).round = event.round;
          } catch (error) {
            console.warn('[苍玄助手] 写 session.round 失败', error);
          }
        }
      };

      const input = (args.input ?? '').trim();
      const lastTurn = args.history.length ? args.history[args.history.length - 1] : null;
      const alreadyRecorded = input !== '' && !!lastTurn && lastTurn.role === 'user' && lastTurn.text.trim() === input;

      /**
       * 本轮用户消息：预设本体里已经放了（user 特殊层 / {{用户需求}} 宏）就不让循环再补一条，
       * 但**轮次记录不能少** —— 界面没记过（比如从立绘页直接跑）时这里自己补一条，
       * 顺序和循环一致：user 在最前面。
       */
      const loopUser = alreadyRecorded || prefix.demandPlaced ? undefined : args.input;
      if (!alreadyRecorded && prefix.demandPlaced) {
        const userTurn = pendingUserTurn(args);
        if (userTurn) {
          forwarded.push(userTurn);
          args.onTurn(userTurn);
        }
      }

      let result: AgentLoopResult;
      try {
        result = await runAgentLoop({
          transport,
          tools: toolDefs,
          enabled_tools: caps.tools,
          settings: args.data.api,
          system: '',
          prefix: prefix.prefix,
          user: loopUser,
          user_images: loopUser === undefined ? undefined : args.images?.slice(),
          context: {
            worlds: args.data.selection.worldbook_names.slice(),
            drafts,
            skills,
            observations: guards.observations,
            tool_overrides: overrides,
            genImage: args.genImage,
          },
          max_rounds: maxRounds,
          signal: args.signal,
          onEvent,
          guards: guards.guards,
        });
      } finally {
        syncDrafts(args.data);
      }

      if (result.reason === 'error') throw new Error(result.error || 'Agent 跑挂了');
      const via = result.via || transport.lastVia();
      return { turns: forwarded, via, done: result.reason === 'submit' || result.reason === 'no_tool_calls' };
    },

    async saveDrafts(): Promise<{ applied: number; failed: number }> {
      const report = await drafts.apply(getPort());
      syncDrafts(lastData);
      if (!report.ok) {
        const detail = report.worlds
          .filter(item => !item.ok)
          .map(item => item.world + '：' + (item.error || '写回失败'))
          .join('；');
        console.warn('[苍玄助手] 草稿写回有失败：' + detail);
      }
      return { applied: report.applied, failed: report.failed };
    },

    exportDrafts(): string {
      const items = drafts.diffs();
      if (!items.length) return '（没有草稿）';
      const head = '苍玄助手 · 草稿 ' + items.length + ' 处改动（未保存）';
      return (
        head +
        items
          .map(item => '\n\n### ' + describeChange(item.change) + '\n' + formatDiff(item.lines, { context: 2 }))
          .join('')
      );
    },

    dropDrafts(): void {
      drafts.clear();
      syncDrafts(lastData);
    },

    draftCount(): number {
      return drafts.count();
    },
  };
}
