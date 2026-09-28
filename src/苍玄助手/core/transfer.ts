/**
 * 分三类导出 / 导入（B44，用户定案 D8 + T4 + T5）。
 *
 * ─────────────────────────── 为什么要分三类 ───────────────────────────
 *
 * 老做法只有「导出整棵树 / 导入整棵树」。问题是**颗粒度太粗**：
 * 想把自己的一个预设分享给别人，只能把整份数据（含 API Key、全部聊天记录）给出去。
 *
 * 现在按 D8 分三类，每类一个**自带 `kind` 的单文件 JSON**（T4：JSON 单文件）：
 *
 * | 类 | `kind` | 装什么 |
 * |---|---|---|
 * | 工具提示词 | `tool-prompts` | 一份 `tool_overrides` |
 * | 预设 | `preset` | 一个 `Preset`（含 items / tools / skills / use_global_caps / tool_overrides） |
 * | 技能 | `skill` | 一个 `Skill`（含 files[]） |
 *
 * **`kind` 的作用是「导入时能校验」**：拿着技能文件去点「导入预设」，
 * 必须当场报「这个文件是技能，导不进预设」，而不是塞进去变成一条坏数据。
 *
 * ─────────────────────────── 导入的三种情况（T5）───────────────────────────
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 同 id 已存在（用户自己的） | **不自己决定**，返回 `conflict` 让界面弹窗问（覆盖 / 另存为 / 取消） |
 * | 撞内置 id | **直接拒绝** —— 内置是随版本走的只读起点，覆盖了下次刷新也会被打回 |
 * | 格式不对 | 明确报「这个文件是 X 类，导入不到 Y」 |
 *
 * 这一层**只做解析与判定，不写数据**：怎么落地由调用方（store / 界面）决定，
 * 所以它是纯函数，好测。
 */
import type { Preset, Skill } from './types.ts';
import type { ToolOverrideMap } from './ports.ts';

/** 三类导出的公共信封版本 */
export const TRANSFER_VERSION = 1;

export type TransferKind = 'tool-prompts' | 'preset' | 'skill';

/** 工具提示词那一类的信封 */
export interface ToolPromptsTransfer {
  kind: 'tool-prompts';
  version: number;
  overrides: ToolOverrideMap;
}

/** 预设那一类的信封 */
export interface PresetTransfer {
  kind: 'preset';
  version: number;
  preset: Preset;
}

/** 技能那一类的信封 */
export interface SkillTransfer {
  kind: 'skill';
  version: number;
  skill: Skill;
}

export type Transfer = ToolPromptsTransfer | PresetTransfer | SkillTransfer;

/* ============================ 导出 ============================ */

/** 三类各自的 JSON 文本（缩进 2，人能读） */
export function exportToolPrompts(overrides: ToolOverrideMap): string {
  const payload: ToolPromptsTransfer = { kind: 'tool-prompts', version: TRANSFER_VERSION, overrides: overrides ?? {} };
  return JSON.stringify(payload, null, 2);
}

export function exportPreset(preset: Preset): string {
  const payload: PresetTransfer = { kind: 'preset', version: TRANSFER_VERSION, preset };
  return JSON.stringify(payload, null, 2);
}

export function exportSkill(skill: Skill): string {
  const payload: SkillTransfer = { kind: 'skill', version: TRANSFER_VERSION, skill };
  return JSON.stringify(payload, null, 2);
}

/* ============================ 导入 ============================ */

/** 导入判定结果 */
export interface ImportOutcome {
  ok: boolean;
  /** 解析出来的是哪一类（解析成功时必有） */
  kind?: TransferKind;
  /** 三类各自的内容（按 kind 取其中一个） */
  overrides?: ToolOverrideMap;
  preset?: Preset;
  skill?: Skill;
  /**
   * 撞上了已有的（用户自己的）同名 / 同 id 项，**等用户选**（T5）。
   *
   * 有这个字段时 `ok` 仍然是 true —— 解析是成功的，只是落地前要问一句。
   * 界面据此弹「覆盖 / 另存为 / 取消」。
   */
  conflict?: { id: string; name: string };
  /** 失败原因（人话） */
  error?: string;
}

/** 类别的人话名（报错文案要用） */
const KIND_LABELS: Record<TransferKind, string> = {
  'tool-prompts': '工具提示词',
  preset: '预设',
  skill: '技能',
};

