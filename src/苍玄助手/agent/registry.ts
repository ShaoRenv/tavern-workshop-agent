/**
 * 工具注册表：内置工具清单 + 流程工具（submit / ask_user）。
 *
 * 工具清单照设计稿「设置页 · 工具」那张表（阶段 3 起含插件贡献的）：
 *   knowledge: wb_list / wb_search / wb_read · portrait_list / portrait_meta（插件）
 *   write:     entry_create / entry_edit / entry_delete / entry_meta（插件）
 *   skill:     skill / read_skill_file / create_skill（底座）
 *   image:     gen_image · portrait_prompt（插件）
 *   flow:      submit / ask_user（底座）
 *
 * 每个 ToolDef 都有完整 JSON Schema 参数（parameters），可以直接喂给原生 tools 通道。
 * 写操作一律只落草稿（ctx.drafts），真正的 WorldbookPort.writeAll 由 draft.ts 的 apply() 做。
 *
 * 依赖方向（阶段 3 起）：
 *   agent/toolkit.ts（叶子）→ agent/tools_skill.ts → 本文件
 *   世界书 / 生图那两组工具已搬进 plugins/builtin/<id>/，由 pluginToolDefs(state) 组装进来；
 *   本文件只做「底座工具 + 插件工具」的合并与查询，**不 import 任何插件目录**。
 *
 * 为什么要传 state：插件工具是不是可用取决于插件开关（关掉即消失），
 * 而「哪些插件开着」只有 getVariables 里的 plugin_state 知道。
 */
import type {
  SettingsSchema,
  ToolDef,
  ToolOverride,
  ToolOverrideMap,
  ToolSpec,
  WorldbookPort,
} from '../core/ports.ts';
import { asText, clip, resultFail, resultOk, schemaObject, schemaString } from './toolkit.ts';
import { createSkillTools, type AgentSkillLike, type RegistryOptions, type SkillDraft } from './tools_skill.ts';
import { createToolGuards, type ToolGuardSet } from './guards.ts';
import { pluginToolDefs } from '../plugins/registry.ts';
import type { PluginStateHost } from '../plugins/types.ts';

export type { AgentSkillLike, RegistryOptions, SkillDraft };

/* ============================ 清单常量 ============================ */

/**
 * 全部工具名，顺序 = 设置页显示顺序。
 *
 * 阶段 3：世界书 7 + 生图 1 已搬进插件，加上苍玄助手插件的 3 个（portrait_list /
 * portrait_meta / portrait_prompt），共 16 个。
 * ⚠️ 这份清单是**内置工具的全集**（顺序 = 设置页显示顺序），跟「插件开不开」无关：
 * 关掉插件时工具定义不进注册表，但界面仍要靠这份清单标出「来源已停用」（见 App.vue）。
 *
 * ⚠️⚠️ 它**不再是「底座眼里的全部工具」**（阶段 6 起）：运行时注册的工具（MCP 连上才有）
 * 以及将来外部插件带来的工具，名字根本不可能预先写在这里。所以 `catalog()` 必须是
 * **「这份清单 ∪ 注册表里真实存在的 defs」**，不能只遍历这份名单 —— 否则新来源的工具
 * 模型拿得到、界面却列不出来（真机验收就这么抓到的：连上 MCP 后「能力 · 工具」少两个）。
 */
export const TOOL_NAMES = [
  'wb_list',
  'wb_search',
  'wb_read',
  'entry_create',
  'entry_edit',
  'entry_delete',
  'entry_meta',
  'portrait_list',
  'portrait_meta',
  'portrait_prompt',
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
  // 阶段 3：苍玄助手插件默认开的那两个只读工具（portrait_prompt 会产出正文，按需）
  'portrait_list',
  'portrait_meta',
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

/**
 * ToolDef → 设置页的一行（工具详情页也吃这份）。
 *
 * ⚠️ 抽成函数是**故意的**：`catalog()` 有两条来源（内置名单 / 名单外的真实 defs），
 * 两处各写一份投影 = 迟早有一处漏字段（比如 source / settings 只在一个分支里透出）。
 */
function catalogRow(def: ToolDef): ToolCatalogRow {
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
    // 工具自己的声明式设置（阶段 4）：内核只负责**原样透出**，不认识里面任何键。
    // 没声明就保持键缺席 —— 详情页据此显示「这个工具没有专属设置」。
    ...(def.settings !== undefined ? { settings: def.settings } : {}),
    missing: false,
  };
}

