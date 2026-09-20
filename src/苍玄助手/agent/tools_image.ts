/**
 * 生图工具：gen_image
 *
 * 出的图放进 ToolResult.images：
 *  - UI 把图直接画进对话（设计稿：生图卡永远展开）
 *  - loop.ts 会把图作为图片消息回灌给模型，所以模型能「看过自己生的图再改」
 */
import type { ToolDef } from '../core/ports.ts';
import {
  asInt,
  asText,
  clip,
  resultFail,
  resultOk,
  schemaInteger,
  schemaObject,
  schemaString,
} from './tools_worldbook.ts';

const MAX_IMAGES = 4;

export function createImageTools(): ToolDef[] {
  const genImage: ToolDef = {
    name: 'gen_image',
    group: 'image',
    title: '生图',
    desc: '调生图 API，出图直接进对话',
    model_description:
      '调生图接口画一张图，图会直接出现在对话里，也会回灌给你看。prompt 写具体画面（主体、环境、光线、风格、比例），要改图就把上一版 prompt 调一调再画，别整段重写。',
    parameters: schemaObject(
      {
        prompt: schemaString('画面描述，越具体越好；建议带风格和比例'),
        negative: schemaString('负面提示词：不想要的东西'),
        count: schemaInteger('要几张，默认 1，最多 ' + MAX_IMAGES, { minimum: 1, maximum: MAX_IMAGES }),
      },
      ['prompt'],
    ),
    // 默认关：生图 API 还没接，默认开着只会诱导模型乱调、白烧钱。用户在预设里想要就自己勾。
    default_on: false,
    run: async (args, ctx) => {
      const prompt = asText(args.prompt).trim();
      if (!prompt) return resultFail('没给 prompt', 'gen_image 需要 prompt。');
      if (!ctx.genImage)
        return resultFail(
          '生图插件没启用',
          'gen_image 现在不可用：去「能力 · 插件」打开生图插件、填好 API Key，它才会接上接口。',
        );
      const negative = asText(args.negative).trim();
      const want = asInt(args.count, 1, 1, MAX_IMAGES);
      const images: string[] = [];
      let lastError = '';
      for (let round = 0; round < MAX_IMAGES && images.length < want; round++) {
        try {
          const got = await ctx.genImage(prompt, negative);
          if (Array.isArray(got) && got.length) images.push(...got.filter(item => typeof item === 'string' && item));
          else break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      if (!images.length)
        return resultFail('生图失败', '生图没出图。' + (lastError ? '错误：' + lastError : '检查设置页的生图接口。'));
      const unique = Array.from(new Set(images)).slice(0, Math.max(want, 1));
      const lines = [
        '已生成 ' + unique.length + ' 张图（图已经进对话，也回灌给你了）。',
        'prompt：' + clip(prompt, 800),
        negative ? 'negative：' + clip(negative, 400) : '',
        '要改就调 gen_image 再来一张，prompt 只改要变的部分。',
      ].filter(Boolean);
      return resultOk('已生成 ' + unique.length + ' 张 · ' + clip(prompt, 30, '…'), lines.join('\n'), unique);
    },
  };

  return [genImage];
}

/** 给 UI 用：把 prompt 压成生图卡标题那种短句 */
export function imageCardTitle(prompt: string): string {
  return clip(asText(prompt).replace(/\s+/g, ' ').trim(), 40, '…');
}
