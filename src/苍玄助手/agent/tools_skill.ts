/**
 * 技能工具：skill / read_skill_file / create_skill。
 *
 * 设计稿的规矩：只有「名称 + 一句话描述」会进系统提示词，正文等模型调 skill() 时才读，省 token。
 *
 * ─────────────────────────── B48-B51 改了什么 ───────────────────────────
 *
 * | 项 | 老行为 | 新行为 |
 * |---|---|---|
 * | B48/B51 内容来源 | 内存里的 `data.skills`（酒馆变量，8,000 字符上限） | **ST 真文件 + 索引**（core/skill_store.ts） |
 * | B50 截断 | 正文硬截断 20,000、文件 12,000 | 正文**不截断**；参考文件**分页**（offset/limit） |
 * | B47 树状 | `files[].name` 支持带路径但没人用 | 索引里存树状 `path`，`read_skill_file` 按它读 |
 * | B49 权限位 | 无 | `disable-model-invocation` / `user-invocable`（来自 SKILL.md frontmatter） |
 * | B40 共享纪律 | 无 | `skill()` 返回时在正文前拼一段**可编辑的**共享纪律 |
 *
 * ⚠️ 正文为什么不能截断：正文是**主入口**，模型拿到的必须是完整的一份。
 * 世界书手册 27,642 字符，老代码 20,000 就砍了尾巴 —— 而砍掉的正好是后半段操作细节。
 * 参考文件才分页，因为那是一次读不完的大块，分页读比一次塞爆上下文便宜。
 */
import type { ToolDef } from '../core/ports.ts';
import { asText, clip, resultFail, resultOk, schemaArray, schemaObject, schemaString } from './toolkit.ts';
import type { PluginStateHost } from '../plugins/types.ts';

/* ============================ 技能相关类型（registry.ts 从这里再导出） ============================ */

export interface AgentSkillLike {
  id: string;
  name: string;
  summary: string;
  body: string;
  /** 参考文件（树状 path）；read_skill_file 按 path 找 */
  files?: { name: string; content: string }[];
  /** B49：模型不能自己调（只能用户主动触发） */
  disable_model_invocation?: boolean;
  /** B49：用户可以主动调 */
  user_invocable?: boolean;
}

export interface SkillDraft {
  name: string;
  summary: string;
  body: string;
  files: { name: string; content: string }[];
}

export interface RegistryOptions {
  /**
   * 读技能参考文件。
   *
   * B48 起这个**必传**（内容在 ST 真文件里，工具自己读不到），
   * 传了就用它；没传才回落到 `ctx.skills[i].files`（测试 / 独立预览用）。
   */
  readSkillFile?: (skill: AgentSkillLike, fileName: string) => string | undefined;
  /** create_skill 生成的新技能交给谁保存；不传就只回结果给模型，由界面自己接 */
  createSkill?: (draft: SkillDraft) => void | Promise<void>;
  /**
   * 共享纪律（B40）：每次 skill() 返回时**拼在正文前面**。
   *
   * 为什么不塞系统提示词：用户明确否决过 ——
   * 「我不想在系统提示词中注入系统提示词，因为这套 skill 不是 agent 的全部使用场景，
   *   这是一个酒馆内的 agent 底座而不是制卡改卡机器」。
   *
   * 传空串 = 不注入（用户把那段文本清空时就是这个效果）。
   */
  shared_discipline?: string;
  /**
   * 插件开关状态（**内层映射**，即 `plugin_state` 那一段，不是 RootData 外壳）。
   *
   * 阶段 3 起插件工具也并进这张注册表，而「哪些插件开着」得看这份状态：
   * 不传 = 按 manifest 的 defaultEnabled 算（测试与独立预览用）。
   *
   * ⚠️ 类型故意取 `PluginStateHost['plugin_state']`（内层），而不是 `PluginStateHost`（外壳）：
   * 调用方（runner / App.vue）手里拿的就是内层映射，传外壳会让「字段全可选」的壳把所有错误吃掉。
   */
  plugin_state?: PluginStateHost['plugin_state'];
  /**
   * B21：文件工具的宿主依赖（write_file / read_file 用）。
   *
   * 与 `readSkillFile` 同一个口径：装配方给能力，测试注入假实现。
   * 不传 = 每次跑的时候现取生产依赖（走 hostFn 链）。
   */
  fileDeps?: import('../core/skill_store.ts').SkillStoreDeps;
}