export class ToolRegistry {
  readonly defs: ToolDef[];
  private readonly index = new Map<string, ToolDef>();
  private readonly wb: WorldbookPort;

  constructor(wb: WorldbookPort, options: RegistryOptions = {}) {
    this.wb = wb;
    // 阶段 3：世界书 / 生图工具从**插件注册表**来（plugins/builtin/<id>/tools.ts），
    // 底座只保留技能与流程工具。插件关着时 pluginToolDefs 就不给它的工具 ——
    // 「关掉即消失」在**注册表这一层**就成立，runner 的 liveToolDefs 是第二道闸。
    // ⚠️ 注意：pluginToolDefs 收的是 **PluginStateHost**（`{ plugin_state }` 外壳），
    // 不是内层的 `plugin_state` 映射。传错的话它会读不到 plugin_state 而回落到
    // manifest.defaultEnabled —— 表面「插件开着」，实际**所有开关都失效**（关掉的插件照样给工具）。
    const state: PluginStateHost = options.plugin_state ? { plugin_state: options.plugin_state } : {};
    const assembled = [...createSkillTools(options), ...pluginToolDefs(state), ...createFlowTools()];
    // 顺序一律按 TOOL_NAMES（设置页显示顺序，与设计稿一致）：
    // 插件工具是后并进来的，不排序的话界面顺序会随「谁先注册」漂移。
    // 不在 TOOL_NAMES 里的（阶段 5 的 MCP 运行时工具等）排到最后，保持插入顺序。
    const rank = new Map<string, number>(TOOL_NAMES.map((name, index) => [name, index]));
    this.defs = assembled
      .map((def, index) => ({ def, index }))
      .sort((a, b) => {
        const ra = rank.get(a.def.name);
        const rb = rank.get(b.def.name);
        if (ra === undefined && rb === undefined) return a.index - b.index;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      })
      .map(item => item.def);
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
    // ① 内置名单：即使注册表里没有（插件关着 / 名字过期）也要出行，标 missing ——
    //    预设里硬引用过的工具靠这行兜底显示「来源已停用 / 缺失」。
    const rows: ToolCatalogRow[] = TOOL_NAMES.map(name => {
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
      return catalogRow(def);
    });

    // ② **名单之外**的真实 defs 也要列：运行时注册的（MCP）、以后外部插件带来的。
    //    顺序 = this.defs 的顺序（constructor 已把这批排到最后），保持「谁先注册在前」。
    const listed = new Set<string>(TOOL_NAMES);
    for (const def of this.defs) {
      if (listed.has(def.name)) continue;
      rows.push(catalogRow(def));
    }
    return rows;
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
  /**
   * 这个工具自己的声明式设置（ToolDef.settings，阶段 4）。
   *
   * 内核**只透传、不认识**：里面是通用字段声明（core/ports.ts 的 SettingsSchema），
   * 画成什么样由宿主的 SettingsForm 决定 —— 外部工具没有 DOM，只能靠这条路给自己做设置。
   */
  settings?: SettingsSchema;
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
  /*
   * 用户级开关（工具页那个开关）→ 落到 default_on 上。
   *
   * ⚠️ 为什么落在 default_on 而不是另开一个字段：**下游只认 default_on**
   * （resolveCaps 用 `tool.default_on` 决定发不发）。在这里翻译一次，
   * runner 与界面就自动共用同一份口径 —— 不然又是一个「两处各判一次、早晚分叉」的坑。
   *
   * ⚠️ 只能**收窄**：显式 true 只是把它恢复成「默认给」，
   * 救不回「来源已停用」的工具（那一步在 liveToolDefs / pluginAllTools 就被筛掉了，
   * 比这里更早，符合「停用只在来源处」仍然成立的那部分口径）。
   */
  if (typeof override.enabled === 'boolean') {
    next.default_on = override.enabled;
  }
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
