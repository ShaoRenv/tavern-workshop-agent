/**
 * 苍玄助手贡献的 2 个工具：`portrait_list` / `portrait_prompt`。
 *
 * 它们都是**零参**工厂返回静态 ToolDef[]（阶段 3 契约：manifest 加载时拿不到宿主对象）。
 * 需要的能力一律从 ctx 取；这里只需要读角色图库，走 core/portrait.ts 的纯函数。
 *
 * ─────────────────────────── B24：从 3 个收成 2 个 ───────────────────────────
 *
 * **删掉 `portrait_meta`**（用户原话：「c4 返回提示词，不要元数据，多个」）。
 * 理由（用户指出、核实为真）：`portrait_meta` 与 `portrait_prompt` **读的是同一份数据**，
 * 只是把「原始文本」和「提取后的提示词」拆成两个工具 —— 而实际要用的只有后者。
 * 两个工具还各带一份参数说明和错误话术，等于同样的东西维护两遍。
 *
 * **`portrait_prompt` 改成收 `names[]`**（批量）。一次处理一个角色时模型要来回调 N 次，
 * 而「把这几个角色的提示词都给我」是真实需求（智绘姬的角色预设就是整批转的）。
 *
 * 默认开关：`portrait_list` 只读、便宜 → 默认开；
 * `portrait_prompt` 会产出正文（要拿去改图 / 转预设），跟 `create_skill` 一个路子 → 默认关。
 */
import type { ToolDef } from '../../../core/ports.ts';
import { listCharacters, readPortraitMeta, type PortraitMetaResult } from '../../../core/portrait.ts';
import { asText, asTextArray, clip, resultFail, resultOk, schemaArray, schemaObject, schemaString } from '../../../agent/toolkit.ts';

/** 列表最多显示多少个角色（防止把整张图库塞进上下文） */
const LIST_LIMIT = 60;
/** 单个角色的提示词文本上限 */
const TEXT_LIMIT = 4000;
/** 一次最多批量读几个角色（防止模型一口气要 50 个把图床打爆 / 把上下文塞满） */
const BATCH_LIMIT = 12;

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

/**
 * 取一个角色的提示词正文。
 *
 * 两条来源，顺序不能反：
 *   ① **手动传的元数据**（`plugins.cangxuan.manual_meta`）—— 用户明确喂进来的，最可信；
 *   ② 立绘 PNG 里嵌的元数据 —— 自动解析。
 *
 * @returns 要么 `{ text }`，要么 `{ error }`（人话，直接给模型看）
 */
async function promptOf(
  name: string,
  manual: { name: string; text: string }[],
): Promise<{ text: string; from: string } | { error: string }> {
  const pick = resolveCharacter(name);
  if (pick.ambiguous.length) {
    return {
      error: '「' + name + '」匹配到多个角色：' + pick.ambiguous.join('、') + '。请写完整的角色名。',
    };
  }
  if (!pick.character) return { error: '图库里没有「' + name + '」。先调 portrait_list 看看有哪些。' };

  const hit = manual.find(item => item.name === pick.character!.name);
  if (hit && hit.text.trim()) {
    return { text: hit.text, from: '手动传的元数据' };
  }

  if (!pick.character.imageUrl) {
    return { error: '「' + pick.character.name + '」既没有立绘，也没有手动传的元数据。' };
  }

  let result: PortraitMetaResult;
  try {
    result = await readPortraitMeta(pick.character.name);
  } catch (error) {
    return { error: '读「' + pick.character.name + '」时出错：' + (error instanceof Error ? error.message : String(error)) };
  }
  if (!result.ok) {
    const hint = result.corsBlocked ? '（疑似被跨域拦截，可让用户改用上传本地 PNG 的方式）' : '';
    return { error: '读「' + pick.character.name + '」失败：' + result.error + hint };
  }
  const text = (result.extracted?.text ?? '').trim();
  if (!text) {
    return {
      error:
        '「' + pick.character.name + '」的图读到了，但里面没有可用的提示词字段。' +
        '可能图床把元数据剥掉了，或这张图本来就不是生成的。',
    };
  }
  return { text, from: '立绘里嵌的元数据' };
}

/** 从插件配置里读手动传的元数据（形状见 plugins/builtin/cangxuan/config.ts） */
function readManualMeta(config: unknown): { name: string; text: string }[] {
  const bag = (config ?? {}) as Record<string, unknown>;
  const list = bag.manual_meta;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return { name: asText(row.name).trim(), text: asText(row.text) };
    })
    .filter(row => row.name && row.text.trim());
}

export function createCangxuanTools(): ToolDef[] {
  const list: ToolDef = {
    name: 'portrait_list',
    group: 'knowledge',
    title: '列立绘',
    desc: '看有哪些角色立绘可用',
    model_description:
      '列出当前可用的角色立绘（名字 + 有没有图 + 来源）。想知道该给谁处理立绘时先调它；拿到名字后再用 portrait_prompt 取提示词。',
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

  const prompt: ToolDef = {
    name: 'portrait_prompt',
    group: 'image',
    title: '取图片提示词',
    desc: '取一个或多个角色立绘的提示词（可批量）',
    model_description:
      '取角色立绘里的图片提示词正文（拿去重画 / 改图 / 转角色预设用）。' +
      'names 可以一次给多个角色名（要批量处理时别一个一个调）。' +
      '要改图时先调它拿到原始提示词，再在它的基础上改，不要从零编。',
    parameters: schemaObject(
      {
        names: schemaArray('角色名列表（见 portrait_list 的结果）；可以一次给多个', schemaString('角色名')),
      },
      ['names'],
    ),
    // 会产出正文，跟 create_skill 一样按需开
    default_on: false,
    readonly: true,
    run: async (args, ctx) => {
      // 兼容老的 name 单参写法：老会话 / 老提示词里可能还在用
      const asked = asTextArray(args.names).length ? asTextArray(args.names) : asTextArray(args.name);
      if (!asked.length) {
        return resultFail('没写角色名', 'portrait_prompt 需要 names：一个或多个角色名，先调 portrait_list 看有哪些。');
      }
      if (asked.length > BATCH_LIMIT) {
        return resultFail(
          '一次要的太多了',
          '一次最多 ' + BATCH_LIMIT + ' 个角色（你要了 ' + asked.length + ' 个）。请分批调。',
        );
      }

      const manual = readManualMeta(ctx?.plugin_config?.['cangxuan']);
      const blocks: string[] = [];
      const failed: string[] = [];

      for (const name of asked) {
        const got = await promptOf(name, manual);
        if ('error' in got) {
          failed.push(name + '：' + got.error);
          continue;
        }
        blocks.push('### ' + name + '（来自' + got.from + '）\n\n' + clip(got.text, TEXT_LIMIT));
      }

      if (!blocks.length) {
        return resultFail('一个都没取到', '这些角色都取不到提示词：\n' + failed.join('\n'));
      }

      const head = asked.length === 1 ? '' : '共 ' + blocks.length + ' / ' + asked.length + ' 个角色取到提示词。\n\n';
      const tail = failed.length ? '\n\n—— 下面这些没取到：\n' + failed.join('\n') : '';
      return resultOk(
        '取到 ' + blocks.length + ' 个角色的提示词' + (failed.length ? '（' + failed.length + ' 个失败）' : ''),
        head + blocks.join('\n\n') + tail,
      );
    },
  };

  return [list, prompt];
}
