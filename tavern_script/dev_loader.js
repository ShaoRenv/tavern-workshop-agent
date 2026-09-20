// 苍玄助手 · 开发版（自动推送）
// 正文只做一件事：从开发服务器拉最新构建并运行。
// 候选地址按顺序试：局域网 IP（手机上的酒馆要用）→ 本机 127.0.0.1。
// 改了代码刷新酒馆就是新版本；开发服务器没起来也不会影响别的脚本。
const CX_DEV_BASES = ['http://__HOST__:__PORT__', 'http://127.0.0.1:__PORT__'];

function cxDevFetch(base) {
  var url = base + '/panel.js?t=' + Date.now();
  console.warn('[苍玄助手·开发版] import 失败，改用 fetch + new Function 再试：' + url);
  return fetch(url)
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then(function (code) {
      new Function(code)();
      console.info('[苍玄助手·开发版] fetch 方式成功，面板已启动（' + base + '）');
      return true;
    });
}

(async function cxDevLoad() {
  var lastError = null;
  for (var i = 0; i < CX_DEV_BASES.length; i++) {
    var base = CX_DEV_BASES[i];
    var url = base + '/panel.js?t=' + Date.now();
    console.info('[苍玄助手·开发版] 正在拉取 ' + url);
    try {
      await import(url);
      console.info('[苍玄助手·开发版] import 成功，面板已启动（' + base + '）');
      return;
    } catch (error) {
      lastError = error;
      console.warn('[苍玄助手·开发版] import 失败：' + base, error);
      try {
        var ok = await cxDevFetch(base);
        if (ok) return;
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }
  }
  console.error('[苍玄助手·开发版] 所有地址都失败了：', lastError);
  try {
    if (typeof toastr !== 'undefined' && toastr && toastr.error) {
      toastr.error('拉不到面板，已试过：' + CX_DEV_BASES.join(' / ') + '（先在项目目录运行 pnpm dev:port）', '苍玄助手');
    }
  } catch (ignore) {}
})();
