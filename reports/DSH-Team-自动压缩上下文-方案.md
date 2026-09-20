# Team 自动压缩上下文方案（100k 触发 · 模型自设里程碑 · 阶段完成后自动压缩）

> 配套：DSH-Team-工作流图-现状.md（现状流程）、DSH-Team-工作流图-里程碑压缩.md（新流程）
> 机制依据：DSH 0.1.5-rc.2 本机安装副本 + 一次独立复核，行号见附录 A
> 结论：**不改 DSH 本体即可落地**（新插件包 + profile 一行 patch）；上游化只动 2 个 experimental 包 + 1 个 profile bundle。

---

## 0. TL;DR

| 问题 | 答案 |
|---|---|
| 做在哪一层 | 新插件包 team-context-milestone，与 dsh-experimental-tool-agent-team 并列挂载；用 agent/created + agent.ctx 给**每个 Team 成员**装一份 |
| 100k 怎么测 | ctx.tokenMeter.measure(session).totalTokens（更省：ctx.sessionProjections.stateOf(session,'contextPressure') 读 pressureTokens） |
| 系统提示注在哪 | agent.ctx.systemPrompt.context({name:'team:milestone', order:130, text}) —— DSH 的动态运行时上下文通道，每步重算、位于请求尾部、状态消失即不注入 |
| 模型怎么“设置”里程碑 | 新增 Team 作用域工具 team_milestone_set / team_milestone_complete |
| 完成后怎么自动压 | 收到 complete 后置 durable 标记；在 agent/status=idle 边界调 **ctx.compaction.compactNow(agent, signal, sourceCommandId)**（/compact 用的同一条公开缝） |
| 为什么不能立即压 | compactNow 内部走 agent.runMaintenance()，**要求 idle**（非 idle 抛 ManualCompactionError(busy)）。设计成“声明完成 → 本回合收尾 → 下个 idle 边界压缩”，不打断工具链 |
| 和内置自动压缩冲突吗 | 不冲突。内置 compaction-basic 默认 auto:true、阈值 0.8×contextWindow（本机 800k），继续当兜底；本方案在 100k 处**提前引导**、在里程碑边界**主动压** |
| 最大风险 | 成员长期不回到 idle 会推迟压缩 → 由 hardTokens + 内置 0.8 兜底；另一个风险是压缩过频 → 冷却 + 经济性门控 |
| 能不能彻底关掉 | 能。`enabled: false` 一关，插件等于不存在，Team 立刻回到现状（只剩 DSH 自带的 0.8×window 自动压缩）。压缩完是否自动叫醒队友由 `continueAfterCompact` 单独控制，默认 **false** |

---

## 1. 需求拆解

原话：**team 添加自动压缩上下文功能，在每个 team 上下文达到 100k 后，会有系统提示词让模型可以自己设置一个大阶段里程碑，大阶段任务完成后自动压缩上下文，参考英伟达开源的 sol pi 里面的主动压缩。**

| 编号 | 需求 | 验收点 |
|---|---|---|
| R1 | Team 每个成员（Lead、每个 teammate）上下文各自计费 | 阈值判断互不影响；teammate 与 Lead 的上下文独立 |
| R2 | 某成员上下文达到 100k 时 harness 注入系统提示 | 出现在该成员**下一次模型请求**里；未达阈值绝不出现 |
| R3 | 该提示让模型自己设定一个大阶段里程碑 | 模型可用工具声明 goal/exit_criteria/steps[]；声明后提示切换为里程碑状态卡 |
| R4 | 大阶段完成后自动压缩 | 无需人工 /compact，历史被替换为 checkpoint，会话事件可查 |
| R5 | 参考 SoL-Pi 的主动压缩 | 模型声明边界、harness 决策；有窗口/经济性判断；压完重规划；状态跨重启可恢复 |

非目标：跨进程 Team、teammate 独立工作目录、UI 里程碑面板、对非 Team 的普通 subagent 生效。

---

## 2. 调研一：DSH 机制（决定方案形态）

### 2.1 Team 的真实结构

- Team = Cordis 域服务 ctx.agentTeams（dsh-experimental-agent-team）+ 工具适配层（dsh-experimental-tool-agent-team），由 dsh-experimental-agent-team-profile 的 cordis.patch.yml 插入并关掉重名的全局 subagent 控制行。
- Lead = 会话 root Agent；teammate = continuable-subagent provider（spawn/fork）创建的**直接子 Agent**，各有**独立 Session（独立上下文历史）**；fork 会继承 Lead 的已完成回合前缀。
- 身份：ctx.agentTeams.membership(agent) 得到 {root, id, role:'lead'|'teammate', name}；tryMembership(agent) 对非 Team agent 返回 undefined。
- 工具与提示按**成员 Agent 作用域**安装（tool-agent-team/lib/index.js:231-245、526-547）：agent.ctx.systemPrompt.section(...) 与 agent.ctx.tools.register(...)，由 agent/created 驱动、agent/disposed 卸载。
- **同一个 agent loop**：Lead 与 teammate 跑的是同一套循环，差异只在 Session 与工具集。所以“每个成员各自的 100k”天然成立。

### 2.2 上下文占用怎么读（R1 的计量基础）

- ctx.tokenMeter.measure(session, requestHeader?) 返回 deep-frozen { logRevision, baseline{kind,tokens,usage?}, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes[] }；totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)（dsh-token-meter/lib/index.js:643-686, 682）。
- 口径：优先采用供应商 usage（input+cacheRead+cacheWrite+output，:595-597），若低于路由重估锚点则整段重估。
- 更省的读法：客户端投影 contextPressure（usage-projection.js:48-58, 141-187）给出 { contextWindow, pressureTokens, projectedTokens }，pressureTokens=input+cacheRead+cacheWrite；读法 ctx.sessionProjections.stateOf(session,'contextPressure')（dsh-session-projection:127-132）。
- contextWindow 不在 meter 里：需 await ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow（compaction-basic:895），或直接读上述投影。
- 本机当前模型 contextWindow = 1,000,000（~/.dsh/settings.yaml:1507-1512）→ 100k ≈ 窗口的 10%。

### 2.3 压缩（R4 的执行基础）

服务缝 ctx.compaction（抽象 CompactionEngine，dsh-compaction/lib/types/index.js:44-47），实现 dsh-compaction-basic（dsh-base/cordis.patch.yml:317-326 挂载，另有 /compact 命令）。

| 方法 | 语义 | 约束 |
|---|---|---|
| compactIfNeeded(agent,'pressure' 或 'context-overflow',signal) | 按阈值自动压缩 | 由内置自动钩子在 agent/pre-step 调用；阈值 = floor(contextWindow × thresholdRatio) |
| compactRegion(start,end,agent,signal) | **公开**，压指定表面区间 | 需自选区间；切点必须通过工具调用/结果配对平衡校验 |
| **compactNow(agent,signal,sourceCommandId)** | 强制压缩一次（/compact 用的就是它） | 内部 agent.runMaintenance()，**要求 idle**；返回 CompactionResult 或 null |

