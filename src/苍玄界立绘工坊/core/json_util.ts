/** 宽松 JSON 解析：失败返回 null，便于对不可信元数据做容错处理 */
export function tryParseJson(text: string | undefined | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 判断是否为普通对象（排除数组与 null） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一化路径取值。
 *
 * 支持:
 * - 点号: `a.b.c`
 * - 数组下标: `a[0].b`
 * - 通配符: `a[*].b`  → 收集数组每一项的 b，用 ", " 连接
 */
export function getByPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = tokenizePath(path);
  return resolveTokens(root, tokens);
}

function tokenizePath(path: string): (string | number | '*')[] {
  const tokens: (string | number | '*')[] = [];
  for (const segment of path.split('.')) {
    const matches = segment.matchAll(/([^[\]]+)|\[(\*|\d+)\]/g);
    for (const match of matches) {
      if (match[1] !== undefined) {
        if (match[1]) tokens.push(match[1]);
      } else if (match[2] === '*') {
        tokens.push('*');
      } else if (match[2] !== undefined) {
        tokens.push(Number(match[2]));
      }
    }
  }
  return tokens;
}

function resolveTokens(current: unknown, tokens: (string | number | '*')[]): unknown {
  if (tokens.length === 0) return current;
  const [head, ...rest] = tokens;

  if (head === '*') {
    if (!Array.isArray(current)) return undefined;
    const collected: unknown[] = [];
    for (const item of current) {
      const value = resolveTokens(item, rest);
      if (value !== undefined && value !== null && value !== '') collected.push(value);
    }
    if (collected.length === 0) return undefined;
    if (collected.length === 1) return collected[0];
    return collected;
  }

  if (Array.isArray(current) && typeof head === 'number') {
    return resolveTokens(current[head], rest);
  }

  if (isPlainObject(current) && typeof head === 'string') {
    return resolveTokens(current[head], rest);
  }

  return undefined;
}

/** 把任意取值转为展示用文本；数组以 ", " 连接 */
export function toDisplayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(item => toDisplayText(item))
      .filter(text => text !== '')
      .join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
