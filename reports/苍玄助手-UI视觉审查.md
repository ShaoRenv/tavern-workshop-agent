# 苍玄助手 · UI 视觉与排版审查

> 只出方案，不改代码。所有结论都能落到具体 CSS 类名 / 模板片段 / 实测数字上。
> 审查人：ui-visual（task-24）｜写范围：本文件

## 0. 审查范围与方法

**读过的代码**

| 文件 | 行数 |
|---|---|
| `src/苍玄助手/global.css` | 1770（全量，含 1630 之后那整段"手机端"媒体查询） |
| `views/`：ChatView / SettingsView / CapabilityView / PortraitsView / WorldbookView / SkillsView / RecordsView | 275 / 557 / 215 / 202 / 185 / 203 / 141 |
| `components/`：AppShell / MsgRow / ToolCard / ToolGroup / Sw / SegBar / Sheet / SkillCard / ToolDetail / ToolPromptSheet / tool_kind.ts / ui_types.ts | 全部 |
| `App.vue` | 458 |

**真实渲染验证：做了**（不是纯静态推论）

- 环境：酒馆 `http://localhost:8000`，面板窗口 iframe `#cx-pw-frame`，实测 **1006 × 549 px**（`clientWidth/clientHeight`），`matchMedia('(max-width: 1280px)').matches === true`。
- 工具：chrome-devtools MCP 在页面里读 `getComputedStyle` / `getBoundingClientRect`，并临时插入探针元素量真实盒模型（探针用完即删）。
- 375px：把 iframe 宽度临时改成 375px 实测（**已还原**：现在仍是 1006×549）。
- 数据：全程没有改任何数据（只切页签 + 点进一个工具详情，已还原到「设置」页签、深色主题）。
- 对比度：WCAG 2.1 相对亮度公式，输入是**实测**色值（例如浅色下 `.cx-hint` 实测 `rgb(152,161,173)`），阈值按 AA 正文 4.5:1、大字 3:1。

**结论一句话**：结构（只有分隔线、无卡片框）和 375px 无横向滚动这两条是成立的，建议保持；**问题集中在「颜色语义在浅色下整体失效」和「间距/字号没有体系」两件事上**。

---

## 最值得做的 3 条

1. **浅色主题缺少 warn / danger / 角色色定义，且 6 组颜色写死在 CSS 里** → 浅色下大量语义色掉到 1.5–2.7:1，字看不见。改 1 个文件约 20 行。
2. **`--qx-faint` 对比度只有 3.14:1（深色）/ 2.61:1（浅色），却承载了 47 处 `.cx-hint` 和 24 处小字** → 这一档灰阶是"看不清"的主要来源。
3. **状态行与输入框没有固定，长对话里滚上去就一起消失** → 直接违反已冻结的「必须有固定可见的运行状态」。`position: sticky` 两行即可。

---

## 1. 浅色主题：语义色缺失 + 硬编码色，浅色下大面积不可读

**现状**

`global.css:30-42` 的浅色块只重定义了 10 个变量：`--qx-veil / panel / ink / muted / faint / hair / field / accent-dim / accent / accent-ink`。**没有 `--qx-warn`、没有 `--qx-danger`。**

另有 6 组颜色直接写死，绕开主题变量：

| 位置 | 值 | 用途 |
|---|---|---|
| `global.css:719`、`1560` | `#c084fc` | 技能工具行 / 时间线 `k-tool` 圆点 |
| `global.css:1038-1048` | `#fbbf24` `#38bdf8` `#2dd4bf` | `.cx-rl.system / .user / .assistant`（预设消息行角色标签） |
| `global.css:1551` | `#38bdf8` | 时间线 `k-user` 圆点 |
| `global.css:1149` | `#b9c6d3` | `.cx-code`（立绘页产物 JSON，`PortraitsView.vue:70`） |
| `global.css:820` | `#1b2b2c → #243036 → #1d2530` | 生图卡占位渐变（浅色下仍是深色块） |
| `App.vue:107` | `background:rgba(45,212,191,.16); color:#2dd4bf` | `toastStyle` 内联样式 |

**实测（浅色开启时）**：`.cx-root` 背景 = `rgb(255,255,255)`；`--qx-warn` 仍 = `#fbbf24`；`--qx-danger` 仍 = `#fb7185`；`.cx-hint` = `rgb(152,161,173)`；`.cx-ghost`（"全选 / 清空"）= `rgb(13,148,136)`。

