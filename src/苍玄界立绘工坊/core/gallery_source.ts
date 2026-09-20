/**
 * 图库采集。
 *
 * 数据来源**全部在本机**，不访问创意工坊的 Cloudflare Worker：
 * 1. `localStorage['cx_workshop_custom_roles_v1']` —— 创意工坊同步到本地的角色
 * 2. `localStorage['cx_status_custom_roles_v1']`   —— 状态栏里手动添加的角色
 * 3. 状态栏脚本文本里内嵌的 `npcList`（基础图库）—— 纯本地文本解析
 *
 * 三者按角色名合并去重，与状态栏自身的 getMergedNpcList 行为保持一致。
 */
import { scrapeStatusbarRoles, type BuiltinRole } from './statusbar_scrape.ts';
import { isPlainObject } from './json_util.ts';

export type RoleSource = 'statusbar_builtin' | 'workshop' | 'statusbar_manual' | 'manual';

export interface GalleryRole {
  name: string;
  sect: string;
  /** 头像 */
  defaultImg: string;
  /** 立绘（优先用于提取元数据） */
  portraitImg: string;
  /** 角色设定文本（工坊角色可能自带） */
  profile: string;
  source: RoleSource;
}

export const WORKSHOP_ROLE_STORAGE_KEY = 'cx_workshop_custom_roles_v1';
export const STATUS_ROLE_STORAGE_KEY = 'cx_status_custom_roles_v1';
/** 状态栏脚本名，用于定位内嵌的基础图库 */
export const STATUSBAR_SCRIPT_NAME = '状态栏';

export const SOURCE_LABELS: Record<RoleSource, string> = {
  statusbar_builtin: '状态栏内置',
  workshop: '创意工坊',
  statusbar_manual: '状态栏自建',
  manual: '手动添加',
};

/** 只接受可用的图片地址 */
export function normalizeImageUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (!url) return '';
  return /^(https?:|data:image\/|blob:)/i.test(url) ? url : '';
}

/** 取得宿主页面的 localStorage（脚本与前端界面均与酒馆同源） */
function hostStorage(): Storage | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(window.parent?.localStorage);
  } catch {
    /* 跨域时忽略 */
  }
  try {
    candidates.push(window.top?.localStorage);
  } catch {
    /* 跨域时忽略 */
  }
  try {
    candidates.push(localStorage);
  } catch {
    /* 不可用时忽略 */
  }

  for (const candidate of candidates) {
    if (candidate && typeof (candidate as Storage).getItem === 'function') return candidate as Storage;
  }
  return null;
}

/** 从 localStorage 读一个角色数组，容错任何异常 */
function readStoredRoles(key: string, source: RoleSource): GalleryRole[] {
  const storage = hostStorage();
  if (!storage) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(key) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const roles: GalleryRole[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    const defaultImg = normalizeImageUrl(item.defaultImg ?? item.avatar ?? item.avatarUrl);
    const portraitImg = normalizeImageUrl(item.portraitImg ?? item.portrait ?? item.portraitUrl) || defaultImg;
    if (!defaultImg && !portraitImg) continue;

    roles.push({
      name,
      sect: String(item.sect ?? item.group ?? '自定义').trim() || '自定义',
      defaultImg,
      portraitImg,
      profile: String(item.profile ?? item.lore ?? item.setting ?? item.description ?? ''),
      source,
    });
  }
  return roles;
}

/** 读取创意工坊同步到本地的角色 */
export function readWorkshopRoles(): GalleryRole[] {
  return readStoredRoles(WORKSHOP_ROLE_STORAGE_KEY, 'workshop');
}

/** 读取状态栏手动添加的角色 */
export function readStatusManualRoles(): GalleryRole[] {
  return readStoredRoles(STATUS_ROLE_STORAGE_KEY, 'statusbar_manual');
}

function toGalleryRole(role: BuiltinRole): GalleryRole {
  return {
    name: role.name,
    sect: role.sect,
    defaultImg: role.defaultImg,
    portraitImg: role.portraitImg || role.defaultImg,
    profile: '',
    source: 'statusbar_builtin',
  };
}

/** 在酒馆助手脚本树中查找状态栏脚本的正文 */
export function findStatusbarScriptText(): string {
  const optionTypes: Array<'global' | 'preset' | 'character'> = ['character', 'global', 'preset'];

  for (const type of optionTypes) {
    try {
      const trees = getScriptTrees({ type });
      for (const node of trees) {
        const scripts = 'scripts' in node && Array.isArray(node.scripts) ? node.scripts : [node];
        for (const script of scripts) {
          if (!script || typeof script !== 'object' || script.type !== 'script') continue;
          if (script.name === STATUSBAR_SCRIPT_NAME && typeof script.content === 'string') {
            return script.content;
          }
        }
      }
    } catch {
      /* 该类型不可用时继续尝试下一种 */
    }
  }
  return '';
}

/** 读取状态栏脚本内嵌的基础图库 */
export function readBuiltinRoles(): GalleryRole[] {
  const text = findStatusbarScriptText();
  if (!text) return [];
  return scrapeStatusbarRoles(text).map(toGalleryRole);
}

/**
 * 汇总全部图库。
 *
 * 合并优先级（后者覆盖前者）: 内置 < 创意工坊 < 状态栏自建。
 * 与状态栏 getMergedNpcList 的覆盖方向一致。
 */
export function collectGallery(): { roles: GalleryRole[]; warnings: string[] } {
  const warnings: string[] = [];
  const map = new Map<string, GalleryRole>();

  const builtin = readBuiltinRoles();
  if (builtin.length === 0) {
    warnings.push('未找到状态栏脚本或其内嵌图库，基础图库为空（可手动粘贴 URL 补充）');
  }
  for (const role of builtin) map.set(role.name, role);

  const workshop = readWorkshopRoles();
  for (const role of workshop) map.set(role.name, role);

  const manual = readStatusManualRoles();
  for (const role of manual) map.set(role.name, role);

  return { roles: [...map.values()], warnings };
}

/** 取用于提取元数据的图片地址：优先立绘，其次头像 */
export function pickImageUrl(role: GalleryRole): string {
  return role.portraitImg || role.defaultImg;
}
