/**
 * skill 同步层（B48/B51）：把「ST 真文件 + 索引」和 `RootData.skills` 接起来。
 *
 * ─────────────────────────── 谁是真源 ───────────────────────────
 *
 * **ST 真文件是真源**（用户已拍板 S2：走文件不走变量）。
 * `RootData.skills` 退化成一个**启动缓存** —— 它让界面和 runner 不必异步就能拿到技能清单，
 * 但它不再承载「唯一一份内容」：每次启动都从文件重新水合（hydrate）。
 *
 * 这么分工的原因：变量只有 8,000 字符（世界书手册一份就 27,642），
 * 而 runner / resolveCaps / 界面全是同步代码 —— 不能为了读技能把它们全改成 async。
 * 于是：**文件存内容，变量存快照**，启动时对齐一次。
 *
 * ─────────────────────────── 失败怎么办 ───────────────────────────
 *
 * 这一层**全部可失败**：拿不到 fetch（不在酒馆里 / 宿主没给）、文件读不出来、索引坏了 ——
 * 任何一种都只是「这次没同步上」，**绝不抛给调用方**，更不许把现有 skills 清空。
 * 理由：技能是可选的加速器，同步失败不该让底座不可用。
 */
import type { Skill } from './types.ts';
import {
  addUserSkillEntry,
  createSkillStoreDeps,
  emptyIndex,
  encodeSkillFile,
  indexEntryFromFactory,
  parseFrontmatter,
  readIndex,
  readSkillFileContent,
  releaseAllFactory,
  releaseSkill,
  removeSkill as removeSkillFromStore,
  saveSkillFile,
  writeIndex,
  type FactorySkill,
  type SkillIndex,
  type SkillStoreDeps,
} from './skill_store.ts';

/** 同步结果，给界面报人话用 */
export interface SkillSyncResult {
  ok: boolean;
  /** 这次从文件读到了几个技能 */
  loaded: number;
  /** 首次释放时写了几个文件 */
  released: number;
  /** 不同步的原因（ok=false 时有人话） */
  reason?: string;
}

/** 这台机器有没有读写 skill 文件的能力（没有就整层降级） */
export function canSyncSkills(deps: SkillStoreDeps = createSkillStoreDeps()): boolean {
  try {
    return typeof deps.getFetch() === 'function';
  } catch {
    return false;
  }
}

/**
 * 索引项 → `Skill`（界面 / runner 认的形状）。
 *
 * `body` 和 `files[].content` 都**现读文件**；读不到就留空（不让整条技能消失 ——
 * 名字和描述还在，用户至少看得见它、能点「恢复默认」）。
 */
async function hydrateOne(
  deps: SkillStoreDeps,
  entry: SkillIndex['skills'][number],
  factory: FactorySkill[],
): Promise<Skill> {
  const mainPath = entry.files.find(file => file.path === 'SKILL.md')?.path ?? entry.files[0]?.path ?? 'SKILL.md';
  const body = (await readSkillFileContent(deps, { version: 1, skills: [entry] }, factory, entry.id, mainPath)) ?? '';
  const files: { name: string; content: string }[] = [];
  for (const file of entry.files) {
    if (file.path === mainPath) continue;
    const content = await readSkillFileContent(deps, { version: 1, skills: [entry] }, factory, entry.id, file.path);
    files.push({ name: file.path, content: content ?? '' });
  }
  return {
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    body,
    files,
    enabled: entry.enabled,
    // 「内置」对界面 = 插件带的（有 fromPlugin）；用户自建的为 false
    builtin: entry.fromPlugin !== '',
  };
}

/**
 * 启动时同步一次：释放出厂 skill → 读索引 → 水合成 `Skill[]`。
 *
 * 返回**新的 skills 数组**（不改入参）；调用方把它塞回 store。
 * 拿不到文件能力 / 出任何错 → 返回 `ok: false` + 原样的 skills（降级，不动数据）。
 */