**问题（对比度，白底 / 面板底）**

| 前景 | 深色主题 | 浅色主题 |
|---|---|---|
| `--qx-warn` `#fbbf24` | 10.97:1 ✅ | **1.67:1** ❌ |
| `--qx-danger` `#fb7185` | 6.80:1 ✅ | **2.69:1** ❌ |
| `--qx-accent` 作为文字 | 9.84:1 ✅ | **3.74:1** ❌ |
| `--qx-faint` | **3.14:1** ❌ | **2.61:1** ❌ |
| `#2dd4bf`（`.cx-rl.assistant`） | 9.84:1 ✅ | **1.86:1** ❌ |
| `#38bdf8`（`.cx-rl.user`） | 8.55:1 ✅ | **2.14:1** ❌ |
| `#c084fc`（技能 / 时间线） | 6.93:1 ✅ | **2.64:1** ❌ |
| `#b9c6d3`（`.cx-code`）on `--qx-veil` | 11.20:1 ✅ | **1.47:1** ❌ |

影响到的可见元素：`.cx-tag.warn`（"仅明确要求时用"、"无元数据"、"必填"，`CapabilityView.vue:34` / `PortraitsView.vue:41` / `ToolDetail.vue:66`）、`.cx-ghost.dang`（删除）、`.cx-danger-text`、`.cx-tli.bad`、`.cx-rl.*`、`.cx-code`、toast。**也就是说：浅色模式下"危险/警告"这两个最重要的语义几乎不可见。**

**建议**（只改 `global.css`，外加 `App.vue:107` 一处）

1. 在 `global.css:30-42` 补三条：`--qx-warn`（浅色建议 `#a16207` 一类深琥珀）、`--qx-danger`（`#be123c` 一类）、`--qx-accent-ink` 已有则不动。取值以实测 ≥4.5:1 为准。
2. 把上表 6 组硬编码色提成 `:root` 变量：`--qx-role-system / -user / -ai / -tool`、`--qx-code-ink`，浅色块里给一份深色版；`.cx-gen` 的渐变也换成变量（或浅色下改成浅灰底）。
3. `App.vue:107` 的 `toastStyle` 挪进 `global.css` 成 `.cx-toast`（顺便用变量，顺便统一边距，见第 6 条）。

**代价**：1 个文件约 20 行 + `App.vue` 删 1 行改 1 个 class；不动 DOM、不动交互。**收益最高、代价最低。**

---

## 2. `--qx-faint` 只有 3:1，却承担了全站最重的辅助文字

**现状**

`global.css:17` 深色 `#5c6673`、`global.css:36` 浅色 `#98a1ad`；这个色值在 CSS 里被引用 **24 次**。

**实测**：`.cx-hint` = `font-size: 11px` + `color: rgb(92,102,115)`；`.cx-statusbar`（"● 就绪"）同色 11px。

**问题**

- 深色面板上 **3.14:1**、落在 `--qx-field`（`#171c24`）上只有 **2.93:1**、浅色 **2.61:1** —— 三档全部低于 AA 4.5:1。
- 它不是"偶尔用用"：`.cx-hint` 在模板里出现 **47 次**（全站出现次数最多的一类文字），再加上 `.cx-m .cx-who`（10px，`global.css:654`）、`.cx-tli-time`（10px，`1605`）、`.cx-rec-meta`（10.5px，`1281`）、`.cx-gmeta`（10.5px，`850`）、`.cx-tc-hint`（10px，`803`）、`.cx-sfile .cx-fs`（10.5px，`1193`）、`.cx-toolrow-desc`（11px，`1338`）。
- **10–11px + 3:1** 正好是手机上最读不动的一档；而这一档里装的恰恰是操作说明（"点一行改它的提示词"、"恢复默认会清掉…"）。

**建议**（二选一，推荐 ①）

1. 把所有 **11px 及以下**的辅助文字从 `--qx-faint` 换成 `--qx-muted`（深色 5.11:1、浅色 4.74:1）；`--qx-faint` 只留给非文字的圆点/箭头（`.cx-cv`、`.cx-sdot`、`.cx-tdot`、`.cx-sw::after`）。机械替换，保留三档层次里的"点/线"那一档。
2. 抬 `--qx-faint` 本身：深色改 `#8a94a2`（≈5.96:1）；但这会让它贴近 `--qx-muted`（5.11:1），浅色更是要提到 `#6d7480`（≈4.71:1）才够 —— 也就是说**这一档灰阶在浅色里本来就撑不起第 3 级**，所以方案 ① 更诚实。

