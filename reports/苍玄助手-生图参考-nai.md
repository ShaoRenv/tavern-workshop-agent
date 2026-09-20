# 苍玄助手 (st-chatu8) NovelAI 生图调用调研

调研对象：`D:\dsh\deliver\st-chatu8-perf\index.js`（约 5 MB、110911 行的打包产物，下文 `L####` 均为该文件 1-based 行号）、`html/settings/novelai.html`、`manifest.json`。
结论全部来自代码直读；代码中不存在的写法一律写 **NOT FOUND**。

## 1 接口与端点

只有两个 NovelAI 图像端点被调用，全部为 **POST**。

### 1.1 主生图：`/ai/generate-image`

```js
// L83234
let urlObj = new URL("https://image.novelai.net/ai/generate-image");
// L83241-83247（"其他站点"分支）
let otherSite = normalizeNovelAIOtherSiteUrl(extension_settings61[extensionName].novelaiOtherSite);
urlObj = otherSite.includes("generate-image") ? new URL(otherSite) : new URL(`${otherSite}/ai/generate-image`);
```

实际请求（浏览器直连分支，L83382，失败 1 秒后原样重试一次 L83387）：

```js
response = await fetch(urlObj.href, { method: "POST", headers: getDirectHeaders3("application/json", Authorization), body: JSON.stringify(data11), signal: currentAbortController2?.signal });
```

同一 URL 在**局部重绘 (infill)** 中复用（L83653、L83662），请求体不同（见 §2.6）。

### 1.2 Vibe 编码：`/ai/encode-vibe`（L90336）

```js
let encodeVibeUrl = "https://image.novelai.net/ai/encode-vibe";                                  // L90336
encodeVibeUrl = otherSite.includes("encode-vibe") ? otherSite : `${otherSite}/ai/encode-vibe`;  // L90345
const response = await fetch(encodeVibeUrl, {                                                     // L90348
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },          // L90350-90353
  body: JSON.stringify(payload)
});
```

### 1.3 未出现的端点

对 `/ai/` 全量 grep 仅 6 处命中（L83234/83247/83653/83662/90336/90345）：

- `/ai/generate-image-stream`：**NOT FOUND**（grep `generate-image-stream` = 0 处）
- `/ai/upscale`：**NOT FOUND**（0 处）
- `/ai/augment-image`：**NOT FOUND**（0 处）
- "流式"仅由请求体字段 `"stream": "msgpack"` 表达（L82985、L83075、L83117），不是独立端点。

### 1.4 酒馆（SillyTavern）后端路由

`client == "jiuguan"` 时不直连 NovelAI，改调 ST 自身路由（L83323）：

```js
const result = await fetch("/api/novelai/generate-image", { method: "POST", headers: getRequestHeaders(window.token), body: JSON.stringify(tavernAIPayload), signal: currentAbortController2?.signal });
```

## 2 请求体结构

### 2.1 顶层（浏览器直连，L83349）

```js
data11 = { "input": prompt2, "model": extension_settings61[extensionName].novelaimode, "action": "generate", "parameters": payload, "use_new_shared_trial": true };
```

顶层字段共 5 个：`input`(正面提示词字符串)、`model`、`action`(="generate")、`parameters`(对象)、`use_new_shared_trial`(=true)。
可选第 6 个 `recaptcha_token`（L83351），但 `recaptcha_token` 恒为 `""`（L83348）故该分支不生效；且该分支会把 `Authorization` 换成 `"Bearer " + recaptcha_token.token`（L83352）。

### 2.2 parameters：NAI3 / 通用基线（L82959-82996）

