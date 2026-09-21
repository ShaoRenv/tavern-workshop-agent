/**
 * 苍玄助手贡献的宏。
 *
 * 三个宏，作用域不同：
 *   - `图片提示词`：酒馆 + 预设 —— 用户在**角色卡里**也能写 {{图片提示词}}；
 *   - `角色列表` / `图片元数据`：只给预设 —— 它们是「这一轮要处理谁」的上下文，
 *     塞进角色卡没有意义。
 *
 * 渲染拿到的 data 是底座的 MacroData（见 core/macros.ts）。
 * 插件宏**关掉即消失**：底座的注册口有名字没 renderer 时一律渲染成空串，
 * 所以老预设不会看到裸露的 {{图片提示词}}。
 */
import type { PluginMacro } from '../../types.ts';

/** 底座宏上下文里我们要用的那几个字段（宽松读，拿不到就空串） */
interface MacroBag {
  characters?: unknown;
  portrait_meta?: unknown;
  demand?: unknown;
}

function pick(data: Record<string, unknown>, key: string): string {
  const value = (data as MacroBag)[key as keyof MacroBag];
  return typeof value === 'string' ? value : '';
}

/**
 * `图片提示词` = 从立绘元数据里抽出的提示词正文。
 *
 * 拿不到位（没传图 / 没解析出提示词）就空串 —— 角色卡里写了这个宏也只是那一段空着，
 * 不会让整张卡渲染失败。
 */
function renderPortraitPrompt(data: Record<string, unknown>): string {
  return pick(data, 'portrait_meta').trim();
}

/** `角色列表` = 本轮勾选/收集到的角色（带元数据） */
function renderCharacters(data: Record<string, unknown>): string {
  return pick(data, 'characters');
}

/** `图片元数据` = 立绘里抽出的原始元数据文本 */
function renderPortraitMeta(data: Record<string, unknown>): string {
  return pick(data, 'portrait_meta');
}

export function cangxuanMacros(): PluginMacro[] {
  return [
    {
      name: '图片提示词',
      scopes: ['tavern', 'preset'],
      /*
       * 面板内用 {{图片提示词}}（我们自己的渲染器，中文名没问题）；
       * 角色卡里必须用 {{cx_image_prompt}} —— 酒馆的宏名只能是 ASCII。
       * 详见 plugins/types.ts 的 tavernAlias 注释。
       */
      tavernAlias: 'image_prompt',
      desc: '当前立绘里抽出的图片提示词（面板里写 {{图片提示词}}；角色卡里写 {{cx_image_prompt}}）',
      render: renderPortraitPrompt,
    },
    {
      name: '角色列表',
      scopes: ['preset'],
      desc: '本轮要处理的角色及其立绘元数据',
      render: renderCharacters,
    },
    {
      name: '图片元数据',
      scopes: ['preset'],
      desc: '立绘里抽出的原始元数据文本',
      render: renderPortraitMeta,
    },
  ];
}