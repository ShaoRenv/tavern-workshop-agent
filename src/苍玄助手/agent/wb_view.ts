/**
 * 草稿视图：把还没落地的草稿套在真实 WorldbookPort 上，得到一个「看起来已经改过」的世界书。
 *
 * 为什么需要它（修三个 bug）：
 *  1) entry_create 之后立刻 entry_edit，之前读真实数据 → 找不到刚建的条目；
 *  2) 同一条改两次，第二次基于旧正文算 after → 把第一处改动覆盖掉；
 *  3) 改完再 wb_read，看到的还是旧内容。
 *
 * 用法：
 *  - 工具层统一用视图（createRegistry(createDraftView(realPort, drafts))）；
 *  - saveDrafts() 必须用**真实端口**落地（视图的 writeAll 只是透传，不做落地）。
 */
import type { WbEntry, WbSearchHit, WorldbookPort } from '../core/ports.ts';
import { searchInEntries } from '../core/worldbook.ts';
import { applyChangesToEntries, type DraftStore } from './draft.ts';

/** 参与版本计算、并且用长度前缀拼起来做防串味 */
function versionPayload(entry: WbEntry): string {
  const parts = [
    entry.name,
    entry.content,
    entry.enabled ? '1' : '0',
    entry.strategy,
    entry.keys.join('\u0001'),
    entry.keys_secondary.logic + '\u0002' + entry.keys_secondary.keys.join('\u0001'),
    String(entry.scan_depth),
  ];
  return parts.map(part => part.length + ':' + part).join('|');
}

/** FNV-1a 32 位 → 8 位十六进制；纯函数、跨进程稳定，可单测 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 条目版本：对正文 / 标题 / 开关 / 蓝绿灯 / 关键词 / 次关键词 / 扫描深度做稳定短 hash。
 * 位置类字段（position/depth/order）不参与 —— 挪个位置不算「内容变过」。
 */
export function entryVersion(entry: WbEntry): string {
  return fnv1a(versionPayload(entry));
}

/**
 * 草稿视图：读全部先套草稿；写操作（writeAll / createWorldbook / deleteWorldbook）原样透传。
 */
export function createDraftView(base: WorldbookPort, drafts: DraftStore): WorldbookPort {
  /** 读完真实条目后按顺序套上这本世界书的草稿 */
  const viewEntries = async (world: string): Promise<WbEntry[]> => {
    const entries = await base.readAll(world);
    const changes = drafts.ofWorld(world);
    if (!changes.length) return entries;
    return applyChangesToEntries(entries, changes).entries;
  };

  return {
    list: () => base.list(),
    current: () => base.current(),
    readAll: world => viewEntries(world),
    async readByUid(world: string, uids: string[]): Promise<WbEntry[]> {
      const wanted = new Set(uids.map(item => String(item)));
      const entries = await viewEntries(world);
      return entries.filter(entry => wanted.has(entry.uid));
    },
    async search(worlds: string[], keyword: string, limit: number): Promise<WbSearchHit[]> {
      const hits: WbSearchHit[] = [];
      for (const world of worlds) {
        if (hits.length >= limit) break;
        hits.push(...searchInEntries(world, await viewEntries(world), keyword, limit - hits.length));
      }
      return hits;
    },
    createWorldbook: name => base.createWorldbook(name),
    deleteWorldbook: name => base.deleteWorldbook(name),
    writeAll: (world, entries) => base.writeAll(world, entries),
  };
}
