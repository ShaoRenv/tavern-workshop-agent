/**
 * 苍玄助手 · 前端界面入口
 *
 * 运行环境：酒馆助手脚本把 dist/苍玄助手/ 塞进 iframe 里跑，
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