/**
 * 世界书插件的 7 个工具：wb_list / wb_search / wb_read / entry_create / entry_edit / entry_delete / entry_meta
 *
 * 两条铁律：
 *  1) entry_edit 只做 old_string → new_string 的精确替换，绝不整条重写；
 *  2) 所有写操作只落草稿，不碰真数据（真写入由 agent/draft.ts 的 apply() 调 WorldbookPort.writeAll）。
 *
 * 阶段 3：本文件从 `agent/tools_worldbook.ts` 搬进插件目录。搬的时候**只搬世界书专属**的部分 ——
 * 参数归一化 / 结果包装 / JSON Schema 小工厂 / 操作范围话术都是与世界书无关的通用件，留在底座
 * `agent/toolkit.ts`，由本文件单向 import。这样依赖方向始终是 plugins → core / agent。
 *
 * 端口注入口径（阶段 3 契约）：`contributes.tools` 是**静态** ToolDef[]，模块加载时拿不到宿主对象，
 * 所以 `createWorldbookTools()` 是**零参**的，7 个工具一律从 `ctx.wb` 取世界书端口
 * （跟 ctx.genImage / ctx.askUser 同一个路子）。
 */
import type { ToolContext, ToolDef, ToolErrorCode, WbEntry } from '../../../core/ports.ts';
import { uid, type DraftChange, type DraftKind } from '../../../core/types.ts';
import { changedLines, diffStat, encodeMetaFields, formatDiff, formatStat, lineDiff } from '../../../agent/draft.ts';
import {
  allowedWorlds,
  asBool,
  asInt,
  asText,
  asTextArray,
  clip,
  outOfScopeError,
  resultFail,
  resultOk,
  schemaArray,
  schemaBoolean,
  schemaInteger,
  schemaObject,
  schemaString,
  scopeEmptyNotice,
  scopeNames,
} from '../../../agent/toolkit.ts';

export interface WorldPick {
  world?: string;
  error?: string;
  /** 失败分类，跟 ports.ts 的 ToolErrorCode 对齐；没分类时调用方按 INVALID_ARGS 兜底 */
  code?: ToolErrorCode;
}

/** 读工具用：只能读本轮范围内的世界书；一本都没勾就整个读不了 */
export function resolveWorld(ctx: ToolContext, asked: unknown): WorldPick {
  const allowed = allowedWorlds(ctx);
  const name = asText(asked).trim();
  if (!allowed.length) return { error: outOfScopeError(allowed, name), code: 'SCOPE_DENIED' };
  if (!name) {
    if (allowed.length === 1) return { world: allowed[0] };
    return { error: '请指明 world（本次可操作范围：' + scopeNames(allowed) + '）。', code: 'INVALID_ARGS' };
  }
  if (!allowed.includes(name)) return { error: outOfScopeError(allowed, name), code: 'SCOPE_DENIED' };
  return { world: name };
}

/** 写工具用：必须明确落在本轮勾选的世界书里，一本都没勾就不许写 */
export function resolveWriteWorld(ctx: ToolContext, asked: unknown): WorldPick {
  const allowed = allowedWorlds(ctx);
  const name = asText(asked).trim();
  if (!allowed.length) return { error: outOfScopeError(allowed, name), code: 'SCOPE_DENIED' };
  if (!name) {
    if (allowed.length === 1) return { world: allowed[0] };
    return { error: '请指明 world（本次可操作范围：' + scopeNames(allowed) + '）。', code: 'INVALID_ARGS' };
  }
  if (!allowed.includes(name)) return { error: outOfScopeError(allowed, name), code: 'SCOPE_DENIED' };
  return { world: name };
}

/* ============================ 草稿 ============================ */

/**
 * ports.ts 的 DraftSink 没有 payload，本层需要能带结构化载荷的版本。
 * DraftStore（draft.ts）实现了 addChange；别的实现退化成 add() 也能用。
 */
export interface AgentDraftSink {
  add(
    world: string,
    uid: string,
    kind: 'create' | 'edit' | 'delete' | 'meta',
    before: string,
    after: string,
    label: string,
  ): void;
  addChange?(change: Partial<DraftChange> & { kind: DraftKind }): unknown;
}

