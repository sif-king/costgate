// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 页面壳机制（MPShell）
   ----------------------------------------------------------------------------
   2026-11-15 从 dashboard.html 的 IIFE 里抽出来，放到 <head> 里**先于所有
   views/*.js** 加载。

   为什么必须搬：views/alerts.js 在 head 里执行 `var S = global.MPShell;`，
   而原来的 MPShell 是在 dashboard.html 的 IIFE **末尾（约 3108 行）**才挂上去的。
   模块加载那一刻它永远是 undefined ⇒ 告警页的 showLoading / hideLoading /
   hideOfflineBanner 三处全部走 console.error 分支，加载条不会亮、离线横幅不会收。
   这是「看着接好了、其实没接」：不报错、不白屏、页面照常出数据，只是壳机制静默失效。

   抽出来之后：
     · MPShell 在 head 就位，任何 views/*.js 加载时都能拿到；
     · dashboard.html 保留同名**薄包装**（函数声明会 hoist，页面里在定义之前
       调用的地方照旧可用），调用点一行不改；
     · 单一定义：壳机制只有这一份，视图模块只调用不复制。

   加载顺序要求：mp-kernel.js 之后、views/*.js 之前；必须早于页面首个内联
   <script>（2.3a 踩过「MPKernel is not defined」的同一个坑）。

   当前职责（页面只留同名薄包装，调用点零改动）：
     · 加载条 / 离线横幅
     · apiKey 横幅（含 24h 关闭记忆）      ← 壳第二片
     · 鉴权三件套（探登录态 / 登录墙 / 全局 fetch 注入 token + 401 跳转）← 壳第三片
   ========================================================================== */
