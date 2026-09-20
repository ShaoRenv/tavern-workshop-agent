# 苍玄助手 · UI 交互与信息架构审查（只出方案，不改代码）

> 任务：task-25（`reports/苍玄助手-UI交互审查.md`，写范围仅此一个文件）。
> 方法：按真实代码路径逐步走完两条主流程（对话页跑一轮 → 草稿 → 保存；设置·预设改系统提示词 / 勾工具），
> 逐处核对 `src/苍玄助手/` 的模板、事件转发与 store 写路径，只写代码里读得到的事实。
> 约束遵守：不改任何代码，不跑构建；提案全部落在现有结构上，兼容 Lead 正在做的
> 「两级能力启用 + 特殊层 + 预设合并（去 kind）」与「对话设置 Sheet」方向，不提推倒重来。

## 0. 一句话结论

**信息架构（库 / 本次 / 全局 三分）这一轮是成功的，不要动。**
真正值得改的是**「状态不可见」和「状态不一致」**：对话页看不到自己在用哪个预设、运行中/草稿切页就消失、
失败提示 3.2 秒闪完既不同色也不可回看；另外有三处「确认/防误触」口径互相矛盾。
这些都是小改动、且全部集中在 `views/` 与 `components/AppShell.vue`+`App.vue`，不碰数据层与内核。

## 1. 排序总表（按 收益 / 代价）

| # | 提案 | 收益 | 代价 | 落点 |
|---|---|---|---|---|
| 1 | 对话页显示当前预设 + 切换入口；拆掉死控件「Agent｜聊天」 | 高 | 小 | ChatView.vue / App.vue |
| 2 | 统一「确认与防误触」口径（删预设零确认、内建预设静默无反应、导入零确认、原生 confirm/prompt） | 高 | 小 | App.vue / SettingsView.vue |
| 3 | 系统提示词框改自动增高（对齐工具页，去掉内嵌小滚动区） | 中高 | 极小 | SettingsView.vue / global.css |
| 4 | 「● 运行中 · 第 N 轮」与「草稿 N」提到顶栏常驻（并给回到对话页的入口） | 中高 | 小 | AppShell.vue / App.vue |
| 5 | 失败提示与成功区分、不自动消失、可回看 | 中高 | 小 | App.vue |
| 6 | 能力页工具详情里的「在当前这个预设里启用」与设置·预设重复，且与两级启用方向冲突 | 中 | 小 | CapabilityView.vue / ToolDetail.vue |
| 7 | 二级导航段位 / 工具详情不记忆（改一次提示词要重走 2 下导航） | 中 | 中 | App.vue / SettingsView.vue / CapabilityView.vue |
| 8 | 立绘页「生成」在 agent 预设下静默跳页并按空需求开跑 | 中 | 小 | App.vue / PortraitsView.vue |
| 9 | 术语统一（记录/对话/会话、保存/全部保存、Agent 类型/普通类型、"已改过"≠"已启用"） | 中 | 小（要扫文案） | 多个 view |
| 10 | 草稿条缺「丢弃」入口；设置页那个「丢弃草稿」会连带清掉别的会话 | 中 | 中 | ChatView.vue / App.vue |

**最值得做的 3 条：第 1、2、3 条。**

## 2. 两条主流程的实走与点击成本

### 流程 1：对话页发一句话 → 模型调工具 → 草稿 → 保存

代码路径：
`ChatView.vue:58` 输入框回车 → `ChatView.vue:227-232` submit → emit `send` →
`App.vue:213-219` `onSend`（先 append 用户轮，再 `runOnce`）→ `App.vue:161-202` `runOnce` →
`App.vue:173` 按 `preset.kind === 'agent'` 选 `runner.runAgent` → `run/runner.ts:444-595` 工具循环，
每步 `publishCall`（runner.ts:504-521）刷工具卡、`syncDrafts`（runner.ts:399-406, 545, 589）把草稿镜像进 `RootData.drafts` →
`ChatView.vue:9-17` 草稿条出现 → 点「保存」→ `App.vue:286-295` `onSaveDrafts` → `runner.ts:597-608` `drafts.apply`。

**新用户（面板没开过）最少点击：开面板 → 点「对话」→ 打字 → 发送 → 保存 = 5 下**（回车代替点发送则 4 下）。
可选「看 diff」+1 下、关弹窗 +1 下。

走查中发现的问题：

- 全程界面上**没有任何地方显示当前用的是哪个预设**（ChatView 的 props 只有 `data` 与 `assistantName`，App.vue:20-30；
  顶栏只显示「苍玄助手 ● 已连接」，AppShell.vue:4-6 + App.vue:92）。而预设决定了它有没有工具、用哪段 system、
  最多跑几轮 —— 这是这条流程里信息量最大却完全不可见的一个状态。→ 见提案 1。
