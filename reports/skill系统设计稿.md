# skill 系统设计稿（待审）

> 状态：**等你审，未动代码**
> 任务范围：重写世界书工具 + skill 系统 + skill 内容（用户 2026 确认）
> 前置：reports/世界书-领域功课报告.md · reports/世界书-skill适配方案.md

---

## 0. 结论先行：地基验完了，5 个硬约束

**B33 实测结果**（真机，不是读文档）：

| 能力 | 结果 |
|---|---|
| 写 POST /api/files/upload | ✅ 200，返回 {path:"/user/files/xxx.md"} |
| 验 POST /api/files/verify | ✅ 200，返回 {url: true/false} |
| 读回 GET /user/files/xxx.md | ✅ 200，**中文 + emoji 逐字节一致** |
| 删 POST /api/files/delete | ✅ 200 |
| **列目录** | ❌ **没有这个 API**（/api/files/=404，/user/files/=500） |

### ⚠️ 5 个硬约束（源码出处）

| # | 约束 | 出处 | 影响 |
|---|---|---|---|
| 1 | 文件名只允许 a-zA-Z0-9_-. | src/endpoints/assets.js:22 | ❌ **中文文件名不行**（实测 400） |
| 2 | 不允许子目录（/ 被拒） | 同上 | ❌ **树状不能靠目录**（实测 400） |
| 3 | 危险扩展名被拒 | assets.js:30 + constants.js:64 | ❌ .js .py .html .sh .ps1 .sql 全挡 |
| 4 | 不能以 . 开头 | assets.js:37 | 小问题 |
| 5 | 无长度限制 | 实测 200 字符 OK | ✅ |

**允许的扩展名**：.md .json .txt —— **正好够用**。

---

## 1. 复刻哪些、不复制哪些

### 1.1 先分清「标准」和「TavernWeave 自己发明的」

```
---                                    ← ① frontmatter 分隔符【Agent Skills 标准】
name: tavern-card-builder              ← ② 【标准】
description: Plan and author...        ← ③ 【标准】
---

# Tavern Card Builder                  ← ④ 标题【习惯】

<!-- tw-guidance-entry:begin -->        ← ⑤ 【TavernWeave 发明，非标准非宏】
## Shared communication
<!-- tw-guidance-entry:end -->

Design the card as...                  ← ⑥ 正文
```

**⑤ 实测结论**：它是**构建期代码生成锚点**，不是运行时机制。

我跑 node scripts/sync-guidance.mjs --check 实测：
- 改源头一个词 → 报 changedOrDrifted: ["host-adapters/tavernweave-front-door.md"]，**exit 1**
- 标记写坏 → 抛 Invalid generated markers
- 恢复 → exit 0

**它对模型零作用**（HTML 注释渲染后不可见）。它解决的是「一份规矩要同步进 22 个磁盘文件」。

### 1.2 DSH 的 skill 加载器（权威标准）

读 @deepseek-ai/dsh-skill-filesystem/lib/index.js：

| 项 | 规则 | 行号 |
|---|---|---|
| 位置 | skills/<名字>/SKILL.md 或 skills/<名字>.md | 550, 587, 589 |
| frontmatter | **必须**有 | 675-677 |
| name | **必须**，有格式校验 | 679-688 |
| description | **必须** | 680-682 |
| whenToUse | 可选 | 699 |
| metadata | 可选（对象） | 701, 872-873 |
| disable-model-invocation | 可选（布尔） | 845 |
| user-invocable | 可选（布尔） | 846 |

### 1.3 复刻清单

| 复刻 ✅ | 不复制 ❌ |
|---|---|
| SKILL.md + frontmatter（name/description） | <!-- tw-... --> 锚点标记 |
| 树状：references/ scripts/ assets/ | sync-guidance.mjs 同步脚本 |
| **渐进披露三层** | agents/openai.yaml（Codex 专有） |
| disable-model-invocation / user-invocable 权限位 | TavernWeave 那 43 行契约的具体内容 |
---

## 2. 存储设计（路线 B）

### 2.1 目录布局

**约束**：不能有子目录、不能有中文名。**解法：文件名编码路径 + 索引文件**。

```
ST 文件系统 /user/files/
├── cx_skills_index.json              ← 索引（唯一真相）
├── cxskill_worldbook__SKILL.md        ← 世界书工程 / SKILL.md
├── cxskill_worldbook__ref__fields.md  ← 世界书工程 / references/字段速查表.md
├── cxskill_worldbook__ref__inject.md  ← 世界书工程 / references/注入位置与顺序.md
├── cxskill_worldbook__ref__activation.md
├── cxskill_worldbook__ref__patterns.md
└── cxskill_worldbook__ref__open-issues.md
```

**命名规则**：
```
cxskill_<skillId>__<相对路径，/ 换成 __>.md
```
实测通过（cxskill__references__field-table.md = 200）。

### 2.2 索引文件（关键）

