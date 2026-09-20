/**
 * 苍玄助手贡献的 3 个工具：portrait_list / portrait_meta / portrait_prompt。
 *
 * 它们都是**零参**工厂返回静态 ToolDef[]（阶段 3 契约：manifest 加载时拿不到宿主对象）。
 * 需要的能力一律从 ctx 取；这里只需要读角色图库，走 core/portrait.ts 的纯函数。
 *
 * 默认开关（见仓规：按需工具 default_on: false）：
 *   - portrait_list / portrait_meta：只读、便宜 → 默认开；
 *   - portrait_prompt：会产出正文（改写提示词），跟 entry_meta / create_skill 一个路子 → 默认关。
 */
import type { ToolDef } from '../../../core/ports.ts';
import { labelOfFormat, listCharacters, readPortraitMeta } from '../../../core/portrait.ts';
import { asText, clip, resultFail, resultOk, schemaObject, schemaString } from '../../../agent/toolkit.ts';

/** 列表最多显示多少个角色（防止把整张图库塞进上下文） */
const LIST_LIMIT = 60;
/** 提示词/元数据文本的截断长度 */
const TEXT_LIMIT = 4000;

/** 把角色图库读成一行行的文本（拿不到就返回空数组，不抛） */
function characterLines(): { lines: string[]; total: number } {
  let characters: ReturnType<typeof listCharacters> = [];
  try {
    characters = listCharacters();
  } catch (error) {
    console.warn('[苍玄助手] 读取角色图库失败', error);
    return { lines: [], total: 0 };
  }
  const total = characters.length;
  const lines = characters.slice(0, LIST_LIMIT).map((character) => {
    const flags: string[] = [];
    if (character.imageUrl) flags.push('有图');
    else flags.push('无图');
    if (character.source) flags.push(String(character.source));
    return '- ' + character.name + '（' + flags.join('/') + '）';
  });
  return { lines, total };
}

/**
 * 找角色：先按名字精确匹配，再退回「唯一前缀/包含匹配」。
 * 模型经常写简称（「潮听澜」写成「听澜」），给它一条活路但不要歧义。
 */
function resolveCharacter(asked: string) {
  const target = asked.trim();
  if (!target) return { character: null, ambiguous: [] as string[] };
  const all = safeCharacters();
  const exact = all.find(character => character.name === target);
  if (exact) return { character: exact, ambiguous: [] as string[] };
  const fuzzy = all.filter(character => character.name.includes(target));
  if (fuzzy.length === 1) return { character: fuzzy[0], ambiguous: [] as string[] };
  if (fuzzy.length > 1) return { character: null, ambiguous: fuzzy.map(character => character.name).slice(0, 10) };
  return { character: null, ambiguous: [] as string[] };
}

function safeCharacters(): ReturnType<typeof listCharacters> {
  try {
    return listCharacters();
  } catch {
    return [];
  }
}

