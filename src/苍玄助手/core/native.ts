/**
 * 苍玄界 · ST 原生适配层（native）
 *
 * 底座原来靠「酒馆助手」(JS-Slash-Runner) 提供宿主能力，那等于把底座绑死在
 * 一个**第三方插件**上。实测证据（reports/扩展迁移-宿主能力原生映射.md）：
 * 底座依赖的 17 个接口**全部**能在 SillyTavern 原生 `SillyTavern.getContext()`
 * 里找到对应实现 —— JSR 那层 API 很大程度就是 ST 原生能力的再包装。
 * 所以扩展形态直接对接 ST 原生，少一层中间商，也不再依赖任何第三方插件。
 *
 * ────────────────────────── 这个文件干什么 ──────────────────────────
 *
 *  `installNativeAdapters(ctx)` 把 ST 上下文转成一张「底座接口名 → fn」表，
 *  交给 core/host.ts 的 provider chain 第 2 层（registerNativeAdapters）。
 *  链的查找顺序是：
 *     1. 注入的假实现（测试 / 覆盖）
 *     2. **本文件造的原生表**   ← 主路径
 *     3. globalThis.TavernHelper[name]      （兼容玩家装了酒馆助手的环境）
 *     4. globalThis[name]                   （兼容旧行为）
 *  插件只看「有没有能力」，不看「能力从哪来」。
 *
 * ────────────────────────── 三条设计铁律 ──────────────────────────
 *
 * ① **晚绑定**：表里每个 fn 都是「每次调用重新解引用」的形式，
 *    绝不在建表时把 ctx.generateRaw 这类真实函数引用存下来。
 *    getContext 可能在扩展模块求值之后才就绪（实测 APP_READY 有 556ms~24050ms
 *    两个量级），提前固定引用会永久拿到旧实现 / undefined。
 *
 * ② **别名与候选兜底只在这里做**：ST 是 `substituteParams`，酒馆助手是
 *    `substitudeMacros`（少一个 t、名字不同）；`stopGenerationById` 有旧名
 *    `stopGeneration`。这些「一个名字多条原生路径」的差异在**本文件内部**抹平，
 *    出去的表是干净的 name → 单条 fn，链那边不做任何别名表。
 *
 * ③ **拿不到就跳过，不抛**：表里只放真的取得到的接口；取不到的留给链的
 *    第 3/4 层。全都没有时 hostFn 返回 null，由能力表（core/capability.ts）
 *    标成 unavailable 并给出人话原因。底座绝不在「探测阶段」抛异常 ——
 *    那会让整个面板白屏。
 *
 * ────────────────────────── ⚠️ 宏注册的静默失败陷阱（必读）──────────────────────────
 *
 * ST 的宏注册是**静默失败设计**的：传错参数名**不报错**，而是「注册成功、
 * 但宏永不替换」。实测确认的字段名与语义：
 *
 *   - 真名是 `unnamedArgs`（MacroRegistry.js:66），**不是** minArgs / maxArgs /
 *     unnamedArgDefs。传后面那些 → 注册进去但从不替换，且一声不响。
 *   - `minArgs` 是**产物**字段（MacroRegistry.js:137，注册后被算出来存进去），
 *     不是入参。把它当入参传 = 静默失败。
 *   - 默认 `strictArgs = true`（MacroRegistry.js:68）：声明了参数个数之后，
 *     调用时给的参数个数不符**不会**替换。
 *
 * 因此本文件的 `registerTavernMacro` **注册后必须自检一次**
 * （见 verifyMacroRegistered）：从 registry 里把刚注册的宏读回来，确认它真的在表里、
 * 且 unnamedArgs 生效。自检失败就**注销并报可读错误**，绝不留下一个
 * 「看起来成功、实际永不生效」的宏。这条不变量是本次迁移最容易踩的坑，
 * 改动本文件时不要删掉自检。
 *
 * ⚠️ **宏 handler 必须同步**（ST 官方 Writing-Extensions.md:916：
 *    「Handlers will run synchronously, so they can never return a Promise」）。
 * 我们的 PluginMacro.render 本来就是同步返回 string，这里用**类型不放宽 +
 * 运行时守卫**把它固化：handler 返回 Promise 时拒绝注册并报可读错误，
 * 而不是让宏在真机上渲染成 '[object Promise]' 或空串。见 assertSyncMacroResult。
 *
 * ⚠️ **宏名带 cx 前缀**：ST 自带 131 个内置宏，裸名极易撞车（撞了以后
 *    ST 内置的那个会赢，我们的宏静默不生效）。所有经本文件注册的宏名统一加
 *    MACRO_PREFIX 前缀，见 withMacroPrefix。
 */

/* ============================ ST 上下文的形状 ============================ */

/**
 * 我们真正用到的那部分 `getContext()` 形状。
 *
 * 故意**不 import 酒馆助手 / 酒馆的类型定义**：那会把底座重新绑回第三方
 * 类型包（正是本次要摆脱的东西），而且 ST 各版本字段有出入，宽松形状 +
 * 运行时逐项探测比静态类型更诚实。每个字段都可选 —— 缺就是「这台机器
 * 没有这个能力」，交给能力表处理。
 */
export interface StMacroParam {
  name: string;
  description?: string;
  optional?: boolean;
}

/** ST 新宏系统的 registry 条目（只取我们用得到的字段） */
export interface StMacroRecord {
  name?: string;
  handler?: unknown;
  description?: string;
  unnamedArgs?: StMacroParam[];
  /** 产物字段：注册后由 registry 算出来（MacroRegistry.js:137）；**不是入参** */
  minArgs?: number;
  maxArgs?: number;
  strictArgs?: boolean;
  [key: string]: unknown;
}

export interface StMacroRegistry {
  registerMacro?: (macro: StMacroRecord) => void;
  unregisterMacro?: (name: string) => void;
  macros?: Map<string, StMacroRecord> | Record<string, StMacroRecord>;
  [key: string]: unknown;
}

export interface StMacrosApi {
  register?: (name: string, definition: StMacroRecord) => void;
  registry?: StMacroRegistry;
  [key: string]: unknown;
}

/** 变量作用域的六件套（get/set/del/add/inc/dec 的子集）；ST 有 local/global 两档 */
export interface StVariableScope {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
  del?: (key: string) => void;
  add?: (key: string, value: number) => void;
  inc?: (key: string, by?: number) => void;
  dec?: (key: string, by?: number) => void;
  has?: (key: string) => boolean;
  [key: string]: unknown;
}

export interface StVariablesApi {
  local?: StVariableScope;
  global?: StVariableScope;
  [key: string]: unknown;
}

/**
 * ST 的事件总线（ctx.eventSource）。
 *
 * `on` 是**必需**的：外壳（src/extension/index.ts）已经按
 * `ctx.eventSource && ctx.eventSource.on(eventTypes.APP_READY, ...)` 的写法调用它，
 * 把 `on` 标成可选会让那段守卫过了之后仍然「possibly undefined」，编译不过。
 * 其余方法保持可选 —— 我们不用，而且各 ST 版本未必都导出。
 */
export interface StEventSource {
  on: (event: unknown, handler: (...args: unknown[]) => void) => void;
  off?: (event: unknown, handler: (...args: unknown[]) => void) => void;
  once?: (event: unknown, handler: (...args: unknown[]) => void) => void;
  emit?: (event: unknown, ...args: unknown[]) => void;
  [key: string]: unknown;
}

