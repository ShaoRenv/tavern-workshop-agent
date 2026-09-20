/**
 * 从状态栏脚本文本中抠出内置角色图库。
 *
 * 状态栏脚本正文里有一段 base64 编码的 HTML，真正的图库代码在其中：
 * - `const npcList = [{ name: "沈慕微", defaultImg: "https://...", portraitImg: "https://..." }, ...]`
 * - `const fixedSectMap = { "沈慕微": "天剑宗", ... }`
 *
 * 这里只做**本地文本解析**，不发起任何网络请求，也不接触创意工坊的云服务。
 */

export interface BuiltinRole {
  name: string;
  sect: string;
  defaultImg: string;
  portraitImg: string;
  source: 'statusbar_builtin';
}

/** 把 base64 按 UTF-8 解码（HTML 内含中文） */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 从脚本文本里取出被 base64 编码的 HTML。
 *
 * @param scriptText 状态栏脚本的 content 文本，或状态栏脚本 JSON 的原文
 * @returns 解码后的 HTML；找不到则返回 null
 */
export function extractEmbeddedHtml(scriptText: string): string | null {
  // 兼容两种输入：脚本 content 原文（引号为 "），以及脚本 JSON 文件原文（引号被转义为 \"）
  const match =
    scriptText.match(/STATUS_HTML_BASE64\s*=\s*"([A-Za-z0-9+/=]+)"/) ??
    scriptText.match(/STATUS_HTML_BASE64\s*=\s*\\"([A-Za-z0-9+/=]+)\\"/);
  if (!match) return null;
  try {
    return base64ToUtf8(match[1]);
  } catch {
    return null;
  }
}

/** 从形如 `{ name: "x", defaultImg: "y" }` 的对象文本里取某个字段 */
function readProperty(objectText: string, key: string): string {
  // 用字符串拼接构造正则，避免模板字符串与引号字符互相干扰
  const pattern = '\\b' + key + '\\s*:\\s*["\']([^"\']*)\\s*["\']';
  const match = objectText.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
}

/** 在文本中定位 `<marker>\s*=\s*[...]` 的数组字面量内容并返回 */
function sliceArrayLiteral(text: string, marker: string): string | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bracketStart = text.indexOf('[', start);
  if (bracketStart < 0) return null;

  let depth = 0;
  for (let i = bracketStart; i < text.length; i++) {
    const char = text[i];
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) return text.slice(bracketStart + 1, i);
    }
  }
  return null;
}

/** 解析 `fixedSectMap`，得到 角色名 -> 势力 的映射 */
export function extractSectMap(html: string): Record<string, string> {
  const start = html.indexOf('fixedSectMap');
  if (start < 0) return {};

  const braceStart = html.indexOf('{', start);
  if (braceStart < 0) return {};

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd < 0) return {};

  const body = html.slice(braceStart + 1, braceEnd);
  const map: Record<string, string> = {};
  for (const match of body.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']*)["']/g)) {
    map[match[1].trim()] = match[2].trim();
  }
  return map;
}

/**
 * 从状态栏 HTML 中解析内置角色图库。
 *
 * 解析是容错的：单个对象缺字段时跳过，不影响其他角色。
 */
export function extractBuiltinRoles(html: string): BuiltinRole[] {
  const arrayBody = sliceArrayLiteral(html, 'npcList');
  if (!arrayBody) return [];

  const sectMap = extractSectMap(html);
  const roles: BuiltinRole[] = [];

  // 以顶层 "}," 切分对象，避免嵌套结构干扰（npcList 元素是扁平对象）
  for (const rawObject of arrayBody.split(/\}\s*,/)) {
    if (!rawObject.includes('name')) continue;
    const name = readProperty(rawObject, 'name');
    if (!name) continue;

    const defaultImg = readProperty(rawObject, 'defaultImg');
    const portraitImg = readProperty(rawObject, 'portraitImg') || defaultImg;
    if (!defaultImg && !portraitImg) continue;

    roles.push({
      name,
      sect: sectMap[name] || readProperty(rawObject, 'sect') || '未知',
      defaultImg,
      portraitImg,
      source: 'statusbar_builtin',
    });
  }

  return roles;
}

/** 一步到位：从状态栏脚本文本得到内置图库 */
export function scrapeStatusbarRoles(scriptText: string): BuiltinRole[] {
  const html = extractEmbeddedHtml(scriptText);
  if (!html) return [];
  return extractBuiltinRoles(html);
}
