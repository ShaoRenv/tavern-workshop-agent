# 苍玄界 · 立绘提示词工坊

面向 SillyTavern + 酒馆助手（JS-Slash-Runner）的**前端界面**：把立绘 PNG 里带的生图提示词榨出来，交给 LLM 打包成绘图插件的角色预设 JSON，或把世界书里的角色设定压缩成一份新的精简世界书。

它做两件事：

1. **立绘元数据 → 角色预设**：从本机图库读立绘图片，解析 PNG 文本块（NovelAI V4/V3、A1111、ComfyUI），默认只取 `char_caption`（角色 DNA）与 `prompt`（完整提示词），调 LLM 转成**智绘姬（st-chatu8）**或**小白x（novel-draw-characters v3）**的角色预设 JSON，可合并进你已有的插件文件。
2. **世界书 → 新世界书**：从指定源世界书里按区块或势力勾选角色，调 LLM 生成「全角色蓝灯精简」正文，写成一个**全新的**世界书条目（永远新建，不覆盖既有世界书）。

---

## 目录结构

```
src/苍玄界立绘工坊/
├─ index.html            前端界面容器（<div id="app">）
├─ index.ts              入口：createApp + Pinia，挂载到 #app
├─ App.vue               顶部标题与四个页签
├─ views/
│  ├─ GalleryView.vue      ① 立绘图库
│  ├─ PortraitsView.vue    ② 打包导出
│  ├─ WorldbookView.vue    ③ 世界书
│  └─ PresetsView.vue      ④ 预设与模板
├─ stores/workshop.ts    唯一的 Pinia store：全部状态与动作
├─ core/                 纯逻辑解析层（不依赖酒馆全局，可被 node --test 直接测试）
│  ├─ png_meta.ts          PNG tEXt / zTXt / iTXt 文本块解析
│  ├─ nai_parser.ts        NovelAI V4 / V3
│  ├─ a1111_parser.ts      Stable Diffusion WebUI (A1111)
│  ├─ comfyui_parser.ts    ComfyUI
│  ├─ meta_types.ts        格式识别与归一化文档
│  ├─ extractor.ts         按规则从元数据里抽字段
│  ├─ json_util.ts         宽松 JSON 解析、路径取值（支持 [*]）
│  ├─ llm_extract.ts       从 LLM 回复里抽 JSON
│  ├─ merge.ts             合并进两个绘图插件的既有格式
│  ├─ gallery_source.ts    图库采集（localStorage + 状态栏脚本）
│  ├─ statusbar_scrape.ts  状态栏脚本文本解析
│  ├─ worldbook_source.ts  世界书区块 / 势力树解析
│  ├─ fetch_image.ts       图片下载与本地文件读取
│  └─ async_util.ts        受限并发工具
└─ llm/
   ├─ schema.ts          全部数据模型的 zod schema
   ├─ presets_builtin.ts 内置模板、LLM 预设、提取规则、世界书预设
   └─ engine.ts          分批、重试、降级、合并的执行主体
```

单测在 `tests/苍玄界立绘工坊/`。

---

## 安装与导入

```bash
pnpm install

pnpm build       # 生产构建（含压缩 / 混淆）
# 或
pnpm build:dev   # 开发构建，产物可读性更好
```

**产物**：`dist/苍玄界立绘工坊/index.html` —— 单文件，CSS 与 JS 全部内联（仓库中现有产物实测 1,407,612 字节，≈1.34 MiB）。把它作为**前端界面**导入酒馆助手即可。

开发期用 `pnpm watch` 会启动酒馆监听服务（端口 6621），编译完成后自动推送更新事件；该模式还会顺带执行 `pnpm dump`（把 schema.ts 转成 schema.json）与 `pnpm sync bundle all`。

---

## 数据从哪来（隐私与合规）

