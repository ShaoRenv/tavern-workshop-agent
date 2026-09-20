# task-3 报告：补强测试（多格式解析与边界）

## 结论
- 新增 6 个测试文件、**116 个用例**；全量 **216 通过 / 0 失败**（原有 100 + 新增 116）。
- 只写 `tests/苍玄界立绘工坊/`，**未改动 src/**。
- 验收命令：`node --test 'tests/苍玄界立绘工坊/*.test.ts'` → tests 216, pass 216, fail 0, duration ~1.05s。

## 新增文件与覆盖范围

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `a1111_parser.test.ts` | 16 | 正向 + `Negative prompt:` + 参数行；参数键归一化/数值转换（含负数）；多行负向；缺负向/缺参数行/空文本/只有参数行；CRLF；行首锚定；`extractEmbeddedJson`；与 buildImageMeta + 默认规则的复用 |
| `comfyui_parser.test.ts` | 17 | 含 CLIPTextEncode 的节点图取正向/负向；prompt + workflow 双块；节点号升序遍历；class_type 变体与容错；无文本节点；非 JSON/数组/标量/缺 prompt；坏 workflow；三个文本节点的正负向选择；buildImageMeta 集成 |
| `extractor_paths.test.ts` | 22 | json:/chunk: 前缀与非法前缀；候选路径回落（未命中/空白/空串）；`[*]` 多 char_caption 拼接与单元素；显式下标；全部未命中时 text/missing；禁用字段；0/false 命中；header/field_template/footer 渲染与去空白；值内占位符不被二次替换；默认规则路径断言与 base_caption 回落 |
| `png_chunks.test.ts` | 18 | 手工构造字节流的 tEXt / zTXt(zlib) / iTXt(压缩与未压缩、langTag/translatedKeyword)；未知块忽略；IEND 后不解析；同名块首优先；非 ASCII 关键字；任意 CRC；缺 NUL；坏压缩数据；长度越界；截断；zTXt parameters → A1111 端到端；压缩 iTXt prompt → ComfyUI 端到端 |
| `merge_edge.test.ts` | 24 | 智绘姬数组/对象表/顶层对象表入参；自定义 key_prefix（角色 + 服装键）；outfits 数组形态；rename/skip 下 outfits 与角色的策略独立性；小白x 对象表/顶层数组；缺 name 与非对象条目 warning；id 生成与冲突重生成；rename 递增；同名条目单次调用；顶层字段保留；非对象 existing；nextAvailableKey 上限回退 |
| `worldbook_edge.test.ts` | 19 | 嵌套区块、错位结束、EOF 强制收尾、标题去空白；空标题分隔符；带 `[mvu_plot]` 后缀分隔条目；势力跨分类同名；全角冒号/逗号/顿号；区域概览空字段；标题含「角色」的多个区块；同名去重与来源优先级；多义「势力概览」条目取第一个；精简名单关联条目 |

## 发现的 src 潜在问题（按严重度）

### P1 智绘姬传入数组时角色名丢失为下标（merge.ts:116）
```ts
const name = zhihatsukiDisplayName(keyHint, key_prefix) || String(value.nameCN ?? '').trim();
```
数组入参时 `keyHint = String(index)`（"0"/"1"，恒为真值），`||` 右侧的 nameCN 回退永远不执行。
复现：
```ts
mergeCharacterDocuments(createEmptyDocument('zhihatsuki'),
  { characters: [{ name: '甲' }, { nameCN: '乙' }] },
  { target: 'zhihatsuki', conflict: 'overwrite' });
// 实际：characters 键 = ['[苍玄界]0','[苍玄界]1']，added = ['0','1']
// 期望：['[苍玄界]甲','[苍玄界]乙']
```
建议：keyHint 为纯数字下标时改用 `value.nameCN ?? value.name`。
对应测试：`merge_edge.test.ts` 第 1 个用例（特征化，修后需同步更新）。

### P2 ComfyUI 的 char_caption 会混入负向提示词（comfyui_parser.ts:28/35 + extractor.ts:120）
`parseComfyUiMeta` 把**全部** CLIPTextEncode 文本写进 `document.texts`（含负向），而默认规则 `char_caption` 的第三候选路径是 `json:texts`（extractor.ts:120），于是角色 DNA 变成 "正向, 负向"。
复现：用默认规则提取 ComfyUI 元数据 → `char_caption = 'masterpiece, 1girl, silver hair, lowres, bad hands'`。
建议：comfyui 另存 `positive_texts`，或默认规则改指向只含正向的字段。
对应测试：`comfyui_parser.test.ts` 最后一个用例（特征化）。

### P3 id 生成在随机源恒定时死循环（merge.ts:228）
```ts
while (protectedIds.has(String(value.id))) value.id = createXiaobaixId(now, random);
```
无重试上限。若调用方注入的 `now()`/`random()` 恒定（或极端碰撞），循环永不退出 → 界面卡死。
复现（已实测挂起）：`mergeCharacterDocuments({characters:[]}, {characters:[{name:'甲'},{name:'甲'}]}, {target:'xiaobaix', conflict:'rename', now:()=>1, random:()=>'q'})` —— 打印 "start" 后永久卡住，6s 超时被杀。
生产环境 `Math.random()` 每次都变，实际风险低；但建议加迭代上限（如 100 次后回退到序号/时间戳后缀）。
对应测试：`merge_edge.test.ts` 统一使用递增随机串规避，未写挂起用例。

### P4 CLIPTextEncodeSDXL 取不到文本（comfyui_parser.ts:51）
`const text = inputs.text;` 只认 `inputs.text`；SDXL 双文本节点用 `text_g`/`text_l`，导致 `texts = []`，界面会提示无可用文本。
复现：`parseComfyUiMeta({ prompt: JSON.stringify({ '6': { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'g', text_l: 'l' } } }) })` → `texts: []`。
建议：`text ?? text_g ?? text_l` 依次取。

### P5 A1111 的 `Negative prompt:` 区分大小写（a1111_parser.ts:42）
小写 `negative prompt:` 会被当成正向提示词的一部分（实测 `uc === ''`，正文含该行）。官方写出恒为首字母大写，属低风险；若想更稳可改不区分大小写。

### P6 A1111 无空格参数行退化（a1111_parser.ts:73）
`Steps:20,Sampler:Euler a,Seed:1` 这类无空格格式只解析出 `{ steps: '20,Sampler:Euler a,Seed:1' }`。A1111 官方恒为 `", "` 分隔，低风险。

### P7 空标题分隔条目被当成普通条目（worldbook_source.ts:80）
`========_开始` 因标题为空被 `parseSectionMarker` 判为 null，随后进入 `buildCharacterIndex` / 候选列表。低风险（真实世界书不存在该形态），但会污染候选名列表。

### P8 角色设定内嵌子区块的条目漏出候选（worldbook_source.ts:325）
`if (!section.title.includes('角色')) continue;` 使嵌套在「角色设定」内、但标题不含「角色」的子区块（如「内嵌」）里的角色全部漏掉。低风险（真实世界书未嵌套），若以后允许嵌套需改成按包含关系汇总。

## 与缺陷绑定的「特征化测试」清单
若 Lead 决定修 src，以下 6 个用例会失败，需同步改为期望的正确行为：
1. `merge_edge.test.ts` — 智绘姬：characters 传数组时当前以数组下标当角色名（P1）
2. `comfyui_parser.test.ts` — CLIPTextEncodeSDXL 的 text_g / text_l 当前取不到（P4）
3. `comfyui_parser.test.ts` — 默认提取规则 char_caption 会把负向一并拼入（P2）
4. `a1111_parser.test.ts` — 小写 negative prompt: 不被识别（P5）
5. `worldbook_edge.test.ts` — 没有标题的分隔条目不被识别（P7）
6. `worldbook_edge.test.ts` — 角色设定内嵌子区块的条目不会成为候选（P8）
