/**
 * 工具行：能力 · 工具段 与 预设的「这个预设用哪些工具」Sheet **共用一份口径**（H4）。
 *
 * 为什么要抽出来：两处原本各写一份「正常行 + 兜底行」，分叉的第一个后果就是 F-B
 * ——预设的 Sheet 里漏了「来源已停用」，同一件事出现两种表达。
 *
 * 口径：
 *  - 正常行：来源可用（owner_disabled 不为 true）的工具，按清单顺序、按名字去重；
 *  - 兜底行：预设里硬引用过、正常行里却没有的，排在正常行之后。只有两种可能：
 *      ① 来源插件关着（清单里有、被跳过，owner_disabled = true → 行上标「来源已停用」）
 *      ② 名字根本不在内核清单里（老名字 / 拼错）→ 给个来源标签，不冒称「来源已停用」
 *  - owner_disabled 由 App.vue 算好（只有它拿得到 store.plugin_state）：这里只筛选、不重算，
 *    免得出现第二份「这工具归谁、来源开没开」的判断。
 */
import { toolOwnerLabel } from '../plugins/registry.ts';
import type { UiTool } from './ui_types.ts';

export function buildToolRows(catalog: readonly UiTool[], presetTools: readonly string[]): UiTool[] {
  const out: UiTool[] = [];
  const seen = new Set<string>();

  for (const tool of catalog) {
    if (tool.owner_disabled) continue;
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }

  for (const name of presetTools) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(catalog.find(tool => tool.name === name) ?? { name, owner: toolOwnerLabel(name) });
  }

  return out;
}