/**
 * 参考文件的分页默认值（B50）。
 *
 * 为什么是 8,000 而不是原来那个 12,000：12,000 一次读完就顶满上下文，
 * 而分页的意义正是「一次少读一点、不够再要」。8,000 字符 ≈ 4,000 token 量级，
 * 单次调用不至于把预算吃光；不够模型会自己带 offset 再来一次。
 */
const FILE_PAGE_CHARS = 8000;

/** 单次最多读多少字符（防止模型要 limit=999999 把上下文一次打爆） */
const FILE_PAGE_MAX = 40000;

function findSkill(skills: AgentSkillLike[], name: string): AgentSkillLike | undefined {
  const wanted = name.trim();
  if (!wanted) return undefined;
  return (
    skills.find(item => item.name === wanted) ??
    skills.find(item => item.id === wanted) ??
    skills.find(item => item.name.trim() === wanted)
  );
}

/** 运行时对象上常常带着 files（虽然 ToolContext.skills 的签名里没有） */
function skillFiles(skill: AgentSkillLike): { name: string; content: string }[] {
  const raw = skill.files;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item && typeof item.name === 'string')
    .map(item => ({ name: item.name, content: typeof item.content === 'string' ? item.content : '' }));
}

/**
 * B49 权限位：这个技能允不允许模型自己调？
 *
 * `disable-model-invocation: true` = **只有用户主动触发**才能用（危险操作类）。
 * 模型在列表里仍然看得见它（用户问「有什么技能」时要答得上来），
 * 但调 `skill()` 会被拒，并给一句人话说明该请用户自己来。
 */
function modelMayInvoke(skill: AgentSkillLike): boolean {
  return skill.disable_model_invocation !== true;
}

/** 列表里给不可调的那些标一下，免得模型反复试 */
function listSkillsForModel(skills: AgentSkillLike[]): string {
  if (!skills.length) return '（本预设一个技能都没挂）';
  return skills
    .map(item => {
      const note = modelMayInvoke(item) ? '' : '（只能由用户主动触发，你不能自己调）';
      return '- ' + item.name + '：' + (item.summary || '(没写描述)') + note;
    })
    .join('\n');
}