界面**不调用任何第三方云服务 / Worker API**：整个模块里只有一处网络请求，就是按图床**直链**下载图片本身以读取 PNG 元数据（地址来自图库数据本身，`fetch(url, { credentials: 'omit' })`）。图库数据的采集全部发生在本机：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 创意工坊同步到本地的角色 | `localStorage['cx_workshop_custom_roles_v1']` | 只读本机 localStorage，不访问创意工坊云端 |
| 状态栏里手动添加的角色 | `localStorage['cx_status_custom_roles_v1']` | 同上 |
| 状态栏内置基础图库 | 名为「状态栏」的脚本正文里内嵌的 `npcList` | 纯本地文本解析（脚本内有一段 base64 的 HTML，解码后抠出角色表与 `fixedSectMap`） |
| 手动补充 | 你在「立绘图库」粘贴的角色名 + 图片 URL | 只存在内存，不写回任何持久层 |

- 前端界面与酒馆同源，代码按 `window.parent.localStorage` → `window.top.localStorage` → `localStorage` 的顺序尝试取用宿主存储。
- 三类来源按**角色名**合并去重，优先级为 **状态栏内置 < 创意工坊 < 状态栏自建**（同名以后者覆盖前者），与状态栏自身的 `getMergedNpcList` 方向一致。
- 你在「④ 预设与模板」里编辑的预设、模板、提取规则以及设置项，保存在酒馆的**全局变量** `cx_portrait_workshop_v1` 中（`insertOrAssignVariables`，type: global），对所有角色卡与聊天共享，不写 localStorage。
- 首次运行时若发现四类内置资源为空，会自动填入一套内置模板 / LLM 预设 / 提取规则 / 世界书预设。

---

## 使用流程

顶部四个页签对应四步，正常顺序是 **① → ②** 或 **① → ③**，④ 随时可改。

### ① 立绘图库

1. 点 **重新采集图库**：从上面三个本机来源读出角色表。若找不到状态栏脚本，会提示「未找到状态栏脚本或其内嵌图库，基础图库为空（可手动粘贴 URL 补充）」。
2. 用筛选条缩小范围：搜索角色名、按势力下拉、勾选「只看有图片地址」；**全选当前**只作用于筛选后可见的行，**清空选择**作用于全部行。
3. 表格里每行显示：勾选框、角色、势力、来源（状态栏内置 / 创意工坊 / 状态栏自建 / 手动添加）、解析状态、元数据预览、操作（详情 / 上传）。
4. 勾选若干角色后点 **解析选中元数据（N）**。解析用的图片地址取 `portraitImg`（立绘），没有才退回 `defaultImg`（头像）；下载并发由设置项 `image_concurrency`（默认 4）控制。
5. 解析状态含义：

   | 状态 | 含义 |
   | --- | --- |
   | 待解析 | 还没解析过 |
   | 解析中 | 正在下载 / 解析 |
   | 解析成功 | 识别出元数据格式，并已按当前规则抽出字段 |
   | 无元数据 | 图片能下载，但 PNG 里没有可用文本块 |
   | 跨域被拦截 | 下载请求被同源策略挡下（fetch 抛 TypeError） |
   | 解析失败 | 其它错误（HTTP 状态码、读取异常等） |
   | 手动上传 | 由本地上传解析成功 |

6. 若某行显示「跨域被拦截」或「无元数据」，点该行的 **上传**，选本地 PNG 文件 —— 这条路径不经过网络，一定能拿到元数据。**详情**按钮可查看该行实际命中的图片地址与完整提取文本。
7. 也可以用最上面的「角色名 + 立绘图片 URL + 手动添加 / 覆盖」补充不在图库里的角色（同名则覆盖其图片地址）。

> 只有解析成功的行才能在②里被处理：打包时只取「已勾选且提取文本非空」的行。

### ② 打包导出

1. 顶部三件套：
   - **LLM 预设**：决定提示词、批大小、冲突策略。
   - **元数据提取规则**：决定从图片里取哪些字段（这里选中的规则**实际生效**）。
   - **冲突处理**：覆盖同名角色 / 跳过同名角色 / 保留双方（改名）。改动会直接写回当前 LLM 预设。
2. 中间一行会显示当前生效的「目标格式 · 合并方式 · 批大小」。目标格式来自模板的 `target`（当它不是 `custom` 时），否则用预设的 `target`；只支持智绘姬与小白x 两种。
3. 点 **开始打包（N 个角色）**。角色按 `batch_size` 分批送 LLM：
   - 整批解析失败会重试，最多 `max_retries` 次；
   - 整批仍失败且该批多于 1 人时，**降级为逐角色处理**，避免一个角色拖垮整批；
   - 只有所有重试都耗尽才算「失败」，失败角色列在结果下方。
