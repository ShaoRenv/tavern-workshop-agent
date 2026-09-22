/**
 * MCP 插件 · 连接状态机 + 工具装配（P6-3）。
 *
 * 这个文件是「远端工具怎么变成底座工具」的唯一落点。三件事：
 *   1. **连接**：拿一个 McpServer 配置，initialize + tools/list，把远端工具包成 ToolDef；
 *   2. **装配**：把包好的工具交给 plugins/registry.ts 的 registerRuntimeTools；
 *   3. **状态**：给 Page.vue 提供只读的「连上没有 / 有哪些工具」。
 *
 * ─────────────── ⚠️ 本文件最关键的一条：registerRuntimeTools 是**按插件整批替换** ───────────────
 *
 * 它签名上是 `registerRuntimeTools(plugin, tools[])` —— 一次调用换掉这个插件的**全部**运行时工具。
 * 所以：
 *   · **多台服务器必须合并成一批注册**。若每台各调一次，第二台会把第一台的工具**抹掉**；
 *   · **断开一台必须重算整批**（拿剩下的已连服务器重新合并），不能只删那台的；
 *   · **重连也走同一条路**（整批重建），这样远端工具改名后不会残留旧名。
 * 本文件因此把「哪些服务器连着、各自有哪些工具」当成**唯一真相源**（sessions），
 * 每次都能从它重新算出整批 —— 而不是在注册表上做增量修补（那是这类 bug 的温床）。
 *
 * ─────────────── 为什么不 import store / core/host ───────────────
 *
 * 同 protocol.ts 的口径：**fetch 由调用方注入**（`getFetch`），这层绝不摸全局。
 * 于是单测能塞假 fetch 把状态机整个驱动一遍，不需要起 pinia、也不需要真网络。
 * config 的写回（last_error / last_ok_at）也不在这里做 —— 这层不碰持久化，
 * 由调用方（App.vue 接线）拿到 McpConnectResult 后自己 patch。
 */
import type { ToolDef, ToolResult } from '../../../core/ports.ts';
import type { McpServer } from '../../../core/types.ts';
import { unregisterRuntimeTools, registerRuntimeTools } from '../../registry.ts';
import { createMcpClient, type McpClient, type McpToolInfo } from './client.ts';
import { McpError } from './protocol.ts';

/** 本插件的 id（运行时工具挂在它名下）。写成常量，免得字符串散落各处写错 */
const PLUGIN_ID = 'mcp';

/**
 * 一次连接尝试的结果（**冻结的公开形状**，App.vue / Page.vue 按它写）。
 *
 * 注意它是**结果**不是**异常**：所有失败都翻成 `{ ok:false, error: 人话 }` 返回，
 * 绝不抛给调用方 —— 服务器页要能显示原因，而不是被一个 throw 打断整页渲染。
 *
 * ⚠️ **必须有 `id`：结果必须能对应回服务器。**
 * 调用方（App.vue）靠它把 `last_error` / `last_ok_at` **写回对应的那一台** config。
 * 为什么这件事要紧：`manifest.status()` 读的就是 config 里这两个字段 ——
 * 结果对不上号 → 写不回去 → **连不上的服务器在插件列表里会永远显示「已连接 N 台」**，
 * 也就是界面替底层撒谎。
 * 而且 `syncServers()` **只返回「这次真的发生动作」的那些结果**，
 * 与入参的顺序、数量都可能对不上，所以**不能靠数组下标**去认。
 */
export interface McpConnectResult {
  /** 这台服务器的 id（= McpServer.id）；调用方靠它把结果写回配置 */
  id: string;
  ok: boolean;
  /** 成功时：这台服务器带来了几个工具（**可用的**，已剔除被拒的） */
  toolCount: number;
  /** 失败时的人话原因（可直接显示）；成功时缺省 */
  error?: string;
  /** 这次尝试的时间戳（毫秒）—— 界面显示「刚刚试过」用 */
  at: number;
}

