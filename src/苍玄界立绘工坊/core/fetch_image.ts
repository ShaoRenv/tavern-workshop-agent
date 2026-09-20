/**
 * 图片下载与本地读取。
 *
 * 设计要点：**只按图床直链下载图片本身**，不接触任何第三方云服务的 API。
 * 浏览器受同源策略限制，部分图床不允许跨域读取，因此这里把失败原因区分出来，
 * 交由界面提示用户改用「手动上传 PNG」这条一定能成功的路径。
 */

export interface FetchBytesResult {
  ok: boolean;
  bytes: Uint8Array | null;
  error: string;
  /** 是否疑似被跨域策略拦截 */
  corsBlocked: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 按 URL 下载图片字节。
 *
 * @param url 图片地址
 * @param proxyPrefix 可选的代理前缀，用于绕过图床的跨域限制；留空则直连
 */
export async function fetchImageBytes(url: string, proxyPrefix = ''): Promise<FetchBytesResult> {
  const target = url.trim();
  if (!target) return { ok: false, bytes: null, error: '图片地址为空', corsBlocked: false };

  const prefix = proxyPrefix.trim().replace(/\/+$/, '');
  const requestUrl = prefix ? prefix + '/' + target : target;

  try {
    const response = await fetch(requestUrl, { credentials: 'omit' });
    if (!response.ok) {
      return { ok: false, bytes: null, error: 'HTTP ' + response.status, corsBlocked: false };
    }
    const buffer = await response.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buffer), error: '', corsBlocked: false };
  } catch (error) {
    // fetch 抛 TypeError 通常就是跨域被拦或网络不可达
    return { ok: false, bytes: null, error: describeError(error), corsBlocked: true };
  }
}

/** 读取用户选择的本地文件（拖拽或文件选择），这条路径不受跨域限制 */
export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}