4. **中止**会立刻停止后续批次并调用 `stopAllGeneration()`；已完成的部分保留在结果里。
5. 想合并进已有插件文件时，点 **导入既有插件文件** 选一个 JSON（例如智绘姬导出的角色预设），后续生成会以它为基底合并；**清空基底** 恢复为从零生成。注意这份基底只存在内存中，刷新界面后需要重新导入。
6. 结果区显示进度条、执行摘要（新增 / 覆盖 / 跳过 / 失败各几个）、失败清单、可折叠的执行日志，以及最终 JSON 预览，支持 **复制 JSON** 与 **下载 JSON**（文件名按目标格式为 `智绘姬角色预设.json` 或 `小白x角色提示词.json`）。

### ③ 世界书

1. 选择 **源世界书**（点 **刷新列表** 读取当前酒馆的世界书列表；首次会自动优先选中名字里带「苍玄界」的那本），然后点 **载入世界书**。
2. 载入后左侧出现 **按区块勾选**（每个 `====区块====` 一组，带全选 / 取消），右侧出现 **按势力勾选**（来自「势力概览」或名字含「势力」的条目，带选 / 消）。区块列表会过滤掉 `USER`、`用户档案`、`====` 开头的条目。
3. 也可以直接勾选单个角色，或点 **清空已选**。已选数量会实时显示在按钮上。
4. 选好 **世界书预设**（默认「全角色蓝灯精简」）后点 **开始生成（已选 N 个角色）**。同样是分批 + 重试；**中止**后可以再次点开始继续，已生成的部分会保留并拼接。
5. 生成结果出现在下方可编辑的文本框里，也可以点 **下载 txt** 存成 `<将创建的世界书名>.txt` 先看看效果。
6. 满意后点 **创建新世界书**：按钮旁会实时显示 **将创建：<名字>**。名字由预设的命名模板得到（`{源名}` 换成源世界书名、`{日期}` 换成本地日期且把 `/` 换成 `-`）。

> **永远新建，不覆盖**。重名时按预设的 `name_conflict` 处理：默认加序号后缀 ` (2)`、` (3)`…，或选择加时间戳。产物是**单条目**模式：全部生成内容汇总进一个条目，蓝灯常驻（`constant`），插入位置 `before_character_definition`，order 100，depth 4。

### ④ 预设与模板

四个子页签：**LLM 预设 / JSON 模板 / 元数据提取规则 / 世界书预设**。所有编辑即时生效并写入全局变量。

- **新建** = 以当前选中项为模板复制一份，命名为「<原名> 副本」，并把 id 自动分配为 `前缀-N`（不与现有 id 冲突）。
- 带 `builtin: true` 的内置项**不可删除**；要改内置项就先复制一份再改。
- 具体字段含义见下面的「自定义指南」。

---

## 元数据格式支持与真实局限

支持的格式（`core/meta_types.ts` 依次尝试，第一个识别成功者胜出）：

| 格式 | 识别依据 | 界面显示 |
| --- | --- | --- |
| NovelAI V4 | `Comment` 里的 JSON 含 `v4_prompt`，或 `Source` 含 v4 | NovelAI V4 |
| NovelAI V3 | `Software`/`Source`/`Title` 含 novelai，或 `Comment` JSON 含 `uc` | NovelAI V3 |
| Stable Diffusion WebUI (A1111) | 存在 `parameters` 文本块（`Negative prompt:` + `Steps: …`） | Stable Diffusion WebUI (A1111) |
| ComfyUI | 存在 `prompt` 文本块且是节点图 JSON（`CLIPTextEncode` 节点的 `inputs.text`） | ComfyUI |
| 其它 | 以上都不匹配 | 未识别到元数据 |

解析层做了两件事让同一套提取规则能跨格式复用：

- NovelAI 会**扁平化** `v4_prompt.caption.char_captions[*].char_caption` 成 `char_captions` 数组，并归一化 `params`；A1111 / ComfyUI 的正向词都会写进 `prompt`，负向词同时写进 `uc` 与 `negative_prompt`。
- 原始 PNG 文本块始终保留在 `chunks` 里，可用 `chunk:` 前缀直接取（例如 `chunk:Description`、`chunk:Source`）。

