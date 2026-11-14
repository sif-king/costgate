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

  global.MPShell = {
    showLoading: function () { addClass('loadingBar', 'active'); },
    hideLoading: function () { removeClass('loadingBar', 'active'); },
    showOfflineBanner: function () { removeClass('offlineBanner', 'hidden'); },
    hideOfflineBanner: function () { addClass('offlineBanner', 'hidden'); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