| 字段 | 值 / 来源 | 行号 |
|---|---|---|
| `params_version` | `model.includes("nai-diffusion-5") ? 4 : 3`（同对象内重复定义两次） | L82960、L82986 |
| `width` | `Number(Xwidth ? Xwidth : novelai_width)` | L82961 |
| `height` | `Number(Xheight ? Xheight : novelai_height)` | L82962 |
| `scale` | `Number(nai3Scale)`（Prompt Guidance） | L82963 |
| `sampler` | `novelai_sampler` | L82965 |
| `steps` | `Number(novelai_steps)` | L82967 |
| `n_samples` | `1` | L82969 |
| `ucPreset` | `3` | L82970 |
| `qualityToggle` | `true` | L82972 |
| `sm` | `sm === "false" ? false : true` | L82973 |
| `sm_dyn` | `dyn === "false" \|\| sm === "false" ? false : true` | L82974 |
| `dynamic_thresholding` | `nai3Deceisp === "false" ? false : true` | L82975 |
| `controlnet_strength` | `1` | L82976 |
| `legacy` / `legacy_uc` / `legacy_v3_extend` | `false` | L82977-82978、L82984 |
| `add_original_image` | `true` | L82979 |
| `cfg_rescale` | `Number(cfg_rescale)` | L82980 |
| `noise_schedule` | `Schedule` | L82982 |
| `skip_cfg_above_sigma` | `nai3Variety === "false" ? null : 19`（随后被 §2.5 重算） | L82983 |
| `stream` | `"msgpack"` | L82985 |
| `seed` | seed 为 `"0"`/`""`/`"-1"` → `generateRandomSeed()`，否则 `Number(novelai_seed)` | L82987 |
| `negative_prompt` | `negative_prompt` | L82989 |
| `reference_image_multiple` | `[]` | L82990 |
| `reference_information_extracted_multiple` | `[]` | L82991 |
| `reference_strength_multiple` | `[]` | L82992 |
| `reference_image_multiple_cached` | `[]` | L82993 |
| `normalize_reference_strength_multiple` | `normalizeRefStrength === "true"` | L82994 |
| `use_coords` | `use_coords` | L82995 |

NAI5 追加字段（L82997-83006）：`tag_hint_uc_preset`(0/1/2/3/4 由 `UCP_novelai` 映射)、`tag_hint_qt`(=`1`)、`straight_alpha`(bool)。

> ⚠️ 实证缺陷：这三项随后被整体重新赋值抹掉——L83033 用 `{ ...preset_data, characterPrompts, v4_prompt, v4_negative_prompt, ... }` 重建，L83040 与 L83081 又用**不含这三个键的字面量**整体重建 `preset_data`。故 **v5 的 `tag_hint_uc_preset`/`tag_hint_qt`/`straight_alpha` 不会出现在实际 body 中**（`JSON.stringify` 丢弃 `undefined`）。另外默认值 `UCP_novelai: "Heavy"`（L2699）与判定用的小写 `"heavy"`（L82933）不相等，`ucPresetInt` 恒为 0。

### 2.3 parameters：NAI4 / 4.5（非分角色分支，L83081-83133）

同名字面量 30 项：`autoSmea:false`(L83082)、`normalize_reference_strength_multiple`(L83083)、`inpaintImg2ImgStrength:1`(L83084)、`params_version`(L83085，同 §2.2 规则)、`width``height``scale``sampler``steps`(L83086-83092)、`n_samples:1`(L83094)、`ucPreset:3`(L83095)、`qualityToggle:false`(L83097，**与 NAI3 分支相反**)、`dynamic_thresholding:false`(L83098)、`controlnet_strength:1`(L83099)、`legacy:false`/`legacy_uc:false`(L83100-83101)、`add_original_image:true`(L83102)、`cfg_rescale`(L83103)、`noise_schedule`(L83105)、`skip_cfg_above_sigma`(L83106，默认 `19.343056794463642`)、`legacy_v3_extend:false`(L83107)、`seed`(L83108)、`negative_prompt`(L83110)、四个参考数组(空，L83111-83114)、`use_coords`(L83115)、`characterPrompts: []`(L83116)、`stream:"msgpack"`(L83117)、`v4_prompt`(L83118-83125)、`v4_negative_prompt`(L83126-83132)。

```js
"v4_prompt": { "caption": { "base_caption": prompt2, "char_captions": [] }, "use_coords": use_coords, "use_order": true },              // L83118-83125
"v4_negative_prompt": { "caption": { "base_caption": negative_prompt, "char_captions": [] }, legacy_uc: false }                        // L83126-83132
```

分角色分支字面量在 L83040-83079，差异：`skip_cfg_above_sigma` 按模型覆写——`nai-diffusion-4-full` → `19`（L83035），4.5 curated/full → `59.04722600415217`（L83038）。