### 真实局限（重要）

- **图床二次压缩可能把元数据整体剥离**。仓库里有真实样本：某张 postimg 立绘图（角色「江念」）解析出 **0 个文本块**，界面会显示「无元数据」，提取器把所有字段标为「未命中」并提示手动上传，而不是报错。同一图床的多数图仍然完好（另一张 NovelAI V4 的立绘可正常解析出 `char_caption` 与 `prompt`）——所以这是**个别图片**的问题，不是图床策略。
- 因此在图库上看到「无元数据 / 跨域被拦截」时，正确做法不是反复重试，而是**点该行「上传」选本地原图**：本地文件读取 + 本地解析不经过网络，也绕开 CORS，只要原图还带元数据就一定成功。
- 若原图本身就被导出工具清除了元数据，任何工具都救不回来 —— 界面不会编造内容，只会把字段标为未命中。

---

## 自定义指南

### 元数据提取规则（决定「从图片里取哪些字段」）

| 字段 | 含义 |
| --- | --- |
| 名称 | 下拉框中显示的名字 |
| 字段渲染模板 `field_template` | 单个字段怎么渲染，占位符 `{{label}}` 与 `{{value}}`；默认渲染成两行「【`{{label}}`】」换行「`{{value}}`」 |
| 整体前缀 `header` / 整体后缀 `footer` | 拼在整段文本最前 / 最后（空串则不加） |
| 提取字段 | 每项有显示名 `label`、是否启用 `enabled`、候选路径 `paths` |

**候选路径语法**（每行一条，**按顺序取第一个非空命中**）：

| 写法 | 含义 | 例子 |
| --- | --- | --- |
| `json:<路径>` | 在归一化文档里取值 | `json:char_captions` |
| `chunk:<关键字>` | 取 PNG 原始文本块的正文 | `chunk:Description`、`chunk:Source` |
| `a.b.c` | 逐层取属性 | `json:v4_prompt.caption.base_caption` |
| `a[0].b` | 取数组下标 | — |
| `a[*].b` | 通配：收集数组每一项的 `b`，多项时用 `", "` 连接 | `json:v4_prompt.caption.char_captions[*].char_caption` |

未命中的字段会被记入 `missing`，界面上显示成「未命中：…」，方便你判断是不是规则写错或图片确实缺元数据。

**内置默认规则**（id `builtin-default`，名称「默认（char_caption + prompt）」）：

| 字段 | 启用 | 候选路径 |
| --- | --- | --- |
| 角色DNA（char_caption） | ✅ | `json:char_captions` / `json:v4_prompt.caption.char_captions[*].char_caption` / `json:texts` |
| 完整提示词（prompt） | ✅ | `json:prompt` / `chunk:Description` |
| 负向提示词（uc） | ✅ | `json:uc` / `json:negative_prompt` / `json:v4_negative_prompt.caption.base_caption` |
| 场景与画风（base_caption） | ❌（默认关闭） | `json:v4_prompt.caption.base_caption` |
| 生图参数（params） | ❌（默认关闭） | `json:params` / `chunk:Source` |

> 默认只把 `char_caption` 与 `prompt` 送进提示词；`base_caption` 与 `params` 默认关闭，因为场景 / 构图 / 光影 / 画风词不属于「角色本身」，混进去会污染角色预设。

### JSON 模板（决定「产出什么结构」）

| 字段 | 含义 |
| --- | --- |
| 名称 | 模板库里的显示名 |
| 目标格式 `target` | `zhihatsuki`（智绘姬）/ `xiaobaix`（小白x）/ `custom`（自定义）。打包目标优先取它（非 custom 时） |
| 合并方式 `merge_mode` | `object_map` 对象表合并 / `array_push` 数组追加 / `custom` |
| 角色键前缀 `key_prefix` | 智绘姬角色键的前缀，默认 `[苍玄界]` |
| 格式说明 `schema_note` | **写给 LLM 的格式要求**，会以「===== 输出格式要求 =====」整段拼进 user 输入 |
| JSON 骨架 `skeleton` | 供 LLM 照抄结构的骨架 JSON（**不是** JSON Schema），以「===== JSON 模板（严格照此结构）=====」拼进输入 |
| JSON Schema `json_schema_text` | 可选。**与骨架完全无关**：只有预设勾选「把模板里的 JSON Schema 交给酒馆做强制结构化输出」且这段文本能 `JSON.parse` 时，才作为 `json_schema` 传给酒馆；解析失败会静默降级为不传，不会崩溃 |