/**
 * 一台**已连上**的服务器在内存里的事实。
 *
 * 只存「连上之后不会自己变」的东西：client 句柄、名字、以及远端工具清单。
 * 之所以缓存 tools：`serverToolNames()` 是**渲染路径**函数（Page 每帧调），
 * 不能每次都去发一次 tools/list。清单在连接时拉一次，重连时刷新。
 */
interface McpSession {
  id: string;
  name: string;
  client: McpClient;
  tools: McpToolInfo[];
  /** 被注册表拒绝的工具名 → 原因（名字撞车等），界面要显示，不静默 */
  rejected: Array<{ name: string; reason: string }>;
  /** 这台服务器自己的配置（重连 / 重算整批时要读 disabled_tools 等） */
  server: McpServer;
}

/** 当前连着哪些服务器（**唯一真相源**；整批注册每次都从这里重算） */
const sessions = new Map<string, McpSession>();

/* ============================ 小工具 ============================ */

function nowMs(): number {
  return Date.now();
}

/** 服务器在界面上的显示名：没起名就用地址兜底，地址也没有就说「未命名」 */
function displayName(server: McpServer): string {
  const name = typeof server?.name === 'string' ? server.name.trim() : '';
  if (name) return name;
  const url = typeof server?.url === 'string' ? server.url.trim() : '';
  return url || '未命名';
}

/**
 * 把任意异常翻成**人话**。
 *
 * McpError 自带 detail + hint（协议层已经分好类），直接用 `toUserMessage()`；
 * 其他异常兜底成一句带原文的话 —— 绝不把裸 TypeError 甩给用户（那是我们没翻干净）。
 */
function humanError(error: unknown): string {
  if (error instanceof McpError) return error.toUserMessage();
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
/* ============================ 远端工具 → ToolDef ============================ */

/**
 * 把一条远端工具包成底座的 ToolDef。
 *
 * 字段口径（与题面冻结的一致）：
 *   · `group: 'external'` —— 设置页按组显示时归「外部」；
 *   · `name` **用远端原名**（不改名、不加前缀）：名字是模型调用的键，也是用户看的东西，
 *     改了就对不上服务器文档了。撞名由注册表拒绝并给原因（见下面 rejected 的处理）。
 *   · `default_on` 由「**不在** `disabled_tools` 里」决定 —— 逐条停用是**持久**语义，
 *     存回 config，跨刷新有效；
 *   · `model_description` 用远端 description（缺省给一句兜底，别留空 —— 空描述模型猜不出用途）；
 *   · `parameters` 用远端 inputSchema（缺省 `{ type:'object', properties:{} }`，
 *     有些服务器不给 schema，给个合法空壳比传 undefined 稳）。
 *
 * ⚠️ `run` 是**闭包捕获 session.client**：工具一旦注册就绑定住当时那个 client。
 *   这是故意的 —— 断线重连会整批重建工具，所以不存在「拿着旧 client 的过期工具」；
 *   而如果这里去 sessions.get(id) 现查，反而会在「注册完但还没连上」的窗口里拿到 undefined。
 */
function wrapTool(session: McpSession, info: McpToolInfo): ToolDef {
  const disabled = Array.isArray(session.server?.disabled_tools) ? session.server.disabled_tools : [];
  const description = typeof info.description === 'string' ? info.description.trim() : '';
  const schema = info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} };

  return {
    name: info.name,
    group: 'external',
    // title 是给人看的短名；远端只有 name，就用它（界面已经知道它来自哪台服务器）
    title: info.name,
    desc: description || 'MCP 工具（' + session.name + '）',
    model_description: description || '远端 MCP 工具 ' + info.name + '（服务器未提供说明，请按名字谨慎使用）',
    parameters: schema as Record<string, unknown>,
    // 逐条停用的落点：勾掉了就不默认给模型（但仍在注册表里，工具页还能看到）
    default_on: !disabled.includes(info.name),
    source: 'external',
    origin: session.server?.url ?? '',
    /**
     * 转发到远端 tools/call。
     *
     * ⚠️ **不抛**：ToolDef.run 的契约是返回 ToolResult（ok=false 表示失败），
     * 抛出去会让 Agent 循环把它当成内核异常，用户看到的是「工具崩了」而不是「远端报错」。
     * 所以这里把远端失败 / 网络失败都翻成 ok:false + 人话 detail。
     */
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await session.client.callTool(info.name, args ?? {});
        const text = typeof result.text === 'string' ? result.text : '';
        if (result.isError) {
          return {
            ok: false,
            brief: session.name + ' · ' + info.name + ' 返回错误',
            detail: text || '远端工具报告了一个错误，但没有给出说明。',
            code: 'TOOL_ERROR',
          };
        }
        return {
          ok: true,
          brief: session.name + ' · ' + info.name + ' 完成',
          detail: text,
        };
      } catch (error) {
        // 网络 / 协议 / 超时 —— 翻成人话，并把它当成工具失败（不是内核异常）
        return {
          ok: false,
          brief: session.name + ' · ' + info.name + ' 失败',
          detail: humanError(error),
          code: 'TOOL_ERROR',
        };
      }
    },
  };
}