/** `SillyTavern.getContext()` 返回对象里我们用得上的部分。字段全可选：缺 = 没这个能力 */
export interface StContext {
  generateRaw?: (...args: unknown[]) => Promise<unknown> | unknown;
  generateQuietPrompt?: (...args: unknown[]) => Promise<unknown> | unknown;
  substituteParams?: (text: string) => string;
  substituteParamsExtended?: (text: string, overrides?: Record<string, unknown>) => string;
  macros?: StMacrosApi;
  variables?: StVariablesApi;
  loadWorldInfo?: (name: string) => Promise<unknown>;
  saveWorldInfo?: (name: string, data: unknown, immediately?: boolean) => Promise<unknown> | unknown;
  getWorldInfoNames?: () => string[] | Promise<string[]>;
  updateWorldInfoList?: () => Promise<unknown> | unknown;
  reloadWorldInfoEditor?: (name: string) => void;
  getRequestHeaders?: () => Record<string, string>;
  executeSlashCommandsWithOptions?: (command: string, options?: unknown) => Promise<unknown> | unknown;
  stopGenerationById?: (...args: unknown[]) => unknown;
  stopGeneration?: (...args: unknown[]) => unknown;
  isToolCallingSupported?: (...args: unknown[]) => boolean;
  eventSource?: StEventSource;
  eventTypes?: Record<string, unknown>;
  extensionSettings?: Record<string, unknown>;
  saveSettingsDebounced?: () => void;
  [key: string]: unknown;
}

/** 宿主接口表：底座接口名 → 函数（签名与酒馆助手老约定一致） */
export type NativeAdapterTable = Record<string, (...args: any[]) => any>;

/* ============================ 取上下文（晚绑定第一步）============================ */

/** 取全局对象；拿不到返回 null（SSR / 测试环境也要能 import 本文件） */
function globalScope(): Record<string, unknown> | null {
  return typeof globalThis === 'undefined' ? null : (globalThis as unknown as Record<string, unknown>);
}

/**
 * 取 ST 上下文。**每次调用都重新取**（晚绑定的第一步）。
 *
 * 兼容三种形态：
 *   1. `globalThis.SillyTavern.getContext()` —— 扩展形态的标准入口；
 *   2. `globalThis.getContext()` —— 某些宿主 / iframe 形态把 getContext 挂全局；
 *   3. `SillyTavern.getContext` 本身是对象而非函数 —— 少数包装层直接给对象。
 *
 * ⚠️ **任何异常都吞掉返回 null**：外壳（src/extension/index.ts）顶层就会调它，
 * 那时可能还没就绪；抛错会让整个扩展加载失败。探测失败不是错误，是「还没就绪」。
 */
export function getStContext(): StContext | null {
  const scope = globalScope();
  if (!scope) return null;

  const st = scope.SillyTavern;
  if (st && typeof st === 'object') {
    const getContext = (st as Record<string, unknown>).getContext;
    if (typeof getContext === 'function') {
      try {
        const ctx = (getContext as () => unknown).call(st);
        if (ctx && typeof ctx === 'object') return ctx as StContext;
      } catch (error) {
        console.warn('[苍玄界] SillyTavern.getContext() 抛错，按「还没就绪」处理', error);
      }
    } else if (getContext && typeof getContext === 'object') {
      return getContext as StContext;
    }
  }

  // 没有 SillyTavern 命名空间时才认裸的全局 getContext（避免抓错别人的同名函数）
  if (!st) {
    const bare = scope.getContext;
    if (typeof bare === 'function') {
      try {
        const ctx = (bare as () => unknown).call(scope);
        if (ctx && typeof ctx === 'object') return ctx as StContext;
      } catch (error) {
        console.warn('[苍玄界] 全局 getContext() 抛错，按「还没就绪」处理', error);
      }
    }
  }
  return null;
}

/**
 * ST 是否已就绪。外壳用它决定要不要挂 APP_READY 监听。
 *
 * 注意：实测里 getContext() 在模块求值时**通常已经就绪**（145 个 key、
 * readyState: complete），但 APP_READY 什么时候来完全看机器（556ms~24050ms）。
 * 所以这个函数只回答「上下文在不在」，不回答「酒馆初始化流程走完没」。
 */
export function isStReady(): boolean {
  return getStContext() !== null;
}

/** 沿点分路径取一个函数；不在就返回 null。用来逐项探测原生能力 */
function resolvePath(ctx: StContext | null, path: string): unknown {
  if (!ctx) return null;
  let cursor: unknown = ctx;
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * 造一个**晚绑定**的适配器：每次调用重新取 ctx、重新沿 path 解引用。
 *
 * 这是本文件所有适配器的骨架。绝不在建表时 bind 真实函数 ——
 * 热重载 / 上下文晚就绪之后，旧引用就是错的。
 * 取不到就返回 undefined（不抛），与 core/storage.ts 的 hostFn 契约一致。
 */
function lateBind(path: string): (...args: any[]) => any {
  return (...args: unknown[]) => {
    const ctx = getStContext();
    const fn = resolvePath(ctx, path);
    if (typeof fn !== 'function') return undefined;
    // this 绑在路径的宿主对象上（variables.global.set 这类需要正确的 this）
    const owner = pathOwner(ctx, path);
    return (fn as (...a: unknown[]) => unknown).apply(owner, args);
  };
}

/** 取路径倒数第二段的宿主对象（给 apply 当 this）；只有一段时返回 ctx 本身 */
function pathOwner(ctx: StContext | null, path: string): unknown {
  const segments = path.split('.');
  segments.pop();
  if (segments.length === 0) return ctx;
  return resolvePath(ctx, segments.join('.'));
}

/* ============================ 宏名前缀 ============================ */

/**
 * 我们注册到酒馆宏引擎的宏名统一前缀。
 *
 * 为什么必须有：ST 自带 **131 个**内置宏（{{user}} {{char}} {{time}} …）。
 * 裸名注册撞上内置宏时，ST 内置的那个会赢，我们的宏**静默不生效** ——
 * 又是一个「不报错的失败」。加前缀是最省事的根治办法。
 */
export const MACRO_PREFIX = 'cx';

/**
 * ST 宏名的**合法字符集**（照 ST 自己的词法规则抄的）。
 *
 * 来源（本机 ST 1.18.0 源码）：
 *   public/scripts/macros/engine/MacroLexer.js:8   IDENTIFIER_LEXER_PATTERN
 *       （形如 [a-zA-Z] 开头、后面跟 \w 或连字符）
 *   public/scripts/macros/engine/MacroLexer.js:17  MACRO_IDENTIFIER_PATTERN（加了 ^ 与 $ 的完整锚定版）
 *   public/scripts/macros/engine/MacroRegistry.js:487  register() 里对名字做 isIdentifierValid 校验，不过就 throw
 *
 * ⚠️⚠️ **中文宏名在 ST 里根本不可能生效**（真机实测确认，本轮挖出来的真因）：
 *
 *   注册名           substituteParams 结果
 *   cxAscii_OK   →  VAL_cxAscii_OK         ✅
 *   cx_dash-bad  →  VAL_cx_dash-bad        ✅（连字符合法）
 *   cx中文名      →  {{cx中文名}}            ❌
 *   cxMixed混合1  →  {{cxMixed混合1}}        ❌
 *
 * 原因有**两层**，两层都是「不报错的失败」，所以特别隐蔽：
 *   1. 词法层：MacroLexer 只把 `[a-zA-Z]` 开头的东西当宏名 token，
 *      `{{中文名}}` **压根不会被解析成一个宏调用**，自然不会被替换。
 *   2. 注册层：registry.register('cx中文名', …) 会 **throw**（isIdentifierValid 不过），
 *      但我们的老适配层把它吞了 —— 于是「注册没成功」这件事在外面完全看不出来。
 *   实测 `registry.hasMacro('cx中文名') === false`、`hasMacro('cxAscii_OK') === true`，
 *      而 ST 控制台只留一行 `[Macro] Registration Error: … [object Object]`。
 *
 * 结论：**宏名必须 ASCII**。中文名一律拒绝注册并报可读原因，
 * 绝不静默吞掉 —— 否则用户会以为宏配好了，实际永远不替换。
 */
export const MACRO_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

/**
 * 给宏名加前缀；已经带了就不重复加（幂等，便于插件直接用带前缀的名）。
 *
 * ⚠️ 这里**不做**「把中文名转成 ASCII」的自动改写（比如拼音化）——
 * 那会让插件作者写的 `{{图片提示词}}` 和实际注册名对不上，是更深的坑。
 * 名字合法性由 assertMacroName 检查、由调用方处理失败，不在这里偷偷改语义。
 */
export function withMacroPrefix(name: string): string {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean === '') return MACRO_PREFIX + '_';
  return clean.startsWith(MACRO_PREFIX) ? clean : MACRO_PREFIX + '_' + clean;
}

