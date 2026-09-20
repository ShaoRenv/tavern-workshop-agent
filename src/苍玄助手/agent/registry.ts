/**
 * 工具注册表：内置工具清单 + 流程工具（submit / ask_user）。
 *
 * 工具清单照设计稿「设置页 · 工具」那张表：
 *   knowledge: wb_list / wb_search / wb_read
 *   write:     entry_create / entry_edit / entry_delete / entry_meta
 *   skill:     skill / read_skill_file / create_skill
 *   image:     gen_image
 *   flow:      submit / ask_user
 *
 * 每个 ToolDef 都有完整 JSON Schema 参数（parameters），可以直接喂给原生 tools 通道。
 * 写操作一律只落草稿（ctx.drafts），真正的 WorldbookPort.writeAll 由 draft.ts 的 apply() 做。
 *
 * 依赖方向（eslint no-cycle 管得严，故意做成一条链）：
 *   draft.ts（叶子）→ tools_worldbook.ts（工具层公共底座）→ tools_skill / tools_image → registry.ts
 * 所以：公共辅助函数在 tools_worldbook.ts，草稿接口在 draft.ts，本文件只做组装。
 */
import type { ToolDef, ToolOverride, ToolOverrideMap, ToolSpec, WorldbookPort } from '../core/ports.ts';
import {
  asText,
  clip,
  createWorldbookTools,
  resultFail,
  resultOk,
  schemaObject,
  schemaString,
} from './tools_worldbook.ts';
import { createSkillTools, type AgentSkillLike, type RegistryOptions, type SkillDraft } from './tools_skill.ts';
import { createImageTools } from './tools_image.ts';
import { createToolGuards, type ToolGuardSet } from './guards.ts';

export type { AgentSkillLike, RegistryOptions, SkillDraft };

/* ============================ 清单常量 ============================ */

/** 内置工具，顺序 = 设置页显示顺序 */
export const TOOL_NAMES = [
  'wb_list',
  'wb_search',
  'wb_read',
  'entry_create',
  'entry_edit',
  'entry_delete',
  'entry_meta',
  'skill',
  'read_skill_file',
  'create_skill',
  'gen_image',
  'submit',
  'ask_user',
] as const;

export type BuiltinToolName = (typeof TOOL_NAMES)[number];

export const TOOL_GROUP_LABELS: Record<ToolDef['group'], string> = {
  knowledge: '读世界书',
  write: '改世界书',
  skill: '技能',
  image: '生图',
  flow: '流程',
  external: '外部',
};

/**
 * 默认勾上的那些。
 * 默认关的：entry_meta / ask_user / create_skill（按需）+ **gen_image**
 * （生图 API 还没接，默认开着只会诱导模型乱调、白烧钱；用户想要自己在预设里勾）。
 */
export const DEFAULT_ON_TOOLS: string[] = [
  'wb_list',
  'wb_search',
  'wb_read',
  'entry_create',
  'entry_edit',
  'entry_delete',
  'skill',
  'read_skill_file',
  'submit',
];

/* ============================ 流程工具 ============================ */