- 草稿出来后，「保存」是唯一出口，**没有「丢弃」**；不想保存的路径在 设置 · 数据 · 危险操作（SettingsView.vue:173），
  且那个按钮清的是全部会话的草稿（App.vue:409-412 → `stores/app.ts:642-646`）。→ 见提案 10。
- 保存结果只有一句 3.2 秒的青色 toast（App.vue:112-116, 291），失败时同样颜色、同样时长，
  且 `failed > 0` 时只给总数、不说是哪本书哪一条（App.vue:291）。→ 见提案 5。

### 流程 2：设置 · 预设改系统提示词 / 勾工具

代码路径：`AppShell.vue:15` 点「设置」→ `App.vue:50-59` `SettingsView` →
`SettingsView.vue:5` 二级 SegBar（`seg = ref('api')`，SettingsView.vue:354）→ 点「预设」段（SettingsView.vue:60）→
`SettingsView.vue:82-85` 选预设 → `SettingsView.vue:99` 改系统提示词（`v-model="preset.system"`，无保存键）→
`SettingsView.vue:118-127` 点「工具 10/13 ▾」→ Sheet（SettingsView.vue:181-204）逐个勾 → 点「完成」。

**从对话页出发最少：设置 → 预设 → 改 → 勾工具 → 完成 → 回对话 = 6 下**，其中 2 下是纯导航损耗
（段位不记忆，每次都要从「接口」再点一次；回来看效果再回来又要点一次）→ 见提案 7。
另有两处与冻结约束「不要内嵌小滚动区」不符 → 见提案 3。

## 3. 逐条提案

### 【1】对话页显示当前预设 + 切换入口；顺手拆掉「Agent｜聊天」这个死控件

**现状（引代码）**

- 对话页顶部只有一个模式开关：`ChatView.vue:4-6` `<SegBar v-model="session.mode" :items="MODE_ITEMS" …>`，
  `MODE_ITEMS` 在 `ChatView.vue:139-142`（Agent / 聊天）。
- 但真正决定跑哪条通道的是**预设类型**，不是这个开关：`App.vue:173` `preset.kind === 'agent' ? runAgent : runPlain`。
- `session.mode` 写进去之后，**没有任何一处 UI 读它**；`store.setMode`（`stores/app.ts:421-424`）全仓只有定义和 export，
  没有任何调用者（grep `setMode` 只命中 stores/app.ts 三行）。`toSessionMeta` 带出的 `mode`（`core/types.ts:410`）
  在记录页也没被渲染（RecordsView.vue:17-20 只显示时间/轮数）。
- 对话页也没有任何"当前预设"的输出：`App.vue:20-30` 传给 ChatView 的只有 `data` 和 `assistant-name`。

**问题（为什么不好）**

1. 用户点「聊天」以为切成了普通对话模式，实际行为完全没变（还是 agent 预设、还是带工具），
   这是**一个会误导人的控件**，比没有更糟。等 Lead 按 `reports/苍玄助手-预设与上下文.md` 六去掉 `kind` 之后
   （"是不是 agent 由有没有勾工具决定"），这个开关会彻底无意义。
2. 预设是这条流程里最该可见的状态（决定有没有工具、哪段 system、几轮预算），却藏在一个要切页才能到的下拉里
   （只有 `SettingsView.vue:82` 和 `PortraitsView.vue:12` 两个入口）。跑到一半出问题，用户第一反应是"我是不是没选预设"，
   而对话页回答不了这个问题。

**建议（具体怎么改）**

- 做 Lead 已经拍板的「对话设置 Sheet」（`reports/苍玄助手-预设与上下文.md` 五：切聊天 / 切预设 / 删除对话）时，
  把**当前预设名**放在对话页顶栏那一行：`ChatView.vue:4-6` 那个 `.cx-blk` 里，左边一行小字
  「预设 · {{ presetName }}（{{ 工具 N 个 }}）›」，点它开同一个 Sheet（Sheet 是现成件，`components/Sheet.vue`）。
  一行只读文案 + 一个已有弹窗，不必新增组件。
- 「Agent｜聊天」：二选一，别留着。
  （a）**推荐**：删掉 UI（`ChatView.vue:4-6, 139-142`），`session.mode` 字段保留做老数据兼容（迁移不动，测试里的
  `core_sessions.test.ts:33/100`、`core_types_storage.test.ts:57/80` 全绿）；
  （b）如果确实要保留"手动切通道"，就让它真的驱动选择 —— 但那样会和"去 kind"直接打架，不建议。
- 顺带：预设为空的兜底提示 `App.vue:163` `notify('先选一个预设')` 其实几乎走不到（`activePreset` 会退回 `presets[0]`，
  `stores/app.ts:222-225`，且 `applyBuiltins` 会补内置预设），文案可以不用管。

