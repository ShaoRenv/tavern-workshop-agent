# task-22（P4-7）三个内置插件补 contributes.requires —— 验收记录

> 执行者：host-bridge ｜ 写作用域：三个 `plugins/builtin/*/manifest.ts`
> 目的：让「能力闸」从「shipped but dead」变成**真的会拦**，并留下可复现的实证。

---

## 一、查实结果（grep 各自目录，不照抄题面猜测）

口径：能力名逐字等于 `core/capability.ts` 的 `CAPABILITIES[].name`；
`['X']` = 必需，`['X?']` = 可选；**未知名字 = 装载失败**（故意的，写错不许静默通过）。

### 1. worldbook —— 按**本插件代码路径**分必需 / 可选

```ts
requires: [
  'getWorldbook',
  'replaceWorldbook',
  'getWorldbookNames?',
  'getGlobalWorldbookNames?',
  'getCharWorldbookNames?',
  'getChatWorldbookName?',
  'createWorldbook?',
  'deleteWorldbook?',
]
```

判据不是抄能力表的 `required` 字段，而是看 `core/worldbook.ts` 用的是哪把取函数：

| 名字 | 判据（代码事实） | 必需性 |
|---|---|---|
| `getWorldbook` | `requireHostFn`（worldbook.ts:484）→ 取不到**直接抛** | **必需** |
| `replaceWorldbook` | `requireHostFn`（:549）→ `writeAll` 唯一出口 | **必需** |
| `getWorldbookNames` | `hostFn`（:369）+ `if (!getNames) return []` | 可选 |
| `getGlobalWorldbookNames` | `hostFn`（:393）+ try/catch continue | 可选 |
| `getCharWorldbookNames` | `hostFn`（:403）+ try/catch continue | 可选 |
| `getChatWorldbookName` | `hostFn`（:416）+ try/catch continue | 可选 |
| `createWorldbook` | `hostFn`（:526）；缺了还有 `createOrReplaceWorldbook` 兜底 | 可选 |
| `deleteWorldbook` | 只影响删除路径 | 可选 |

**为什么不声明 `createOrReplaceWorldbook`**：它**不在**能力表 26 个名字里。
声明它 = `probeCapabilities` 判「名字不在能力表」= 世界书插件整个装不上。
它是 `createWorldbook` 的**内部兜底**（worldbook.ts:531），不是对外能力。

**为什么列表类四个是「可选」**：它们全是 `hostFn()`，取不到就 `return []` / 跳过 ——
那是**降级**，不是不可用。写成必需会让「只缺一个枚举接口」的机器整插件消失，比降级更糟。

### 2. cangxuan —— 只一条，且可选

```ts
requires: ['getScriptTrees?']
```

唯一碰宿主的地方是 `core/portrait.ts` 的 `getScriptTreesViaHost()`。
**必须带 `?`**：该接口在 ST 原生**没有对应**（`native.ts` 的 `NO_NATIVE_EQUIVALENT`），
只有装了酒馆助手才有；取不到时它 `return []` + 记一次原因（portrait.ts:30-40）。
声明成必需 = 玩家没装酒馆助手 → 整个苍玄助手插件（含三个宏）消失，比「图库空着」糟得多。

### 3. image —— 查实后确认 `requires` 缺省（**不是漏了**）

grep 本目录全部宿主调用点，**只有一处**：`nai.ts:332` 的 `hostFn('fetch')`。
- `fetch` **不在**能力表 26 个名字里 → 写进 requires 会让插件永远装不上，**不能写**；
- 也**不需要**写：生图是用户自己填接口地址直连 NovelAI，不经酒馆助手、不需要模型生成能力；
  `fetch` 是浏览器自带的，不是「宿主能力」。
- 题面假设过 `['generateImage']` —— 能力表里**没有这个名字**，照抄会让插件永远装不上。
  **实查后否掉了它**（这正是本任务要防的「名字打错」）。

> 附带发现：`core/capability.ts` 的 `CAPABILITIES` 里 **`fetch` 未被登记为能力**。
> 若不打算让插件声明 fetch，现状即可；若将来要声明，需先在能力表登记这个名字。

---

## 二、逐字核对：9 个声明名全部命中能力表

```
CAPABILITIES count = 26
cangxuan   OK   getScriptTrees?
worldbook  OK   getWorldbook
worldbook  OK   replaceWorldbook
worldbook  OK   getWorldbookNames?
worldbook  OK   getGlobalWorldbookNames?
worldbook  OK   getCharWorldbookNames?
worldbook  OK   getChatWorldbookName?
worldbook  OK   createWorldbook?
worldbook  OK   deleteWorldbook?
image      requires = (缺省/空)
BAD COUNT = 0
```

---

## 三、真机证据（宿主机：酒馆 1.18.0 @8000，扩展形态，酒馆助手 4.8.9 在位）

