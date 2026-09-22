# 阶段 6 · MCP 插件（运行时工具注册 + 服务器页）—— 交付与真机验收

> 一句话：**MCP 通了**。连一台 HTTP MCP 服务器 → 它的远端工具出现在「设置 · 能力 · 工具」并带上
> `MCP · 服务器名` 来源标签 → 断开即消失；错误全部翻成人话显示在服务器行上。
> 本轮最大的价值不在功能本身，而在**真机验收当场抓出 3 个只有接上真宿主才暴露的缺陷**（见 §4）。

## 1. 交付了什么

| 交付 | 位置 | 说明 |
|---|---|---|
| **契约冻结** | `core/types.ts` · `plugins/registry.ts` | `McpServerSchema` / `McpConfigSchema` + **运行时工具注册通道** `registerRuntimeTools` |
| **协议层** | `plugins/builtin/mcp/protocol.ts` · `client.ts` | JSON-RPC 2.0 over HTTP：握手 / 会话 / 翻页 / 调工具 / 12 个错误码 → 人话 |
| **装配层** | `plugins/builtin/mcp/connection.ts` · `manifest.ts` | 连接状态机 + 远端工具 → ToolDef + 整批注册；`requires: ['fetch']`、默认关、页面 `inTabbar:false` |
| **服务器页** | `plugins/builtin/mcp/Page.vue` · `Switch.vue` | 列表 / 详情 / 请求头 / **逐条停用**；自包含（不 import 宿主外壳） |
| **宿主接线** | `App.vue` · `plugins/host.ts`-同层 | 页面挂载 + 五个 handler + 启动/开关变化时 `syncServers` + id 不变量兜底 |
| **测试** | `mcp_client.test.ts`(24) · `mcp_connection.test.ts`(21) · `runtime_tools.test.ts`(10) · 契约闸若干 | 见 §5 |
| **验收工具** | `dev_mcp_server.mjs` | 假 MCP 服务器（正常 + `?mode=` 11 种失败模式），真机验收用 |

## 2. 契约（下一轮别推翻）

```ts
// 运行时工具注册：整批替换（不是增量），按插件为粒度
registerRuntimeTools(plugin, tools, label) → { registered, rejected }
unregisterRuntimeTools(plugin) / runtimeToolsOf(plugin) / runtimeToolNames(plugin)

// 插件设置
McpServer = { id, name, url, headers, transport, enabled, disabled_tools, last_error, last_ok_at }
```

两条关键口径（都是踩出来的）：
1. **整批替换**：多台服务器必须**合并成一批**注册；断开一台要**重算整批**，否则会把别台的工具一起抹掉。
2. **`toolOwner` 必须认运行时工具**：落回 `'base'` 的话 `liveToolDefs` 会把它当底座工具，**关掉插件后照样发给模型**。

## 3. 真机验收（SillyTavern 1.18.0 @ 127.0.0.1:8000，扩展形态）

| 验收点 | 实测 |
|---|---|
| 插件出现在列表 | 「MCP | 未启用 | 内置 · v0.1 · 1 页」；开关打开后行内状态变「还没有服务器」 |
| 页面可达 | 插件管理页「它加了什么 → 页面：MCP（不上顶栏）」能进；**顶栏仍是 3 格** |
| 新增服务器 | 名字 + 地址 → 「加入清单」→ 详情页 |
| **连接** | 页面「已连接 · 2 个工具」；假服务器日志：`initialize → notifications/initialized → tools/list ×2`（**翻页真的走了两页**） |
| 工具进能力表 | 「能力 · 工具」**17 行**，含 `cx_ping \| MCP · 本地假服 \| 默认`、`cx_echo \| …` |
| 插件状态 | 插件列表行变「**已连接 1 台**」（读的是持久化的 `last_ok_at`） |
| **断开即消失** | 点「断开」→ 详情「未连接」→ 工具表回到 **15 行**、`cx_*` 全没 |
| **错误人话化** | 地址换 `?mode=401` → 行上显示「调用 initialize 时鉴权失败（HTTP 401），服务端说：{…}；**在服务器的 headers 里填对凭据，通常是 Authorization: Bearer <token>；确认这个 token 没过期**」 |

## 4. ⚠️ 真机当场抓到的 3 个缺陷（都只有真机能暴露）

### 4.1 页面上「加入清单」产生的服务器**没有 id** → 连接被拒
现象：详情页报「这台服务器没有 id，没法建立连接」。
判定：**身份不该由展示层保证** —— 连接、逐条停用归属、错误写回全靠它。
修法：`App.vue` 的 `onMcpAdd` 统一补 `id: uid()`，并加 `ensureMcpIds()` 修老数据（老数据里空 id 的行会被自动补好）。