export function createSkillTools(options: RegistryOptions = {}): ToolDef[] {
  const skillTool: ToolDef = {
    name: 'skill',
    group: 'skill',
    title: '读技能正文',
    desc: '按名字载入技能正文',
    model_description:
      '按名字载入一个技能的正文（怎么做这件事的具体步骤）。需要专门手法时先用它，再按技能里的规矩干活；不要凭技能名猜内容。',
    parameters: schemaObject(
      {
        name: schemaString('技能名称（或技能 id）'),
      },
      ['name'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const skills = (ctx.skills ?? []) as AgentSkillLike[];
      const name = asText(args.name).trim();
      if (!name) return resultFail('没给技能名', 'skill 需要 name 参数。可用技能：\n' + listSkillsForModel(skills));
      const found = findSkill(skills, name);
      if (!found)
        return resultFail('没有这个技能：' + name, '找不到技能「' + name + '」。当前可用技能：\n' + listSkillsForModel(skills));
      if (!modelMayInvoke(found)) {
        return resultFail(
          '技能「' + found.name + '」只能由用户主动触发',
          '技能「' + found.name + '」标了 disable-model-invocation，你不能自己调它。' +
            '如果确实需要，请告诉用户「这个技能需要你自己发起」，并说明你想用它做什么。',
        );
      }
      // B50：正文**不截断**（它是主入口，必须完整）。
      const body = found.body || '';
      const files = skillFiles(found);
      const tail = files.length
        ? '\n\n参考文件（可用 read_skill_file 读，大文件支持分页）：' + files.map(file => file.name).join('、')
        : '';
      // B40：共享纪律拼在**正文之前**（照搬上游「每个 SKILL.md 头部都有一份」的做法）
      const discipline = (options.shared_discipline ?? '').trim();
      const head = discipline ? discipline + '\n\n---\n\n' : '';
      return resultOk(
        '已载入「' + found.name + '」· ' + (head + body).length + ' 字',
        '技能「' + found.name + '」正文：\n' + head + (body || '(正文是空的)') + tail,
      );
    },
  };

  const readSkillFile: ToolDef = {
    name: 'read_skill_file',
    group: 'skill',
    title: '读技能参考文件',
    desc: '读技能带的模板/范例文件（大文件可翻页）',
    model_description:
      '读技能附带的参考文件（模板、范例、格式说明）。只在需要时读，先 skill() 拿到技能正文，再从它的文件列表里挑。文件很长时会分页，按返回里的提示继续读下一段。',
    parameters: schemaObject(
      {
        skill: schemaString('技能名称；不填 = 本轮只挂了一个技能时用那个'),
        file: schemaString('文件名（树状路径），要和技能里的文件列表一字不差'),
        offset: schemaString('从第几个字符开始读（默认 0）；接上一页的「下次从这里开始」'),
        limit: schemaString('这次最多读多少字符（默认 ' + FILE_PAGE_CHARS + '，上限 ' + FILE_PAGE_MAX + '）'),
      },
      ['file'],
    ),
    default_on: true,
    run: async (args, ctx) => {
      const skills = (ctx.skills ?? []) as AgentSkillLike[];
      let target: AgentSkillLike | undefined;
      const skillName = asText(args.skill).trim();
      if (skillName) {
        target = findSkill(skills, skillName);
        if (!target)
          return resultFail(
            '没有这个技能：' + skillName,
            '找不到技能「' + skillName + '」。当前可用技能：\n' + listSkillsForModel(skills),
          );
      } else if (skills.length === 1) {
        target = skills[0];
      } else {
        return resultFail(
          '没说清读哪个技能的',
          'read_skill_file 需要 skill 参数。当前可用技能：\n' + listSkillsForModel(skills),
        );
      }
      const file = asText(args.file).trim();
      if (!file) return resultFail('没给文件名', 'read_skill_file 需要 file 参数。');
      const injected = options.readSkillFile?.(target, file);
      const files = skillFiles(target);
      const local =
        files.find(item => item.name === file) ??
        files.find(item => item.name.trim() === file) ??
        files.find(item => item.name.endsWith('/' + file));
      const content = typeof injected === 'string' ? injected : local?.content;
      if (content === undefined) {
        const names = files.map(item => item.name);
        return resultFail(
          '技能「' + target.name + '」里没有文件：' + file,
          names.length ? '可读文件：' + names.join('、') : '技能「' + target.name + '」没有附带参考文件。',
        );
      }
      // B50：分页。offset/limit 是字符串参数（schema 只给了 string），所以自己解析并夹住范围。
      const total = content.length;
      const start = clampInt(args.offset, 0, total, 0);
      const size = clampInt(args.limit, 1, FILE_PAGE_MAX, FILE_PAGE_CHARS);
      const end = Math.min(total, start + size);
      const page = content.slice(start, end);
      const more = end < total;
      /**
       * 「要不要显示页码」只按**这一页是不是全文**判，不按 size 判。
       *
       * ⚠️ 这里踩过一次：原来判据是 `total > size || start > 0`，于是「文件比一页小」时
       * detail 走「全文」分支、brief 却仍写 `0–5 / 5`，两处说法不一致（测试抓到的）。
       */
      const whole = start === 0 && !more;
      const head =
        '技能「' + target.name + '」的参考文件「' + file + '」' +
        (whole ? '（全文 ' + total + ' 字符）' : '（第 ' + start + '–' + end + ' 字符 / 共 ' + total + ' 字符）') +
        '：\n';
      const tail = more ? '\n\n…还有 ' + (total - end) + ' 字符没读完。继续读请带 offset=' + end + '。' : '';
      return resultOk(
        '已读「' + target.name + ' / ' + file + '」' + (whole ? total + ' 字（全文）' : start + '–' + end + ' / ' + total + ' 字'),
        head + page + tail,
      );
    },
  };

  const createSkill: ToolDef = {
    name: 'create_skill',
    group: 'skill',
    title: '存成技能',
    desc: '把这次的做法存成技能',
    model_description:
      '把一套可复用的做法存成一个新技能（名称 + 一句话描述 + 正文 + 可选参考文件），下次别的预设也能用。**仅当用户明确要求时使用**：用户没说要存技能就不要调它。',
    parameters: schemaObject(
      {
        name: schemaString('技能名称，短而具体'),
        summary: schemaString('一句话描述：什么时候用它，这句会进系统提示词，必须写清楚'),
        body: schemaString('技能正文：具体步骤、规矩、格式要求'),
        files: schemaArray(
          '参考文件（模板 / 范例）',
          schemaObject(
            { name: schemaString('文件名（可带树状路径，例如 references/字段速查表.md）'), content: schemaString('文件内容') },
            ['name'],
            '一个参考文件：文件名 + 内容',
          ),
        ),
      },
      ['name', 'summary', 'body'],
    ),
    default_on: false,
    user_initiated_only: true,
    run: async args => {
      const name = asText(args.name).trim();
      const summary = asText(args.summary).trim();
      const body = asText(args.body);
      if (!name) return resultFail('技能得有个名字', 'create_skill 需要 name。');
      if (!summary)
        return resultFail('技能得有一句话描述', 'create_skill 需要 summary：这句会进系统提示词，写清楚什么时候用它。');
      const files = Array.isArray(args.files)
        ? (args.files as unknown[])
            .map(item => {
              const object = (item ?? {}) as Record<string, unknown>;
              return { name: asText(object.name).trim(), content: asText(object.content) };
            })
            .filter(item => item.name)
        : [];
      const draftSkill: SkillDraft = { name, summary, body, files };
      let saved = false;
      if (options.createSkill) {
        try {
          await options.createSkill(draftSkill);
          saved = true;
        } catch (error) {
          return resultFail(
            '保存技能失败',
            'create_skill 保存失败：' + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      const payload = JSON.stringify(draftSkill, null, 2);
      return resultOk(
        '技能草稿「' + name + '」' + (saved ? ' 已交给技能页' : ' 已生成（等界面保存）'),
        (saved
          ? '技能已保存到技能页，默认不启用，需要用户在技能页勾上。'
          : '技能内容已生成，界面会把它放进技能页待保存。') +
          '\n\n' +
          clip(payload, 6000),
      );
    },
  };

  return [skillTool, readSkillFile, createSkill];
}

/**
 * 把字符串参数解析成夹在 [min, max] 里的整数。
 *
 * schema 那边只声明了 `string`（本工程的 schemaString 只有一种），
 * 所以模型可能给 'abc' / '-5' / '1e9' —— 一律当「没给」处理，绝不把 NaN 传下去。
 */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return Math.min(max, Math.max(min, int));
}

/** 给 UI 用：技能清单摘要（名称 + 一句话描述），就是会进系统提示词的那部分 */
export function skillCatalogText(skills: AgentSkillLike[]): string {
  return skills.map(item => '- ' + item.name + '：' + (item.summary || '(没写描述)')).join('\n');
}