**代价**：方案 ① 约 20 行机械替换，风险低（不改变布局，只改颜色）。方案 ② 只改 2 行但会压平层次。

---

## 3. 状态行与输入框没有固定，长对话里会一起消失（违反已冻结的约束）

**现状**

`global.css:1198-1206`（`.cx-statusbar`）与 `global.css:854-860`（`.cx-composer`）都是普通文档流元素，没有 `position`；`.cx-body`（`global.css:207-211`）靠 `flex: 1` 吸收剩余高度。它们在 DOM 里是 `.cx-root` 的最后两个子元素（实测 `rootChildren: ["cx-bar","cx-seg","cx-body","cx-statusbar","cx-composer"]`）。

**实测**（往 `.cx-body` 临时塞 1200px 内容，不改任何数据；探针已删）

| 量 | 值 |
|---|---|
| `.cx-statusbar` top | 1448（视口高 549） |
| `.cx-composer` top / bottom | 1476 / 1544 |
| `composerVisible` / `statusbarVisible` | `false` / `false` |
| 需要滚动多少才回到视口 | **995px** |
| 两者 `position` | `static` / `static` |

**问题**

已冻结的口径里写着「必须有固定可见的运行状态（● 运行中 · 第 N 轮）」。现在只有 `ChatView.vue:218-223` 的 `scrollIntoView({block:'end'})` 在每次新轮次把人拽到底部 —— 用户**一旦往上翻历史**，状态行和输入框同时离开视口，看不到"还在跑 / 第几轮"，也没法直接接着说话。

**建议**

给 `.cx-statusbar` 和 `.cx-composer` 加 `position: sticky; bottom: 0; z-index: 10`；`.cx-composer` 已经有 `background: var(--qx-panel)`（`global.css:859`），`.cx-statusbar` 要补同款底色，否则内容会从它底下透出来。`sticky` 不产生滚动容器，仍然满足「不做内嵌小滚动区」。

**代价**：2 行 + 1 行底色；需要回归一次长对话页（滚动时不闪、遮罩层 `.cx-backdrop` 的 `z-index: 99` 仍然压在它上面，见 `global.css:1091-1097`）。风险低。

---

## 4. `.cx-frow > .cx-lab` 这条"手机端"规则误伤工具详情页的标签条

**现状**

`global.css:1714-1722`（≤1280px）：

```css
.cx-frow { flex-wrap: wrap; align-items: flex-start; }
.cx-frow > .cx-lab { flex: 1 1 100%; }   /* "标签压到控件上方" */
```

而 `ToolDetail.vue:14-22` 用 `.cx-frow` 装了一条**行内标签**：「来源 [内置] 状态 [正常] 默认开」。

**实测**（1006px 宽，还没有窄到 375px）：这条本来一行的横排被撑成 **106px 高 / 4 行** ——

| 子元素 | top | width |
|---|---|---|
| `.cx-lab` "来源" | 272 | **955px**（撑满整行） |
| `.cx-tag` "内置" | 299 | 34 |
| `.cx-lab` "状态" | 328 | **955px** |
| `.cx-tag` "正常" / "默认开" | 356 | 34 / 44 |

**问题**

「来源 / 状态」是标签条上的行内标签，不是表单字段标签；这条规则把它们当表单 label 处理了。13 个工具、每个详情页头部的第一屏都被它吃掉 106px。

**建议**

把选择器收紧到表单区：`global.css:1720` 改成 `.cx-f > .cx-frow > .cx-lab { flex: 1 1 100% }`（所有真正的表单行都在 `.cx-f` 里），或给标签条换一个 `.cx-metarow` 类。

**代价**：1 行选择器；需要看 5 处 `.cx-frow`（`ToolDetail.vue:14/100/107`、`SettingsView.vue:31/40/47`、`PortraitsView.vue:16`）。

---

## 5. 失败的"改动类"工具调用，左边色条是青玉而不是红

**现状** `global.css:689-696`：

