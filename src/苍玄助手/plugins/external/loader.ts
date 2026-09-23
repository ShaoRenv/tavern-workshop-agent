/**
 * 外部插件装载（阶段 7）。
 *
 * ─────────────────────────── 三条路（都已在真酒馆实测通过）───────────────────────────
 *
 *   ① URL 下载  → 存成 ST 真文件 → `import(文件URL)`
 *   ② 粘贴 JS   → 存成 ST 真文件 → `import(文件URL)`
 *   ③ 兜底      → `blob:` URL（HTTPS 部署下 http 源会被「混合内容」拦掉，blob 不受限）
 *
 * 证据见 `reports/阶段7-外部插件装载-探针.md` §1。
 *
 * ─────────────────────────── 为什么「先落盘再执行」───────────────────────────
 *
 * 装了就要能**重装 / 重载**：刷新页面之后插件还得活。`blob:` URL 一刷新就没了，
 * 所以**磁盘上那份才是「安装」的事实来源**，import 只是执行它。
 * 反过来，只 import 不落盘 = 每次刷新都要用户重新粘一遍代码，那不叫安装。
 *
 * ─────────────────────────── 安全口径（已拍板，别重开）───────────────────────────
 *
 * **全权装载、不做权限门禁、只留来源/hash 展示**；真禁网只能靠隔离档 iframe（二期）。
 * 这里做的是**失败隔离**，不是权限隔离：任何一步抛异常都只影响这一个插件。
 */
import type { ExternalPlugin } from '../../core/types.ts';
import type { PluginManifest } from '../types.ts';
import { isExternalPlugin, registerExternalManifest, unregisterExternalManifest } from '../registry.ts';
import { hostFn } from '../../core/host.ts';

/** 底座版本（apiVersion 兼容判据：同大版本可用） */
export const BASE_API_VERSION = 1;

/** 插件代码存在 ST 真文件里的名字前缀（放 files 根目录：ST 的 upload 不建子目录） */
export const PLUGIN_FILE_PREFIX = 'cx-plugin-';

/**
 * ⚠️⚠️ 存成 `.txt` 而不是 `.js` —— **真机验收踩出来的**。
 *
 * ST 的 `/api/files/upload` 走 `validateAssetFileName`，它拿 `UNSAFE_EXTENSIONS` 挡扩展名，
 * 而那份名单里**明确包含 `.js`**（还有 .html/.htm/.php/.exe…，见 ST 的 src/constants.js）。
 * 用 `.js` 上传会直接 400：`Forbidden file extension.` —— 装什么都装不上。
 *
 * 为什么换个扩展名**不影响功能**：这个文件从来不靠静态服务当脚本执行，
 * 而是「**读回文本 → 我们自己 import**」（`importCode` 里那条 blob 兜底就是干这个的）。
 * 扩展名在这里只决定两件事：ST 允不允许写、以及我们读回来的是不是原文。
 */
export const PLUGIN_FILE_EXT = '.txt';

/** 单个插件代码的体积上限（1 MB）。超了直接拒绝，别把 settings/磁盘当垃圾场 */
export const MAX_PLUGIN_BYTES = 1024 * 1024;

/* ============================ 注入的宿主能力（测试用假实现驱动） ============================ */

export interface ExternalLoaderDeps {
  /** 取 fetch（宿主能力 'fetch'）；拿不到就明确报「这台机器没有网络能力」 */
  getFetch: () => typeof fetch | null;
  /** 取 CSRF token（ST 要求带 X-CSRF-Token，否则 403） */
  getCsrf: () => Promise<string | null>;
}

/**
 * 生产用的依赖：宿主 fetch + CSRF。
 *
 * 放在这里而不是 App.vue：**能力怎么拿**是装载器自己的知识（能力名 'fetch'、ST 要 CSRF 头），
 * 界面不该知道这些细节。测试里换成假实现即可，一行都不用改产品代码。
 */
export function createLoaderDeps(): ExternalLoaderDeps {
  let csrf: string | null = null;
  const getFetch = (): typeof fetch | null => {
    const fn = hostFn('fetch') as typeof fetch | undefined;
    return typeof fn === 'function' ? fn : null;
  };
  return {
    getFetch,
    getCsrf: async () => {
      if (csrf) return csrf;
      const doFetch = getFetch();
      if (!doFetch) return null;
      try {
        const response = await doFetch('/csrf-token', { credentials: 'include' });
        const body = (await response.json()) as { token?: unknown };
        csrf = typeof body.token === 'string' ? body.token : null;
      } catch {
        // 拿不到 token 不代表不能试：ST 在某些部署下不校验 —— 让请求自己去撞 403，再报人话
        csrf = null;
      }
      return csrf;
    },
  };
}

