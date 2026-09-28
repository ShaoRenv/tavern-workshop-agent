---
name: worldbook-engineering
description: 改酒馆世界书（World Info / lorebook）。世界书是提示词注入器 —— 往预设预留的位置按条件注入文本。用于新建/修改/删除条目、查为什么没触发、整理结构。
---

# 世界书工程

> 领域知识来自 TavernWeave 手册原文（`A3_世界书优化` / `A4_提示词与预设`），不是 AI 写的。
> Copyright 2026 LiarMTTT · PolyForm Noncommercial License 1.0.0

---

## 一、世界书是什么

**提示词注入器。** 里面装的是各种要喂给模型的提示词，按条件注入到 prompt 的指定位置。

> World Info（Lorebook）是动态字典，仅当关键词出现在扫描缓冲区时才将对应条目内容插入 prompt。内容对 AI 可见，但不保证 AI 一定使用。
> —— A3 §1 ｜ high `[文档·多源]`

### 和预设的分工：预设固定结构，世界书灵活注入

预设固定了 prompt 的结构 —— 一张有固定顺序的插槽表：

```
main                 Main Prompt
worldInfoBefore      ★ 世界书插槽（角色定义前）
charDescription      Character Description
charPersonality      Character Personality
scenario             Character Scenario
worldInfoAfter       ★ 世界书插槽（角色定义后）
chatHistory          Chat History
jailbreak            Post-History Instructions
```

世界书做的事：往这两个专属插槽里填内容，或绕过插槽直接注入到聊天历史深处（`at_depth`）。

### 注入到哪个位置（position）

| position | 位置 | 通常装什么 |
|---|---|---|
| `0` | 角色定义前 | **世界设定、角色设定**等大量信息类条目 |
| `1` | 角色定义后（默认） | 补充设定 |
| `4` | **系统深度（at_depth）** | **输出规则、世界驱动人物交互的硬性规则** —— 优先级最高 |

其余位置（示例消息前后、作者注释、Outlet）少见。

### 通常只在当前角色卡生效

稳定卡用**角色绑定**的世界书（`character_book`），不靠玩家手动开全局书。

### 你干的活在哪一环

> 来源：`design-wiki / 角色卡技术路径总图.md`（三张已验证稳定卡共用这条主链）

```
世界书扫描注入 prompt          ← 你在这里
        ↓
模型输出正文 + <UpdateVariable>
        ↓
MVU bundle 打 JSONPatch
        ↓
消息渲染：宏 → 正则 → Markdown → .mes_text
        ↓
显示层挂载：OMNI / 气泡 / 选项 / 开局壳
        ↓
HUD 读 stat_data 刷新
        ↓
入口打开：魔棒 / 悬浮球 / 抽屉 / 浮窗
```

世界书是**最上游**的一环 —— 你注入什么，后面整条链都受影响。但你只负责**注入**，后面怎么渲染、怎么显示不是世界书的事。

---

## 二、我们的工具

| 工具 | 干什么 |
|---|---|
| `wb_list` | 列世界书（名字 + 生效范围 + 条目数） |
| `wb_outline` | 看一本书的结构（分节 + 每条状态）—— **改之前先看它** |
| `wb_read` | 读条目正文 + 判定所需字段，**可一次读多条** |
| `wb_search` | 按关键词找条目 |
| `wb_write` | 新建 / 修改 / 删除条目 |

**标准流程**：

```
wb_list → 问清哪本 → wb_outline 看结构 → wb_search / wb_read 定位
        → wb_write 改 → wb_read 回读确认
```

**两条纪律**：

- **改前必须读** —— 条目名和正文经常不一致（有人叫「江念」，里面写的是门派设定）
- **改后必须回读** —— 界面上显示「换回去 4 条」，磁盘上实际 0 条。**界面会替底层撒谎，回读不会**

### ⚠️ 字段名有两套，别搞混

| 概念 | 独立世界书文件 | 卡内 `character_book` |
|---|---|---|
| 主关键词 | `key` | `keys` |
| 次关键词 | `keysecondary` | `secondary_keys` |
| 启用 | `disable`（**反义**） | `enabled` |
| 顺序 | `order` | `insertion_order` |

**我们操作的是独立世界书文件。** 写入走「读-改-写」，你没传的字段会原样保留。

---

## 三、常见任务

**改世界书**
```
wb_list → 问清哪本 → wb_outline 看结构 → wb_search / wb_read 定位
        → wb_write 改 → wb_read 回读确认
```

**查「为什么这条没触发」**
读字段，不要猜。逐条排：被停用 / 绿灯无关键词 / 概率 0 / 次关键词矛盾 / 延迟未达。
最常见的是 **绿灯但 `key` 是空的** —— 条目写了等于没写。

**整理结构**
世界书编辑器是个**扁平列表**（某张卡 219 条排一起）。制卡人自己发明了分区办法：
`====核心规则====_开始` / `====xxx====_结束` 成对标记，还有 `[mvu_update]` / `[mvu_plot]` 语义前缀。
`wb_outline` 会把分节复现出来。**尊重它们，不要把分节标记当普通条目删掉。**
（要重新分区先问用户 —— 那是改结构，不是修 bug）

**治蓝灯泛滥**
蓝灯每轮都占 token。实测有本书 **296 条里 274 条是蓝灯**，预算被吃光，绿灯挤不进来。
`wb_outline` 数比例，和用户确认哪些能转绿灯 —— **转的时候必须给关键词**，否则变成死条目。

---

## 四、参考文件

**完整认知与操作方法都在这里**，需要时读：

| 文件 | 内容 |
|---|---|
| `references/字段速查表.md` | 全部字段 + 默认值 + 卡内对照 |
| `references/激活机制详解.md` | 一条条目什么时候会被激活（关键词 / 次级逻辑 / 分组 / 定时 / 递归 / 向量） |
| `references/注入位置与顺序.md` | 注入位置、排序机制、token 预算 |
| `references/条目范式与范例.md` | 写条目的范式与范例 |
| `references/悬案与不确定项.md` | 未验证的结论 —— **下判断之前先看** |

全部带置信度标注（high / medium / low）。**不要把 medium 当 high 用。**