/* ============================ 整批注册（本文件的核心） ============================ */

/**
 * 把**当前所有已连服务器**的工具合并成一批，一次性注册。
 *
 * ⚠️ 这是本文件唯一允许调 registerRuntimeTools 的地方。
 * 理由（再强调一次，因为这是 P6-3 最容易写错的一点）：
 * 那个接口是**按插件整批替换**的 —— 任何「只注册一台 / 只注销一台」的增量写法
 * 都会把别的服务器的工具一起抹掉。所以所有变更（连上 / 断开 / 重连 / 改停用）
 * 都**只改 sessions 这张表**，然后统一走这里重算整批。
 *
 * 没有已连服务器时**注销整批**（而不是注册空数组）—— 语义更明确：
 * 「这个插件现在没有运行时工具」，注销能让 runtimeToolsOf 直接返回空。
 */
function reregisterAll(): void {
  const all: ToolDef[] = [];
  for (const session of sessions.values()) {
    for (const info of session.tools) all.push(wrapTool(session, info));
  }

  if (all.length === 0) {
    unregisterRuntimeTools(PLUGIN_ID);
    return;
  }

  // label 是给界面看的来源说明：多台时列出名字，单台就用它自己
  const names = [...sessions.values()].map(session => session.name);
  const label = names.length === 1 ? 'MCP · ' + names[0] : 'MCP · ' + names.length + ' 台：' + names.join('、');
  const report = registerRuntimeTools(PLUGIN_ID, all, label);

  // 把拒绝原因**回填到每台会话**上，界面按服务器显示（不静默）
  const rejectedBySession = new Map<string, Array<{ name: string; reason: string }>>();
  for (const session of sessions.values()) rejectedBySession.set(session.id, []);
  for (const item of report.rejected) {
    // 找到这个名字属于哪台（同名工具可能来自多台 —— 都记上，界面各自显示）
    for (const session of sessions.values()) {
      if (session.tools.some(info => info.name === item.name)) {
        rejectedBySession.get(session.id)?.push(item);
      }
    }
  }
  for (const session of sessions.values()) {
    session.rejected = rejectedBySession.get(session.id) ?? [];
  }
}
/* ============================ 公开接口（冻结） ============================ */

/**
 * 连上一台服务器：initialize → tools/list → 包成工具 → 整批注册。
 *
 * **要重连就先断开再连**（本函数内部会先把自己那台从 sessions 里摘掉），
 * 这样重连天然是「整批替换」，不会残留上一批工具名。
 *
 * 所有失败都翻成 `{ ok:false, error: 人话 }` —— **不抛**。
 * 失败时**不留下半截会话**：要么整台连上并参与整批注册，要么这台什么都不留。
 * （半截状态是最糟的：工具注册了但没 client，模型一调就炸。）
 */