**代价**：小。改 ChatView 顶部一行 + 删 5 行模板/常量；不碰 store、runner、数据层、测试。
风险：几乎没有；唯一要注意的是别和 Lead 正在写的对话设置 Sheet 抢同一个文件 —— 建议由他一起做，或在他落地后追加。

---

### 【2】「确认与防误触」口径不一致：该拦的没拦，不该用原生弹窗的用了

**现状（引代码）**

| 操作 | 现在的确认方式 | 后果 |
|---|---|---|
| 删除当前预设 | **完全没有确认**：`SettingsView.vue:335-340` 菜单项标了 `danger:true`，`App.vue:357` 直接 `store.removePreset(presetId)` | 一次误点，预设里的系统提示词 + 工具勾选清单全没 |
| 删除**内置**预设 | **静默无反应**：`stores/app.ts:249-251` `if (!target || target.builtin) return;`，而 `App.vue:357` 之后没有任何 notify | 用户以为点了没反应 / 以为删掉了 |
| 删除一条聊天记录 | 原生 `confirm('删掉这条聊天记录？')`，`App.vue:253` | 风格与整套 Sheet 不一致；sandbox iframe 未放行 modal 时会**静默不删** |
| 重命名记录 | 原生 `prompt('改成什么名字？', …)`，`App.vue:257-259` | 手机上难用、不能粘贴长标题、无长度约束 |
| 导入数据（整份覆盖） | **完全没有确认**：`App.vue:390-402` 选完文件直接 `replaceAll` | 选错文件 = 设置/预设/记录/技能全部被覆盖，事后无撤销 |
| 清空对话 / 丢弃草稿 / 丢弃产物 | 有原生 confirm，`App.vue:405-415` | 该有的有，但同 4 |
| 工具详情「恢复默认」 | 原生 confirm，`ToolDetail.vue:344` | 同上 |

**问题**

同一类"不可逆操作"三条口径：有的零确认（删预设、导入）、有的原生弹窗（删记录、清空）、有的连反馈都没有（删内建预设）。
用户学不到规律，只能每次赌一下。另外「导入数据」是**破坏性最强**的一个，反而最顺滑。

**建议**

1. 删预设：在 `App.vue:357` 前加一层确认（可直接复用 Sheet：标题「删除预设」+ 预设名 + 危险键），
   并让 `removePreset` 的返回值（改成 `boolean`）驱动提示：内建 → `notify('内置预设不能删，复制一份再改')`。
   这是本提案里性价比最高的一条：**2 处 app 层改动，消灭 1 个静默失败 + 1 个零确认删除**。
2. 重命名：换成 Sheet 里的一个 input（`Sheet.vue` 现成，`SettingsView.vue:232-264` 的消息编辑弹窗就是模板）。
3. 导入：文件读完、`importAll` 校验通过之后，先弹一个 Sheet 摘要（"将覆盖：预设 N 个 / 技能 N 个 / 记录 N 条，
   当前数据会被替换"）再 `replaceAll`。`importAll` 已经回了校验结果（`App.vue:395-397`），顺路就能算摘要。
4. 原生 `confirm/prompt` 逐步收进 Sheet；至少把"删除聊天记录"改掉（记录页是手机上最容易误触的列表）。
   设置页那三个"清空/丢弃"可以第二批。

**代价**：小-中。1 是 2 行；2、3 要各加一个 Sheet 状态（App.vue / RecordsView 各一处）；
4 的面更大但可以拆批。风险：导入确认会多一步点击 —— 但为"全量覆盖"付这一步是值得的。

---

### 【3】系统提示词输入框不该是 5 行内嵌滚动区（工具页已经做对了）

**现状（引代码）**

- 设置 · 预设 · 系统提示词：`SettingsView.vue:99` `<textarea ref="systemEl" v-model="preset.system" class="cx-mono" rows="5">`，
  `rows="5"` + `global.css:358-361` `textarea { resize: vertical }` → 一个固定的 5 行小框，内容超了就在**框内滚动**。
- 同一件事在工具页是另一种做法：`ToolDetail.vue:40-46` 用 `class="cx-mono cx-grow"`，`ToolDetail.vue:253-259` 的 `grow()`
  把 `height` 设成 `scrollHeight`，`global.css:1431-1436` 的 `.cx-grow { resize:none; overflow:hidden; min-height:120px }`，
  并在注释里写明"跟着内容长，不做内嵌滚动区"。工具详情页的注释（`ToolDetail.vue:157-166`）也把这当成设计约定。
- 同类问题还有：消息编辑 `SettingsView.vue:247` 内联 `min-height:170px`、技能正文 `SkillsView.vue:49` 同款内联样式。

**问题**

1. 违反冻结约束「长页面滚动、不要内嵌小滚动区」（`reports/苍玄助手-计划.md` 4.1、`reports/苍玄助手-UI整理.md` 五）。
2. 系统提示词通常是最长的一个字段，手机上却是最短的那个框：手指在框内滚、页面又在外面滚，两层滚动互相打架，
   光标定位/选中都很别扭。
