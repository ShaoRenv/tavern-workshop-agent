/**
 * 苍玄助手 · skill 存储（**ST 真文件 + 索引**，B52/B53/B57）。
 *
 * ─────────────────────────── 为什么要这套东西 ───────────────────────────
 *
 * 老做法把 skill 正文塞进 `RootData.skills` —— 也就是酒馆变量（实测 8,000 字符上限）。
 * 世界书手册一份就 27,642 字符，**根本装不下**，而且变量是「一个 JSON 树」,
 * 塞进去之后每次保存都要把整棵树回传一遍。
 *
 * 现在改成**三层**（用户已拍板 S2「走 ST 文件」）：
 *
 *   第 1 层 · 出厂：编译进 index.js 的字符串（content.ts），用户改不到
 *   第 2 层 · 用户副本：`/user/files/cxskill_<id>__<路径>.md`，日常读写都在这
 *   第 3 层 · 索引：`/user/files/cx_skills_index.json`（**唯一真相源**）
 *
 * ─────────────────────────── 5 个硬约束（真机实测，别重开）───────────────────────────
 *
 * | 约束 | 出处 | 后果 |
 * |---|---|---|
 * | 文件名只允许 `[a-zA-Z0-9_\-.]` | ST `src/endpoints/assets.js:22` | 中文文件名 400 |
 * | **不允许子目录**（`/` 被拒） | 同上 | 树状不能靠目录，只能编码 |
 * | `.js/.py/.html/.sh` 等被挡 | `assets.js:30` + `constants.js:64` | 只敢用 `.md/.json/.txt` |
 * | **没有列目录 API** | `/api/files/` 404、`/user/files/` 500 | 必须靠索引枚举 |
 * | 不能以 `.` 开头 | `assets.js:37` | 小问题 |
 *
 * 于是路径映射是「**对外树状，对内扁平**」：
 *
 *   世界书工程/references/字段速查表.md  →  cxskill_worldbook__ref__字段速查表.md
 *                                          ^^^^^^^^^^^^ 中文在文件名里会被 400，所以再编码
 *
 * ⚠️ 编码里中文要**转成安全字符**：路径段先做 transliterate-ish 的兜底（见 safeSegment）。
 * 索引里存 `path`（人类可读的中文树状路径）和 `file`（真实文件名）两列，映射由索引负责。
 *
 * ─────────────────────────── 写盘口径 ───────────────────────────
 *
 * 全部走 ST 原生 `/api/files/*`：
 *   · 写：`POST /api/files/upload { name, data: base64 }`
 *   · 读：`GET /user/files/<name>`
 *   · 删：`POST /api/files/delete { path }`
 *   · 存在性：`POST /api/files/verify { urls: [...] }`
 * 都带 CSRF 头（ST 要 `X-CSRF-Token`，否则 403），拿法见 core/host.ts 的 getRequestHeaders。
 *
 * ⚠️ 本文件**不碰 RootData**：它只认「宿主 fetch + 索引」这一层。
 * 要不要释放 / 什么时候释放，由调用方（App.vue / stores）决定。
 */
import { hostFn } from './host.ts';

/* ============================ 常量 ============================ */

/** 索引文件放哪（放 files 根目录：ST 的 upload 不建子目录） */
export const SKILL_INDEX_PATH = '/user/files/cx_skills_index.json';
export const SKILL_INDEX_NAME = 'cx_skills_index.json';

/** 每个 skill 文件的文件名前缀 */
export const SKILL_FILE_PREFIX = 'cxskill_';

/** 索引格式版本；结构变了就涨它，读的时候据此迁移 */
export const SKILL_INDEX_VERSION = 1;

/** 出厂内容模块的 id（也是「这个 skill 归哪个插件」的默认值） */
export const FACTORY_SKILL_ID = 'worldbook';

/* ============================ 路径编码（B53）============================ */

/**
 * 一个路径段 → 能过 ST 文件名校验的安全段。
 *
 * ST 只认 `[a-zA-Z0-9_\-.]`，中文会 400。做法：
 *   · 已知的中文段走**固定映射表**（可读、稳定、好排查）
 *   · 表里没有的 → 逐字符：字母数字保留，其余转 `_<hex>`
 *
 * 为什么不直接 `encodeURIComponent`：它产出 `%E5%AD%97`，而 `%` 不在白名单里，照样 400。
 */