function createFlowTools(): ToolDef[] {
  const submit: ToolDef = {
    name: 'submit',
    group: 'flow',
    title: '提交',
    desc: '任务做完时叫一声，循环就停',
    model_description:
      '任务全部做完时调用一次，表示收工；调用后本轮对话结束，不要再调别的工具。参数 summary 用一两句话说明你改了什么。',
    parameters: schemaObject(
      {
        summary: schemaString('一两句话说明这次做了什么（会显示给用户）'),
        result: schemaString('可选：最终的正文/JSON 结果，界面上会当成产物展示'),
      },
      [],
    ),
    default_on: true,
    run: async args => {
      const summary = asText(args.summary).trim();
      const result = asText(args.result).trim();
      const detail =
        (summary ? '任务完成：' + summary : '任务完成。') + (result ? '\n\n结果：\n' + clip(result, 4000) : '');
      return resultOk(summary || '已提交', detail);
    },
  };

  const askUser: ToolDef = {
    name: 'ask_user',
    group: 'flow',
    title: '问用户',
    desc: '停下来问你一句',
    model_description:
      '当只有用户能回答、含糊下去会把世界书写错时，调用它问一句；用户的回答会作为工具结果返回。一次只问一个问题，问清关键点就继续干活。',
    parameters: schemaObject(
      {
        question: schemaString('要问用户的问题，一句话，具体'),
      },
      ['question'],
    ),
    default_on: false,
    run: async (args, ctx) => {
      const question = asText(args.question).trim();
      if (!question) return resultFail('问题为空', 'ask_user 需要 question 参数。');
      if (!ctx.askUser) return resultFail('界面没接上「问用户」通道', 'ask_user 暂不可用：请界面注入 ctx.askUser。');
      const answer = asText(await ctx.askUser(question)).trim();
      if (!answer) {
        return resultOk(
          '用户没回答，先跳过',
          '问了用户：' + question + '\n用户没有回答（可能直接跳过了）。先按你的判断继续，或者再问一次。',
        );
      }
      return resultOk('用户回答：' + clip(answer, 60, '…'), '问了用户：' + question + '\n用户回答：' + answer);
    },
  };

  return [submit, askUser];
}

/* ============================ 注册表 ============================ */

export class ToolRegistry {
  readonly defs: ToolDef[];
  private readonly index = new Map<string, ToolDef>();
  private readonly wb: WorldbookPort;

  constructor(wb: WorldbookPort, options: RegistryOptions = {}) {
    this.wb = wb;
    this.defs = [
      ...createWorldbookTools(wb),
      ...createSkillTools(options),
      ...createImageTools(),
      ...createFlowTools(),
    ];
    for (const def of this.defs) this.index.set(def.name, def);
  }

  /** 拿 WorldbookPort（界面/测试要用真实端口时方便） */
  port(): WorldbookPort {
    return this.wb;
  }

  names(): string[] {
    return this.defs.map(def => def.name);
  }