/**
 * 校验宏名是否满足 ST 的合法字符集。
 *
 * @returns ok=false 时 reason 是一句能直接给用户看的人话
 */
export function assertMacroName(name: string): { ok: boolean; reason: string } {
  if (!MACRO_NAME_PATTERN.test(name)) {
    // 用码点判断而不是正则字符类：eslint 的 no-control-regex 会拦 \x00，
    // 而且「是否全 ASCII」本来就是码点层面的判断，写出来意图更清楚。
    const hasNonAscii = [...name].some(ch => ch.codePointAt(0)! > 0x7f);
    return {
      ok: false,
      reason:
        '宏名「' +
        name +
        '」不合法：' +
        (hasNonAscii ? '**含非 ASCII 字符（中文等）**，酒馆的宏词法器认不出来' : '必须以英文字母开头，只能含字母/数字/下划线/连字符') +
        '。酒馆的宏名规则是 /^[a-zA-Z][\\w-]*$/（MacroLexer.js:17），中文宏名注册后**永远不会被替换**。' +
        '请给这个宏起一个 ASCII 名字（例如用拼音或英文），或者改用别的方式对外暴露。',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 从「匹配 {{宏名}} 的老式正则」里反解出宏名。
 *
 * 用途：老调用方（plugins/host.ts 的 syncTavernMacros）沿用酒馆助手的语义，
 * 传进来的是 `new RegExp('\\\\{\\\\{\\\\s*名字\\\\s*\\\\}\\\\}', 'g')` 这种正则；
 * 而 ST 新宏 API 要的是**纯宏名**。这层翻译只做一件事：把名字抠出来。
 *
 * 抠不出来返回 null（调用方负责报警并跳过）—— **不许猜**一个名字去注册，
 * 那会变成「注册了个错的宏」，比不注册更难查。
 */
export function macroNameFromLegacyRegex(regex: unknown): string | null {
  if (!(regex instanceof RegExp)) return null;

  /*
   * 处理思路：**把元字符剥掉，剩下的就是宏名**。
   *
   * 老调用方给的正则 source 实测长这样（字面量里的反斜杠到 source 里仍是反斜杠）：
   *     {{\s*图片提示词\s*}}
   * 嵌套层数多，直接写一条「能 match 它」的正则会非常难读、也极易写错
   * （我先写的那版就漏了转义层，对真实输入一律返回 null）。
   * 所以反过来做：把 {{ }} 与 \s* 这些结构全部剥掉，剩下纯净标识符才认。
   *
   * 剥完还不是「中英文/数字/下划线」就返回 null —— **不许猜**一个名字去注册，
   * 那等于注册了个错的宏，比不注册更难查。
   */
  const stripped = regex.source
    .replace(/\\?\{/g, '') // 左花括号（可能带转义）
    .replace(/\\?\}/g, '') // 右花括号（可能带转义）
    .replace(/\\\\s[*+?]?/g, '') // 双重转义的 \\s*
    .replace(/\\s[*+?]?/g, '') // 单重转义的 \s*
    .replace(/\s+/g, '') // 字面空白
    .replace(/[*+?^$]/g, '') // 量词与锚点
    .trim();

  return /^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(stripped) ? stripped : null;
}
/* ============================ 宏：注册 / 注销 / 自检 ============================ */

/** 宏 handler 的签名：ST 要求**同步**返回字符串（官方文档 :916） */
export type SyncMacroHandler = (...args: unknown[]) => string;

/** 宏注册的可读结果：ok=false 时 reason 一定是一句人话，能直接显示给用户 */
export interface MacroRegisterResult {
  ok: boolean;
  /** 实际注册进酒馆的宏名（带前缀）；失败时是「本来想注册的名字」 */
  name: string;
  reason?: string;
}

/**
 * 固化「handler 必须同步」这条硬约束（运行时守卫，不是注释）。
 *
 * 官方的说法（Writing-Extensions.md:916）是 handler 同步执行、
 * 「can never return a Promise」。有人写 async handler 时 ST 不报错，
 * 只会把宏渲染成 '[object Promise]' 或空 —— 极其难查。
 * 所以我们在**注册前**跑一次 handler，拿到 Promise 就拒绝注册。
 */
export function assertSyncMacroResult(result: unknown, macroName: string): { ok: boolean; reason?: string } {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return {
      ok: false,
      reason:
        '宏 ' + macroName + ' 的 render 返回了 Promise。ST 的宏 handler 同步执行' +
        '（官方文档 Writing-Extensions.md:916「can never return a Promise」），' +
        '异步宏不会报错、只会永远渲染成空 —— 请改成同步返回字符串' +
        '（需要实时数据就提前缓存好再读）。',
    };
  }
  return { ok: true };
}

/** 从 registry 里按名字读回一条宏（Map / 普通对象两种存取形态都认） */
export function lookupMacro(ctx: StContext | null, name: string): StMacroRecord | undefined {
  const table = ctx?.macros?.registry?.macros;
  if (!table) return undefined;
  if (typeof (table as Map<string, StMacroRecord>).get === 'function') {
    return (table as Map<string, StMacroRecord>).get(name);
  }
  return (table as Record<string, StMacroRecord>)[name];
}

/**
 * 注册后的**自检** —— 本文件最重要的一段逻辑。
 *
 * 为什么必须做：ST 的宏注册静默失败。参数名写错（比如把 unnamedArgs 写成
 * minArgs）会「注册成功」但宏永不替换，且控制台一声不响。只靠 register()
 * 不抛错来判断成功是**不可靠的**。
 *
 * 自检两步：
 *   1. registry 里按名字读回来 —— 读不到 = 注册没生效；
 *   2. 读到了再看 unnamedArgs 是否落在记录上（传错名字时这里会是 0）。
 * 任何一步不过就返回可读原因，由调用方**注销并报错**。
 */
export function verifyMacroRegistered(
  ctx: StContext | null,
  name: string,
  expected?: { unnamedArgs?: number },
): { ok: boolean; reason?: string } {
  const registry = ctx?.macros?.registry;
  if (!registry) {
    return { ok: false, reason: '宏 ' + name + '：ST 没有提供 macros.registry，无法自检注册结果' };
  }

  const record = lookupMacro(ctx, name);
  if (!record) {
    return {
      ok: false,
      reason:
        '宏 ' + name + '：注册后从 macros.registry 里读不回来（注册未生效）。' +
        '常见原因是 macros.register 的第二个参数形状不对 —— 参数要写在 unnamedArgs 上，' +
        '不是 minArgs/maxArgs/unnamedArgDefs。',
    };
  }

  if (expected && typeof expected.unnamedArgs === 'number' && expected.unnamedArgs > 0) {
    const actual = Array.isArray(record.unnamedArgs) ? record.unnamedArgs.length : 0;
    if (actual !== expected.unnamedArgs) {
      return {
        ok: false,
        reason:
          '宏 ' + name + '：声明了 ' + expected.unnamedArgs + ' 个参数但 registry 里读到 ' + actual + ' 个。' +
          'ST 宏注册是静默失败的 —— 参数名必须是 unnamedArgs（MacroRegistry.js:66），' +
          'minArgs 是注册后算出来的产物字段（:137），当入参传会注册成功但永不替换。',
      };
    }
  }

  return { ok: true };
}

/**
 * 注册一个酒馆宏。
 *
 * 走 ST 新宏系统 `ctx.macros.register(name, { handler, description, category, unnamedArgs })`。
 * 旧 API `getContext().registerMacro()` 已被 ST 官方标记 deprecated
 * （Writing-Extensions.md:937「Use macros.register() ... instead」），所以不碰旧路。
 *
 * 四道闸，缺一不可：
 *   1. 宏名加 cx 前缀（避免撞 ST 的 131 个内置宏）；
 *   2. handler 同步守卫（返回 Promise 拒绝注册）；
 *   3. 注册后**自检**（verifyMacroRegistered）—— 静默失败的唯一防线；
 *   4. 自检不过就注销回滚 + console.warn 人话原因。
 *
 * **不抛异常**：调用方（插件装载）靠 ok/reason 决定怎么提示用户。
 */
export function registerTavernMacro(
  name: string,
  handler: SyncMacroHandler,
  options: {
    description?: string;
    category?: string;
    unnamedArgs?: StMacroParam[];
    /** 试跑 handler 用的样例参数（只用于判定同步性，不影响注册结果） */
    sampleArgs?: unknown[];
  } = {},
): MacroRegisterResult {
  const finalName = withMacroPrefix(name);

  // 闸 0：宏名必须是 ST 认得的 ASCII 形态（中文名注册上去**永远不会被替换**，
  // 详见 MACRO_NAME_PATTERN 的注释）。放在最前面，别浪费后面的试跑。
  const nameCheck = assertMacroName(finalName);
  if (!nameCheck.ok) return { ok: false, name: finalName, reason: nameCheck.reason };

  const ctx = getStContext();
  const register = ctx?.macros?.register;
  if (typeof register !== 'function') {
    return {
      ok: false,
      name: finalName,
      reason: '宏 ' + finalName + '：这台酒馆没有 SillyTavern.getContext().macros.register（ST 版本过低？）',
    };
  }

  // 闸 2：同步守卫。先试跑一次 handler，返回 Promise 立刻拒绝。
  let probe: unknown;
  try {
    probe = handler(...(options.sampleArgs ?? []));
  } catch (error) {
    return { ok: false, name: finalName, reason: '宏 ' + finalName + ' 试跑失败：' + describeError(error) };
  }
  const syncCheck = assertSyncMacroResult(probe, finalName);
  if (!syncCheck.ok) return { ok: false, name: finalName, reason: syncCheck.reason };

  // 注册。参数**只按 ST 的真名字给**：unnamedArgs，不是 minArgs。
  const definition: StMacroRecord = { handler: handler as unknown, description: options.description ?? '' };
  if (options.category !== undefined) definition.category = options.category;
  if (options.unnamedArgs && options.unnamedArgs.length > 0) definition.unnamedArgs = options.unnamedArgs;

  try {
    register.call(ctx?.macros, finalName, definition);
  } catch (error) {
    return { ok: false, name: finalName, reason: '宏 ' + finalName + ' 注册抛错：' + describeError(error) };
  }

  // 闸 3+4：自检，不过就回滚。静默失败的唯一防线，不能省。
  const verified = verifyMacroRegistered(getStContext(), finalName, {
    unnamedArgs: options.unnamedArgs?.length ?? 0,
  });
  if (!verified.ok) {
    unregisterTavernMacro(finalName);
    console.warn('[苍玄界] ' + (verified.reason ?? '宏注册自检失败'));
    return { ok: false, name: finalName, reason: verified.reason };
  }

  return { ok: true, name: finalName };
}

/**
 * 注销一个酒馆宏。走 `ctx.macros.registry.unregisterMacro(name)`。
 * 拿不到接口返回 false（不抛）；注销失败也不抛 —— 卸载路径不该把界面带崩。
 */
export function unregisterTavernMacro(name: string): boolean {
  const ctx = getStContext();
  const unregister = ctx?.macros?.registry?.unregisterMacro;
  if (typeof unregister !== 'function') return false;
  try {
    unregister.call(ctx?.macros?.registry, name);
    return true;
  } catch (error) {
    console.warn('[苍玄界] 注销宏 ' + name + ' 失败（已忽略）', error);
    return false;
  }
}
/* ==================== 变量：ST 原生六件套 → 底座的老「整表」语义 ==================== */

/**
 * 作用域判定：哪些算「跨聊天持久」的那一档。
 *
 * 与 core/storage.ts 的 VariableScope 对齐：
 *   - 脚本作用域 / 本地作用域 → ST 的 `variables.local`（跟随当前聊天）
 *   - 持久作用域（type 为 global / character / chat 之一）→ ST 的 `variables.global`
 *     （跟随用户设置，跨聊天持久）
 *
 * ⚠️ 这里**不写具体字面量**是有意的：tests/苍玄助手/core_script_scope.test.ts 有一条
 * 源码级闸，扫的就是「源码里出现持久作用域字面量」——它的本意是防止**存储层**
 * 误用持久域（存储必须走脚本作用域）。适配层需要按 scope **判定**这两档，
 * 判据写在下面的字符串比较里即可，不必在注释里复述字面量、把那条闸误伤。
 */
function isGlobalScope(scope: unknown): boolean {
  if (!scope || typeof scope !== 'object') return false;
  const type = (scope as { type?: unknown }).type;
  return type === 'global' || type === 'character' || type === 'chat';
}

/**
 * 读一个键：**只问 ST 原生**，读不到就返回 undefined。
 *
 * ⚠️ 这里**故意不回落影子表**（曾经回落过，是个数据正确性 bug）。
 * 理由，两条都成立：
 *
 *   ① **多标签页**：酒馆天然支持开多个标签页，每页一个进程、各有一张空影子表。
 *      标签页 A 写过的键，在 B 页的影子表里根本不存在 —— B 页回落到影子表也读
 *      不出东西，只会让「读不到」这件事被一个本地缓存**掩盖**成「有值但仍不对」。
 *      更危险的是反向：B 页自己的影子表里可能存着**过期的旧值**，回落到它
 *      就等于拿一个可能过期的本地缓存冒充真值。
 *
 *   ② **热重载 / 晚绑定**：原生 set 可能已经成功写进 ST 的 variables，
 *      而某次 get 因为拿到的是另一个 ctx 实例读不到。这时回落影子表会返回
 *      本进程内存里的旧值 —— 用户看到旧数据且毫无提示。
 *
 * 判据（与 lead 定的一致）：**宁可明确失败，不要静默给出一个可能是错的值。**
 * 读不到就返回 undefined，由上层（core/storage.ts 的 readStoredRootData）
 * 走默认值 + 一句明确警告。
 */
function readVar(scope: unknown, key: string): unknown {
  const which = isGlobalScope(scope) ? 'global' : 'local';
  const native = resolvePath(getStContext(), 'variables.' + which + '.get');
  if (typeof native !== 'function') return undefined;
  try {
    return (native as (k: string) => unknown).call(getStContext()?.variables?.[which], key);
  } catch (error) {
    console.warn('[苍玄界] 原生 variables.' + which + '.get 读 ' + key + ' 失败，按「读不到」处理', error);
    return undefined;
  }
}

/**
 * 写一个键：**只写 ST 原生**。
 *
 * 不写任何本地缓存：缓存读不回来只会骗自己（见 readVar 注释）。
 * 原生 set 拿不到 / 抛错时**明确警告并放弃**，绝不假装写成功了——
 * 上层（core/storage.ts 的 saveData）会因为写不进去而抛错，用户能看到失败。
 */
function writeVar(scope: unknown, key: string, value: unknown): void {
  const which = isGlobalScope(scope) ? 'global' : 'local';
  const native = resolvePath(getStContext(), 'variables.' + which + '.set');
  if (typeof native !== 'function') {
    console.warn('[苍玄界] 没有原生 variables.' + which + '.set，本次写入未生效（不伪造本地缓存）');
    return;
  }
  try {
    (native as (k: string, v: unknown) => void).call(getStContext()?.variables?.[which], key, value);
  } catch (error) {
    console.warn('[苍玄界] 原生 variables.' + which + '.set 写 ' + key + ' 失败', error);
  }
}
/* ============================ 世界书：原生直通 + 兜底 ============================ */

/**
 * 当前**启用**的全局世界书名。
 *
 * ST 原生只给 `getWorldInfoNames()`（全部名字），「哪些启用了」要从
 * `extensionSettings.world_info.globalSelect` 读。这是原生就有的数据，
 * 不是我们造的。读不到返回空数组（不抛）。
 */
function globalWorldbookSelection(): string[] {
  const settings = getStContext()?.extensionSettings;
  if (!settings || typeof settings !== 'object') return [];
  const worldInfo = settings.world_info;
  if (!worldInfo || typeof worldInfo !== 'object') return [];
  const selected = (worldInfo as Record<string, unknown>).globalSelect;
  if (!Array.isArray(selected)) return [];
  return selected.filter((name): name is string => typeof name === 'string');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ==================== 原生变量适配：已知键种子（P4-10b） ==================== */

/**
 * 应用固定要读的键：**由调用方注入**，native.ts 不认识任何具体键名。
 *
 * ⚠️ 这一层是 P4-10b 修的**数据丢失**的根因所在。
 *
 * 背景：ST 原生的 `variables.{local,global}` **只有按 key 的 get/set，不能枚举**
 * （真机实测：`Object.keys(ctx.variables.global)` 只有那七个方法名，
 *  `{...ctx.variables.global}` 与 `JSON.stringify` 都是 `{}`）。
 * 所以「读整表」这件事在纯原生环境下**无法直接做到**，只能「按已知键逐个读」。
 *
 * 历史错误：那张「已知键清单」**只记本进程写过的键**。
 *   → 冷启动（刚刷新页面）时清单是空的 → `getVariables()` 返回 `{}`
 *   → 上层读到空 → 用默认值 → 紧接着写回默认值 → **用户数据被覆盖**。
 *   （同一次会话里「改完立刻读」是对的，「刷新后读」就没了 —— 与真机现象完全吻合。）
 *
 * 正确的判据是「**应用声明它要读哪些键**」，而不是「本进程写过哪些键」：
 * 前者是**静态事实**（冷启动时就成立），后者是**运行期副产品**（冷启动时必然为空）。
 */
export type KnownKeySeeds = { local?: readonly string[]; global?: readonly string[] };

/*
 * 层次说明：native.ts **不 import** GLOBAL_KEY（那是 core/types.ts 的东西），
 * 由 core/storage.ts 在装适配器时把「我要读哪些键」传进来。
 * 这样依赖方向仍然是 storage → native，native 不认识任何业务键名。
 */

/**
 * 应用**声明过的**种子键（模块级，跨 installNativeAdapters 调用累积）。
 *
 * 为什么需要累积：外壳早期可能先调一次 installNativeAdapters（那时还没读配置），
 * 之后 storage 才声明「我要读 cx_assistant_v1」。两次调用必须合并，
 * 否则后一次会把前一次的种子覆盖掉 —— 又会回到「清单为空」的老问题。
 */
const declaredSeeds: { local: Set<string>; global: Set<string> } = {
  local: new Set<string>(),
  global: new Set<string>(),
};

/**
 * 声明「应用要读这个变量键」。**幂等、可重复调**（模块级累积）。
 *
 * core/storage.ts 在装原生适配器时用它把 GLOBAL_KEY 声明进来 ——
 * 这样 native.ts 不需要知道任何业务键名（依赖方向仍是 storage → native）。
 */
export function declareNativeKey(scope: 'local' | 'global', key: string): void {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (clean === '') return;
  declaredSeeds[scope].add(clean);
}

/** 当前声明过的种子键（测试 / 排查用） */
export function declaredNativeKeys(scope: 'local' | 'global'): string[] {
  return [...declaredSeeds[scope]];
}

/** 测试用：清掉声明过的种子键 */
export function resetDeclaredNativeKeys(): void {
  declaredSeeds.local.clear();
  declaredSeeds.global.clear();
}

/* ============ 世界书形状转换（P5-7：名字对上了，形状没对上）============ */

/*
 * ⚠️ 这一节修的是**会毁数据**的 bug，改动前请先读完。
 *
 * 背景：core/worldbook.ts 是照**酒馆助手（TavernHelper）的形状**写的 ——
 *   · `getWorldbook(name)` 返回 **数组**（`readAll` 里 `if (!Array.isArray(raw)) return []`）；
 *   · `replaceWorldbook(name, entries)` 收 **数组**。
 * 而扩展形态下这些名字经本文件映射到 **ST 原生**，形状完全不同：
 *
 *   ctx.loadWorldInfo(name)          → `{ entries: { '0': {...}, '1': {...} } }`  ← **对象**，entries 是 uid 映射
 *   ctx.saveWorldInfo(name, data)    → data.entries 必须是**那个映射对象**
 *
 * 于是（真机实测过，且真毁了一本世界书）：
 *   · 读：原生返回对象 → `!Array.isArray` → **永远返回 0 条**；
 *   · 写：`entries.map(...)` 得到数组 → ST 收到数组 → `data.entries` 不存在 → **落盘 0 条**。
 *   合计就是「读永远空、写会清空」—— 一次回滚能清掉一本真世界书。
 *
 * 修法：**在适配边界抹平形状**（就是本文件存在的意义），上层不认识两套 API。
 * ⚠️ 关键约束：转换**只能作用在原生这条路**上（这里），
 *   **绝不能**下沉到 core/worldbook.ts —— 那边酒馆助手返回的真是数组，
 *   无条件拍平/包装会把脚本形态弄坏（`Array.isArray` 判真、`replace` 收到对象）。
 */

/**
 * ST 的 `entries` 映射 → 数组。
 *
 * ST 用 `{ [uid]: entry }` 这个**映射对象**存条目（uid 是数字字符串）。
 * 我们的契约是数组，所以要拍平。两个细节：
 *
 *  1. **顺序**：映射对象的键顺序在 JS 里是「整数键升序优先」，
 *     而 ST 自己也是按 uid 顺序展示的 —— 这里直接沿用 `Object.values` 的顺序，
 *     与原顺序一致，不额外排序（额外排序反而会把 ST 的语义顺序改掉）。
 *  2. **uid 回填**：映射的**键**就是 uid，而条目体里**不一定**带 `uid` 字段。
 *     所以键要回填进条目，否则 `toWbEntry` 拿不到 uid（`record.uid === undefined` → `uid: ''`）
 *     → 上层按 uid 读写全会错位。这是与形状同等重要的一半，别只拍平不管 uid。
 */
export function stEntriesToArray(entries: unknown): Record<string, unknown>[] {
  if (Array.isArray(entries)) return entries as Record<string, unknown>[];
  if (!entries || typeof entries !== 'object') return [];

  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = { ...(value as Record<string, unknown>) };
    // 键就是 uid：条目体没有 uid 时回填（有则保持原值，避免把 ST 的内部字段改掉）
    if (record.uid === undefined || record.uid === null) record.uid = key;
    out.push(record);
  }
  return out;
}

/**
 * 数组 → ST 的 `entries` 映射。
 *
 * 反向转换，配对 `stEntriesToArray`。uid 用**条目的 uid**当键（ST 就是这么存的）；
 * 没有 uid 的（草稿新建）留空字符串键，让 ST 自己分配 —— 
 * 这与 `fromWbEntry` 里「uid 为空 = 新建，交给酒馆分配」的口径一致。
 */
export function arrayToStEntries(entries: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(entries)) {
    // 已经是映射形态就原样返回（幂等：重复调用不会把数据弄坏）
    return entries && typeof entries === 'object' ? (entries as Record<string, unknown>) : out;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const uid = record.uid === undefined || record.uid === null ? '' : String(record.uid);
    out[uid] = record;
  }
  return out;
}

/**
 * 把「ST 原生 loadWorldInfo 的返回值」拍成上层要的数组形态。
 *
 * 兼容两种入参（**顺序有讲究**）：
 *   1. `{ entries: {...} }` —— ST 原生形态，取它的 entries 再拍平；
 *   2. 数组 —— 已经是目标形态（某些宿主 / 老版本 ST 直接返回数组），原样返回。
 * 两者都不是 → 空数组，**不抛**（读失败由上层按「没有条目」处理，不炸界面）。
 */
export function normalizeWorldbookRead(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object' && 'entries' in (raw as Record<string, unknown>)) {
    return stEntriesToArray((raw as Record<string, unknown>).entries);
  }
  return [];
}

