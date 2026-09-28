/**
 * 世界书插件的 **5 个工具**：wb_list / wb_outline / wb_read / wb_search / wb_write
 *
 * ── 这一版相对上一版的改动（B15-B19，用户已批设计稿）──
 *
 *  | 旧 | 新 | 为什么 |
 *  |---|---|---|
 *  | `wb_list` / `wb_search` / `wb_read` | 保留 | 名字够清楚 |
 *  | — | **`wb_outline`** ★ 新增 | 219 条的书要的是「看清结构」，不是「第 1-20 条」 |
 *  | `entry_create`+`entry_edit`+`entry_delete`+`entry_meta` | **`wb_write`** 合并 | 一个工具 = 一个人真的会做的动作，不是一套 API 一个工具 |
 *
 * **三条设计原则**（用户定的）：
 *  1. **工具摆数据，skill 教判断** —— 工具里不放任何「结论」。
 *     所以 `wb_outline` **不标**「死条目 / 单字关键词 / 重名」——
 *     那是判断，交给模型 + `世界书工程` skill。
 *  2. **提示词只写三件事**：干什么 / 什么时候用 / 返回什么。
 *     领域知识（蓝绿灯语义、position 8 个位置、预算机制）全进 skill，不进工具描述。
 *  3. **必填最少，其余走默认** —— 1788 条真实数据里绝大多数只用
 *     `comment`/`content`/`key`/`constant`。
 *
 * **两条铁律不变**：
 *  1) 所有写操作只落草稿，不碰真数据（真写入由 agent/draft.ts 的 apply() 调 WorldbookPort.writeAll）；
 *  2) 改之前先读 —— 由 agent/guards.ts 的 observe-guard 强制执行。
 *
 * **端口注入口径（阶段 3 契约）**：`contributes.tools` 是**静态** ToolDef[]，模块加载时拿不到宿主对象，
 * 所以 `createWorldbookTools()` 是**零参**的，工具一律从 `ctx.wb` 取世界书端口。
 */
import type { ToolContext, ToolDef, ToolErrorCode, WbEntry } from '../../../core/ports.ts';
import { uid, type DraftChange, type DraftKind } from '../../../core/types.ts';
import { changedLines, formatDiff, lineDiff } from '../../../agent/draft.ts';
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

/* ============================ position / 字段渲染（wb_read 用）============================ */

/**
 * position 的数字 → 人话。
 *
 * 表来自 TavernWeave 手册 §6.2（`references/注入位置与顺序.md`），**照抄不解释** ——
 * 工具只负责把数字翻译成名字，不负责教「该用哪个」（那是 skill 的事）。
 * 未知值原样显示数字，不猜（真实数据里 position 只出现过 0/1/3/4）。
 */
const POSITION_LABELS: Record<number, string> = {
  0: '角色定义之前',
  1: '角色定义之后',
  2: '作者注顶部',
  3: '作者注底部',
  4: '系统深度（at_depth）',
  5: '示例消息之前',
  6: '示例消息之后',
  7: 'Outlet',
};

function positionLabel(position: number): string {
  return POSITION_LABELS[position] ?? '未知位置';
}

/** 条目类型的人话（wb_read 的「类型:」一行） */
function typeLabel(entry: WbEntry): string {
  if (entry.strategy === 'constant') return '常亮（蓝灯，每轮都进 prompt）';
  if (entry.strategy === 'vectorized') return '向量化（按向量相似度触发）';
  if (!entry.keys.length) return '关键词触发（绿灯）—— ⚠️ 但没给关键词';
  return '关键词触发（绿灯）';
}

/**
 * 高级字段：从 `extra` 里挑出「模型读了 skill 之后可能会想去改」的那几个。
 *
 * ⚠️ **只列存在的**。真实数据里 `group` 用了 **0 次**、`probability` 只有 2 条不是 100 ——
 * 所以绝大多数条目这一行是空的，不会平白占上下文。
 */