3. 同一个"改提示词"的动作在能力页手感正确、在设置页是错的 —— 用户会觉得是两个产品。

**建议**

- 把 `SettingsView.vue:99` 换成 `class="cx-mono cx-grow"`，并把 `ToolDetail.vue:253-267` 那段 `grow()`（`@input` + `watch` + `onMounted`）
  抄过来 —— 或者更省事：把这 15 行提到一个 `components/GrowTextarea.vue`，三处（系统提示词、消息内容、技能正文）共用。
- 若担心超长提示词把设置页拉得很长，**给一个阈值折叠**（超过 N 行显示"展开全文"），而不是回到内嵌滚动。

**代价**：极小（改 1 个 class + 抄 15 行；抽组件则 3 处共用）。风险：无；不影响任何数据。

---

### 【4】「● 运行中 · 第 N 轮」和「草稿 N」应该常驻顶栏（现在切页就看不见）

**现状（引代码）**

- 运行状态行是**对话页内部元素**：`ChatView.vue:49-54` `<div class="cx-statusbar" :class="{ on: session.running }">` 显示
  「运行中 · 第 N 轮」；数据来自 `session.running/round`（`stores/app.ts:479-482`，`runner.ts:552-558` 每轮写 `round`）。
- 顶栏那一行只显示"连没连上"：`AppShell.vue:4-6` 的 `.cx-st`，值来自 `App.vue:92` `store.ready ? '● 已连接' : '○ 载入中'`。
- 切到别的页签时，唯一的痕迹是记录页列表行里一行小字：`RecordsView.vue:18-19` `· 跑着呢`（还要先进记录页、再找到那一行）。
- 「停止」也只存在于对话页的 composer：`ChatView.vue:59` `v-if="session.running" … @click="emit('stop')"`，
  `App.vue:221-226` `onStop`。

**问题**

冻结约束第 3 条是「**必须有固定可见的运行状态**（● 运行中 · 第 N 轮）」（`reports/苍玄助手-计划.md` 4.3）。
现在它只是"对话页可见"：
在跑到一半切去世界书页挑条目、或切去记录页看时间线时（这两个都是跑 agent 时的常见动作），
界面上完全看不出还在跑，也**停不掉**；用户会以为卡死或以为跑完了，再点一次生成 —— 而重复点只有对话页才看得见的那句
toast 在拦（`App.vue:164` `if (busy.value) { notify('还在跑，先停一下'); return; }`）。

**建议**

- 在 `AppShell.vue` 顶栏给一个状态槽：`<span class="cx-st on" @click="emit('goto-chat')">● 运行中 · 第 {{ round }} 轮</span>`，
  由 `App.vue` 传 `running/round/draftCount` 三个 prop。点它 = 回对话页（顺手就能按停止）。6 个页签下都常驻。
- 同一处一起显示草稿：`草稿 N 处`（取 `store.data.drafts.length`，它是跨会话的全部草稿，正是用户要关心的），点它回对话页看 diff。
  这样也替代了 store 里那个**从来没被界面读过**的 `dirty`（`stores/app.ts:125, 178-192, 662`）—— 不必再新造机制。
- 顺便去重：对话页**把草稿数写了两遍** —— `ChatView.vue:12`「草稿 · N 处改动」和 `ChatView.vue:53`「草稿 N 处」。
  顶栏放一份之后，对话页状态行只留运行状态即可，别三处重复同一个数。

**代价**：小。AppShell 加 1 个 prop + 1 个 emit 转发、App.vue 加一个 computed、复用现有 `.cx-st`/accent 变量。
风险：顶栏变挤（375px 下「苍玄助手 ● 运行中 · 第 3 轮 草稿 2」可能一行放不下）——
写成两行或让标题在运行中收缩，交给视觉审查定。

---

### 【5】失败提示跟成功长得一样、活 3.2 秒、还经常被弹窗遮住

**现状（引代码）**

- 唯一的提示通道：`App.vue:112-116` `notify()` + `App.vue:107` 的 `toastStyle`（写死 `background:rgba(45,212,191,.16); color:#2dd4bf`，青色，
  `z-index:20`），3200ms 后自己消失。
- 所有失败都走它，且**和成功同一套样式**：跑挂了（`App.vue:192-196`，直接把 `Error.message` 拼进去）、
  写回结果（`App.vue:291`，成功和失败共用一句 `notify('已写回世界书：成功 N 处，失败 M 处')`）、
  导出失败（`App.vue:263-274`）、导入失败（`App.vue:396-400`）、获取模型失败（`App.vue:341-344`）。