  byName(name: string): ToolDef | undefined {
    return this.index.get(name);
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** enabled 为空 = 全给；否则按名字过滤（保持 TOOL_NAMES 顺序） */
  pick(enabled?: string[]): ToolDef[] {
    if (!enabled || !enabled.length) return this.defs.slice();
    const set = new Set(enabled);
    return this.defs.filter(def => set.has(def.name));
  }

  /**
   * 转成 ports.ts 的 ToolSpec，直接喂 LlmPort。
   * overrides = 工具页改过的提示词/参数（按工具名查）；不传就是内置默认。
   */
  specs(enabled?: string[], overrides?: ToolOverrideMap): ToolSpec[] {
    return this.pick(enabled).map(def => {
      const resolved = applyToolOverride(def, overrides?.[def.name]);
      return { name: resolved.name, description: resolved.model_description, parameters: resolved.parameters };
    });
  }

  /**
   * 默认守卫（observe + prune + repeat），跟着本注册表的端口走。
   * 工具层用的是草稿视图时，observe-guard 看到的版本也是套过草稿的。
   */
  guards(options: { observations?: ToolGuardSet['observations'] } = {}): ToolGuardSet {
    return createToolGuards({ port: this.wb, ...(options.observations ? { observations: options.observations } : {}) });
  }

  /**
   * 设置页/工具页要的元信息。
   * 这里给的是 **ToolDef 的原样值**（工具详情页拿它当「恢复默认」的基准），
   * 不套 tool_overrides —— 覆盖值由界面自己从 store 读。
   */
  catalog(): ToolCatalogRow[] {
    return TOOL_NAMES.map(name => {
      const def = this.byName(name);
      if (!def) {
        return {
          name,
          group: 'flow',
          group_label: TOOL_GROUP_LABELS.flow,
          title: name,
          desc: '(缺失)',
          model_description: '',
          parameters: { type: 'object', properties: {} },
          default_on: false,
          user_initiated_only: false,
          missing: true,
        };
      }
      return {
        name: def.name,
        group: def.group,
        group_label: TOOL_GROUP_LABELS[def.group] ?? def.group,
        title: def.title,
        desc: def.desc,
        model_description: def.model_description,
        parameters: def.parameters,
        default_on: def.default_on,
        user_initiated_only: !!def.user_initiated_only,
        ...(typeof def.timeoutMs === 'number' ? { timeout_ms: def.timeoutMs } : {}),
        ...(def.readonly ? { readonly: true } : {}),
        ...(def.source ? { source: def.source } : {}),
        ...(def.origin ? { origin: def.origin } : {}),
        missing: false,
      };
    });
  }

  /** 自检：清单里每个工具都在吗？名字有没有多余？ */
  audit(): { ok: boolean; missing: string[]; extra: string[] } {
    const have = new Set(this.names());
    const missing = TOOL_NAMES.filter(name => !have.has(name));
    const wanted = new Set<string>(TOOL_NAMES);
    const extra = this.names().filter(name => !wanted.has(name));
    return { ok: missing.length === 0 && extra.length === 0, missing, extra };
  }
}

export interface ToolCatalogRow {
  name: string;
  group: ToolDef['group'];
  /** 分组中文名（TOOL_GROUP_LABELS） */
  group_label: string;
  title: string;
  desc: string;
  /** 进模型的那段说明（内置默认值，不套覆盖） */
  model_description: string;
  /** 参数 JSON Schema（内置默认值，不套覆盖） */
  parameters: Record<string, unknown>;
  default_on: boolean;
  user_initiated_only: boolean;
  timeout_ms?: number;
  readonly?: boolean;
  source?: 'builtin' | 'external';
  origin?: string;
  missing: boolean;
}

export function createRegistry(wb: WorldbookPort, options: RegistryOptions = {}): ToolRegistry {
  return new ToolRegistry(wb, options);
}

/** 参数 schema：把工具页改过的说明/默认值套上去 */
export function applyParameterOverride(
  parameters: Record<string, unknown>,
  override: ToolOverride,
): Record<string, unknown> {
  const properties = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const nextProperties: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const patched: Record<string, unknown> = { ...(schema ?? {}) };
    const description = override.param_descriptions?.[key];
    if (typeof description === 'string' && description.trim()) patched.description = description;
    if (override.param_defaults && key in override.param_defaults) patched.default = override.param_defaults[key];
    nextProperties[key] = patched;
  }
  return { ...parameters, properties: nextProperties };
}

/**
 * 工具页覆盖：说明 / 参数说明 / 参数默认值 / 超时。
 * 只覆盖给了的字段，其余保持 ToolDef 原值（界面「恢复默认」就是直接不传覆盖）。
 */
export function applyToolOverride(def: ToolDef, override?: ToolOverride): ToolDef {
  if (!override) return def;
  const next: ToolDef = { ...def };
  if (typeof override.description === 'string' && override.description.trim()) {
    next.model_description = override.description;
  }
  if (override.param_descriptions || override.param_defaults) {
    next.parameters = applyParameterOverride(def.parameters, override);
  }
  if (typeof override.timeout_ms === 'number' && override.timeout_ms > 0) {
    next.timeoutMs = override.timeout_ms;
  }
  return next;
}

/** 按 tool_overrides 批量解析（runner 组装 specs 前用） */
export function resolveToolDefs(defs: ToolDef[], overrides?: ToolOverrideMap): ToolDef[] {
  if (!overrides) return defs;
  return defs.map(def => applyToolOverride(def, overrides[def.name]));
}

/** 默认开的工具名（设置页初始化用） */
export function defaultEnabledTools(): string[] {
  return DEFAULT_ON_TOOLS.slice();
}
