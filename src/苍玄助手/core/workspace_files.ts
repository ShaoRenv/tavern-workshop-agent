/**
 * B21：`write_file` / `read_file` —— 让 agent 能把东西**落到酒馆文件里**。
 *
 * ─────────────────────────── 为什么需要它 ───────────────────────────
 *
 * 用户指出的 B6：「JSON 输出没做成工具」。现状是 `makeArtifact` **被动** ——
 * 只有预设的 `output !== none` 时，回复里恰好有可解析 JSON 才会被存进 `RootData.artifacts`
 * （那是酒馆变量，8,000 字符上限）。模型**没有主动落盘的手段**。
 *
 * 而「产出一份 JSON 给用户」是真实需求（智绘姬的角色预设就是一大坨 JSON，见
 * `reports/会话决策记录.md` §2）。所以补两个工具，让模型自己说「存到哪」。
 *
 * ─────────────────────────── 走 ST 真文件，不走变量 ───────────────────────────
 *
 * 复用 `core/skill_store.ts` 那套已验证的 I/O（`/api/files/upload` + `GET /user/files/`），
 * 因为变量装不下（整棵树实测 8,000 字符），而文件没有长度限制（实测 200 字符文件名 OK）。
 *
 * ─────────────────────────── ⚠️ 三个硬约束（真机实测）───────────────────────────
 *
 * | 约束 | 出处 | 后果 |
 * |---|---|---|
 * | 文件名只允许 `[a-zA-Z0-9_\-.]` | ST `src/endpoints/assets.js:22` | 中文名 400 |
 * | **不允许子目录** | 同上 | `/` 被拒，只能扁平 |
 * | `.js/.py/.html/.sh` 等被挡 | `assets.js:30` + `constants.js:64` | 只敢用 `.json/.md/.txt` |
 *
 * **中文文件名不行** → 中文名要编码（`encodeFileName`），人话名留在返回值里给模型看。
 *
 * ─────────────────────────── 安全口径 ───────────────────────────
 *
 * 这两个工具**只动 `/user/files/` 下的文件**，且文件名强制加前缀 `cx-file-`：
 *   · 加前缀 → 一眼看出是 agent 写的，也**绝不会撞上** skill 的 `cxskill_*` 与索引文件
 *   · 不实现删目录 / 通配 / 遍历 —— 没有「删」这个动作，要删让用户去酒馆文件管理里删
 */
import { toBase64, createSkillStoreDeps, type SkillStoreDeps } from './skill_store.ts';

/** agent 写的文件统一带这个前缀（与 skill 的 `cxskill_` 区分开） */
export const FILE_PREFIX = 'cx-file-';

/** 允许的扩展名。**故意的白名单**，不是黑名单 —— ST 挡了一批，我们别去试边界 */
export const ALLOWED_EXTENSIONS = ['.json', '.md', '.txt'] as const;

/** 单次写入的字节上限（1 MB）。超了直接拒绝，别把磁盘当垃圾场 */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * 中文 / 特殊字符 → 能过 ST 校验的安全段。
 *
 * 与 `skill_store.ts` 的 `safeSegment` 同一套思路（非白名单字符转 `_<hex>`），
 * 但这里**不查映射表** —— 用户给的文件名是任意的，映射表不可能穷举。
 * 纯 ASCII 名字（英文 / 数字 / `_-.`）会**原样保留**，所以「role.json」还是 role.json，
 * 只有中文名才会变成 `_<hex>` 串。
 */
export function encodeFileName(name: string): string {
  const raw = String(name ?? '').trim();
  let out = '';
  for (const char of raw) {
    if (/[A-Za-z0-9_\-.]/.test(char)) out += char;
    else out += '_' + char.codePointAt(0)!.toString(16);
  }
  return out;
}

/**
 * 把模型给的路径收成一个**安全的落盘名**（带前缀、带白名单扩展名）。
 *
 * 规则：
 *   · 去掉目录部分（ST 不收子目录）—— 但保留它做人话提示，免得用户以为存到了子目录
 *   · 扩展名不在白名单里 → **换成 `.txt`**（不报错：模型经常忘记写扩展名，
 *     而「写了但被拒」比「按 txt 存下」更让人困惑。返回值里会说明换过）
 *   · 空名 → 给一个带时间戳的兜底名
 *
 * @returns { name, changedExt, hadDir } —— 后两个用于在结果里如实告知
 */
export function resolveFileName(raw: string): { name: string; changedExt: boolean; hadDir: boolean } {
  const text = String(raw ?? '').trim();
  const hadDir = text.includes('/') || text.includes('\\');
  const base = text.split(/[/\\]/).filter(Boolean).pop() ?? '';

  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0;
  const stemRaw = hasExt ? base.slice(0, dot) : base;
  const extRaw = hasExt ? base.slice(dot).toLowerCase() : '';

  const allowed = (ALLOWED_EXTENSIONS as readonly string[]).includes(extRaw);
  const changedExt = hasExt && !allowed;
  const ext = allowed ? extRaw : '.txt';

  //
  // ⚠️ **已经带前缀的不要再加一次**（真机流程跑通前先被单测抓到的 bug）。
  //
  // 模型的标准用法是「write_file 存完，拿返回值里的文件名去 read_file 读回来确认」。
  // 如果无脑再拼一次前缀，就会去找 `cx-file-cx-file-role.json` —— 永远读不到，
  // 而模型看到的是「我明明刚存过」的困惑。
  //
  // 判据：名字已经以 FILE_PREFIX 开头就不再拼。
  //
  const hadPrefix = base.startsWith(FILE_PREFIX);
  const stemInput = hadPrefix ? stemRaw.slice(FILE_PREFIX.length) : stemRaw;
  const stem = encodeFileName(stemInput) || 'untitled-' + Date.now().toString(36);
  // 文件名总长兜底：ST 那边没测出上限，但太长的名字在任何系统里都是麻烦
  return { name: FILE_PREFIX + stem.slice(0, 120) + ext, changedExt, hadDir };
}