### 2.4 sampler 补丁与 skip_cfg 重算（L83136-83142）

```js
if (novelai_sampler == "k_euler_ancestral") { preset_data["deliberate_euler_ancestral_bug"] = false; preset_data["prefer_brownian"] = true; }   // L83136-83139
if (nai3Variety != "false") { preset_data["skip_cfg_above_sigma"] = calculateSkipCfgAboveSigma(preset_data.width, preset_data.height, novelaimode); } // L83140-83142
```

`calculateSkipCfgAboveSigma`（L9500-9509）= `Math.pow(width*height / REFERENCE_PIXEL_COUNT, 0.5) * magicConstant`；`REFERENCE_PIXEL_COUNT = 1011712`（L10642）、`SIGMA_MAGIC_NUMBER = 19`（L10643）、4.5 用 `SIGMA_MAGIC_NUMBER_V4_5 = 58`（L10644，选择逻辑 L9502）。

### 2.5 各模型版本字段差异

| 字段 | NAI3 | NAI4 | NAI4.5 | NAI5 |
|---|---|---|---|---|
| `params_version` | 3 | 3 | 3 | 4 |
| `qualityToggle` | true (L82972) | false (L83097) | false | false |
| `sm` / `sm_dyn` | 有 (L82973-82974) | 无 | 无 | 无 |
| `dynamic_thresholding` | 依 Decrisp (L82975) | false (L83098) | false | false |
| `v4_prompt`/`v4_negative_prompt`/`characterPrompts` | 无 | 有 (L83076-83078) | 有 | 有（入口条件 L83007 为 `model !== "nai-diffusion-3"`） |
| `deliberate_euler_ancestral_bug`/`prefer_brownian` | 仅 sampler 为 k_euler_ancestral 时 (L83136-83139) | 同 | 同 | 同 |
| `tag_hint_uc_preset`/`tag_hint_qt`/`straight_alpha` | 无 | 无 | 无 | 代码有设但被覆盖丢失（L83003-83005 vs L83081） |

清理 `cleanNovelAIPayload`（L82326-82358）：NAI3 删 `reference_image_multiple_cached` 及全部 `director_reference_*`（L82330-82337）；NAI4/4.5 删 `reference_image_multiple`、`reference_information_extracted_multiple`（L82338-82341）；NAI5 额外删 `skip_cfg_above_sigma`、删除空参考数组，并把 `ddim_v3` 改写为 `k_euler_ancestral`（L82342-82355）。校验 `validateNovelAIPayload` 要求 `width/height/scale/sampler/steps/seed` 均非 null（L82360-82365）。

### 2.6 局部重绘（infill）请求体（L83557-83615）

顶层 `action:"infill"` / `input` / `model`（**硬编码** `"nai-diffusion-4-5-curated-inpainting"`，L83560）/ `parameters`。
parameters 含：`width``height``scale``sampler``steps``seed`、`n_samples:1`、`image`(原图纯 base64，L83541)、`mask`(L83542)、`params_version`(L83571，v5→4 否则 3)、`prefer_brownian:true`、`autoSmea:false`、`strength:0.7`、`noise:0`、`extra_noise_seed`、`add_original_image:false`、`cfg_rescale:0`、`controlnet_strength:1`、`deliberate_euler_ancestral_bug:false`、`dynamic_thresholding:false`、`legacy/legacy_uc/legacy_v3_extend:false`、`normalize_reference_strength_multiple`、`noise_schedule`、`qualityToggle:true`、`skip_cfg_above_sigma:19`、`ucPreset:0`、`use_coords:false`、`image_format:"png"`、`img2img:{strength, color_correct:true}`、`inpaintImg2ImgStrength`、`v4_prompt`、`v4_negative_prompt`（`char_captions: []`，L83598-83613）。

### 2.7 酒馆后端路线的**扁平** body（L83315-83321）