- 这些失败**不落记录**：runner 的 `notice` 只调 `args.onNotice`（`runner.ts:548-551`）→ toast，
  没有 `store.logEvent`；所以记录页时间线（RecordsView.vue:46-66）里看不到 run 级异常，
  能看到的只有 `ok:false` 的工具事件（`core/types.ts:344-357`）。
- 弹窗开着时 toast 被压住：`.cx-backdrop` `z-index:99`（`global.css:1091-1097`）> toast 的 20。
  也就是在草稿 diff 弹窗里点「导出 JSON」（ChatView.vue:79 → App.vue:297-303）、
  在产物弹窗里点「保存 JSON」（PortraitsView.vue:80）时，成功/失败提示基本看不清。

**问题**

失败是最需要被看见的信息，现在它：颜色和成功一样、只活 3.2 秒、正文可能是很长的报错、消失后无处可查、还可能被遮罩压住。
用户唯一的下场是"刚才好像闪了一下红的？"。

**建议**

- `notify(text, ok = true)` 加一个成败参数：失败时 toast 用 `--qx-danger`（描边或文字），
  `App.vue:107` 的 `toastStyle` 改成按状态取色；`z-index` 提到 100 以上（跟 Sheet 同层或更高）。
- 失败的 toast **不自动消失**（或延长到 8-10 秒），并给一个 ✕；同一位置改成"最近一条"堆叠也可以（极简：只保一条）。
- 落一组事件到记录页：在 `App.vue:194-196` 的 catch 和 `onSaveDrafts` 的失败分支里调一次
  `store.logEvent('notice', { title: '跑挂了', text: 错误正文, ok: false })`（`stores/app.ts:527-531` 现成），
  这样时间线里能事后复盘，也不违反"每一步都留痕"的既定原则。
- 写回失败时至少把**失败的世界书名**拼进 toast（`runner.saveDrafts` 里已有 `report.worlds` 明细，`runner.ts:600-606` 只是 `console.warn`）。

**代价**：小-中。样式与时长是几行；落事件是 catch 里加一行（`logEvent` 已存在）。风险：失败常驻可能挡住底部输入区，
建议放在顶栏状态区而不是 bottom toast —— 与提案 4 合起来做最省事。

---

### 【6】能力页工具详情里的「在当前这个预设里启用」是第二份「本次配置」，还和两级启用方向冲突

**现状（引代码）**

- 能力页明明立了"一份清单只有一个入口"的规矩：`CapabilityView.vue:45-48` 写着
  「这个预设用哪些工具，去「设置 · 预设」勾 —— 一份清单只有一个入口」，`CapabilityView.vue:21-28` 的行也只负责"点进详情"。
- 但打开详情后，里面**还有一个写同一个 `preset.tools` 的开关**：`CapabilityView.vue:11-19` 把
  `:enabled="toolOn(openTool)"` 和 `@toggle-enabled="toggleTool(openTool)"` 传进详情；
  `CapabilityView.vue:143-154` 的 `toolOn/toggleTool` 直接 `splice/push` 当前预设的 `tools`；
  `ToolDetail.vue:99-105` 渲染「在当前这个预设里启用」+ 说明"只是这个预设的勾选"。
- 设置 · 预设里那份多选（`SettingsView.vue:118-127` + Sheet `181-204`）写的是同一个数组。

**问题**

1. 同一个"本次配置"两处可写：能力页详情里的开关、设置·预设的多选。用户在其中一处改了，另一处不会提示发生了什么，
   出问题时也不知道该去哪儿核对（这正是上一轮 UI 整理想消灭的东西，`reports/苍玄助手-UI整理.md` 二.1）。
2. 更关键：按 `reports/苍玄助手-预设与上下文.md` 四的两级口径，**能力页代表"全局默认"**，
   预设里那个开关才代表"单独启用预设能力"。而现在的开关文案（"在当前这个预设里启用"）恰好把两者说反了。
   改造时如果只是把这个开关删掉，能力页就没有"全局默认"的开关了；如果留着不改文案，就会和新的两级模型正面对冲。

**建议**

- 与 Lead 的两级改造一起做，能力页那个开关**保留但换语义和文案**：
  位置不变（`ToolDetail.vue:99-105` 第 4 块），文案从「在当前这个预设里启用」改成
  「全局默认启用 / 停用（预设里可单独覆盖）」并说明优先级；写路径从 `preset.tools` 改成全局默认字段
  （现在没有这个字段，建议加在 `tool_overrides` 体系里，因为那里已经是"工具级配置"的唯一写入口，`stores/app.ts:546-571`）。
- 同时把 `CapabilityView.vue:143-154` 的 `toolOn/toggleTool` 从"改预设"摘掉；
  `CapabilityView.vue:45-48` 的说明改成两句："启用默认在 能力 页改；这个预想要用哪几个，去 设置 · 预设 勾"。