export async function syncSkillsFromStore(
  current: Skill[],
  factory: FactorySkill[],
  deps: SkillStoreDeps = createSkillStoreDeps(),
): Promise<{ skills: Skill[]; index: SkillIndex; result: SkillSyncResult }> {
  if (!canSyncSkills(deps)) {
    return {
      skills: current,
      index: emptyIndex(),
      result: { ok: false, loaded: 0, released: 0, reason: '这台机器拿不到网络能力（fetch），技能改从变量读' },
    };
  }

  try {
    const index = await readIndex(deps);
    // 首次运行：把出厂 skill 铺到 /user/files/（已有的不动 —— 见 releaseSkill 的说明）
    const released = await releaseAllFactory(deps, factory, index);

    // 插件**不再贡献**的 skill：索引里留着没关系（用户可能还在用），
    // 但已经不在出厂清单里的，界面上不该再标「内置」。
    const skills: Skill[] = [];
    for (const entry of index.skills) {
      skills.push(await hydrateOne(deps, entry, factory));
    }

    // 索引写了才算数（释放可能改了索引项）
    await writeIndex(deps, index);

    return {
      skills,
      index,
      result: { ok: true, loaded: skills.length, released: released.written },
    };
  } catch (error) {
    return {
      skills: current,
      index: emptyIndex(),
      result: {
        ok: false,
        loaded: 0,
        released: 0,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * 写回一个技能（用户点保存 / 另存为时调）。
 *
 * 语义：把 `skill.body` + `skill.files` 全量写进 ST 文件，并更新索引。
 * 这是 B51 之后**唯一**的技能写路径 —— 界面不再直接改 `data.skills` 就完事。
 */
export async function persistSkill(
  deps: SkillStoreDeps,
  index: SkillIndex,
  skill: Skill,
  factory: FactorySkill[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const exists = index.skills.some(entry => entry.id === skill.id);
    if (!exists) {
      const fromFactory = factory.find(item => item.id === skill.id);
      if (fromFactory) {
        // 插件带的技能：索引里先建好（内容随后覆盖）
        const entry = indexEntryFromFactory(fromFactory, skill.enabled);
        entry.name = skill.name;
        entry.summary = skill.summary;
        index.skills.push(entry);
      } else {
        addUserSkillEntry(index, { id: skill.id, name: skill.name, summary: skill.summary, enabled: skill.enabled });
      }
    }
    const entry = index.skills.find(item => item.id === skill.id);
    if (!entry) return { ok: false, error: '索引里没能建起这个技能：' + skill.id };

    entry.name = skill.name;
    entry.summary = skill.summary;
    entry.enabled = skill.enabled;

    // SKILL.md：正文 + 我们生成的 frontmatter（标准要求的 name / description）
    await saveSkillFile(deps, index, skill.id, 'SKILL.md', withFrontmatter(skill, entry.frontmatter));
    for (const file of skill.files) {
      if (!file.name) continue;
      await saveSkillFile(deps, index, skill.id, file.name, file.content);
    }
    await writeIndex(deps, index);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 给正文补 frontmatter。
 *
 * 只有「本来就没有」时才补：用户（或出厂内容）自己写的 frontmatter 一律保留原样 ——
 * 那是 Agent Skills 标准里描述这个技能的地方，不该被我们重写。
 */
function withFrontmatter(skill: Skill, existing: Record<string, string>): string {
  const parsed = parseFrontmatter(skill.body);
  if (parsed.ok || skill.body.trimStart().startsWith('---')) return skill.body;
  const name = existing.name || slugify(skill.id);
  const description = existing.description || skill.summary || skill.name;
  return '---\nname: ' + name + '\ndescription: ' + oneLine(description) + '\n---\n\n' + skill.body;
}

/** 把任意字符串收成 frontmatter 能安全承载的一行（换行会破坏 key: value） */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** id → 合法的 skill name（标准要求小写字母数字加连字符） */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

/**
 * 删除一个技能：先删文件（用户自建的才允许），成功再从 `skills` 数组里摘掉。
 */
export async function deleteSkillFromStore(
  deps: SkillStoreDeps,
  index: SkillIndex,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await removeSkillFromStore(deps, index, id);
  if (!result.ok) return result;
  try {
    await writeIndex(deps, index);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/**
 * 「恢复默认」：把这个技能从出厂内容重放一遍（force），再把正文读回来。
 *
 * 返回新的 `Skill`（`body` / `files` 已是出厂内容）；失败返回 `null`（调用方保留原样）。
 */
export async function restoreSkill(
  deps: SkillStoreDeps,
  index: SkillIndex,
  skill: Skill,
  factory: FactorySkill[],
): Promise<Skill | null> {
  const source = factory.find(item => item.id === skill.id);
  if (!source) return null;
  try {
    await releaseSkill(deps, source, index, { force: true });
    await writeIndex(deps, index);
    const entry = index.skills.find(item => item.id === skill.id);
    if (!entry) return null;
    return await hydrateOne(deps, entry, factory);
  } catch {
    return null;
  }
}

/** 读一次索引（给界面判断「有没有改过」用）；失败给空索引 */
export async function peekIndex(deps: SkillStoreDeps = createSkillStoreDeps()): Promise<SkillIndex> {
  if (!canSyncSkills(deps)) return emptyIndex();
  try {
    return await readIndex(deps);
  } catch {
    return emptyIndex();
  }
}

/** 这个技能的文件名长什么样（界面上给用户看「文件在哪」） */
export function skillFileNames(skill: Skill): string[] {
  return ['SKILL.md', ...skill.files.map(file => file.name)].map(path => encodeSkillFile(skill.id, path));
}

/** 顺手 re-export，免得界面为了一个类型多 import 一个文件 */
export type { FactorySkill, SkillIndex, SkillStoreDeps };
export { createSkillStoreDeps };