```js
const tavernAIPayload = { prompt: prompt2, model: ..., sampler: ..., scheduler: ..., steps: ..., scale: ..., width: ..., height: ..., negative_prompt: ..., decrisper: preset_data.dynamic_thresholding, variety_boost: preset_data.skip_cfg_above_sigma, sm: ..., sm_dyn: ..., seed: ... };
if (novelaimode.includes("nai-diffusion-5")) { tavernAIPayload.tag_hint_uc_preset = ...; tavernAIPayload.tag_hint_qt = ...; tavernAIPayload.straight_alpha = ...; tavernAIPayload.use_new_shared_trial = true; }
```

## 3 参考图字段

### 3.1 NAI3 单 Vibe（`applySingleVibeTransfer`，L82408-82433）

```js
preset_data.reference_image_multiple.push(processedImage);                  // L82424
preset_data.reference_information_extracted_multiple.push(infoExtracted);   // L82425
preset_data.reference_strength_multiple.push(strength);                     // L82426
```

三数组必须等长（校验 L82366-82378）。`processedImage` 为**纯 base64（无 `data:` 前缀）**，由 `processReferenceImage` 产出（L9445-9499）：按宽高比吸附到 1024x1536 / 1472x1472 / 1536x1024（L9454-9461），移动端输出 `image/jpeg` q=0.3、桌面端 `image/png`，并 `.replace(/^data:image\/png;base64,/, "")` 去前缀（L9480-9484）。

### 3.2 NAI4/4.5 Vibe 组（`applyVibeGroupTransfer`，L82479-82621）

```js
preset_data.reference_image_multiple_cached.push({ cache_secret_key: cacheSecretKey, data: vibeData.data }); // L82607-82610
preset_data.reference_strength_multiple.push(normalizedStrength[i]);                                        // L82611
```

`cache_secret_key` 为随机 UUID（`generateRandomUUID()`，L82443-82452，优先 `crypto.randomUUID()`）。`data` 来自预先用 `/ai/encode-vibe` 生成的 .naiv4vibe 编码（见 §6.5）。强度：`normalizeRefStrength === "true"` 且模型为 4.5 → 原值（L82588-82591）；否则总和 > 1 时按比例归一（L82592-82598）；否则原值（L82599-82602）。

### 3.3 角色参考（仅 NAI4.5，`applyCharacterReferenceGroup`，L82622-82718）

入口条件 L83152（`nai3CharRef === "true" && isNAI45 && isBrowserClient`）。五个并行数组：

```js
preset_data.director_reference_images_cached.push({ cache_secret_key: cacheSecretKey, data: processedImage });                                        // L82669-82672
preset_data.director_reference_descriptions.push({ caption: { base_caption: baseCaption, char_captions: [] }, legacy_uc: false });                    // L82679-82685
preset_data.director_reference_information_extracted.push(1);                                                                                          // L82686
preset_data.director_reference_strength_values.push(ref.strength);                                                                                     // L82687
preset_data.director_reference_secondary_strength_values.push(1 - ref.strength);                                                                       // L82688
```

`base_caption` 取值（L82673-82678）：默认 `"character"`；`ref.type === "character_style"` → `"character&style"`；`"style"` → `"style"`。数组等长校验 L82391-82405。

### 3.4 v4_prompt / v4_negative_prompt / characterPrompts（分角色模式，L83015-83033）

```js
characterPrompts.push({ enabled: true, prompt: prompt_data[`Character ${i} Prompt`], center: prompt_data[`Character ${i} coordinates`], uc: prompt_data[`Character ${i} UC`] ? prompt_data[`Character ${i} UC`] : "" }); // L83018
let v4_negative_prompt = { caption: { base_caption: negative_prompt, char_captions: [] }, legacy_uc: false };                                                  // L83021
v4_negative_prompt.caption.char_captions.push({ char_caption: <Character i UC 或 "">, centers: [prompt_data[`Character ${i} coordinates`]] });              // L83024
let v4_prompt = { caption: { base_caption: prompt2, char_captions: [] }, use_coords, use_order: true };                                                        // L83027
v4_prompt.caption.char_captions.push({ char_caption: prompt_data[`Character ${i} Prompt`], centers: [prompt_data[`Character ${i} coordinates`]] });        // L83030
preset_data = { ...preset_data, characterPrompts, v4_prompt, v4_negative_prompt, add_original_image: true, skip_cfg_above_sigma: ... };                        // L83033
```

