/**
 * 酒馆工坊Agent · 挂载接缝（应用侧）```
 *
 * 扩展外壳（src/extension/index.ts）通过**动态 import** 调这里的 mountApp，
 * 拿到一个 dispose 回调。这样做的意义：
 *  - 外壳不认识 Vue / pinia，也不知道面板怎么建 —— 它只管「挂 / 卸」
 *  - 应用不认识扩展 / 酒馆 —— 它只管「给我一个 DOM 容器，我画进去」
 *  两边任何一边坏掉都不会连坐（界面挂了，宏与工具照常）。
 *
 * ⚠️ 这里**不再等待 jQuery ready / errorCatched**：
 * 那是「酒馆助手脚本跑在 iframe 里」时代的开场白，扩展里没有那套东西。
 * 扩展外壳自己决定挂载时机（activate / APP_READY），到这时 DOM 一定是好的。
 */
import './global.css';

import { createPinia } from 'pinia';
import { createApp, type App as VueApp } from 'vue';

import App from './App.vue';

/** 同一时刻只允许一个实例（扩展模块是单例，但这层自己兜住，别指望外面） */
let active: VueApp | null = null;

/**
 * 把面板画进指定容器。
 *
 * @param container 外壳建好的 DOM 容器（已 append 到酒馆页面）
 * @returns dispose —— 卸载应用并清掉容器里的东西；**必须可重复调用**
 */
export function mountApp(container: HTMLElement): () => void {
  // 之前挂过就先拆：扩展的 enable/disable 可能来回切，别叠两层
  if (active) {
    active.unmount();
    active = null;
  }

  const app = createApp(App).use(createPinia());
  app.mount(container);
  active = app;

  return () => {
    if (active === app) active = null;
    app.unmount();
  };
}