const KNOWN_SEGMENTS: Record<string, string> = {
  '世界书工程': 'worldbook',
  'SKILL.md': 'SKILL.md',
  'references': 'ref',
  '字段速查表.md': 'fields.md',
  '激活机制详解.md': 'activation.md',
  '注入位置与顺序.md': 'position.md',
  '条目范式与范例.md': 'patterns.md',
  '悬案与不确定项.md': 'open-issues.md',
};

/** 未知段：非白名单字符转 `_<hex>`（hex 只含 0-9a-f，安全） */
function safeSegment(segment: string): string {
  const known = KNOWN_SEGMENTS[segment];
  if (known) return known;
  let out = '';
  for (const char of segment) {
    if (/[A-Za-z0-9_\-.]/.test(char)) out += char;
    else out += '_' + char.codePointAt(0)!.toString(16);
  }
  // 空段 / 全是点之类的兜底，避免产出非法文件名
  if (!out || out === '.' || out === '..') return '_x' + Math.abs(hash32(segment)).toString(16);
  return out;
}

/** 树状相对路径 → 扁平文件名（B53 的编码规则） */
export function encodeSkillFile(skillId: string, relPath: string): string {
  const safeId = skillId.replace(/[^A-Za-z0-9_-]/g, '_') || 'skill';
  const segments = relPath.split('/').filter(Boolean).map(safeSegment);
  const tail = segments.join('__') || 'SKILL.md';
  // 保证以 .md 结尾（ST 认扩展名；无扩展名虽可上传，但读回来不好认）
  const withExt = /\.[A-Za-z0-9]+$/.test(tail) ? tail : tail + '.md';
  return SKILL_FILE_PREFIX + safeId + '__' + withExt;
}

/** 这个 skill 的文件在 ST 里的完整路径 */
export function skillFilePath(skillId: string, relPath: string): string {
  return '/user/files/' + encodeSkillFile(skillId, relPath);
}

/* ============================ 小工具 ============================ */

/** 稳定的 32 位哈希（FNV-1a）；用来判断「用户改过没有」 */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 内容指纹（16 进制，8 位）—— 索引里存它，用来比对出厂版 / 用户版 */
export function hashText(text: string): string {
  return hash32(text).toString(16).padStart(8, '0');
}

/** UTF-8 安全 base64（`btoa` 只吃 latin1，中文会炸） */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ============================ 宿主依赖 ============================ */

/**
 * skill 存储要的宿主能力。**全部可注入**（测试用假实现驱动，一行产品代码都不用改）。
 */
export interface SkillStoreDeps {
  /** 取 fetch（宿主能力 'fetch'）；拿不到 = 这台机器不能读写 skill 文件 */
  getFetch: () => typeof fetch | null;
  /** 取 CSRF token（ST 要 X-CSRF-Token，否则 403）；拿不到就返回 null 让请求去撞 */
  getCsrf: () => Promise<string | null>;
}

/** 生产用的依赖：宿主 fetch + CSRF（与外部插件装载器同一套口径） */
export function createSkillStoreDeps(): SkillStoreDeps {
  let csrf: string | null = null;
  const getFetch = (): typeof fetch | null => {
    const fn = hostFn('fetch') as typeof fetch | undefined;
    return typeof fn === 'function' ? fn : null;
  };
  return {
    getFetch,
    getCsrf: async () => {
      if (csrf) return csrf;
      const doFetch = getFetch();
      if (!doFetch) return null;
      // 优先用 ST 原生导出的 getRequestHeaders（S0 探针那条手写 /csrf-token 已退役）
      try {
        const headers = hostFn('getRequestHeaders') as (() => Record<string, string>) | undefined;
        if (typeof headers === 'function') {
          const token = headers()?.['X-CSRF-Token'];
          if (typeof token === 'string' && token) { csrf = token; return csrf; }
        }
      } catch {
        // 落回下面的 /csrf-token
      }
      try {
        const response = await doFetch('/csrf-token', { credentials: 'include' });
        const body = (await response.json()) as { token?: unknown };
        csrf = typeof body.token === 'string' ? body.token : null;
      } catch {
        csrf = null;
      }
      return csrf;
    },
  };
}

