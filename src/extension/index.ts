/**
 * 苍玄界 · 扩展入口（SillyTavern extension bootstrap）
 *
 * 这个文件是**唯一**被酒馆直接加载的代码（manifest.json 的 `js` 指向 dist/extension/index.js）。
 * 它的职责只有三件事，别在这里写业务：
 *   1. 把「宿主能力」注册进底座（core/host.ts 的 provider chain）
 *   2. 提供生命周期钩子（manifest.hooks 里的名字必须在这里 export）
 *   3. 在**正确的时机**挂载界面
 *
 * ────────────────────────── 三条硬约束（阶段 3.5 实测）──────────────────────────
 *
 * ① **activate 有 5 秒超时，且模块是 ES-module 单例**
 *    在酒馆界面里点「禁用→启用」**不会**重新执行本文件的顶层代码
 *    （模块已经被 import 过，浏览器缓存住了）。所以初始化逻辑必须写成
 *    **可重复调用**的 init()，不能依赖顶层副作用。顶层只做「注册」这种幂等的事。
 *
 * ② **APP_READY 时机不稳定**（实测 24050ms vs 556ms 两个量级）
 *    getContext() 在模块求值时其实**已经就绪**（145 个 key、readyState: complete），
 *    但 APP_READY 什么时候来完全看机器。所以：
 *      - 顶层立刻可用的能力（getContext / macros / 事件）→ 顶层注册
 *      - 需要 DOM 存在的（#extensions_settings2）→ 等 APP_READY 或 activate
 *
 * ③ **动态 chunk 是 hash 文件名，更新后旧 chunk 404**
 *    发布必须**原子**：index.js 与它引用的 chunk 必须同批上线。
 *    否则玩家侧就是「更新后白屏」—— 这是这类扩展最经典的翻车方式。
 */
import './style.css';

import { getStContext, installNativeAdapters, isStReady } from '../苍玄助手/core/native.ts';
import { registerNativeAdapters } from '../苍玄助手/core/host.ts';

/* ============================ 运行时状态 ============================ */

/**
 * 模块级状态 —— 因为模块是单例，这些值在整个酒馆会话里存活。
 * key 用 `cx_<名字>`，方便在控制台里一眼认出是我们的。
 */
const state: {
  /** 面板挂载点是否已经插进 DOM */
  mounted: boolean;
  /** 已注册的清理回调（dispose 时按序倒着跑） */
  disposers: (() => void)[];
  /** 底座初始化是否跑过（init 可重复调用，靠它防重入） */
  inited: boolean;
} = {
  mounted: false,
  disposers: [],
  inited: false,
};

/** 挂载点 id —— 前缀 cx- 避免和酒馆 / 别的扩展撞 */
const ROOT_ID = 'cx-root-mount';

/* ============================ 底座初始化 ============================ */

/**
 * 初始化底座。**可重复调用**（activate / enable / APP_READY 都可能来调）。
 *
 * 做两件事：
 *  1. 注册原生宿主适配器 —— 让底座摆脱对「酒馆助手」的依赖，
 *     所有宿主调用走 SillyTavern.getContext() 原生接口
 *  2. 探一次能力表，把不可用的能力记下来（界面要显示原因）
 *
 * ⚠️ 必须在**任何业务代码跑之前**完成 —— 底座读世界书 / 注册宏都要走这条链。
 */
function init(): void {
  if (state.inited) return;
  state.inited = true;

  const ctx = getStContext();
  if (!ctx) {
    // 还没就绪不要紧：getContext 是晚绑定的，后面真正调用时会再取一次。
    // 这里只是不能注册适配器表 —— 留个明显的日志，别静默。
    console.warn('[苍玄界] 初始化时 SillyTavern.getContext() 还不存在，宿主能力将在首次调用时惰性解析');
    return;
  }

  // 把原生适配器挂进 host.ts 的 provider chain（第 2 层）。
  // 晚绑定：这里交出去的是「怎么按名字取到函数」的规则，不是固定的函数引用，
  // 所以酒馆热重载 / 扩展重载后拿到的永远是当前实现。
  registerNativeAdapters(installNativeAdapters(ctx));
  console.log('[苍玄界] 宿主能力已切到 ST 原生接口');
}

/* ============================ 界面挂载 ============================ */