- 如果 Lead 想先落地两级再说，**最低限度**：把 `ToolDetail.vue:101` 的文案改成「（临时）在当前这个预设里启用」+
  一句"全局默认开关在两级启用改造后放这里"，避免用户把它当成新模型的开关。

**代价**：小（文案 + 一个写路径换地方）。风险：需要和新全局字段一起改，属于"必须与 Lead 同一步"的条目 ——
建议列进他的两级启用任务，而不是独立改。

---

### 【7】二级导航段位与工具详情不记忆：每次改完去看效果，回来要多点 2 下

**现状（引代码）**

- 设置页段位是本地 ref、固定从第一段开始：`SettingsView.vue:354` `const seg = ref('api')`（`SET_SEG_ITEMS` 见 321-325）。
- 能力页同理：`CapabilityView.vue:118` `const seg = ref('tools')`；而且一旦换段，打开的详情/快捷弹窗被清掉
  （`CapabilityView.vue:209-214` `watch(seg, …)`）。
- 视图是 `v-if/v-else-if` 切换的（`App.vue:3-59`），切走就卸载、切回重建 → 段位必然回到第一段。
- 「去设置」还落不到想要的段：`PortraitsView.vue:9` `emit('open-settings')` → `App.vue:9` `goto('settings')`，
  而设置页默认段是「接口」（`SettingsView.vue:354`）；`PortraitsView.vue:20` 的提示语却说"在设置页里选一个（预设）"。

**问题**

典型路径"改工具提示词 → 切对话页试一句 → 回来接着改"：
回来时落在「接口」段（改一次提示词要多点 2 下），工具详情也关了（又多 1 下）。
这不是大问题，但它**每次**都发生，是流程 2 里唯一稳定的摩擦点（见第 2 节点击统计）。

**建议**

- 段位与"当前打开的工具"提到 `App.vue` 的 ref（或 store 的临时字段，不落持久化也行）：
  `SettingsView`/`CapabilityView` 各加一个 `seg` prop + `update:seg` emit（照 `AppShell.vue:14-16` 的 `update:tab` 写法）。
  比 `<KeepAlive>` 更可控 —— KeepAlive 会顺便记住滚动位置和展开状态，反而不符合"每次回到干净的列表"。
- 如果不想加 prop：让「去设置 →」带上目标段（`goto('settings', 'preset')`），至少让 1 是直达的。
- `PortraitsView.vue:9,20` 的语义要定一个：这个按钮到底是"配接口"还是"选预设"？
  页面上`PortraitsView.vue:12-15` 本来就有预设下拉，我**倾向**把按钮改名「配接口 →」并保留落到「接口」段，
  它是页面上唯一需要去别处的动作；提示语 v20 改成"这里有内置预设，没有合适的再自己去建"。

**代价**：中（3 个视图各加 1 个 prop/emit）。风险：低；不碰数据模型。

---

### 【8】立绘页「生成」会把用户瞬移到对话页，并且空需求也照跑

**现状（引代码）**

- `PortraitsView.vue:57-61` 底部实心键 `:disabled="!preset || generating"`，文案只有「生成 / 生成中…」。
- `App.vue:204-211` `onGenerate`：先只校验角色（`character_ids.length === 0` → `notify('先勾几个角色')`），
  然后在 agent 预设下**先跳页再跑**：`if (preset && preset.kind === 'agent') { goto('chat'); } await runOnce(store.data.selection.demand);`。
- `demand` 可以是空串（`PortraitsView.vue:53` 的 textarea 没有必填校验，`App.vue:210` 也没检查），
  而 runner 对空 input 不会补用户轮：`runner.ts:295-308` `pendingUserTurn` 在 `input` 为空时返回 `null`，
  `agent/loop.ts:205` 也是 `if (… input.user.trim() !== '')` 才建 user turn。

**问题**

1. 点"生成"被扔到另一个页面，没有一句解释；用户会以为点错了或页面跳了。
2. 需求为空时照样发一轮请求（白烧 token/额度），而且**对话里不会出现任何用户气泡**，事后完全看不出这一轮为什么跑、
   用户想要什么 —— 复盘断链。
3. 同一个按钮在 plain 预设下是"原地生成产物"、在 agent 预设下是"跳页跑对话"，行为不同却长得一样。

**建议**

- 按钮文案按预设分支：agent →「去对话页让苍玄改」/ plain →「生成」；或在 agent 分支先 `notify('这是 Agent 预设，去对话页开工')` 再跳。
- 补空需求校验，和已有的"先勾几个角色"对齐：`if (!store.data.selection.demand.trim()) { notify('先写一句用户需求'); return; }`（`App.vue:205-206` 旁边）。
- 如果 agent 预设下本来就想让用户在对话页自己说需求，那应该在跳页后**把光标聚焦到对话输入框**（`ChatView.vue:58`，需要一个 `focus` 时机），
  而不是直接拿空的 demand 开跑。