/* ============================ 低层：ST 文件读写 ============================ */

async function postJson(deps: SkillStoreDeps, url: string, body: unknown): Promise<{ status: number; text: string }> {
  const doFetch = deps.getFetch();
  if (!doFetch) throw new Error('这台机器拿不到网络能力（fetch），没法读写 skill 文件');
  const csrf = await deps.getCsrf();
  const response = await doFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** 写一个文本文件（同名覆盖） */
export async function writeTextFile(deps: SkillStoreDeps, name: string, text: string): Promise<string> {
  const result = await postJson(deps, '/api/files/upload', { name, data: toBase64(text) });
  if (result.status !== 200) {
    throw new Error('写文件失败（HTTP ' + result.status + '）：' + result.text.slice(0, 160));
  }
  try {
    const parsed = JSON.parse(result.text) as { path?: unknown };
    if (typeof parsed.path === 'string' && parsed.path) return parsed.path;
  } catch {
    // 回落到我们自己拼的路径
  }
  return '/user/files/' + name;
}

/** 读一个文本文件；文件不在返回 null（不抛） */
export async function readTextFile(deps: SkillStoreDeps, pathOrName: string): Promise<string | null> {
  const doFetch = deps.getFetch();
  if (!doFetch) throw new Error('这台机器拿不到网络能力（fetch），没法读 skill 文件');
  const url = pathOrName.startsWith('/') ? pathOrName : '/user/files/' + pathOrName;
  try {
    const response = await doFetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** 删一个文件（不在也算成功） */
export async function deleteFile(deps: SkillStoreDeps, path: string): Promise<void> {
  if (!path) return;
  try {
    await postJson(deps, '/api/files/delete', { path });
  } catch {
    // 删不掉不算致命：索引才是真相源，下次释放会覆盖
  }
}

/** 批量问「这些文件在不在」 */
export async function verifyFiles(deps: SkillStoreDeps, paths: string[]): Promise<Record<string, boolean>> {
  if (!paths.length) return {};
  try {
    const result = await postJson(deps, '/api/files/verify', { urls: paths });
    if (result.status !== 200) return {};
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) out[key] = value === true;
    return out;
  } catch {
    return {};
  }
}

/* ============================ 索引（B52）============================ */

/** 索引里的一条文件记录 */
export interface SkillIndexFile {
  /** 树状相对路径（人类 / 模型看到的那个，例如 references/字段速查表.md） */
  path: string;
  /** ST 里的真实文件名（编码过的扁平名） */
  file: string;
  /** 内容指纹（读回来时判断「用户改过没有」） */
  hash: string;
}

/** 索引里的一个 skill */
export interface SkillIndexEntry {
  id: string;
  name: string;
  /** 一句话描述：只有这句进系统提示词 */
  summary: string;
  enabled: boolean;
  /** 哪个插件带的（空 = 用户自建） */
  fromPlugin: string;
  /** 出厂版的整体指纹（判断用户改没改过；用户自建的为空） */
  factoryHash: string;
  /** SKILL.md frontmatter 里的原始字段（name / description / whenToUse / ...） */
  frontmatter: Record<string, string>;
  /** 权限位（B49）：模型不能自己调 / 用户可以主动调 */
  disableModelInvocation: boolean;
  userInvocable: boolean;
  files: SkillIndexFile[];
}

/** 索引文件的结构 */
export interface SkillIndex {
  version: number;
  skills: SkillIndexEntry[];
  /**
   * 共享纪律是不是被用户**显式关掉**了（B40）。
   *
   * ⚠️ 为什么需要这个布尔位：ST 的 `/api/files/upload` **拒收空内容**
   * （实测 400 `No upload data specified`），所以「用户想把纪律清空」这件事
   * **没法用一个空文件表达**。没有这一位的话，「清空」要么静默失败、
   * 要么被读成「回落到出厂默认」—— 两种都不是用户要的。
   *
   * 关掉时顺手把那个文件删了（文件不存在 + 这一位为 true = 明确的不注入）。
   */
  disciplineOff?: boolean;
}

/** 空索引 */
export function emptyIndex(): SkillIndex {
  return { version: SKILL_INDEX_VERSION, skills: [], disciplineOff: false };
}

/** 把任意输入收成合法索引（读文件 / 老数据迁移都用它兜底） */
export function parseIndex(raw: unknown): SkillIndex {
  const source = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(source.skills) ? source.skills : [];
  const skills: SkillIndexEntry[] = [];
  for (const item of list) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) continue;
    const files = Array.isArray(entry.files) ? entry.files : [];
    skills.push({
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      enabled: entry.enabled !== false,
      fromPlugin: typeof entry.fromPlugin === 'string' ? entry.fromPlugin : '',
      factoryHash: typeof entry.factoryHash === 'string' ? entry.factoryHash : '',
      frontmatter: (entry.frontmatter && typeof entry.frontmatter === 'object' ? entry.frontmatter : {}) as Record<string, string>,
      disableModelInvocation: entry.disableModelInvocation === true,
      userInvocable: entry.userInvocable !== false,
      files: files
        .map(file => {
          const f = (file ?? {}) as Record<string, unknown>;
          return {
            path: typeof f.path === 'string' ? f.path : '',
            file: typeof f.file === 'string' ? f.file : '',
            hash: typeof f.hash === 'string' ? f.hash : '',
          };
        })
        .filter(file => file.path && file.file),
    });
  }
  return { version: SKILL_INDEX_VERSION, skills, disciplineOff: source.disciplineOff === true };
}

