/**
 * 插件注册表。
 *
 * 「插件」是什么（这一版定下来的口径）：**一份自己的设置 + 它提供的工具**。
 *  - 设置：`data.plugins.<id>`（见 core/types.ts 的 PluginsSchema）
 *  - 工具：工具名，在「工具」段里能单独改提示词 / 参数 / 超时
 *  - 开关：插件开着 = 它提供的工具进「全局能力」；关着 = 一个请求都不发
 *
 * 为什么表放在代码里而不是数据里：插件的**代码**（怎么发请求）本来就在代码里，
 * 光有数据也装不起来。内置插件就先写死这一张表；以后外部装载
 * （URL / 粘贴 / 创意工坊，契约在 core/ports.ts 的 ExternalToolManifest）
 * 再把这张表换成可增删的记录。
 */
import type { GenImageConfig } from '../core/types.ts';

export type PluginId = 'image';

export interface PluginDef {
  id: PluginId;
  name: string;
  /** 一句话：这插件干什么（列表行上用） */
  desc: string;
  /** 它提供哪些工具（工具名，按顺序） */
  tools: string[];
  version: string;
  origin: 'builtin';
}

export const PLUGIN_DEFS: PluginDef[] = [
  {
    id: 'image',
    name: '生图插件',
    desc: '接 NovelAI 生图：模型调 gen_image 画图，图直接进对话，也能回灌给它自己看。',
    tools: ['gen_image'],
    version: '0.1',
    origin: 'builtin',
  },
];

export function pluginDef(id: PluginId): PluginDef {
  const hit = PLUGIN_DEFS.find(item => item.id === id);
  if (!hit) throw new Error('没有这个插件：' + id);
  return hit;
}

export interface PluginStatus {
  label: string;
  /** 给 .cx-tag 的类名：'' | 'ok' | 'warn' | 'dang' */
  kind: '' | 'ok' | 'warn' | 'dang';
}

/**
 * 生图插件的状态（列表行和详情页共用一份口径，免得两处说法不一样）：
 *  - 没开 → 未启用
 *  - 开了但缺 Key（或选了反代却没填地址）→ 缺配置，warn
 *  - 齐了 → 已启用
 */
export function imagePluginStatus(config: GenImageConfig): PluginStatus {
  if (!config.enabled) return { label: '未启用', kind: '' };
  if (!config.api_key.trim()) return { label: '缺 API Key', kind: 'warn' };
  if (config.site === 'proxy' && !config.site_url.trim()) return { label: '缺反代地址', kind: 'warn' };
  return { label: '已启用', kind: 'ok' };
}

/**
 * 插件开着时，它提供的工具进「全局能力」（App.vue 组装 globalCaps 用）。
 * 关着返回空数组：工具从全局能力里消失，模型根本看不到它。
 */
export function imagePluginTools(config: GenImageConfig | undefined): string[] {
  return config && config.enabled ? pluginDef('image').tools.slice() : [];
}