export async function connectServer(server: McpServer, getFetch: () => typeof fetch | null): Promise<McpConnectResult> {
  const at = nowMs();
  const id = typeof server?.id === 'string' ? server.id.trim() : '';
  const url = typeof server?.url === 'string' ? server.url.trim() : '';

  // 极端情形：连 id 都没有。仍然带上 id 字段（空串）——让结果形状始终一致，
  // 调用方不必为「有没有 id」分两条路走；空 id 的结果它自己会忽略。
  if (!id) return { id: '', ok: false, toolCount: 0, error: '这台服务器没有 id，没法建立连接', at };
  if (!url) return { id, ok: false, toolCount: 0, error: '还没填服务器地址', at };

  const fetchImpl = getFetch();
  if (typeof fetchImpl !== 'function') {
    return { id, ok: false, toolCount: 0, error: '这个环境里取不到 fetch，连不了 MCP 服务器', at };
  }

  // 先断开旧的（重连语义）：保证 sessions 里不会出现同一 id 的两份
  closeSession(id);

  try {
    const client = createMcpClient({ url, headers: server.headers ?? {}, fetchImpl });
    const info = await client.initialize();
    const tools = await client.listTools();
    // 名字按服务器的 name 兜底 url（与 displayName 同口径）
    const session: McpSession = {
      id,
      name: displayName(server),
      client,
      tools,
      rejected: [],
      server,
    };
    sessions.set(id, session);
    // 连上之后**整批重算**（别的服务器的工具也要一起带上）
    reregisterAll();

    // 只有真正可用的（没被注册表拒绝的）才算数 —— 否则界面会报一个模型调不到的数目
    const usable = tools.length - session.rejected.length;
    void info; // initialize 的 serverName/protocolVersion 目前只用于日志；不留未用变量
    return { id, ok: true, toolCount: Math.max(0, usable), at };
  } catch (error) {
    // 失败路径：确保不留任何半截会话，并**重算整批**（把可能已加进去的部分摘干净）
    closeSession(id);
    reregisterAll();
    return { id, ok: false, toolCount: 0, error: humanError(error), at };
  }
}

/**
 * 关掉某台的连接（本地会话 + 它的 client）。**不改 sessions 以外的任何东西**。
 *
 * 单独抽出来是因为有三处要用（重连前、断开、失败回滚），
 * 每处各写一遍 close + delete 迟早会漏一处。
 */
function closeSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  try {
    session.client.close();
  } catch (error) {
    // close 是幂等的且不该抛；真抛了也不该影响断开流程（工具必须能从能力里消失）
    console.warn('[苍玄界] 关闭 MCP 连接时出错（已忽略）', error);
  }
  return true;
}

/**
 * 断开一台：摘掉会话 + **重算整批**注册。
 *
 * ⚠️ 重算这一步是这个接口的重点。只 sessions.delete 而不 reregisterAll 的话，
 * 那台的工具会留在注册表里 —— 模型仍能调用一个已经断开的服务器。
 */
export function disconnectServer(id: string): void {
  const target = typeof id === 'string' ? id.trim() : '';
  if (!target) return;
  if (!closeSession(target)) return;
  reregisterAll();
}

/**
 * 按配置**同步**一遍连接状态（幂等）。
 *
 * 口径（题面冻结的）：
 *   · `enabled` 且**没连**的 → 连上；
 *   · 非 `enabled` 或**已从配置里删掉**的 → 断开；
 *   · 已连且仍 enabled 的 → **不动**（不重复连接：重连会打断正在跑的工具调用）；
 *   · 地址或配置变了的 → 重连（比对 url / headers，变了才重连）。
 * 返回**这次真正发生动作**的那些服务器的结果（没动的那些不出现在结果里）。
 *
 * 为什么幂等重要：调用方会在插件开关变化、页面挂载、用户点刷新等多个时机调它，
 * 每调一次就重连全部服务器的话，用户会看到工具反复消失又出现。
 */