/** 读索引；读不到 / 坏了都回落到空索引（不抛） */
export async function readIndex(deps: SkillStoreDeps): Promise<SkillIndex> {
  const text = await readTextFile(deps, SKILL_INDEX_PATH);
  if (!text) return emptyIndex();
  try {
    return parseIndex(JSON.parse(text));
  } catch {
    return emptyIndex();
  }
}

/** 写索引（唯一真相源，写完才算数） */
export async function writeIndex(deps: SkillStoreDeps, index: SkillIndex): Promise<void> {
  const payload: SkillIndex = {
    version: SKILL_INDEX_VERSION,
    skills: index.skills,
    disciplineOff: index.disciplineOff === true,
  };
  await writeTextFile(deps, SKILL_INDEX_NAME, JSON.stringify(payload, null, 2));
}

/* ============================ 共享纪律（B40）============================ */

/**
 * 共享纪律存在哪 —— 和 skill 一样走 ST 真文件，**不占那个 8,000 字符的变量**。
 *
 * 为什么不塞系统提示词：用户明确否决过 ——
 * 「我不想在系统提示词中注入系统提示词，因为这套 skill 不是 agent 的全部使用场景，
 *   这是一个酒馆内的 agent 底座而不是制卡改卡机器」。
 *
 * 做法照搬上游（TavernWeave 把同一段规矩同步进 22 个 SKILL.md 的头部），
 * 但**换掉实现**：它们是构建期脚本写进磁盘文件，我们是**运行期 skill() 拼在正文前**。
 * 差别在于不会漂移 —— 改一处就是改一处，没有 22 份副本要同步。
 */
export const SKILL_DISCIPLINE_PATH = '/user/files/cx_skills_discipline.md';
export const SKILL_DISCIPLINE_NAME = 'cx_skills_discipline.md';

/**
 * 出厂默认的共享纪律。
 *
 * ⚠️ **来源：TavernWeave skills/consult-tavernweave-library/references/communication-and-guidance.md**
 * （Copyright 2026 LiarMTTT · PolyForm Noncommercial License 1.0.0，全文见仓库根 THIRD_PARTY_NOTICES.md）。
 *
 * 取舍见 `reports/B40-共享纪律-待审.md`：上游 53 行里**真正通用的是 6 条**，
 * 其余要么是制卡专有（「接手卡二创」「改进作品」），要么依赖「引导挡位」这个我们没做的功能。
 * 逐条对照表在报告里，这里就是那 6 条。
 *
 * 用户可以在技能页改这段文本；改了就存进 SKILL_DISCIPLINE_PATH，
 * 以后读的是用户那份（读不到才回落到这里）。
 */