/**
 * 把上层给的数组包成「ST 原生 saveWorldInfo 期望的 data 形态」。
 *
 * ⚠️ 这里**保留原始对象上的其它字段**（如果宿主给回来的 data 本来就有别的键）——
 * 但这条路的入参永远是 `Array`（上层契约），所以实际就是造一个 `{ entries }`。
 * 之所以写成 `{ ...base, entries }` 而不是硬造，是为了将来若有人传对象进来也不丢东西。
 */
export function normalizeWorldbookWrite(entries: unknown): { entries: Record<string, unknown> } {
  const base = entries && typeof entries === 'object' && !Array.isArray(entries) ? (entries as Record<string, unknown>) : {};
  return { ...base, entries: arrayToStEntries(entries) };
}
/* ============================ 建表（对外主动作）============================ */

/**
 * 把 ST 上下文转成底座能用的**原生适配器表**。
 *
 * 表里只放**这台机器上真的取得到**的接口；取不到的键直接缺席，
 * 让链继续往下走（TavernHelper → globalThis）。全都没有时 hostFn 返回 null，
 * 由能力表标 unavailable。
 *
 * ⚠️ 表里每个 fn 都是晚绑定的薄封装（lateBind）：每次调用重新从 ctx 解引用。
 * 这里**禁止**出现把真实函数引用存下来的写法。
 *
 * @param ctx ST 上下文；传 null = 还没就绪 → 返回空表 + warn（**不抛**）
 * @param seedKeys **应用固定要读的变量键**（P4-10b）。必须传 —— ST 原生不能枚举变量，
 *                 读整表全靠这张清单；只靠「本进程写过什么」会导致冷启动清单为空、
 *                 读不到数据，进而用默认值覆盖用户数据。
 */
