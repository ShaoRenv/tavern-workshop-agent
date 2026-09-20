/**
 * 页面注册表（核心页部分）。
 *
 * 页面的**唯一来源**就是这里 + 各插件 manifest 的 contributes.pages；
 * active_tab 只存 id，是不是合法页面由 availablePages() 现算（老数据里的页 id 可能已经不存在）。
 *
 * 阶段 1 的 order 是**照着老顶栏逐格对齐**的：
 *   立绘 10（插件页）· 世界书 20（插件页）· 对话 30 · 能力 40 · 记录 50 · 设置 90
 * 阶段 2 起会重排：记录并进对话页的 ⋯、能力并进设置 → 只剩 对话 10 / 设置 90。
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
  { id: 'chat', title: '对话', order: 30, inTabbar: true, owner: 'base' },
  { id: 'capability', title: '能力', order: 40, inTabbar: true, owner: 'base' },
  { id: 'records', title: '记录', order: 50, inTabbar: true, owner: 'base' },
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