export const DEFAULT_SHARED_DISCIPLINE = [
  '## 沟通与引导（所有任务共同遵守）',
  '',
  '- 所有面向用户的说明、提问、计划、进度、报错、交付持续使用大白话。先说明结果、',
  '  影响或与用户目标的关系，再给必要依据、选择和下一步。',
  '- 必要术语首次出现时解释在当前任务中的意思。多项术语用「原术语 / 大白话 /',
  '  本次具体含义」对照，短任务可行内说明；不堆无关词典。项目特有缩写须查证，',
  '  不能凭常见含义猜测。',
  '- 事实、数值、否定、原因的不确定性、失败与未验证项必须保留。代码、宏、变量名、',
  '  引用、机器格式、必需报告结构保持各自要求。',
  '- 任何情况下在有需要或修 bug 时都必须详细解释，除非用户明确说对应范围没必要。',
  '  讲清出现条件、实际/预期表现、已证实原因与推测、处理方法、影响、验证结果及下一步。',
  '  需要理解机制或取舍才能行动时主动展开；长短以能理解和操作为准。',
  '- 「这次不用解释」只免除指定范围的长解释，仍报告结果、失败和未验证项；',
  '  「简短点」不自动取消必要解释。后续故障恢复默认详细解释。',
  '- 文件检查只证明规则已写入，不能证明客户端实际加载。报告文件/安装状态和新任务',
  '  实际使用证据，尚未观察时标为未验证；没有实际持久支持时说明限制，继续按可用',
  '  范围帮助用户。',
].join('\n');

/**
 * 读共享纪律。三种状态要分清：
 *
 * | 索引 disciplineOff | 文件 | 结果 |
 * |---|---|---|
 * | true | （已删） | **空串** = 不注入任何纪律（用户显式关掉的） |
 * | false | 有 | 用户那份 |
 * | false | 没有 | **出厂默认** |
 *
 * ⚠️ 为什么「关掉」要用索引里一个布尔位、而不是写个空文件：
 * ST 的 `/api/files/upload` **拒收空内容**（实测 400 `No upload data specified`）。
 * 真机踩出来的：点「恢复出厂文本 → 保存」时静默失败，文件里还是上一次的内容。
 *
 * @param index 当前索引（`disciplineOff` 从这读）。不传就只按文件判。
 */
export async function readSharedDiscipline(
  deps: SkillStoreDeps,
  index?: SkillIndex,
): Promise<{ text: string; fromUser: boolean; off: boolean }> {
  if (index?.disciplineOff) return { text: '', fromUser: false, off: true };
  const text = await readTextFile(deps, SKILL_DISCIPLINE_PATH);
  if (text === null) return { text: DEFAULT_SHARED_DISCIPLINE, fromUser: false, off: false };
  return { text, fromUser: true, off: false };
}

/**
 * 写共享纪律（用户在技能页改完点保存时调）。
 *
 * 空串 = **关掉**：不写文件（ST 也不收空内容），改成删掉那个文件 + 置 `disciplineOff`。
 * 非空 = 写文件 + 清掉 `disciplineOff`。
 *
 * 索引由调用方落盘（这里只改内存里那份）—— 因为写索引和写技能文件共用同一个入口，
 * 免得两处各写一半、落盘两次。
 */
export async function writeSharedDiscipline(
  deps: SkillStoreDeps,
  text: string,
  index: SkillIndex,
): Promise<void> {
  if (!text.trim()) {
    index.disciplineOff = true;
    await deleteFile(deps, SKILL_DISCIPLINE_PATH);
    return;
  }
  index.disciplineOff = false;
  await writeTextFile(deps, SKILL_DISCIPLINE_NAME, text);
}

