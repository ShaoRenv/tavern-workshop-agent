/**
 * 全局 store。持有 RootData，负责读写和所有增删改。
 * UI 只从这拿状态、只通过这改状态。
 *
 * 会话模型（v2 起是多会话）：
 *  - 唯一真源是 data.sessions + data.active_session_id
 *  - 所有会话级动作（appendTurn / upsertTurn / patchTurnText / setTurns / setRunning /
 *    resetSession）都作用于**当前会话**
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

import type { BackupSink, RollbackResult } from '../agent/draft.ts';
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
  migrateTabId,
  pickActiveSession,
  sessionTitle,
  titleFromText,
  toSessionMeta,
  uid,
  type DraftChange,
  type ExternalPlugin,
  type GenImageConfig,
  type Preset,
  type RootData,
  type Session,
  type SessionEvent,
  type SessionEventType,
  type SessionMeta,
  type Skill,
  type Turn,
  type WbBackup,
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

/**
 * 回滚通道：**store 需要的那个最小形状**，刻意与 `Runner.rollback` 的**一参**签名逐字一致。
 *
 * 为什么不直接写 `Pick<Runner, 'rollback'>`：那会给 store 多拉一条 `run/runner.ts` 的 import 边，
 * 而 store 只需要这一个方法。用结构化的小接口表达同一件事，编译期照样挡得住签名不一致。
 *
 * ⚠️ **一参**：端口由 runner 内部 `getPort()` 提供（回滚必须落在真实端口上，不能落在草稿视图上）。
 *
 * 这个类型存在的唯一理由就是踩过的那个坑：这里曾写成 `Pick<DraftStore, 'rollback'>`（**两参**
 * `(wb, backup)`），而运行时传进来的是 **runner**（一参）—— 类型与真实对象不是同一个东西，
 * 于是 `tsc` 全绿、真机一点就炸：`runner.rollback(port, backup)` 把 **port 当成 backup**，
 * `draft.ts` 读出 `backup.world` 不是字符串 → 「这份备份没记世界书名，没法回滚」。
 * 教训（本项目第二次「单层都对、合起来炸」）：**跨层注入的对象，参数类型要按「实际会不会传进来」写**。
 */
export interface RollbackSource {
  rollback(backup: Pick<WbBackup, 'world' | 'entries'>): Promise<RollbackResult>;
}

