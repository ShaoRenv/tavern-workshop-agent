# 阶段 2-D · UI 收尾报告（task-33 / ui-wire）

> 三条：F-B（预设工具 Sheet 漏来源标签）、H3（goto 子段落点要稳）、H4（两处重复的行逻辑抽公共）。
> 完整验收背景：reports/苍玄助手-阶段2验收.md ③ / ④。

## ① 改了哪些文件

1. **src/苍玄助手/components/tool_rows.ts（新增）**
   - buildToolRows(catalog, presetTools)：正常行（owner_disabled 不为 true，按清单顺序去重）+ 兜底行（预设硬引用过、正常行里没有的，排在后面）——两处共用一份口径（H4）
2. src/苍玄助手/components/ui_types.ts
   - :108-127 新增 GotoSeg（page / seg / sub / at）：一次跳转要带子段，光有页面 id 落不准（H3）
3. src/苍玄助手/App.vue
   - :73 import GotoSeg
   - :45 / :60 SettingsView 绑定 :seg-intent="segIntent" + @goto-seg="requestGotoSeg"
   - :223-241 segIntent + segSeq + requestGotoSeg()；goto('capability') 走同一条（不再 store.setTab 一个不存在的页）
4. src/苍玄助手/views/SettingsView.vue
   - :320-327 模块级 appliedIntentAt（跨挂载记住「这条意图已落实」，防旧意图劫持）
   - :355-356 import GotoSeg + buildToolRows；:382/:390 props 加 segIntent；:401 emits 加 goto-seg
   - :512-528 segIntent watcher（immediate：从别处发起、切到设置页才挂载也当场落位）
   - :453-455 onGotoSeg() 往上转发；:166-167 能力段接 :seg-intent + @goto-seg
   - :219-225 「这个预设用哪些工具」Sheet 行：来源标签 + 「来源已停用」+ 说明句「· 来源停用了，不会发给模型」（F-B）
   - :593 toolRows 改用 buildToolRows（原来自己写了一份）
5. src/苍玄助手/views/CapabilityView.vue
   - :98/:123/:128 props 加 segIntent；:154 emits 加 goto-seg；:166-180 二级段 watcher
   - :187-194 toolRows 改用 buildToolRows（删掉自己那份）
   - :274-282 onGoto('capability')：本地先切工具段（快）+ emit goto-seg 把完整落点交给 App.vue（H3）

## ② 每条门禁的原始结论

| 门禁 | 命令 | 结论 |
|---|---|---|
| 单测 | node --test "tests/苍玄助手/*.test.ts" | **exit 0，tests 292 / pass 292 / fail 0**（与 Lead 给的基线一致） |
| Lint | npx eslint "src/苍玄助手" | **exit 0，0 问题** |
| 类型 | npx tsc --noEmit | exit 2，共 **5 行**、全是既有 node_modules 噪音；Select-String "src/" 命中 **0** |
| 正式构建 | pnpm build | **exit 0**；脚本正文 543 KB；应用 JS 248 KB，CSS 20 KB |
| 开发构建 | pnpm build:dev | **exit 0**，dist 已更新 |

### 真界面自检（127.0.0.1:8787/frame.html，chrome-devtools MCP，用完即关）

- **①** 关掉世界书 → 能力 · 工具段 **11 行**、其中 **6 处「来源已停用」**（预设引用的 6 个 wb_* 兜底行，行上有来源标签「世界书」+ 标题 + 说明）✓
- **②（F-B）** 设置 · 预设 → 开「单独启用预设能力」→「工具 9 / 11 ▾」→ Sheet 里 6 条 wb 工具行都带 **「世界书」+「来源已停用」**，说明行尾巴多了「· 来源停用了，不会发给模型」；base 工具行只有来源标签 ✓
- **③（H3）** 设置 · 能力 · 插件 → 世界书管理页 → 点「工具：wb_list / … ›」→ 落在 **设置 · 能力 · 工具**（外层四格 + 内层 工具|技能|插件 + 工具列表 12 行）✓
- **④** 重开世界书 → 能力 · 工具段回 **12 行**、「来源已停用」**0 处**；顶栏回 4 格 ✓
- **回归（新机制）**：跳转落位后再切到「数据」段 → 切「对话」→ 切回「设置」，**落回「接口」段**（旧意图没有把用户拽到「能力」）✓
- 自检完把世界书开关、预设的「单独启用预设能力」都恢复默认，页签点回「苍玄助手」，自检页已关 ✓

## ③ 没做完 / 不确定

1. **H4 的函数签名改成两个参数**（任务里写的是 catalog / presetTools / pluginAllToolsSet 三个）：owner_disabled 已经由 App.vue 按 pluginAllTools 算好打在 catalog 每一条上（阶段 2 就是这么定的），再传一个 Set 进来等于第二份「这工具归谁、来源开没开」的判断 —— 抽公共的目的正是消灭第二份口径，所以只留 catalog + presetTools。
2. **H3 的「在数据段时点也一样」在真界面上点不出来**：插件管理页只挂在「能力」段里，「数据」段没有任何入口能发出这条跳转。我实现的是**机制**上的稳：意图由 App.vue 存（requestGotoSeg：page + seg + sub + at），SettingsView / CapabilityView 各自消费；App.vue 的 goto('capability') 也走同一条（将来别处只认识老 id 也落得对）。能实测到的等效路径都测了：切走再回来不被旧意图劫持、immediate 落位、重复点也生效（at 递增）。要真验「从数据段点」，得先有一个外部入口（阶段 3 的 ⋯ 更多页面 / 错误边界里的「去设置」），那时不用改这套。
3. **F-B 的实现比验收建议多了半句**：Sheet 行的说明尾巴加了「· 来源停用了，不会发给模型」。理由是 F-A 已经闭环（runner 的 liveToolDefs 真的不给工具 def），这句话现在是真的 —— 如果 Lead 觉得啰嗦，删掉那半句即可（标签本身已经在）。
4. 没动 tests/、core/*、plugins/*、stores/*；没有 git commit。dist 是 build:dev 产物，src/酒馆助手脚本-苍玄助手.json 是同一次源码的正式构建产物。
5. 验收 ③ 里「真酒馆落盘 / 真数据」仍然没验（不属本轮，frame 没有宿主存储）。