/**
 * 解析一份导入文件。
 *
 * @param text 文件内容
 * @param expect 期望的类别（界面点的是哪个「导入 X」按钮）。
 *   不传 = 不校验类别（整树导入 / 自动识别用）。
 * @param existing 已存在的 id → 名字（用来判撞车）。**内置项不要放进来** ——
 *   撞内置走的是「直接拒绝」，与「问用户」是两条不同的路。
 * @param builtinIds 内置 id 集合（撞上直接拒）。
 *
 * **不抛**：坏了返回 `{ ok: false, error }`。
 */
export function importTransfer(
  text: string,
  options: {
    expect?: TransferKind;
    existing?: Record<string, string>;
    builtinIds?: string[];
  } = {},
): ImportOutcome {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { ok: false, error: '导入内容为空' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: '不是合法的 JSON：' + (error instanceof Error ? error.message : String(error)) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '这份文件的顶层不是一个对象（可能是整树导出，请用「导入数据」）' };
  }

  const envelope = parsed as Record<string, unknown>;
  const kind = envelope.kind;
  if (kind !== 'tool-prompts' && kind !== 'preset' && kind !== 'skill') {
    return {
      ok: false,
      error:
        '认不出这份文件是哪一类（缺 kind 或值不对）。' +
        '它可能是旧版的整树导出 —— 那种请用「导入数据」。',
    };
  }

  // 类别校验：拿着技能文件点「导入预设」必须当场说清，而不是塞进去变坏数据
  if (options.expect && options.expect !== kind) {
    return {
      ok: false,
      error:
        '这个文件是「' + KIND_LABELS[kind] + '」，导不进「' + KIND_LABELS[options.expect] + '」。' +
        '请用对应的「导入' + KIND_LABELS[kind] + '」。',
    };
  }

  if (kind === 'tool-prompts') {
    const overrides = envelope.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return { ok: false, kind, error: '工具提示词文件里没有 overrides 对象' };
    }
    return { ok: true, kind, overrides: overrides as ToolOverrideMap };
  }

  if (kind === 'preset') {
    const preset = envelope.preset;
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      return { ok: false, kind, error: '预设文件里没有 preset 对象' };
    }
    const item = preset as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) return { ok: false, kind, error: '这份预设没有 id，没法判断撞不撞车' };
    if ((options.builtinIds ?? []).includes(id)) {
      return {
        ok: false,
        kind,
        error:
          '这份预设的 id 是内置的（' + id + '），不能覆盖。' +
          '内置预设随版本自动更新，覆盖了下次刷新也会被打回 —— 可以「另存为」成新的一份。',
      };
    }
    const conflictName = (options.existing ?? {})[id];
    if (conflictName !== undefined) {
      return { ok: true, kind, preset: preset as Preset, conflict: { id, name: conflictName } };
    }
    return { ok: true, kind, preset: preset as Preset };
  }

  const skill = envelope.skill;
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    return { ok: false, kind, error: '技能文件里没有 skill 对象' };
  }
  const skillItem = skill as Record<string, unknown>;
  const skillId = typeof skillItem.id === 'string' ? skillItem.id : '';
  if (!skillId) return { ok: false, kind, error: '这份技能没有 id，没法判断撞不撞车' };
  if ((options.builtinIds ?? []).includes(skillId)) {
    return {
      ok: false,
      kind,
      error: '这份技能的 id 是内置的（' + skillId + '），不能覆盖。可以「另存为」成新的一份。',
    };
  }
  const skillConflict = (options.existing ?? {})[skillId];
  if (skillConflict !== undefined) {
    return { ok: true, kind, skill: skill as Skill, conflict: { id: skillId, name: skillConflict } };
  }
  return { ok: true, kind, skill: skill as Skill };
}

/** 三类各自的默认文件名（带时间戳，导出多次不会互相覆盖） */
export function transferFileName(kind: TransferKind, name: string, now = new Date()): string {
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  const stamp =
    String(now.getFullYear()) +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    '-' +
    p(now.getHours()) +
    p(now.getMinutes());
  const prefix = kind === 'tool-prompts' ? '工具提示词' : kind === 'preset' ? '预设' : '技能';
  const safe = (name || prefix).replace(/[\\/:*?"<>|]/g, '_').trim() || prefix;
  return safe + '.' + stamp + '.json';
}

/** 类别的人话名（界面要用；与报错文案同一份，不会两处不一致） */
export function transferKindLabel(kind: TransferKind): string {
  return KIND_LABELS[kind];
}