### LLM 预设（决定「怎么让模型干活」）

| 字段 | 含义 |
| --- | --- |
| 名称 / 目标格式 | 显示名；打包目标（当模板的 `target` 为 `custom` 时用它） |
| 冲突处理 `conflict` | `overwrite` 覆盖同名 / `skip` 跳过同名 / `rename` 保留双方（改名） |
| 批大小 `batch_size` | 每次请求塞几个角色，1–20，内置预设分别用 4 与 6 |
| 温度 `temperature` | 0–2，内置预设用 0.3 |
| 重试次数 `max_retries` | 0–5，同批失败重复请求的上限 |
| 模板挂载 `template_mode` | `reference` 引用模板库里的模板 / `embedded` 使用本预设内的 `embedded_template` |
| 引用的模板 `template_id` | `reference` 模式下用哪张模板 |
| 元数据规则 `meta_extract_rule_id` | 本预设偏好的提取规则（兜底用；实际解析以「② 打包导出」页的下拉为准） |
| 强制结构化输出 `use_json_schema` | 勾选后把模板的 `json_schema_text` 交给酒馆 |
| 系统提示词 `system_prompt` | 作为 `system` 消息 |
| 转换指令 `instruction` | 提示词的**核心**，拼在 user 输入最前面 |
| 参考示例 `few_shot` | 可选，以「===== 参考示例 =====」拼进输入 |
| 从回复中提取 JSON `reply_extract` | 见下表 |

**`reply_extract` 的四种提取方式**（决定「怎么从 LLM 回复里取出 JSON」）：

| 方式 | 语义 |
| --- | --- |
| `fenced` 代码块围栏 | 先找「三反引号 + 标记名」的围栏代码块，再找任意围栏代码块，最后退化为「找第一段配平 JSON」 |
| `labeled_brace` 标记名 + 花括号 | 定位「标记名」（兼容英文引号、`「」`、全角冒号），从其后第一个 `{` 或 `[` 开始配平；找不到标记名会退化为找第一段配平 JSON |
| `regex` 自定义正则 | 用你填的正则匹配，取**第 1 个捕获组**（没有捕获组则取整个匹配）。正则需要考虑换行：内部以 `s` 标志执行 |
| `whole` 整段即 JSON | 整段回复 trim 后直接当 JSON |

配套字段：

- **标记名** `label`：`fenced` 与 `labeled_brace` 用它匹配（默认 `JSON`）。
- **JSON 路径** `json_path`：可选。解析出 JSON 后再按路径取子节点；取不到时保留原值。路径语法同元数据路径（点号、`[0]`、`[*]`）。

解析容错：先严格 `JSON.parse`，失败再用 `jsonrepair` 修一次（尾逗号、单引号、缺括号等常见问题），仍失败才计为失败并进入重试。

> 数据模型里 `reply_extract` 的默认值是 `label: 'JSON'` + `mode: 'labeled_brace'`；内置预设没有显式覆盖它，靠 `labeled_brace` 的兜底逻辑（退化到找第一段配平 JSON）工作。若你的模型习惯把 JSON 包在围栏代码块里输出，手动改成 `fenced` 更稳。

### 世界书预设

| 字段 | 含义 |
| --- | --- |
| 名称 | 显示名 |
| 世界书命名模板 | 可用 `{源名}`（源世界书名）与 `{日期}`（本地日期，`/` → `-`），默认 `{源名} · 全角色蓝灯精简` |
| 条目名模板 | 单条目模式下新条目的 comment，默认「全角色蓝灯精简」 |
| 重名处理 `name_conflict` | `suffix` 加序号后缀 / `timestamp` 加毫秒时间戳 |
| 产出形态 `output_mode` | `text` 直接把回复当正文；`json` 先按 `reply_extract` 抽 JSON，再按 `output_json_path`（或字符串 / 数组 / 对象第一个字符串值）取出正文 |
| 批大小 / 温度 | 1–30 / 0–2，内置预设为 6 / 0.4 |
| 新条目的默认属性 | 激活策略（`constant` 蓝灯常驻 / `selective` 绿灯关键词）、插入位置 `position_type`、`order`、`depth`、触发词（每行一个，留空即纯蓝灯） |
| 系统提示词 / 生成指令 / 字段·行格式规范 / 容错说明 / 参考示例 | 依次拼进 user 输入，其中「容错说明」紧跟在参考示例之后 |
| 从回复中提取 JSON `reply_extract` | 含义同 LLM 预设，仅 `output_mode: json` 时使用 |

