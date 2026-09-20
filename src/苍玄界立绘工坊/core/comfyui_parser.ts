import { isPlainObject, tryParseJson } from './json_util.ts';

export interface ComfyUiMeta {
  document: Record<string, unknown>;
}

/**
 * 解析 ComfyUI 写入的 `prompt` / `workflow` 文本块。
 *
 * ComfyUI 本身不保存成品提示词字符串，只保存节点图。这里做尽力而为的提取：
 * 遍历节点，收集 `CLIPTextEncode` 类节点的 `inputs.text`，
 * 第一个非空文本视为正向提示词，其后若存在形似负向的文本则作为负向。
 */
export function parseComfyUiMeta(chunks: Record<string, string>): ComfyUiMeta | null {
  const promptJson = tryParseJson(chunks['prompt']);
  const workflowJson = tryParseJson(chunks['workflow']);

  const nodes = isPlainObject(promptJson) ? promptJson : null;
  if (!nodes) return null;

  const texts = collectClipTexts(nodes);
  if (texts.length === 0) {
    // 是 ComfyUI 图但没有可直接使用的文本节点
    return { document: { comfyui_prompt: nodes, workflow: workflowJson ?? null, texts: [] } };
  }

  const positive = texts[0];
  const negative = texts.length > 1 ? texts[texts.length - 1] : '';
  const negativeTexts = texts.length > 1 ? [negative] : [];

  return {
    document: {
      prompt: positive,
      uc: negative,
      negative_prompt: negative,
      // 分开暴露正/负向：默认提取规则的 char_caption 只应命中正向，
      // 否则角色 DNA 会把负向质量词一并拼进去。
      positive_texts: [positive],
      negative_texts: negativeTexts,
      // 保留全部文本（含负向），供用户自定义规则使用
      texts,
      comfyui_prompt: nodes,
      workflow: workflowJson ?? null,
    },
  };
}

/** 从 ComfyUI 节点图中收集文本编码节点的文本 */
function collectClipTexts(nodes: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const node of Object.values(nodes)) {
    if (!isPlainObject(node)) continue;
    const classType = String(node.class_type ?? '');
    if (!/clip.?text.?encode/i.test(classType)) continue;
    const inputs = node.inputs;
    if (!isPlainObject(inputs)) continue;
    // CLIPTextEncode 用 text；CLIPTextEncodeSDXL 用 text_g / text_l，两个都要收
    for (const key of ['text', 'text_g', 'text_l']) {
      const value = inputs[key];
      if (typeof value === 'string' && value.trim()) texts.push(value.trim());
    }
  }
  return texts;
}
