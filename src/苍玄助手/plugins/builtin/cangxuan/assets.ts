/**
 * 素材存储：走酒馆原生文件接口，**存 URL 不存 base64**。
 *
 * 来由：reports/苍玄助手-真文件存储探针.md。磁盘实测 settings.json 已 50.4MB，
 * 撑爆它的是别人脚本塞进去的 base64 图片；而 ST 原生 upload 在脚本形态下本来就能用。
 * 所以立绘 / 素材一律上传成真文件，变量里只留几十字节的路径。
 *
 * 实测结论（真酒馆 localhost:8000，面板 iframe 内）：
 *   - 面板 `cx-pw-frame` 与酒馆**同源**（about:srcdoc），可直接 fetch；
 *   - 必须先 `GET /csrf-token`，再带 `X-CSRF-Token` + `credentials:'include'`（否则 403）；
 *   - `POST /api/images/upload {image, format, filename, ch_name}` → `{path:'/user/images/<夹>/<名>'}`；
 *   - 1.1MB 上传 29ms；URL 可直接当 <img src>；跨整页刷新仍在；删除返回 200 且同 URL 变 404。
 *
 * 不依赖 TavernHelper：面板里 window.TavernHelper 是 undefined，纯 fetch 就够。
 */

/** 插件素材目录名（出现在 /api/images/folders 里，和用户自己的「苍玄界」并列） */
export const ASSET_FOLDER = 'cx-assets';

let csrfToken: string | null = null;

/** 拿 CSRF token（缓存；403 时清缓存重取一次） */
async function getCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch('/csrf-token', { credentials: 'include' });
  if (!response.ok) throw new Error('拿不到 CSRF token（HTTP ' + response.status + '）');
  const body = (await response.json()) as { token?: unknown };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) throw new Error('CSRF token 为空，请刷新酒馆页面重试');
  csrfToken = token;
  return token;
}

/** 酒馆原生 POST：自动带 CSRF 头；403 重取一次 token */
async function stPost(url: string, body: unknown): Promise<unknown> {
  const send = async (token: string) =>
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(body),
    });

  let response = await send(await getCsrfToken());
  if (response.status === 403) {
    // token 过期（酒馆重启 / 会话重置）—— 强制重取一次再试
    response = await send(await getCsrfToken(true));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('酒馆接口失败 ' + response.status + (text ? '：' + text.slice(0, 200) : ''));
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 上传一张图，返回可直接当 <img src> 用的路径。
 *
 * @param base64 不带 `data:image/png;base64,` 前缀的纯 base64
 * @param format 扩展名（png / jpg / webp …），必须在酒馆的 MEDIA_EXTENSIONS 里
 * @param filename 文件名（不含扩展名）；省略则用时间戳
 */
export async function uploadAsset(base64: string, format: string, filename?: string): Promise<string> {
  const body: Record<string, string> = { image: base64, format, ch_name: ASSET_FOLDER };
  if (filename) body.filename = filename;
  const result = (await stPost('/api/images/upload', body)) as { path?: unknown } | null;
  const path = result && typeof result.path === 'string' ? result.path : '';
  if (!path) throw new Error('上传成功但没拿到路径');
  return path;
}

/** 列本插件素材目录里的文件名 */
export async function listAssets(): Promise<string[]> {
  const result = await stPost('/api/images/list', { folder: ASSET_FOLDER });
  return Array.isArray(result) ? result.map(String) : [];
}

/** 删掉一个素材（path 必须是 uploadAsset 返回的那种路径） */
export async function deleteAsset(path: string): Promise<void> {
  await stPost('/api/images/delete', { path });
}

/** 上传要不要拼 data: 前缀的元数据 → 纯 base64（传给 uploadAsset 用） */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** 从 data URL 里读扩展名；认不出就用 png */
export function formatFromDataUrl(dataUrl: string): string {
  const match = /^data:image\/([a-zA-Z0-9+.-]+)[;,]/.exec(dataUrl);
  const raw = match ? match[1].toLowerCase() : 'png';
  return raw === 'jpeg' ? 'jpg' : raw;
}

/** 测试用：清掉缓存的 token */
export function resetAssetToken(): void {
  csrfToken = null;
}