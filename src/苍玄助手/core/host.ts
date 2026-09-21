/**
 * 苍玄助手 · 宿主 provider chain（**唯一一条**宿主解析链）
 *
 * 背景（审计：三条平行链，同一接口两种解析结果）：
 *   1. core/storage.ts 的 hostFn()  —— 闭包，晚绑定，认注入的假实现
 *   2. agent/transport.ts 的 globalFunction() —— 用 .bind() **早绑定**，且**不认**注入的假实现
 *   3. core/macros.ts 的 applyStMacros() —— 裸读 globalThis.substitudeMacros，完全绕过前两条
 * 同一份代码里「generateRaw 注入的假实现在 storage 链上生效、在 transport 链上不生效」，
 * 就是这三条链给出的两种答案。现在全部收敛到这里。
 *
 * **唯一解析顺序（晚绑定）**：
 *   1. 注入的假实现（setHostBridge，测试用）
 *   2. 注册的原生适配器（registerNativeAdapters，ST getContext() 等，由 core/native.ts 挂进来）
 *   3. globalThis.TavernHelper[name]
 *   4. globalThis[name]（历史兼容：再兜一层 globalThis.window[name]）
 *
 * **晚绑定是硬要求**：每一次 hostFn(name) 调用都重新走一遍整条链，**不做任何缓存**，
 * 也不许在解析时把函数 .bind() 固定下来 —— 面板里宿主接口经常晚于首次读取才就绪
 * （例如 getScriptId / generateRaw），早绑定会在接口就绪前先把 undefined 定死。
 *
 * 不碰任何插件、不 import 任何东西：这一层只认名字，不认业务。
 */

/** 宿主接口的统一签名；参数与返回值都按酒馆助手的原始约定 */
export type HostFn = (...args: any[]) => any;

/** 一张 name → 宿主实现的表；key 就是酒馆助手接口名 */
export type HostProviderTable = Record<string, HostFn | undefined>;

/**
 * 原生适配器表（第 2 层）。
 *
 * 与 HostProviderTable 是同一个形状，单独给个名字是为了让 core/native.ts 与
 * src/extension/index.ts 的契约读起来自解释（lead 的外壳按这个名字 import）。
 * 两者可互换使用，不引入任何运行时差异。
 */
export type NativeAdapterTable = Record<string, HostFn | undefined>;

/* ============================ 第 1 层：注入的假实现 ============================ */

let injectedBridge: HostProviderTable | null = null;

/** 注入假实现（测试用）；传 null 恢复成读真实宿主 */
export function setHostBridge(bridge: HostProviderTable | null): void {
  injectedBridge = bridge;
}

/** 取当前注入的宿主接口表；没注入过返回 null */
export function getHostBridge(): HostProviderTable | null {
  return injectedBridge;
}

/* ============================ 第 2 层：注册的原生适配器 ============================ */

/**
 * 原生适配器表（ST getContext() 适配层）。
 *
 * 为什么单独一层、而不是混进注入层：注入层是**测试替身**，会整体覆盖宿主；
 * 原生适配器是**真宿主能力**，只是换了个取法（老接口没了，从 getContext() 里挖）。
 * 两者语义不同，混在一起会让「测试注入优先」这条规则失效。
 */
let nativeAdapters: HostProviderTable = {};

/**
 * 注册原生适配器表（第 2 层）。
 *
 * 由 core/native.ts 在模块载入时调用：`registerNativeAdapters(buildNativeAdapters(st))`。
 * 传 null 清空。后注册的同名实现覆盖先前的（也覆盖已经注册过的旧表 —— 见下）。
 */
export function registerNativeAdapters(table: NativeAdapterTable | null): void {
  if (table === null) {
    nativeAdapters = {};
    return;
  }
  nativeAdapters = { ...nativeAdapters, ...table };
}

/** 清空原生适配器表（测试 / 卸载用） */
export function clearNativeAdapters(): void {
  nativeAdapters = {};
}

