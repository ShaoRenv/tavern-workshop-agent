/**
 * 生图插件 · 清单。
 *
 * 自包含目录：manifest（本文件）+ tools.ts（gen_image）+ nai.ts（NovelAI 适配层）+ options.ts（选项表）。
 * 依赖方向单向：plugins/builtin/image → core / agent，**插件之间零 import**。
 *
 * 默认 **关**（defaultEnabled: false）：生图 API 没配好时开着只会诱导模型乱调、白烧钱，
 * 用户要自己在「能力 · 插件」里打开。status() 告诉界面它现在缺什么。
 */
import type { PluginManifest } from '../../types.ts';
import { createImageTools } from './tools.ts';

export const manifest: PluginManifest = {
  id: 'image',
  name: '生图',
  desc: '接 NovelAI 生图：模型调 gen_image 画图，图直接进对话。',
  version: '0.1',
  apiVersion: 1,
  builtin: true,
  defaultEnabled: false,
  contributes: {
    tools: createImageTools(),
  },
  status: config => {
    const bag = (config ?? {}) as Record<string, unknown>;
    const key = typeof bag.api_key === 'string' ? bag.api_key.trim() : '';
    const site = typeof bag.site === 'string' ? bag.site : 'official';
    const siteUrl = typeof bag.site_url === 'string' ? bag.site_url.trim() : '';
    if (!key) return { label: '缺 API Key', kind: 'warn' };
    if (site === 'proxy' && !siteUrl) return { label: '缺反代地址', kind: 'warn' };
    return { label: '已启用', kind: 'ok' };
  },
};

export default manifest;