**为什么必须有**：没有列目录 API，只能靠索引知道有哪些 skill。

```json
{
  "version": 1,
  "skills": [
    {
      "id": "worldbook",
      "name": "世界书工程",
      "summary": "改世界书前先读它",
      "builtin": true,
      "version": "1.0.0",
      "enabled": true,
      "frontmatter": { "name": "worldbook-engineering", "description": "..." },
      "files": [
        { "path": "SKILL.md", "file": "cxskill_worldbook__SKILL.md", "bytes": 12000, "sha256": "..." },
        { "path": "references/字段速查表.md", "file": "cxskill_worldbook__ref__fields.md", "bytes": 8000, "sha256": "..." }
      ]
    }
  ]
}
```

**索引同时解决三件事**：
1. 没有列目录 API → 靠索引枚举
2. 中文名不能做文件名 → 中文存在索引里
3. 内置/用户区分 → builtin: true = **只读**

### 2.3 路径映射（对外树状，对内扁平）

| 用户/模型看到 | 实际文件名 |
|---|---|
| 世界书工程/SKILL.md | cxskill_worldbook__SKILL.md |
| 世界书工程/references/字段速查表.md | cxskill_worldbook__ref__fields.md |

**映射由索引负责**，模型永远只看树状路径。

---

## 3. 渐进披露三层（skill 系统的灵魂）

```
第 1 层：摘要进系统提示词
   → 只有「名称 + 一句话描述」
   → 22 个 skill 也就几百 token

第 2 层：skill() 读正文
   → 模型主动调，读 SKILL.md

第 3 层：read_skill_file() 读参考
   → 需要时才读 references/xxx.md
```

**现状**：三层已经有了（tools_skill.ts 的 skill / read_skill_file），**要改的是内容来源** ——
从「内存里的 data.skills」改成「**ST 文件 + 索引**」。

### 3.1 ⚠️ 截断限制必须重定（B50）

```ts
// tools_skill.ts 现在
const BODY_LIMIT = 20000;   // 正文上限
const FILE_LIMIT = 12000;   // 单文件上限
```

**问题**：世界书手册 **27,642 字符** → 正文 20,000 就截断了，**读不全**。

**方案**：
- 正文：不截断（正文是主入口，必须完整）
- 参考文件：**分页**（read_skill_file 加 offset/limit），因为 27,642 字符一次塞进上下文太贵

---

## 4. 权限位（你要的「必读」）

DSH 标准里有两位（index.js:845-846）：

| 位 | 含义 | 我们的用法 |
|---|---|---|
| disable-model-invocation | 模型**不能自己调**，只能用户主动触发 | 给「危险操作」类 skill |
| user-invocable | 用户**能直接调** | 给「用户想手动跑」的 skill |

**关键澄清**：这两个位**不是「必读」机制**。

### 「必读」在 TavernWeave 里到底是什么

我实测查证：**「必读」在 TavernWeave 里不是某个特殊 skill，是三套机制**：

| 机制 | 做法 | 证据 |
|---|---|---|
| ① 共享块自动内联 | 每个 SKILL.md 头部有 <!-- tw-guidance-entry --> 包裹的「Shared communication」，**22/22 全有** | 实测 |
| ② 路由表 | route-map.json 是机器权威：哪个任务 → 读哪些文件 | consult-.../SKILL.md:33 |
| ③ 写入前门禁 | 「写入类任务前必须读 A0 检查单，或明确确认三个门：目标、红线、验收」 | consult-.../SKILL.md:23 |

**你要的「必读」= 机制 ① + ③。**

### 4.1 我们的「共享纪律」怎么做

**用户明确否决了「塞进系统提示词」**：
> 「我不想在系统提示词中注入系统提示词，因为这套 skill 不是 agent 的全部使用场景，这是一个酒馆内的 agent 底座而不是制卡改卡机器」

**照搬机制，不照搬实现**：

| TavernWeave | 我们 |
|---|---|
| 构建期脚本写进 22 个磁盘文件 | **运行期 skill() 自动注入**（改一处代码） |
| HTML 注释锚点 | 不需要（不写进文件就不会漂移） |
| 写在 markdown 里 | 存成**一段可编辑文本**（用户能改） |

**实现**：
```ts
// tools_skill.ts 的 skill() 返回时
const body = 共享纪律 + "\n\n" + skill.body;
```

**效果**：模型读**任何** skill 都会先读到纪律；不碰系统提示词；底座还是底座。

**比 TavernWeave 还干净**：它们的 skill 是磁盘文件所以需要脚本同步；我们是数据结构，运行期拼接**不存在漂移**。
---

## 5. 用户要的预设机制（默认只读 + 派生 + 导出）

### 5.1 现状冲突

presets/builtin.ts:445-462 现在是**「只补不覆盖」**：

```ts
// 规则：只补不覆盖。同 id 已存在就原样保留（用户可能改过内置内容）
for (const preset of createBuiltinPresets()) {
  if (!presetIds.has(preset.id)) presets.push(preset);
}
```

