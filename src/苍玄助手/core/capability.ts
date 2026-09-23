/**
 * 酒馆工坊Agent · 能力表（capability）
 *
 * ────────────────────────── 为什么需要它 ──────────────────────────
 *
 * 迁移前的状态：能力可得性是**隐式**的。拿不到宿主接口时，各处自己
 * `throw new Error('酒馆助手缺少 xxx 接口')`（如 core/worldbook.ts:349），
 * 界面上 `hasHostFn()` 也只是一个布尔 —— 没有「哪些能力可用、降级到什么程度」
 * 的表达。结果是：插件装上了、跑起来炸在半路，用户只看到一句没有上下文的报错。
 *
 * 这个文件把「能力」提升成**一等公民**：
 *   1. 底座启动**探一遍**宿主，得出一张能力表；
 *   2. 插件在 manifest 的 `contributes.requires` 里**声明**自己需要哪些能力；
 *   3. 能力缺失 → 该插件**不注册**，并给出一句人话原因（而不是运行时炸半路）。
 *
 * 这把 `plugins/builtin/image/manifest.ts` 已有的 `status()` 个案例
 * **提升为框架机制** —— 每个插件不用自己写一遍「我缺什么」。
 *
 * ────────────────────────── 契约（lead 定稿，别改形状）──────────────────────────
 *
 *   interface Capability {
 *     name: string;                       // 底座接口名，如 'getWorldbook'
 *     provider: string;                   // 谁提供的：'native' | 'tavern-helper' | 'none'
 *     required: boolean;                  // 缺了是不是就用不了（false = 可降级）
 *     degrade?: () => void;               // 缺失时跑的降级动作（记日志 / 关开关）
 *     label: string;                      // 人话名字，界面直接用，如 '读世界书'
 *   }
 *
 * ────────────────────────── 三条设计口径 ──────────────────────────
 *
 * ① **探测不抛**。任何一条能力探测失败都当成「不可用」，绝不向上抛 ——
 *    能力探测发生在界面挂载之前，抛一下就是整个面板白屏。
 *
 * ② **探测用注入的解析器**。真实解析器是 core/host.ts 的 hostFn（四层链：
 *    假实现 → 原生表 → TavernHelper → globalThis）。测试注入假的即可，
 *    不需要真酒馆环境。
 *
 * ③ **明确标不可用**。ST 原生压根没有对应的接口（native.ts 的
 *    NO_NATIVE_EQUIVALENT：getScriptTrees / getModelList / getScriptId）
 *    是「永久不可用」，与「这台机器恰好缺」语义不同，原因文案也分开写。
 */
import { NO_NATIVE_EQUIVALENT, NATIVE_PATHS, probeNativeCapabilities, getStContext } from './native.ts';

/* ============================ 契约 ============================ */

/** 能力来源：谁提供了这个能力 */
/**
 * 能力来源。
 *
 *  - 'native'         ST 原生 getContext() 直接给的；
 *  - 'tavern-helper'  酒馆助手（JS-Slash-Runner）给的 —— 兼容老环境；
 *  - 'platform'       **运行时平台自带**的（例如 fetch）；
 *  - 'injected'       测试 / 覆盖注入的假实现；
 *  - 'none'           这台机器上谁都给不了。
 *
 * ⚠️ 为什么必须有 'platform' 这一档（不是给 fetch 打的一次性补丁）：
 *
 * 兜底解析走的是 `lookupCompat()`，它把「globalThis 上任意同名函数」一律标成
 * 'tavern-helper'。对真正的酒馆助手接口那是对的，但对**平台内置**的东西就是**误标**：
 * 最典型的是 `fetch` —— 浏览器本来就有，标成 'tavern-helper' 会让人以为
 * 「装了酒馆助手才有网络」，而事实是没装也有。
 *
 * 于是「三档」的必要性在于：**来源不同，含义就不同** ——
 *   · native / tavern-helper：依赖某个宿主的导出，换环境可能没有；
 *   · platform：**不依赖任何宿主**，所以不存在「没装就没」这回事。
 * 界面与排查都要靠这个区别说人话（「这份能力是酒馆给的，还是本来就有的」）。
 * 将来任何「运行时自带、不经过宿主」的能力（例如 localStorage / WebSocket）
 * 都该用这一档，而不是让 lookupCompat 把它们误标成酒馆助手的。
 */
