// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 路由预演（shadow）
   ----------------------------------------------------------------------------
   为什么单独一个文件（2026-11-14，阶段 2.3b 第一片）：dashboard.html 已经 3.4k 行，
   七个页内视图的取数 / 渲染全挤在同一个 IIFE 里，改一页要在一坨 2k 行代码里找位置。
   抽离顺序按「最自治的先抽」——shadow 只读一个接口、不写盘、不碰轮询、不被别的
   视图调用，是验证「一页一文件」这个形状最便宜的样本。验证成立再抽下一片。

   边界：
     · 只做本视图的取数与渲染。**HTML 骨架留在 dashboard.html**（静态结构跟页面
       在一起更好读，抽成 JS 字符串反而要拼 innerHTML、多一层转义风险，还会首屏空白）。
     · 不碰 switchPage / 轮询 / 移动端侧栏——那些是页面壳的事，不是这一页的事。
     · 依赖 `mp-kernel.js`（esc / getToken），必须在它之后加载。

   公开面：window.MPViews.shadow.load()
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    // 静默失败是这里最坏的结局：页面只会显示「策略：—」，看着像「没有数据」，
    // 而不是「脚本没加载对」。所以直接喊出来。
    console.error('[views/shadow] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  var esc = K.esc;

  // 鉴权头。2026-11-14 实查发现：这一页原来写的是 `getAuthHeader()`，而 **全站
  // 没有任何地方定义过这个函数**（面板统一用的是 `x-auth-token` 头）。于是 fetch
  // 每次都在抛 ReferenceError，被本函数的 try/catch 吞掉，UI 上只剩一行
  // 「加载失败：getAuthHeader is not defined」——接口本身 200、10 个能力标签全在。
  // 抽离时顺手改成真源头（MPKernel.getToken），并让 E2E 断言「必须出卡片」。
  function authHeaders() {
    return { 'x-auth-token': K.getToken() || '' };
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function showBanner(text, warn) {
    var alert = document.getElementById('shadowAlert');
    if (!alert) return;
    alert.style.display = 'block';
    alert.className = warn ? 'banner banner-warn' : 'banner';
    // 走 textContent：gaps 来自接口，不拼 innerHTML（避免引入转义链）。
    alert.textContent = text;
  }

  function hideBanner() {
    var alert = document.getElementById('shadowAlert');
    if (alert) alert.style.display = 'none';
  }

  function cardHtml(c) {
    var statusClass = c.noCandidate ? 'shadow-card-bad' : (c.rejected ? 'shadow-card-warn' : 'shadow-card-ok');
    var chosenTxt = c.chosen ? ('→ ' + c.chosen) : (c.noCandidate ? '无候选' : '—');
    var candTxt = (c.candidates || []).map(function (x) {
      return x.adapterId + (x.modelTier ? '(' + x.modelTier + ')' : '');
    }).join('、') || '—';
    return '<div class="shadow-card ' + statusClass + '">' +
      '<div class="shadow-card-type">' + esc(c.type) + '</div>' +
      '<div class="shadow-card-chosen">' + esc(chosenTxt) + '</div>' +
      '<div class="shadow-card-meta">档位 ' + esc(c.expectedTier || '—') + ' · 候选 ' + esc(candTxt) + '</div>' +
      '</div>';
  }

  async function load() {
    var grid = document.getElementById('shadowGrid');
    if (!grid) return;
    try {
      var res = await fetch('/api/l2/shadow-map', { headers: authHeaders() });
      var data = await res.json();

      // 三态必须分开：模块不可用 ≠ 读失败 ≠ 没有缺口。
      if (data.available === false) {
        showBanner('L2 模块当前不可用：' + (data.error || '未知'), false);
        return;
      }

      setText('shadowPolicy', '无候选策略：' + (data.policy || '—'));
      setText('shadowCapCount', '能力标签：' + (data.capabilityCount || 0));
      setText('shadowGapCount', '无候选缺口：' + (data.gapCount || 0));

      if (data.gapCount > 0) {
        // 容器已有 .banner-warn 承载视觉告警，文案里不再塞 ⚠（emoji 跨平台渲染不一致）。
        showBanner('存在无 adapter 承接的能力标签：' + (data.gaps || []).join(', ') +
          ' —— 切 reject 前必须先补 owner。', true);
      } else {
        hideBanner();
      }

      grid.innerHTML = (data.capabilities || []).map(cardHtml).join('');
    } catch (e) {
      // 这里刻意不写「暂无数据」：读不到和没有是两件事（unknown 态对账纪律）。
      showBanner('加载失败：' + ((e && e.message) || e), true);
    }
  }

  global.MPViews = global.MPViews || {};
  global.MPViews.shadow = { load: load };
})(typeof window !== 'undefined' ? window : globalThis);
