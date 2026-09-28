# skill 存储系统设计稿（待审）

> 状态：**等你审，未动代码**
> 范围：skill 存储 + 索引 + 出厂/用户两层 + 恢复默认 + 插件贡献 skill

---

## 0. 前提：已经实测过的事实

| 事实 | 证据 |
|---|---|
| 外部插件**只能上传单个文件** | `loader.ts` `installFromCode` 收一段代码；`code_path` 是单路径 |
| **所以 md 必须内置在插件里**（用户纠正，已接受） | 用户原话：「用户只能上传 index.js，所以 md 是内置在插件的」 |
| webpack 支持 `?raw` 导入任意文件 | `webpack.config.ts:374-378` `resourceQuery: /raw/` → `asset/source` |
| ST `/api/files/` 可读写，**无列目录 API** | 实测：upload/verify/delete 200，`/api/files/` 404 |
| ST `/api/files/` 文件名只允许 `a-zA-Z0-9_-.` | `assets.js:22`，中文实测 400 |
| **不允许子目录** | 同上，`cx-sub/dir.md` 实测 400 |
| 允许的扩展名含 `.md` `.json` `.txt` | `assets.js:30` + `constants.js:64`（`.js`/`.py`/`.html` 被挡） |
| 无长度限制 | 实测 200 字符文件名 OK |

**结论：只有「内置在插件」这一条路**（不需要往扩展目录放）。

---

## 1. 存储结构：三层

```
第 1 层 · 出厂（编译进 index.js，用户改不到）
   src/苍玄助手/plugins/builtin/worldbook/skills/世界书工程/
   ├── SKILL.md
   └── references/*.md
        │ import ... from '...?raw'  →  webpack 打成字符串进 bundle
        ↓
第 2 层 · 用户副本（可编辑，日常读写都在这）
   /user/files/cxskill_worldbook__SKILL.md
   /user/files/cxskill_worldbook__ref__fields.md
        ↑ 首次运行从第 1 层释放
        ↓ 用户随便改；改坏了从第 1 层重新释放 = 恢复默认
        ↓
第 3 层 · 索引（没有列目录 API，必须靠它枚举）
   /user/files/cx_skills_index.json
```

### 1.1 为什么文件名要编码

**ST 不允许中文文件名、不允许子目录。** 所以：

```
cxskill_<skillId>__<相对路径，/ 换成 __>.md

世界书工程/SKILL.md                  →  cxskill_worldbook__SKILL.md
世界书工程/references/字段速查表.md  →  cxskill_worldbook__ref__fields.md
```

**实测通过**：`cxskill__references__field-table.md` = 200。

**对外仍是树状** —— 模型和用户只看 `世界书工程/references/字段速查表.md`，映射由索引负责。

### 1.2 索引文件

```json
{
  "version": 1,
  "skills": [
    {
      "id": "worldbook",
      "name": "世界书工程",
      "summary": "改世界书前先读它",
      "enabled": true,
      "fromPlugin": "worldbook",        // 哪个插件带的（空 = 用户自建）
      "factoryHash": "a1b2c3d4",        // 出厂版哈希（判断用户改没改过）
      "files": [
        { "path": "SKILL.md", "file": "cxskill_worldbook__SKILL.md" },
        { "path": "references/字段速查表.md", "file": "cxskill_worldbook__ref__fields.md" }
      ]
    }
  ]
}
```

**索引同时解决三件事**：
1. 没有列目录 API → 靠索引枚举
2. 中文名不能做文件名 → 中文存在索引里
3. 区分出厂/用户 → `fromPlugin` + `factoryHash`

---

## 2. 五个操作

| 操作 | 做什么 |
|---|---|
| **释放**（首次运行） | 索引里没有的 → 从第 1 层复制到 `/user/files/` + 写索引 |
| **读** | 读 `/user/files/` 那份；读不到就回退到第 1 层（bundle） |
| **写** | 改 `/user/files/` 那份 + 更新索引（`factoryHash` 不变） |
| **新建 / 另存为** | 写新 `/user/files/` 文件 + 索引加一项（`fromPlugin` 为空） |
| **恢复默认** | 单个：从第 1 层重新复制覆盖；批量：遍历 `fromPlugin` 非空的全部重放 |

### 2.1 恢复默认的判据

```ts
// 用户改过没有？对比当前内容与出厂版的哈希
const current = await readSkillFile(...);
const factory = factoryContentFor(skill.id, relPath);   // 从 bundle 拿
if (hashText(current) === hashText(factory)) {
  // 没改过 → 静默跳过，不用恢复
} else {
  // 改过 → 覆盖
}
```