```css
.cx-cline.err   { box-shadow: inset 2px 0 0 var(--qx-danger); }  /* 690 */
.cx-cline.patch { box-shadow: inset 2px 0 0 var(--qx-accent); }  /* 694 */
```

同特异性、后者在后 → **patch 覆盖 err**。

**实测**（探针 `<div class="cx-cline err patch">`）：

- 只有 `.err` → `rgb(251,113,133) 2px 0 0 0 inset`（红，正确）
- `.err` + `.patch` → `rgb(45,212,191) 2px 0 0 0 inset`（**青玉**）

**问题**

`tool_kind.ts:10` 的 `PATCH_TOOLS`（`entry_edit / entry_create / entry_delete / entry_meta / wb_write / entry_write`）恰好是**最容易失败**的一类工具（`NOT_OBSERVED` / `STALE` / 越权）。它们失败时左边色条是"成功色"，而冻结约束里写的是「失败/改动自动展开」——意图就是"失败要一眼看见"。

**建议**：把 `.cx-cline.err` 挪到 `.patch` 之后，或加一条 `.cx-cline.err, .cx-cline.err.patch { box-shadow: inset 2px 0 0 var(--qx-danger) }`。

**代价**：1 行，零风险。

---

## 6. 水平边距有三套：12 / 16 / 18

**现状**

| 选择器 | 水平内边距 | 行 |
|---|---|---|
| `.cx-bar` | 18 | `global.css:75` |
| `.cx-seg`（页签药丸） | **12** | `global.css:152` |
| `.cx-blk`（所有内容块） | 18 | `global.css:216` |
| `.cx-foot` | 18 | `global.css:225` |
| `.cx-statusbar` | **16** | `global.css:1202` |
| `.cx-composer` | **16** | `global.css:858` |
| toast | **12** | `App.vue:107` |

**实测**（1006px 宽）：`.cx-seg` 左边缘 **x=12**、`.cx-blk` 内容左边缘 **x=18**、`.cx-statusbar` / `.cx-composer` 内容 **x=16**。

**问题**：页签药丸比正文宽 6px、比底栏宽 4px；同一屏里上下叠着三种左边缘。第一张截图里能直接看到药丸的左边超出「世界书」标题。

**建议**：统一到 18px（与 `.cx-blk` 对齐）：`.cx-seg { margin: 0 18px 4px }`、`.cx-statusbar`/`.cx-composer` 的 `16px` → `18px`、toast `margin: 0 18px`。若嫌手机端 18px 太宽，整体降 16px 也行，**但必须同一档**。

**代价**：3 行 + `App.vue` toast 一条。

---

## 7. 1280px 断点让桌面面板也走"手机端"，28px 工具卡从未生效

**现状**

`global.css:672-683`：`.cx-cline { min-height: 28px; font-size: 11.5px; padding: 3px 8px; }`
`global.css:1630`：`@media (max-width: 1280px)` —— 注释写的是「手机端」
`global.css:1724-1729`：该断点下 `.cx-cline, .cx-tc { min-height: 34px; padding: 5px 10px; font-size: 12.5px; }`

**实测**：面板 iframe 固定 **1006 × 549**，`matchMedia('(max-width: 1280px)')` = `true` → 桌面面板整份"手机端"样式生效：

- `.cx-cline` 实际高 **34px**（探针实测 `minHeight: "34px"`），不是 28px
- `.cx-ibtn` / `.cx-send` 42×42，输入框 46px，表单字号 14px，消息正文 14.5px

**问题**

已冻结的「工具调用卡一行 28px」在当前宽度下**从来没有生效过**；同时"手机端"这个词描述的其实是桌面。这是"两处说法不一致"，必须选一边：

- 如果在桌面（1006px 窗口）就是要 28px 密度 → 断点得收窄；
- 如果现在的大字号是故意的 → 那就把冻结约定改掉，别让它继续误导后面的人。

**建议**：断点从 1280px 收到 640px（真手机 375–430px），桌面恢复 28px；如果还想照顾高分屏触屏，另外用 `@media (pointer: coarse)` 单独放大点击区，而不是靠宽度猜。

**代价**：1 行断点，但要**回归 6 个页签 + 375px 无横向滚动**（我刚实测过 375px：`documentElement.scrollWidth === 360`，6 个页签 `53px×6` 正好放下，横向溢出元素 **0 个** —— 所以断点收窄不会破坏手机端）。中等风险。

