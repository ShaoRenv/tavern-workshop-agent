/**
 * 工具层公共底座（阶段 3 从 tools_worldbook.ts 抽出来的）。
 *
 * 为什么要有这个文件：阶段 3 把世界书工具搬进 `plugins/builtin/worldbook/` 之后，
 * 这些**与世界书无关**的通用件（参数归一化 / 结果包装 / JSON Schema 小工厂 /
 * 操作范围话术）如果跟着搬，就会逼着 agent/ 反过来 import plugins/ —— 破坏
 * 「依赖只能 plugins → core/agent」这条硬规矩。
 *
 * 所以分层是：
 *   core/ports.ts        （类型）
 *   agent/toolkit.ts     （本文件：通用工具件，叶子）
 *   agent/tools_*.ts     （技能 / 生图等底座工具）
 *   plugins/builtin/<id>/tools.ts （插件自己的工具，import 本文件）
 *
 * ⚠️ 这里**不许**出现任何世界书专属语义（世界名解析、条目渲染、草稿推送、条目 diff）；
 * 那些跟着世界书插件走。唯一例外是「操作范围」这组 —— 它拼的是**底座系统提示词**，
 * 只依赖 core 的 WorldbookPort，所以归底座。
 */
import type { ToolContext, ToolErrorCode, ToolResult, WorldbookPort } from '../core/ports.ts';

/* ============================ 参数读取（模型给的东西一律脏，全部归一化） ============================ */

export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function asInt(value: unknown, fallback: number, min?: number, max?: number): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  let out = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  if (typeof min === 'number') out = Math.max(min, out);
  if (typeof max === 'number') out = Math.min(max, out);
  return out;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
  }
  return fallback;
}

export function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => asText(item).trim()).filter(Boolean);
  const text = asText(value).trim();
  if (!text) return [];
  return text
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/* ============================ 结果包装 ============================ */

export function resultOk(brief: string, detail: string, images?: string[]): ToolResult {
  return images && images.length ? { ok: true, brief, detail, images } : { ok: true, brief, detail };
}

export function resultFail(brief: string, detail?: string, code?: ToolErrorCode): ToolResult {
  // 带上错误码：界面能按类型分流显示，守卫也能认出「越界 / 参数错 / 找不到」
  return code ? { ok: false, brief, detail: detail ?? brief, code } : { ok: false, brief, detail: detail ?? brief };
}

/** 截断长文本，尾巴上留一句话说明被砍过 */
export function clip(text: string, max: number, tail = '\n…（内容过长已截断）'): string {
  const value = String(text ?? '');
  if (max <= 0 || value.length <= max) return value;
  return value.slice(0, max) + tail;
}

/* ============================ JSON Schema 小工厂 ============================ */

/**
 * 对象 schema。
 * description 是给**嵌套对象**用的：原生 tools 通道下模型只看得到这里写的东西，
 * 所以 keys_secondary 这种子对象必须带上说明，不能只给子属性写。
 */
export function schemaObject(
  properties: Record<string, unknown>,
  required: string[] = [],
  description = '',
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'object', properties, required, additionalProperties: false };
  if (description) schema.description = description;
  return schema;
}

export function schemaString(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra };
}

export function schemaInteger(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'integer', description, ...extra };
}

export function schemaBoolean(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'boolean', description, ...extra };
}

export function schemaArray(
  description: string,
  items: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'array', description, items, ...extra };
}

/* ============================ 操作范围（底座系统提示词用） ============================ */

/** 本次允许读改的世界书（空数组 = 用户一本都没勾） */
export function allowedWorlds(ctx: ToolContext): string[] {
  return (ctx?.worlds ?? []).map(name => asText(name).trim()).filter(Boolean);
}

/** 一本都没勾时的专门文案（系统提示词、越权报错共用） */
export function scopeEmptyNotice(): string {
  return '当前没有勾选任何世界书，读写都会失败，请先让用户去「世界书」页勾选。';
}

/** 范围内的世界书名，逗号顿号串起来；空数组返回空串 */
export function scopeNames(worlds: string[]): string {
  return worlds
    .map(name => asText(name).trim())
    .filter(Boolean)
    .join('、');
}

/**
 * 越权文案（读、写、搜共用同一份话术）：
 * 《X》不在本次可操作范围内。本次只能用：A、B。如果需要《X》，请让用户去「世界书」页勾上。
 */
export function outOfScopeError(worlds: string[], target: string): string {
  const allowed = worlds.map(name => asText(name).trim()).filter(Boolean);
  const name = asText(target).trim();
  if (!allowed.length) return scopeEmptyNotice() + (name ? '你想动的是《' + name + '》。' : '');
  const quoted = name ? '《' + name + '》' : '没写名字的那一本';
  return (
    quoted +
    '不在本次可操作范围内。本次只能用：' +
    allowed.join('、') +
    '。如果需要' +
    quoted +
    '，请让用户去「世界书」页勾上。'
  );
}

/**
 * 系统提示词里的「本次可操作范围」段落。
 * **只出现范围内的世界书名**（范围外的一个字都不写，省 token 也免得它惦记），
 * 每本带上实际条目数 / 启用数；拿不到统计就不写括号那部分；一本都没勾走专门文案。
 *
 * 归底座的理由：它拼的是底座 agent 系统提示词，只依赖 core 的 WorldbookPort，
 * 跟「世界书插件给模型哪些工具」是两件事。
 */
export async function buildScopePrompt(wb: WorldbookPort, worlds: string[]): Promise<string> {
  const allowed = worlds.map(name => asText(name).trim()).filter(Boolean);
  if (!allowed.length) return scopeEmptyNotice();
  const lines = ['本次你可以读改这些世界书：'];
  for (const name of allowed) {
    let stat = '';
    try {
      const entries = await wb.readAll(name);
      const enabled = entries.filter(entry => entry.enabled).length;
      stat =
        enabled === entries.length
          ? '（' + entries.length + ' 条）'
          : '（' + entries.length + ' 条，启用 ' + enabled + '）';
    } catch {
      stat = '';
    }
    lines.push('- ' + name + stat);
  }
  lines.push('范围外的世界书一律不可读写，也不要问它们的内容。若确实需要别的，请让用户去「世界书」页勾上。');
  return lines.join('\n');
}