最多 4 个角色（`for (let i = 1; i <= 4; i++)`，L83016/83022/83028）。触发条件：提示词含 `"Scene Composition"` 且模型为 4/5（L82809-82811）。

> 注意 `use_coords` 定义（L82958）：`let use_coords = !extension_settings61[extensionName].AI_use_coords == "true";`。因 `!` 优先级高于 `==`，表达式恒为 `false`，即 `use_coords` **永远输出 false**（L82841 同一写法用于清空角色坐标）。

### 3.5 未找到的字段

4.x 分支显式删除 `reference_image_multiple` / `reference_information_extracted_multiple`（L82339-82340），**不存在与 `*_cached` 同时下发的写法**；未发现 `director_reference_*` 之外的 v4.5 风格字段，也未发现 v5 专属参考字段。`normalize_reference_strength_multiple` 是唯一与参考强度归一相关的布尔字段（L82994、L83042、L83083）。

## 4 请求头与鉴权

### 4.1 直连 NovelAI（L82310-82322）

```js
function getDirectHeaders3(contentType = null, auth = null) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*"
  };
  if (contentType) { headers["Content-Type"] = contentType; }
  if (auth) { headers["Authorization"] = auth; }
  return headers;
}
```

调用处传入 `"application/json"` 与 `"Bearer " + access_token`（L83347、L83382；重绘 L83665、L83669-83674）。即：`Content-Type: application/json`、`Authorization: Bearer <key>`、`User-Agent: <Chrome 120 UA>`、`Accept: */*`。

### 4.2 encode-vibe（L90350-90353）

只发 `Content-Type: application/json` 与 `Authorization: Bearer <key>`（无 UA、无 Accept）。

### 4.3 酒馆后端路由（L10097-10102）

```js
function getRequestHeaders(token2) { return { "Content-Type": "application/json", "X-CSRF-Token": token2 }; }
```

即 `X-CSRF-Token: window.token`，**不携带 NovelAI 的 Bearer key**（L83323）。

### 4.4 API Key 格式与校验

- 读取仅 `trim()`：`let access_token = (extension_settings61[extensionName].novelaiApi || "").trim();`（L82813；重绘 L83549；Vibe 生成器 L90286）。
- 唯一硬校验是占位符 `"000000"`：`if (extension_settings61[extensionName].novelaiApi == "000000") { toastr.error("请填写 NovelAI API Key"); ... throw new Error("请填写 NovelAI API Key"); }`（L82798-82804）；重绘为 `if (!access_token || access_token === "000000")`（L83550-83552）；Vibe 为 `if (!apiKey || apiKey === "000000")`（L90287-90289）。`"000000"` 同时是设置默认值（L2687、L3198）。
- **代码中不存在 `pst-` 前缀校验（NOT FOUND）**。全文 grep `pst` 仅 4 处，全为面向 LLM 的说明文本：L63223、L63379（`- novelaiApi：NovelAI 的 API Key，格式为 "pst-xxx..."`）、L63503、L63615（`确认 novelaiApi 格式正确（pst- 开头）`）。
- 酒馆路线下密钥经 ST secrets 接口写入（L83275-83314）：`/api/secrets/read`、`/api/secrets/delete`、`/api/secrets/write`（body `{ key: "api_key_novel", value: novelaiApi, label: "插件设置的api_key_novel" }`，L83292）、`/api/secrets/rotate`（L83304）——即复用 ST 内置 NovelAI 图片源的 secret 名 `api_key_novel`。

### 4.5 错误码映射（L83411-83438）

`400` 解析 `errorJson.message`；`401` → "API Key 错误或无效，请检查 API Key。"；`402` → "需要有效订阅才能访问此端点。"；其余记录状态码与响应文本后抛出。

## 5 响应解析

### 5.1 浏览器直连：ZIP（不是 JSON/base64）

```js
const data123 = await response.arrayBuffer();   // L83440
re = await unzipFile(data123);                  // L83441
if (!re) { throw new Error("未能从API响应中提取图像数据。"); }   // L83443-83445
let imageUrl = "data:image/png;base64," + re;   // L83446
```

`unzipFile`（L82719-82745）用 **JSZip** 解压，对 zip 内**第一个**条目取 `zipEntry.async("base64")` 后 resolve，返回值即 base64 字符串：