/**
 * 只覆盖某一个名字（第 2 层）。
 *
 * 单个适配器写坏 / 需要局部替换时用；fn 传 null 表示撤掉这一个名字。
 */
export function setNativeAdapter(name: string, fn: HostFn | null): void {
  const next: HostProviderTable = { ...nativeAdapters };
  if (fn === null) delete next[name];
  else next[name] = fn;
  nativeAdapters = next;
}

/** 当前原生适配器表（只读快照，测试断言用） */
export function getNativeAdapters(): HostProviderTable {
  return { ...nativeAdapters };
}

/* ============================ 链本体 ============================ */

/**
 * 按名字取宿主接口，**每次调用重新解析整条链**。
 *
 * 找不到返回 null（调用方自己决定是抛错还是降级），不做任何缓存 ——
 * 这样界面运行时接口晚一点就绪也能拿到。
 *
 * 第 3/4 层用箭头闭包**逐次解引用**（而不是先取出函数再 .bind()）：
 * 宿主把 TavernHelper 整个换掉（面板重载）时，旧引用会变成孤儿。
 */
export function hostFn(name: string): HostFn | null {
  // 1) 注入的假实现：只认显式存在的函数名，没列的名字继续往下走
  const injected = injectedBridge?.[name];
  if (typeof injected === 'function') return injected;

  // 2) 注册的原生适配器（ST getContext() 适配层）
  const native = nativeAdapters[name];
  if (typeof native === 'function') return native;

  const scope = typeof globalThis === 'undefined' ? null : (globalThis as Record<string, any>);
  if (!scope) return null;

  // 3) 酒馆助手全局对象
  const helper = scope.TavernHelper;
  if (helper && typeof helper[name] === 'function') {
    // 晚绑定：调用时才去 helper 上重新取，且保留 this 为 helper
    return (...args: any[]) => helper[name](...args);
  }

  // 4) 全局同名函数
  if (typeof scope[name] === 'function') {
    return (...args: any[]) => scope[name](...args);
  }

  // 4') 历史兼容：有些宿主把接口挂在 window 上（globalThis.window === globalThis，
  //     但 iframe / 沙箱里未必相等，多兜一层不亏）
  try {
    const win = scope.window as Record<string, any> | undefined;
    if (win && win !== scope && typeof win[name] === 'function') {
      return (...args: any[]) => win[name](...args);
    }
  } catch {
    /* 宿主没给 window 就算了 */
  }

  return null;
}

/** 宿主接口在不在（界面可用来显示「未连接」） */
export function hasHostFn(name: string): boolean {
  return hostFn(name) !== null;
}

/**
 * 取宿主接口，取不到就抛。
 *
 * 世界书那种「没有接口就没法干活」的地方用它；找不到时抛的是调用方给的错误类，
 * 这样 core 不用认识任何具体业务的错误类型。
 */
export function requireHostFn(name: string, makeError: (name: string) => Error): HostFn {
  const fn = hostFn(name);
  if (!fn) throw makeError(name);
  return fn;
}

/* ============================ 便利封装 ============================ */

/**
 * 调一次宿主接口，拿返回值。
 *
 * 找不到接口 / 调用抛错 → 返回 undefined（不抛），把「宿主没给」和「宿主炸了」
 * 一并交给调用方按降级处理。需要区分这两种情况时请直接用 hostFn()。
 */
export function callHostFn(name: string, ...args: unknown[]): unknown {
  const fn = hostFn(name);
  if (!fn) return undefined;
  return fn(...args);
}

/**
 * 取宿主 fetch。
 *
 * fetch 也是宿主能力（酒馆可能在沙箱里换了 fetch），一并走链，
 * 免得又出现「transport 裸读 globalThis.fetch、nai 裸读 globalThis.fetch」这种第二、第三条链。
 */
export function hostFetch(): HostFn | null {
  return hostFn('fetch');
}