export type CapabilityProvider = 'native' | 'tavern-helper' | 'platform' | 'injected' | 'none';

/**
 * 一条能力的描述符（lead 定稿的契约，字段名别改）。
 */
export interface Capability {
  /** 底座用的宿主接口名，如 'getWorldbook'（= hostFn 的 name） */
  name: string;
  /** 谁提供的。'none' 表示这台机器上谁都给不了 */
  provider: CapabilityProvider;
  /** 缺了是不是就用不了。false = 可以降级（degrade 会跑） */
  required: boolean;
  /** 缺失时跑的降级动作（记日志 / 关开关 / 切备用实现） */
  degrade?: () => void;
  /** 人话名字，界面直接用，如 '读世界书' */
  label: string;
}

/**
 * 一条能力的探测结果：在 Capability 之上补「可用与否 + 为什么」。
 *
 * `reason` 是人话，**能直接显示给用户**；`ok=true` 时它缺席。
 */
export interface CapabilityStatus extends Capability {
  ok: boolean;
  /** 不可用的人话原因（ok=true 时缺席） */
  reason?: string;
  /** 这个能力对应的 ST 原生路径（有的话，给用户一个「该有什么」的线索） */
  nativePath?: string;
  /** true = ST 原生压根没有对应（永久不可用），不是「这台机器恰好缺」 */
  noNativeEquivalent?: boolean;
}

/**
 * 底座认识的全部能力（**唯一清单**）。
 *
 * 加能力就在这里加一条；插件 manifest 的 requires 只能引用这里的 name。
 * required 的口径：
 *   - true  = 底座 / 该能力的核心用途没有它就跑不起来（缺了要显式降级）；
 *   - false = 有更好、没有也能用别的方式凑（缺了记一条日志就好）。
 */
export const CAPABILITIES: ReadonlyArray<Omit<Capability, 'provider'>> = [
  // ---- 生成（文本通道主命脉）----
  { name: 'generateRaw', label: '调用模型生成', required: true },
  { name: 'generateQuietPrompt', label: '静默生成（后备通道）', required: false },
  // ---- 宏 ----
  { name: 'substitudeMacros', label: '替换酒馆宏', required: false },
  { name: 'registerMacroLike', label: '注册酒馆宏', required: false },
  { name: 'unregisterMacroLike', label: '注销酒馆宏', required: false },
  // ---- 世界书 ----
  { name: 'getWorldbook', label: '读世界书', required: false },
  { name: 'replaceWorldbook', label: '写回世界书', required: false },
  { name: 'createWorldbook', label: '新建世界书', required: false },
  { name: 'deleteWorldbook', label: '删除世界书', required: false },
  { name: 'getWorldbookNames', label: '列出世界书', required: false },
  { name: 'getGlobalWorldbookNames', label: '读全局启用世界书', required: false },
  { name: 'getCharWorldbookNames', label: '读角色卡世界书', required: false },
  { name: 'getChatWorldbookName', label: '读当前聊天世界书', required: false },
  // ---- 变量（存储）----
  //
  // ⚠️ 这里刻意分成 **两档能力**，不要合成一个「存储：可用」（lead 裁决）：
  //
  //   vars.table  整表读写（能枚举、能整体替换）—— 只有**酒馆助手**给得了。
  //               ST 原生的 variables.{local,global} 只有按 key 的 get/set，
  //               **没有「列出全部键」的接口**，所以整表语义在纯原生环境下不成立。
  //   vars.keyed  按 key 读写 —— ST 原生就有，**始终可用**。
  //
  // 为什么必须分开标：合成一个的话，界面只能笼统说「存储可用」，
  // 用户要等到「多标签页 / 换机器」时才发现读不全 —— 那正是我们要根治的
  // 「能力可得性隐式」问题。分开标之后设置页能直说：
  //   「存储：受限（只能读写本底座自己的键，因为没装酒馆助手）」。
  { name: 'vars.table', label: '变量整表读写（需酒馆助手）', required: false },
  { name: 'vars.keyed', label: '变量按键读写', required: true },
  { name: 'getVariables', label: '读变量', required: true },
  { name: 'insertOrAssignVariables', label: '写变量', required: true },
  { name: 'replaceVariables', label: '整体替换变量', required: false },
  { name: 'updateVariablesWith', label: '按函数更新变量', required: false },
  // ---- 请求 / 生成控制 ----
  { name: 'getRequestHeaders', label: '取酒馆请求头（CSRF）', required: false },
  { name: 'triggerSlash', label: '执行斜杠命令', required: false },
  { name: 'stopGenerationById', label: '中止生成', required: false },
  // ---- 网络 ----
  //
  // ⚠️ `fetch` 与表里其他条目**语义不同**，别按 `required: false` 的老眼光读它：
  //   其他条目是「这台机器**可能没有**这个宿主能力」（缺了要降级 / 拦插件）；
  //   而 fetch 在浏览器里**总是存在** —— 真正会变的是「**是谁的 fetch**」：
  //   酒馆可能在沙箱里换过它，所以底座要求走 core/host.ts 的 hostFetch()（provider chain），
  //   而不是裸读 globalThis.fetch（那会形成第二、第三条链 —— 审计出来的老毛病）。
  //
  // 因此这里的口径是：
  //   · `required: false` —— 它几乎不会让插件「跑不起来」，写 true 会让插件在
  //     任何探测意外时被整个拦掉，代价远大于收益（网络失败本来就该由插件自己处理）；
  //   · 但它**必须登记在表里**，否则：
  //     ① 能力表不再是「这台机器有哪些宿主能力」的完整真相源；
  //     ② test-author 的静态名字闸会把 `requires: ['fetch']` 判成 typo，
  //        导致一个**合法需要网络**的插件（尤其二期外部插件）整个装载失败。
  //
  // 一句话：它更像「**总是可用、但来源可能被换过**」，而不是「可能缺失」。
  { name: 'fetch', label: '网络请求', required: false },
  // ---- 工具调用 ----
  { name: 'isToolCallingSupported', label: '原生工具调用探测', required: false },
  // ---- 明确不可用的三个（ST 原生没有对应）----
  { name: 'getScriptTrees', label: '读酒馆助手脚本树', required: false },
  { name: 'getModelList', label: '获取模型列表', required: false },
  { name: 'getScriptId', label: '取脚本 id', required: false },
];
/* ============================ 探测 ============================ */