- 默认配置（BASIC_COMPACT_CONFIG_KEYS）: thresholdRatio 0.8、retainRatio 0.16、retainTokens（绝对量，与 retainRatio 互斥）、summarizationProvider/Model 空、maxTokens 8192、compactionRetries 1、maxOverflowRetries 1、modelPolicies 空、**auto true**。
- **没有绝对阈值键**：thresholdRatio 是 contextWindow 的比例（:108-125），所以“100k”无法用配置直接表达——必须插件侧自己比较 totalTokens。
- 自动路径（:793-847）：agent/pre-step 里 compactIfNeeded('pressure')；agent/request-error 里对 CONTEXT_WINDOW_EXCEEDED 压缩后返回 {kind:'retry'}；压缩前先调 toolResultPruner 修剪超大工具结果。
- 结果：CompactionResult = { compactionId, sourceCommandId?, startSeq, summarySeq, endSeq, summary[], shadowedRange{start,end}, shadowedSeqs[], shadowedTokenCount }（:633-653）；成功还要求摘要**严格小于**被遮挡部分（:571-572）。
- 产物：一条替换节点（user/message，source = compactCheckpointSource(compactionId, sourceCommandId) 得到 {kind:'plugin', plugin:'compact'}），内容 = CHECKPOINT_PREAMBLE + `compacted-summary» 包裹的结构化摘要（:211-212, 257, 323-335, 567-570, 621-632）。
- 会话事件（观测点）：compaction/start {compactionId, sourceCommandId?, turn}（:452）、compaction/summary（:605-620）、compaction/end（:467；失败时带 error，:478-481）、compaction/prune（pruner :162-169）。
- 切点合法性：validateSurfaceRegion 会拒绝**工具调用/结果配对不平衡**的切点（:533-549），公开助手 toolPairingBalancedBefore/After（dsh-compaction/lib/types/tool-pairing.js:82-95）。
- 失败码闭合：busy / cancelled / changed / summary / commit / persistence。
- 压缩前的历史**仍留在盘上**，回放一致（dsh-compaction/README.zh.md:12, :95）——天然满足 SoL-Pi 的“保留证据”。

> 关键结论 1：内置自动压缩默认 0.8×contextWindow（本机 800k）且默认开启，**100k 不能用改 thresholdRatio 实现**（那是“到期自动压”，与“模型设里程碑、完成后压”语义冲突）。100k 只作为**提醒/准备**触发点。
> 关键结论 2：唯一强制入口 compactNow 要求 idle；回合内强压只能用公开的 compactRegion 自行选区并保证配对平衡。

### 2.4 注入系统提示的三条缝（R2/R3 的关键）

| 缝 | API | 形态 | 缓存/成本 | 适用 |
|---|---|---|---|---|
| A 静态段 | agent.ctx.systemPrompt.section({name,order,text,complete?}) | 进 system prompt 前缀 | 见下方 in-history 机制 | 稳定策略文本 |
| **B 动态 context** | agent.ctx.systemPrompt.context({name,order,text}) | 组装成**一条尾随消息**，每步重算 | 变化只影响尾部 | **本方案首选** |
| C 一次性消息 | agent/pre-step 瀑布里往 messages 追加 plugin source 消息；或 tools/post-execute 返回 additionalContexts | 进历史的 system-reminder | 一次性 | 事件通知（压缩完成/强制边界） |

- 证据：systemPrompt.section/context/variable 定义（dsh-system-prompt:238-266, 336-343）；CONTEXT_ORDERS = {SANDBOX_POLICY:110, APPROVAL_POLICY:115, SUBAGENT_DELEGATION:120}（:43-47），团队插件占 SECTION_ORDERS.TEAM_POLICY=600（:14）。
- 作用域：loop 以 **agent 为 scope** 组装（dsh-agent:258-264 与 dsh-agent-loop:890），所以 agent.ctx.systemPrompt.* 是**按成员**的；root ctx 则是全局。同层重名会抛错并提示改走 agent.ctx。
- pre-step 瀑布契约：{messages,turn,step,signal} 进，默认返回 {kind:'enter', messages:[...claimed, context]}（dsh-agent-loop:885-908）。注意：若用 {prepend:true} 短路，会**跳过**默认的运行时上下文追加，必须自己补。
- 一次性消息写法（dsh-repeat-tool-reminder:1377-1380, 1483-1512）：createUserMessage({content:[{type:'text',text}], source:{kind:'plugin', plugin:'<name>', form:'notice', summary}}) —— source 必须打标，否则会渲染成用户发言。
- 文案约定：dsh-agent-instructions 用 `system-reminder» ... `/system-reminder» 标签包裹并转义闭合标签（:111-112, 127-129）。
- **前缀缓存的重要利好**：DeepSeek 路由声明 systemPromptUpdate = 'in-history'（dsh-llm-deepseek:1849, 1882；dsh-llm:2057-2058），system prompt 变化会被**追加为新的 system/message 节点**而不是重写 node 0（dsh-agent-loop:274-283），因此即使在 section 里改文本也不会摧毁已缓存前缀（代价是多一条历史节点）。其它路由或新请求序列（换工具、表面替换）仍会重写 node 0。

### 2.5 生命周期与并发约定

- 事件：agent/created、agent/status（running|idle）、agent/pre-step、agent/turn-stopping、agent/request-error、agent/disposed、session/event。
- agent.status：maintenance 阶段也报 **idle**（dsh-agent-loop:773-776）；压缩期间 Lead 看到的 teammate 仍是 idle，但 send_message 会被 maintenance.wakeRequested 闩住并在压缩结束后自动唤醒投递（:805-828, :837-843），消息不丢。
- send/followup/steer/inject（:783-797）：followup=入队+唤醒（等价 SoL-Pi 的 triggerTurn），inject=只入队不唤醒。
- 持久化：session.append(type,data,opts) 允许自定义事件类型（先例 sandbox/mode、approval/policy），配 ctx.sessionProjections.register({key,stateVersion,stateSchema,init,apply}) 得到可回放的派生状态。

### 2.6 装配方式

- profile 的 cordis.patch.yml 支持按 id 改配置与 insert 新行；bundle 顺序在 profile package.json 的 dsh.profile.bundles。
- 插件契约：导出 name / inject / Config(schemastery z) / apply(ctx,config)；或 Service 子类 + static inject + static Config + constructor(ctx,config)。
- 本机现状：~/.dsh/profiles/desktop/cordis.patch.yml 已把 agent-team.maxMembers 提到 30 并 insert 了 chrome-devtools MCP —— 新插件加在同一处。

---

## 3. 调研二：NVIDIA SoL-Pi 的主动压缩

- 仓库 https://github.com/NVlabs/SoL-Pi （MIT，TypeScript，装在 Pi harness 上的扩展；组件 src/sol-pi/extensions/online-context-compact/）
- 论文 https://arxiv.org/abs/2609.20519

**范式**：模型通过 update_plan 维护完整计划；**任何一步从 in_progress 变为 completed 就是一次阶段边界**；harness 在回合末校验边界是否干净（无 error/abort、工具结果非错误），再用**经济性不等式**与**窗口保护**决定压不压；决定压就 abort 当前回合并调 Pi 原生 compaction；成功后发隐藏 triggerTurn 消息自动开新回合，并要求模型先重规划（recordCompaction 清空 plan）。

可直接复用的设计要点：

1. **声明与执行分离**：模型只声明边界，压不压由 harness 决定（防止模型拿压缩逃避工作）。
2. **边界要在回合末校验**：有错或被中断的回合不算边界。
3. **经济性门控**：breakevenRequests = writeTokens × (cacheWriteReadRatio − 1) ÷ saving ≤ horizon；saving = archiveTokens − memoTokens，archiveTokens = writeTokens − systemPrompt − keepRecentTokens（keepRecentTokens 默认 20k，cacheWriteReadRatio 默认 12.5）；首次压缩放宽，后续要求更大余量。
4. **窗口保护旁路**：contextTokens ≥ contextWindow − 16,384 时无视经济性直接压。
5. **保留证据**：原文留盘（DSH 天然满足：压缩前事件仍在会话日志里）。
6. **压完必须重新规划**：POST_COMPACTION_PLAN_REMINDER + 自动续跑。

不照搬的部分（诚实标注）：Pi 的 cache 定价遥测在 DSH 侧不完全等价（我们只能从 assistant/message 的 usage 与自报 contextWindow 推算，故把 cacheWriteReadRatio 做成配置项）；Pi 允许回合中途 abort 再压，DSH 的强制入口要求 idle；论文里的收益数字属二次调研，立项前建议对照原文复核，本方案不依赖这些数字。

对标：Claude Code 的 /compact 与 auto-compact window（人/阈值触发）、Codex 的 model_auto_compact_token_limit（阈值）、Letta 的 memory block（模型编辑记忆但不控制压缩点）、langmem 的 max_tokens_before_summary（阈值）。**“模型声明边界 + harness 决策”这一层，SoL-Pi 是唯一直接对标。**

---

## 4. 方案设计

### 4.1 形态选择

| 方案 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **B（先做）** | 新插件包 team-context-milestone，只用公开缝：agents / agentTeams / tools / systemPrompt / tokenMeter / compaction | 零改 DSH 本体，今天就能在本机 profile 跑 | 状态自持（用 session 事件） |
| A（上游化） | packages/experimental/ 新增同名包 + agent-team 域加 milestone 记录 + 新 profile bundle 行 | 与任务板同级持久化/CAS，Lead 可跨成员查询，UI 可展示 | 动 DSH 本体与发布流程 |

同一份状态机代码，A 只是把“状态存哪”从 session 事件换成 Team journal。

### 4.2 状态机（每个成员一份）

- clean：无里程碑。每步读占用；≥ armTokens 且 < hardTokens → armed。
- armed：注入“设定里程碑”指令（常驻 context）；首步立即注入，之后按 reminderCooldownSteps（默认 8）温和重述，最多 maxArmSteps（默认 40）次；≥ hardTokens（默认 600k）→ 直接 compressing 并注入强制边界告警。
- active：常驻 context 换成里程碑状态卡；模型用 team_milestone_set 更新步骤（CAS）。
- compressing：等待 idle；成功后 epoch+1、里程碑归档进 history（留最近 3 条）、回 clean；**下一次请求立刻重新注入「当前里程碑状态」（B 方案，见 4.4）**，再叠加 POST_COMPACTION_REMINDER；是否自动叫醒队友由 continueAfterCompact 决定（默认 false，按 Team 的节奏应由 Lead 派下一单）。
- **总开关**：enabled=false 时 apply() 直接不装任何作用域，等于插件没挂载；dryRun=true 时只走提示与计量，绝不调 compactNow，用于试水。
- 被 interrupt_agent 或回合出错：状态不变，只是推迟。

### 4.3 关键代码骨架（真实 API）

```ts
// 入口：只对 Team 成员装作用域
export const name = 'team-context-milestone';
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'tokenMeter', 'compaction'];

