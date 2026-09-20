/**
 * 页面注册表（核心页部分）。
 *
 * 页面的**唯一来源**就是这里 + 各插件 manifest 的 contributes.pages；
 * active_tab 只存 id，是不是合法页面由 availablePages() 现算（老数据里的页 id 可能已经不存在）。
 *
 * 阶段 2 起核心页只剩两个：**对话 10 · 设置 90**（插件页夹在中间）。
 *   - 记录不占页面：它是对话页右上角 ⋯ 里的一张 Sheet；
 *   - 能力（工具 / 技能 / 插件）不占页面：它是设置里的一格。
 * 老数据的 active_tab = records / capability 由 TAB_ID_ALIASES 兜到 chat / settings（见 core/types.ts）。
 */
export interface PageEntry {
  id: string;
  title: string;
  order: number;
  inTabbar: boolean;
  /** 'base' = 底座给的页面；否则是插件 id */
  owner: string;
}

export const CORE_PAGES: PageEntry[] = [
  { id: 'chat', title: '对话', order: 10, inTabbar: true, owner: 'base' },
  { id: 'settings', title: '设置', order: 90, inTabbar: true, owner: 'base' },
];

/** 合并核心页与插件页：按 order 升序，同 order 按 id 稳定排序（核心页与插件页都在同一张表里比） */
export function mergePages(pluginPages: PageEntry[]): PageEntry[] {
  return [...CORE_PAGES, ...pluginPages].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/** 能上顶栏的那些（inTabbar !== false） */
export function tabbarPages(pages: PageEntry[]): PageEntry[] {
  return pages.filter(page => page.inTabbar !== false);
}

/** 按 id 找页面；找不到返回 null（调用方自己决定回落到哪） */
export function findPage(pages: PageEntry[], id: string): PageEntry | null {
  return pages.find(page => page.id === id) ?? null;
}