**代价**：小。改 App.vue 3 行 + PortraitsView 按钮文案 1 行。

---

### 【9】术语统一：同一件事现在有三个名字

**现状（引代码）**：这类问题单看每一处都不算错，合起来会让新用户建立不起词典。

| 同一件事 | 现在的叫法（位置） |
|---|---|
| 会话 / 聊天记录 | 页签叫「对话」（`ui_types.ts:104`）、页签叫「记录」（`ui_types.ts:105` / `RecordsView.vue:6`）、新会话标题叫「新对话」（`core/types.ts:363`）、清空动作叫「清空对话」（`SettingsView.vue:172`）、确认语叫「清空当前对话？」（`App.vue:406`） |
| 草稿落地 | 草稿条叫「保存」（`ChatView.vue:15`）、弹窗里叫「全部保存」（`ChatView.vue:80`）、时间线事件标签叫「保存」（`ui_types.ts:197` 的 `apply`）、成功提示叫「已写回世界书」（`App.vue:291`） |
| 预设的子类 | 「Agent 类型 / 普通类型」（`SettingsView.vue:363`）、「Agent 预设」（`SettingsView.vue:375-379`）、立绘页只报数量不报类型（`PortraitsView.vue:122`） |
| 工具行的标签 | 「已改过 / 默认」（`CapabilityView.vue:36`）指的是**提示词覆盖**，很容易被读成"已启用" |
| 同一件事在两级模型里 | 改造中：能力页 = 全局默认、预设里 = 单独启用（`reports/苍玄助手-预设与上下文.md` 四）—— 现在的能力页文案还没有这两个词 |

**问题**

用户需要在脑子里维护多套同义词（记录=对话=会话；保存=全部保存=写回）。这不影响功能，但会持续制造
"我点的是不是同一个东西"的犹豫 —— 而这正是上一轮把工具清单从两处收成一处的初衷。

**建议**：定一张词表，不必一次改完（建议先定，再随上面几条的改动顺路替换）：

- 对外统一「**对话**」指当前这条；「**记录**」只做页签名，正文/提示语里一律写"对话记录"，别再混用"会话/记录/对话"。
- 草稿按钮统一为「**保存到世界书**」（草稿条、draft 弹窗、时间线标签都跟着改），成功提示改成"已保存 · 成功 N 处"。
- 预设类型词随 Lead 去 `kind` 一起消失：改成按能力描述 —— 「带工具的预设 / 不带工具的预设」，或直接用"工具 N 个 · 技能 M 个"。
- 能力页工具行标签从「已改过 / 默认」改成「**提示词已改 / 内置默认**」；与"启用"区分开。
- 两级启用落地时把两个词一次写死：能力页叫「**全局默认**」，预设里叫「**单独启用预设能力**」（后者的文案 Lead 已经定了）。

**代价**：小但要扫全仓文案，且必须在 Lead 落地去 `kind` 之后一起做（否则改两遍）。风险：低。

---

### 【10】草稿条缺「丢弃」，而设置页那个「丢弃草稿」会连带清掉别的会话

**现状（引代码）**

- 草稿条只有两个动作：`ChatView.vue:14-15` 「看 diff」「保存」。**没有"这轮改得不对，别保存"的出口。**
- 唯一的丢弃入口在 设置 · 数据 · 危险操作：`SettingsView.vue:173` → `App.vue:409-412`
  `if (confirm('丢弃全部草稿改动？')) { store.clearDrafts(); }` → `stores/app.ts:642-646` `data.drafts = []`，**清的是全部会话**。
- store 里其实已有按会话清的能力 `clearDraftsFor(sessionId)`（`stores/app.ts:593-597`），但**全仓没有调用者**（grep 只命中定义与 export）；
  runner 的 `dropDrafts()`（`runner.ts:91, 622-625`）同样没有调用者。
- 顺带一个有连带关系的既有行为：保存走的是 `runner.saveDrafts` → `DraftStore.apply`，
  而 `DraftStore` 是 `createRunner()` 里的**长期单例**（`runner.ts:366-368`），`apply` 不按会话过滤
  （`agent/draft.ts:318-345` 只按世界书分组）→ 在对话 A 点保存，会话 B 里没保存的草稿会被一起写回世界书并清掉。

**问题**

1. 主流程（流程 1）缺一个反向动作：跑完发现改错了，用户只能"保存了再改回来"或者跑去设置页冒一次危险操作。
2. 设置页那个按钮的语感是"丢弃草稿"，用户很可能在一个会话里点它，实际丢掉了所有会话的草稿 —— 且没有撤销。
3. 上面那条"跨会话一起落地"同样是 UI 语义问题（"保存"看起来只保存当前对话）。**这条属于数据层，界面不该单方面兜**，
   但界面至少要说清楚。