export async function syncServers(
  servers: McpServer[],
  getFetch: () => typeof fetch | null,
): Promise<McpConnectResult[]> {
  const list = Array.isArray(servers) ? servers : [];
  const results: McpConnectResult[] = [];

  // ① 该断的：配置里没有的 / 被关掉的
  const keep = new Set<string>();
  for (const server of list) {
    const id = typeof server?.id === 'string' ? server.id.trim() : '';
    if (id && server.enabled !== false) keep.add(id);
  }
  for (const id of [...sessions.keys()]) {
    if (keep.has(id)) continue;
    disconnectServer(id);
  }

  // ② 该连的：enabled 且没连（或配置变了要重连）
  for (const server of list) {
    const id = typeof server?.id === 'string' ? server.id.trim() : '';
    if (!id || server.enabled === false) continue;

    const existing = sessions.get(id);
    if (existing) {
      // 已连着：地址或请求头变了才重连（否则保持不动 —— 幂等的关键）
      const sameUrl = (existing.server.url ?? '') === (server.url ?? '');
      const sameHeaders = JSON.stringify(existing.server.headers ?? {}) === JSON.stringify(server.headers ?? {});
      if (sameUrl && sameHeaders) {
        // 只是 disabled_tools / name / last_error 变了 —— 更新会话里的配置快照并重算整批
        // （disabled_tools 影响 default_on，必须重算；这不涉及网络，便宜）
        existing.server = server;
        existing.name = displayName(server);
        reregisterAll();
        continue;
      }
    }

    results.push(await connectServer(server, getFetch));
  }

  return results;
}

/* ============================ 只读状态（Page.vue 用） ============================ */

/**
 * 一台服务器在界面上该显示什么状态。
 *
 * 只回答「**连上没有**」，不重复 manifest.status() 的那套（未启用 / 缺配置由那边判）——
 * 两处都判一遍会打架，而界面知道该用哪个（列表行用 manifest 的，详情页用这个）。
 * 名字撞车被拒的工具也算「有话说」，所以报 warn 并带上原因。
 */
export function serverStatus(id: string): { label: string; kind: '' | 'ok' | 'warn' | 'dang' } {
  const session = sessions.get(typeof id === 'string' ? id.trim() : '');
  if (!session) return { label: '未连接', kind: '' };
  if (session.rejected.length > 0) {
    return { label: session.rejected.length + ' 个工具被拒', kind: 'warn' };
  }
  return { label: '已连接 · ' + session.tools.length + ' 个工具', kind: 'ok' };
}

/** 这台服务器带来的工具名（**不含**被注册表拒绝的 —— 界面区分「有但没进来」靠 serverRejections） */
export function serverToolNames(id: string): string[] {
  const session = sessions.get(typeof id === 'string' ? id.trim() : '');
  if (!session) return [];
  const rejected = new Set(session.rejected.map(item => item.name));
  return session.tools.map(info => info.name).filter(name => !rejected.has(name));
}

/**
 * 被拒绝的工具及原因（名字撞底座工具等）。
 *
 * 单独开一个只读口是因为「被拒」和「没有」在界面上必须**分清**：
 * 前者要显示原因让用户改服务器，后者只是没配。
 */
export function serverRejections(id: string): Array<{ name: string; reason: string }> {
  const session = sessions.get(typeof id === 'string' ? id.trim() : '');
  return session ? session.rejected.slice() : [];
}

/** 当前连着哪些服务器（Page.vue 画「已连接」标记用） */
export function connectedIds(): string[] {
  return [...sessions.keys()];
}

/**
 * 测试 / 卸载用：断开全部并清空注册。
 *
 * 为什么需要：模块级 sessions 是**跨测试存活**的，不复位会让用例互相污染
 * （前一个用例连着，后一个用例断言「断开后没工具」就会假绿）。
 */
export function disconnectAll(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
  unregisterRuntimeTools(PLUGIN_ID);
}