export function apply(ctx, cfg) {
  if (cfg.enabled === false) return;      // 总开关：关掉后零作用域、零提示、零压缩
  const installed = new Map();
  const maybeInstall = (agent) => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return;
    installed.set(agent, install(agent, ctx, cfg));
  };
  for (const a of ctx.agents.list()) maybeInstall(a);
  ctx.on('agent/created',  ({ agent }) => maybeInstall(agent));
  ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent); });
  ctx.effect(() => () => { for (const d of installed.values()) d(); installed.clear(); },
             'team-context-milestone.scopes()');
}

// 每个成员作用域
function install(agent, ctx, cfg) {
  const scope = agent.ctx;
  const d = [];
  // (1) 常驻系统提示：每步重算，位于请求尾部
  d.push(scope.systemPrompt.context({
    name: 'team:milestone',
    order: 130,                                  // CONTEXT_ORDERS.SUBAGENT_DELEGATION = 120 之后
    text: (assembly) => renderMilestoneContext(stateOf(agent), cfg, assembly),
  }));
  // (2) 每步计量 + 状态推进 +（必要时）一次性提醒
  d.push(scope.on('agent/pre-step', async ({ agent: a, turn, step, signal }, next) => {
    const ev = await advance(a, { turn, step }, cfg);        // clean→armed / hard→compressing
    const downstream = await next();
    if (downstream.kind !== 'enter' || ev.oneShot.length === 0) return downstream;
    return { ...downstream, messages: [...downstream.messages, ...ev.oneShot] };
  }));
  // (3) 两个工具
  d.push(scope.tools.register(setTool));
  d.push(scope.tools.register(completeTool));
  // (4) idle 边界执行压缩
  d.push(scope.on('agent/status', ({ agent: a, status }) => { if (status === 'idle') void drain(a); }));
  return () => { for (const x of d.reverse()) x(); };
}

