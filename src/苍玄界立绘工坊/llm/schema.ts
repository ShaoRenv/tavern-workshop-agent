/**
 * 全部持久化数据模型（zod）。
 *
 * 设计原则：**脚本提供框架，具体行为由用户在预设里定义**。
 * 因此预设里的提示词、模板、提取规则都是可自由编辑的字符串字段。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 元数据提取规则（决定"从图片里取哪些字段"）
 * ------------------------------------------------------------------ */

export const MetaExtractFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean().default(true),
  /** 候选路径，按顺序取第一个命中的值；前缀 json: 或 chunk: */
  paths: z.array(z.string()).default([]),
});

export const MetaExtractRuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    builtin: z.boolean().default(false),
    field_template: z.string().default('【{{label}}】\n{{value}}'),
    header: z.string().default(''),
    footer: z.string().default(''),
    fields: z.array(MetaExtractFieldSchema).default([]),
  });

export type MetaExtractRuleData = z.infer<typeof MetaExtractRuleSchema>;

/* ------------------------------------------------------------------ *
 * 回复提取规则（决定"怎么从 LLM 回复里取出 JSON"）
 * ------------------------------------------------------------------ */

export const ReplyExtractRuleSchema = z
  .object({
    /** 标记名，如 JSON */
    label: z.string().default('JSON'),
    /**
     * - fenced: 代码块围栏
     * - labeled_brace: 标记名后跟花括号，如 "JSON"{...}
     * - regex: 自定义正则
     * - whole: 整段即 JSON
     */
    mode: z.enum(['fenced', 'labeled_brace', 'regex', 'whole']).default('labeled_brace'),
    custom_regex: z.string().default(''),
    json_path: z.string().default(''),
  })
  .prefault({});

export type ReplyExtractRuleData = z.infer<typeof ReplyExtractRuleSchema>;

export const REPLY_EXTRACT_MODE_LABELS: Record<ReplyExtractRuleData['mode'], string> = {
  fenced: '代码块围栏 (\u0060\u0060\u0060json)',
  labeled_brace: '标记名 + 花括号 ("JSON"{...})',
  regex: '自定义正则',
  whole: '整段即 JSON',
};

/* ------------------------------------------------------------------ *
 * JSON 模板（决定"产出什么结构"）
 * ------------------------------------------------------------------ */

export const MergeModeSchema = z.enum(['object_map', 'array_push', 'custom']);

export const JsonTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    builtin: z.boolean().default(false),
    target: z.enum(['zhihatsuki', 'xiaobaix', 'custom']).default('custom'),
    /** 目标格式的 JSON 骨架，供 LLM 参照 */
    skeleton: z.string().default(''),
    /** 写给 LLM 的格式说明 */
    schema_note: z.string().default(''),
    /**
     * 可选的 JSON Schema（不是示例！）。
     * 非空且预设开启 use_json_schema 时，会交给酒馆做强制结构化输出。
     */
    json_schema_text: z.string().default(''),
    merge_mode: MergeModeSchema.default('object_map'),
    /** 智绘姬角色键前缀 */
    key_prefix: z.string().default('[苍玄界]'),
  });

export type JsonTemplateData = z.infer<typeof JsonTemplateSchema>;

/* ------------------------------------------------------------------ *
 * LLM 预设
 * ------------------------------------------------------------------ */

export const LlmPresetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    builtin: z.boolean().default(false),
    target: z.enum(['zhihatsuki', 'xiaobaix', 'custom']).default('zhihatsuki'),

    /* 提示词 */
    system_prompt: z.string().default(''),
    instruction: z.string().default(''),
    few_shot: z.string().default(''),

    /* 模板挂载方式：内嵌 or 引用模板库 */
    template_mode: z.enum(['embedded', 'reference']).default('reference'),
    template_id: z.string().default(''),
    embedded_template: JsonTemplateSchema.nullable().default(null),

    /* 取哪些元数据、怎么取 JSON */
    meta_extract_rule_id: z.string().default('builtin-default'),
    reply_extract: ReplyExtractRuleSchema,

    /* 生成参数 */
    temperature: z.number().min(0).max(2).default(0.3),
    batch_size: z.number().int().min(1).max(20).default(4),
    max_retries: z.number().int().min(0).max(5).default(2),

    /* 冲突处理 */
    conflict: z.enum(['overwrite', 'skip', 'rename']).default('overwrite'),
    /** 是否尝试用 json_schema 强制结构化输出 */
    use_json_schema: z.boolean().default(false),
  });