const ADVANCED_FIELDS: Array<[string, string]> = [
  ['group', '分组'],
  ['group_weight', '分组权重'],
  ['sticky', '粘住轮数'],
  ['cooldown', '冷却轮数'],
  ['delay', '延迟轮数'],
  ['probability', '触发概率'],
  ['useProbability', '用概率'],
  ['role', '注入角色'],
  ['matchWholeWords', '全词匹配'],
  ['excludeRecursion', '禁止递归'],
  ['preventRecursion', '阻止递归'],
  ['delayUntilRecursion', '延迟到递归'],
  ['automationId', '自动化 id'],
  ['vectorized', '向量化'],
  ['selectiveLogic', '次关键词逻辑'],
];

function renderAdvancedFields(entry: WbEntry): string {
  const extra = (entry.extra ?? {}) as Record<string, unknown>;
  const shown: string[] = [];
  for (const [key, label] of ADVANCED_FIELDS) {
    const value = extra[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean' && value === false) continue; // false 是默认值，不占行
    shown.push(label + '=' + (typeof value === 'object' ? JSON.stringify(value) : String(value)));
  }
  return shown.join(' · ');
}

/**
 * `wb_read` 的单条渲染 —— **删掉 wb_check 之后，判定所需的全部信息必须在这里摆全**。
 *
 * 判定依据全在字段上（用户指正原话：「能不能触发只需要了解世界书是否开启、蓝绿灯、key
 * 就可以判断出来」），所以这里把 开/类型/主关键词/次关键词/扫描深度/概率/位置/顺序 全列出来，
 * 让模型**自己**判断，而不是给一个「能不能触发」的结论。
 */
export function renderEntryDetailed(entry: WbEntry, index: number, maxContent: number): string {
  const extra = (entry.extra ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  lines.push('[' + (index + 1) + '] uid=' + entry.uid + '  「' + (entry.name || '(无标题)') + '」');
  lines.push('');
  lines.push('正文：');
  lines.push(clip(entry.content, maxContent, '\n…（正文已截断，用 max_content 调大）') || '(空)');
  lines.push('');
  lines.push('────────────────────────');
  lines.push('启用：      ' + (entry.enabled ? '是' : '否'));
  lines.push('类型：      ' + typeLabel(entry));
  lines.push('主关键词：  ' + (entry.keys.length ? JSON.stringify(entry.keys) : '（无）'));
  lines.push(
    '次关键词：  ' +
      (entry.keys_secondary.keys.length
        ? entry.keys_secondary.logic + ' ' + JSON.stringify(entry.keys_secondary.keys)
        : '（无）'),
  );
  lines.push(
    '扫描深度：  ' +
      (entry.scan_depth === 'same_as_global' ? '跟随全局（当前 ' + GLOBAL_SCAN_DEPTH_HINT + '）' : String(entry.scan_depth) + ' 楼'),
  );
  const probability = extra.probability;
  lines.push('概率：      ' + (probability === undefined || probability === null ? '100%' : String(probability) + '%'));
  lines.push('位置：      ' + positionLabel(entry.position) + ' (pos=' + entry.position + ')');
  lines.push('顺序：      ' + entry.order + '（越大越靠近最新消息）');
  if (entry.position === 4) lines.push('深度：      ' + entry.depth + ' 楼');

  const advanced = renderAdvancedFields(entry);
  if (advanced) lines.push('[高级字段] ' + advanced);

  // 「一个字段都不丢」的承诺要有据可查：告诉模型还剩几个没列出来的扩展字段
  const known = new Set(['probability', ...ADVANCED_FIELDS.map(([key]) => key)]);
  const rest = Object.keys(extra).filter(key => !known.has(key));
  if (rest.length) lines.push('[其他字段] 本条目还有 ' + rest.length + ' 个扩展字段，已原样保留（写回时不会丢）');

  return lines.join('\n');
}

/**
 * 「跟随全局」时全局扫描深度是多少楼。
 *
 * ⚠️ 这是个**提示**，不是权威值：真实值在酒馆的 `world_info_depth` 里，
 * 而那个字段在 ST 1.18.0 上取不到（原生 `extensionSettings` 没有 world_info）。
 * 实测本机是 2（手册说 4 是 DEFAULT_DEPTH，不是当前值）。
 * 所以文案写「当前 2」时带「（本机实测）」口径，读不到就不显示这个提示。
 */
const GLOBAL_SCAN_DEPTH_HINT = '2 楼（本机实测）';

/* ============================ wb_outline 用：分节 ============================ */

/**
 * 人类的分节约定：`====分节名====_开始` / `====分节名====_结束` 成对出现。
 *
 * 真实制卡人就是这么组织大书的（`我的苍玄界` 219 条里用了多组）。
 * **配对**才认：只有 `_开始` 没有 `_结束` 时，那对条目按普通条目处理 ——
 * 免得一个手滑的标题把后面几百条全吞进一个假分节里。
 */
const SECTION_OPEN = /^={2,}\s*(.+?)\s*={2,}\s*_?开始/;
const SECTION_CLOSE = /^={2,}\s*(.+?)\s*={2,}\s*_?结束/;

export interface OutlineSection {
  /** 分节名；'' 表示「分节之外」的条目 */
  name: string;
  entries: WbEntry[];
}

/**
 * 把一本书切成若干节（纯函数，可单测）。
 *
 * 分节标记条目**本身也进列表**（真实数据里它们是带 `[mvu_plot]` 前缀的真实条目，
 * 藏起来反而让模型对不上号），只是同时充当分节边界。
 */
export function groupIntoSections(entries: WbEntry[]): OutlineSection[] {
  const sections: OutlineSection[] = [];
  let current: OutlineSection = { name: '', entries: [] };
  // 先扫一遍：哪些分节名是**成对**的（只有成对才当分节）
  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  for (const entry of entries) {
    const open = SECTION_OPEN.exec(entry.name.trim());
    if (open) opens.set(open[1], (opens.get(open[1]) ?? 0) + 1);
    const close = SECTION_CLOSE.exec(entry.name.trim());
    if (close) closes.set(close[1], (closes.get(close[1]) ?? 0) + 1);
  }
  const paired = new Set<string>();
  for (const [name, count] of opens) if ((closes.get(name) ?? 0) > 0 && count > 0) paired.add(name);

  for (const entry of entries) {
    const trimmed = entry.name.trim();
    const open = SECTION_OPEN.exec(trimmed);
    if (open && paired.has(open[1])) {
      if (current.entries.length || current.name) sections.push(current);
      current = { name: open[1], entries: [entry] };
      continue;
    }
    current.entries.push(entry);
    const close = SECTION_CLOSE.exec(trimmed);
    if (close && paired.has(close[1]) && current.name === close[1]) {
      sections.push(current);
      current = { name: '', entries: [] };
    }
  }
  if (current.entries.length || current.name) sections.push(current);
  return sections;
}

/** 一行条目：`标题  1601字  绿 keys=["江念"]  pos0` —— 只摆字段，不做任何标记 */
function outlineLine(entry: WbEntry): string {
  const state = entry.enabled ? '' : '停用  ';
  const size = String(entry.content.length) + '字';
  let kind: string;
  if (!entry.enabled) kind = '';
  else if (entry.strategy === 'constant') kind = '蓝';
  else if (entry.strategy === 'vectorized') kind = '向量';
  else kind = '绿';
  const keys = entry.keys.length ? ' keys=' + JSON.stringify(entry.keys) : ' keys=[]';
  const depth = entry.position === 4 ? ' depth' + entry.depth : '';
  return (
    '  ' +
    state +
    (entry.name || '(无标题)') +
    '  ' +
    size +
    '  ' +
    kind +
    (kind ? keys : '') +
    '  pos' +
    entry.position +
    depth +
    '  order' +
    entry.order
  );
}

/** 一节的小结：`(23 条 · 21 绿灯)` —— 数出来的，不是判断出来的 */
function sectionSummary(section: OutlineSection): string {
  const total = section.entries.length;
  const blue = section.entries.filter(entry => entry.enabled && entry.strategy === 'constant').length;
  const green = section.entries.filter(
    entry => entry.enabled && entry.strategy !== 'constant' && entry.strategy !== 'vectorized',
  ).length;
  const off = section.entries.filter(entry => !entry.enabled).length;
  const parts = [String(total) + ' 条'];
  if (blue) parts.push(String(blue) + ' 蓝灯');
  if (green) parts.push(String(green) + ' 绿灯');
  if (off) parts.push(String(off) + ' 停用');
  return '(' + parts.join(' · ') + ')';
}

/** 渲染整本 outline（纯函数，可单测） */
export function renderOutline(world: string, entries: WbEntry[]): string {
  const sections = groupIntoSections(entries);
  const lines: string[] = ['《' + world + '》 ' + entries.length + ' 条'];
  for (const section of sections) {
    if (section.name) lines.push('├─ ====' + section.name + '==== ' + sectionSummary(section));
    else if (sections.length > 1) lines.push('├─ （分节之外） ' + sectionSummary(section));
    for (const entry of section.entries) lines.push(outlineLine(entry));
  }
  return lines.join('\n');
}

/* ============================ 5 个工具 ============================ */
export function createWorldbookTools(): ToolDef[] {
  /* ------------------------------------------------------------------ wb_list */

  const wbList: ToolDef = {
    name: 'wb_list',
    group: 'knowledge',
    title: '列世界书',
    desc: '列出酒馆里的世界书',
    model_description: '列出酒馆里的世界书。不确定用户指哪本时先调它。',
    parameters: schemaObject({
      in_scope_only: schemaBoolean('只列本次勾选范围内的世界书，默认 false 列全部'),
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
      const shown = inScopeOnly ? scopes.filter(item => allowedSet.has(item.name)) : scopes;
      const rows: string[] = [];
      for (const item of shown) {
        let stat = '（条目数读不到）';
        try {
          const entries = await ctx.wb.readAll(item.name);
          const enabled = entries.filter(entry => entry.enabled).length;
          stat = entries.length + ' 条，启用 ' + enabled;
        } catch {
          stat = '（条目数读不到）';
        }
        const writable = allowedSet.has(item.name) ? '' : '（不在本次范围，不可读写）';
        rows.push('- ' + item.name + ' —— ' + item.label + '　' + stat + writable);
      }

      if (!rows.length) {
        return resultOk(
          inScopeOnly ? '本次范围内没有世界书' : '酒馆里没有任何世界书',
          inScopeOnly
            ? '本次勾选范围内没有世界书。' + scopeEmptyNotice()
            : '酒馆里读不到任何世界书。可能世界书功能没开，可以让用户确认一下。',
        );
      }

      return resultOk('世界书 ' + rows.length + ' 本 · 可读写 ' + allowed.length + ' 本', rows.join('\n'));
    },
  };

  /* --------------------------------------------------------------- wb_outline */

  const wbOutline: ToolDef = {
    name: 'wb_outline',
    group: 'knowledge',
    title: '看结构',
    desc: '看一本书的结构',
    model_description: '看一本书的结构：分节、每节条目、每条的状态。改之前先看它。',
    parameters: schemaObject({
      world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
      max_entries: schemaInteger('最多列多少条，默认 500（一本 219 条的书一屏看完）', {
        minimum: 1,
        maximum: 5000,
      }),
    }),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWorld(ctx, args.world);
      if (pick.error || !pick.world)
        return resultFail('没指定世界书', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');

      const all = await ctx.wb.readAll(pick.world);
      if (!all.length) {
        return resultOk('《' + pick.world + '》是空的', '世界书「' + pick.world + '」里一条条目都没有。');
      }
      const maxEntries = asInt(args.max_entries, 500, 1, 5000);
      const entries = all.slice(0, maxEntries);
      const text = renderOutline(pick.world, entries);
      const trailer =
        all.length > entries.length
          ? '\n\n（只列了前 ' + entries.length + ' 条，共 ' + all.length + ' 条；用 max_entries 调大）'
          : '';
      return resultOk('《' + pick.world + '》 ' + all.length + ' 条', text + trailer);
    },
  };

  /* ---------------------------------------------------------------- wb_search */

  const wbSearch: ToolDef = {
    name: 'wb_search',
    group: 'knowledge',
    title: '搜条目',
    desc: '按关键词找条目',
    model_description: '按关键词找条目。',
    parameters: schemaObject(
      {
        keyword: schemaString('要搜的关键词'),
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
      if (!allowed.length)
        return resultFail('超出范围', outOfScopeError(allowed, asTextArray(args.worlds).join('、')), 'SCOPE_DENIED');
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

  /* ------------------------------------------------------------------ wb_read */

  const wbRead: ToolDef = {
    name: 'wb_read',
    group: 'knowledge',
    title: '读条目',
    desc: '读条目',
    model_description: '读条目。改之前一定要读。',
    parameters: schemaObject({
      world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
      uids: schemaArray('要读的条目 uid 列表（可批量）', schemaString('条目 uid')),
      offset: schemaInteger('从第几条开始（0 起），默认 0；只在没给 uids 时有意义', { minimum: 0 }),
      limit: schemaInteger('这一页读几条，默认 ' + PAGE_LIMIT_DEFAULT + '，最大 ' + PAGE_LIMIT_MAX, {
        minimum: 1,
        maximum: PAGE_LIMIT_MAX,
      }),
      max_content: schemaInteger('每条正文最多给多少字，默认 ' + CONTENT_LIMIT_DEFAULT, {
        minimum: 200,
        maximum: 20000,
      }),
    }),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWorld(ctx, args.world);
      if (pick.error || !pick.world)
        return resultFail('没指定世界书', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const world = pick.world;
      const maxContent = asInt(args.max_content, CONTENT_LIMIT_DEFAULT, 200, 20000);
      const uids = asTextArray(args.uids).map(value => asText(value).trim()).filter(Boolean);

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
              ' 这些 uid。先用 wb_search 或 wb_outline 找 uid。',
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
        ? entries.map((entry, index) => renderEntryDetailed(entry, offset + index, maxContent)).join('\n\n')
        : '（空）';
      const parts = [headLine(world, total, offset, entries.length), '', body];
      if (paged) parts.push('', pageTrailer(total, offset, limit));
      return resultOk(entries.length ? '读到 ' + entries.length + ' 条' : '这一页是空的', parts.join('\n'));
    },
  };

  /* ----------------------------------------------------------------- wb_write */

  const wbWrite: ToolDef = {
    name: 'wb_write',
    group: 'write',
    title: '写条目',
    desc: '新建 / 修改 / 删除条目',
    model_description: '新建、修改或删除世界书条目。改完要回读确认。',
    parameters: schemaObject(
      {
        world: schemaString('世界书名；不填 = 本轮只选中一本时用那本'),
        action: schemaString('要做什么：create 新建 / update 修改 / delete 删除', {
          enum: ['create', 'update', 'delete'],
        }),
        uid: schemaString('update / delete 必填：条目 uid'),
        content: schemaString('正文；create 必填，update 时给了就整条替换'),
        name: schemaString('标题'),
        keys: schemaArray('触发关键词（绿灯用）', schemaString('关键词')),
        constant: schemaBoolean('true = 常亮（蓝灯，每轮都进 prompt）；false = 按关键词触发'),
        depth: schemaInteger('深度（只在 position=4 时有意义）'),
        position: schemaInteger('插入位置 0-7'),
        order: schemaInteger('顺序；越大越靠近最新消息'),
        enabled: schemaBoolean('是否启用'),
      },
      ['action'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const pick = resolveWriteWorld(ctx, args.world);
      if (pick.error || !pick.world)
        return resultFail('不能写', pick.error ?? '需要 world 参数。', pick.code ?? 'INVALID_ARGS');
      const action = asText(args.action).trim();
      if (action === 'create') return runCreate(args, ctx, pick.world);
      if (action === 'update') return runUpdate(args, ctx, pick.world);
      if (action === 'delete') return runDelete(args, ctx, pick.world);
      return resultFail(
        'action 不认识',
        'wb_write 的 action 只能是 create / update / delete，你给的是「' + action + '」。',
        'INVALID_ARGS',
      );
    },
  };

  return [wbList, wbOutline, wbRead, wbSearch, wbWrite];
}

/* ============================ wb_write 的三个动作 ============================ */

/** 把「填了才改」的可选字段收成一份 patch（不填的键不出现在结果里） */
function collectPatch(args: Record<string, unknown>, entry?: WbEntry): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('name' in args) patch.name = asText(args.name);
  if ('content' in args) patch.content = asText(args.content);
  if ('keys' in args) patch.keys = asTextArray(args.keys);
  if ('constant' in args) patch.strategy = asBool(args.constant, false) ? 'constant' : 'selective';
  if ('enabled' in args) patch.enabled = asBool(args.enabled, entry ? entry.enabled : true);
  if ('position' in args) patch.position = asInt(args.position, entry ? entry.position : 0);
  if ('depth' in args) patch.depth = asInt(args.depth, entry ? entry.depth : 4);
  if ('order' in args) patch.order = asInt(args.order, entry ? entry.order : 100);
  return patch;
}

/**
 * 死条目检查（B18）：`非蓝灯 + 无关键词 + 非向量化` = **任何消息都不会激活它**。
 *
 * ⚠️ **只警告，不拦截**（设计稿 §1.7 定案）。理由：真实数据里 4 条死条目有 2 条是
 * **故意的分节标记**（`====CG系统====_开始`），拦下来会把正常做法堵死。
 * 所以返回一句提醒，让模型自己决定要不要补关键词 —— 判断归模型，工具只摆事实。
 */
function deadEntryNotice(patch: Record<string, unknown>): string {
  const strategy = patch.strategy;
  if (strategy === 'constant' || strategy === 'vectorized') return '';
  const keys = patch.keys;
  if (Array.isArray(keys) && keys.length > 0) return '';
  return '\n\n⚠️ 这条既不是常亮、又没有关键词 —— 它不会被任何消息触发（除非它是分节标记这类骨架）。要让它生效就补 keys，或设 constant=true。';
}

async function runCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  world: string,
): Promise<ReturnType<typeof resultOk>> {
  if (!('content' in args) || !asText(args.content).trim()) {
    return resultFail('create 必须给 content', 'wb_write 的 action=create 时必须有 content（条目正文）。', 'INVALID_ARGS');
  }
  const patch = collectPatch(args);
  if (!('name' in args)) patch.name = '';
  if (!('strategy' in patch)) patch.strategy = 'selective';
  if (!('keys' in patch)) patch.keys = [];
  if (!('enabled' in patch)) patch.enabled = true;
  if (!('position' in patch)) patch.position = 0;
  if (!('depth' in patch)) patch.depth = 4;
  if (!('order' in patch)) patch.order = 100;
  patch.keys_secondary = { logic: 'and_any', keys: [] };

  const label = asText(patch.name).trim() || '(无标题)';
  const entryUid = newEntryUid();
  pushDraft(ctx, {
    kind: 'create',
    world,
    uid: entryUid,
    label,
    before: '',
    after: asText(patch.content),
    payload: patch,
  });

  return resultOk(
    '草稿 · 新建「' + label + '」',
    '已把新条目放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
      world +
      '\nuid：' +
      entryUid +
      '\n标题：' +
      label +
      '\n' +
      (patch.strategy === 'constant' ? '常亮（蓝灯）' : '关键词触发') +
      (Array.isArray(patch.keys) && (patch.keys as string[]).length
        ? '　关键词：' + (patch.keys as string[]).join('、')
        : '') +
      deadEntryNotice(patch),
  );
}

async function runUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  world: string,
): Promise<ReturnType<typeof resultOk>> {
  const entryUid = asText(args.uid).trim();
  if (!entryUid) return resultFail('update 必须给 uid', 'wb_write 的 action=update 时要指明 uid。', 'INVALID_ARGS');
  const found = await ctx.wb.readByUid(world, [entryUid]);
  if (!found.length)
    return resultFail('没找到 uid ' + entryUid, '世界书「' + world + '」里没有 uid ' + entryUid + '。', 'NOT_FOUND');
  const entry = found[0];

  const patch = collectPatch(args, entry);
  delete patch.name;
  if (!Object.keys(patch).length)
    return resultFail(
      '没给要改的字段',
      'action=update 至少要传 content / name / keys / constant / depth / position / order / enabled 里的一个。',
    );

  // 标题是单独一步（它不在 entryVersion 的正文语义里，但草稿要能显示改名）
  const newName = 'name' in args ? asText(args.name) : entry.name;
  const before = entry.content;
  const after = 'content' in patch ? asText(patch.content) : before;

  pushDraft(ctx, {
    kind: 'edit',
    world,
    uid: entryUid,
    label: newName || entryUid,
    before,
    after,
    payload: { ...patch, ...(newName !== entry.name ? { name: newName } : {}) },
  });

  const changes = Object.keys(patch)
    .map(key => key + '=' + JSON.stringify(patch[key]))
    .join(' · ');
  const merged = { ...patch };
  if (!('strategy' in merged)) merged.strategy = entry.strategy;
  if (!('keys' in merged)) merged.keys = entry.keys;

  return resultOk(
    '草稿 · 改 uid ' + entryUid + '「' + (newName || '(无标题)') + '」',
    '已把改动放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
      world +
      '\nuid：' +
      entryUid +
      '\n改了：' +
      changes +
      ('content' in patch
        ? '\n\ndiff：\n' +
          formatDiff(changedLines(lineDiff(before, after))) +
          '\n\n改后的正文：\n' +
          clip(after, 3000)
        : '') +
      deadEntryNotice(merged),
  );
}

async function runDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
  world: string,
): Promise<ReturnType<typeof resultOk>> {
  const entryUid = asText(args.uid).trim();
  if (!entryUid) return resultFail('delete 必须给 uid', 'wb_write 的 action=delete 时要指明 uid。', 'INVALID_ARGS');
  const found = await ctx.wb.readByUid(world, [entryUid]);
  if (!found.length)
    return resultFail('没找到 uid ' + entryUid, '世界书「' + world + '」里没有 uid ' + entryUid + '。', 'NOT_FOUND');
  const entry = found[0];

  // 防删错：给了 name 就必须和实际标题一致
  if ('name' in args) {
    const expect = asText(args.name).trim();
    if (expect && expect !== entry.name) {
      return resultFail(
        '标题对不上，先别删',
        '你给的 name「' + expect + '」和实际标题「' + entry.name + '」不一致，删之前先 wb_read 确认。',
      );
    }
  }

  pushDraft(ctx, {
    kind: 'delete',
    world,
    uid: entryUid,
    label: entry.name || entryUid,
    before: entry.content,
    after: '',
    payload: { name: entry.name, uid: entryUid },
  });

  return resultOk(
    '草稿 · 删除「' + (entry.name || entryUid) + '」',
    '已把删除放进草稿（还没有写回酒馆，等用户确认）。\n世界书：' +
      world +
      '\nuid：' +
      entryUid +
      '\n标题：' +
      (entry.name || '(无标题)') +
      '\n\n原正文（删掉后要恢复就用它）：\n' +
      clip(entry.content, 2000),
  );
}

/* ============================ 供 UI 用 ============================ */

/** 供 UI 预览用：把一条条目渲染成 wb_read 里的那种文本 */
export function previewEntry(entry: WbEntry, index = 0, maxContent = CONTENT_LIMIT_DEFAULT): string {
  return renderEntryDetailed(entry, index, maxContent);
}

/** 供 UI 用：把一段正文的改动写成人看的 +/- 文本 */
export function previewDiff(before: string, after: string): string {
  return formatDiff(changedLines(lineDiff(before, after)));
}