部署方式：`pnpm build:ext` → 覆盖 `data/default-user/extensions/苍玄界/` → 刷新。

### 证据 1：正常装载 —— 页面在、7 个工具都在

| 观测点 | 结果 |
|---|---|
| 顶栏页签 | `["对话","世界书","设置"]` |
| 面板状态 | `● 已连接` |
| 工具总数 | **15 个** |
| 7 个世界书工具 | **全在**：列世界书 / 搜条目 / 读条目 / 新建条目 / 改条目 / 删条目 / 改条目属性 |
| 世界书页 | 活着，`0 / 14 本`，**列出 14 本真实世界书**（证 `getWorldbookNames` 真通） |
| 未注册残留 | `stillMissing=false`（没有「来源已停用 / (缺失)」） |

截图存于 `reports/task22-evidence/正常装载-世界书页14本.png`。

### 证据 2：⭐「写错名字会被拦下」实验（本条唯一有价值的部分）

**实验设计**：把 `'getWorldbook'` 故意改成 `'getWorldbooks'`（多一个 s）→ build → 部署 → 刷新。
改前备份，`sha256 = CC9D9AA3F83560E9B8C449125DEA356241B780CB282ADD0D6CCE8728AD50F4DB`。

**对照/实验组对比（真机实测）**：

| | 顶栏 | 工具数 | 世界书页 |
|---|---|---|---|
| 对照（正常 requires） | [对话, **世界书**, 设置] | **15** | 活着，列出 **14 本真世界书** |
| 实验（`getWorldbooks`） | [对话, 设置] | **14** | **真的消失** |

7 个世界书工具逐个可见地变为「来源已停用 / 内核里没有 / (缺失)」。
核心层给出的是**人话 + 自带诊断**：

```
缺少必需能力：getWorldbooks、写回世界书（该插件已跳过，未注册任何工具 / 页面 / 宏）
这个插件需要以下能力，其中 2 项在这台机器上不可用：
  ✗ getWorldbooks（getWorldbooks）
      能力「getWorldbooks」不在底座的能力表里（core/capability.ts 的 CAPABILITIES）。
      这是插件 manifest 的 requires 写错了名字 —— 请改成能力表里的名字，或先在能力表里登记这条能力。
```

**结论：闸是活的** —— 名字打错 → 插件真的不注册 + 原因可读。这就是 P4-7 要的实证。

**还原**：已还原为 `'getWorldbook'`，还原后 `sha256 = CC9D9AA3…F4DB`（与备份**逐字节一致**），
并**重新 build + 部署 + 复跑**采了上面证据 1（当前代码状态）。

> ⚠️ 过程备注：实验期间该 typo 被 lead 看到并误判为笔误要修，我已即时说明「这是我故意的实验」，未影响结论。
> 教训已由 lead 记入流程复盘（看到可疑名字应先确认执行者状态再下结论）。

---

## 四、门禁

| 门禁 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | **752 tests / 752 pass / 0 fail** |
| `npx tsc --noEmit`（src） | **0 error** |
| `npx eslint`（我改的 3 个文件） | **exit 0** |

（说明：`npx eslint` 全项目输出 **exit 1**，为**既存**状态 —— 3142 errors 集中在示例代码 /
测试文件的 `import-x/no-nodejs-modules` 等规则，与本次改动无关；我改的 3 个文件单独跑 exit 0。
另外全量测试在我改动期间曾因 test-author 的「能力夹具」尚未落地而出现成片红，
lead 已确认那是**闸按设计生效**、归 task-32，非本任务产品侧问题；现在 752/752 全绿。）

---

## 五、顺带发现（**未扩范围**，已报 lead 另开任务）

**插件列表页没反映「缺能力」**：实验组里**实际装载**已被正确拦掉（顶栏、工具注册表都对），
但插件**列表页**那一行仍显示「世界书 · 已启用 · 1 页 · 7 工具」，详情页也没有「缺能力」标记 ——
列表用的是不看能力的老 `pluginStatus`，没走 `pluginStatusWithCapabilities`。
用户会看到「已启用」但插件其实没在工作，属于本底座要消除的「假状态」。
lead 已确认是**真问题**并另开任务追踪；**不在 task-22 范围内**。

---

## 六、改动清单

| 文件 | 改动 |
|---|---|
| `src/苍玄助手/plugins/builtin/worldbook/manifest.ts` | +`requires`（2 必需 + 6 可选）+ 口径注释 |
| `src/苍玄助手/plugins/builtin/cangxuan/manifest.ts` | +`requires: ['getScriptTrees?']` + 口径注释 |
| `src/苍玄助手/plugins/builtin/image/manifest.ts` | 仅补注释说明「查实后不需声明」，**无 requires 字段** |

未新增依赖、未改任何其它文件。