// 压缩：唯一被强约束的一步
async function drain(agent) {
  if (!isCompressing(agent) || !takeSlot(cfg.maxConcurrentCompactions)) return;
  if (agent.status !== 'idle') return;                       // 必须 idle
  try {
    const result = await ctx.compaction.compactNow(agent, new AbortController().signal, undefined);
    if (result === null) finishEpoch(agent, { kind: 'nothing-to-compact' });
    else finishEpoch(agent, { kind: 'compacted', shadowedTokens: result.shadowedTokenCount,
                              seqs: result.shadowedSeqs.length });
    // 默认 false：不自动叫醒，等 Lead 派下一单；true 才会主动唤醒队友续跑
    if (cfg.continueAfterCompact && hasRemainingWork(agent)) agent.followup(postCompactReplan(agent));
  } catch (e) {
    const code = e?.name === 'ManualCompactionError' ? e.code : 'unknown';   // busy|cancelled|changed|summary|commit|persistence
    noteCompactionFailure(agent, code);                                      // busy → 下个 idle 重试
  } finally { releaseSlot(); }
}
```

> 竞态：agent/status=idle 与 compactNow 的 runMaintenance 之间可能被唤醒；runMaintenance 非 idle 时**同步抛错**，映射为 busy —— 当作“下个 idle 再来”，无需额外锁。
> 若必须在**回合内**压（例如模型声明完成但整回合跨度极长）：不能调 compactNow，需自己用公开的 measure().nodes + toolPairingBalancedBefore/After 选区，再调 compactRegion(start,end,agent,signal)。属于阶段 3 的可选增强，MVP 不做。

### 4.4 状态与持久化（B 方案）

- Durable：每次状态迁移 agent.session.append('team-milestone/state', {epoch, phase, milestone, historyTail, counters, at})；用 ctx.sessionProjections.register({key:'teamMilestone', stateVersion:1, stateSchema, init, apply}) 回放。崩溃/重启无需额外存储即可恢复。先例：sandbox/mode、approval/policy。
- **B 方案：里程碑状态必须活过压缩。** 压缩只替换对话历史（surface），不会动 system prompt 与投影状态，所以：
  1. 压缩**前**把当前里程碑的 goal / exit_criteria / steps / evidence 冻结进 'team-milestone/state'（这一步本来就有，关键是**不要**把它和 history 一起归档清空）；
  2. 压缩**后**的下一次 pre-step，renderMilestoneContext 直接把这个冻结值渲染出来 → 队友醒来自带主线（"我在干什么、干到哪、怎么算干完"），不必依赖摘要会不会提到；
  3. 摘要只作为细节补充。摘要丢主线也不影响任务连续性——这是 B 相对 A（只靠摘要）的核心价值。
- 归档仅清空"已完成"里程碑的 steps 明细，goal 与 exit_criteria 进 history 尾部（保留最近 3 条）供追溯。
- Runtime 索引：插件内 WeakMap 存阈值节流、步数计数等易失量。
- A 方案增量：把 milestone 写进 Team journal（新增 team/milestone-* 事件 + projection + TeamService 方法），Lead 即可跨成员查询。

### 4.5 注入的提示词（初稿，必须用 dryRun 验证后再定稿）

> **诚实声明**：下面四段是**我手写的初稿**，不是验证过的定稿。其中只有 SoL-Pi 的两句
> （BOUNDARY_COMPACTION_INSTRUCTIONS、POST_COMPACTION_PLAN_REMINDER）有原文可参照，其余措辞都是推测。
> 提示词工程没有"一次写对"，**这四段必须做成可配置模板 + 用 dryRun 跑真实任务迭代**（见 4.5.1）。
> 风险点：(a) 一次要求 4 个字段，模型可能只填 goal 就交差或把 steps 写成废话； (b) 状态卡每步注入，可能过于啰嗦。

**(a) armed 常驻 context**

```text
<system-reminder>
Context budget checkpoint: your context is at ~{{totalTokens}} tokens (soft budget {{armTokens}} of {{contextWindow}}).
Declare ONE large milestone now with team_milestone_set — a coherent stage whose completion is independently
verifiable, not a single tool call:
- goal: one sentence defining what "this stage is done" means;
- exit_criteria: concrete checks a reviewer could run;
- steps: 1..{{maxMilestoneSteps}} ordered steps, at most one in_progress;
- evidence: files/commands that prove the stage.
When the whole milestone is verified, call team_milestone_complete. The harness then compacts your history at
the next idle boundary and you continue from the checkpoint — so put durable facts (paths, decisions, commands)
into the milestone, not into the transcript.
</system-reminder>
```

**(b) active 常驻状态卡**

```text
<system-reminder>
Milestone (epoch {{epoch}}, step {{k}}/{{n}}): {{goal}}
exit_criteria: {{exit_criteria}}
steps: {{steps}}
context: ~{{totalTokens}} tokens. When the last step's verification passes, call team_milestone_complete.
</system-reminder>
```

**(c) 压缩完成后一次性消息（借鉴 SoL-Pi 的 POST_COMPACTION_PLAN_REMINDER）**

```text
<system-reminder>
Milestone {{goal}} was compacted into the checkpoint above (freed ~{{freedTokens}} tokens).
The parent task is still active. Before doing more work, re-read the checkpoint and call team_milestone_set
with a fresh milestone for the remaining work.
</system-reminder>
```

**(d) 强制边界（hardTokens 兜底）**

```text
<system-reminder>
Context budget hard limit reached (~{{totalTokens}} tokens) and {{armSteps}} reminders produced no milestone.
The harness is compacting your history at the next idle boundary. Immediately record the durable facts you
cannot afford to lose (team_milestone_set or a file), then continue.
</system-reminder>
```

措辞要点（来自 SoL-Pi 的经验）：**只说“harness 会在下一个 idle 边界压缩”，不能说“调用它就会压缩”**——决策权留在 harness，经济性不足时可以不压，模型侧不会觉得被骗。

### 4.5.1 提示词迭代流程（承认"初稿不可靠"的工程姿势）

**第一原则：四段提示词全部作为 Config 模板暴露，默认值只是兜底，不改代码就能调措辞。**

«««ts
Config = z.object({
  // 四段模板，支持 {{totalTokens}} / {{armTokens}} / {{goal}} 等占位符
  promptArmed:    z.string().default(DEFAULT_ARMED),
  promptActive:   z.string().default(DEFAULT_ACTIVE),
  promptPostCompact: z.string().default(DEFAULT_POST_COMPACT),
  promptHardLimit: z.string().default(DEFAULT_HARD_LIMIT),
});
«««

**为什么必须这样**：提示词写死等于把"未经验证的措辞"固化进代码，日后每次调整都要发版。做成模板后，调措辞 = 改一行 YAML + 重启，可以快速试十几个版本。

**迭代步骤**：

| 步骤 | 做法 | 看什么 |
|---|---|---|
| 1 最小可用版 | 先把 (a) 砍到只剩一句话：「你的上下文到了 {{totalTokens}}，可以用 team_milestone_set 声明一个大阶段；声明完成并验收后我会帮你压缩历史。」 | 模型**会不会调用工具**（不调就是措辞没让它明白"这是个动作"） |
| 2 补字段 | 模型调了但字段残缺，再逐条补要求（先补 goal，再补 exit_criteria，最后补 steps） | 每次只加一条要求，看**字段完整率**变化，避免一次加太多反而全崩 |
| 3 测 (b) 状态卡 | 观察 active 阶段每步注入的状态卡 | 模型是否照着 steps 走；token 开销是否值得 |
| 4 测 (c) 重规划 | 压缩后看模型是否重建里程碑 | 不重建 = 措辞不够强，或摘要已足够、可考虑删掉这段 |
| 5 测 (d) 强制边界 | 人为让模型一直不声明 | 模型收到 (d) 后是否会把要紧信息写下来 |

**量化指标**（建议 dryRun 期间记录）：

- 调用率：越过 armTokens 后 N 步内调用 team_milestone_set 的比率（目标 > 80%）
- 字段完整率：goal / exit_criteria / steps 三项齐全的比率（目标 > 70%）
- 步骤质量：steps 是否可验收（人工抽样，目标：不出现"完成这个任务"级别的废话）
- 打扰度：模型是否在无关场景被提示带偏（观察是否出现"我要不要建个里程碑"之类的废话输出）

**坑**：指标不达标时，**优先怀疑提示词**而不是模型能力——同一件事换个说法，调用率可能从 30% 跳到 90%。

### 4.6 工具 schema（仅 Team 成员可见，只加 2 个）

team_milestone_set：

```json
{ "goal": "string (必填, ≤512B)",
  "exit_criteria": "string (必填, ≤4KB)",
  "steps": [ { "id": "string", "goal": "string", "status": "pending|in_progress|completed" } ],
  "evidence": ["string (≤8 条, 每条 ≤1KB)"],
  "expected_revision": "integer (可选, CAS)" }