/* ============================ 动态 import（**必须绕开打包器**） ============================ */

/**
 * 运行时的 `import(变量)`。
 *
 * ⚠️⚠️ 这里**不能**直接写 `await import(url)`：webpack 见到动态 import 会把它当成
 * **打包期**的依赖，于是要么报「找不到模块」，要么真去生成一个异步 chunk
 * —— 而外部插件的 URL 只有运行时才知道，编译期根本不存在这个模块。
 *
 * 用 `new Function` 包一层，让打包器看不见这个 import（这是社区里的标准做法）。
 * 代价：这条路**没有类型、没有打包期检查** —— 所以下面每个环节都要自己校验形状。
 */
const runtimeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;

/**
 * 把一段代码变成可 import 的模块。
 *
 * ⚠️ **主路是 blob**，不是「直接 import 那个文件 URL」——
 * 因为插件代码存成的是 `.txt`（见 `PLUGIN_FILE_EXT` 的说明：ST 禁掉 `.js` 上传），
 * 静态服务会按 text/plain 给出来，浏览器**拒绝**把 text/plain 当模块执行。
 * 所以顺序是：**读回文本（调用方已做）→ blob → import**；
 * 直接 import URL 只作为兜底（万一将来 ST 允许脚本扩展名 / 或代码本来就是从别处 import 的）。
 */
async function importCode(url: string, code: string): Promise<unknown> {
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await runtimeImport(blobUrl);
  } catch (error) {
    // blob 都不行（极少见）→ 最后试一次直接 import 那个 URL
    try {
      return await runtimeImport(url);
    } catch {
      throw error;
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/* ============================ 文本哈希（展示 + 「文件被换过」判断） ============================ */

/** FNV-1a 32 位（同 core 里观察用的那套，够做展示与变化检测，不做安全用途） */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/* ============================ apiVersion ============================ */

/**
 * 判据：**同大版本可用**（`apiVersion === BASE_API_VERSION`）。
 *
 * 不匹配时给的是**人话 + 下一步**，而不是「不兼容」三个字：
 * 用户拿到的往往是一个为别的底座版本写的包，他需要知道「该找谁」。
 */
export function evaluateApiVersion(declared: unknown): { ok: boolean; error?: string } {
  const value = typeof declared === 'number' ? declared : NaN;
  if (!Number.isFinite(value)) {
    return { ok: false, error: '这个插件包没声明 apiVersion —— 没法判断它是不是给这个底座写的，已拒绝装载' };
  }
  if (value === BASE_API_VERSION) return { ok: true };
  return {
    ok: false,
    error:
      '这个插件包声明的 apiVersion 是 ' + value + '，而当前底座是 ' + BASE_API_VERSION +
      '（底座只保证同大版本兼容）—— 请找这个插件的作者要一个给 apiVersion ' + BASE_API_VERSION + ' 写的版本',
  };
}

/* ============================ 形状校验 ============================ */

/**
 * 校验模块导出的东西**够不够当插件用**。
 *
 * 外部代码没有任何编译期保证，所以这里把「能查的都查一遍」，并且**说清哪里不对**：
 * 一个只写了 `export default {...}` 的包，作者会想知道到底差在哪，而不是看到「加载失败」。
 */
export function validateModule(mod: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const bag = (mod ?? {}) as Record<string, unknown>;
  const candidate = (bag.manifest ?? bag.default) as PluginManifest | undefined;
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, error: '这个插件包没有导出 manifest（应 `export const manifest = {…}` 或 `export default {…}`）' };
  }
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return { ok: false, error: 'manifest 缺 id（插件的唯一身份，装/卸/开关都靠它）' };
  }
  if (!candidate.contributes || typeof candidate.contributes !== 'object') {
    return { ok: false, error: 'manifest 缺 contributes（它得说清自己贡献了页面 / 工具 / 宏 / 技能 / 设置里的哪些）' };
  }
  const version = evaluateApiVersion(candidate.apiVersion);
  if (!version.ok) return { ok: false, error: version.error ?? 'apiVersion 不兼容' };
  return { ok: true, manifest: candidate };
}

