/**
 * 技能工具：skill / read_skill_file / create_skill
 *
 * 设计稿的规矩：只有「名称 + 一句话描述」会进系统提示词，正文等模型调 skill() 时才读，省 token。
 * read_skill_file 读参考文件；create_skill 默认关，且描述里明写「仅当用户明确要求时使用」。
 */
import type { ToolDef } from '../core/ports.ts';
import { asText, clip, resultFail, resultOk, schemaArray, schemaObject, schemaString } from './tools_worldbook.ts';

/* ============================ 技能相关类型（registry.ts 从这里再导出） ============================ */

export interface AgentSkillLike {
  id: string;
  name: string;
  summary: string;
  body: string;
  /** ToolContext.skills 的签名里没有 files，运行时对象上通常带着；也支持 options.readSkillFile 注入 */
  files?: { name: string; content: string }[];
}

export interface SkillDraft {
  name: string;
  summary: string;
  body: string;
  files: { name: string; content: string }[];
}

export interface RegistryOptions {
  /** 读技能参考文件；不传就只认 ctx.skills[i].files */
  readSkillFile?: (skill: AgentSkillLike, fileName: string) => string | undefined;
  /** create_skill 生成的新技能交给谁保存；不传就只回结果给模型，由界面自己接 */
  createSkill?: (draft: SkillDraft) => void | Promise<void>;
}

const BODY_LIMIT = 20000;
const FILE_LIMIT = 12000;

function listSkills(skills: AgentSkillLike[]): string {
  if (!skills.length) return '（本预设一个技能都没挂）';
  return skills.map(item => '- ' + item.name + '：' + (item.summary || '(没写描述)')).join('\n');
}

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
      if (!name) return resultFail('没给技能名', 'skill 需要 name 参数。可用技能：\n' + listSkills(skills));
      const found = findSkill(skills, name);
      if (!found)
        return resultFail('没有这个技能：' + name, '找不到技能「' + name + '」。当前可用技能：\n' + listSkills(skills));
      const body = clip(found.body, BODY_LIMIT, '\n…（技能正文过长已截断）');
      const files = skillFiles(found);
      const tail = files.length
        ? '\n\n参考文件（可用 read_skill_file 读）：' + files.map(file => file.name).join('、')
        : '';
      return resultOk(
        '已载入「' + found.name + '」· ' + body.length + ' 字',
        '技能「' + found.name + '」正文：\n' + (body || '(正文是空的)') + tail,
      );
    },
  };

  const readSkillFile: ToolDef = {
    name: 'read_skill_file',
    group: 'skill',
    title: '读技能参考文件',
    desc: '读技能带的模板/范例文件',
    model_description:
      '读技能附带的参考文件（模板、范例、格式说明）。只在需要时读，先 skill() 拿到技能正文，再从它的文件列表里挑。',
    parameters: schemaObject(
      {
        skill: schemaString('技能名称；不填 = 本轮只挂了一个技能时用那个'),
        file: schemaString('文件名，要和技能里的文件列表一字不差'),
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
            '找不到技能「' + skillName + '」。当前可用技能：\n' + listSkills(skills),
          );
      } else if (skills.length === 1) {
        target = skills[0];
      } else {
        return resultFail(
          '没说清读哪个技能的',
          'read_skill_file 需要 skill 参数。当前可用技能：\n' + listSkills(skills),
        );
      }
      const file = asText(args.file).trim();
      if (!file) return resultFail('没给文件名', 'read_skill_file 需要 file 参数。');
      const injected = options.readSkillFile?.(target, file);
      const files = skillFiles(target);
      const local = files.find(item => item.name === file) ?? files.find(item => item.name.trim() === file);
      const content = typeof injected === 'string' ? injected : local?.content;
      if (content === undefined) {
        const names = files.map(item => item.name);
        return resultFail(
          '技能「' + target.name + '」里没有文件：' + file,
          names.length ? '可读文件：' + names.join('、') : '技能「' + target.name + '」没有附带参考文件。',
        );
      }
      return resultOk(
        '已读「' + target.name + ' / ' + file + '」· ' + content.length + ' 字',
        '技能「' +
          target.name +
          '」的参考文件「' +
          file +
          '」：\n' +
          clip(content, FILE_LIMIT, '\n…（文件过长已截断）'),
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
        name: schemaString('技能名称，短而具体，例如「世界书精修」'),
        summary: schemaString('一句话描述：什么时候用它，这句会进系统提示词，必须写清楚'),
        body: schemaString('技能正文：具体步骤、规矩、格式要求'),
        files: schemaArray(
          '参考文件（模板 / 范例）',
          schemaObject(
            { name: schemaString('文件名（含后缀，模型用 read_skill_file 读它）'), content: schemaString('文件内容') },
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

/** 给 UI 用：技能清单摘要（名称 + 一句话描述），就是会进系统提示词的那部分 */
export function skillCatalogText(skills: AgentSkillLike[]): string {
  return skills.map(item => '- ' + item.name + '：' + (item.summary || '(没写描述)')).join('\n');
}