```js
const JSZipConstructor = window.stChatu8JSZip || window.JSZip;    // L82721
zip.forEach(function(relativePath, zipEntry) { ... zipEntry.async("base64").then(function(base64String) { resolve(base64String); }) ... });   // L82730-82739
```

JSZip 由 `loadJSZip()` 从扩展目录动态加载并做 UMD 隔离求值（L110588-110612；`${extensionFolderPath}/jszip.min.js`，L110595；挂在 `window.stChatu8JSZip`），启动时即加载（L110952-110954）。

### 5.2 酒馆后端路线：JSON `images[0]` 或裸 base64（L83337-83344）

```js
let data = await result.text();
try { const jsonResponse = JSON.parse(data); re = jsonResponse.images[0]; }
catch (e) { addLog("JSON 解析失败，尝试作为原始 Base64 数据处理。"); re = data; }
```

### 5.3 msgpack：被加载但未被使用

`loadmsgpack()` 加载 `${extensionFolderPath}/msgpack.min.js` 并挂到 `window.stChatu8MessagePack`（L110650-110678）；启动时由 `window.__chatu8perf.skipMsgpackEagerLoad` 决定是否预载（L110642-110649、L110958-110962）。但全文再无第二处 `stChatu8MessagePack`/`MessagePack` 引用（grep 仅命中 loader 自身），**响应解析路径未使用 msgpack**；即 body 里的 `"stream": "msgpack"` 与实际按 ZIP 解析之间存在不一致。

### 5.4 收尾

`data:image/png;base64,` + base64 → 若 `convertToJpegStorage === "true"` 再 `convertImageToJpeg(imageUrl)`（L83459-83461）→ 返回 `{ image, change, genParams }`（L83462）。

## 6 代理与 CORS

### 6.1 两条路线显式二选一

`client` 默认 `"browser"`（L2524），可选 `"browser"` / `"jiuguan"`（文档 L62528）。文档直接点明跨域（L69132）：

> `client: "客户端环境标识，常规为 'browser','jiuguan'决定了从哪里发起生图请求，如果从浏览器发请求可能会碰到跨域问题"`

排障文档（L62618）：`如果选了 "browser" 可能会有跨域问题，建议先尝试"jiuguan"进行…`。

### 6.2 走酒馆后端（规避 CORS 的主路径）

`client == "jiuguan"` 分支（L83251-83344）不访问 `image.novelai.net`，而是先把 key 写入 ST secrets（L83275-83314）再请求 `/api/novelai/generate-image`（L83323），由 ST 服务端转发。该分支**禁止自定义站点**：`throw new Error("酒馆端不支持自定义站点！")`（L83236-83239），重绘同理（L83655-83656）。

### 6.3 镜像 / 第三方站点

选"其他站点"时直连被改写为镜像地址（L83235-83248、L83654-83663）。默认填 `"http://localhost:9696/get-new-token"`（L2784，即本地取 token 的转发服务）。第三方站点在 Vibe 编码处也被允许（L90341-90345），但酒馆端被拒（L90338-90340）。

### 6.4 云端排队（限流，不是 CORS 代理）

`enableCloudQueue === "true"` 时两条路线都会先排队（L83260-83273、L83365-83378；重绘 L83638-83651）：

```js
var POLL_INTERVAL = 1e3; var MAX_POLL_RETRIES = 3;                       // L79182-79183
await fetch(`${baseUrl}/join-queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key_hash: keyHash, user_id: userId, task_id: taskId, greeting: greeting || null }) });   // L79225-79228
await fetch(`${baseUrl}/my-turn?key_hash=...&user_id=...&task_id=...`);   // L79243
await fetch(`${baseUrl}/complete`,   { method: "POST", ... body: JSON.stringify({ key_hash, user_id, task_id, lock_token: lockToken }) });   // L79255-79258
await fetch(`${baseUrl}/leave-queue`, { method: "POST", ... });          // L79275-79278
```

`key_hash` = API Key 的 SHA-256（`hashKey`，L79192-79214）；`user_id` = localStorage 的 `chatu8_uid`（L79185-79190）。默认地址 `https://st-chatu-novelai-queue.hf.space`（L2786）。取锁成功后 `await sleep(1e3)` 再发图（L83268）。