/* ============================ 真文件读写（ST /api/files） ============================ */

function safeFileId(id: string): string {
  // ST 的 upload 会校验文件名；把 id 里可能出现的怪字符换掉，保证路径安全且可复现
  return id.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'plugin';
}

/** 这个插件的代码存在哪 */
export function codePathFor(id: string): string {
  return '/user/files/' + PLUGIN_FILE_PREFIX + safeFileId(id) + PLUGIN_FILE_EXT;
}

async function postJson(deps: ExternalLoaderDeps, url: string, body: unknown): Promise<{ status: number; text: string }> {
  const doFetch = deps.getFetch();
  if (!doFetch) throw new Error('这台机器拿不到网络能力（fetch），没法读写插件文件');
  const csrf = await deps.getCsrf();
  const response = await doFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** 把代码写进 ST 真文件（base64，ST 的 upload 收的是 base64） */
async function writeCodeFile(deps: ExternalLoaderDeps, id: string, code: string): Promise<string> {
  const name = PLUGIN_FILE_PREFIX + safeFileId(id) + PLUGIN_FILE_EXT;
  const result = await postJson(deps, '/api/files/upload', { name, data: toBase64(code) });
  if (result.status !== 200) {
    throw new Error('插件代码没能写进酒馆文件（HTTP ' + result.status + '）：' + result.text.slice(0, 160));
  }
  try {
    const parsed = JSON.parse(result.text) as { path?: unknown };
    return typeof parsed.path === 'string' && parsed.path ? parsed.path : codePathFor(id);
  } catch {
    return codePathFor(id);
  }
}

/** 从 ST 真文件读回代码（重装 / 重载时用） */
async function readCodeFile(deps: ExternalLoaderDeps, path: string): Promise<string> {
  const doFetch = deps.getFetch();
  if (!doFetch) throw new Error('这台机器拿不到网络能力（fetch），没法读插件文件');
  const response = await doFetch(path, { credentials: 'include' });
  if (!response.ok) throw new Error('读插件文件失败（HTTP ' + response.status + '）：' + path);
  return await response.text();
}

/** 删掉插件文件（卸载时用；文件不在也算成功） */
async function deleteCodeFile(deps: ExternalLoaderDeps, path: string): Promise<void> {
  if (!path) return;
  await postJson(deps, '/api/files/delete', { path });
}

/** UTF-8 安全 base64（`btoa` 只吃 latin1，中文插件注释会直接炸） */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ============================ 安装 / 装载 / 卸载 ============================ */

export interface InstallResult {
  ok: boolean;
  /** 装上了的话，它的 id */
  id?: string;
  /** 失败了的话，人话原因（可直接显示） */
  error?: string;
  /** 已经装过同 id 的包（更新场景），调用方据此决定要不要覆盖清单 */
  updated?: boolean;
  /** 装上之后的 manifest（调用方拿它写安装记录：名字 / 版本 / apiVersion） */
  manifest?: PluginManifest;
  /** 代码落在哪（= 以后重载要读的路径） */
  code_path?: string;
  /** 代码哈希（展示 + 判断文件被换过） */
  hash?: string;
}

/**
 * 从一段代码安装（URL 下载与粘贴共用这条路）。
 *
 * 顺序是刻意的：**先执行、后落盘** ——
 * 代码跑不起来（语法错 / 没有 manifest / apiVersion 不兼容）就**不该留下任何痕迹**，
 * 否则用户会得到一个「装上了但一直报错」的僵尸插件。
 */
export async function installFromCode(
  code: string,
  meta: { id?: string; source: 'url' | 'paste'; origin?: string },
  deps: ExternalLoaderDeps,
): Promise<InstallResult> {
  const bytes = new TextEncoder().encode(code).length;
  if (bytes > MAX_PLUGIN_BYTES) {
    return { ok: false, error: '插件代码 ' + Math.round(bytes / 1024) + ' KB，超过上限 ' + MAX_PLUGIN_BYTES / 1024 + ' KB' };
  }
  if (!code.trim()) return { ok: false, error: '代码是空的' };

  // ① 先写文件（拿一个真 URL），再 import —— 这样 import 的 URL 与以后重载的**是同一个**
  const idForFile = meta.id?.trim() || 'pending-' + hashText(code);
  let path = '';
  try {
    path = await writeCodeFile(deps, idForFile, code);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  // ② 执行 + 校验形状
  let mod: unknown;
  try {
    mod = await importCode(path, code);
  } catch (error) {
    await deleteCodeFile(deps, path).catch(() => undefined);
    return { ok: false, error: '插件代码执行失败：' + messageOf(error) };
  }
  const checked = validateModule(mod);
  if (!checked.ok) {
    await deleteCodeFile(deps, path).catch(() => undefined);
    return { ok: false, error: checked.error };
  }

  // ③ 注册 manifest（撞内置 id 会被拒 —— 这时也要把文件删掉，不留垃圾）
  const registered = registerExternalManifest(checked.manifest);
  if (!registered.ok) {
    await deleteCodeFile(deps, path).catch(() => undefined);
    return { ok: false, error: registered.error ?? '注册失败' };
  }

  // ④ 代码里声明的 id 与文件名不一致时，按真实 id 重写一份，保证「文件路径 = codePathFor(id)」
  const realId = checked.manifest.id;
  const expected = codePathFor(realId);
  if (path !== expected) {
    try {
      await writeCodeFile(deps, realId, code);
      if (path !== expected) await deleteCodeFile(deps, path).catch(() => undefined);
      path = expected;
    } catch {
      // 重写失败不致命：下次重载会按 codePathFor 读，读不到会明确报错
    }
  }

  return {
    ok: true,
    id: realId,
    updated: isExternalPlugin(realId),
    manifest: checked.manifest,
    code_path: path,
    hash: hashText(code),
  };
}

/** 从 URL 安装（先把代码下载下来，再走上面那条路） */
export async function installFromUrl(url: string, deps: ExternalLoaderDeps): Promise<InstallResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: '地址是空的' };
  if (!/^https?:\/\//i.test(trimmed)) return { ok: false, error: '只支持 http(s) 地址' };
  const doFetch = deps.getFetch();
  if (!doFetch) return { ok: false, error: '这台机器拿不到网络能力（fetch），没法下载插件' };

  let code = '';
  try {
    const response = await doFetch(trimmed, { credentials: 'omit' });
    if (!response.ok) {
      return { ok: false, error: '下载失败（HTTP ' + response.status + '）—— 确认这个地址能直接在浏览器里打开' };
    }
    code = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: '下载失败：' + messageOf(error) + ' —— 常见原因：地址写错、对方没开 CORS（跨源下载需要它）、网络不通',
    };
  }
  return await installFromCode(code, { source: 'url', origin: trimmed }, deps);
}