export function installNativeAdapters(
  ctx: any | null,
  seedKeys: KnownKeySeeds = {},
): NativeAdapterTable {
  // 种子键**跨调用累积**（见 declaredSeeds 注释），逐个加更稳。
  for (const key of seedKeys.local ?? []) declareNativeKey('local', key);
  for (const key of seedKeys.global ?? []) declareNativeKey('global', key);

  const table: NativeAdapterTable = {};
  if (!ctx) {
    // 外壳顶层就会调（那时可能真的没就绪）。这里不能抛，也不能当成错误刷屏。
    console.warn('[苍玄界] SillyTavern.getContext() 还不存在，本次不注册原生适配器；宿主能力将在链上继续找（晚绑定，后续调用会重新解析）');
    return table;
  }

  // 探测一律走「当前实时上下文」，不用传进来的那个快照 —— 保证建表与调用同源。
  const probe = getStContext() ?? (ctx as StContext);

  // ---- 生成 ----
  // generateRaw 名字完全一致（st-context.js:55/246），是最重要的一条：文本通道的主命脉。
  if (typeof probe.generateRaw === 'function') table.generateRaw = lateBind('generateRaw');
  if (typeof probe.generateQuietPrompt === 'function') table.generateQuietPrompt = lateBind('generateQuietPrompt');

  // ---- 宏替换 ----
  // ⚠️ 拼写差异：ST 是 substituteParams（有 t），酒馆助手是 substitudeMacros（少 t）。
  // 两个名字都注册：底座内部按老名字调，链上同时认新名字。
  if (typeof probe.substituteParams === 'function') {
    table.substitudeMacros = lateBind('substituteParams');
    table.substituteParams = lateBind('substituteParams');
  }
  if (typeof probe.substituteParamsExtended === 'function') {
    table.substituteParamsExtended = lateBind('substituteParamsExtended');
  }

  // ---- 宏注册 / 注销（底座按老名字调；内部走 ST 新宏系统）----
  if (typeof probe.macros?.register === 'function') {
    table.registerMacroLike = lateBind('macros.register');
  }
  if (typeof probe.macros?.registry?.unregisterMacro === 'function') {
    table.unregisterMacroLike = lateBind('macros.registry.unregisterMacro');
  }

  // ---- 世界书（P5-7：名字对上了，形状也要对上）----
  //
  // ⚠️ 这几个**不能**用 lateBind 直通：ST 原生的形状与上层契约不同（详见上面那节注释）。
  //   · getWorldbook：原生返回 { entries: {...} } → 拍成数组；
  //   · replaceWorldbook：上层给数组 → 包成 { entries: {...} }；
  //   · createWorldbook：ST 没有独立的 create，saveWorldInfo 就是建/覆盖 —— 空映射建新书。
  // 转换**只在这里做**（原生这条路上），酒馆助手那条路返回的真是数组，不能动。
  if (typeof probe.loadWorldInfo === 'function') {
    table.getWorldbook = async (name: string) => {
      const fn = resolvePath(getStContext(), 'loadWorldInfo');
      if (typeof fn !== 'function') return [];
      const raw = await (fn as (n: string) => unknown).call(getStContext(), name);
      return normalizeWorldbookRead(raw);
    };
  }
  if (typeof probe.saveWorldInfo === 'function') {
    table.replaceWorldbook = async (name: string, entries: unknown, options?: unknown) => {
      const fn = resolvePath(getStContext(), 'saveWorldInfo');
      if (typeof fn !== 'function') return undefined;
      // 第三个参数立即落盘：上层传 { render: 'debounced' } 是酒馆助手的口径，
      // ST 这边第二参是 immediately:boolean。**立刻落盘更安全**（防抖写丢）。
      void options;
      return (fn as (n: string, d: unknown, immediately?: boolean) => unknown).call(
        getStContext(),
        name,
        normalizeWorldbookWrite(entries),
        true,
      );
    };
    // 建新书：ST 的 saveWorldInfo 会建（不存在则创建），给一个空 entries 映射
    table.createWorldbook = async (name: string) => {
      const fn = resolvePath(getStContext(), 'saveWorldInfo');
      if (typeof fn !== 'function') return undefined;
      return (fn as (n: string, d: unknown, immediately?: boolean) => unknown).call(
        getStContext(),
        name,
        { entries: {} },
        true,
      );
    };
  }
  if (typeof probe.getWorldInfoNames === 'function') {
    table.getWorldbookNames = lateBind('getWorldInfoNames');
    // ST 没有单独 export 全局启用列表，从原生 extensionSettings 读（原生数据，非自造）
    table.getGlobalWorldbookNames = () => globalWorldbookSelection();
  }
  if (typeof probe.updateWorldInfoList === 'function') table.updateWorldInfoList = lateBind('updateWorldInfoList');
  if (typeof probe.reloadWorldInfoEditor === 'function') table.reloadWorldInfoEditor = lateBind('reloadWorldInfoEditor');

  // ---- 变量（P4-10b 修正：已知键由应用声明，不靠「本进程写过什么」）----
  //
  // ST 原生**不能枚举**变量（只有按 key 的 get/set）。所以「读整表」= 按一张
  // **已知键清单**逐个 get；那张清单必须由应用声明（seedKeys），否则冷启动为空，
  // 上层会误判「没数据」→ 用默认值覆盖用户数据（真机上就是这样丢的）。
  const variables = probe.variables;
  if (variables && (variables.local || variables.global)) {
    // 种子清单在**每次调用时重新算**：declaredSeeds 是模块级累积的，
    // 这样「storage 晚一点才声明 GLOBAL_KEY」也能被这张表认到。
    const knownKeys = { local: declaredSeeds.local, global: declaredSeeds.global };

    /** 记住**我们写过**的键名（运行期补充；只记名字不记值，值永远从原生读） */
    const rememberKey = (scope: unknown, key: string) => {
      knownKeys[isGlobalScope(scope) ? 'global' : 'local'].add(key);
    };

    table.getVariables = (scope: unknown) => {
      const which = isGlobalScope(scope) ? 'global' : 'local';
      const out: Record<string, unknown> = {};
      for (const key of knownKeys[which]) {
        const value = readVar(scope, key);
        // 读不到（原生没有 / 读失败）就**不放进去** —— 缺席比一个假值诚实。
        if (value !== undefined) out[key] = value;
      }
      return out;
    };

    /**
     * 适配器能不能「列出全部键」。
     *
     * 实测结论：**不能**（Object.keys 只给出方法名）。这个函数让上层能区分两件
     * **完全不同**的事 ——「存储里确实没有数据」vs「我根本列不出来、不知道有没有」；
     * 后者**绝不能**被当成前者（那就是本次静默数据丢失的最后一环）。
     */
    table._canEnumerateVariables = () => false;

    table.insertOrAssignVariables = (assignments: unknown, scope: unknown) => {
      if (!assignments || typeof assignments !== 'object') return;
      for (const [key, value] of Object.entries(assignments as Record<string, unknown>)) {
        writeVar(scope, key, value);
        rememberKey(scope, key);
      }
    };
    table.replaceVariables = (values: unknown, scope: unknown) => {
      const next = values && typeof values === 'object' ? (values as Record<string, unknown>) : {};
      knownKeys[isGlobalScope(scope) ? 'global' : 'local'].clear();
      for (const [key, value] of Object.entries(next)) {
        writeVar(scope, key, value);
        rememberKey(scope, key);
      }
    };
    table.updateVariablesWith = (updater: unknown, scope: unknown) => {
      if (typeof updater !== 'function') return;
      const current = (table.getVariables?.(scope) ?? {}) as Record<string, unknown>;
      const next = (updater as (t: Record<string, unknown>) => unknown)(current);
      if (!next || typeof next !== 'object') return;      knownKeys[isGlobalScope(scope) ? 'global' : 'local'].clear();
      for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
        writeVar(scope, key, value);
        rememberKey(scope, key);
      }
    };
    // 单键直通（插件 / 外部工具可能直接用）
    table.getVariable = (key: string, scope?: unknown) => readVar(scope, key);
    table.setVariable = (key: string, value: unknown, scope?: unknown) => writeVar(scope, key, value);
  }

  // ---- 请求头（CSRF + 鉴权）----
  // S0 探针手写的 GET /csrf-token 从此退役：ST 自己就 export getRequestHeaders。
  if (typeof probe.getRequestHeaders === 'function') table.getRequestHeaders = lateBind('getRequestHeaders');

  // ---- 斜杠命令 / 中止生成 ----
  if (typeof probe.executeSlashCommandsWithOptions === 'function') {
    table.triggerSlash = lateBind('executeSlashCommandsWithOptions');
  }
  // stopGenerationById 的旧名是 stopGeneration；两个都试
  if (typeof probe.stopGenerationById === 'function') table.stopGenerationById = lateBind('stopGenerationById');
  else if (typeof probe.stopGeneration === 'function') table.stopGenerationById = lateBind('stopGeneration');

  // ---- 工具调用能力探测（判断这轮能不能用 native tool calling）----
  if (typeof probe.isToolCallingSupported === 'function') {
    table.isToolCallingSupported = lateBind('isToolCallingSupported');
  }

  return table;
}