export type LlmPresetData = z.infer<typeof LlmPresetSchema>;

/* ------------------------------------------------------------------ *
 * 世界书预设
 * ------------------------------------------------------------------ */

export const WorldbookEntryDefaultsSchema = z
  .object({
    strategy: z.enum(['constant', 'selective']).default('constant'),
    keys: z.array(z.string()).default([]),
    position_type: z
      .enum([
        'before_character_definition',
        'after_character_definition',
        'before_example_messages',
        'after_example_messages',
        'before_author_note',
        'after_author_note',
        'at_depth',
      ])
      .default('before_character_definition'),
    order: z.number().default(100),
    depth: z.number().default(4),
  })
  .prefault({});

export const WorldbookPresetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    builtin: z.boolean().default(false),

    /** 新世界书命名模板，可用 {源名} {日期} */
    worldbook_name_template: z.string().default('{源名} · 全角色蓝灯精简'),
    /** 永远新建；重名时的处理 */
    name_conflict: z.enum(['suffix', 'timestamp']).default('suffix'),

    entry_mode: z.enum(['single', 'grouped', 'auto']).default('single'),
    entry_name_template: z.string().default('全角色蓝灯精简'),

    system_prompt: z.string().default(''),
    instruction: z.string().default(''),
    field_spec: z.string().default(''),
    few_shot: z.string().default(''),
    /** 容错说明，用户可改 */
    tolerance_note: z.string().default(''),

    reply_extract: ReplyExtractRuleSchema,
    /** 产出形态：text = 直接拼接精简行；json = 先抽 JSON 再取字段 */
    output_mode: z.enum(['text', 'json']).default('text'),
    /** output_mode 为 json 时，从 JSON 的哪个路径取最终文本 */
    output_json_path: z.string().default(''),
    temperature: z.number().min(0).max(2).default(0.4),
    batch_size: z.number().int().min(1).max(30).default(6),
    max_retries: z.number().int().min(0).max(5).default(2),
    /** 全部生成完后是否再调一次 LLM 做一致性整理 */
    final_pass: z.boolean().default(false),

    entry_defaults: WorldbookEntryDefaultsSchema,
  });

export type WorldbookPresetData = z.infer<typeof WorldbookPresetSchema>;

/* ------------------------------------------------------------------ *
 * 设置与任务进度
 * ------------------------------------------------------------------ */

export const SettingsSchema = z
  .object({
    /** 图片下载并发 */
    image_concurrency: z.number().int().min(1).max(16).default(4),
    /** 图床代理前缀，用于绕过 CORS */
    proxy_prefix: z.string().default(''),
    /** 元数据缓存条数上限 */
    cache_limit: z.number().int().min(0).max(2000).default(300),
    /** 选中的源世界书 */
    source_worldbook: z.string().default(''),
    /** 界面当前页签 */
    active_tab: z.string().default('gallery'),
  })
  .prefault({});

export type SettingsData = z.infer<typeof SettingsSchema>;

export const TaskFailureSchema = z.object({ name: z.string(), error: z.string() });

export const TaskStateSchema = z
  .object({
    kind: z.enum(['portraits', 'worldbook']).default('portraits'),
    preset_id: z.string().default(''),
    status: z.enum(['idle', 'running', 'paused', 'done', 'failed']).default('idle'),
    total: z.number().default(0),
    /** 已完成角色名，用于断点续跑 */
    completed: z.array(z.string()).default([]),
    failures: z.array(TaskFailureSchema).default([]),
    /** 已产出的累积文本 */
    partial: z.string().default(''),
    started_at: z.number().default(0),
    updated_at: z.number().default(0),
  })
  .prefault({});

export type TaskStateData = z.infer<typeof TaskStateSchema>;

/* ------------------------------------------------------------------ *
 * 根存储
 * ------------------------------------------------------------------ */

export const WorkshopDataSchema = z
  .object({
    version: z.number().default(1),
    settings: SettingsSchema,
    llm_presets: z.array(LlmPresetSchema).default([]),
    worldbook_presets: z.array(WorldbookPresetSchema).default([]),
    templates: z.array(JsonTemplateSchema).default([]),
    meta_extract_rules: z.array(MetaExtractRuleSchema).default([]),
    task: TaskStateSchema,
  })
  .prefault({});

export type WorkshopData = z.infer<typeof WorkshopDataSchema>;
