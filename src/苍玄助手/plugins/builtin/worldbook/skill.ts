/**
 * 世界书工程 skill · 出厂清单（把 content.ts 的字符串包成插件贡献的形状）。
 *
 * 为什么单独一个文件、不写在 manifest.ts 里：
 *   manifest 要尽量薄（它被注册表静态 import，改它容易波及一堆测试），
 *   而「skill 有几个文件、叫什么名字」是**内容层**的事，跟着 content.ts 走更清楚。
 *
 * ⚠️ 这里是**出厂层**（第 1 层）：内容编译进 index.js，用户改不到。
 * 用户改的是释放到 /user/files/ 的第 2 层副本；「恢复默认」从这份重放。
 */
import type { PluginSkillRef } from '../../types.ts';
import {
  REF_ACTIVATION,
  REF_FIELDS,
  REF_OPEN_ISSUES,
  REF_PATTERNS,
  REF_POSITION,
  SKILL_MD,
} from './skills/世界书工程/content.ts';

/**
 * 出厂 skill 的 id。
 *
 * 用 `worldbook`（不是 `builtin-skill-worldbook-...`）—— 它同时也是文件名编码里的那段，
 * 短、稳定、不含中文，出问题时肉眼一看就知道是哪个 skill 的文件。
 */
export const WORLDBOOK_SKILL_ID = 'worldbook';

/** 世界书工程 skill 的文件树（顺序 = 树状展示顺序） */
export const WORLDBOOK_SKILL_FILES: { path: string; content: string }[] = [
  { path: 'SKILL.md', content: SKILL_MD },
  { path: 'references/字段速查表.md', content: REF_FIELDS },
  { path: 'references/激活机制详解.md', content: REF_ACTIVATION },
  { path: 'references/注入位置与顺序.md', content: REF_POSITION },
  { path: 'references/条目范式与范例.md', content: REF_PATTERNS },
  { path: 'references/悬案与不确定项.md', content: REF_OPEN_ISSUES },
];

/**
 * 交给插件注册表的那一份（contributes.skills）。
 *
 * `desc` 就是**会进系统提示词的那一句** —— 按「什么时候用它」写，不要复述正文。
 */
export const worldbookSkillRef: PluginSkillRef = {
  id: WORLDBOOK_SKILL_ID,
  name: '世界书工程',
  desc: '改酒馆世界书：改前看结构、改后回读',
  content: SKILL_MD,
  files: WORLDBOOK_SKILL_FILES.filter(file => file.path !== 'SKILL.md').map(file => ({
    name: file.path,
    content: file.content,
  })),
};

export default worldbookSkillRef;