/**
 * 挂载点：**document.body**（悬浮层挂在页面级，不挂进设置抽屉）。
 *
 * ⚠️ 这条是真机踩出来的（不是推演）：
 * 一开始按官方模板把容器 append 到 #extensions_settings2。那个节点在酒馆里
 * 位于 `#rm_extensions_block`（设置抽屉）内部，而**抽屉关着时 ST 给它 display:none**：
 *
 *   #extensions_settings2 → #extensions_block → #rm_extensions_block.drawer-content.closedDrawer  (display:none)
 *
 * display:none 的祖先把整棵子树的计算几何压成 0×0 —— 实测悬浮球
 * getBoundingClientRect() = {0,0,0,0}、offsetParent = null，也就是说
 * **用户不打开设置抽屉就永远看不见那颗球，而且控制台一声不响**。
 *
 * 而我们的界面形态是「**常驻悬浮球 + 浮层**」：它是页面级覆盖层，
 * 生命周期与设置抽屉无关（用户可能整局都不打开设置）。所以必须挂在 body 下。
 *
 * 顺带：挂在 body 也顺带解决了祖先 `display:flex` 的布局干扰 ——
 * 悬浮球不必再和抽屉里的兄弟节点抢 flex 空间。
 */
function mountTarget(): HTMLElement {
  // body 一定存在（ST 加载扩展时页面已就绪）；退一步用 documentElement 兜底
  return document.body ?? document.documentElement;
}

/**
 * 挂载界面。可重复调用（重复调用是 no-op）。
 *
 * ⚠️ 界面是**动态 import** 的，不是静态 import。
 * 理由：这是扩展，有静态服务器伺候 chunk，不再受「单文件酒馆脚本」的约束
 * （旧形态里 import() 出来的 chunk 永远 404，所以插件页只能静态引入 —— 那个妥协已经作废）。
 * 好处：底座初始化不用等整个 Vue 应用下载完；界面坏了也不影响宏 / 工具。
 */
async function mountUi(): Promise<void> {
  if (state.mounted) return;

  const target = mountTarget();

  // 自己建一个隔离的容器，不往宿主的 DOM 结构里插东西。
  // 挂在页面级（body）—— 理由见 mountTarget 的注释（抽屉 display:none 会把几何压成 0）。
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    target.appendChild(root);
  }

  state.mounted = true;
  try {
    const { mountApp } = await import('../苍玄助手/mount.ts');
    const dispose = mountApp(root);
    state.disposers.push(dispose);
    console.log('[苍玄界] 界面已挂载');
  } catch (error) {
    // 挂载失败要能回滚，否则下次 activate 会以为已经挂过了
    state.mounted = false;
    console.error('[苍玄界] 界面挂载失败', error);
  }
}

/** 卸载界面（disable / delete 时跑） */
function unmountUi(): void {
  while (state.disposers.length > 0) {
    const dispose = state.disposers.pop();
    try {
      dispose?.();
    } catch (error) {
      console.warn('[苍玄界] 清理回调抛错（已忽略，继续卸载）', error);
    }
  }
  document.getElementById(ROOT_ID)?.remove();
  state.mounted = false;
}

/* ============================ 生命周期钩子 ============================ */
/* 名字必须和 manifest.json 的 hooks 对得上，否则酒馆找不到函数（而且**不报错**）。 */

/** 扩展被加载 / 启用时调用（有 5 秒超时，别在这里做长活） */
export function onActivate(): void {
  init();
  // 界面挂载是异步的，但**不能 await**：5 秒超时是按同步返回算的，
  // 而且挂载失败不该让 activate 失败。
  void mountUi();
}

/** 用户点「启用」 */
export function onEnable(): void {
  init();
  void mountUi();
}

/** 用户点「禁用」：拆干净，别在宿主 DOM 里留残骸 */
export function onDisable(): void {
  unmountUi();
}

export function onInstall(): void {
  console.log('[苍玄界] 已安装');
}

export function onUpdate(): void {
  // 更新后模块会重新求值（换了 URL），这里主要是把「界面要重新挂」这件事记下来
  console.log('[苍玄界] 已更新');
}

export function onDelete(): void {
  unmountUi();
}

/* ============================ 顶层：只做幂等的注册 ============================ */
/*
 * 顶层代码在「扩展加载」时执行一次。这里**只放幂等、且不依赖 DOM** 的事：
 * 把宿主能力先挂上，这样即使 activate 因为超时没跑完，宏 / 工具也已经可用。
 * 界面挂载不在这里 —— DOM 可能还没有（#extensions_settings2 在酒馆页面里，晚于我们的脚本）。
 */
init();

// APP_READY 到了再兜底挂一次界面：activate 可能跑在 DOM 就绪之前。
const earlyCtx = getStContext();
if (earlyCtx?.eventSource && earlyCtx?.eventTypes?.APP_READY && !isStReady()) {
  earlyCtx.eventSource.on(earlyCtx.eventTypes.APP_READY, () => {
    init();
    void mountUi();
  });
}
