/**
 * 生图插件 · NovelAI 适配层（浏览器直连 / 反代）。
 *
 * 这一层只做三件事，全是**纯函数 + 一个 fetch**，方便测：
 *  1 planNaiRequest(config, prompt, negative) —— 按模型版本拼出 url / headers / body（可单测）
 *  2 unzipFirstEntryBase64(buffer)            —— NovelAI 回的是 ZIP，取出第一张图（可单测）
 *  3 generateImages(config, prompt, negative) —— 发请求并把响应解析成 dataURL 数组
 *
 * 参考实现：st-chatu8（D:\dsh\deliver\st-chatu8-perf\index.js），行号见
 * reports/苍玄助手-生图参考-nai.md。**故意跟它不一样的地方**（每处都是它那边的坑）：
 *  - 不发 `stream: "msgpack"`：它发了但响应仍按 ZIP 解析，别把这个矛盾抄过来
 *  - 不发 `use_new_shared_trial`：那是它自己的试用通道标志，跟我们无关
 *  - `n_samples` 恒为 1、`use_coords` 恒为 false（它那个 use_coords 表达式恒为 false，别抄）
 *  - v5 的 straight_alpha / tag_hint_* 真的会发出去（它那边被后面整体重建 body 冲掉了）
 */
import type { GenImageConfig } from '../../../core/types.ts';
import { hostFn } from '../../../core/host.ts';
import { isV4Plus, naiVersion, qualityWordsFor, supportsStraightAlpha, NAI_UC_PRESETS } from './options.ts';

/** 官网接口；反代/镜像填在 config.site_url 里 */
export const NAI_OFFICIAL_ENDPOINT = 'https://image.novelai.net/ai/generate-image';