> 数据模型里还留着 `entry_mode`（`single` / `grouped` / `auto`）、`final_pass`、`output_json_path` 等字段；**当前实现只做了单条目模式**，界面也未暴露 `output_json_path` / `final_pass` 的输入框。

---

## 两个内置预设的差异

| | 智绘姬（st-chatu8） | 小白x（novel-draw-characters v3） |
| --- | --- | --- |
| 模板 id / 预设 id | `tpl-zhihatsuki` / `preset-zhihatsuki` | `tpl-xiaobaix` / `preset-xiaobaix` |
| 目标格式 | `zhihatsuki` | `xiaobaix` |
| 合并方式 | `object_map`（对象表合并） | `array_push`（数组追加） |
| characters 形态 | 对象表，键为 `[苍玄界]<中文名>` | 扁平数组 |
| 外观字段 | **按部位拆成六个**：`facialFeatures` / `facialFeaturesBack` / `upperBodySFW` / `upperBodySFWBack` / `fullBodySFW` / `fullBodySFWBack`，另有四个 NSFW 变体字段（推断不出时留空，禁止编造） | **单个** `appearance`，合并全部外观，保留权重语法与**末尾逗号** |
| 服装 | `outfits` 是**独立对象表**，通过 `owner`（角色的 `nameEN`，小写拼音）关联；角色里只放服装键名数组 | `outfits` **内联数组**，每项 `{ name, tags }` |
| 角色 id | 无（以键名标识） | **必填**：`id` 为空或重复时脚本生成 `char-<时间戳>-<随机串>`（一次只生成 4 位随机串） |
| 额外字段 | `nameCN` / `nameEN` / `characterTraits` / `negative` / `mediaSchemaVersion: 2` 等 | 顶层 `type: 'novel-draw-characters'` + `version: 3`；角色含 `aliases` / `type` / `negativeTags` / `danbooruTag` |
| 内置批大小 / 温度 | 4 / 0.3 | 6 / 0.3 |
| 内置模板 key_prefix | `[苍玄界]` | `[苍玄界]` |

**冲突策略的实际行为**：

| 策略 | 智绘姬 | 小白x |
| --- | --- | --- |
| `overwrite` 覆盖 | 同名键整体替换 | 替换内容但**保留原有 id**，避免破坏插件引用关系 |
| `skip` 跳过 | 跳过该角色；同名服装也跳过并记一条 warning | 跳过该角色 |
| `rename` 改名 | 键改成 `[苍玄界]名字(2)`（递增到不冲突） | 角色名改成 `名字(2)` 并**追加**为新条目 |

两个适配器都做了容错：LLM 产出成 `{characters: {...}}`、`{characters: [...]}`、直接数组或直接对象表都能归一化；结构不对只会记 warning 或跳过，不会抛异常。智绘姬的服装键会自动补上前缀。

---

## 开发

| 命令 | 作用 | 当前实测状态 |
| --- | --- | --- |
| `pnpm install` | 安装依赖 | — |
| `pnpm test` | `node --test "tests/**/*.test.ts"` | ✅ 撰写本文档时实测 `tests 133 / pass 133 / fail 0`，退出码 0（13 个测试文件，全部在 `tests/苍玄界立绘工坊/`；该目录仍在扩充，具体条数以实际输出为准） |
| `pnpm typecheck` | `tsc --noEmit` | ⚠️ 有 5 条**既有**报错，全都不在本项目代码里：`@types/function/worldbook.d.ts`(1) 与 `node_modules/@vueuse/core` 类型声明(4)。`src/苍玄界立绘工坊/` 自身 **0 报错** |
| `pnpm lint` | `eslint` | ✅ `npx eslint "src/苍玄界立绘工坊/**/*.{ts,vue}"` 退出码 0、无输出 |
| `pnpm build:dev` | webpack 开发构建 | 产物 `dist/苍玄界立绘工坊/index.html`（单文件；仓库中现有产物为 1,407,612 字节） |
| `pnpm build` | webpack 生产构建（压缩 + 混淆） | 同上路径 |
| `pnpm watch` | 开发监听（6621 端口 + schema dump + tavern_sync） | — |