/* ============================ SKILL.md frontmatter（B46）============================ */

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 复刻的是 **Agent Skills 标准**（依据 `@deepseek-ai/dsh-skill-filesystem` 的加载器）：
 *   · frontmatter **必须有**，且必须闭合
 *   · `name` **必须**
 *   · `description` **必须**
 *   · `whenToUse` / `metadata` / `disable-model-invocation` / `user-invocable` 可选
 *
 * ⚠️ 只认**平铺的 `key: value`**（含简单引号剥离），不引入 YAML 依赖：
 * 标准要求的这几个键都是标量，为 4 个标量键拉一个解析器不划算。
 * 真需要嵌套结构时再说。
 *
 * 解析失败**不抛**：返回 `{ ok: false, error }`，由调用方决定是回退到文件名还是报错。
 */
export interface SkillFrontmatter {
  /** frontmatter 里所有平铺键值 */
  fields: Record<string, string>;
  /** 正文（frontmatter 之后的部分） */
  body: string;
  ok: boolean;
  /** ok=false 时的人话原因 */
  error?: string;
}

/** 剥掉一层成对引号（单引号 / 双引号） */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const doubleQuoted = first === String.fromCharCode(34) && last === String.fromCharCode(34);
    const singleQuoted = first === String.fromCharCode(39) && last === String.fromCharCode(39);
    if (doubleQuoted || singleQuoted) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(text: string): SkillFrontmatter {
  const source = typeof text === 'string' ? text : '';
  // 允许 BOM / 前置空行：只在「第一处非空内容」判断分隔符
  const head = source.replace(/^\uFEFF/, '').replace(/^\s*\n/, '');
  if (!head.startsWith('---')) {
    return { fields: {}, body: source, ok: false, error: 'SKILL.md 缺 frontmatter（必须以 --- 开头）' };
  }
  const lines = head.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return { fields: {}, body: source, ok: false, error: 'frontmatter 没有闭合的 ---' };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = stripQuotes(trimmed.slice(colon + 1));
    if (key) fields[key] = value;
  }
  const body = lines.slice(end + 1).join('\n');
  if (!fields.name) return { fields, body, ok: false, error: 'frontmatter 缺必填的 name' };
  if (!fields.description) return { fields, body, ok: false, error: 'frontmatter 缺必填的 description' };
  return { fields, body, ok: true };
}

/** frontmatter 里的布尔位（标准里是 disable-model-invocation / user-invocable） */
export function frontBool(fields: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = fields[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === 'yes' || value === '1') return true;
  if (value === 'false' || value === 'no' || value === '0') return false;
  return fallback;
}

/* ============================ 出厂层：插件带来的 skill ============================ */

/** 出厂层的一个 skill（由插件 manifest 的 contributes.skills 提供） */
export interface FactorySkill {
  id: string;
  name: string;
  /** 一句话描述（进系统提示词） */
  summary: string;
  /** 哪个插件带的 */
  fromPlugin: string;
  /** 文件树：path 是树状相对路径，content 是正文 */
  files: { path: string; content: string }[];
}