export interface NaiRequestPlan {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 拼请求时用的提示词（固定在前后 + 质量词） */
export function buildPrompts(
  config: GenImageConfig,
  prompt: string,
  negative: string,
): { positive: string; negative: string } {
  const positive = [config.prompt, prompt, config.prompt_end, config.quality ? qualityWordsFor(config.model) : '']
    .map(item => String(item ?? '').trim())
    .filter(item => item !== '')
    .join(', ');
  const negativeText = [config.negative, negative]
    .map(item => String(item ?? '').trim())
    .filter(item => item !== '')
    .join(', ');
  return { positive, negative: negativeText };
}

/** 反代地址 → 接口地址；空/非法就回落官网 */
export function naiEndpoint(config: GenImageConfig): string {
  if (config.site !== 'proxy') return NAI_OFFICIAL_ENDPOINT;
  const base = String(config.site_url ?? '').trim().replace(/\/+$/, '');
  if (base === '') return NAI_OFFICIAL_ENDPOINT;
  if (base.includes('generate-image')) return base;
  return base + '/ai/generate-image';
}

/**
 * 多样性（Variety+）对应的 skip_cfg_above_sigma 阈值。
 * 公式照 st-chatu8：sqrt(像素数 / 1011712) × 魔数（4.5 用 58，其余 19）。
 * 这数越大越"放开"高 CFG 的钳制；关掉多样性就不发这个字段。
 */
export function skipCfgAboveSigma(width: number, height: number, version: string): number {
  const magic = version === 'v4.5' ? 58 : 19;
  const value = Math.sqrt((width * height) / 1011712) * magic;
  return Math.round(value * 1000000) / 1000000;
}

/** ucPreset：枚举 → NovelAI 要的数字（0 重 / 1 轻 / 2 人像向 / 3 不用） */
export function ucPresetOf(config: GenImageConfig): number {
  const hit = NAI_UC_PRESETS.find(item => item.value === config.uc_preset);
  return hit ? hit.uc : 0;
}

/** 随机种子（config.seed = 0 表示随机） */
export function pickSeed(config: GenImageConfig, random = Math.random): number {
  const seed = Number(config.seed);
  return seed === 0 || !Number.isFinite(seed) ? Math.floor(random() * 4294967295) : Math.round(seed);
}

/**
 * 组装请求（纯函数）。
 *
 * 顶层结构照 NovelAI：`{ input, model, action, parameters }`。
 * v3 与 v4+ 的 parameters 是**两套字段**（见参考报告 §2.5），这里分叉得很明确：
 *  - v3：sm / sm_dyn / dynamic_thresholding（Decrisp）/ qualityToggle
 *  - v4+：autoSmea / v4_prompt / v4_negative_prompt / characterPrompts / inpaintImg2ImgStrength
 */
export function planNaiRequest(
  config: GenImageConfig,
  prompt: string,
  negative: string,
  options: { seed?: number; random?: () => number } = {},
): NaiRequestPlan {
  const key = String(config.api_key ?? '').trim();
  if (key === '') throw new Error('还没填 NovelAI API Key（插件页 · 接口）');

  const version = naiVersion(config.model);
  const words = buildPrompts(config, prompt, negative);
  const seed = options.seed === undefined ? pickSeed(config, options.random) : Math.round(options.seed);
  const width = Math.max(64, Math.round(Number(config.width)));
  const height = Math.max(64, Math.round(Number(config.height)));

  // v5 不认 ddim_v3（参考报告 §2.5：它会被换成 Euler Ancestral）
  let sampler = String(config.sampler || 'k_euler_ancestral');
  if (version === 'v5' && sampler === 'ddim_v3') sampler = 'k_euler_ancestral';

  const common: Record<string, unknown> = {
    width,
    height,
    scale: Number(config.guidance),
    sampler,
    steps: Math.max(1, Math.round(Number(config.steps))),
    n_samples: 1,
    ucPreset: ucPresetOf(config),
    qualityToggle: config.quality,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: Number(config.guidance_rescale),
    noise_schedule: String(config.schedule || 'karras'),
    legacy_v3_extend: false,
    seed,
    negative_prompt: words.negative,
    use_coords: false,
  };

  // 只有 v3 认这几个；v4 起的 parameters 用下面那套（autoSmea / v4_prompt）
  if (!isV4Plus(version)) {
    common.params_version = 3;
    common.sm = config.smea;
    common.sm_dyn = config.smea && config.smea_dyn;
    common.dynamic_thresholding = config.decrisp;
    common.reference_image_multiple = [];
    common.reference_information_extracted_multiple = [];
    common.reference_strength_multiple = [];
    common.reference_image_multiple_cached = [];
    common.normalize_reference_strength_multiple = false;
  } else {
    common.params_version = version === 'v5' ? 4 : 3;
    common.autoSmea = false;
    common.dynamic_thresholding = false;
    common.inpaintImg2ImgStrength = 1;
    common.normalize_reference_strength_multiple = false;
    common.reference_image_multiple = [];
    common.reference_information_extracted_multiple = [];
    common.reference_strength_multiple = [];
    common.reference_image_multiple_cached = [];
    common.characterPrompts = [];
    common.v4_prompt = {
      caption: { base_caption: words.positive, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    common.v4_negative_prompt = { caption: { base_caption: words.negative, char_captions: [] }, legacy_uc: false };
    // v5 专有：透明背景 + tag hint（参考报告 §2.2）
    if (supportsStraightAlpha(version)) {
      common.straight_alpha = config.straight_alpha;
      common.tag_hint_qt = 1;
      common.tag_hint_uc_preset = ucPresetOf(config);
    }
  }

  if (config.variety) common.skip_cfg_above_sigma = skipCfgAboveSigma(width, height, version);

  // Euler Ancestral：官方那两条补丁（参考报告 §2.4）
  if (sampler === 'k_euler_ancestral') {
    common.deliberate_euler_ancestral_bug = false;
    common.prefer_brownian = true;
  }

  return {
    url: naiEndpoint(config),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      Authorization: 'Bearer ' + key,
    },
    body: {
      input: words.positive,
      model: config.model,
      action: 'generate',
      parameters: common,
    },
  };
}

/* ==================== 响应解析 ==================== */

/** Uint8Array → base64（分块，别用展开运算符一次性拼，几 MB 会爆栈） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** 从尾部往前找 End of Central Directory（ZIP 的中央目录结束标记） */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 66000);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 取 ZIP 里第一张图，返回 base64（不带 data: 前缀）。
 *
 * NovelAI 直接回 ZIP；用 DecompressionStream('deflate-raw') 解 deflate，
 * 不引 JSZip（几十上百 KB）——只需要第一个条目，手解 ZIP 头就够了。
 */
export async function unzipFirstEntryBase64(buffer: ArrayBuffer): Promise<string> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('响应不是 ZIP（找不到中央目录）');
  if (view.getUint16(eocd + 10, true) === 0) throw new Error('ZIP 里没有文件');
  const cd = view.getUint32(eocd + 16, true);
  if (cd <= 0 || cd + 46 > buffer.byteLength || view.getUint32(cd, true) !== 0x02014b50)
    throw new Error('ZIP 中央目录头不对');
  const method = view.getUint16(cd + 10, true);
  const compressedSize = view.getUint32(cd + 20, true);
  const local = view.getUint32(cd + 42, true);
  if (local + 30 > buffer.byteLength || view.getUint32(local, true) !== 0x04034b50)
    throw new Error('ZIP 本地文件头不对');
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = bytes.slice(start, start + compressedSize);
  if (method === 0) return bytesToBase64(data);
  if (method !== 8) throw new Error('ZIP 压缩方式不支持：' + method);
  const table = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const raw = new Uint8Array(await new Response(table).arrayBuffer());
  return bytesToBase64(raw);
}