export interface DraftInput {
  kind: DraftKind;
  world: string;
  uid: string;
  label: string;
  before: string;
  after: string;
  payload?: Record<string, unknown>;
}

/**
 * 写草稿。优先 addChange（载荷全）；只有 add() 时：
 *   create → before 放条目字段 JSON；meta → before/after 放旧/新字段 JSON。
 */
export function pushDraft(ctx: ToolContext, input: DraftInput): void {
  const sink = ctx?.drafts as AgentDraftSink | undefined;
  if (!sink) throw new Error('本轮没有接上草稿仓（ctx.drafts 缺失）');
  const payload = input.payload ?? {};
  if (typeof sink.addChange === 'function') {
    sink.addChange({
      kind: input.kind,
      world: input.world,
      uid: input.uid,
      label: input.label,
      before: input.before,
      after: input.after,
      payload,
    });
    return;
  }
  if (input.kind === 'create') {
    sink.add(input.world, input.uid, 'create', JSON.stringify(payload), input.after, input.label);
  } else if (input.kind === 'meta') {
    const { before_fields: beforeFields, ...newFields } = payload;
    sink.add(
      input.world,
      input.uid,
      'meta',
      JSON.stringify((beforeFields as Record<string, unknown> | undefined) ?? {}),
      JSON.stringify(newFields),
      input.label,
    );
  } else if (input.kind === 'delete') {
    sink.add(input.world, input.uid, 'delete', input.before, input.after, input.label);
  } else {
    sink.add(input.world, input.uid, 'edit', input.before, input.after, input.label);
  }
}

/** 新建条目的 uid 兜底 */
export function newEntryUid(): string {
  return uid('entry');
}

/* ============================ 条目渲染 ============================ */

export function strategyLabel(strategy: WbEntry['strategy']): string {
  if (strategy === 'constant') return '蓝灯常驻';
  if (strategy === 'vectorized') return '向量化';
  return '绿灯';
}

/** 蓝绿灯参数：优先 strategy 枚举，其次吃 constant: boolean 简写 */
export function asStrategy(value: unknown, hasConstant: boolean, constantValue: unknown): WbEntry['strategy'] {
  const text = asText(value).trim();
  if (text === 'constant' || text === 'selective' || text === 'vectorized') return text;
  if (hasConstant) return asBool(constantValue, false) ? 'constant' : 'selective';
  return 'selective';
}

export function renderEntry(entry: WbEntry, index: number, maxContent: number): string {
  const tags = [entry.enabled ? '启用' : '已禁用', strategyLabel(entry.strategy)];
  const head =
    '[' + (index + 1) + '] uid=' + entry.uid + ' 标题：' + (entry.name || '(无标题)') + '（' + tags.join(' / ') + '）';
  const keys = entry.keys.length ? ' 关键词：' + entry.keys.join('、') : '';
  const secondary = entry.keys_secondary.keys.length
    ? ' 次关键词(' + entry.keys_secondary.logic + ')：' + entry.keys_secondary.keys.join('、')
    : '';
  const meta =
    '    position=' +
    entry.position +
    ' depth=' +
    entry.depth +
    ' order=' +
    entry.order +
    ' scan_depth=' +
    entry.scan_depth +
    keys +
    secondary;
  const content = clip(entry.content, maxContent, '\n…（正文已截断，用 max_content 调大或分页继续读）');
  return head + '\n' + meta + '\n正文：\n' + (content || '(空)');
}

/** 分页默认值 */
const PAGE_LIMIT_DEFAULT = 5;
const PAGE_LIMIT_MAX = 30;
const CONTENT_LIMIT_DEFAULT = 2000;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count++;
    from = index + needle.length;
  }
}

function headLine(world: string, total: number, from: number, count: number): string {
  if (count <= 0) return '世界书「' + world + '」· 共 ' + total + ' 条 · 本页空';
  return '世界书「' + world + '」· 共 ' + total + ' 条 · 本次给第 ' + (from + 1) + '-' + (from + count) + ' 条';
}