export function createCangxuanTools(): ToolDef[] {
  const list: ToolDef = {
    name: 'portrait_list',
    group: 'knowledge',
    title: '列立绘',
    desc: '看有哪些角色立绘可用',
    model_description:
      '列出当前可用的角色立绘（名字 + 有没有图 + 来源）。想知道该给谁处理立绘时先调它；拿到名字后再用 portrait_meta 读细节。',
    parameters: schemaObject({}, []),
    default_on: true,
    readonly: true,
    run: async () => {
      const { lines, total } = characterLines();
      if (!total) {
        return resultOk(
          '没有可用的立绘',
          '当前读不到任何角色立绘。可能原因：角色卡没有立绘、图库脚本没装、或不在酒馆环境里。请让用户确认后再试。',
        );
      }
      const more = total > lines.length ? '\n…（还有 ' + (total - lines.length) + ' 个没列出）' : '';
      return resultOk('共 ' + total + ' 个角色立绘', '可用角色立绘（' + total + ' 个）：\n' + lines.join('\n') + more);
    },
  };

  const meta: ToolDef = {
    name: 'portrait_meta',
    group: 'knowledge',
    title: '读立绘元数据',
    desc: '读某个角色立绘里的元数据',
    model_description:
      '读某个角色立绘里嵌入的元数据（NovelAI / A1111 / ComfyUI 都认），返回归一化后的字段。参数 name 写角色名；不确定名字就先调 portrait_list。',
    parameters: schemaObject({ name: schemaString('角色名（见 portrait_list 的结果）') }, ['name']),
    default_on: true,
    readonly: true,
    run: async (args) => {
      const asked = asText(args.name).trim();
      if (!asked) return resultFail('没写角色名', 'portrait_meta 需要 name 参数；先调 portrait_list 看有哪些角色。');

      const pick = resolveCharacter(asked);
      if (pick.ambiguous.length) {
        return resultFail(
          '角色名有歧义',
          '「' + asked + '」匹配到多个角色：' + pick.ambiguous.join('、') + '。请写完整的角色名。',
        );
      }
      if (!pick.character) {
        return resultFail('找不到这个角色', '图库里没有「' + asked + '」。先调 portrait_list 看看有哪些。');
      }
      if (!pick.character.imageUrl) {
        return resultFail(
          '这个角色没有立绘',
          '「' + pick.character.name + '」没有图，读不到元数据。可以让用户传一张立绘，或换别的角色。',
        );
      }

      try {
        const result = await readPortraitMeta(pick.character.name);
        if (!result.ok) {
          const hint = result.corsBlocked ? '（疑似被跨域拦截，可让用户改用上传本地 PNG 的方式）' : '';
          return resultFail('读元数据失败', '读「' + pick.character.name + '」失败：' + result.error + hint);
        }
        const text = (result.extracted?.text ?? '').trim();
        if (!text) {
          return resultFail(
            '这张图里没有元数据',
            '「' + pick.character.name + '」的图读到了，但里面没有可用的元数据字段。' +
              '可能图床把元数据剥掉了，或这张图本来就不是生成的。',
          );
        }
        const format = result.meta ? labelOfFormat(result.meta.format) : '未识别';
        return resultOk(
          clip(text, 60, '…'),
          '角色：' + pick.character.name + '\n元数据格式：' + format + '\n\n' + clip(text, TEXT_LIMIT),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return resultFail('读元数据出错', '读「' + pick.character.name + '」时出错：' + message, 'TOOL_ERROR');
      }
    },
  };

  const prompt: ToolDef = {
    name: 'portrait_prompt',
    group: 'image',
    title: '取图片提示词',
    desc: '把某个角色立绘的提示词取出来',
    model_description:
      '取某个角色立绘里的**图片提示词正文**（拿去重画 / 改图用）。参数 name 写角色名。' +
      '要改图时先调它拿到原始提示词，再在它的基础上改，不要从零编。',
    parameters: schemaObject({ name: schemaString('角色名（见 portrait_list 的结果）') }, ['name']),
    // 会产出正文，跟 entry_meta 一样按需开
    default_on: false,
    readonly: true,
    run: async (args, ctx) => {
      const asked = asText(args.name).trim();
      if (!asked) return resultFail('没写角色名', 'portrait_prompt 需要 name 参数；先调 portrait_list。');

      const pick = resolveCharacter(asked);
      if (pick.ambiguous.length) {
        return resultFail('角色名有歧义', '「' + asked + '」匹配到多个：' + pick.ambiguous.join('、') + '。请写完整名字。');
      }
      if (!pick.character) {
        return resultFail('找不到这个角色', '图库里没有「' + asked + '」。先调 portrait_list。');
      }

      // 先看手动传的元数据（plugins.cangxuan.manual_meta）里有没有这个角色的记录
      const manual = readManualMeta(ctx?.plugin_config?.['cangxuan']);
      const hit = manual.find(item => item.name === pick.character!.name);
      if (hit && hit.text.trim()) {
        return resultOk(
          clip(hit.text, 60, '…'),
          '角色：' + pick.character.name + '（来自手动传的元数据）\n\n' + clip(hit.text, TEXT_LIMIT),
        );
      }

      if (!pick.character.imageUrl) {
        return resultFail(
          '这个角色没有立绘',
          '「' + pick.character.name + '」既没有立绘，也没有手动传的元数据。',
        );
      }
      try {
        const result = await readPortraitMeta(pick.character.name);
        if (!result.ok) {
          return resultFail('读提示词失败', '读「' + pick.character.name + '」失败：' + result.error);
        }
        const text = (result.extracted?.text ?? '').trim();
        if (!text) {
          return resultFail('这张图里没有提示词', '「' + pick.character.name + '」的图里没有可用的提示词字段。');
        }
        return resultOk(
          clip(text, 60, '…'),
          '角色：' + pick.character.name + '\n\n' + clip(text, TEXT_LIMIT),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return resultFail('读提示词出错', '读「' + pick.character.name + '」时出错：' + message, 'TOOL_ERROR');
      }
    },
  };

  return [list, meta, prompt];
}

/** 手动元数据的一条记录 */
export interface ManualMetaItem {
  name: string;
  text: string;
  /** 上传得到的素材 URL（没有就空串） */
  url: string;
}

/**
 * 手动传的元数据存在哪：`plugins.cangxuan.manual_meta`。
 *
 * ⚠️ 阶段 3 之前它**只在内存里**（刷新就丢）。schema 里是 `string[]`（只存 URL / 文本，**不存 base64**）。
 * 这里用宽松解析：数组里既可能是纯字符串，也可能是 {name,text,url} 的 JSON 串。
 */
function readManualMeta(bag: unknown): ManualMetaItem[] {
  const raw = (bag as { manual_meta?: unknown } | null)?.manual_meta;
  if (!Array.isArray(raw)) return [];
  const out: ManualMetaItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { name?: unknown; text?: unknown; url?: unknown };
        out.push({
          name: typeof parsed.name === 'string' ? parsed.name : '',
          text: typeof parsed.text === 'string' ? parsed.text : '',
          url: typeof parsed.url === 'string' ? parsed.url : '',
        });
        continue;
      } catch {
        // 不是 JSON 就当纯文本
      }
    }
    out.push({ name: '', text, url: '' });
  }
  return out;
}