/**
 * 能力解析器：给一个接口名，返回提供者（或 'none'）。
 *
 * 真实实现是 core/host.ts 的 hostFn + hasHostFn（四层链）。这里做成可注入的
 * 函数，为的是：测试不用真酒馆、界面可以显示「这条是从哪来的」。
 */
export type CapabilityResolver = (name: string) => CapabilityProvider;

/**
 * 默认解析器：完全靠 native.ts 的自省。
 *
 * 顺序与宿主链一致：原生表拿得到 → 'native'；否则看兼容层有没有；都没有 → 'none'。
 * ⚠️ 故意**不 import core/host.ts**：host.ts 属 host-bridge 的写范围，
 * 而 capability 只依赖「有没有」这一事实，不该跟链的实现耦合。
 * 链就绪后由 installCapabilityResolver 换上带四层链的版本。
 */
let resolver: CapabilityResolver | null = null;

/** 当前解析器（没注入过就用内省版） */
export function capabilityResolver(): CapabilityResolver {
  if (resolver) return resolver;
  return defaultResolver;
}

/** 裸全局里有没有这个名字的兼容实现（链的第 3/4 层） */
function lookupCompat(name: string): CapabilityProvider {
  const scope = typeof globalThis === 'undefined' ? null : (globalThis as unknown as Record<string, unknown>);
  if (!scope) return 'none';
  const helper = scope.TavernHelper as Record<string, unknown> | undefined;
  if (helper && typeof helper[name] === 'function') return 'tavern-helper';
  if (typeof scope[name] === 'function') return 'tavern-helper';
  return 'none';
}

/**
 * 默认解析器：每次调用**现探**，不缓存。
 *
 * 为什么要现探：ST 上下文是晚就绪的（实测 APP_READY 556ms~24050ms），
 * 启动时探一次就缓存住的话，扩展加载早于酒馆初始化就会把能力永久标成不可用。
 */