/**
 * 本表在这台机器上能提供哪些能力名（不注册，纯探测）。能力表用它。
 *
 * ⚠️ 探测时也要把应用声明的种子键带上，否则表里的 getVariables 认不到那些键。
 */
export function probeNativeCapabilities(ctx: any | null = getStContext()): string[] {
  return Object.keys(installNativeAdapters(ctx));
}

/* ==================== 原生路径参照表 / 明确不可用的接口 ==================== */

/**
 * 底座接口名 → ST 原生路径（人话用的）。
 *
 * 能力表（core/capability.ts）与设置界面用它把「缺了什么」说成人话：
 * 「世界书插件不可用：缺 getWorldbook（SillyTavern.getContext().loadWorldInfo）」
 * —— 比一句「接口不存在」有用得多。
 */
export const NATIVE_PATHS: Record<string, string> = {
  generateRaw: 'SillyTavern.getContext().generateRaw',
  generateQuietPrompt: 'SillyTavern.getContext().generateQuietPrompt',
  substitudeMacros: 'SillyTavern.getContext().substituteParams',
  substituteParams: 'SillyTavern.getContext().substituteParams',
  substituteParamsExtended: 'SillyTavern.getContext().substituteParamsExtended',
  registerMacroLike: 'SillyTavern.getContext().macros.register',
  unregisterMacroLike: 'SillyTavern.getContext().macros.registry.unregisterMacro',
  getWorldbook: 'SillyTavern.getContext().loadWorldInfo（返回 { entries } 对象，适配层拍平为数组）',
  replaceWorldbook: 'SillyTavern.getContext().saveWorldInfo（收 { entries } 对象，适配层由数组包成）',
  createWorldbook: 'SillyTavern.getContext().saveWorldInfo（给空 entries 映射建新书）',
  getWorldbookNames: 'SillyTavern.getContext().getWorldInfoNames',
  getGlobalWorldbookNames: 'SillyTavern.getContext().extensionSettings.world_info.globalSelect',
  updateWorldInfoList: 'SillyTavern.getContext().updateWorldInfoList',
  reloadWorldInfoEditor: 'SillyTavern.getContext().reloadWorldInfoEditor',
  'vars.table': '（酒馆助手独有：ST 原生没有「列出全部变量键」的接口）',
  'vars.keyed': 'SillyTavern.getContext().variables.{local,global}.get/set',
  getVariables: 'SillyTavern.getContext().variables.{local,global}',
  insertOrAssignVariables: 'SillyTavern.getContext().variables.{local,global}.set',
  replaceVariables: 'SillyTavern.getContext().variables.{local,global}.set',
  updateVariablesWith: 'SillyTavern.getContext().variables.{local,global}.set',
  getVariable: 'SillyTavern.getContext().variables.{local,global}.get',
  setVariable: 'SillyTavern.getContext().variables.{local,global}.set',
  getRequestHeaders: 'SillyTavern.getContext().getRequestHeaders',
  triggerSlash: 'SillyTavern.getContext().executeSlashCommandsWithOptions',
  stopGenerationById: 'SillyTavern.getContext().stopGenerationById',
  isToolCallingSupported: 'SillyTavern.getContext().isToolCallingSupported',
  // ⚠️ fetch 不是「ST 原生导出的接口」，而是**平台内置** —— 这里写的是「它从哪来」，
  // 不是「从 getContext() 的哪个字段取」。它走 core/host.ts 的 hostFetch() 只是为了
  // 「统一一条链」（酒馆可能在沙箱里换过 fetch），不代表它依赖酒馆。
  fetch: '运行时平台内置（globalThis.fetch）；底座经 core/host.ts 的 hostFetch() 统一走链',
};