/** 出厂层的整体指纹（判断用户改没改过；也是「恢复默认」的比对基准） */
export function factoryHashOf(skill: FactorySkill): string {
  // 每个文件的 path + 内容串起来算一个指纹；按 path 排序保证顺序稳定，改一个字就变
  const parts = [...skill.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(file => file.path + '\u0000' + file.content);
  return hashText(parts.join('\u0001'));
}

/** 出厂层里找 SKILL.md（没有就用第一个文件兜底） */
export function factoryBody(files: { path: string; content: string }[]): string {
  const main = files.find(file => file.path === 'SKILL.md') ?? files[0];
  return main?.content ?? '';
}

/** 从出厂内容现算一个索引项（不写盘，纯计算） */
export function indexEntryFromFactory(skill: FactorySkill, enabled = true): SkillIndexEntry {
  const parsed = parseFrontmatter(factoryBody(skill.files));
  return {
    id: skill.id,
    name: skill.name,
    summary: skill.summary,
    enabled,
    fromPlugin: skill.fromPlugin,
    factoryHash: factoryHashOf(skill),
    frontmatter: parsed.fields,
    disableModelInvocation: frontBool(parsed.fields, 'disable-model-invocation', false),
    userInvocable: frontBool(parsed.fields, 'user-invocable', true),
    files: skill.files.map(file => ({
      path: file.path,
      file: encodeSkillFile(skill.id, file.path),
      hash: hashText(file.content),
    })),
  };
}

/* ============================ 五个操作（设计稿 §2）============================ */

/** 释放 / 恢复的结果，给人话用 */
export interface ReleaseResult {
  /** 真写了几个文件 */
  written: number;
  /** 因为「和出厂版一致」而跳过的文件数 */
  skipped: number;
  /** 出了错的文件（不中断整体） */
  errors: string[];
}

/**
 * **释放**（首次运行）或**恢复默认**（单个 skill）。
 *
 * 语义是「把出厂内容铺到 /user/files/」：
 *   · 索引里没有这个 skill → 建索引项 + 写全部文件
 *   · 索引里已有 → **文件在的跳过、不在的补上**（绝不覆盖已有的）
 *
 * ⚠️ 「已有就不动」是**刻意**的，别改成「hash 不一致就重写」：
 * 那个条件分不清「用户改过」和「插件升级换了出厂内容」，会把用户的编辑静默冲掉。
 * 想同步回出厂版 = 显式 `force: true`（「恢复默认」按钮）。
 */
export async function releaseSkill(
  deps: SkillStoreDeps,
  skill: FactorySkill,
  index: SkillIndex,
  options: { force?: boolean } = {},
): Promise<ReleaseResult> {
  const result: ReleaseResult = { written: 0, skipped: 0, errors: [] };
  const next = indexEntryFromFactory(skill, true);
  const existing = index.skills.find(item => item.id === skill.id);
  // 保留用户关掉技能的开关状态（恢复默认不该把它重新打开）
  if (existing) next.enabled = existing.enabled;

  for (const file of skill.files) {
    const record = next.files.find(item => item.path === file.path);
    if (!record) continue;
    if (!options.force) {
      //
      // ⚠️ 非 force 的语义是「**把缺的补上，绝不覆盖已有的**」，不是「内容不一致就重写」。
      //
      // 为什么不能按「hash 和出厂版不同」判断：那个条件**分不清**两种情况 ——
      //   ① 用户自己改过（必须保住）
      //   ② 插件升级换了出厂内容（用户那份仍然该保住，读的就是用户那份）
      // 按 hash 判会把两种都当成「要重写」，于是**用户的编辑被静默冲掉** ——
      // 这条正是本文件早期版本的 bug（tests/苍玄助手/skill_store.test.ts 里那条用例抓到的）。
      //
      // 想主动同步回出厂版 = 点「恢复默认」= force。
      //
      const onDisk = await readTextFile(deps, record.file);
      if (onDisk !== null) {
        result.skipped++;
        continue;
      }
    }
    try {
      await writeTextFile(deps, record.file, file.content);
      result.written++;
    } catch (error) {
      result.errors.push(file.path + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  const at = index.skills.findIndex(item => item.id === skill.id);
  if (at >= 0) index.skills[at] = next;
  else index.skills.push(next);
  return result;
}

/**
 * 把一批出厂 skill 全部释放（启动时调一次）。
 *
 * ⚠️ **只补不覆盖**：已有索引项的走 `releaseSkill` 的差异路径，
 * 所以用户改过的内容不会被启动流程冲掉 —— 想冲掉得显式点「恢复默认」。
 */
export async function releaseAllFactory(
  deps: SkillStoreDeps,
  factory: FactorySkill[],
  index: SkillIndex,
): Promise<ReleaseResult> {
  const total: ReleaseResult = { written: 0, skipped: 0, errors: [] };
  for (const skill of factory) {
    const one = await releaseSkill(deps, skill, index);
    total.written += one.written;
    total.skipped += one.skipped;
    total.errors.push(...one.errors);
  }
  return total;
}

/**
 * 读一个 skill 的正文（第 2 层优先，读不到回退第 1 层）。
 *
 * 回退很重要：用户还没释放过（第一次装、或者文件被清掉了）时，
 * skill 仍然要能用 —— 出厂内容就在 bundle 里，不依赖磁盘。
 */
export async function readSkillBody(
  deps: SkillStoreDeps,
  index: SkillIndex,
  factory: FactorySkill[],
  id: string,
): Promise<string | null> {
  const entry = index.skills.find(item => item.id === id);
  if (entry) {
    const main = entry.files.find(file => file.path === 'SKILL.md') ?? entry.files[0];
    if (main) {
      const text = await readTextFile(deps, main.file);
      if (text !== null) return text;
    }
  }
  const fallback = factory.find(skill => skill.id === id);
  return fallback ? factoryBody(fallback.files) : null;
}

/**
 * 读 skill 的某个参考文件（同样是第 2 层优先、第 1 层兜底）。
 *
 * 返回 `null` = 这个 skill 里没有这个文件（调用方据此报「可读文件有哪些」）。
 */
export async function readSkillFileContent(
  deps: SkillStoreDeps,
  index: SkillIndex,
  factory: FactorySkill[],
  id: string,
  relPath: string,
): Promise<string | null> {
  const wanted = relPath.trim();
  const entry = index.skills.find(item => item.id === id);
  const record = entry?.files.find(file => file.path === wanted) ?? entry?.files.find(file => file.file === wanted);
  if (record) {
    const text = await readTextFile(deps, record.file);
    if (text !== null) return text;
  }
  const fallback = factory.find(skill => skill.id === id);
  const source = fallback?.files.find(file => file.path === wanted);
  return source ? source.content : null;
}

/**
 * 写一个 skill 文件（用户编辑 / 另存为都走这里）。
 *
 * 写完**同步更新索引里的 hash** —— 那是「用户改过没有」的唯一判据。
 */
export async function saveSkillFile(
  deps: SkillStoreDeps,
  index: SkillIndex,
  id: string,
  relPath: string,
  content: string,
): Promise<void> {
  const entry = index.skills.find(item => item.id === id);
  if (!entry) throw new Error('索引里没有这个技能：' + id);
  const fileName = encodeSkillFile(id, relPath);
  await writeTextFile(deps, fileName, content);
  const at = entry.files.findIndex(file => file.path === relPath);
  const record: SkillIndexFile = { path: relPath, file: fileName, hash: hashText(content) };
  if (at >= 0) entry.files[at] = record;
  else entry.files.push(record);
}

/** 新增一个用户自建 skill 的索引项（文件由 saveSkillFile 逐个写） */
export function addUserSkillEntry(
  index: SkillIndex,
  input: { id: string; name: string; summary: string; enabled?: boolean; frontmatter?: Record<string, string> },
): SkillIndexEntry {
  const entry: SkillIndexEntry = {
    id: input.id,
    name: input.name,
    summary: input.summary,
    enabled: input.enabled !== false,
    fromPlugin: '',
    factoryHash: '',
    frontmatter: input.frontmatter ?? {},
    disableModelInvocation: false,
    userInvocable: true,
    files: [],
  };
  const at = index.skills.findIndex(item => item.id === input.id);
  if (at >= 0) index.skills[at] = entry;
  else index.skills.push(entry);
  return entry;
}

/** 删掉一个 skill（文件 + 索引项）。内置的删不掉 —— 只允许删用户自建的。 */
export async function removeSkill(
  deps: SkillStoreDeps,
  index: SkillIndex,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = index.skills.find(item => item.id === id);
  if (!entry) return { ok: false, error: '索引里没有这个技能：' + id };
  if (entry.fromPlugin) return { ok: false, error: '插件带的技能删不掉 —— 想清空内容请用「恢复默认」' };
  for (const file of entry.files) await deleteFile(deps, '/user/files/' + file.file);
  index.skills = index.skills.filter(item => item.id !== id);
  return { ok: true };
}

/** 一个 skill 有没有被用户改过（拿索引里的出厂指纹和当前出厂版比） */
export function isSkillModified(entry: SkillIndexEntry, factory: FactorySkill | undefined): boolean {
  if (!factory) return false;
  return entry.factoryHash !== factoryHashOf(factory);
}