const defaultResolver: CapabilityResolver = (name: string) => {
  // 两档变量能力**先判**（它们不是 hostFn 的名字，是能力语义的名字）。
  // vars.keyed：ST 原生就有的按 key 读写 —— 只要 variables 在就可用。
  // vars.table：需要「列出全部键」 —— ST 原生没有，只有酒馆助手给得了。
  if (name === 'vars.keyed') {
    const variables = getStContext()?.variables;
    if (variables && (variables.local || variables.global)) return 'native';
    return lookupCompat('getVariables');
  }
  if (name === 'vars.table') {
    // 这一档**不认原生表**：native.ts 只能「按已知键逐个读」，枚举不出全部键，
    // 所以整表语义在纯原生环境下**不成立**。只有酒馆助手（或注入的假实现）
    // 提供整表接口时才算可用 —— 这正是要暴露给用户的那条差异。
    return lookupCompat('getVariables');
  }

  if (name === 'fetch') {
    // fetch **不按 hostFn 的普通口径判**，理由（写清楚，免得以后有人「顺手统一」掉）：
    //
    // 1. `fetch` 是**平台内置**（浏览器就有），不是酒馆给的宿主能力。
    //    走通用的 lookupCompat() 会把它标成 'tavern-helper' —— 那是**错的**，
    //    会让人以为「装了酒馆助手才有网络」，而事实是没装也有。
    // 2. 它**总是可用**，真正常变的是「**是谁的 fetch**」：
    //    酒馆可能在沙箱里换过它，所以底座要求走 hostFetch()（provider chain），
    //    而不是裸读 globalThis.fetch。这条差异不影响「能不能发请求」的判定。
    //
    // 所以：只要有 fetch 函数就用，来源按**实际在哪找到**如实标。
    const scope = typeof globalThis === 'undefined' ? null : (globalThis as unknown as Record<string, unknown>);
    if (!scope) return 'none';
    // 链的第一层（注入假实现）—— 测试 / 覆盖时算 'injected'
    const helper = scope.TavernHelper as Record<string, unknown> | undefined;
    if (helper && typeof helper.fetch === 'function') return 'tavern-helper';
    if (typeof scope.fetch === 'function') return 'platform';
    // 三条都没有：那是极端情形（没有 fetch 的运行时），如实说不可用
    return 'none';
  }
  try {
    if (probeNativeCapabilities(getStContext()).includes(name)) return 'native';
  } catch {
    // 探测失败 = 这条能力不可用，不向上抛（探测发生在界面挂载之前）
  }
  // 原生表里没有的，还要认「原生能提供但由别的名字兜」的那几个：
  // deleteWorldbook / getCharWorldbookNames / getChatWorldbookName 没有直接的
  // 原生导出，但 ST 的 saveWorldInfo / 角色卡与聊天元数据能兜 —— 归 'native'。
  try {
    if (nativeBackedAlias(name)) return 'native';
  } catch {
    // 同上，不抛
  }
  return lookupCompat(name);
};

/**
 * 这几个名字没有「一模一样的原生函数」，但 ST 原生数据/接口能直接兜住。
 *
 * 必须逐个说明兜法，不能一句「差不多」放过 —— 将来有人查「为什么它算可用」
 * 要能立刻看到依据。
 */
function nativeBackedAlias(name: string): boolean {
  const ctx = getStContext();
  if (!ctx) return false;
  switch (name) {
    case 'deleteWorldbook':
      // ST 没有 deleteWorldInfo；能读 + 能写就说明世界书域可用，
      // 删除由 worldbook.ts 走「写空内容 + 从列表摘掉」实现。
      return typeof ctx.loadWorldInfo === 'function' && typeof ctx.saveWorldInfo === 'function';
    case 'getCharWorldbookNames':
    case 'getChatWorldbookName':
      // 角色卡 / 聊天的世界书绑定在 ST 里是 character.data.extensions 与 chat metadata，
      // 拿得到世界书列表就说明这条路可用（具体读取由 worldbook.ts 完成）。
      return typeof ctx.loadWorldInfo === 'function';
    default:
      return false;
  }
}

/**
 * 换上真正的解析器（host-bridge 的 host.ts 就绪后，由装配处调一次）。
 *
 * 传 null 恢复内省版（测试用）。
 */
export function installCapabilityResolver(next: CapabilityResolver | null): void {
  resolver = next;
}

/**
 * 把 core/host.ts 的 hasHostFn 包成解析器。
 *
 * 装配处这样接（不 import host.ts 到本文件，保持依赖方向干净）：
 *   installCapabilityResolver(fromHasHostFn(hasHostFn))
 */
export function fromHasHostFn(hasHostFn: (name: string) => boolean): CapabilityResolver {
  return (name: string) => {
    let present = false;
    try {
      present = hasHostFn(name) === true;
    } catch {
      present = false;
    }
    if (!present) return 'none';
    try {
      if (probeNativeCapabilities(getStContext()).includes(name)) return 'native';
    } catch {
      // 探测失败不影响「它确实在」这个结论
    }
    return 'tavern-helper';
  };
}