export const useAppStore = defineStore('cx-assistant', () => {
  /** 初始就做一次迁移，保证 sessions 至少一条、active 指得上 */
  const data = ref<RootData>(migrateRootData(RootDataSchema.parse({})).data);

  /**
   * 最近一次回滚的结果（P5-6）。
   *
   * ⚠️ 为什么放 store、由 props 传下去，而不是让 RecordsView 的 `defineExpose` 被 ref 调用：
   * 记录页住在 `<Sheet v-if="recordsOpen">` 里 —— Sheet 一关，RecordsView 就被**卸载**了。
   * 回滚是异步的（读整本 + 写整本），结果回来时用户很可能已经关了 Sheet：
   * 那时 ref 是 null，调用会**静默丢掉**「这次回滚不可撤销」这条红色警报 —— 而那是本功能里
   * 最不能丢的一条。放 store 里则跨卸载存活，重开 Sheet 照样看得到。
   * 顺带也符合本项目「写路径唯一、界面不吃子组件句柄」的口径。
   */
  const rollbackResult = ref<RollbackResult | null>(null);
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
    // ① 老页名先过别名：schema 层（TAB_ID_ALIASES）已经兜过一道，这里是给「直接拿老 id 调 setTab」的调用方兜底，
    //    免得 records / capability 这类历史 id 落到「第一个可用页」而不是它该去的对话页 / 设置页。
    // ② 合法性看**全部页面**（allPages）：inTabbar:false 的页面（例如以后的 MCP 内容页）也得能打开，
    //    顶栏只画 availablePages —— 两件事别混成一个判断，否则那些页面永远进不去（H1）。
    const want = typeof id === 'string' ? String(migrateTabId(id)) : id;
    const pages = allPages(data.value);
    const hit = pages.find(page => page.id === want) ?? pages[0];
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

  /**
   * 切换预设（B58）。
   *
   * ─────────────────────────── 两件事 ───────────────────────────
   *
   * ① 记到会话上（会话列表显示「这条用的哪个预设」）；
   * ② **把新预设存的那份工具提示词覆盖项整体写进临时区**（B45 的两层结构）。
   *
   * ⚠️ 第 ② 步是「工具提示词跟预设走」的全部实现。不做的话，
   * 用户切了预设、工具提示词却还是上一份的 —— 预设里存的那些等于白存。
   *
   * **整体覆盖，不是合并**：新预设的 `tool_overrides` 是什么就是什么。
   * 合并会让上一份预设的残留漏过来（「切到一份干净预设」就永远做不到）。
   *
   * 老数据 / 新预设没有这个字段时 `PresetSchema` 会给 `{}` —— 切过去等于「全部跟随内置默认」。
   *
   * @param id 目标预设 id；传空串 = 清空选择（此时**不动**临时区 —— 没预设可跟，
   *   把用户当前调好的临时改动清掉反而是丢东西）。
   */
  function selectPreset(id: string): void {
    data.value.active_preset_id = id;
    // 顺手记在当前会话上，方便会话列表显示「这条用的哪个预设」
    currentSession().preset_id = id;
    const target = data.value.presets.find((p) => p.id === id);
    if (target) {
      data.value.tool_overrides = { ...(target.tool_overrides ?? {}) };
    }
    save();
  }

  /**
   * 把临时区那份工具提示词**存回当前预设**（B45 的第三个动作）。
   *
   * 内置预设**不许存**（B41 完整版：内置只读，改了下次刷新就被强制覆盖回去）——
   * 返回 false，让界面去提示「先另存为一份」。
   *
   * @returns 真的存进去了吗
   */
  function saveToolOverridesToPreset(): boolean {
    const preset = activePreset.value;
    if (!preset) return false;
    if (preset.builtin) return false;
    const i = data.value.presets.findIndex((p) => p.id === preset.id);
    if (i < 0) return false;
    data.value.presets[i] = { ...data.value.presets[i], tool_overrides: { ...data.value.tool_overrides } };
    save();
    return true;
  }

  /**
   * 临时区里有没有「和当前预设存的那份不一样」的改动（B59 的判据）。
   *
   * 逐键比对（键集合 + 每个键的 JSON）：只比引用会永远说「不一样」。
   * 没有当前预设时返回 false —— 没预设可存，也就谈不上「没存」。
   */
  function toolOverridesDirty(): boolean {
    const preset = activePreset.value;
    if (!preset) return false;
    const saved = preset.tool_overrides ?? {};
    const live = data.value.tool_overrides ?? {};
    const keys = new Set([...Object.keys(saved), ...Object.keys(live)]);
    for (const key of keys) {
      if (JSON.stringify(saved[key] ?? null) !== JSON.stringify(live[key] ?? null)) return true;
    }
    return false;
  }

  function addPreset(preset?: Partial<Preset>): Preset {
    const p: Preset = PresetSchemaLike({ id: uid('preset'), name: '新预设', ...preset });
    data.value.presets.push(p);
    data.value.active_preset_id = p.id;
    save();
    return p;
  }

  /**
   * 改预设。**内置预设拒绝写入**（B41 完整版）。
   *
   * 界面已经把内置预设的写入口全撤掉了，这里是第二道闸：applyBuiltins() 每次载入都会把
   * 内置预设强制覆盖成最新版，所以对内置的写入**下次刷新必然丢失** —— 与其静默丢掉，
   * 不如在这里直接挡下（返回 false），让调用方去走「派生一份再改」那条路。
   */
  function updatePreset(id: string, patch: Partial<Preset>): boolean {
    const i = data.value.presets.findIndex((p) => p.id === id);
    if (i < 0) return false;
    if (data.value.presets[i].builtin) return false;
    data.value.presets[i] = { ...data.value.presets[i], ...patch };
    save();
    return true;
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

  /**
   * B51：技能内容的**唯一真源是 ST 真文件**，这个数组只是启动时的水合快照。
   *
   * 所以「保存技能」不能只改这里 —— 那样下次启动就被文件盖回去了。
   * 界面走 `App.vue` 的 onSkillSave（它写文件 + 再改这里）。
   * 这里保留一个**内部**写入口给水合流程用，不对外暴露成「保存」。
   */
  function updateSkill(id: string, patch: Partial<Skill>): void {
    const i = data.value.skills.findIndex((s) => s.id === id);
    if (i < 0) return;
    data.value.skills[i] = { ...data.value.skills[i], ...patch };
    save();
  }

  /**
   * 整体换掉技能快照（水合流程专用）。
   *
   * ⚠️ 只在 `syncSkills()` 里调：那是「从 ST 文件重新读一遍」的结果，
   * 不是用户编辑。别拿它当保存路径 —— 那样就把文件才是真源这条口径破坏了。
   */
  function replaceSkills(skills: Skill[]): void {
    data.value.skills = skills;
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
   * run/runner.ts 写 args.data.session.round。
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

  /**
   * 把某个工具的**用户级开关**清掉（回到「跟随」）。
   *
   * 为什么需要单独一条：`setToolOverride` 有意忽略 `undefined`（那是防「把已有值误覆盖成空」的），
   * 而三态开关回到「跟随」**必须**把字段删掉 —— 复用 resetToolOverride 又会连提示词一起清空。
   * 所以这里只删 `enabled` 一个键，其余覆盖项原样保留；整条没别的字段了就顺手删掉整条。
   */
  function clearToolSwitch(name: string): void {
    const tool = name.trim();
    if (tool === '') return;
    const current = data.value.tool_overrides[tool];
    if (!current || current.enabled === undefined) return;
    delete current.enabled;
    // 只剩 edited_at（或干脆空了）就整条删掉，别在数据里留空壳
    const rest = Object.keys(current).filter(key => key !== 'edited_at');
    if (rest.length === 0) delete data.value.tool_overrides[tool];
    else current.edited_at = Date.now();
    save();
  }

  /** 撤掉某个工具的全部覆盖（回到内置默认） */
  function resetToolOverride(name: string): void {
    const tool = name.trim();
    if (tool === '' || !(tool in data.value.tool_overrides)) return;
    delete data.value.tool_overrides[tool];
    save();
  }

  /**
   * 整体换掉临时区的工具提示词覆盖项（B44 导入用）。
   *
   * ⚠️ 是**整体替换**不是合并：导入的语义就是「用这份文件里的东西替换当前这份」。
   * 合并会让没被导入的旧项残留下来 —— 用户看到的是「导入了但没干净」。
   *
   * 只动 `RootData.tool_overrides`（临时区），**不碰任何预设**：
   * 想存进预设得用户自己去点「存进预设」（见 saveToolOverridesToPreset）。
   */
  function replaceToolOverrides(next: ToolOverrideMap): void {
    data.value.tool_overrides = { ...(next ?? {}) };
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

  /* -------------------- 外部插件（阶段 7）：安装清单 -------------------- */

  /**
   * 装上 / 更新一个外部插件的**安装记录**（同 id 覆盖 = 更新）。
   *
   * ⚠️ 这里只写「装了什么」（清单 + 代码路径 + 哈希），**不写开关** ——
   * 开关仍然只在 setPluginEnabled 那条路上改（口径同内置插件）。
   * 卸载才动 `plugin_state`（要把它那段开关一起清掉，免得 id 复用时继承旧状态）。
   */
  function setExternalPlugin(record: ExternalPlugin): void {
    const list = data.value.external_plugins;
    const index = list.findIndex(item => item.id === record.id);
    if (index >= 0) list.splice(index, 1, record);
    else list.push(record);
    save();
  }

  /** 记下某个外部插件最近一次的装载失败（成功时传空串清空） */
  function setExternalPluginError(id: PluginId, error: string): void {
    const hit = data.value.external_plugins.find(item => item.id === id);
    if (!hit || hit.last_error === error) return;
    hit.last_error = error;
    save();
  }

  /** 卸载：从清单删掉 + 清掉它的开关（**先做这两件事，再由调用方删文件**） */
  function removeExternalPlugin(id: PluginId): void {
    const list = data.value.external_plugins;
    const index = list.findIndex(item => item.id === id);
    if (index >= 0) list.splice(index, 1);
    delete data.value.plugin_state[id];
    // 它的设置也一起清掉：外部插件的设置是它自己声明的，卸载后留着只会成为孤儿
    const bag = data.value.plugins as unknown as Record<string, unknown>;
    delete bag[id];
    if (!tabExists()) setTab(data.value.active_tab);
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

  /* -------------------- 世界书备份与回滚（P5-6 装配） -------------------- */

  /**
   * 每本世界书**保留几份**备份。
   *
   * ⚠️ 这条策略**故意落在这里**（写入方），不在 `agent/draft.ts`：
   * 那个文件是可单测的纯逻辑层，契约 `BackupSink` 只定形状（`draft.ts:189` 写明「保留策略不管」）。
   * 整本快照实测过 1.1MB 一本，脚本变量不是无限大的，必须有上限。
   */
  const BACKUPS_PER_WORLD = 3;

  /**
   * 造一份备份钩子（P5-6 第 1 段）。
   *
   * 为什么由 store 造、由 App.vue 装：`DraftStore.apply()` 会在写回前调 `snapshot()`，
   * 而 `snapshot` 要写进 `RootData.wb_backups` + 落盘 —— 只有 store 同时拿得到「数据」和 `save()`。
   * 但 `DraftStore` 是 runner 的私有状态（`createRunner()` 建一次长期持有），store 拿不到它。
   * `App.vue` 两边都在作用域里，所以由它把这个 sink 交给 runner：
   *   `runner.setBackupSink(store.backupSink())`
   */
  function backupSink(): BackupSink {
    return {
      /**
       * 写一份快照进 `wb_backups` 并落盘。
       *
       * `entries` 是**写回之前的原始条目**（含 extra）—— 备份的意义是「写坏之前长什么样」。
       */
      snapshot(world: string, entries: WbBackup['entries'], reason: string): void {
        const source = Array.isArray(entries) ? entries : [];
        const backup: WbBackup = {
          id: uid('wbk'),
          world,
          // taken_at 是裁剪的排序依据（见下），必须在这里落真实时间
          taken_at: Date.now(),
          reason,
          entry_count: source.length,
          //
          // ⚠️ **必须深拷贝**，不能直接把 `source` 存进去（B2 补的）。
          //
          // 理由：`source` 是调用方手里的那个数组（`apply` 里就是 `wb.readAll()` 的返回值）。
          // 直接把引用存进 `wb_backups` 的话，**备份的内容会跟着调用方后续的动作变** ——
          // 而「备份」的全部意义就是「当时长什么样」。
          //
          // 诚实说明：**当前调用链恰好是安全的** —— `applyChangesToEntries()` 是纯函数
          // （进函数先深拷贝，见 draft.ts:618），所以今天不会有人改到 `source`。
          // 但这个安全性是**调用方的实现细节**给的，不是备份层保证的：
          // 哪天有人为了省一次拷贝把它改成原地改，备份就会被静默污染，
          // 而那时用户看到的是一份「和现场一模一样」的假备份 —— 回滚回不去。
          // 所以把这条性质**在备份层钉死**，代价是每次写回多一次拷贝
          // （整本 1.1MB，且这些数据本来就要 JSON 序列化进变量，不是额外量级）。
          //
          entries: cloneEntries(source),
        };
        data.value.wb_backups.push(backup);
        pruneBackups(world);
        // 立刻落盘：备份是兜底，晚 2.5 秒落盘就可能来不及（用户下一秒就点了回滚）
        save(true);
      },
    };
  }

  /**
   * 深拷贝一份条目（备份用）。
   *
   * 为什么要自己写而不用 `structuredClone`：本工程的持久化口径是「能 JSON 序列化的数据」
   * （整份 RootData 就是这么存进酒馆变量的），而 `structuredClone` 接受的东西比 JSON 宽
   * （Map / Set / Date / 循环引用…）。用 JSON 这条口径，**能存进去的一定能拷出来**，
   * 而且 `wb_backups` 本来就要过一遍 JSON —— 拷出来的形状和存下来的形状必然一致。
   *
   * 用 `JSON.parse(JSON.stringify())` 与 `core/storage.ts:690` 的既有写法保持一致（同一个项目别有两种口径）。
   *
   * 边界：拷不动（含循环引用等 JSON 表示不了的东西）就**原样返回**，
   * 绝不让备份把写回整条路径炸掉 —— 备份是兜底，不是门禁（同 draft.ts 的 applyBackup 口径）。
   */
  function cloneEntries(entries: WbBackup['entries']): WbBackup['entries'] {
    try {
      return JSON.parse(JSON.stringify(entries)) as WbBackup['entries'];
    } catch {
      return entries;
    }
  }

  /**
   * 限量：每本世界书只留**最近** {@link BACKUPS_PER_WORLD} 份。
   *
   * ⚠️ 裁剪排序用 `taken_at`，**不是数组位置** —— 多标签页 / 乱序写入时数组顺序不可靠
   * （记录页的倒序展示也是按 `taken_at` 排的，两边口径必须一致，否则「列出来的最新那份」
   * 和「留下的最新那份」会对不上）。
   */
  function pruneBackups(world: string): void {
    const mine = data.value.wb_backups.filter(item => item.world === world);
    if (mine.length <= BACKUPS_PER_WORLD) return;
    //
    // 按时间倒序取前 N 份，其余丢掉；用 id 集合做差集（id 由 uid('wbk') 保证唯一）。
    //
    // ⚠️⚠️ **同毫秒必须用「插入位置」当第二判据**（B2 测出来的真 bug）。
    //
    // `snapshot()` 用的是 `Date.now()`，**同一毫秒内连备两次是常态**（一次 apply 写多本书、
    // 或用户连点两下）。而 `Array.prototype.sort` 是**稳定排序** —— 时间戳相等时保持数组原序，
    // 于是 `slice(0, N)` 取到的是**最早插入的 N 份**，与「留最近 N 份」正好相反：
    // 用户刚改完那次的备份会被丢掉，留下的全是旧版本。
    //
    // 修法：相等时按数组下标倒序（下标大的 = 后插入的 = 更新的）。
    // 为什么用下标而不是 id：`uid('wbk')` 里带时间戳+随机串，**不是单调的**，排序不可靠。
    //
    const ranked = mine.map((item, index) => ({ item, index }));
    const keep = new Set(
      ranked
        .sort((a, b) => {
          const diff = (b.item.taken_at || 0) - (a.item.taken_at || 0);
          return diff !== 0 ? diff : b.index - a.index;
        })
        .slice(0, BACKUPS_PER_WORLD)
        .map(entry => entry.item.id),
    );
    data.value.wb_backups = data.value.wb_backups.filter(item => item.world !== world || keep.has(item.id));
  }

  /**
   * 回滚：把某一份备份整本写回去（P5-3 的写路径，唯一入口）。
   *
   * 三层顺序都不能变：
   *  1. 按 id 找到那份备份（找不到就直接失败，不猜「最新那份」）；
   *  2. 交给 runner 的 `rollback()` —— 它内部转给 `DraftStore.rollback()`，
   *     **先对当前状态再备一次**，再整本写回（「回滚也可撤销」的唯一保证，见 draft.ts:440）；
   *  3. 结果**回传给界面**（含 `backed_up_before_rollback`）并落盘。
   *
   * ## ⚠️ 参数类型必须是 `RollbackSource`，不能是 `Pick<DraftStore, 'rollback'>`
   *
   * 这里曾经写成 `Pick<DraftStore, 'rollback'>`（两参：`(wb, backup)`），而**运行时传进来的是 runner**，
   * `Runner.rollback` 是**一参**（端口由 runner 内部 `getPort()` 提供）。类型与运行时不是同一个东西，
   * 于是 `tsc` 全绿、真机一点就炸：`runner.rollback(port, backup)` 把 **port 当成 backup**，
   * `draft.ts` 读出 `backup.world` 不是字符串 → 「这份备份没记世界书名，没法回滚」。
   *
   * 教训（本项目第二次「单层都对、合起来炸」）：**跨层注入的对象，参数类型要按「实际会不会传进来」写**。
   * 端口不在这里取 —— runner 自己拿 `getPort()`，store 不该再掺一脚（那正是两边签名分叉的起点）。
   */
  async function rollbackBackup(source: RollbackSource | null | undefined, id: string): Promise<RollbackResult> {
    const backup = data.value.wb_backups.find(item => item.id === id);
    if (!backup) {
      return { ok: false, error: '找不到这份备份（可能已被后来的备份挤掉）' };
    }
    if (!source || typeof source.rollback !== 'function') {
      return { ok: false, world: backup.world, error: '回滚通道没接上（runner 缺 rollback）' };
    }
    // 一参调用：端口由 runner 内部提供（见上面那段注释）
    const result = await source.rollback({ world: backup.world, entries: backup.entries });
    // 回滚前的安全备份已经在 rollback() 内部写进 wb_backups 了，这里补一次落盘收口
    save(true);
    return result;
  }

  /** 记一份回滚结果给界面看（记录页 props 读它）；传 null = 清掉上次的提示 */
  function setRollbackResult(result: RollbackResult | null): void {
    rollbackResult.value = result;
  }

  /** 某本世界书的备份（最新的在前）；不传 = 全部 */
  function backupsOf(world?: string): WbBackup[] {
    const list = world ? data.value.wb_backups.filter(item => item.world === world) : data.value.wb_backups;
    return list.slice().sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
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
    saveToolOverridesToPreset, toolOverridesDirty,
    addSkill, updateSkill, removeSkill, replaceSkills,
    patchSelection, toggleCharacter, toggleWorldbook, toggleEntry, setEntries, setDemand,
    sessions, activeSession, activeSessionId, currentSessionTurns, sessionMetas,
    createSession, openSession, renameSession, deleteSession, setSessionPreset,
    appendTurn, upsertTurn, patchTurnText, setTurns, setRunning, resetSession,
    currentSessionEvents, eventsOf, appendEvent, appendEvents, logEvent,
    exportSession, exportSessions, exportSessionEvents,
    toolOverrides, toolOverrideOf, setToolOverride, resetToolOverride, clearToolSwitch, replaceToolOverrides,
    pluginEnabled, setPluginEnabled, pluginConfig, imageConfig, setPluginConfig, resetPluginConfig,
    setExternalPlugin, setExternalPluginError, removeExternalPlugin,
    currentDrafts, draftsOf, draftCount, addDraft, clearDraftsFor, clearDrafts,
    backupSink, pruneBackups, rollbackBackup, backupsOf, BACKUPS_PER_WORLD,
    rollbackResult, setRollbackResult,
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
    // B45：工具提示词覆盖项跟预设走。新建预设时**不带**上一份的残留（默认空 = 全跟随内置）
    tool_overrides: input.tool_overrides || {},
  };
}

export { GLOBAL_KEY };
