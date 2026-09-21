/**
 * 苍玄助手 · 前端界面入口（**旧形态：酒馆助手脚本 / 前端界面路径**）
 *
 * ⚠️ 现在真正被挂载的入口是 src/extension/index.ts → mount.ts（扩展路径，宿主是
 * #extensions_settings2 里的普通 div）。本文件是「酒馆助手脚本 + 前端界面」那条老路，
 * 这条路上我们的 HTML 会被酒馆助手塞进**它自己的面板 iframe** 里跑。
 *
 * 所以这里的注释（原来写「运行环境：酒馆助手脚本把 dist/苍玄助手/ 塞进 iframe 里跑」）
 * 只对老路成立；面板按「常驻 DOM、宿主视口 = 酒馆视口」来写样式，
 * 见 components/FloatingShell.vue 顶部那段说明。
 *
 * jQuery / Vue / pinia 由宿主提供全局，所以这里直接 window 上取。
 */
import './global.css';

import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';

type HostWindow = Window & {
  errorCatched?: <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => void;
  jQuery?: (fn: () => void) => void;
  $?: (fn: () => void) => void;
};

const w = window as HostWindow;

function mount(): void {
  const app = createApp(App).use(createPinia());
  app.mount('#app');
  window.addEventListener('pagehide', () => {
    app.unmount();
  });
}

function boot(): void {
  if (typeof w.errorCatched === 'function') {
    w.errorCatched(mount)();
  } else {
    mount();
  }
}

const ready = w.$ || w.jQuery;
if (typeof ready === 'function') {
  ready(boot);
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