**建议**

- 草稿条 `ChatView.vue:14-15` 加第三个键：「丢弃」（.cx-ghost.dim），点了弹一个 Sheet/confirm 说明"只丢弃当前对话的 N 处未保存改动"，
  然后调 `store.clearDraftsFor(store.activeSessionId)` + runner 侧按 id 摘草稿（`DraftStore.remove(id)` 已有，`agent/draft.ts:284-289`）。
  最小版本：先复用 `runner.dropDrafts()`，但**必须**在确认语里写明"会丢掉全部对话的草稿"，别让用户以为只是当前这条。
- 设置页那个按钮（`SettingsView.vue:173`）文案改成「丢弃全部对话的草稿」。
- 跨会话一起落地这件事建议单独立一条给 Agent 内核/数据层（`DraftStore.apply` 加 `sessionId` 过滤 + `saveDrafts(sessionId)`），
  我这边只把它记成"界面必须在文案里说清"的约束。

**代价**：中（新增一个确认态 + 一个 store 调用；按 id 摘草稿要小改 runner 接口）。
风险：如果只做"清全部"，用户会更容易误伤别的会话 —— 所以要么做到按会话，要么先把文案写狠一点。

---

## 4. 建议保持不动（明确结论，不是省事）

- **信息架构本身**：6 页签 + 库/本次/全局 三分（`reports/苍玄助手-UI整理.md` 三）是对的，页面数不要再增减；
  能力页（工具｜技能）与设置页（接口｜预设｜数据）的归属不用动。
- **二级导航的层级深度**：现在是"页 → 段 → 一层 Sheet"（`Sheet.vue`），能力页的工具详情是**整页替换**（`CapabilityView.vue:10-19`）
  而不是再叠一层弹窗 —— 这个做法是对的，不要改成嵌套 Sheet / 抽屉套抽屉。
- **空态**：已经写得不错，逐页都有（`ChatView.vue:44`、`RecordsView.vue:32,67`、`WorldbookView.vue:19,60,61`、
  `CapabilityView.vue:44,198`、`SettingsView.vue:152,224`、`ToolDetail.vue:89`），不需要重写；
  唯一可做的是在 `ChatView.vue:44` 的空态里补一个"当前预设 + 去勾世界书"的直达（已被提案 1 覆盖）。
- **工具卡折叠规则**：`ToolGroup.vue:44-55`（跑动中不折、跑完才折、失败不折、生图永远展开）+ `ToolCard.vue:64-71`（失败/改动自动摊开）
  完全符合冻结约束，逻辑也清楚，不要动。
- **勾选即生效、无保存键**：设置 · 预设的多选与工具覆盖项都是"改了立刻落盘"（`App.vue:110` deep watch + 400ms 防抖，
  `stores/app.ts:178-192`），Sheet 上的「完成」只是关窗 —— 这个语义对移动端是对的（少一次点击），保持；
  只需在 Sheet footer 补一句"点一下即生效"消除疑虑（`SettingsView.vue:202` 的「完成」旁边）。
- **记录页的列表 + 时间线同页**：它面向"事后复盘"而非日常，不进对话页正确；不需要做内嵌滚动或分屏。

## 5. 不属本报告范围（避免和 task-24 重复）

- **点击区尺寸**：`.cx-ghost` 在手机断点下约 35px（`global.css:1645-1648`），顶部 6 个页签约 38.75px
  （`global.css:1631-1634` 的 `padding:10px 0` + `font-size:12.5px`），都不足冻结约束的 40px；
  `.cx-cline`/`.cx-tc` 在手机端也只有 34px（`global.css:1724-1729`，但这一条与"工具卡 28px"的冻结约束直接冲突，需用户裁决）。
  这些是**视觉与排版**问题，交给 task-24 的审查统一给方案，本文不重复提，只在提案 1/10 里确保新增控件不低于 40px。
- 对比度、字号、深浅色一致性、间距节奏同理，不在本文范围。

## 6. 附：本报告核对过的文件

`src/苍玄助手/App.vue`、`views/ChatView.vue`、`views/SettingsView.vue`、`views/CapabilityView.vue`、
`views/RecordsView.vue`、`views/PortraitsView.vue`、`views/WorldbookView.vue`、
`components/AppShell.vue`、`components/SegBar.vue`、`components/Sheet.vue`、`components/Sw.vue`、
`components/ToolGroup.vue`、`components/ToolCard.vue`、`components/ToolDetail.vue`、`components/ToolPromptSheet.vue`、
`components/ui_types.ts`、`stores/app.ts`、`run/runner.ts`、`agent/draft.ts`、`agent/loop.ts`、`core/types.ts`、`global.css`；
文档 `reports/苍玄助手-UI整理.md`、`reports/苍玄助手-计划.md`、`reports/苍玄助手-预设与上下文.md`。
