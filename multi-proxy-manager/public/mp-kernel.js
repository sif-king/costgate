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
     showToast(message, type, duration)            轻提示（全站一套观感）
     getToken()                                    读 auth_token（读入口收这一处）

   showToast 的来历（2026-11-14 老板拍板「视觉合成一套」前，它是被**拒绝**收进来的）：
   当时面板里同时活着三套——
     A. dashboard / logs / proxy-config：右上角、白底、左色条、带图标、`.toast.<type>`
     B. knowledge / sessions / skills：右下角、纯色底白字、无图标、`.toast-<type>`
     C. settings：右上角、`.toast--info`（这个类 CSS 里根本没定义，等于没样式）
   合并等于改观感，所以当初只登记不合并。老板拍板后统一到 A 这一套：它是
   components.css（设计系统新层）的形态，也是三页已经在用的形态；B 的纯色底
   与 C 的空类名是旧写法，按「新层为准」收口。
   视觉统一必须落在 CSS 层一次做完：本函数只负责 DOM 结构与类名（`.toast <type>`），
   位置 / 配色 / 图标尺寸全由 components.css 决定，页面不许再写自己的 .toast 样式。

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

  // 轻提示：全站唯一实现。观感由 components.css 的 `.toast` 决定（右上角、白底、
  // 左色条、带图标），本函数只产出结构，不写样式——页面也**不许**再写自己的 .toast CSS，
  // 否则又是「同一套面板两种长相」。
  //
  // 三类空必须分清的老规矩在提示语上同样成立：调用方别把「读失败」写成「暂无数据」。
  // 图标用内联 SVG（与 icons.js 同风格），不引外部图标字体——面板零网络依赖。
  var TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  // 堆叠上限：右上角浮层是覆盖式的，条数不限就会一路往下长。dashboard 的
  // 能力门控条（含「展开全部」按钮）就在 y≈122 处，第 3 条 toast 的底边就能
  // 压到它上面（实测 1440×900：单条 16→80 不重叠，3 条 16→224 重叠）。
  // 结论是**不给全站顶部留永久安全区**（那是为 3 秒浮层让 9 个页面集体空一条），
  // 而是把最长遮挡封在 3 条高度内：容器 pointer-events:none + 单条 auto 保证
  // 被盖住也点得到（实测 elementFromPoint 命中的仍是那个按钮）。
  // 超出时直接摘最旧的、不播淡出：它正被新内容替代，动画只会让右上角同时晃。
  var MAX_TOASTS = 3;

  // type 白名单：传了别的值一律当 info。过去 proxy-config 直接把 type 拼进 className，
  // 一个手滑的 'error ' 之类就会造出没有样式的类名（settings 的 `.toast--info` 就是这么来的：
  // 类名写上了，CSS 里从没定义，等于没样式还没人发现）。
  function showToast(message, type, duration) {
    var kind = (type === 'success' || type === 'error' || type === 'warning') ? type : 'info';
    var ms = (typeof duration === 'number' && duration > 0) ? duration : 3000;
    // 容器兼容两种历史 id：toastContainer（6 页）/ toasts（settings）。收口后应统一成前者，
    // 这里留兼容是为了「先改 CSS 再改 HTML」也不会出现提示消失的中间态。
    var host = document.getElementById('toastContainer') || document.getElementById('toasts');
    if (!host) return;

    var el = document.createElement('div');
    el.className = 'toast ' + kind;
    // role=status + aria-live：读屏用户也该听到「保存成功」「读取失败」，
    // 而不是只有视觉用户知道发生了什么。
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = TOAST_ICONS[kind];

    var msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;   // 文本节点，不拼 HTML：提示内容常含后端错误串

    el.appendChild(icon);
    el.appendChild(msg);
    host.appendChild(el);

    // 顺序不能反过来：先挂新的再挤旧的，否则一次连发两条会出现「刚挂上就被当成
    // 最旧的那条摘掉」的闪烁。
    while (host.children.length > MAX_TOASTS) {
      var oldest = host.children[0];
      if (!oldest || oldest.parentNode !== host) break;
      host.removeChild(oldest);
    }

    setTimeout(function () {
      el.style.animation = 'toast-out 0.3s ease forwards';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, ms);
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
    showToast: showToast,
    getToken: getToken
  };
})(typeof window !== 'undefined' ? window : globalThis);