```

team_milestone_complete：

```json
{ "goal_ref": "string (必填)", "verified_by": "string (必填)", "residual_work": ["string"] }
```

- steps ≤ maxMilestoneSteps（默认 16；SoL-Pi 是 128，但 DSH 对 schema 与上下文成本更敏感）。
- 结果用紧凑 JSON（jsonOutput 风格），与现有 9 个 Team 工具一致。
- complete 只是**意图**：它把状态推进到 compressing，真正压缩由 idle 边界 + 门控决定。
- 与 team_task_* 不合并：任务板管“细粒度可认领工作”，里程碑管“大阶段 + 上下文边界”；任务跨成员，里程碑是每成员私有。

### 4.7 触发与执行时序（含边界校验）

1. pre-step：读占用（measure 或 contextPressure 投影）→ 状态推进。
2. 达到 armTokens 且 clean → armed；注入 (a)（不再追加历史消息，避免重复占用）。
3. 模型调 team_milestone_set → 校验（steps 非空、长度上限、revision CAS）→ active。
4. 模型调 team_milestone_complete → **边界校验**：本回合无 error/abort、工具结果非 error（可从 agent/turn-stopping 与 tools/post-execute 判定）；不满足则返回结构化拒绝，状态不变。
5. 通过 → compressing；durable append；本回合正常收尾。
6. agent/status=idle → drain()：信号量 → 冷却（minEpochIntervalTokens）→ 经济性/窗口门控（阶段 2）→ compactNow。
7. 成功：监听 compaction/start 到 summary 到 end 确认替换节点已落盘、replaceGeneration+1；epoch+1；注入 (c)；可选 followup。
8. 失败：busy 等下个 idle；summary/changed/commit/persistence 退避重试 ≤3 次，仍失败则冻结该成员的里程碑压缩并把失败码用 notice 告知 Lead（绝不静默）。

### 4.8 经济性门控（阶段 2，SoL-Pi 不等式的 DSH 版）

```text
requestCount(milestone)  ← 两次里程碑之间 assistant/message 的条数
remainingSteps           ← 当前里程碑未完成步骤数（含 history 里未完成里程碑）
horizon  = 1 + floor(meanRequestsPerMilestone × remainingSteps)
           cap 到 floor((contextWindow − totalTokens) ÷ avgContextDeltaPerRequest)