/**
 * 启动 / 刷新时装载**已安装**的插件（幂等）。
 *
 * 每个插件单独 try/catch —— **一个坏插件只影响它自己**（失败隔离的落点）：
 * 它的 `last_error` 会被写回，界面上显示「装上了但跑不起来：原因」，其余插件照常。
 */
export async function loadInstalled(
  installed: ExternalPlugin[],
  deps: ExternalLoaderDeps,
): Promise<{ loaded: string[]; failed: Array<{ id: string; error: string }> }> {
  const loaded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const record of Array.isArray(installed) ? installed : []) {
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    try {
      const path = record.code_path || codePathFor(id);
      const code = await readCodeFile(deps, path);
      const mod = await importCode(path, code);
      const checked = validateModule(mod);
      if (!checked.ok) throw new Error(checked.error);
      if (checked.manifest.id !== id) {
        throw new Error('插件文件里的 id（' + checked.manifest.id + '）与安装记录（' + id + '）对不上，已跳过');
      }
      const registered = registerExternalManifest(checked.manifest);
      if (!registered.ok) throw new Error(registered.error ?? '注册失败');
      loaded.push(id);
    } catch (error) {
      failed.push({ id, error: messageOf(error) });
    }
  }
  return { loaded, failed };
}

/** 卸载：注销 manifest + 删文件（顺序无所谓，两步都幂等） */
export async function uninstallPlugin(id: string, codePath: string, deps: ExternalLoaderDeps): Promise<void> {
  unregisterExternalManifest(id);
  await deleteCodeFile(deps, codePath || codePathFor(id)).catch(() => undefined);
}

/** 任何异常 → 人话（绝不把裸 TypeError 甩给用户） */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
