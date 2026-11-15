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

   已迁出（2026-11-15 壳第四片）：鉴权三件套 → mp-auth.js。
   理由：鉴权是 9 个页面共同的问题，让它住在 dashboard 专属壳里，别的页面想用就得
   连加载条 / 离线横幅 / apiKey 横幅一起引进来，等于把 dashboard 的 DOM 假设投影到
   8 个别的页面上。本文件因此**不再**包含任何 /api 语义——它只认 DOM。
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

  // 鉴权真实现已迁到 mp-auth.js（2026-11-15 壳第四片）。本文件只管 dashboard 专属的
  // 加载条 / 离线横幅 / apiKey 横幅，不认任何 /api 语义。
  // 页面侧 checkAuth / showLoginRequired 两个薄包装现在指向 window.MPAuth。

  global.MPShell = {
    showLoading: function () { addClass('loadingBar', 'active'); },
    hideLoading: function () { removeClass('loadingBar', 'active'); },
    showOfflineBanner: function () { removeClass('offlineBanner', 'hidden'); },
    hideOfflineBanner: function () { addClass('offlineBanner', 'hidden'); },
    showApiKeyBanner: showApiKeyBanner,
    hideApiKeyBanner: hideApiKeyBanner,
    isApiKeyBannerDismissed: isApiKeyBannerDismissed,
    dismissApiKeyBanner: dismissApiKeyBanner,
  };
})(typeof window !== 'undefined' ? window : globalThis);