**这和你的要求矛盾**：

| 现在 | 你要的 |
|---|---|
| 用户改了内置 → 保留用户那份 → **内置永远更新不了** | 默认预设**只读**，要改就**派生副本** |

这正是 B7「内置提示词改了会丢」的**同一个根**。

### 5.2 新机制

```
内置预设（builtin: true）
   ├─ 界面显示「内置」标记，不可编辑
   ├─ applyBuiltins() 每次刷新**强制写回最新版**
   └─ 用户点「在此基础上新建」→ 派生
        ↓
     用户预设（builtin: false，id 为新生成的）
       ├─ 完全可编辑
       └─ 不受内置更新影响
```

### 5.3 导出/导入分三类（D8）

| 类 | 内容 | 格式 |
|---|---|---|
| ① 工具提示词 | 用户改过的 model_description | JSON |
| ② 预设 | 系统提示词 + items + 能力 | JSON |
| ③ 技能 | skill 全文 + 参考文件 | JSON 或 SKILL.md 目录 |

**现状**：SettingsView.vue:196-198 只有「导出全部数据 / 导出（不含 Key）/ 导入数据」—— **是整棵树，不分三类**。

### 5.4 工具提示词预设（B45）

现在 tool_overrides 是**全局一份**。你要的是**能存成预设、切换、导出**。

设计：
```
tool_prompt_presets: [
  { id, name, builtin, overrides: { [toolName]: model_description } }
]
active_tool_prompt_preset: string
```

---

## 6. 要动的文件清单

| 文件 | 改什么 |
|---|---|
| core/types.ts | SkillSchema 加 frontmatter / version；新增 ToolPromptPresetSchema |
| agent/tools_skill.ts | skill() 注入共享纪律；read_skill_file 加分页；去掉硬截断 |
| agent/registry.ts | skill 来源改为「索引 + ST 文件」 |
| **新增** core/skill_store.ts | ST 文件读写 + 索引维护 + 路径映射 |
| presets/builtin.ts | applyBuiltins() 改为内置**强制覆盖**；加派生函数 |
| views/SkillsView.vue | 树状展示；内置只读标记；派生按钮 |
| views/SettingsView.vue | 导出分三类 |
| components/SkillCard.vue | 显示 builtin / 版本 / 文件树 |

---

## 7. 需要你拍板

| # | 问题 | 我的建议 |
|---|---|---|
| **K1** | 索引文件放 ST 文件，还是仍放变量？ | **ST 文件**（和 skill 文件放一起好维护） |
| **K2** | 共享纪律**注入位置**：每个 skill 正文前？还是只在「写操作类」skill 前？ | **每个 skill 正文前**（照搬 TavernWeave 22/22） |
| **K3** | 共享纪律**内容**从哪来？ | 从 TavernWeave 的 communication-and-guidance.md **适配**（挑通用的，去掉制卡专有） |
| **K4** | read_skill_file 分页，还是整篇给？ | **分页**（手册 27,642 字符一次给太贵） |
| **K5** | 用户 skill 也放 ST 文件，还是小的放变量？ | **都放 ST 文件**（统一，且变量只剩 8000 字符） |
| **K6** | 旧的 data.skills 变量怎么迁移？ | 首次启动自动迁到 ST 文件，变量里只留索引指针 |

---

## 8. 下一步

```
1. 你审这份 → 改到你说行
2. 写《世界书 skill 内容》全文（从 945 行手册适配）→ 再交你审
3. 写《世界书工具设计稿》修订版 → 再交你审
4. 三份都过了，才动代码
```

---

## 附：本次实测的原始证据

**B33 files API 实测**：
```json
{ "uploadStatus": 200, "uploadBody": "{\"path\":\"/user/files/cx-wb-skill-test.md\"}",
  "verifyStatus": 200, "verifyBody": "{\"/user/files/cx-wb-skill-test.md\":true}",
  "readStatus": 200, "readText": "# 测试\n\n这是酒馆工坊的 skill 存储测试。\n中文 + emoji ✅\n",
  "roundTrip": "EXACT",
  "extra": {
    "子目录 cx-sub/dir-test.md": "400 Illegal character in filename; only alphanumeric, _, - are accepted.",
    "路径穿越 ../escape.md": "400 Illegal character in filename...",
    "js 扩展名 cx-evil.js": "400 Forbidden file extension.",
    "py 扩展名 cx-evil.py": "400 Forbidden file extension." } }
```

**文件名约束实测**：
```json
{ "普通 .md": 200, "双下划线编码路径": 200, "单下划线": 200,
  "超长 200 字符": 200, "超长 120 字符": 200,
  "中文名": "400 Illegal character in filename...",
  "点开头": "400 Filename cannot start with .", "无扩展名": 200,
  "listApi": 404, "staticDir": "500 Internal Server Error" }
```

**清理验证**：删除后 verify 从 true 变 false，测试文件已全部清除。