function pageTrailer(total: number, offset: number, limit: number): string {
  const next = offset + limit;
  const hasMore = next < total;
  return (
    '[分页] offset=' +
    offset +
    ' limit=' +
    limit +
    ' total=' +
    total +
    ' next_offset=' +
    (hasMore ? next : -1) +
    ' has_more=' +
    hasMore
  );
}

export function createWorldbookTools(): ToolDef[] {
  const wbList: ToolDef = {
    name: 'wb_list',
    group: 'knowledge',
    title: '列世界书',
    desc: '列出世界书 + 它从哪儿生效（全局 / 角色卡 / 未启用）',
    model_description:
      '列出世界书，并标出每本的绑定范围：全局（所有聊天都生效）/ 当前角色卡 / 当前聊天 / 未启用，' +
      '外加条目数与启用数。为什么要看范围：同样一次改动，动全局书会影响所有聊天，动角色卡书只影响当前角色，' +
      '而「未启用」的书本来就还没生效——用户说「改一下世界书」时，先用这个工具确认他指的是哪本、影响面多大，' +
      '别猜。参数 in_scope_only=true 只列本次勾选范围内的（可读写的那几本）。',
    parameters: schemaObject({
      in_scope_only: schemaBoolean('只列本次勾选范围内的世界书，默认 false 列全部（含未勾选的）'),
    }),
    default_on: true,
    run: async (args, ctx) => {
      const allowed = allowedWorlds(ctx);
      const allowedSet = new Set(allowed);

      // 全部世界书 + 各自的绑定范围（拿不到 scopes 就退回「只有名字」，别让工具整个废掉）
      let scopes: Array<{ name: string; label: string }> = [];
      try {
        scopes = (await ctx.wb.scopes()).map(item => ({ name: item.name, label: item.label }));
      } catch (error) {
        console.warn('[苍玄助手] 读世界书范围失败，退回只列名字', error);
      }
      if (!scopes.length) {
        try {
          scopes = (await ctx.wb.list()).map(name => ({ name, label: '未知' }));
        } catch {
          scopes = [];
        }
      }

      const inScopeOnly = asBool(args.in_scope_only, false);
      // 默认列**全部**：用户说「改一下世界书」时，模型得先知道有哪些、哪本没启用
      const shown = inScopeOnly ? scopes.filter(item => allowedSet.has(item.name)) : scopes;
      const rows: string[] = [];
      const byScope: Record<string, string[]> = { 全局: [], 当前角色卡: [], 当前聊天: [], 未启用: [], 未知: [] };
      for (const item of shown) {
        let stat = '（条目数读不到）';
        try {
          const entries = await ctx.wb.readAll(item.name);
          const enabled = entries.filter(entry => entry.enabled).length;
          stat = entries.length + ' 条，启用 ' + enabled;
        } catch {
          stat = '（条目数读不到）';
        }
        // 不在本次范围的顺手标出来，模型就知道哪些能直接用、哪些要先让用户勾
        const writable = allowedSet.has(item.name) ? '' : '（不在本次范围，不可读写）';
        rows.push('- ' + item.name + ' —— ' + item.label + '　' + stat + writable);
        (byScope[item.label] ?? byScope['未知']).push(item.name);
      }

      if (!rows.length) {
        return resultOk(
          inScopeOnly ? '本次范围内没有世界书' : '酒馆里没有任何世界书',
          inScopeOnly
            ? '本次勾选范围内没有世界书。' + scopeEmptyNotice()
            : '酒馆里读不到任何世界书。可能世界书功能没开，可以让用户确认一下。',
        );
      }

      const summary = ['全局', '当前角色卡', '当前聊天', '未启用']
        .filter(kind => byScope[kind].length)
        .map(kind => kind + ' ' + byScope[kind].length + ' 本')
        .join(' · ');

      const detail = [
        '世界书共 ' + rows.length + ' 本（' + summary + '）：',
        ...rows,
        '',
        '说明：全局的改动会影响所有聊天；当前角色卡只影响这个角色；未启用表示它现在没生效（要用得去「世界书」页勾上）。',
        '本次可读写的是：' + (allowed.length ? scopeNames(allowed) : '（一本都没勾，先用 scopeEmptyNotice 那条口径告诉用户）') + '。',
      ].join('\n');

      return resultOk(
        '世界书 ' + rows.length + ' 本 · ' + summary + ' · 可读写 ' + allowed.length + ' 本',
        detail,
      );
    },
  };

  const wbSearch: ToolDef = {
    name: 'wb_search',
    group: 'knowledge',
    title: '搜条目',
    desc: '按关键词搜条目，只给摘要',
    model_description:
      '在世界书里按关键词搜条目，只返回命中摘要和 uid，不返回全文。先用它定位，再用 wb_read 读全文。worlds 不填就用本轮勾选的范围；范围外的世界书搜不到，也别去试。',
    parameters: schemaObject(
      {
        keyword: schemaString('要搜的关键词，2-6 个字最好'),
        worlds: schemaArray('要搜的世界书名；不填 = 本轮选中的世界书', schemaString('世界书名')),
        limit: schemaInteger('最多返回几条，默认 20，最大 100', { minimum: 1, maximum: 100 }),
      },
      ['keyword'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const keyword = asText(args.keyword).trim();
      if (!keyword) return resultFail('没给关键词', 'wb_search 需要 keyword 参数。', 'INVALID_ARGS');
      const limit = asInt(args.limit, 20, 1, 100);
      const allowed = allowedWorlds(ctx);
      if (!allowed.length) return resultFail('超出范围', outOfScopeError(allowed, asTextArray(args.worlds).join('、')), 'SCOPE_DENIED');
      let worlds = asTextArray(args.worlds);
      if (worlds.length) {
        const outside = worlds.filter(name => !allowed.includes(name));
        if (outside.length) return resultFail('超出范围', outOfScopeError(allowed, outside[0]), 'SCOPE_DENIED');
      }
      if (!worlds.length) worlds = allowed;
      const hits = await ctx.wb.search(worlds, keyword, limit);
      if (!hits.length)
        return resultOk('没命中', '关键词「' + keyword + '」在 ' + worlds.join('、') + ' 里没有命中任何条目。');
      const lines = hits.map(
        hit =>
          '- ' +
          hit.world +
          ' · uid ' +
          hit.uid +
          ' · ' +
          (hit.name || '(无标题)') +
          '（命中 ' +
          hit.hits +
          ' 次）：' +
          hit.snippet.replace(/\s+/g, ' ').trim(),
      );
      return resultOk(
        '命中 ' + hits.length + ' 条',
        '关键词「' + keyword + '」在 ' + worlds.join('、') + ' 命中 ' + hits.length + ' 条：\n' + lines.join('\n'),
      );
    },
  };

  const wbRead: ToolDef = {
    name: 'wb_read',
    group: 'knowledge',
    title: '读条目',
    desc: '按 uid 读，或分页读全本',
    model_description:
      '读条目正文。给 uid（或 uids）就读指定条目；不给 uid 就按 offset/limit 分页读整本世界书（返回里有 [分页] 一行，按 next_offset 继续读）。只能读本次勾选范围内的世界书；改之前一定要先读。',
    parameters: schemaObject({
      world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
      uid: schemaString('要读的条目 uid（单个）'),
      uids: schemaArray('要读的条目 uid 列表（批量）', schemaString('条目 uid')),
      offset: schemaInteger('从第几条开始（0 起），默认 0', { minimum: 0 }),
      limit: schemaInteger('这一页读几条，默认 ' + PAGE_LIMIT_DEFAULT + '，最大 ' + PAGE_LIMIT_MAX, {
        minimum: 1,
        maximum: PAGE_LIMIT_MAX,
      }),
      max_content: schemaInteger('每条正文最多给多少字，默认 ' + CONTENT_LIMIT_DEFAULT, {
        minimum: 200,
        maximum: 20000,
      }),
      with_index: schemaBoolean('额外附上本世界书的 uid+标题索引，方便挑 uid，默认 false'),
    }),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWorld(ctx, args.world);
      if (pick.error || !pick.world) return resultFail('没指定世界书', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const world = pick.world;
      const maxContent = asInt(args.max_content, CONTENT_LIMIT_DEFAULT, 200, 20000);
      const uidArg = asText(args.uid).trim();
      const uids = uidArg ? [uidArg] : asTextArray(args.uids);
      let entries: WbEntry[];
      let total: number;
      let offset = 0;
      let limit: number;
      let paged = false;
      if (uids.length) {
        entries = await ctx.wb.readByUid(world, uids);
        total = entries.length;
        limit = entries.length || uids.length;
        if (!entries.length) {
          return resultFail(
            '没找到 uid ' + uids.join('、'),
            '世界书「' +
              world +
              '」里没有 ' +
              uids.join('、') +
              ' 这些 uid。先用 wb_search 或带 with_index 的 wb_read 找 uid。',
          );
        }
      } else {
        paged = true;
        const all = await ctx.wb.readAll(world);
        total = all.length;
        offset = asInt(args.offset, 0, 0);
        limit = asInt(args.limit, PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX);
        entries = all.slice(offset, offset + limit);
      }
      const body = entries.length
        ? entries.map((entry, index) => renderEntry(entry, offset + index, maxContent)).join('\n\n')
        : '（空）';
      const parts = [headLine(world, total, offset, entries.length), '', body];
      if (paged) parts.push('', pageTrailer(total, offset, limit));
      if (asBool(args.with_index, false)) {
        const all = paged ? await ctx.wb.readAll(world) : null;
        const indexLines = (all ?? []).map((entry, i) => i + 1 + '. ' + entry.uid + ' · ' + (entry.name || '(无标题)'));
        if (indexLines.length) parts.push('', 'uid 索引（共 ' + indexLines.length + ' 条）：' + indexLines.join(' | '));
      }
      return resultOk(entries.length ? '读到 ' + entries.length + ' 条' : '这一页是空的', parts.join('\n'));
    },
  };

  const entryCreate: ToolDef = {
    name: 'entry_create',
    group: 'write',
    title: '新建条目',
    desc: '在世界书里加一条新条目',
    model_description:
      '新建一条世界书条目。内容只进草稿，等用户确认后才写回酒馆。strategy=constant 是蓝灯常驻，selective 是绿灯按关键词触发（绿灯记得给 keys）。',
    parameters: schemaObject(
      {
        world: schemaString('写进哪本世界书；不填 = 本轮只选中一本时用那本'),
        name: schemaString('条目标题（TavernHelper 里的 comment）'),
        content: schemaString('条目正文'),
        strategy: schemaString(
          '激活策略：constant（蓝灯常驻）/ selective（绿灯关键词）/ vectorized（向量化），默认 selective',
          {
            enum: ['constant', 'selective', 'vectorized'],
          },
        ),
        constant: schemaBoolean('简写：true 等价于 strategy=constant'),
        keys: schemaArray('绿灯触发关键词', schemaString('关键词')),
        keys_secondary: schemaObject(
          {
            logic: schemaString('次关键词逻辑：and_any / and_all / not_all / not_any', {
              enum: ['and_any', 'and_all', 'not_all', 'not_any'],
            }),
            keys: schemaArray('次关键词列表', schemaString('关键词')),
          },
          [],
          '次级触发关键词（TavernHelper 的 keys_secondary）：logic 是多个次关键词之间怎么组合，keys 是关键词本身',
        ),
        scan_depth: schemaInteger('扫描深度；不填 = 跟随全局'),
        enabled: schemaBoolean('是否启用，默认 true'),
        position: schemaInteger('插入位置，原值直传，默认 0'),
        depth: schemaInteger('深度，默认 4'),
        order: schemaInteger('顺序，默认 100'),
      },
      ['name', 'content'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWriteWorld(ctx, args.world);
      if (pick.error || !pick.world) return resultFail('不能写', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const name = asText(args.name).trim();
      if (!name) return resultFail('新建条目必须有 name', 'entry_create 需要 name（条目标题）。', 'INVALID_ARGS');
      const content = asText(args.content);
      const strategy = asStrategy(args.strategy, 'constant' in args, args.constant);
      const payload: Record<string, unknown> = {
        name,
        content,
        strategy,
        keys: asTextArray(args.keys),
        enabled: asBool(args.enabled, true),
        position: asInt(args.position, 0),
        depth: asInt(args.depth, 4),
        order: asInt(args.order, 100),
        keys_secondary: {
          logic: asText((args.keys_secondary as Record<string, unknown> | undefined)?.logic).trim() || 'and_any',
          keys: asTextArray((args.keys_secondary as Record<string, unknown> | undefined)?.keys),
        },
      };
      if (
        'scan_depth' in args &&
        args.scan_depth !== null &&
        args.scan_depth !== undefined &&
        asText(args.scan_depth) !== ''
      ) {
        payload.scan_depth =
          asText(args.scan_depth) === 'same_as_global' ? 'same_as_global' : asInt(args.scan_depth, 4);
      }
      const entryUid = asText(args.uid).trim() || newEntryUid();
      pushDraft(ctx, {
        kind: 'create',
        world: pick.world,
        uid: entryUid,
        label: name,
        before: '',
        after: content,
        payload,
      });
      const diff = formatDiff(lineDiff('', content), { only_changed: true });
      return resultOk(
        '草稿 · 新建「' + name + '」',
        '已把新条目放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
          pick.world +
          '\nuid：' +
          entryUid +
          '\n标题：' +
          name +
          '\n策略：' +
          strategyLabel(strategy) +
          '\n' +
          ((payload.keys as string[]).length ? '关键词：' + (payload.keys as string[]).join('、') + '\n' : '') +
          '\n' +
          clip(diff, 2000),
      );
    },
  };

  const entryEdit: ToolDef = {
    name: 'entry_edit',
    group: 'write',
    title: '改条目',
    desc: 'old_string → new_string 精确替换',
    model_description:
      '精确替换条目正文里的一段文字：把 old_string 原样改成 new_string，其余一个字都不动，禁止整条重写。old_string 必须先在正文里出现过；如果命中多处又不唯一，就多给几句上下文让它唯一，或者显式传 replace_all=true。改之前先 wb_read。改动只进草稿，等用户确认。',
    parameters: schemaObject(
      {
        world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
        uid: schemaString('要改的条目 uid'),
        old_string: schemaString('要替换掉的原文片段，必须和正文一字不差'),
        new_string: schemaString('替换成的新文字；空串表示删掉这段'),
        replace_all: schemaBoolean('old_string 命中多处时是否全部替换，默认 false（不唯一就报错）'),
      },
      ['uid', 'old_string', 'new_string'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWriteWorld(ctx, args.world);
      if (pick.error || !pick.world) return resultFail('不能改', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const entryUid = asText(args.uid).trim();
      if (!entryUid) return resultFail('没给 uid', 'entry_edit 需要 uid；先用 wb_search / wb_read 找到 uid。', 'INVALID_ARGS');
      const oldString = asText(args.old_string);
      const newString = asText(args.new_string);
      if (!oldString)
        return resultFail('old_string 不能为空', 'entry_edit 必须给出要被替换的原文（old_string），不能整条重写。', 'INVALID_ARGS');
      const found = await ctx.wb.readByUid(pick.world, [entryUid]);
      if (!found.length)
        return resultFail(
          '没找到 uid ' + entryUid,
          '世界书「' + pick.world + '」里没有 uid ' + entryUid + '，先用 wb_read 看看。',
        );
      const entry = found[0];
      const before = entry.content;
      const count = countOccurrences(before, oldString);
      if (count === 0) {
        return resultFail(
          'old_string 在正文里找不到',
          'uid ' +
            entryUid +
            '（' +
            (entry.name || '无标题') +
            '）的正文里没有这段文字。原文片段必须一字不差。\n先 wb_read 把正文读出来再改。\n你给的 old_string：\n' +
            clip(oldString, 400),
        );
      }
      const replaceAll = asBool(args.replace_all, false);
      if (count > 1 && !replaceAll) {
        return resultFail(
          'old_string 命中 ' + count + ' 处，不唯一',
          'uid ' +
            entryUid +
            ' 里「' +
            clip(oldString, 80, '…') +
            '」出现了 ' +
            count +
            ' 次。要么把 old_string 前后多带几句让它唯一，要么显式 replace_all=true 全换掉。',
        );
      }
      // 两个分支都必须按**字面量**替换：String.replace(old, new) 会把 new_string 里的
      // $& / $1 / $' / $$ 当成替换模式，跟 replace_all 的 split/join 语义不一致。
      const after = before.split(oldString).join(newString);
      if (after === before)
        return resultFail('内容没有变化', 'old_string 和 new_string 一样，这次替换没有产生任何改动。');
      const diff = lineDiff(before, after);
      const stat = diffStat(diff);
      pushDraft(ctx, {
        kind: 'edit',
        world: pick.world,
        uid: entryUid,
        label: entry.name || entryUid,
        before,
        after,
        payload: {
          old_string: oldString,
          new_string: newString,
          replace_all: replaceAll,
          add: stat.add,
          del: stat.del,
        },
      });
      return resultOk(
        'uid ' + entryUid + ' · ' + formatStat(stat),
        '已把改动放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
          pick.world +
          '\nuid：' +
          entryUid +
          '（' +
          (entry.name || '无标题') +
          '）\n替换 ' +
          (replaceAll ? count : 1) +
          ' 处，' +
          formatStat(stat) +
          '\n\ndiff：\n' +
          formatDiff(changedLines(diff)) +
          '\n\n改后的正文：\n' +
          clip(after, 3000),
      );
    },
  };

  const entryDelete: ToolDef = {
    name: 'entry_delete',
    group: 'write',
    title: '删条目',
    desc: '删掉一条条目',
    model_description:
      '删除一条世界书条目。删之前先 wb_read 确认 uid 和标题对得上；不确定时先 ask_user。删除只进草稿，等用户确认。',
    parameters: schemaObject(
      {
        world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
        uid: schemaString('要删的条目 uid'),
        expect_name: schemaString('可选：条目标题，填了就必须和实际标题一致，防删错'),
      },
      ['uid'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWriteWorld(ctx, args.world);
      if (pick.error || !pick.world) return resultFail('不能删', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const entryUid = asText(args.uid).trim();
      if (!entryUid) return resultFail('没给 uid', 'entry_delete 需要 uid。', 'INVALID_ARGS');
      const found = await ctx.wb.readByUid(pick.world, [entryUid]);
      if (!found.length)
        return resultFail('没找到 uid ' + entryUid, '世界书「' + pick.world + '」里没有 uid ' + entryUid + '。', 'NOT_FOUND');
      const entry = found[0];
      const expect = asText(args.expect_name).trim();
      if (expect && expect !== entry.name) {
        return resultFail(
          '标题对不上，先别删',
          '你给的 expect_name「' + expect + '」和实际标题「' + entry.name + '」不一致，删之前先 wb_read 确认。',
        );
      }
      pushDraft(ctx, {
        kind: 'delete',
        world: pick.world,
        uid: entryUid,
        label: entry.name || entryUid,
        before: entry.content,
        after: '',
        payload: { name: entry.name, uid: entryUid },
      });
      return resultOk(
        '草稿 · 删除「' + (entry.name || entryUid) + '」',
        '已把删除放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
          pick.world +
          '\nuid：' +
          entryUid +
          '\n标题：' +
          (entry.name || '(无标题)') +
          '\n\n原正文（删掉后要恢复就用它）：\n' +
          clip(entry.content, 2000),
      );
    },
  };

  const entryMeta: ToolDef = {
    name: 'entry_meta',
    group: 'write',
    title: '改条目属性',
    desc: '改蓝绿灯 / 深度 / 关键词 / 顺序',
    model_description:
      '只改条目的属性，不碰正文：蓝绿灯（constant）、触发关键词（keys）、深度（depth）、顺序（order）、插入位置（position）、开关（enabled）、标题（name）。只传要改的字段。默认关闭，仅在用户明确要求调整这些属性时才会开。',
    parameters: schemaObject(
      {
        world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
        uid: schemaString('条目 uid'),
        name: schemaString('新标题'),
        strategy: schemaString('激活策略', { enum: ['constant', 'selective', 'vectorized'] }),
        constant: schemaBoolean('简写：true = 蓝灯常驻，false = 绿灯'),
        keys: schemaArray('新的触发关键词（整组替换）', schemaString('关键词')),
        keys_secondary: schemaObject(
          {
            logic: schemaString('次关键词逻辑：and_any / and_all / not_all / not_any', {
              enum: ['and_any', 'and_all', 'not_all', 'not_any'],
            }),
            keys: schemaArray('次关键词列表（整组替换）', schemaString('关键词')),
          },
          [],
          '次级触发关键词（TavernHelper 的 keys_secondary）：只传要改的 logic / keys，整组替换',
        ),
        scan_depth: schemaString('扫描深度：整数，或 same_as_global 跟随全局'),
        enabled: schemaBoolean('条目开关'),
        position: schemaInteger('插入位置'),
        depth: schemaInteger('深度'),
        order: schemaInteger('顺序'),
      },
      ['uid'],
    ),
    default_on: false,
    run: async (args, ctx) => {
      const pick = resolveWriteWorld(ctx, args.world);
      if (pick.error || !pick.world) return resultFail('不能改', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const entryUid = asText(args.uid).trim();
      if (!entryUid) return resultFail('没给 uid', 'entry_meta 需要 uid。', 'INVALID_ARGS');
      const found = await ctx.wb.readByUid(pick.world, [entryUid]);
      if (!found.length)
        return resultFail('没找到 uid ' + entryUid, '世界书「' + pick.world + '」里没有 uid ' + entryUid + '。', 'NOT_FOUND');
      const entry = found[0];
      const fields: Record<string, unknown> = {};
      if ('name' in args) fields.name = asText(args.name);
      if ('strategy' in args || 'constant' in args)
        fields.strategy = asStrategy(args.strategy, 'constant' in args, args.constant);
      if ('keys' in args) fields.keys = asTextArray(args.keys);
      if ('keys_secondary' in args) {
        fields.keys_secondary = {
          logic:
            asText((args.keys_secondary as Record<string, unknown> | undefined)?.logic).trim() ||
            entry.keys_secondary.logic,
          keys: asTextArray((args.keys_secondary as Record<string, unknown> | undefined)?.keys),
        };
      }
      if ('scan_depth' in args)
        fields.scan_depth =
          asText(args.scan_depth) === 'same_as_global'
            ? 'same_as_global'
            : asInt(args.scan_depth, entry.scan_depth === 'same_as_global' ? 4 : entry.scan_depth);
      if ('enabled' in args) fields.enabled = asBool(args.enabled, entry.enabled);
      if ('position' in args) fields.position = asInt(args.position, entry.position);
      if ('depth' in args) fields.depth = asInt(args.depth, entry.depth);
      if ('order' in args) fields.order = asInt(args.order, entry.order);
      if (!Object.keys(fields).length) {
        return resultFail(
          '没给要改的字段',
          'entry_meta 至少要传 name / strategy / keys / keys_secondary / scan_depth / enabled / position / depth / order 里的一个。',
        );
      }
      const beforeFields: Record<string, unknown> = {};
      for (const key of Object.keys(fields)) {
        beforeFields[key] = (entry as unknown as Record<string, unknown>)[key];
      }
      pushDraft(ctx, {
        kind: 'meta',
        world: pick.world,
        uid: entryUid,
        label: entry.name || entryUid,
        before: encodeMetaFields(beforeFields),
        after: encodeMetaFields(fields),
        payload: { ...fields, before_fields: beforeFields },
      });
      return resultOk(
        '草稿 · 属性「' + (entry.name || entryUid) + '」',
        '已把属性改动放进草稿（还没有写回酒馆）。\n世界书：' +
          pick.world +
          '\nuid：' +
          entryUid +
          '\n\n' +
          formatDiff(changedLines(lineDiff(encodeMetaFields(beforeFields), encodeMetaFields(fields)))),
      );
    },
  };

  return [wbList, wbSearch, wbRead, entryCreate, entryEdit, entryDelete, entryMeta];
}

/** 供 UI 预览用：把一条条目渲染成 wb_read 里的那种文本 */
export function previewEntry(entry: WbEntry, index = 0, maxContent = CONTENT_LIMIT_DEFAULT): string {
  return renderEntry(entry, index, maxContent);
}

/** 供 UI 用：把一段正文的改动写成人看的 +/- 文本 */
export function previewDiff(before: string, after: string): string {
  return formatDiff(changedLines(lineDiff(before, after)));
}