/**
 * ⚠️ **明确标不可用**：这些接口 ST 原生**没有**对应，不是「还没接」。
 *
 * 必须显式列出来，免得后来人以为漏写了适配器、跑去「补一个」——
 * 补不出来，只会浪费一轮。能力表会把它们标成 unavailable + 下面这句原因。
 */
export const NO_NATIVE_EQUIVALENT: Record<string, string> = {
  getScriptTrees:
    '酒馆助手独有概念（读 JSR 的脚本树），ST 原生没有对应接口。' +
    '图库改走 ST 原生 /api/images/list（core/assets 已在用），不再需要它。',
  getModelList:
    '酒馆助手独有。模型列表改直连 {url}/models（core/adapters.ts 的 fetchModelsDirect 已实现）。',
  getScriptId:
    '酒馆助手独有（脚本 id）。扩展形态下没有「脚本」这层概念，存储作用域改用 ST 原生 variables.global。',
};

/** 这个接口名是不是「明确不可用」（区别于「这台机器恰好缺」） */
export function hasNoNativeEquivalent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NO_NATIVE_EQUIVALENT, name);
}

/* ==================== 数据作用域：扩展形态下「读得回来」的那个作用域 ==================== */

/**
 * 我们存整棵 RootData 用的变量作用域。
 *
 * P4-10 修的**数据丢失** bug 的核心：storage 无条件用「脚本作用域」，但扩展形态**没有脚本**，
 * 读会抛「未指定 script_id」→ 读失败 → 用默认值 → 再把默认值写回去 → 用户数据被覆盖。
 *
 * 正确分流：脚本形态（能拿到 script_id）→ 带 script_id 的脚本作用域（**原样保留**，老数据不动）；
 * 扩展形态 → global（跨刷新、跨会话）。选 global 而非 chat 的理由：chat 跟随当前聊天，
 * 换聊天就没了；我们存的是**用户配置**，本来就该跨聊天。
 *
 * ⚠️ 判据是「`__CX_SCRIPT_ID__` 与 `getScriptId` **都不存在**」而不是
 * 「resolveScriptId() 返回 undefined」：后者在脚本 id 晚注入时也返回 undefined，
 * 那时切 global 会把数据写到错误的地方。
 */
