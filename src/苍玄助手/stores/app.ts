/**
 * 全局 store。持有 RootData，负责读写和所有增删改。
 * UI 只从这拿状态、只通过这改状态。
 *
 * 会话模型（v2 起是多会话）：
 *  - 唯一真源是 data.sessions + data.active_session_id
 *  - 所有会话级动作（appendTurn / upsertTurn / patchTurnText / setTurns / setRunning /
 *    resetSession / setMode）都作用于**当前会话**
 *  - data.session 是「当前会话」的活动别名（同一个对象引用），只为兼容还没迁移的调用点
 *    （App.vue / run/runner.ts / 旧 view 还在读 data.session.*）；storage 落盘时会把单数
 *    session 写成空壳，所以聊天记录不会存两份。新代码请用 activeSession / sessions。
 *
 * 事件日志与覆盖项（v3）：
 *  - 写轮次时**双写**：turns 照旧（读路径不动），同时把权威事件追加进 Session.events
 *    （appendTurn / upsertTurn / setTurns 都走 logTurnEvents）
 *  - 工具页覆盖项的唯一写入口是本文件的 setToolOverride / resetToolOverride
 *  - 草稿按会话分开：drafts 的 session_id 决定归属，addDraft 会自动盖当前会话
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { loadData, migrateRootData, saveData } from '../core/storage.ts';
import { allPages, pluginManifest } from '../plugins/registry.ts';
import type { PluginId } from '../plugins/types.ts';
import { applyBuiltins } from '../presets/builtin.ts';
// 工具覆盖项的唯一契约在 ports.ts（types.ts 只借类型做持久化校验）
import type { ToolOverride, ToolOverrideMap } from '../core/ports.ts';
import {
  DEFAULT_SESSION_TITLE,
  GLOBAL_KEY,
  GenImageConfigSchema,
  RootDataSchema,
  appendEvent as appendEventToList,
  appendEvents as appendEventsToList,
  eventTitle,
  eventsForTurn,
  makeEvent,
  makeSession,
  pickActiveSession,
  sessionTitle,
  titleFromText,
  toSessionMeta,
  uid,
  type DraftChange,
  type GenImageConfig,
  type Preset,
  type RootData,
  type Session,
  type SessionEvent,
  type SessionEventType,
  type SessionMeta,
  type Skill,
  type Turn,
} from '../core/types.ts';

/* ============================ 导出用的小工具 ============================ */

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm'（本地时区；不依赖 toLocaleString，输出稳定） */
export function formatTime(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

/** 轮次角色 → markdown 小节标题 */
const TURN_HEADINGS: Record<Turn['role'], string> = {
  user: '用户',
  assistant: '苍玄',
  tool: '工具',
};

/**
 * 会话 → markdown（聊天记录导出）。
 *
 * 形状：一级标题是会话标题，第二行是创建/更新时间与轮数，
 * 然后每个轮次一个 `## 用户` / `## 苍玄` 小节，工具调用缩进一行写成 `- 工具 名字 → 摘要`。
 * 图片只写张数（dataURL 塞进 md 会变成几 MB，不适合导出）。
 */
export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push('# ' + sessionTitle(session));
  lines.push('');
  lines.push(
    '创建：' + formatTime(session.created_at) + ' · 更新：' + formatTime(session.updated_at) + ' · 共 ' + session.turns.length + ' 轮',
  );
  lines.push('');

  for (const turn of session.turns) {
    lines.push('## ' + (TURN_HEADINGS[turn.role] ?? turn.role));
    lines.push('');

    const text = turn.text.trim();
    if (text !== '') {
      lines.push(text);
      lines.push('');
    }

    for (const call of turn.calls) {
      const brief = call.brief.trim() !== '' ? call.brief.trim() : call.ok ? '完成' : '失败';
      lines.push('  - 工具 ' + call.name + ' → ' + brief + (call.ok ? '' : '（失败）'));
    }
    if (turn.calls.length > 0) lines.push('');

    if (turn.images.length > 0) {
      lines.push('  - 图片 ' + String(turn.images.length) + ' 张（导出不含图片数据）');
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 自动保存的防抖间隔（毫秒）。
 *
 * 一次落盘 = 整份 RootData 回传酒馆（实测 46.7 MB），手机上非常贵；
 * 2.5 秒能把「打字 / 连续点按」合并成一次写，又不会让数据在内存里挂太久。
 * 长时间任务（agent 运行）不靠它，靠 holdSaves() / releaseSaves() 收成一次。
 */
export const SAVE_DEBOUNCE_MS = 2500;

export const useAppStore = defineStore('cx-assistant', () => {
  /** 初始就做一次迁移，保证 sessions 至少一条、active 指得上 */
  const data = ref<RootData>(migrateRootData(RootDataSchema.parse({})).data);
  const ready = ref(false);
  const dirty = ref(false);

  /* -------------------- 会话：读 -------------------- */

  /** 全部会话（聊天记录管理页的列表） */
  const sessions = computed<Session[]>(() => data.value.sessions);

  /** 当前会话；storage 的归一化保证 sessions 至少一条 */
  const activeSession = computed<Session>(() => pickActiveSession(data.value));

  /** 当前会话 id */
  const activeSessionId = computed<string>(() => activeSession.value.id);

  /** 当前会话的轮次（界面直接绑这个） */
  const currentSessionTurns = computed<Turn[]>(() => activeSession.value.turns);

  /** 列表页要的轻量元信息（标题 / 时间 / 轮数） */
  const sessionMetas = computed<SessionMeta[]>(() => data.value.sessions.map(toSessionMeta));

  /** 当前会话的权威事件流（记录页时间线用；旧数据是空数组，界面自己回退到 turns） */
  const currentSessionEvents = computed<SessionEvent[]>(() => activeSession.value.events);

  /** 工具页的覆盖项（只读；写路径只有 setToolOverride / resetToolOverride） */
  const toolOverrides = computed<ToolOverrideMap>(() => data.value.tool_overrides);

  /** 当前会话的草稿（草稿条只显示自己那条会话的） */
  const currentDrafts = computed<DraftChange[]>(() => draftsOf(activeSessionId.value));

  /* -------------------- 读写 -------------------- */

  function load(): void {
    let next: RootData;
    try {
      // loadData 已经逐块恢复 + 迁移过；这里再 parse + 迁移一次，双重保险
      next = migrateRootData(RootDataSchema.parse(loadData())).data;
    } catch (err) {
      console.warn('[苍玄助手] 读取失败，用默认值', err);
      next = migrateRootData(RootDataSchema.parse({})).data;
    }
    try {
      // 只补不覆盖：内置预设 / 内置技能 / 首次的 active_preset_id
      next = applyBuiltins(next);
    } catch (err) {
      console.warn('[苍玄助手] 内置预设注入失败', err);
    }
    data.value = next;
    bindLegacyAlias();
    // F3：active_tab 是自由字符串，载入时就归位（老数据 / 插件关掉导致页面不存在），
    // 别等界面第一次切页 —— 否则第一帧会停在一个画不出来的页上
    if (!tabExists()) setTab(data.value.active_tab);
    ready.value = true;
    dirty.value = false;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 挂起层数（> 0 = 挂起中）。
   *
   *  - 挂起期间 `save()`（自动防抖那条路）只置 dirty，**不排定时器**；
   *  - 挂起期间 `save(true)`（显式立即写）照常立刻落盘 —— 关键节点要能写；
   *  - 嵌套用计数，release 到 0 才真正释放。
   */
  const saveHoldCount = ref(0);

  /**
   * 立刻落盘；顺带清掉待定的防抖定时器。
   *
   * @param keepDirty 写完之后仍然标着「有未确认的改动」。
   *   兜底的 flushSaves()（页面隐藏）用它：那次是在**挂起中插队**写的，
   *   之后 runner 还会直接改 data（data.drafts / session.round 这类不走 save() 的写点），
   *   releaseSaves() 必须再写一次才不会漏 —— 最多多写一次，绝不漏写。
   */
  function flushNow(keepDirty = false): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      saveData(data.value);
      if (!keepDirty) dirty.value = false;
    } catch (err) {
      console.warn('[苍玄助手] 保存失败', err);
    }
  }

  /**
   * 记一笔「数据变了」。
   *
   * @param now true = 立刻写（挂起期间也生效，给关键节点用）；不传 = 走防抖
   */
  function save(now?: boolean): void {
    dirty.value = true;
    if (now) {
      flushNow();
      return;
    }
    if (saveHoldCount.value > 0) {
      // 挂起中：只置 dirty，不排定时器（agent 跑起来时几十毫秒一次的变更不该写盘）
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushNow, SAVE_DEBOUNCE_MS);
  }

  /**
   * 批量挂起：长时间任务（agent 运行）期间只写一次。
   *
   * 进入时会把已经排好的防抖定时器取消 —— 否则任务跑到一半，那次防抖照样会写一整份。
   * 支持嵌套（计数），release 到 0 才写。
   *
   * ⚠️ 必须和 releaseSaves() 成对，且放在 try / finally 里。
   */
  function holdSaves(): void {
    saveHoldCount.value += 1;
    if (saveHoldCount.value === 1 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 释放一层挂起；计数到 0 且期间有改动，就立刻写一次。
   *
   * 幂等：没挂起时调用什么都不做（不会误写，也不抛）。
   * ⚠️ 调用方要放在 finally 里 —— 异常路径不释放 = 数据永远不落盘。
   */
  function releaseSaves(): void {
    if (saveHoldCount.value === 0) return;
    saveHoldCount.value -= 1;
    if (saveHoldCount.value > 0) return;
    if (dirty.value) flushNow();
  }

  /**
   * 兜底 flush：忽略挂起，dirty 就立刻写。
   *
   * document 隐藏（切后台 / 锁屏）时用：手机上进程随时可能被系统杀掉，
   * 这时候挂不挂起都不重要了，先保住数据。
   */
  function flushSaves(): void {
    if (dirty.value) flushNow(true);
  }

  /** hold → 跑任务 → finally release；异常路径也保证释放，dirty 就落盘 */
  async function withHeldSaves<T>(task: () => Promise<T> | T): Promise<T> {
    holdSaves();
    try {
      return await task();
    } finally {
      releaseSaves();
    }
  }

  /** 当前是不是挂起中（测试 / 界面状态用） */
  const savesHeld = computed(() => saveHoldCount.value > 0);

  /** 挂起层数（嵌套时会 > 1） */
  const savesHeldCount = computed(() => saveHoldCount.value);

  /* -------------------- 页签 -------------------- */

  /** 整份替换（导入数据用）；next 已经过 importAll 校验 */
  function replaceAll(next: RootData): void {
    let parsed: RootData;
    try {
      parsed = migrateRootData(RootDataSchema.parse(next)).data;
    } catch (err) {
      console.warn('[苍玄助手] 导入数据不合法', err);
      return;
    }
    try {
      parsed = applyBuiltins(parsed);
    } catch (err) {
      console.warn('[苍玄助手] 导入时补内置失败', err);
    }
    data.value = parsed;
    bindLegacyAlias();
    save(true);
  }

  /**
   * 切页。页面集合是运行时算的（核心页 + 已启用插件页），所以这里**必须校验**：
   * 页面不存在（老数据里的 records / portraits，或插件被关掉）就落到第一个可用页 ——
   * 不许把 active_tab 写成一个界面画不出来的 id（否则整个面板会空）。
   */
  function setTab(id: string): void {
    // 合法性看**全部页面**（allPages）：inTabbar:false 的页面（例如以后的 MCP 内容页）也得能打开，
    // 顶栏只画 availablePages —— 两件事别混成一个判断，否则那些页面永远进不去（H1）。
    const pages = allPages(data.value);
    const hit = pages.find(page => page.id === id) ?? pages[0];
    data.value.active_tab = hit ? hit.id : 'chat';
    save();
  }

  /** 当前 active_tab 指向的页面还存在吗（页面被插件开关撤掉时用） */
  function tabExists(): boolean {
    return allPages(data.value).some(page => page.id === data.value.active_tab);
  }

  /* -------------------- 预设 -------------------- */

  const activePreset = computed<Preset | null>(() => {
    const id = data.value.active_preset_id;
    return data.value.presets.find((p) => p.id === id) || data.value.presets[0] || null;
  });

  function selectPreset(id: string): void {
    data.value.active_preset_id = id;
    // 顺手记在当前会话上，方便会话列表显示「这条用的哪个预设」
    currentSession().preset_id = id;
    save();
  }

  function addPreset(preset?: Partial<Preset>): Preset {
    const p: Preset = PresetSchemaLike({ id: uid('preset'), name: '新预设', ...preset });
    data.value.presets.push(p);
    data.value.active_preset_id = p.id;
    save();
    return p;
  }

  function updatePreset(id: string, patch: Partial<Preset>): void {
    const i = data.value.presets.findIndex((p) => p.id === id);
    if (i < 0) return;
    data.value.presets[i] = { ...data.value.presets[i], ...patch };
    save();
  }

  function removePreset(id: string): void {
    const target = data.value.presets.find((p) => p.id === id);
    if (!target || target.builtin) return;
    data.value.presets = data.value.presets.filter((p) => p.id !== id);
    if (data.value.active_preset_id === id) {
      data.value.active_preset_id = data.value.presets[0] && data.value.presets[0].id ? data.value.presets[0].id : '';
    }
    save();
  }

  /* -------------------- 技能 -------------------- */

  function addSkill(skill?: Partial<Skill>): Skill {
    const s: Skill = { id: uid('skill'), name: '新技能', summary: '', body: '', files: [], enabled: true, builtin: false, ...skill };
    data.value.skills.push(s);
    save();
    return s;
  }

  function updateSkill(id: string, patch: Partial<Skill>): void {
    const i = data.value.skills.findIndex((s) => s.id === id);
    if (i < 0) return;
    data.value.skills[i] = { ...data.value.skills[i], ...patch };
    save();
  }

  function removeSkill(id: string): void {
    data.value.skills = data.value.skills.filter((s) => s.id !== id);
    save();
  }

  /* -------------------- 选择 -------------------- */

  function patchSelection(patch: Partial<RootData['selection']>): void {
    data.value.selection = { ...data.value.selection, ...patch };
    save();
  }

  function toggleIn(list: string[], v: string): string[] {
    return list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : list.concat(v);
  }

  function toggleCharacter(id: string): void {
    patchSelection({ character_ids: toggleIn(data.value.selection.character_ids, id) });
  }

  function toggleWorldbook(name: string): void {
    patchSelection({ worldbook_names: toggleIn(data.value.selection.worldbook_names, name) });
  }

  function toggleEntry(entryKey: string): void {
    patchSelection({ entry_uid: toggleIn(data.value.selection.entry_uid, entryKey) });
  }

  function setEntries(keys: string[]): void {
    patchSelection({ entry_uid: keys });
  }

  function setDemand(text: string): void {
    patchSelection({ demand: text });
  }

  /* -------------------- 会话：写 -------------------- */

  /**
   * 把 data.session 指到当前会话（同一个对象引用）。
   *
   * 只为兼容还没迁移的调用点：App.vue 读 store.data.session.turns、
   * run/runner.ts 写 args.data.session.round、旧 view 绑 data.session.mode。
   * 因为是同一个对象，从任何一边改都会同步，不需要来回拷。
   */
  function bindLegacyAlias(): void {
    data.value.session = currentSession();
  }

  /**
   * 当前会话；万一 sessions 被外部清空了，就地补一条再返回，
   * 保证每个写动作都有落点（读请用 activeSession 计算属性）。
   */
  function currentSession(): Session {
    if (data.value.sessions.length === 0) {
      const now = Date.now();
      const created = makeSession({ id: uid('sess'), title: DEFAULT_SESSION_TITLE, created_at: now, updated_at: now });
      data.value.sessions.push(created);
      data.value.active_session_id = created.id;
    }
    const session = activeSession.value;
    // 顺手把别名对准当前会话：即使还没 load() 过、或者有人换过 active，也不会指到旧对象上
    if (data.value.session !== session) data.value.session = session;
    return session;
  }

  /** 记时间；标题还是默认值时，用第一条用户消息当标题 */
  function touchSession(session: Session, turn: Turn): void {
    const now = Date.now();
    if (session.created_at <= 0) session.created_at = now;
    if (session.started_at <= 0) session.started_at = now;
    session.updated_at = now;

    const stillDefault = session.title.trim() === '' || session.title === DEFAULT_SESSION_TITLE;
    if (stillDefault && turn.role === 'user' && turn.text.trim() !== '') {
      session.title = titleFromText(turn.text);
    }
  }

  /** 新建会话并切过去 */
  function createSession(title?: string): Session {
    const now = Date.now();
    const current = activeSession.value;
    const session = makeSession({
      id: uid('sess'),
      title: (title ?? '').trim() || DEFAULT_SESSION_TITLE,
      created_at: now,
      updated_at: now,
      preset_id: data.value.active_preset_id || current.preset_id,
      mode: current.mode,
    });
    data.value.sessions.push(session);
    data.value.active_session_id = session.id;
    bindLegacyAlias();
    save();
    return session;
  }

  /** 切到某个会话；id 不存在返回 false */
  function openSession(id: string): boolean {
    if (!data.value.sessions.some((s) => s.id === id)) return false;
    data.value.active_session_id = id;
    bindLegacyAlias();
    save();
    return true;
  }

  /** 改名；传空串就退回「由首条用户消息推出来的标题」（没消息就是「新对话」） */
  function renameSession(id: string, title: string): void {
    const target = data.value.sessions.find((s) => s.id === id);
    if (!target) return;
    const trimmed = title.trim();
    target.title = trimmed !== '' ? trimmed : sessionTitle({ ...target, title: '' });
    save();
  }

  /** 删会话；删到最后一个会自动补一个空白会话（界面永远有东西可显示） */
  function deleteSession(id: string): void {
    const index = data.value.sessions.findIndex((s) => s.id === id);
    if (index < 0) return;

    data.value.sessions.splice(index, 1);

    if (data.value.sessions.length === 0) {
      const now = Date.now();
      data.value.sessions.push(
        makeSession({ id: uid('sess'), title: DEFAULT_SESSION_TITLE, created_at: now, updated_at: now }),
      );
    }
    if (!data.value.sessions.some((s) => s.id === data.value.active_session_id)) {
      const fallback = data.value.sessions[Math.min(index, data.value.sessions.length - 1)];
      data.value.active_session_id = fallback.id;
    }

    bindLegacyAlias();
    save();
  }

  /** 当前会话的预设信息同步给会话（换预设时用） */
  function setSessionPreset(id: string): void {
    currentSession().preset_id = id;
    save();
  }

  /* -------------------- 会话：轮次 -------------------- */

  function setMode(mode: 'agent' | 'chat'): void {
    currentSession().mode = mode;
    save();
  }

  /**
   * 双写：把轮次派生的事件追加进会话（turns 是读路径，events 是权威流）。
   *
   * 仅追加，所以 upsert 重写同一个轮次时会再追加一组同 id 的事件；
   * 记录页按 id 折叠、后写的算数即可（见 types.ts 的 eventsForTurn 注释）。
   * 流式增量（patchTurnText）不逐条入日志，轮次定稿时由 appendTurn / upsertTurn 补。
   */
  function logTurnEvents(session: Session, turn: Turn): void {
    const derived = eventsForTurn(turn);
    if (derived.length === 0) return;
    session.events = appendEventsToList(session.events, derived);
  }

  /** 追加一条轮次（push 语义，流式开始时用） */
  function appendTurn(turn: Turn): void {
    const session = currentSession();
    session.turns.push(turn);
    logTurnEvents(session, turn);
    touchSession(session, turn);
    save();
  }

  /** 按 id upsert：存在就整条替换，不存在就 push（重跑 / 整条替换用） */
  function upsertTurn(turn: Turn): void {
    const session = currentSession();
    const index = session.turns.findIndex((item) => item.id === turn.id);
    if (index >= 0) session.turns[index] = turn;
    else session.turns.push(turn);
    logTurnEvents(session, turn);
    touchSession(session, turn);
    save();
  }

  /** 给当前会话里某条轮次的 text 追加增量（流式回显用）；找不到那一条就什么也不做 */
  function patchTurnText(id: string, delta: string): void {
    if (delta === '') return;
    const session = currentSession();
    const turn = session.turns.find((item) => item.id === id);
    if (!turn) return;
    turn.text += delta;
    session.updated_at = Date.now();
    save();
  }

  /** 整批换轮次（导入 / 恢复用）；events 只追加，所以这批轮次也会补上事件 */
  function setTurns(turns: Turn[]): void {
    const session = currentSession();
    session.turns = turns;
    for (const turn of turns) logTurnEvents(session, turn);
    session.updated_at = Date.now();
    save();
  }

  function setRunning(v: boolean): void {
    currentSession().running = v;
    save();
  }

  function resetSession(): void {
    const session = currentSession();
    session.turns = [];
    session.round = 0;
    session.running = false;
    session.updated_at = Date.now();
    save();
  }

  /* -------------------- 会话：事件日志（仅追加） -------------------- */

  /** 取某个会话的事件流；不传 = 当前会话 */
  function eventsOf(sessionId?: string): SessionEvent[] {
    const id = sessionId ?? activeSessionId.value;
    return data.value.sessions.find((s) => s.id === id)?.events ?? [];
  }

  /**
   * 往当前会话的事件流追加一条（仅追加）。
   * title 拿不到就从 type 兜底生成 —— 契约要求它非空。
   */
  function appendEvent(event: SessionEvent): void {
    const session = currentSession();
    session.events = appendEventToList(session.events, { ...event, title: eventTitle(event) });
    save();
  }

  /** 批量追加（空数组直接返回） */
  function appendEvents(more: SessionEvent[]): void {
    if (more.length === 0) return;
    const session = currentSession();
    session.events = appendEventsToList(
      session.events,
      more.map((event) => ({ ...event, title: eventTitle(event) })),
    );
    save();
  }

  /**
   * 造一条事件 + 追加 + 返回它（runner 记 draft / apply / artifact / notice 用）。
   *
   * 例：`store.logEvent('draft', { title: '草稿 · 12 处改动', ok: true, ref: draftId })`
   */
  function logEvent(type: SessionEventType, partial: Partial<SessionEvent> = {}): SessionEvent {
    const event = makeEvent(type, partial);
    appendEvent(event);
    return event;
  }

  /* -------------------- 工具页覆盖项 -------------------- */

  /** 某个工具改过什么；没改过返回 undefined */
  function toolOverrideOf(name: string): ToolOverride | undefined {
    return data.value.tool_overrides[name];
  }

  /**
   * 改工具覆盖项：合并进已有项，自动盖 `edited_at`。
   *
   * patch 里显式给 `undefined` 的字段不当成「覆盖成 undefined」（不写进去）；
   * 想彻底回到内置默认用 resetToolOverride。
   */
  function setToolOverride(name: string, patch: Partial<ToolOverride>): void {
    const tool = name.trim();
    if (tool === '') return;

    // 先把 patch 里显式 undefined 的字段滤掉，再合并：undefined 表示「这个字段没动」，
    // 不能把已有值覆盖成 undefined
    const patchClean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) patchClean[key] = value;
    }

    data.value.tool_overrides[tool] = {
      ...data.value.tool_overrides[tool],
      ...patchClean,
      edited_at: Date.now(),
    };
    save();
  }

  /** 撤掉某个工具的全部覆盖（回到内置默认） */
  function resetToolOverride(name: string): void {
    const tool = name.trim();
    if (tool === '' || !(tool in data.value.tool_overrides)) return;
    delete data.value.tool_overrides[tool];
    save();
  }

  /* -------------------- 插件：开关 + 设置 -------------------- */

  /**
   * 插件开着吗：plugin_state 里有就听它的，没有就用 manifest.defaultEnabled。
   * 读开关只有这一处（界面别去翻 plugin_state 的原始形状）。
   */
  function pluginEnabled(id: PluginId): boolean {
    const hit = data.value.plugin_state[id];
    if (hit && typeof hit.enabled === 'boolean') return hit.enabled;
    return pluginManifest(id).defaultEnabled;
  }

  /**
   * 改插件开关。关掉插件时，如果当前页正是它贡献的页面，自动回落到第一个可用页 ——
   * 否则界面会停在一个已经画不出来的页上（「关掉即消失」最容易漏的就是这个边角）。
   */
  function setPluginEnabled(id: PluginId, enabled: boolean): void {
    data.value.plugin_state[id] = { enabled };
    if (!tabExists()) setTab(data.value.active_tab);
    save();
  }

  /** 读插件自己的设置（没设置过就是空对象） */
  function pluginConfig(id: PluginId): Record<string, unknown> {
    const bag = data.value.plugins as unknown as Record<string, Record<string, unknown> | undefined>;
    return bag[id] ?? {};
  }

  /** 生图插件的设置（它有真 schema，界面表单直接拿这个类型用） */
  function imageConfig(): GenImageConfig {
    return data.value.plugins.image;
  }

  /**
   * 改插件设置（插件管理页）。合并进已有配置并落盘。
   *
   * 跟 setToolOverride 一个口径：patch 里显式给 undefined 的字段不当成「改成 undefined」。
   * **enabled 一律忽略**：开关只在 setPluginEnabled 那条路上改，两个写点必然分叉。
   * 想回内置默认用 resetPluginConfig。
   */
  function setPluginConfig(id: PluginId, patch: Record<string, unknown>): void {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key !== 'enabled') clean[key] = value;
    }
    const bag = data.value.plugins as unknown as Record<string, Record<string, unknown>>;
    bag[id] = { ...(bag[id] ?? {}), ...clean };
    save();
  }

  /** 插件设置恢复内置默认（**只清设置，不动开关**） */
  function resetPluginConfig(id: PluginId): void {
    if (id === 'image') {
      data.value.plugins.image = GenImageConfigSchema.parse({});
    } else {
      const bag = data.value.plugins as unknown as Record<string, Record<string, unknown>>;
      bag[id] = {};
    }
    save();
  }

  /* -------------------- 草稿：按会话分开 -------------------- */

  /** 取某个会话的草稿；不传 = 当前会话（runner 按会话取草稿就是它） */
  function draftsOf(sessionId?: string): DraftChange[] {
    const id = sessionId ?? activeSessionId.value;
    return data.value.drafts.filter((draft) => draft.session_id === id);
  }

  /** 某个会话的草稿条数 */
  function draftCount(sessionId?: string): number {
    return draftsOf(sessionId).length;
  }

  /** 加一条草稿；没写 session_id 就自动盖上当前会话（调用方不用自己传） */
  function addDraft(change: Omit<DraftChange, 'session_id'> & { session_id?: string }): void {
    data.value.drafts.push({ ...change, session_id: change.session_id || activeSessionId.value });
    save();
  }

  /** 清掉某个会话的草稿；不传 = 当前会话 */
  function clearDraftsFor(sessionId?: string): void {
    const id = sessionId ?? activeSessionId.value;
    data.value.drafts = data.value.drafts.filter((draft) => draft.session_id !== id);
    save();
  }

  /* -------------------- 会话：导出 -------------------- */

  /**
   * 导出单个会话。
   *
   * - 'json' → 会话对象的 JSON（可以直接存文件）
   * - 'md'   → 给人看的 markdown（标题 / 时间 / ## 用户 / ## 苍玄 / 工具调用）
   *
   * 找不到这个会话就返回空串（不抛）。
   */
  function exportSession(id: string, format: 'json' | 'md' = 'json'): string {
    try {
      const session = data.value.sessions.find((s) => s.id === id);
      if (!session) return '';
      return format === 'md' ? sessionToMarkdown(session) : JSON.stringify(session, null, 2);
    } catch (err) {
      console.warn('[苍玄助手] 导出会话失败', err);
      return '';
    }
  }

  /** 导出全部会话（备份用）：JSON 数组文本 */
  function exportSessions(): string {
    try {
      return JSON.stringify(data.value.sessions, null, 2);
    } catch (err) {
      console.warn('[苍玄助手] 导出会话列表失败', err);
      return '[]';
    }
  }

  /** 导出某个会话的**权威事件流**（json 数组文本）；找不到返回 '[]' */
  function exportSessionEvents(id: string): string {
    try {
      return JSON.stringify(eventsOf(id), null, 2);
    } catch (err) {
      console.warn('[苍玄助手] 导出事件流失败', err);
      return '[]';
    }
  }

  /* -------------------- 草稿 / 产物 -------------------- */

  /** 清掉**全部**会话的草稿（设置页「清空草稿」用） */
  function clearDrafts(): void {
    data.value.drafts = [];
    save();
  }

  function addArtifact(name: string, dataText: string, kind: 'json' | 'worldbook'): void {
    data.value.artifacts.push({ id: uid('art'), kind, name, data: dataText, at: Date.now() });
    save();
  }

  function clearArtifacts(): void {
    data.value.artifacts = [];
    save();
  }

  // 初始状态就把别名绑好：还没 load() 时旧 view 读 data.session 也能看到那条默认会话
  bindLegacyAlias();

  return {
    data, ready, dirty, load, save, holdSaves, releaseSaves, flushSaves, withHeldSaves,
    savesHeld, savesHeldCount, replaceAll, setTab,
    activePreset, selectPreset, addPreset, updatePreset, removePreset,
    addSkill, updateSkill, removeSkill,
    patchSelection, toggleCharacter, toggleWorldbook, toggleEntry, setEntries, setDemand,
    sessions, activeSession, activeSessionId, currentSessionTurns, sessionMetas,
    createSession, openSession, renameSession, deleteSession, setSessionPreset,
    setMode, appendTurn, upsertTurn, patchTurnText, setTurns, setRunning, resetSession,
    currentSessionEvents, eventsOf, appendEvent, appendEvents, logEvent,
    exportSession, exportSessions, exportSessionEvents,
    toolOverrides, toolOverrideOf, setToolOverride, resetToolOverride,
    pluginEnabled, setPluginEnabled, pluginConfig, imageConfig, setPluginConfig, resetPluginConfig,
    currentDrafts, draftsOf, draftCount, addDraft, clearDraftsFor, clearDrafts,
    addArtifact, clearArtifacts,
  };
});

/** 兜一层，顺手把默认值补齐 */
function PresetSchemaLike(input: Partial<Preset>): Preset {
  return {
    id: input.id || uid('preset'),
    name: input.name || '新预设',
    builtin: input.builtin || false,
    output: input.output || 'none',
    items: input.items || [],
    use_global_caps: input.use_global_caps || false,
    tools: input.tools || [],
    skills: input.skills || [],
    max_rounds: input.max_rounds || 12,
  };
}

export { GLOBAL_KEY };