---

## 8. 内容不足一屏时，面板底部露出一条更暗的 `--qx-veil`

**现状** `global.css:54-60` body 底色 = `--qx-veil`（`#0a0d11`）；`global.css:64-69` `.cx-root` 只有 `display:flex; flex-direction:column`，**没有 `min-height`**。

**实测**（对话页空态）：`.cx-root` 高 **344px**、视口 **549px** → `.cx-root` 下方 **205px** 是 body 的 `rgb(10,13,17)`（`--qx-veil`），而面板是 `rgb(17,21,27)`（`--qx-panel`）。第三张截图里输入框下面那条更暗的带子就是它。

**问题**：对话页空态（以及记录页空态）看起来像面板没有铺满、像被截断。`global.css:8` 的注释假设"界面是自适应高度的 iframe"，但当前这个窗口高度是**固定 549**，所以假设不成立。

**建议**（二选一）：① `global.css:55` 改成 `background: var(--qx-panel)`；或 ② `html, body { height: 100% }` + `.cx-root { min-height: 100% }`。注意别用 `vh`（会跟"自适应高度 iframe"那条约定打架）。

**代价**：1–2 行。

---

## 9. `.cx-tn2`（工具名）有三种长相

**现状** `.cx-tn2` **没有基础规则**，只有三条祖先限定的：`global.css:928`（`.cx-trow .cx-tn2`，等宽 12px）、`1394`（`.cx-tpname .cx-tn2`，只给 `font-size: 14px`）、`1416`（`.cx-tparam .cx-tn2`，等宽 12.5px）。

**实测**（把同一个 `<span class="cx-tn2">` 探针放进三种祖先）：

| 祖先 | 字体 | 字号 | 字重 |
|---|---|---|---|
| `.cx-toolrow-name`（能力·工具列表，`CapabilityView.vue:33`） | Microsoft YaHei | 13px | 400 |
| `.cx-tpname`（工具详情大标题，`ToolDetail.vue:11`） | Microsoft YaHei | **14px** | 400 |
| `.cx-trow`（预设的勾选弹窗，`SettingsView.vue:193`） | **ui-monospace** | 12px | 400 |

**问题**：同一个工具名，在列表、详情、弹窗里三种字体/字号，而且**都不加粗** —— 名字和下面那行 `--qx-faint` 描述只能靠颜色区分。列表行还因此看不出"这是个键名"。

**建议**：给 `.cx-tn2` 一条基础规则（`font-family: ui-monospace`、`font-size: 12.5px`、`font-weight: 700`、`color: var(--qx-ink)`），`.cx-tpname .cx-tn2` 只留 `font-size: 14px`，`.cx-trow .cx-tn2` 可删。

**代价**：3 行。

---

## 10. 字号 / 间距 / 圆角没有体系（这是"看着不够整"的根因，但要单开一轮）

**现状（census 结果，`global.css` 全文统计）**

| 属性 | 不同取值数 | 分布 |
|---|---|---|
| `font-size` | **15 种** | 11px×15、13px×11、12px×10、12.5px×9、10px×6、11.5px×5、14.5px×5、15px×4、10.5px×4、14px×4、9px×2、17px×2、9.5px×1、15.5px×1、`var(--qx-fs)`×1 |
| `padding` | **44 种** | 单值/双值/三值/四值混用 |
| `border-radius` | **13 种** | 5 / 6 / 7 / 8 / 9 / 10 / 12 / 16 / 999 / 50% / 2px / 4px / 12px 12px 3px 12px |
| `line-height` | **7 种** | 1 / 1.5 / 1.6 / 1.7 / 1.75 / 1.8 / 1.9 |

且 `--qx-fs: 13px`（`global.css:26`）只在 body 用了一次（`global.css:58`），其余全是就近写新数字。

**问题**：没有"一级 / 二级 / 三级"的层级。表现：

- `.cx-tag`（`global.css:539`）与 `.cx-tli-time`（`1605`）都是 10px，`.cx-rl`（`1031`）是 9.5px —— 三个层级挤在 0.5px 的差别里，人眼分辨不出意图；
- `11px` 一档用了 15 次，但 `.cx-cline` 是 11.5px、`.cx-menu-i` 是 12px，看不出为什么；
- 圆角 7px / 8px / 9px / 10px 四种并存在相邻控件上（`.cx-ghost` 7、`.cx-row` 8、`.cx-root input` 9、`.cx-draftbar` 10）。