### 6.5 Vibe 编码路线

`/ai/encode-vibe` 仅浏览器直连一条（L90336-90355）。请求体 `{ image: imageBase64, information_extracted: 1, model }`（L90331-90335）；响应 `arrayBuffer()` → `uint8ArrayToBase64`（L90367-90369），长度 < 100 字节报错（L90371-90373）。结果写入本地 .naiv4vibe JSON（`buildVibeJson`，L89633-89662），固定 encoding key `b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f`（L89558），文件名 = hash 前 6 + 后 6 位（L89653）。

## 7 默认值

### 7.1 设置默认值（初始化 L2687-2786；配置档案副本 L3196-3225）

| 项 | 默认 | 行号 |
|---|---|---|
| `novelaiApi` | `"000000"`（占位，需用户填） | L2687 |
| `novelaimode` | `"nai-diffusion-4-5-full"` | L2781 |
| `novelai_sampler` | `"k_euler"` | L2743 |
| `Schedule`（noise_schedule） | `"karras"` | L2758 |
| `nai3Scale`（scale / Prompt Guidance） | `"10"` | L2691 |
| `cfg_rescale` | `"0.18"` | L2695 |
| `novelai_steps` | `"28"` | L2709 |
| `novelai_width` / `novelai_height` | `"1024"` / `"1024"` | L2710-2711 |
| `novelai_seed` | `"0"`（0/""/-1 → 随机） | L2712 |
| `sm` / `dyn` | `"true"` / `"true"` | L2693-2694 |
| `nai3Variety` / `nai3Deceisp` | `"true"` / `"true"` | L2757 / L2756 |
| `nai3VibeTransfer` / `enableVibeGroupTransfer` / `nai3CharRef` | `"false"` | L2748-2752 |
| `InformationExtracted` / `ReferenceStrength` | `"0.3"` / `"0.6"` | L2754-2755 |
| `normalizeRefStrength` | `"false"` | L2751 |
| `novelaisite` | `"官网"` | L2783 |
| `novelaiOtherSite` | `"http://localhost:9696/get-new-token"` | L2784 |
| `enableCloudQueue` / `cloudQueueUrl` | `"false"` / `"https://st-chatu-novelai-queue.hf.space"` | L2785-2786 |
| `imageGenInterval` | `100`（毫秒） | L2803 |

UI 下拉项（novelai.html）：模型 L216-222 = `nai-diffusion-3`、`nai-diffusion-4-full`、`nai-diffusion-4-curated-preview`、`nai-diffusion-4-5-curated`、`nai-diffusion-4-5-full`、`nai-diffusion-5-curated`、`nai-diffusion-5-full`；采样器 L232-238 = `k_euler`、`ddim_v3`、`k_dpmpp_2s_ancestral`、`k_dpmpp_2m`、`k_euler_ancestral`、`k_dpmpp_2m_sde`、`k_dpmpp_sde`；噪点表 L244-247 = `native/exponential/polyexponential/karras`；预设尺寸 L300-306 = 512x512、640x640、512x768、768x512、1024x1024、1216x832、832x1216。

### 7.2 默认正面质量标签（AQT，按模型硬编码映射，L82815-82829）

| 模型 | AQT 文本 | 行号 |
|---|---|---|
| 4-curated-preview | `rating:general, best quality, very aesthetic, absurdres` | L82816 |
| 4-full | `no text, best quality, very aesthetic, absurdres` | L82818 |
| 4-5-full | `very aesthetic, masterpiece, no text` | L82820 |
| 4-5-curated | `very aesthetic, masterpiece, no text, -0.8::feet::, rating:general` | L82822 |
| 5-full | `very aesthetic, amazing quality, no text` | L82824 |
| 5-curated | `very aesthetic, masterpiece, no text` | L82826 |
| 3 | `best quality, amazing quality, very aesthetic, absurdres` | L82828 |

仅当 `AQT_novelai != ""` 时生效；设置默认值即 `"best quality, amazing quality, very aesthetic, absurdres"`（L2698；novelai.html L138 的选项值相同）。