/**
 * 探一条能力，给出可读状态。
 *
 * 任何异常都吞成「不可用」—— 这个函数在界面挂载前跑，抛一下就是白屏。
 */
export function probeCapability(def: Omit<Capability, 'provider'>): CapabilityStatus {
  const noNative = Object.prototype.hasOwnProperty.call(NO_NATIVE_EQUIVALENT, def.name);
  let provider: CapabilityProvider = 'none';
  try {
    provider = capabilityResolver()(def.name);
  } catch (error) {
    console.warn('[酒馆工坊Agent] 探测能力 ' + def.name + ' 抛错，按不可用处理', error);
    provider = 'none';
  }

  const nativePath = NATIVE_PATHS[def.name];
  const status: CapabilityStatus = { ...def, provider, ok: provider !== 'none' };
  if (nativePath) status.nativePath = nativePath;
  if (noNative) status.noNativeEquivalent = true;

  if (!status.ok) {
    status.reason = noNative
      ? def.label + '不可用：' + (NO_NATIVE_EQUIVALENT[def.name] ?? 'ST 原生没有对应接口')
      : def.label + '不可用：这台机器上找不到接口 ' + def.name +
        (nativePath ? '（ST 原生对应：' + nativePath + '）' : '') +
        '，也没有装酒馆助手可以顶替。';
  }
  return status;
}

/**
 * 探一遍全部能力，得到**能力表**（底座启动时调一次；界面也可以随时重探）。
 *
 * @param only 只探这几个名字（给「某个插件需要哪些」用；不传 = 全探）
 */
export function probeCapabilities(only?: readonly string[]): CapabilityStatus[] {
  if (!only || only.length === 0) return CAPABILITIES.map(def => probeCapability(def));

  const byName = new Map(CAPABILITIES.map(def => [def.name, def]));
  const out: CapabilityStatus[] = [];
  for (const name of only) {
    const def = byName.get(name);
    if (def) {
      out.push(probeCapability(def));
      continue;
    }
    // ⚠️ 插件声明了一个**不在能力表里**的名字 —— 这是**声明错误**，必须判 fail。
    // 如果这里静默跳过，插件就绕过了能力闸（写错名字反而「通过」），
    // 正是本项目一直在治的「静默失败」。判 fail + 说清原因，让它立刻暴露。
    out.push({
      name,
      provider: 'none',
      required: true,
      label: name,
      ok: false,
      reason:
        '能力「' + name + '」不在底座的能力表里（core/capability.ts 的 CAPABILITIES）。' +
        '这是插件 manifest 的 requires 写错了名字 —— 请改成能力表里的名字，或先在能力表里登记这条能力。',
    });
  }
  return out;
}

/** 能力表里可用的那些名字（插件装载用得快查） */
export function availableCapabilities(only?: readonly string[]): string[] {
  return probeCapabilities(only)
    .filter(status => status.ok)
    .map(status => status.name);
}
/* ==================== 插件装载裁决：缺能力 → 不注册 + 人话原因 ==================== */

/**
 * 一个插件的装载裁决结果。
 *
 * `ok=false` 时 `reason` 一定是**一句能直接显示给用户的人话**
 * （本任务的核心验收项：不能是「插件加载失败」这种没有信息量的文案）。
 */
export interface PluginCapabilityVerdict {
  /** 全部声明需要的能力都可用（或没声明需要什么） */
  ok: boolean;
  /** 缺失且**必须**的能力（required=true 的那些）—— 这些决定了 ok=false */
  missingRequired: CapabilityStatus[];
  /** 缺失但可降级的能力（required=false）—— 只提醒，不拦装 */
  missingOptional: CapabilityStatus[];
  /** 一句话人话原因（ok=true 时是空串） */
  reason: string;
  /** 给界面的详细说明（可能多行，逐条列缺什么） */
  detail: string;
}

