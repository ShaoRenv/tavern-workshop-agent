import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import './global.css';

$(() => {
  errorCatched(() => {
    const app = createApp(App).use(createPinia());
    app.mount('#app');

    $(window).on('pagehide', () => {
      app.unmount();
    });
  })();
});
