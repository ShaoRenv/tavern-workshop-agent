/**
 * B21：`write_file` / `read_file` 两个工具（底座工具，不属于任何插件）。
 *
 * 为什么归底座而不是某个插件：它们是**通用出口**（模型把结果落盘），
 * 跟世界书 / 生图 / 立绘都不沾边。放插件里的话，「这个插件关掉就没有落盘能力」
 * 会变成一个莫名其妙的耦合。
 *
 * 真正的 I/O 在 `core/workspace_files.ts`（那层只管「怎么写、写去哪、什么名字合法」），
 * 这里只管**跟模型说话**：参数怎么收、返回什么话、失败怎么解释。
 */
import type { ToolDef } from '../core/ports.ts';
import {
  createFileDeps,
  readWorkspaceFile,
  writeWorkspaceFile,
  type ReadFileResult,
  type WriteFileResult,
} from '../core/workspace_files.ts';
import type { SkillStoreDeps } from '../core/skill_store.ts';
import { asText, clip, resultFail, resultOk, schemaObject, schemaString } from './toolkit.ts';

export interface FileToolOptions {
  /**
   * 文件 I/O 的宿主依赖。不传 = 每次跑的时候现取（生产路径）。
   *
   * 测试注入假实现；与 `RegistryOptions.readSkillFile` 是同一种「装配方给能力」的口径。
   */
  fileDeps?: SkillStoreDeps;
}

/** 单次返回给模型的正文上限（读大文件时别把上下文打爆） */
const READ_LIMIT = 12000;

function writeOkDetail(result: WriteFileResult): string {
  const notes: string[] = [];
  if (result.changedExt) notes.push('扩展名不在允许列表里，已按 .txt 存');
  if (result.hadDir) notes.push('酒馆文件不支持子目录，已拍平到根目录');
  return (
    '已写入：' +
    result.path +
    '（' +
    result.bytes +
    ' 字节）' +
    (notes.length ? '\n⚠️ ' + notes.join('；') : '') +
    '\n\n用户可以在酒馆的「文件」里找到它。同名文件会被覆盖。'
  );
}

function readOkDetail(result: ReadFileResult): string {
  const total = result.text.length;
  const body = clip(result.text, READ_LIMIT);
  return '文件：' + result.name + '（' + total + ' 字符）\n\n' + (body || '（文件是空的）');
}

export function createFileTools(options: FileToolOptions = {}): ToolDef[] {
  /** 现取依赖：宿主接口可能晚于首次读取才就绪（同 hostFn 的晚绑定口径） */
  const deps = (): SkillStoreDeps => options.fileDeps ?? createFileDeps();

  const write: ToolDef = {
    name: 'write_file',
    group: 'file',
    title: '写文件',
    desc: '把一段文本存成酒馆文件',
    model_description:
      '把一段文本存进酒馆文件（用户能在酒馆的「文件」里找到）。适合存产物：JSON、Markdown、清单这类要给用户的东西。' +
      '参数 name 是文件名（只能用英文/数字/_-.，不能带目录；不给扩展名或给了不允许的会按 .txt 存）。' +
      '参数 content 是完整正文，不是替换片段 —— 同名文件会被整个覆盖。',
    parameters: schemaObject(
      {
        name: schemaString('文件名，例如 role-preset.json；不要带目录，中文会被编码'),
        content: schemaString('完整文件正文（同名会被整个覆盖）'),
      },
      ['name', 'content'],
    ),
    // 会产出东西给用户看 → 按需开（同 create_skill / portrait_prompt 的口径）
    default_on: false,
    user_initiated_only: true,
    run: async (args) => {
      const name = asText(args.name).trim();
      if (!name) return resultFail('没给文件名', 'write_file 需要 name：给个英文名，例如 role-preset.json。');
      if (!('content' in args)) {
        return resultFail('没给内容', 'write_file 需要 content（完整正文）。要存空文件就传空字符串。');
      }
      const content = asText(args.content);
      let result: WriteFileResult;
      try {
        result = await writeWorkspaceFile(deps(), name, content);
      } catch (error) {
        return resultFail('写文件出错', error instanceof Error ? error.message : String(error), 'TOOL_ERROR');
      }
      if (!result.ok) return resultFail('没写成', '写「' + name + '」失败：' + result.error, 'TOOL_ERROR');

      return resultOk('已写入 ' + result.name + '（' + result.bytes + ' 字节）', writeOkDetail(result));
    },
  };

  const read: ToolDef = {
    name: 'read_file',
    group: 'file',
    title: '读文件',
    desc: '读回之前写过的酒馆文件',
    model_description:
      '读回一个之前用 write_file 写过的文件。只能读自己写的那些（名字以 cx-file- 开头）。' +
      '要确认刚才存进去的到底对不对、或者接着改，就先读回来看看。',
    parameters: schemaObject(
      {
        name: schemaString('文件名（write_file 时用的那个名字）'),
      },
      ['name'],
    ),
    default_on: false,
    user_initiated_only: true,
    run: async (args) => {
      const name = asText(args.name).trim();
      if (!name) return resultFail('没给文件名', 'read_file 需要 name。');

      let result: ReadFileResult;
      try {
        result = await readWorkspaceFile(deps(), name);
      } catch (error) {
        return resultFail('读文件出错', error instanceof Error ? error.message : String(error), 'TOOL_ERROR');
      }
      if (result.missing) {
        return resultFail(
          '没这个文件',
          '酒馆文件里没有「' + name + '」。可能名字写错了，或者还没用 write_file 写过它。',
        );
      }
      if (!result.ok) return resultFail('没读成', '读「' + name + '」失败：' + result.error, 'TOOL_ERROR');

      return resultOk('已读 ' + result.name + '（' + result.text.length + ' 字符）', readOkDetail(result));
    },
  };

  return [write, read];
}