只跑本目录的测试：

```bash
node --test "tests/苍玄界立绘工坊/*.test.ts"
```

> 注意：`node --test` 要传 **glob**，直接传目录会报 `Cannot find module`。Node 打印的 `MODULE_TYPELESS_PACKAGE_JSON` 警告是正常的（测试文件用 ESM 语法但 package.json 没有 `"type": "module"`），可忽略。

### 项目约定

- 相对导入**必须带 `.ts` 扩展名**（如 `import { getByPath } from './json_util.ts'`），这是 `node --test` 能直接跑 TS 的前提。
- `tsconfig` 开启 `strict` + `noUnusedLocals` + `noUnusedParameters`。
- `core/` 与 `llm/engine.ts` 保持**纯逻辑**：不直接调用酒馆全局（`generateRaw` / `getWorldbook` 等由 `stores/workshop.ts` 注入），因此才能离线单测。生成函数是注入式的 `GenerateFn`，测试里注入假实现即可验证分批、重试、断点、合并，不用烧 token。

---

## 常见问题

**Q：解析时提示「跨域被拦截」怎么办？**
图床不允许浏览器跨域读取。三条路：① 点该行 **上传** 选本地 PNG（最稳，不经过网络）；② 换一个允许 CORS 的图床直链；③ 在设置项 `proxy_prefix` 里填一个代理前缀（该设置存在于数据模型 `settings.proxy_prefix`，默认空 = 直连；**当前界面没有暴露输入框**，需要自行写入全局变量 `cx_portrait_workshop_v1`）。失败时 `fetch` 只抛 `TypeError`，界面据此归类为跨域。

**Q：提示「无元数据」怎么办？**
说明图片里没有 PNG 文本块（常见于图床二次压缩，仓库里有 0 个文本块的真实样本）。用 **上传** 选本地原图；如果原图也没有，那就是源文件本身丢了元数据。

**Q：世界书重名了会覆盖吗？**
**永远不会覆盖。** 创建时先算名字，若已被占用则加 ` (2)`、` (3)`… 直到可用（预设的 `name_conflict` 选 `timestamp` 时改为追加 ` · <毫秒时间戳>`）。新世界书是独立的，源世界书不受任何影响。

**Q：内置预设 / 模板删不掉？**
`builtin: true` 的项禁止删除。点 **新建** 复制一份再改，副本可以删。

**Q：点了「开始打包」但提示没有可处理的角色？**
打包只处理「在①里勾选 **且** 提取文本非空」的行。请先确认解析状态是「解析成功」或「手动上传」。

**Q：改了预设里的「元数据规则」，为什么解析结果没变？**
实际解析用的是「② 打包导出」页的 **元数据提取规则** 下拉（初始为内置默认规则）；预设里的 `meta_extract_rule_id` 只在界面选择为空时兜底。要换规则，请改②页的下拉。

**Q：导入的既有文件为什么过一会儿就没了？**
「导入既有插件文件」得到的基底只存在内存里（不写入全局变量），刷新界面 / 重开面板后需重新导入。

**Q：LLM 返回的 JSON 被包在围栏代码块里、或前后带了多余文字，能处理吗？**
能。四种 `reply_extract` 方式 + `jsonrepair` 修复 + 跨批重试 + 整批失败后逐角色降级，都是为了这个场景。实在解析不了的角色只会被列进失败清单，不影响其它角色。

**Q：会把我自己的酒馆预设 / 角色卡弄坏吗？**
不会。调用生成时用的是 `generateRaw` + `ordered_prompts`（system + user 两条），**不携带当前酒馆预设**，提示词完全由本界面里的预设决定；世界书也只做新建，不修改源世界书。