**「批量恢复默认」**：遍历所有 `fromPlugin` 非空的，逐个重放。

---

## 3. 插件贡献 skill

### 3.1 现状：机制已有，但没人用

| 层 | 状态 |
|---|---|
| `PluginManifest.contributes.skills` | ✅ 已定义（`plugins/types.ts:117`） |
| `PluginSkillRef { name, desc, content }` | ✅ 已定义（`types.ts:148-154`） |
| `pluginSkills(state)` 收集 | ✅ 已实现（`registry.ts:462`） |
| **合并进技能注册表** | ❌ **只收集，没合并** |
| **`files[]` 支持** | ❌ `PluginSkillRef` 没有这个字段 |
| 世界书插件 manifest | ❌ 没声明 `contributes.skills` |

### 3.2 要改的

```ts
// plugins/types.ts
export interface PluginSkillRef {
  name: string;
  desc: string;
  content: string;                      // SKILL.md 正文
  files?: { name: string; content: string }[];   // ★ 新增：树状参考文件
}
```

### 3.3 世界书插件怎么声明

```ts
// plugins/builtin/worldbook/manifest.ts
import skillBody from './skills/世界书工程/SKILL.md?raw';
import fieldTable from './skills/世界书工程/references/字段速查表.md?raw';
// ... 其余 4 个 references

contributes: {
  pages: [...],
  tools: createWorldbookTools(),
  skills: [{
    name: '世界书工程',
    desc: '改酒馆世界书：改前看结构、改后回读',
    content: skillBody,
    files: [
      { name: 'references/字段速查表.md', content: fieldTable },
      // ...
    ],
  }],
  requires: [...],
}
```

### 3.4 与「出厂/用户两层」的关系

**插件带的 skill = 出厂层。** 流程：

```
插件装载 → pluginSkills() 拿到 { name, desc, content, files }
   ↓ 并进技能注册表
首次运行 → 释放到 /user/files/ + 写索引（fromPlugin = 插件 id）
   ↓
之后读 /user/files/ 那份；恢复默认从插件那份重放
```

**关掉插件 → 它的 skill 从列表消失**（`PluginSkillRef` 注释的原设计意图）。

---

## 4. 要动的文件

| 文件 | 改什么 |
|---|---|
| `plugins/types.ts` | `PluginSkillRef` 加 `files?` |
| `plugins/registry.ts` | `pluginSkills()` 的产物并进技能注册表 |
| **新增** `core/skill_store.ts` | ST 文件读写 + 索引维护 + 路径编码/解码 + 释放/恢复 |
| `core/types.ts` | `SkillSchema` 加 `fromPlugin` / `factoryHash`；`DATA_VERSION` 相关 |
| `agent/registry.ts` | skill 来源改为「索引 + ST 文件」 |
| `agent/tools_skill.ts` | `skill()` 读 ST 文件；`read_skill_file` 支持分页 |
| `plugins/builtin/worldbook/manifest.ts` | 声明 `contributes.skills` |
| `plugins/builtin/worldbook/skills/` | **新增目录**：放 6 个 md 文件 |
| `webpack.config.ts` | 确认 `.md?raw` 规则生效（已有 `resourceQuery: /raw/`） |
| `views/SkillsView.vue` | 树状展示 + 「恢复默认」按钮 |

---

## 5. 需要你拍板

| # | 问题 | 我的建议 |
|---|---|---|
| **K1** | 索引文件放 `/user/files/cx_skills_index.json`？ | 是 |
| **K2** | 用户自建的 skill 也走 `/user/files/`？ | 是（统一） |
| **K3** | 老数据 `RootData.skills` 怎么迁移？ | 首次启动：把变量里的 skill 写成 ST 文件 + 索引，变量里只留空数组 |
| **K4** | 旧 `builtin-skill-worldbook-polish` / `builtin-skill-faction-relations` 怎么办？ | **删掉**（D7 已定案） |
| **K5** | `read_skill_file` 分页？ | 要（手册 27,642 字符一次给太贵） |
| **K6** | 插件关掉时，已释放到 `/user/files/` 的副本要不要删？ | **不删**（用户可能改过），只在列表里隐藏 |

---

## 6. 下一步

```
1. 你审这份 → 改到你说行
2. 三份设计稿都过了才动代码：
   · reports/skill系统设计稿.md
   · reports/预设系统设计稿.md
   · reports/skill存储系统设计稿.md（本文）
```
