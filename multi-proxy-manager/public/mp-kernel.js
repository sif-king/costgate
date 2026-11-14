// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   multi-proxy · 面板共享薄内核
   ----------------------------------------------------------------------------
   存在的理由（2026-11-14）：面板拆改时发现 esc / showToast / showReadError /
   fetchJSON 这几样被 6~8 个页面各抄了一份。抄本身不是罪，问题在于它们**会分叉**：
   同一件事（怎么转义、读失败怎么显示）在不同页面写着不同答案，用户看到的就是
   同一套面板自相矛盾。所以先抽一层「谁都在用、谁也不该各写一份」的助手。

   边界（别让这层长胖）：
     · 只放跨页共用的**机制**，不放任何一页的业务：不碰 PROXY_CONFIGS、不碰
       页面状态、不碰任何 /api 语义。业务留在各页自己的 IIFE 里。
     · 这里没有 DOM 结构假设，除了 showReadError 会往指定容器里塞一块告警块，
       这是它全部的存在意义。
     · 单独 load 一层只为消除漂移；不要因为它在这儿就把页面逻辑上移。

   公开面（window.MPKernel）：
     esc(s)                                        HTML 转义（文本 + 属性双安全）
     fetchJSON(url, opts)                          fetch + 非 2xx 抛错 + 带出 body.hint
     showReadError(id, title, detail, hint, retry) 读失败块（三态里的 error 态）
     getToken()                                    读 auth_token（读入口收这一处）

   注意：showToast **故意不收进来**。它不是重复实现那么简单——dashboard / logs /
   proxy-config 用的是「右上角、带图标、.toast.<type>」，而 knowledge / sessions /
   skills 用的是「右下角、纯色底、.toast-<type>」，两套视觉各有各的本地 CSS 撑着。
   合并等于改三个页面的观感，那是一次视觉决定的活，不该混在去重里偷偷做。
   同理 showReadError 暂只覆盖 dashboard（empty-state 族、带图标）；proxy-config
   那份是内联 padding 块、无图标，合并会改观感，留待视觉统一时一起做。

   还有一类「看起来也该合并」但**不能**合并的：nav.js / states.js / gatebar.js 里的
   私有 esc。它们是能被单独加载的独立模块（login.html / consent.html / legal.html
   只引 nav.js，不引本文件），一旦依赖本文件就多了一条「必须先加载 mp-kernel」的
   隐形前置。模块自足优先于去重。
   ========================================================================== */
(function (global) {
  'use strict';

  // 单遍替换表。为什么不走「createElement + textContent + innerHTML」那条老路：
  // 它依赖一个游离 div 的 innerHTML 序列化结果（且要再手动补引号），既慢又要靠
  // 浏览器行为背书；一条正则表就够，且不碰 DOM，node 里也能直接测。
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  // 读失败统一呈现：不猜、不装、不静默。
  // 面板过去的兜底只有两种，且都比报错更糟——① 喂 mock 假数据（pid 12345、
  // uptime「2h34m」），故障被伪装成正常；② 兜底成空数组，「暂无」和「读不到」
  // 长得一模一样。两者都违反 unknown 态对账纪律。三种空必须分开：
  // 真的空 / 没开功能 / 读失败。
  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = (body && body.error) ? body.error : ('HTTP ' + res.status);
          var e = new Error(msg); e.httpStatus = res.status;
          // 后端常在 body.hint 里给「怎么修」（如 alert-gate-closed 的
          // 「PROXY_HEALTH_ALERT 未开启，开灰度：PROXY_HEALTH_ALERT=1 node server.js」）。
          // 丢掉 hint 只显示机器码，等于把后端已经写好的解决方案扔了。
          if (body && body.hint) e.hint = body.hint;
          throw e;
        }, function () {
          var e = new Error('HTTP ' + res.status); e.httpStatus = res.status; throw e;
        });
      }
      return res.json();
    });
  }

  // 读失败块：视觉与 empty-state 同族（不引入新样式体系），但语义是「读不到」而非
  // 「没有」。四参分工：title 主文案／detail 后端给的错误原因（优先显示）／hint
  // 排查提示／retryFn 点击「重试」时重跑对应的读取函数。
  // 2026-10-24：此前这里只派发 retry-read CustomEvent 却全文件无监听者 → 死按钮。
  // 改为直接 addEventListener 绑定 retryFn，点击即重跑，不依赖虚无的事件链路。
  // 注意 detail / hint 是**有意**拼进 innerHTML 的（后端 human 文本允许换行），
  // 所以调用方必须自己 esc 过其中的变量部分；title 这里已代为转义。
  function showReadError(containerId, title, detail, hint, retryFn) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var body = [detail, hint].filter(Boolean).join('<br>') || '未知错误';
    el.innerHTML =
      '<div class="empty-state" role="alert" style="grid-column:1/-1;">' +
        '<div class="empty-icon" style="color:#d97706;">' +
          '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '</div>' +
        '<div class="empty-text" style="color:#d97706;">' + esc(title || '读取失败') + '</div>' +
        '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:6px;max-width:460px;line-height:1.6;">' +
          body +
        '</div>' +
        (typeof retryFn === 'function'
          ? '<button class="btn btn-outline btn-sm mp-retry-btn" type="button" style="margin-top:10px;">重试</button>'
          : '') +
      '</div>';
    if (typeof retryFn === 'function') {
      var btn = el.querySelector('.mp-retry-btn');
      if (btn) {
        btn.addEventListener('click', function () {
          el.innerHTML = '';
          retryFn();
        });
      }
    }
  }

  // 每次现读，不缓存：登录/登出会在同一页里改这个值，缓存一份就等于让页面
  // 拿着一枚过期令牌去请求，然后把它显示成「读取失败」。
  // 边界（别把它当"令牌已收口"）：本函数只管**读**。各页登出时的
  // `sessionStorage.removeItem('auth_token')` 与 settings / gatebar 的
  // localStorage 兜底都还在原处——令牌的存取策略要跟登出、迁移一起定，
  // 不该在一次去重里顺手改掉鉴权行为。
  function getToken() {
    try { return sessionStorage.getItem('auth_token'); } catch (e) { return null; }
  }

  global.MPKernel = {
    esc: esc,
    fetchJSON: fetchJSON,
    showReadError: showReadError,
    getToken: getToken
  };
})(typeof window !== 'undefined' ? window : globalThis);