writeTokens   = totalTokens
archiveTokens = writeTokens − systemPromptTokens − keepRecentTokens   (keepRecentTokens 默认 20000)
saving        = archiveTokens − memoTokens                            (memoTokens 首次压缩后实测回写)
breakeven     = writeTokens × (cacheWriteReadRatio − 1) ÷ saving      (cacheWriteReadRatio 默认 12.5，可配)
压缩当且仅当 breakeven ≤ horizon   或   totalTokens ≥ contextWindow − reserveTokens(16384)
```

DSH 侧可用实测输入：assistant/message 的 usage（含 cacheReadTokens/cacheWriteTokens）、measure().totalTokens/surfaceTokens、上一次的 shadowedTokenCount、替换节点的实际占用。**必修防护**：首次压缩后实测 memoTokens 并回写基线，否则 saving 全靠猜。

### 4.9 与内置压缩的关系

内置 compaction-basic 默认 auto:true、阈值 0.8×contextWindow、回合中途执行，继续作为兜底保留；不要为 100k 去改 thresholdRatio。可选：为 Team 成员的 modelPolicies[].thresholdRatio 设 0.5，作为“模型完全无视提示”的第二道网。四条路径共用同一个 ctx.compaction 与 durable lock，不会互相踩踏。

### 4.10 KV cache / 前缀稳定性

- 提示走 B 通道（动态 context）与 C 通道（一次性消息），不新增 system prompt section。
- 额外利好：DeepSeek 路由声明 systemPromptUpdate='in-history'，即使将来把状态卡放进 section，改动也只是**追加一条 system/message 节点**而不是重写 node 0（多一条可被压缩的历史节点）。
- renderMilestoneContext 每步允许变化，但它在请求尾部；真正跨步稳定的部分在它之前。
- 占用数字每步变化会让尾部缓存失效 → 提供 quantizeTokens（把数字量化到 5k 档；active 态每 N 步才刷新）。

### 4.11 失败模式与兜底

| 场景 | 处理 |
|---|---|
| 模型长期不声明（armed 到 maxArmSteps） | 注入 (d) → compressing → idle 时压缩；同时告警 Lead |
| compactNow 撞上 busy（Lead 恰好在同一瞬间派活） | 保留 compressing 状态，下个 idle 重试；Team 的实际节奏是「队友干完 → Lead 消化很久 → 再派活」，真空期很宽裕，通常第一次就能压上。超 maxBusyRetries 降级为等内置 0.8 阈值并给 Lead 一条 notice |
| compactNow 返回 null | 回 clean，epoch 不变，记录原因 |
| summary/changed/commit/persistence 失败 | 指数退避 ≤3 次；仍失败则冻结本成员并向 Lead 报失败码 |
| 压缩与 send_message 竞争 | DSH 已用 maintenance.wakeRequested 闩住，压缩结束后自动投递 |
| 多成员同时到边界 | 进程内信号量 maxConcurrentCompactions（默认 1），排队不丢 |
| fork teammate 开局就超过 100k | 首个 pre-step 立即 armed（继承 Lead 前缀，属预期） |
| compressing 中被 dispose | 作用域卸载；durable 事件留档，重开时投影回到 compressing 再试一次 |
| 切点破坏工具配对 | 只用 compactNow（内部已保证配对平衡）；不手写 compactRegion |

### 4.12 多成员协同

每个成员的阈值、里程碑、epoch 完全独立；Lead 的上下文里不镜像 teammates 的里程碑（省 token），需要时用阶段 2 的 team_milestone_status 或 A 方案的 roster 扩展。压缩期间成员对外仍报 idle，但“不可干活”；可选在 A 方案里通过 list_agents 的 diagnostics 附加 compacting 标记。

### 4.13 开关语义：怎样“关掉里程碑压缩、回归原本功能”

| 配置 | 效果 | 什么时候用 |
|---|---|---|
| enabled: false | **彻底关闭**。apply() 立刻返回，不给任何成员装 context、不注册工具、不挂 agent/status 钩子。Team 的行为与没装插件**完全一致**，只剩 DSH 自带的 compaction-basic（0.8×window 回合中途自动压缩）在跑 | 想完全回归原状、或者这个功能上线后觉得不合适 |
| dryRun: true | **只提示、不压缩**。仍然在 100k 注入提示、仍然记状态与日志，但绝不调 compactNow | 首次上线试水，观察提示会不会打扰模型、会不会破坏 KV cache |
| enabledRoles: ['teammate'] | 只在队友身上生效，Lead 不触发 | 只想压缩队友、保留 Lead 的完整记忆 |
| armTokens: 一个极大值（如 999999999） | 等价于永不 armed，但插件还在跑（有开销） | 不推荐，直接用 enabled: false |
| continueAfterCompact: false | 压缩照常发生，只是压完不自动叫醒队友 | **本 Team 的默认**：等 Lead 消化完再派活 |

**“原本功能”具体是什么**（关掉后回到的状态，两条都在，跟本插件无关）：

1. DSH 内置自动压缩：某个成员上下文到 0.8 × contextWindow（本机 80 万）时，在回合中途自动压一次；
2. /compact 人工命令：想手动压就敲一次。

也就是说：**关掉不会让压缩能力消失，只是回到“到量才压 + 人工可压”，没有“模型设里程碑、完成后压”这一层。**

---

## 5. 落地实施（文件级）

### 5.1 B 方案：插件包结构

```text
dsh-team-context-milestone/
├─ package.json                 # exports 指向 lib/；peerDeps: @deepseek-ai/{cordis,dsh-agent,dsh-session,dsh-system-prompt,dsh-tools}
├─ README.md / README.zh.md     # 配置表 + Model Experience（Token effect / KV Cache effect）两条必写
├─ src/
│  ├─ index.ts                  # name / inject / Config / apply（4.3 的入口，约 120 行）
│  ├─ scope.ts                  # install(agent)：context 注入 + 工具 + 钩子 + 卸载（约 150 行）
│  ├─ state.ts                  # 状态机 + RuntimeState WeakMap（约 220 行）
│  ├─ persist.ts                # session.append 事件 + sessionProjections.register 投影（约 120 行）
│  ├─ prompts.ts                # 四段模板渲染（占位符替换）+ renderMilestoneContext / renderOneShot；模板来自 Config（约 120 行）
│  ├─ tools.ts                  # 两个 defineTool + 校验/拒绝 + 紧凑 JSON 输出（约 180 行）
│  ├─ compaction-driver.ts      # idle 调度、信号量、失败退避、finishEpoch、followup 续跑（约 170 行）
│  ├─ economics.ts              # 阶段 2：horizon / breakeven / 窗口保护（约 150 行）
│  ├─ config.ts                 # Config schema + 阈值钳制 min(armTokens, maxArmRatio×contextWindow)（约 60 行）
│  └─ notice.ts                 # 给成员/Lead 的 plugin-source notice（约 60 行）
├─ test/                        # 见 §6
└─ lib/                         # 构建产物（tsc/esbuild）
```

挂载（本机 desktop profile，3 处改动）：

1. ~/.dsh/profiles/desktop/package.json 的 dependencies 加 "dsh-team-context-milestone": "file:..."。
2. 同目录 cordis.patch.yml 追加：

```yaml
- insert:
    - id: team-context-milestone
      name: 'dsh-team-context-milestone'
      config:
        enabled: true         # 设 false = 彻底关闭里程碑压缩，回归原本功能
        armTokens: 100000
        hardTokens: 600000
        keepRecentTokens: 20000
        continueAfterCompact: false   # 压完不自动叫醒，等 Lead 派活
        gate: threshold
        maxConcurrentCompactions: 1
        dryRun: true          # 首次上线先只注入提示、不真压
