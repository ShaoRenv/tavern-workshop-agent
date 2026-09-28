# 第三方声明（THIRD_PARTY_NOTICES）

本仓库（酒馆工坊Agent）的代码以根目录 [LICENSE](LICENSE)（MIT）发布。

**但本仓库包含来自 TavernWeave 的领域知识文本**，那部分**不受 MIT 覆盖**，
按上游许可 PolyForm Noncommercial License 1.0.0 使用。下面逐项说明。

---

## 1. TavernWeave（世界书 skill 领域知识）

- **来源**：TavernWeave 手册原文
  - `A3_世界书优化`（27,642 字符）
  - `A4_提示词与预设`（部分）
- **著作权人**：Copyright 2026 LiarMTTT
- **许可**：PolyForm Noncommercial License 1.0.0
  - 许可全文：[`licenses/PolyForm-Noncommercial-1.0.0.txt`](licenses/PolyForm-Noncommercial-1.0.0.txt)
  - 官方链接：<https://polyformproject.org/licenses/noncommercial/1.0.0>
  - **Required Notice**：`Copyright 2026 LiarMTTT`（已在上方与每个 skill 正文里保留）

### 用在哪里

| 位置 | 用法 | 现状 |
|---|---|---|
| `reports/世界书skill-适配稿/` | **原文机械拆分 + 平台适配**，非重写 | ✅ 已有（1 正文 + 5 references） |
| `src/苍玄助手/skills/`（落地后） | 同一批文本搬进插件（B46-B57） | ⏳ 待落地 |

⚠️ **落地时不许再改写一遍** —— 搬进 `src/` 的就是 `reports/世界书skill-适配稿/` 里那份原文，
两边必须逐字一致（可加文件头注释，不改正文）。

**「机械拆分」的含义**：按手册自己的章节切分，逐行核对无丢失；
只在必要处加了平台适配层（两套字段名对照、手册说错的两处修正、我们的工具名映射）。
正文措辞、结构、术语一律照抄上游。

### 上游声明

TavernWeave 自己的 `THIRD_PARTY_NOTICES.md` 记录了它对 SillyTavern / JS-Slash-Runner /
ST-Prompt-Template / MagVarUpdate 等项目的互操作性来源。本仓库**没有**转发那些项目的
源码或资源，因此不重复其声明；如需了解，请看上游仓库。

---

## 2. 本仓库**不包含**的上游内容

以下内容**没有**被复制进来（避免引入额外许可义务）：

- TavernWeave 的其余 21 个 skill（只用了世界书相关的两个）
- `consult-tavernweave-library` 的 AFV 前端/动效目录
- 任何上游源码、类型声明、字体、图片、扩展资源
- TavernWeave 的仓库级工具链

---

## 3. 依赖项

运行期依赖（Vue / Pinia 等）的许可在 `node_modules` 各自目录里，
不在本文件重复列举。

---

## 4. 维护要求

**新增任何第三方文本 / 代码 / 资源时，必须同步更新本文件。**
若该资源带 Required Notice，必须把 notice 原文一并保留在对应文件里，
不能只在 README 里提一句。

---

_本文件由 `reports/待办总表.md` 的 B39 引入。_