/** 把一段 base64 / dataURL 规整成 dataURL（图片格式交给 PNG，NovelAI 出的就是 PNG） */
export function toDataUrl(value: string): string {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  return /^data:image\//i.test(text) ? text : 'data:image/png;base64,' + text;
}

/**
 * 解析生图响应，返回 dataURL 数组。
 *
 *  - 直连 NovelAI：`application/zip` / 未知类型 → ZIP
 *  - 反代 / 中转：常见是 JSON `{images: [base64]}`（跟酒馆 `/api/novelai/generate-image` 一样）
 *  - 少数中转直接回裸 base64 文本
 */
export async function parseImageResponse(response: Response): Promise<string[]> {
  const type = String(response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/json') || type.includes('text/json')) {
    // 中转站偶尔会挂 JSON 头却回空体 / 半截 JSON：解析失败就交给下面的兜底，别把 SyntaxError 抛给用户
    const text = (await response.text()).trim();
    if (text === '') return [];
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return imagesFromJson(JSON.parse(text) as unknown);
      } catch {
        return [];
      }
    }
    return imagesFromJson(text);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) return [];
  const head = new Uint8Array(buffer.slice(0, 2));
  if (head[0] === 0x50 && head[1] === 0x4b) return [toDataUrl(await unzipFirstEntryBase64(buffer))];
  if (head[0] === 0x89 && head[1] === 0x50) return [toDataUrl(bytesToBase64(new Uint8Array(buffer)))]; // 直接回 PNG
  const text = new TextDecoder().decode(buffer).trim();
  if (text.startsWith('{')) return imagesFromJson(JSON.parse(text) as unknown);
  return /^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 64 ? [toDataUrl(text)] : [];
}

/** 宽松地从 JSON 里抠图：`{images: [...]}` / `{image: "..."}` / 裸数组 / 带 data 字段 */
export function imagesFromJson(data: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') out.push(toDataUrl(value));
  };
  if (Array.isArray(data)) data.forEach(push);
  else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const list = record.images ?? record.image ?? record.data;
    if (Array.isArray(list)) list.forEach(push);
    else if (typeof list === 'string') push(list);
    else if (list && typeof list === 'object') push((list as Record<string, unknown>).data);
  }
  return out;
}

/* ==================== 发请求 ==================== */

export interface GenerateOptions {
  /** 换一个 fetch 实现（测试用） */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 请求超时（毫秒），默认 120 秒 */
  timeoutMs?: number;
}

/** 把 HTTP 状态翻译成人能看懂的话（照参考报告 §4.5） */
export function describeStatus(status: number, text: string): string {
  if (status === 400) {
    const message = /"message"\s*:\s*"([^"]+)"/.exec(text);
    return message ? 'NovelAI 说：' + message[1] : '请求被拒（400）：' + text.slice(0, 200);
  }
  if (status === 401) return 'API Key 错误或失效（401）。';
  if (status === 402) return '这个账号需要有效订阅才能用生图（402）。';
  if (status === 429) return '请求太快被限流（429），等一会儿再试。';
  return '生图失败（HTTP ' + status + '）：' + text.slice(0, 200);
}

/**
 * 发一次生图请求，返回 dataURL 数组（一次一张）。
 *
 * 用户在插件页点「试画一张」和模型调 gen_image 走的是**同一条**链路，
 * 所以试画能出图 = 模型那边也能出图（区别只是谁来写 prompt）。
 */
export async function generateImages(
  config: GenImageConfig,
  prompt: string,
  negative: string,
  options: GenerateOptions = {},
): Promise<string[]> {
  const plan = planNaiRequest(config, prompt, negative);
  // fetch 走 core/host.ts 的唯一一条链（不再裸读 globalThis.fetch）：
  // 显式注入的 options.fetchImpl 优先（那是调用方传的，不是第二条链），
  // 否则 原生适配器 → globalThis.TavernHelper.fetch → globalThis.fetch 逐层兜。
  const doFetch = (options.fetchImpl ?? hostFn('fetch')) as typeof fetch | null;
  if (typeof doFetch !== 'function') throw new Error('这个环境里没有 fetch，发不了请求');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs ?? 120000));
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await doFetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(describeStatus(response.status, text));
    }
    const images = await parseImageResponse(response);
    if (!images.length) throw new Error('接口回了 200，但里面没有图。');
    return images;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new Error('生图超时了（默认 120 秒）。');
    if (error instanceof TypeError) {
      throw new Error(
        '请求发不出去：浏览器多半被 CORS 挡住了（或地址填错）。插件页把站点改成「反代 / 中转」再试。',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