### 7.3 默认负面预设文本（UCP，L82883-82942）

`UCP_novelai` 默认 `"Heavy"`（L2699）。非 v5 判定用 `Heavy/Light/Human Focus/Furry Focus`（L82883-82927），v5 判定用小写 `heavy/light/humanFocus/furryFocus/none`（L82930-82941）。Heavy 档文本：

- NAI3（L82884）：`lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]`
- NAI4-full（L82895）：`blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page`
- NAI4.5-curated（L82912）：`blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page`
- NAI4.5-full（L82921）：`lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page`
- NAI5 heavy（L82934）：与 NAI4.5-full 文本相同

最终负面 = 用户预设 `negativePrompt` 与 UCP 文本合并（`fumian(_nai_preset.negativePrompt, UCP_novelai)`，L82943），再追加角色负面（L82944-82948）与智绘姬额外负面（L82952-82956）。UI 里的 `UCP_novelai` 是空 `<select>`（novelai.html L144-145），选项由 JS 动态填充。

### 7.4 其他默认

- 重绘负面默认 `"blurry, lowres, bad quality"`、遮罩强度默认 `0.54`（L83544-83545）；`parameters.strength` 硬编码 `0.7`（L83574）。
- 重绘尺寸回退链：`window.novelaiInpaintWidth || Xwidth || novelai_width || 1024`（L83553-83554，高度同理）。
- Vibe 预设默认：`{ model: "nai-diffusion-4-5-full", infoExtract: 1, strength: 0.6 }`（L89667-89673）。
- `n_samples` 恒为 `1`（L82969、L83053、L83094、L83568）。

## 8 证据行号索引

| 主题 | 行号 |
|---|---|
| 生图 URL 构造（直连 / 镜像） | 83234-83248 |
| 生图 URL 构造（重绘） | 83653-83663 |
| encode-vibe URL、请求体、请求头 | 90331-90355 |
| 主 fetch（直连 POST + getDirectHeaders3，含重试） | 83382、83387 |
| 主 fetch（酒馆路由 `/api/novelai/generate-image`） | 83323 |
| ST secrets 读写（`api_key_novel`） | 83275-83314 |
| 顶层 body `{input, model, action, parameters}` | 83349、83351 |
| 酒馆扁平 body `tavernAIPayload` | 83315-83321 |
| parameters 基线（NAI3/通用） | 82959-82996 |
| parameters（NAI4/4.5，分角色） | 83040-83079 |
| parameters（NAI4/4.5，非分角色） | 83081-83133 |
| NAI5 专属字段设置与被覆盖 | 82997-83006、83040、83081 |
| sampler 补丁 / skip_cfg 重算 | 83136-83142、9500-9509、10642-10644 |
| 清理 / 校验 | 82326-82358、82359-82407 |
| NAI3 参考数组写入 | 82424-82426 |
| Vibe 组（`*_cached`）写入与归一化 | 82479-82621 |
| 角色参考 5 数组 | 82653-82688 |
| v4_prompt / characterPrompts | 83015-83033 |
| `use_coords` 恒 false | 82958、82841 |
| 参考图预处理（尺寸/编码/去前缀） | 9445-9499 |
| 请求头 `getDirectHeaders3` | 82310-82322 |
| ST 请求头 `getRequestHeaders` | 10097-10102 |
| Key 校验（占位符 `000000`） | 82798-82804、83549-83552、90286-90289 |
| Key `pst-` 前缀校验：NOT FOUND | 仅文本 63223、63379、63503、63615 |
| 错误码映射 | 83411-83438 |
| 响应 ZIP 解压 / data URL | 83440-83446、82719-82745 |
| 响应 `JSON.images[0]`（酒馆路线） | 83337-83344 |
| JSZip 加载 | 110588-110612、110952-110954 |
| msgpack 加载（未被调用） | 110642-110678、110958-110962 |
| 云队列四个端点与轮询 | 79182-79340、83260-83273、83365-83378 |
| AQT / UCP 文本映射 | 82814-82942 |
| 默认设置 | 2687-2786、3196-3225 |
| CORS 说明文本 | 69132、62618 |
| .naiv4vibe 结果结构 | 89558、89633-89662 |