/**
 * 这个文件名带不带我们的前缀。
 *
 * ⚠️ 它**不是** `read_file` 的越界闸 —— 那里的保护是「前缀永远被强制加上」
 * （见 `readWorkspaceFile` 的说明，这个谓词曾被误当成闸写成死代码）。
 * 现在它的用途是：**测试与界面判断「这个名字是不是我们这一命名空间的」**。
 */
export function isOwnFileName(name: string): boolean {
  return String(name ?? '').startsWith(FILE_PREFIX);
}

/* ============================ 落盘 / 读取（给工具用）============================ */

/** 写文件的结果，工具拿它拼人话 */
export interface WriteFileResult {
  ok: boolean;
  /** 真正落盘的文件名（带前缀 + 扩展名） */
  name: string;
  /** 完整访问路径，给用户看「文件在哪」 */
  path: string;
  bytes: number;
  /** 扩展名被换过（模型给了 .js 之类） */
  changedExt: boolean;
  /** 名字里带过目录（被拍平了） */
  hadDir: boolean;
  error?: string;
}

/** 把文本写进 `/user/files/`；**同名覆盖**。不抛，失败给人话。 */
export async function writeWorkspaceFile(
  deps: SkillStoreDeps,
  rawName: string,
  text: string,
): Promise<WriteFileResult> {
  const { name, changedExt, hadDir } = resolveFileName(rawName);
  const content = typeof text === 'string' ? text : '';
  const bytes = new TextEncoder().encode(content).length;
  const path = '/user/files/' + name;

  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      name,
      path,
      bytes,
      changedExt,
      hadDir,
      error: '内容太大（' + bytes + ' 字节，上限 ' + MAX_FILE_BYTES + '）',
    };
  }

  const doFetch = deps.getFetch();
  if (!doFetch) {
    return { ok: false, name, path, bytes, changedExt, hadDir, error: '这台机器拿不到网络能力（fetch），没法写文件' };
  }

  try {
    const csrf = await deps.getCsrf();
    const response = await doFetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ name, data: toBase64(content) }),
    });
    if (response.status !== 200) {
      const body = await response.text();
      return {
        ok: false,
        name,
        path,
        bytes,
        changedExt,
        hadDir,
        error: '写文件失败（HTTP ' + response.status + '）：' + body.slice(0, 160),
      };
    }
    return { ok: true, name, path, bytes, changedExt, hadDir };
  } catch (error) {
    return {
      ok: false,
      name,
      path,
      bytes,
      changedExt,
      hadDir,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 读文件的结果 */
export interface ReadFileResult {
  ok: boolean;
  name: string;
  /** 文件不在（与「读失败」分开：不在是正常情况，读失败是环境问题） */
  missing: boolean;
  text: string;
  error?: string;
}

/**
 * 从 `/user/files/` 读文本。不抛。
 *
 * ─────────────────────────── 越界保护靠什么 ───────────────────────────
 *
 * **靠「前缀永远被强制加上」这条结构性质**，不是靠一个事后检查。
 *
 * `resolveFileName` 会把任何输入收成 `cx-file-<安全名>.<白名单扩展名>`：
 *   · 目录被拍平（`/`、`\` 都切掉，只留最后一段）；
 *   · 已经有前缀的不重复加（见那里的往返说明）。
 *
 * 于是模型无论传什么，落到的都是**我们自己那一命名空间**：
 *
 * ```
 * 传 cx_skills_index.json  → 找 cx-file-cx_skills_index.json → 404（读不到 skill 索引）
 * 传 cxskill_xxx__SKILL.md → 找 cx-file-cxskill_xxx__SKILL.md → 404
 * 传 ../../cx_skills_index.json → 同上（目录被拍平）
 * ```
 *
 * ⚠️ 我一开始在这里写了个 `isOwnFileName(name)` 检查 —— 那是**死代码**：
 * `name` 是 `resolveFileName` 的产物，它**必然**带前缀，检查永远通过。
 * 单测把这条「越界应该报错」的断言跑出来才发现（断言根本触发不到）。
 * 真正该测的是**上面那条性质**：传外来名字读不到外来内容。
 */
export async function readWorkspaceFile(
  deps: SkillStoreDeps,
  rawName: string,
): Promise<ReadFileResult> {
  const { name } = resolveFileName(rawName);
  const doFetch = deps.getFetch();
  if (!doFetch) {
    return { ok: false, name, missing: false, text: '', error: '这台机器拿不到网络能力（fetch），没法读文件' };
  }
  try {
    const response = await doFetch('/user/files/' + name, { credentials: 'include' });
    if (response.status === 404) return { ok: false, name, missing: true, text: '' };
    if (!response.ok) {
      return { ok: false, name, missing: false, text: '', error: '读文件失败（HTTP ' + response.status + '）' };
    }
    return { ok: true, name, missing: false, text: await response.text() };
  } catch (error) {
    return { ok: false, name, missing: false, text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** 生产用的依赖（与 skill 存储同一套：宿主 fetch + CSRF） */
export function createFileDeps(): SkillStoreDeps {
  return createSkillStoreDeps();
}