### 4.2 **工具目录是拿写死的 `TOOL_NAMES` 生成的** → 运行时工具永远进不了界面
现象：连上服务器后「能力 · 工具」仍是 15 行，没有 `cx_ping`；**但模型拿得到**（runner 每轮重建注册表）。
判定：这条直接违背「可拓展」—— 名单外的工具（MCP 的、将来外部插件的）界面永远列不出来，
而**界面列不出来 = 用户改不了它的提示词、也看不见它存在**。
修法：`ToolRegistry.catalog()` 改成「**内置名单 ∪ 注册表里真实的 defs**」，两处共用同一份行投影 `catalogRow(def)`。
**这条是本轮最有价值的修复** —— 它是「能力取决于插件」这条理念在 UI 层的必要条件。

### 4.3 UI 目录不随插件开关/运行时注册刷新
`loadTools()` 原来既没传 `plugin_state`（于是**用户手动开的非默认插件的工具在界面上根本列不出来**），
也只在挂载时跑一次。修法：传 `plugin_state` + 运行时变更后重算（`mcpBump()` 里调 `loadTools()`）。

> 另外：ui-shell 在自己的驱动测试里又抓到 2 个（连续勾选两条工具互相抹掉、请求头「＋ 加一条」点了没反应），
> 都是「props 是快照、只 emit 不回写」的副作用 —— 看代码看不出来。

## 5. 门禁（收尾实测）

| 项 | 结果 |
|---|---|
| `node --test "tests/苍玄助手/*.test.ts"` | **612 / 612 pass，0 fail**（开工前 543） |
| `npx tsc --noEmit` | src **0 错**（全工程仅剩 4 条 `@vueuse` 蓝牙类型定义的既有噪音） |
| `npx webpack --mode production` | exit **0**（2+1 条既有 warning，无 ERROR） |
| `node build_tavern_script.mjs` | exit **0**，脚本正文 **669 KB** |
| `pnpm build` / `pnpm exec` | ⚠️ **环境故障，与本工作无关**：pnpm 11 的锁文件供应链检查（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，12 个 17:0x 刚发布的 `@typescript-eslint` 条目落在 cutoff 内）。`pnpm exec -- true` 同样失败 ⇒ 与代码无关；本轮用 `npx webpack` + `node build_tavern_script.mjs` 等价替代。**没动锁文件**。 |

测试规模：新增 `mcp_client` 24 + `mcp_connection` 21 + `runtime_tools` 10 + 契约/闸更新若干。
反例自检都做了：断 A 不抹 B（对照「整批替换会把 B 抹掉」）、撞名被拒不误报、
失败矩阵闸真的会拒裸 `TypeError`、`catalog` 名单外工具「没注册时不该出现」。

## 5.1 交付与发布

| 位置 | 内容 |
|---|---|
| `main` · commit **4281a2e** | 全部源码 + 测试 + 本报告（已 push：`5d494fa..4281a2e`） |
| `extension` 分支 · commit **d5f2fcc** | 只放可安装产物（`manifest.json` / `index.js` / `index.css` / `index.<hash>.chunk.js` / `README.md`），已 push |

用户侧的安装/更新路径不变：酒馆「扩展 → 安装扩展」贴仓库地址 + 分支填 `extension`；
已装过的可以直接点「更新」拉本次产物（**拉到的就是上面这份真机验过的构建**）。

## 6. 遗留与下一轮

1. **task-36（世界书写路径真机端到端）仍押后** —— 用户口径「先做后续，校验留后面」；执行方案保留在任务描述里。
2. **task-44（阶段 7 探针）未完成** —— host-bridge 中途中断，报告未落地；已让它补写。
   阶段 7（外部插件装载）**动手前必须先有这个探针**：动态 import 在 `about:srcdoc` iframe 里行不行、代码存哪、
   装载时序、失败隔离要动哪里。
3. **本机酒馆里两份扩展副本并存**：`data/default-user/extensions/苍玄界`（local）与
   `public/scripts/extensions/third-party/tavern-workshop-agent`（global，**实际被加载的那份**，用户从 GitHub 装的）。
   本轮把新构建覆盖到了 global 那份做验收。**发版后建议让用户从酒馆里「更新」拉一次**，避免两份不一致。
4. 验收用的假服务器 `dev_mcp_server.mjs` 留在仓库根（dev 脚本，不是产品代码）；`?mode=` 11 种失败模式可直接复用。
5. 我在用户酒馆数据里建的测试服务器（`本地假服`）**已删除**；MCP 插件开关**保持开启**（0 台服务器，无副作用）。

## 7. 给下一轮的三条纪律（本轮血换的）

1. **界面列不出来 = 功能不存在**。凡是「模型拿得到」的东西，界面上必须也能看见、能改 —— 否则就是在骗用户。
2. **身份/不变量归宿主**，不归展示层（id 那条）。
3. **接上真宿主之前，不要相信任何门禁全绿**：本轮 611 条测试 + tsc + build 全绿，仍然漏掉了
   「catalog 是封闭名单」这种只有连上真服务器才会暴露的缺陷。