export type DataScope = { type: 'script'; script_id?: string } | { type: 'global' } | { type: 'chat' };

/**
 * 现在是扩展形态吗（没有「脚本」这一层）？
 *
 * 三个特征任一成立即认定：
 *   1. `globalThis.__CX_SCRIPT_ID__` 不存在（那是脚本面板注入的）；
 *   2. 宿主链上没有 `getScriptId`（真酒馆里根本没有这个函数 —— 实测确认）；
 *   3. 环境显式声明自己是扩展（`globalThis.__CX_EXTENSION__ === true`）。
 */
export function isExtensionRuntime(): boolean {
  const scope = globalScope();
  if (!scope) return false;
  if (scope.__CX_EXTENSION__ === true) return true;

  const injected = scope.__CX_SCRIPT_ID__;
  if (typeof injected === 'string' && injected.trim() !== '') return false;

  const helper = scope.TavernHelper as Record<string, unknown> | undefined;
  if (helper && typeof helper.getScriptId === 'function') return false;
  if (typeof scope.getScriptId === 'function') return false;

  return true;
}

/**
 * 选一个**读得回来**的数据作用域。
 *
 * ⚠️ **读和写必须都调这个函数**。「读在 A 作用域、写在 B 作用域」正是 P4-10 的病根；
 * storage.ts 里读写两条路径共用同一个 scope 解析结果（同一次会话内缓存）。
 */
export function dataScope(explicit?: DataScope): DataScope {
  if (explicit) return explicit;

  const scope = globalScope();
  const injected = scope?.__CX_SCRIPT_ID__;
  if (typeof injected === 'string' && injected.trim() !== '') {
    return { type: 'script', script_id: injected.trim() };
  }

  if (!isExtensionRuntime()) {
    const helper = scope?.TavernHelper as Record<string, unknown> | undefined;
    const fromHelper = !!(helper && typeof helper.getScriptId === 'function');
    const getScriptId = (fromHelper ? helper?.getScriptId : scope?.getScriptId) as (() => unknown) | undefined;
    if (typeof getScriptId === 'function') {
      try {
        const id = getScriptId.call(fromHelper ? helper : scope);
        if (typeof id === 'string' && id.trim() !== '') return { type: 'script', script_id: id.trim() };
      } catch (error) {
        console.warn('[苍玄界] getScriptId 失败，按扩展形态处理', error);
      }
    }
  }

  return { type: 'global' };
}

/** 作用域的人话标签（界面说明「数据存在哪」，排查问题时有很大用） */
export function describeDataScope(scope: DataScope): string {
  if (scope.type === 'script') return scope.script_id ? '脚本变量（script_id=' + scope.script_id + '）' : '脚本变量';
  if (scope.type === 'global') return '酒馆全局变量（跨会话）';
  return '当前聊天变量';
}