**建议**：把 `:root` 扩成 token，先只替换覆盖率最高的四档字号 + 两档圆角：`--qx-fs-hint: 11px / --qx-fs-body: 12.5px / --qx-fs-title: 13px / --qx-fs-lg: 15px`、`--qx-r-sm: 8px / --qx-r: 10px`；间距同理只保留 4 的倍数。其余（9px / 9.5px / 17px 这些孤立值）单独一处处决。

**代价**：`global.css` 内约 60–80 行替换，必须逐页回归 6 个页签。**收益是根因级的，但不适合和 Lead 正在做的「预设合并 / 特殊层」并行改同一个文件** —— 建议等那一轮落地后单开一轮，且只动 `global.css`、不动模板。

---

## 建议保持不动（不粉饰）

- **"只有分隔线、没有卡片框"的结构**（`.cx-blk` 的 `border-top`，`global.css:213-221`）是真的成立了：实测 6 个页签里没有多余的外框，`.cx-capbody` / `.cx-setbody`（`global.css:1463-1466`）补分隔线的做法也正确。**别动。**
- **375px 手机端**：实测 `documentElement.scrollWidth === 360`、横向溢出元素 **0 个**、6 个页签各 53px 正好放下、`.cx-row` 行高 51px、`.cx-back` 40px、`.cx-tiny` 40px —— 「375 无横向滚动 / 点击区 ≥40px」这两条**已经达标，建议保持**。
- **工具调用分组的折叠逻辑**（`ToolGroup.vue:44-55`）：跑动中不折、跑完收成一行、失败不折、生图永远展开 —— 这是行为不是排版，视觉上是对的。只改第 5 条的色条顺序即可。
- **时间线的语义色**（`global.css:1550-1571`）：深色下 6.93–10.97:1，没问题；只有浅色要按第 1 条补。
- **`.cx-sheet` 的 16px 圆角 + 边框 + 阴影**（`global.css:1099-1111`）虽然和"不要卡片框"的语言不完全一致，但作为模态外壳是合理的，不必改。

## 未覆盖 / 不确定

- **375px 的真机（iOS Safari / Android Chrome）**没跑过。375px 的结论是在桌面 Chrome 里把 iframe 宽度改成 375px 实测的（已还原），字体回退（`body` 的 `'Microsoft YaHei', system-ui` 在手机上会落到系统字体）会改变 CJK 的实际宽度，6 个页签在真机上会不会挤需要再看一眼。
- **`.cx-gen` 生图卡**（`global.css:817-842`）没有真实数据可渲染，没验证过 `max-height: 340px` + `object-fit: cover` 对竖图/横图的裁切观感。
- **`.cx-menu`（⋯ 下拉）**实测项高约 33px（`menu-i` 12px + `padding: 7px 9px`，`global.css:125-138`），在手机端 40px 的约定下偏小 —— 但它是绝对定位的浮层，不影响布局，我没把它算进 10 条里。
- 浅色主题里的 `.cx-gen` 深色渐变、`.cx-diff`（`global.css:1164` 用 `--qx-muted` on `--qx-veil`，实测浅色 **3.99:1**）并入第 1/2 条一起修，没有单列。

## 附录：顺带发现（都不是视觉问题，交给「UI 交互与信息架构审查」那份）

- `WorldbookView.vue:20` 的文案「这是 Agent 能读改的范围；它自己也能列全部世界书」与已拍板口径（`task-19`：范围定死成勾选的那些，`wb_list` 只列范围内）冲突 —— 这句现在是错的。
- `SettingsView.vue:354`（`seg = ref('api')`）与 `CapabilityView.vue:118`（`seg = ref('tools')`）是局部 ref：**离开页签再回来会重置到第一段**。我实测到了：原本停在「设置 · 预设」，切走再切回来变成「接口」。
- `global.css:409` 的 `.cx-mt14` 没有任何模板在用；`ToolDetail.vue:2` 的 `.cx-toolpage` 在 CSS 里**没有定义**（只是个空包裹层）。
- `AppShell.vue:28` 的注释还写着「五个页签的药丸分段器」，实际 `TAB_IDS` 是 **6 个**（`core/types.ts`）。
