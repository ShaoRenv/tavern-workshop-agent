/**
 * 工具调用的分类与展示小工具。
 *
 * 为什么按名字猜：工具注册表在 agent 内核那边，界面不引它（避免循环依赖），
 * 这里只认「名字 → 长什么样」这一条映射；认不出来的一律当普通工具。
 */
import type { ToolCall } from '../core/types.ts';

const IMAGE_TOOLS = ['gen_image', 'generate_image', 'image_gen'];
const PATCH_TOOLS = ['entry_edit', 'entry_create', 'entry_delete', 'entry_meta', 'wb_write', 'entry_write'];
const SKILL_TOOLS = ['skill', 'read_skill_file'];

/** 生图：要在对话里出图 */
export function isImageCall(call: ToolCall): boolean {
  return call.images.length > 0 || IMAGE_TOOLS.includes(call.name);
}

/** 改动世界书：展开时按 +/− 上色 */
export function isPatchCall(call: ToolCall): boolean {
  return PATCH_TOOLS.includes(call.name);
}

/** 读技能正文 / 参考文件 */
export function isSkillCall(call: ToolCall): boolean {
  return SKILL_TOOLS.includes(call.name);
}

/** 行首那个符号：◆ 普通 / ◈ 技能 / ✎ 改动 */
export function callIcon(call: ToolCall): string {
  if (isSkillCall(call)) return '◈';
  if (isPatchCall(call)) return '✎';
  return '◆';
}

/** 参数列：挑一个最能说明问题的字段，太长由 CSS 截断 */
export function callArgBrief(call: ToolCall): string {
  const args = call.args || {};
  for (const key of ['keyword', 'query', 'name', 'prompt', 'world', 'uid', 'id']) {
    const value = args[key];
    if (typeof value === 'string' && value) return key === 'uid' ? 'uid ' + value : value;
    if (typeof value === 'number') return key === 'uid' ? 'uid ' + String(value) : String(value);
  }
  return '';
}

export interface DiffLine {
  text: string;
  cls: string;
}

/** 改动内容按行上色：+ 青玉、− 危险色 */
export function patchLines(text: string): DiffLine[] {
  return (text || '')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      if (line.startsWith('+')) return { text: line, cls: 'cx-add' };
      if (line.startsWith('-')) return { text: line, cls: 'cx-del' };
      return { text: line, cls: '' };
    });
}
