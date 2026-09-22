/**
 * MCP 插件 · 清单。
 *
 * 自包含目录：manifest（本文件）+ protocol.ts / client.ts（协议层，host-bridge）
 * + connection.ts（装配层，本目录）+ Page.vue（服务器页）。
 * 依赖方向单向：plugins/builtin/mcp → core / agent，**插件之间零 import**。
 *
 * 这个插件与另外三个**结构上不同**：它的工具**不是静态声明**的，
 * 而是运行时从远端 MCP 服务器拉回来的（`tools/list`）——
 * 所以 `contributes.tools` 是空的，工具走 `registerRuntimeTools('mcp', ...)` 注册。
 * 这也是「工具可以按来源活起来、也可以按来源消失」的第一个真实用例：
 * 断开一台服务器 = 它的工具立刻从能力里消失。
 *
 * ─────────────────────────── requires 的口径 ───────────────────────────
 *
 * `['fetch']` —— 这是**唯一**一个需要网络的插件，而且它真的只用这一个宿主能力。
 *
 * 为什么敢写（P5-5 之前是不能写的）：`fetch` 已登记进 core/capability.ts，
 * 来源归 `'platform'` 档（运行时平台自带，不依赖酒馆也不依赖酒馆助手）。
 * 在那之前写它会撞上「requires 名字必须在能力表里」的静态闸，被判成 typo、整插件装不上。
 *
 * 为什么不写 `required`（即为什么它是**可选**能力）：
 * fetch 几乎不可能不存在，写必需只会让插件在任何探测意外时被整个拦掉；
 * 而「连不上服务器」本来就该由 connection.ts 翻成人话显示在服务器行上，
 * 不该在装载期就把插件判死（那样用户连服务器页都打不开，没法配地址）。
 *
 * ─────────────────────────── status 的口径 ───────────────────────────
 *
 * 「未启用」由底座先判（plugin_status），这里只管**开着的时候**缺什么：
 * 一台都没配 → 提示去加；配了但一台都没连上 → 显示最近一次错误；连上了 → 「已连接 N 台」。
 * ⚠️ 它**不 import connection.ts 的运行时状态**来算这个 —— 见下面 status 的注释。
 */
import type { PluginManifest, PluginStatus } from '../../types.ts';

/**
 * 把 `config` 安全地看成 McpConfig 的形状。
 *
 * 为什么不用 zod parse：status() 是**渲染路径**上的函数（插件列表每行都调），
 * 而它拿到的 config 可能是老数据 / 半截数据。这里只需要几个字段，
 * 逐字段取 + 兜底比「解析失败就整条状态没了」稳得多。
 */
function asServers(config: unknown): Array<{ enabled: boolean; last_error: string; url: string }> {
  const bag = (config ?? {}) as { servers?: unknown };
  const list = Array.isArray(bag.servers) ? bag.servers : [];
  return list.map(item => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      enabled: row.enabled !== false,
      last_error: typeof row.last_error === 'string' ? row.last_error : '',
      url: typeof row.url === 'string' ? row.url.trim() : '',
    };
  });
}

/**
 * 插件状态（插件列表行上的那个标签）。
 *
 * ⚠️ 这里**刻意不读 connection.ts 的运行时连接状态**：
 *   1. status() 是**纯函数式**的（manifest 契约只给它 config），读模块级状态会让它不再可预测；
 *   2. 更要紧的是**依赖方向**：manifest 是最干净的一层，让它去够运行时状态，
 *      以后想单测 manifest / 想换掉连接实现都得先起一遍连接模块。
 *   而「连上没连上」这件事本来就有**持久化的事实来源**：`last_ok_at` 与 `last_error`
 *   （connection.ts 每次连/断都写回 config），所以这里读它们就够了 ——
 *   既拿到了真实信息，又没引入运行时依赖。
 */
export function mcpStatus(config: unknown): PluginStatus {
  const servers = asServers(config);
  if (servers.length === 0) return { label: '还没有服务器', kind: 'warn' };

  const enabled = servers.filter(item => item.enabled);
  if (enabled.length === 0) return { label: '全部停用', kind: '' };

  // 有地址才算「配好了」—— 地址留空的那些不算「连不上」，是「还没填」
  const configured = enabled.filter(item => item.url !== '');
  if (configured.length === 0) return { label: '缺地址', kind: 'warn' };

  const errored = configured.filter(item => item.last_error !== '');
  if (errored.length === configured.length) {
    return { label: errored.length === 1 ? '连不上' : errored.length + ' 台连不上', kind: 'dang' };
  }
  if (errored.length > 0) return { label: errored.length + ' 台出错', kind: 'warn' };

  // 全部配好且没有错误记录 = 连上了。台数用「配好的」而不是「全部」（停用的不算）。
  return { label: '已连接 ' + configured.length + ' 台', kind: 'ok' };
}

export const manifest: PluginManifest = {
  id: 'mcp',
  name: 'MCP',
  desc: '接 MCP 服务器：把远端工具拉进来给模型用，断开即消失。',
  version: '0.1',
  apiVersion: 1,
  builtin: true,
  // 默认 **关**：没配服务器时开着只会多出一页空界面、还白占一次网络能力。
  // 用户要自己在「能力 · 插件」里打开（与 image 同一口径）。
  defaultEnabled: false,
  contributes: {
    // inTabbar: false —— 顶栏保持 3 格（对话 / 世界书 / 设置）。
    // MCP 是「配一次就不常来」的页，从插件管理页「它加了什么 → 页面」进即可。
    pages: [{ id: 'mcp', title: 'MCP', order: 70, inTabbar: false }],
    // 静态工具为空：工具是运行时从远端拉的（registerRuntimeTools），不是写死在这里的。
    tools: [],
    requires: ['fetch'],
  },
  status: mcpStatus,
};

export default manifest;
