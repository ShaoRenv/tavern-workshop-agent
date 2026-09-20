// 苍玄助手 —— 可直接导入酒馆助手的脚本（自包含）。
// 本文件由 build_tavern_script.mjs 读取并内联构建产物，请勿手改；
// 要改界面请改 src/苍玄助手/ 下的源码，然后重新运行 pnpm build 与 pnpm build:script。
$(() => {
  const FRAME_HTML_BASE64 = '__FRAME_HTML_BASE64__';

  const STYLE_ID = 'cx-pw-style';
  const PANEL_ID = 'cx-pw-panel';
  const FRAME_ID = 'cx-pw-frame';
  const HEADER_ID = 'cx-pw-header';
  const RELOAD_ID = 'cx-pw-reload';
  const CLOSE_ID = 'cx-pw-close';
  const BODY_ID = 'cx-pw-body';
  const BAR_BUTTON_ID = 'cx-pw-bar-button';
  const FALLBACK_BAR_ID = 'cx-pw-bar';
  const PANEL_POSITION_KEY = 'cx-pw-panel-position';
  const OPEN_KEY = 'cx-pw-open-v2';

  const BUTTON_LABEL = '苍玄助手';
  const PANEL_TITLE = '苍玄助手';

  // 脚本以 iframe 形式运行，jQuery 作用于酒馆网页本身
  const hostWindow = window.parent && window.parent !== window ? window.parent : window;
  const hostDocument = hostWindow.document;

  /* ---------------- 清掉上一份实例留下的 DOM ---------------- */
  // 自动推送会重载脚本 iframe，但面板挂在酒馆网页上，脚本 iframe 被销毁带不走它。
  // 所以每次启动先把旧的清干净，否则会叠出第二个面板 / 第二个按钮。
  [STYLE_ID, PANEL_ID, BAR_BUTTON_ID, FALLBACK_BAR_ID].forEach(function (id) {
    const stale = hostDocument.getElementById(id);
    if (stale) stale.remove();
  });

  // 传给面板 iframe 的酒馆助手接口：面板 iframe 里拿不到这些全局函数，
  // 必须从脚本上下文桥接过去（与状态栏脚本同一做法）。
  //
  // 这份名单必须覆盖应用里所有走宿主桥的接口，且要和 tavern_script/frame.html 的 HOST_KEYS 对齐 ——
  // 少一个，那个函数在面板里就是 undefined，storage / worldbook / transport 会静默降级。
  // （2026-09 在真酒馆里实测：只桥了 8 个，结果世界书写入全废、脚本变量拿不到 script_id。）
  const HOST_API_NAMES = [
    'getVariables',
    'insertOrAssignVariables',
    'replaceVariables',
    'updateVariablesWith',
    'getScriptId',
    'getScriptTrees',
    'getWorldbookNames',
    'getGlobalWorldbookNames',
    'getCharWorldbookNames',
    'getChatWorldbookName',
    'getWorldbook',
    'replaceWorldbook',
    'createWorldbook',
    'deleteWorldbook',
    'createOrReplaceWorldbook',
    'generateRaw',
    'stopAllGeneration',
    'getModelList',
    'substitudeMacros',
  ];

  const HOST_API = {};
  const MISSING_API = [];
  HOST_API_NAMES.forEach(function (name) {
    let fn = null;
    try {
      fn = window[name];
    } catch (error) {
      fn = null;
    }
    // getScriptId 这类是脚本上下文里的全局函数，不在 TavernHelper 对象上，所以先取全局再退回对象
    if (typeof fn !== 'function' && window.TavernHelper && typeof window.TavernHelper[name] === 'function') {
      fn = function () { return window.TavernHelper[name].apply(window.TavernHelper, arguments); };
    }
    if (typeof fn === 'function') HOST_API[name] = fn;
    else MISSING_API.push(name);
  });

  if (MISSING_API.length > 0) {
    console.warn('[苍玄助手] 这些酒馆助手接口没桥上，相关功能会降级：' + MISSING_API.join('、'));
  }

  function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function readJson(key, fallback) {
    try {
      const raw = hostWindow.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      hostWindow.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* 写不进去就只是不记忆位置 */
    }
  }

  // 重复加载脚本时先清掉上一次的界面
  for (const id of [PANEL_ID, FALLBACK_BAR_ID, STYLE_ID, BAR_BUTTON_ID]) {
    const stale = hostDocument.getElementById(id);
    if (stale) stale.remove();
  }

  $(hostDocument.createElement('style'))
    .attr('id', STYLE_ID)
    .text(
      [
        // 面板：显式给超高 z-index，否则会被酒馆的下边栏等固定元素盖住
        '#' + PANEL_ID + '{position:fixed;z-index:2147483001;display:none;flex-direction:column;',
        'width:min(1120px,94vw);height:min(780px,86vh);border:1px solid rgba(167,139,250,.28);',
        'border-radius:12px;overflow:hidden;background:rgba(12,10,22,.98);',
        'box-shadow:0 12px 40px rgba(0,0,0,.6);}',
        '#' + PANEL_ID + ' *{box-sizing:border-box;}',
        '#' + HEADER_ID + '{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'padding:6px 10px;cursor:grab;user-select:none;background:rgba(139,92,246,.16);',
        'border-bottom:1px solid rgba(167,139,250,.18);color:#f4f2fb;font:12px/1.4 "Microsoft YaHei",sans-serif;}',
        '.cx-pw-actions{display:flex;gap:6px;}',
        '.cx-pw-actions button{cursor:pointer;border:1px solid rgba(167,139,250,.35);background:rgba(0,0,0,.25);',
        'color:#f4f2fb;border-radius:6px;padding:2px 8px;font-size:12px;}',
        '.cx-pw-actions button:hover{background:rgba(139,92,246,.35);}',
        '#' + FRAME_ID + '{flex:1;width:100%;border:0;background:transparent;display:block;}',
        // 下边栏按钮：套用酒馆自身的 .qr--button 样式，看起来就是原生按钮
        '#' + BAR_BUTTON_ID + '{white-space:nowrap;}',
        '#' + BAR_BUTTON_ID + '.cx-pw-active{border-color:rgb(167 139 250 / 75%);color:rgb(233 213 255);}',
        // 找不到快捷回复栏时的兜底按钮条
        '#' + FALLBACK_BAR_ID + '{display:flex;justify-content:center;gap:5px;width:100%;margin:3px 0;}',
        '#' + FALLBACK_BAR_ID + ' .cx-pw-fallback-button{color:var(--SmartThemeBodyColor,(#eee));',
        'border:1px solid var(--SmartThemeBorderColor,(#888));border-radius:10px;padding:3px 8px;',
        'margin:3px 0;cursor:pointer;font-size:12px;transition:background .2s;}',
        '#' + FALLBACK_BAR_ID + ' .cx-pw-fallback-button:hover{background:rgba(255,255,255,.12);}',
      ].join(''),
    )
    .appendTo(hostDocument.head);

  const $panel = $('<div>').attr('id', PANEL_ID);
  const $header = $('<div>').attr('id', HEADER_ID);
  $('<span>').text(PANEL_TITLE).appendTo($header);
  const $actions = $('<span>').addClass('cx-pw-actions');
  $('<button>').attr('id', RELOAD_ID).attr('title', '重新加载面板').text('⟳').appendTo($actions);
  $('<button>').attr('id', CLOSE_ID).attr('title', '关闭面板').text('✕').appendTo($actions);
  $actions.appendTo($header);
  $header.appendTo($panel);
  $('<div>').attr('id', BODY_ID).css({ flex: '1', display: 'flex', minHeight: '0' }).appendTo($panel);
  $panel.appendTo(hostDocument.body);

  const savedPanel = readJson(PANEL_POSITION_KEY, null);
  const panelPosition = savedPanel || {
    left: Math.max(12, Math.round((hostWindow.innerWidth - Math.min(1120, hostWindow.innerWidth * 0.94)) / 2)),
    top: Math.max(12, Math.round((hostWindow.innerHeight - Math.min(780, hostWindow.innerHeight * 0.86)) / 2)),
  };
  $panel.css({ left: panelPosition.left + 'px', top: panelPosition.top + 'px' });

  // 面板拖拽（按标题栏）
  (function makePanelDraggable() {
    const element = $panel[0];
    const handle = $header[0];
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener('pointerdown', event => {
      if (event.target && event.target.tagName === 'BUTTON') return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = panelPosition.left;
      originTop = panelPosition.top;
      handle.style.cursor = 'grabbing';
      event.preventDefault();
    });

    hostWindow.addEventListener('pointermove', event => {
      if (!dragging) return;
      panelPosition.left = Math.min(Math.max(0, originLeft + (event.clientX - startX)), Math.max(0, hostWindow.innerWidth - 80));
      panelPosition.top = Math.min(Math.max(0, originTop + (event.clientY - startY)), Math.max(0, hostWindow.innerHeight - 40));
      element.style.left = panelPosition.left + 'px';
      element.style.top = panelPosition.top + 'px';
    });

    hostWindow.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      writeJson(PANEL_POSITION_KEY, panelPosition);
    });
  })();

  /* ---------------- 下边栏按钮 ---------------- */

  let barButton = null;

  /** 在酒馆的快捷回复栏里放一个原生样式的按钮 */
  function ensureQrBarButton() {
    const bar = hostDocument.getElementById('qr--bar');
    if (!bar) return false;

    let holder = bar.querySelector(':scope > .qr--buttons');
    if (!holder) {
      holder = hostDocument.createElement('div');
      holder.className = 'qr--buttons';
      bar.appendChild(holder);
    }

    const existing = hostDocument.getElementById(BAR_BUTTON_ID);
    if (existing && existing.parentElement === holder) {
      barButton = existing;
      return true;
    }
    if (existing) existing.remove();

    const button = hostDocument.createElement('div');
    button.id = BAR_BUTTON_ID;
    button.className = 'qr--button';
    button.textContent = BUTTON_LABEL;
    button.title = '打开' + PANEL_TITLE;
    button.addEventListener('click', () => setOpen(!isOpen));
    holder.appendChild(button);
    barButton = button;
    return true;
  }

  /** 找不到快捷回复栏时的兜底：自己在输入框上方插一条按钮 */
  function ensureFallbackBarButton() {
    const sendForm = hostDocument.querySelector('#send_form');
    if (!sendForm) return false;

    let bar = hostDocument.getElementById(FALLBACK_BAR_ID);
    if (!bar) {
      bar = hostDocument.createElement('div');
      bar.id = FALLBACK_BAR_ID;
      if (sendForm.children.length > 0) sendForm.children[0].insertAdjacentElement('beforebegin', bar);
      else sendForm.appendChild(bar);
    }

    const existing = hostDocument.getElementById(BAR_BUTTON_ID);
    if (existing && existing.parentElement === bar) {
      barButton = existing;
      return true;
    }
    if (existing) existing.remove();

    const button = hostDocument.createElement('div');
    button.id = BAR_BUTTON_ID;
    button.className = 'cx-pw-fallback-button';
    button.textContent = BUTTON_LABEL;
    button.title = '打开' + PANEL_TITLE;
    button.addEventListener('click', () => setOpen(!isOpen));
    bar.appendChild(button);
    barButton = button;
    return true;
  }

  function ensureBarButton() {
    // 酒馆会在切换设置/重渲染时把快捷回复栏整个换掉，所以这里做成幂等的、可反复调用
    if (ensureQrBarButton()) return;
    ensureFallbackBarButton();
  }

  let ensureTimer = hostWindow.setInterval(ensureBarButton, 2000);
  ensureBarButton();

  /* ---------------- 面板与接口桥接 ---------------- */

  let bridgeTimer = null;
  let frameElement = null;

  function stopBridge() {
    if (bridgeTimer !== null) {
      hostWindow.clearTimeout(bridgeTimer);
      bridgeTimer = null;
    }
  }

  function attachHostApi() {
    if (!frameElement) return false;
    let frameWindow = null;
    try {
      frameWindow = frameElement.contentWindow;
    } catch (error) {
      return false;
    }
    if (!frameWindow) return false;
    try {
      frameWindow.__CX_HOST_API__ = HOST_API;
    } catch (error) {
      return false;
    }
    return frameWindow.__CX_HOST_READY__ === true;
  }

  function startBridge() {
    stopBridge();
    const deadline = Date.now() + 30000;
    const tick = () => {
      if (attachHostApi() || Date.now() > deadline) {
        stopBridge();
        return;
      }
      bridgeTimer = hostWindow.setTimeout(tick, 100);
    };
    attachHostApi();
    bridgeTimer = hostWindow.setTimeout(tick, 100);
  }

  function createFrame() {
    if (frameElement) return;
    frameElement = hostDocument.createElement('iframe');
    frameElement.id = FRAME_ID;
    frameElement.setAttribute('frameborder', '0');
    frameElement.setAttribute('allow', 'clipboard-write');
    frameElement.srcdoc = decodeBase64(FRAME_HTML_BASE64);
    const body = hostDocument.getElementById(BODY_ID);
    if (body) body.appendChild(frameElement);
    startBridge();
  }

  function reloadFrame() {
    if (!frameElement) {
      createFrame();
      return;
    }
    stopBridge();
    frameElement.srcdoc = decodeBase64(FRAME_HTML_BASE64);
    startBridge();
  }

  let isOpen = false;

  function setOpen(next) {
    isOpen = next;
    if (next) {
      createFrame();
      $panel.css('display', 'flex');
    } else {
      $panel.css('display', 'none');
    }
    if (barButton) {
      if (next) barButton.classList.add('cx-pw-active');
      else barButton.classList.remove('cx-pw-active');
    }
    writeJson(OPEN_KEY, next);
  }

  $panel.on('click', event => {
    if (event.target && event.target.id === CLOSE_ID) setOpen(false);
    if (event.target && event.target.id === RELOAD_ID) reloadFrame();
  });

  if (readJson(OPEN_KEY, false)) setOpen(true);

  function cleanup() {
    if (ensureTimer !== null) {
      hostWindow.clearInterval(ensureTimer);
      ensureTimer = null;
    }
    stopBridge();
    $panel.remove();
    for (const id of [FALLBACK_BAR_ID, STYLE_ID, BAR_BUTTON_ID]) {
      const element = hostDocument.getElementById(id);
      if (element) element.remove();
    }
  }

  $(window).on('pagehide', cleanup);

  console.info('[苍玄助手] 已就绪；按钮位于输入框上方（快捷回复栏内）');
});