(function (global) {
  'use strict';

  function addClass(id, cls) {
    var el = document.getElementById(id);
    if (el) el.classList.add(cls);
  }
  function removeClass(id, cls) {
    var el = document.getElementById(id);
    if (el) el.classList.remove(cls);
  }

  // ── API Key 横幅（2026-11-15 壳第二片收口）────────────────────────
  // 真实现搬进壳，dashboard.html 只留同名薄包装。为什么值得收：这批函数是
  // 「横幅该不该出现」的唯一判据（24 小时内的关闭记忆），页面 init() 要读它、
  // 内联 onclick 要调它。留在页面 IIFE 里，等于壳的横幅机制被切成两半——
  // 一半（offline）在 mp-shell.js、一半（apiKey）在页面，早晚对不上。
  var API_KEY_DISMISSED_KEY = 'apiKeyBannerDismissed';
  var API_KEY_DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 关闭后 24h 内不再弹

  function showApiKeyBanner() { removeClass('apiKeyBanner', 'hidden'); }
  function hideApiKeyBanner() { addClass('apiKeyBanner', 'hidden'); }
  function isApiKeyBannerDismissed() {
    try {
      var ts = localStorage.getItem(API_KEY_DISMISSED_KEY);
      if (ts === null) return false;
      return (Date.now() - parseInt(ts, 10)) < API_KEY_DISMISS_TTL_MS;
    } catch (e) { return false; }
  }
  function dismissApiKeyBanner() {
    hideApiKeyBanner();
    try { localStorage.setItem(API_KEY_DISMISSED_KEY, String(Date.now())); } catch (e) {}
  }

  // ── 鉴权（2026-11-15 壳第三片收口）─────────────────────────────────
  // 三件事原先整段住在 dashboard.html 的 IIFE 里：① 探 /api/auth/status 决定要不要
  // 拦一道登录墙；② 那道墙的 DOM；③ **改写全局 fetch**——自动注入 x-auth-token，
  // 并在非 /api/auth/* 的 401 上清 token 跳登录页。
  //
  // 为什么必须进壳：③ 是「所有接口请求的必经之路」，却由某个页面私下改写 window.fetch。
  // 面板里 9 个页面各有各的写法（logs/knowledge/skills 各抄一份拦截器，settings 漏了
  // token），任何一个新页面照抄 dashboard 都会漏掉这段隐含前置。放在壳里之后，
  // 「请求怎么带上凭证」只有一个答案。
  //
  // token 一律**现读** MPKernel.getToken()，不接页面那份 `var authToken = ...` 快照。
  // 快照在今天等价（全文只读不写），但它是「页面持一份状态」的最后一个样本：
  // 一旦有人给 token 加了刷新，快照就是过期值。读入口收在 kernel 一处。
  function currentToken() {
    try {
      if (global.MPKernel && typeof global.MPKernel.getToken === 'function') {
        return global.MPKernel.getToken() || '';
      }
    } catch (e) { /* 取不到就当未登录 */ }
    return '';
  }

  function showLoginRequired() {
    var main = document.getElementById('mainContent');
    if (!main) return;
    main.innerHTML =
      '<div class="login-required-container">' +
        '<div class="login-required-card">' +
          '<div class="login-required-icon"><svg class="icon-svg" style="width:36px;height:36px;" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
          '<h2 class="login-required-title">需要登录</h2>' +
          '<p class="login-required-desc">请先配置认证密码后访问管理面板</p>' +
          '<a href="login.html" class="btn btn-primary" style="text-decoration:none;display:inline-block;">去设置密码</a>' +
        '</div>' +
      '</div>';
  }

  // 探一次登录态。三条出口都刻意保留原文案与语义：
  //   · 需要初始化且本地无 token → 画登录墙，返回 false（后续取数全部跳过）；
  //   · 探测本身失败（后端没起 / 500 且响应体不是 JSON）→ 亮离线横幅但**放行**，
  //     此时面板该显示的是「连不上」，不是「需要登录」；
  //   · 其余 → 放行。
  // 注意 res.ok 在这里不判：/api/auth/status 失败时 res.json() 自己会抛，落进同一个
  // catch，与「判了 ok 再抛」等价，但少一处要维护的分支。
  function checkAuth() {
    return global.fetch('/api/auth/status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.needsSetup && !currentToken()) {
          showLoginRequired();
          return false;
        }
        return true;
      })
      .catch(function () {
        removeClass('offlineBanner', 'hidden');
        return true;
      });
  }

  // 全局 fetch 改写：装一次，装过的打标记，重复调用直接返回（各页都引壳也不会叠两层）。
  // 401 跳转**排除** /api/auth/* —— 否则「输错密码」会被自己的拦截器当成会话过期，
  // 在登录页上无限跳回自己。
  function installFetchAuth() {
    if (typeof global.fetch !== 'function') return;
    if (global.fetch.__mpAuthInstalled) return;
    var orig = global.fetch;
    var wrapped = function (url, options) {
      if (options === undefined) options = {};
      var isApi = typeof url === 'string' && url.indexOf('/api/') === 0;
      var tok = isApi ? currentToken() : '';
      if (isApi && tok) {
        if (!options.headers) options.headers = {};
        if (typeof options.headers === 'object') {
          options.headers['x-auth-token'] = tok;
        }
      }
      var p = orig(url, options);
      if (isApi && url.indexOf('/api/auth/') !== 0) {
        p.then(function (res) {
          if (res.status === 401) {
            sessionStorage.removeItem('auth_token');
            window.location.href = 'login.html';
          }
        }).catch(function () {});
      }
      return p;
    };
    wrapped.__mpAuthInstalled = true;
    global.fetch = wrapped;
  }
  installFetchAuth();

  global.MPShell = {
    showLoading: function () { addClass('loadingBar', 'active'); },
    hideLoading: function () { removeClass('loadingBar', 'active'); },
    showOfflineBanner: function () { removeClass('offlineBanner', 'hidden'); },
    hideOfflineBanner: function () { addClass('offlineBanner', 'hidden'); },
    showApiKeyBanner: showApiKeyBanner,
    hideApiKeyBanner: hideApiKeyBanner,
    isApiKeyBannerDismissed: isApiKeyBannerDismissed,
    dismissApiKeyBanner: dismissApiKeyBanner,
    showLoginRequired: showLoginRequired,
    checkAuth: checkAuth,
    installFetchAuth: installFetchAuth,
  };
})(typeof window !== 'undefined' ? window : globalThis);