```

3. profile 目录 pnpm install → 重启 DSH（插件 HMR 只覆盖已加载插件，新包首次需重启）。

注意：本机安装副本里 **没有 .d.ts**（package.json 列了但未随包发布），新包只能靠 JSDoc 与运行时对象，不能类型导入 CompactionTrigger/CompactionResult/BasicCompactionConfig。

### 5.2 A 方案：上游化增量

| 文件 | 改动 |
|---|---|
| packages/experimental/team-context-milestone/** | 新增（等于 5.1 去 profile 专属配置） |
| packages/experimental/agent-team/src/{index,journal,projection,types}.ts | 新增 team/milestone-* 事件、TeamMilestoneView、TeamService.setMilestone/completeMilestone/listMilestones（沿用 CAS + Lead 权威） |
| packages/experimental/agent-team-profile/cordis.patch.yml | insert 本插件行（与 agent-team / tool-agent-team 并列） |
| 上述包的 README.md / docs/subsystems/agent-team.md / docs/config-catalog.md | 同步文档（DSH 的 README 是包契约的一部分） |
| .agents/notes/implemented/feature/日期-team-context-milestone.md | 按 DSH 惯例补 Agent Note（模型可见行为、作用域、token/KV 影响） |

### 5.3 配置项全表

| 键 | 默认 | 含义 |
|---|---|---|
| **enabled** | **true** | **总开关。false = 插件完全不装作用域，Team 立刻回到现状（只剩 DSH 自带的 0.8×window 自动压缩）。要"关掉里程碑压缩、回归原本功能"就把它设成 false** |
| armTokens | 100000 | 达到后进入 armed 并注入提示（R2） |
| maxArmRatio | 0.5 | 阈值钳制 min(armTokens, maxArmRatio × contextWindow)，保护小窗口模型 |
| hardTokens | 600000 | 模型不响应的强制边界（仍需 idle 才能压） |
| keepRecentTokens | 20000 | 借 SoL-Pi：压缩保留的最近 token（用于经济性估算） |
| reminderCooldownSteps | 8 | armed 重述间隔（步） |
| maxArmSteps | 40 | armed 最长等待步数 |
| maxMilestoneSteps | 16 | 单里程碑步骤上限 |
| maxConcurrentCompactions | 1 | 进程内并发压缩信号量 |
| maxBusyRetries | 5 | busy 重试上限，超过降级 |
| minEpochIntervalTokens | 300000 | 两次压缩之间的最小 token 间隔（防抖） |
| **continueAfterCompact** | **false** | **压缩完成后是否自动叫醒队友继续干活。名字直译就是「压缩完还继续跑吗」：true = 插件主动唤醒队友让它自己接着干；false = 压完只留一句「记得重新规划」的提醒，安静等 Lead 派下一单。按本 Team 的节奏（队友干完 → Lead 消化很久 → 再派活）应当用 false** |
| gate | threshold | threshold 或 economic（4.8） |
| cacheWriteReadRatio | 12.5 | 仅 economic 用 |
| quantizeTokens | true | 占用数字量化，减少尾部缓存失效 |
| enabledRoles | ['lead','teammate'] | 生效角色（灰度） |
| dryRun | false | 只注入提示与日志、不真压（首次上线建议 true） |
| promptArmed / promptActive / promptPostCompact / promptHardLimit | 见 4.5 | **四段提示词模板，可整段替换。默认值只是未验证的初稿，调措辞不必改代码** |
| promptMinimal | false | true 时只用最小提示（4.5.1 步骤 1 的那一句），用于从零测调用率 |

---

## 6. 测试与验收

### 6.1 自动化用例

单元：1) config 钳制（armTokens=100k 且 contextWindow=32k 得到 16k）与非法值 fail-loud；2) 状态机（armed 只触发一次、cooldown 计数、hardTokens 直达、active 步骤 CAS）；3) persist 回放等价（history 截断到 3）；4) driver 的 busy 重试 / null 归零 / 失败退避 / 信号量互斥（假 ctx.compaction）；5) prompts 四段渲染边界（缺 token 数字、步数上限、空 exit_criteria）；6) economics（saving 小于等于 0 不压、窗口保护强压、首次放宽）。

集成（dsh-agent-loop-testkit）：7) 100k 前**没有** team:milestone 文本，越界后恰好出现并在 set 后换成状态卡；8) 非 Team subagent 完全不受影响（tryMembership 为 undefined）；9) interrupt_agent 期间不压、状态不变；10) 压缩中 send_message 不丢（同 DSH 的 wakeRequested 路径）；11) dispose 后无残留监听。

### 6.2 手工验收（本机 Web GUI）

1. **dryRun:true 下先验提示词**（不要跳过）：把某成员做到超过 100k → 日志出现 arm；然后看模型**实际有没有调 team_milestone_set**、字段填得全不全。不达标就照 4.5.1 改 promptArmed 再跑，直到调用率与字段完整率达标，才进入第 2 步。
2. dryRun:true 下确认注入位置正确：下一次请求尾部出现提示，但 system prompt 前缀逐字节未变（可对比请求头），不压缩。
3. 关 dryRun，调 team_milestone_set → 文本换成状态卡；会话 JSONL 出现 team-milestone/state 事件。
4. 走完步骤并 team_milestone_complete → 回合结束后出现 compaction/start 到 summary 到 end，日志显示 shadowed 区间与 token。
5. **B 方案验证**：压缩后的下一个请求里，里程碑的 goal/exit_criteria/steps 主线**仍然在**（不依赖摘要有没有提到），模型据此继续，无重复旧工具结果。
6. **开关验证**：把 enabled 改 false 重启 → 100k 不再注入任何文本、不再压缩，Team 行为与没装插件一致；改回 true 后功能恢复。
7. **续跑验证**：continueAfterCompact=false 时压完**不自动跑**，等 Lead 派活才动；设 true 时压完自动开新回合。
8. 对比压缩前后 usage.cacheReadTokens/totalTokens：前缀仍在命中，总 token 显著下降。
9. compressing 阶段 kill 再启动 → 成员恢复并完成压缩。
10. Lead + 2 teammate 同时到边界 → 串行执行，无交错 checkpoint，无消息丢失。
11. 完全不声明里程碑撑到 600k → 注入 (d) → idle 时压缩 → Lead 收到告警。
12. **busy 容错**：在压缩被触发的同一瞬间让 Lead 派活 → 不应报错，应下个 idle 重试成功。

### 6.3 可观测性

日志：arm / milestone-set / milestone-complete / compact-attempt / compact-result（区间与 token）/ compact-failed(code) / epoch。结构化通知：给 Lead 一条 plugin-source notice 汇总“谁在哪个 epoch 压了多少”。UI（阶段 3，A 方案）：复用 dsh-experimental-client-ui-agent-team 的 roster 面板加一列 milestone/epoch/compacted tokens。

---

## 7. 分期计划

| 阶段 | 范围 | 出口 |
|---|---|---|
| P0（1–2 天） | index/config/scope/state/prompts/persist/tools + dryRun；gate=threshold | 验收 1、2、6；零压缩副作用 |
| P1（1 天） | compaction-driver 接通 compactNow + 失败码全覆盖 + compaction/* 事件确认 + 通知 | 验收 3、4、7、8；continueAfterCompact 可关 |
| P2（1–2 天） | economics.ts（SoL-Pi 式门控）+ memoTokens 实测回写 + quantizeTokens | 验收 5；gate=economic 灰度 |
| P3（可选） | 回合内 compactRegion 强压（自选平衡切点）/ A 方案上游化 / roster+UI 展示 | 上游 PR |

---

## 8. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 压缩只在 idle 生效，成员可能长期 running | 里程碑压缩被推迟 | hardTokens + 内置 0.8 自动压缩兜底；日志显示推迟原因 |
| 提示每步变化导致尾部缓存失效 | 每步多付少量 input token | quantizeTokens；armed 才带数字；用 usage.cacheReadTokens 实测验证 |
| 模型频繁 complete 逃避工作 | 压缩过频、上下文反复重建 | 回合干净校验 + minEpochIntervalTokens + 经济性门控 |
| 压缩丢掉跨成员协作细节 | teammate 重启后重复劳动 | history 与 exit_criteria 保留；提示里强制要求把耐久事实写进里程碑或文件 |
| memoTokens 估算偏差 | 门控判错 | 首次压缩实测回写；saving 小于等于 0 一律不压 |
| experimental 包无稳定性承诺 | 升级后 API 变动 | 只依赖 6 个稳定缝；inject 显式失败而非静默降级；锁 ^0.1.5-rc.2 |
| schema 成本叠加（Team 已有 9 个工具） | 每请求 token 上升 | 只加 2 个工具、仅 Team 成员可见、字段精简 |
| 本机未随包发布 .d.ts | 无法类型导入 | 用 JSDoc + 运行时断言，或在源码库内开发时走 src/* 导出 |

---

## 附录 A：机制证据索引

| 断言 | 证据 |
|---|---|
| Team 工具按成员作用域安装、agent/created 驱动、tryMembership 过滤 | dsh-experimental-tool-agent-team/lib/index.js:231-245, 526-547 |
| team:policy 段 + 9 个工具 schema | 同上 :9-27 |
| TeamMembership / membership / tryMembership | dsh-experimental-agent-team/lib/types/roster.d.ts:11-16, 47, 53 |
| Team profile patch 内容 | dsh-experimental-agent-team-profile/cordis.patch.yml |
| pre-step 瀑布契约与默认 messages 追加 | dsh-agent-loop/lib/index.js:885-908（waterfall :894-901） |
| agent.status：maintenance 也报 idle | 同上 :773-776 |
| runMaintenance 非 idle 抛错；结束后唤醒闩住消息 | 同上 :805-828, :837-843 |
| followup/steer/inject | 同上 :783-797 |
| TokenMeter.measure 返回结构；totalTokens 口径 | dsh-token-meter/lib/index.js:608-686, 643-686, 682 |
| usage 口径 input+cacheRead+cacheWrite+output | 同上 :595-597 |
| contextPressure 投影 | dsh-token-meter/lib/types/usage-projection.js:48-58, 141-187；读法 dsh-session-projection/lib/index.js:127-132 |
| ctx.compaction 抽象服务 | dsh-compaction/lib/types/index.js:44-47 |
| compactIfNeeded / compactNow / compactRegion | dsh-compaction-basic/lib/index.js:873-920, 944-970, 930-935 |
| compactNow 要求 idle、busy 映射 | 同上 :944-970（:967-969） |
| CompactionResult 字段；摘要必须更小 | 同上 :633-653, :571-572 |
| 默认配置（0.8 / 0.16 / 8192 / retries 1 / auto true） | 同上 :15-17, :30-34, :58-78 |
| 只有比例、无绝对阈值 | 同上 :108-125, :111 |
| 自动压缩钩子（pre-step / status / session 事件 / request-error） | 同上 :793-847 |
| 切点配对平衡校验 | dsh-compaction/lib/types/tool-pairing.js:9-18, 82-95；dsh-compaction-basic:533-549 |
| 替换节点与 checkpoint provenance | dsh-compaction-basic:567-570, 621-632；dsh-compaction/lib/types/checkpoint.js:14, 21-35 |
| compacted-summary 框架与 8 段模板 | dsh-compaction-basic:211-212, 220-257, 323-335 |
| 压缩会话事件 | 同上 :452, 467, 478-481, 605-620；pruner :162-169 |
| 压缩前历史保留、回放一致 | dsh-compaction/README.zh.md:12, :95 |
| surfaceOp replace + replaceGeneration | dsh-session/lib/types/surface.js:164-173, 370-377, 437-446 |
| session.append(type,data,opts) | dsh-session/lib/types/index.js:555-599 |
| systemPrompt.section/context/variable/orders | dsh-system-prompt/lib/index.js:10-47, 238-266, 336-343 |
| 作用域=agent | dsh-agent/lib/index.js:258-264；dsh-agent-loop:890 |
| systemPromptUpdate=in-history | dsh-llm/lib/index.js:2057-2058；dsh-llm-deepseek:1849, 1882；dsh-agent-loop:274-283 |
| system-reminder 标签与转义 | dsh-agent-instructions/lib/index.js:111-112, 127-129, 784-795 |
| 一次性 plugin 消息写法 | dsh-repeat-tool-reminder/lib/index.js:1377-1380, 1483-1512 |
| 自定义 durable 事件先例 | dsh-sandbox-policy:42；dsh-user-approval:65；dsh-subagent:582-586 |
| sessionProjections.register | dsh-session-projection/lib/index.js:68-101, 228-307 |
| 挂载点行 id | dsh-base/cordis.patch.yml:317-326, 394-399 |
| 本机 profile patch 现状 | ~/.dsh/profiles/desktop/cordis.patch.yml |
| 本机模型 contextWindow = 1,000,000 | ~/.dsh/settings.yaml:1507-1512 |

外部：NVlabs/SoL-Pi https://github.com/NVlabs/SoL-Pi · 论文 https://arxiv.org/abs/2609.20519 · 对照 Claude Code /compact 与 auto-compact、Codex model_auto_compact_token_limit、Letta messages.compact、langmem max_tokens_before_summary。

## 附录 B：术语

| 词 | 含义 |
|---|---|
| 大阶段里程碑（milestone） | 模型自己声明的一段可独立验收的工作阶段，是**上下文压缩的边界** |
| 主动压缩 | 不等窗口告急，由“阶段边界 + 经济性”驱动的压缩（SoL-Pi: Online Context Compact） |
| epoch | 成员经历过的压缩次数；epoch 变化 = 历史被替换过一次 |
| clean / armed / active / compressing | 成员里程碑四态 |
| 边界校验 | 声明完成时对“回合是否干净”的检查 |
| memo | 压缩产出的 checkpoint 文本（compacted-summary 内容） |

## 附录 C：提示词中文对照（review 用；实现注入英文版）

- (a) 你的上下文约 {{totalTokens}} tokens（软预算 {{armTokens}}，窗口 {{contextWindow}}）。请立刻用 team_milestone_set 声明**一个**大阶段里程碑：目标一句话、可被复现的验收条件、1..N 步有序计划（最多一步 in_progress）、以及证明证据。整个里程碑验证完成后调用 team_milestone_complete；harness 会在下一个空闲边界压缩你的历史，你将从 checkpoint 继续——所以请把耐久事实（路径、决策、命令）写进里程碑，而不是留在对话里。
- (b) 当前里程碑（epoch {{epoch}}，第 {{k}}/{{n}} 步）：{{goal}}；验收条件：{{exit_criteria}}；当前占用约 {{totalTokens}} tokens。最后一步验证通过时调用 team_milestone_complete。
- (c) 里程碑 {{goal}} 已压缩为上方 checkpoint（释放约 {{freedTokens}} tokens）。父任务仍然有效。继续工作前，请重读 checkpoint 并用 team_milestone_set 为剩余工作重新声明里程碑。
- (d) 上下文触及硬上限（约 {{totalTokens}} tokens），{{armSteps}} 次提醒后仍未收到里程碑。harness 将在下一个空闲边界压缩你的历史。请立即把不可丢失的耐久事实写入 team_milestone_set（或写入文件），然后继续。
