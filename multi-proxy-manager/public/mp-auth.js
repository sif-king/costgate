// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   面板通用鉴权层（MPAuth）
   ----------------------------------------------------------------------------
   2026-11-15 壳第四片从 mp-shell.js 里再剥一层出来。

   为什么要剥：上一片把鉴权收进 mp-shell.js 时，它只服务 dashboard 一个页面。
   但「请求怎么带凭证」是**9 个页面共同的问题**，实测有 4 种答案：
     · dashboard / knowledge / logs / skills：各抄一份全局 fetch 改写（4 份副本）；
     · proxy-config：只抄了 401 跳转那半，token 靠 3 处手写 header；
     · sessions / settings：只手写 header，**没有 401 跳转**——会话过期时页面一直
       显示「读取失败」，用户点「重试」点到天荒地老也不知道自己已经掉线；
     · floor：走 /api/floor（该路由不鉴权），不需要令牌层。

   把鉴权留在 mp-shell.js 里会有个副作用：哪个页面想用鉴权，就得连 dashboard 的
   加载条 / 离线横幅 / apiKey 横幅一起引进来——那是把 dashboard 的 DOM 假设
   投影到 8 个别的页面上。所以分层：
     · mp-auth.js   ← 本文件：探登录态 / 登录墙 / 全局 fetch 注入 + 401 跳转
     · mp-shell.js  ← dashboard 专属壳：加载条 / 离线横幅 / apiKey 横幅
   mp-auth.js 只依赖 mp-kernel.js（取 token），不依赖任何页面 DOM 结构。

   加载顺序：mp-kernel.js 之后、页面首个内联 <script> 之前。本文件**加载即安装**
   拦截器——比「页面 init 时再装」早，覆盖 head 里所有取数脚本。

   边界（别让它长胖）：
     · 只管「凭证怎么进请求」和「401 之后去哪」，不碰任何业务接口语义；
     · 不引入 dashboard 的 DOM：登录墙容器按 id/main 两级兜底，找不到就不画；
     · token 一律现读 MPKernel.getToken()，本文件不缓存、不写 token
       （登出清 token 仍由各页自己的 handleLogout 负责，两件事别混）。
   ========================================================================== */
(function (global) {
  'use strict';

  var LOGIN_PAGE = 'login.html';
  var TOKEN_HEADER = 'x-auth-token';

  // 每次现读，不缓存：登录 / 登出会在同一页里改这个值。缓存一份就等于让页面拿着
  // 过期令牌去请求，然后把 401 显示成「读取失败」——把「掉线」伪装成「没数据」。
  function currentToken() {
    try {
      if (global.MPKernel && typeof global.MPKernel.getToken === 'function') {
        return global.MPKernel.getToken() || '';
      }
    } catch (e) { /* 取不到就当未登录 */ }
    return '';
  }

  // 登录墙的落点。dashboard / knowledge / logs / sessions / skills 都有 #mainContent；
  // proxy-config / settings / floor 没有——那几页目前不调 checkAuth，走不到这里。
  // 兜底到 <main> 而不是 document.body：body 里还有侧栏、横幅、toast 容器，
  // 整页覆盖等于把「需要登录」演成白屏。
  function resolveWallHost() {
    return document.getElementById('mainContent') || document.querySelector('main') || null;
  }

  function showLoginRequired() {
    var host = resolveWallHost();
    // 容器缺失是结构错误，不在这里清空 body 兜底（那会把页面壳一起打掉，
    // 用户看到白屏却不知道原因）。返回 false 让调用方自己决定要不要重试。
    if (!host) return false;
    host.innerHTML =
      '<div class="login-required-container">' +
        '<div class="login-required-card">' +
          '<div class="login-required-icon"><svg class="icon-svg" style="width:36px;height:36px;" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
          '<h2 class="login-required-title">需要登录</h2>' +
          '<p class="login-required-desc">请先配置认证密码后访问管理面板</p>' +
          '<a href="login.html" class="btn btn-primary" style="text-decoration:none;display:inline-block;">去设置密码</a>' +
        '</div>' +
      '</div>';
    return true;
  }

  function revealOfflineBanner() {
    var el = document.getElementById('offlineBanner');
    if (el) el.classList.remove('hidden');
  }

  // 探一次登录态。三条出口刻意保留原文案与语义：
  //   · 需要初始化且本地无 token → 画登录墙，返回 false（后续取数全部跳过）；
  //   · 探测本身失败（后端没起 / 500 且响应体不是 JSON）→ 亮离线横幅但**放行**，
  //     此时该显示的是「连不上」，不是「需要登录」；
  //   · 其余 → 放行。
  // res.ok 在这里不判：/api/auth/status 失败时 res.json() 自己会抛，落进同一个
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
        revealOfflineBanner();
        return true;
      });
  }

  // 全局 fetch 改写：装一次，装过的打标记，重复调用直接返回。
  // 标记挂在**包装函数本身**而不是模块变量上：同一个页面里如果本文件被引两次，
  // 模块 IIFE 会跑两遍，只有函数上的标记跨得过这两次。
  //
  // 401 跳转**排除** /api/auth/* —— 否则「输错密码」会被自己的拦截器当成会话过期，
  // 在登录页上无限跳回自己。这条豁免也是 login.html 不该引本文件的第二道保险。
  //
  // opts.redirectOn401 === false 时只注入 token、不跳转：留给「跳走会丢掉当前操作」
  // 的页面（目前没有页面用到，但出口在这，不要靠改代码来换行为）。
  function installFetchAuth(opts) {
    if (typeof global.fetch !== 'function') return null;
    if (global.fetch.__mpAuthInstalled) return global.fetch;
    var redirectOn401 = !(opts && opts.redirectOn401 === false);
    var orig = global.fetch;

    var wrapped = function (url, options) {
      if (options === undefined) options = {};
      var isApi = typeof url === 'string' && url.indexOf('/api/') === 0;
      var tok = isApi ? currentToken() : '';
      if (isApi && tok) {
        if (!options.headers) options.headers = {};
        if (typeof options.headers === 'object') {
          options.headers[TOKEN_HEADER] = tok;
        }
      }
      var p = orig(url, options);
      if (isApi && redirectOn401 && url.indexOf('/api/auth/') !== 0) {
        p.then(function (res) {
          if (res.status === 401) {
            try { sessionStorage.removeItem('auth_token'); } catch (e) { /* 隐私模式 */ }
            global.location.href = LOGIN_PAGE;
          }
        }).catch(function () {});
      }
      return p;
    };
    wrapped.__mpAuthInstalled = true;
    global.fetch = wrapped;
    return wrapped;
  }

  // 加载即安装：本文件在 head 里、早于页面首个内联脚本，覆盖率是严格超集。
  installFetchAuth();

  global.MPAuth = {
    currentToken: currentToken,
    showLoginRequired: showLoginRequired,
    checkAuth: checkAuth,
    installFetchAuth: installFetchAuth,
  };
})(typeof window !== 'undefined' ? window : globalThis);