/**
 * 评判一个声明了 `requires` 的插件能不能装。
 *
 * 口径（本任务明确定死，别再各自解释）：
 *   - **required 缺失 → 不注册**（ok=false），原因逐条列出缺哪个能力、缺的接口名、
 *     ST 原生对应是什么、以及「装了酒馆助手能不能补上」；
 *   - **optional 缺失 → 照常注册**，但把缺的记进 missingOptional，界面可显示「部分功能不可用」；
 *   - **required: false 的能力缺失时跑它的 degrade()**（降级动作是能力自己的事，
 *     比如「关掉生图开关」「退回直连模型列表」）。
 *
 * 任何异常吞掉按「不可用」处理 —— 装载阶段抛异常会连带把别的插件也带崩。
 */
export function evaluatePluginCapabilities(requires: readonly string[] | undefined): PluginCapabilityVerdict {
  const names = Array.isArray(requires) ? requires.filter(name => typeof name === 'string' && name.trim() !== '') : [];
  if (names.length === 0) return { ok: true, missingRequired: [], missingOptional: [], reason: '', detail: '' };

  // 口径：
  //   - requires 里写 'getWorldbook'   = **必需**（缺了拦装）
  //   - requires 里写 'getWorldbook?'  = **可选**（缺了照装，只降级 / 记一笔）
  // 问号后缀是唯一的「可选」表达法。为什么不用 CAPABILITIES 里的 required 字段：
  // 那个字段说的是「这条能力对**底座整体**是不是必需」，是全局降级策略；
  // 拿它覆盖插件声明的话，插件写了「我要读世界书」、而能力表里 getWorldbook 恰好是
  // required:false，插件就会**静默通过** —— 插件的需要被能力表的默认值悄悄否决了，
  // 正是本项目一直在治的静默失败。
  const declaredOptional = new Set<string>();
  const requiredNames: string[] = [];
  for (const name of names) {
    if (name.endsWith('?')) {
      const bare = name.slice(0, -1);
      declaredOptional.add(bare);
      requiredNames.push(bare);
    } else {
      requiredNames.push(name);
    }
  }

  const probed = probeCapabilities(requiredNames);
  const missingRequired = probed.filter(status => !status.ok && !declaredOptional.has(status.name));
  const missingOptional = probed.filter(status => !status.ok && declaredOptional.has(status.name));

  // 可降级的能力：缺失时跑它的降级动作。单个 degrade 抛错不影响别的。
  for (const status of missingOptional) {
    if (typeof status.degrade !== 'function') continue;
    try {
      status.degrade();
    } catch (error) {
      console.warn('[酒馆工坊Agent] 能力 ' + status.name + ' 的降级动作抛错（已忽略）', error);
    }
  }

  if (missingRequired.length === 0) {
    return { ok: true, missingRequired, missingOptional, reason: '', detail: '' };
  }

  // 人话原因：主句短、可显示在插件列表行上；detail 逐条给出线索。
  const labels = missingRequired.map(status => status.label).join('、');
  const reason = '缺少必需能力：' + labels + '（该插件已跳过，未注册任何工具 / 页面 / 宏）';
  const lines = [
    '这个插件需要以下能力，其中 ' + missingRequired.length + ' 项在这台机器上不可用：',
  ];
  for (const status of missingRequired) {
    lines.push('  ✗ ' + status.label + '（' + status.name + '）');
    if (status.reason) lines.push('      ' + status.reason);
    if (status.noNativeEquivalent) {
      lines.push('      ⚠️ ST 原生没有这个接口，不是「还没接适配器」—— 这条路走不通。');
    }
  }
  for (const status of missingOptional) {
    lines.push('  ⚠ ' + status.label + '（' + status.name + '）不可用，该功能会降级，插件照常装载');
  }

  return { ok: false, missingRequired, missingOptional, reason, detail: lines.join('\n') };
}

/**
 * 探一遍全部能力，打印一行摘要（扩展顶层调一次，真机上方便排查）。
 *
 * 返回 { total, ok, missing } 便于测试断言。
 */
export function reportCapabilityTable(): { total: number; ok: number; missing: string[] } {
  const table = probeCapabilities();
  const missing = table.filter(status => !status.ok).map(status => status.name);
  const ok = table.length - missing.length;
  console.info(
    '[酒馆工坊Agent] 能力表：' + ok + '/' + table.length + ' 可用' +
      (missing.length > 0 ? '；不可用：' + missing.join('、') : ''),
  );
  return { total: table.length, ok, missing };
}

/** 按名字取一条能力的状态；不在清单里返回 undefined（不抛） */
export function capabilityStatus(name: string): CapabilityStatus | undefined {
  const def = CAPABILITIES.find(item => item.name === name);
  return def ? probeCapability(def) : undefined;
}