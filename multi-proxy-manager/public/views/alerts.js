// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 告警中心（alerts）
   ----------------------------------------------------------------------------
   阶段 2.3b 第二片（2026-11-14）。为什么这一片可以抽：四个入口
   （loadAlertsPage / renderAlertList / filterAlerts / collectAlerts）只围绕
   一个接口簇（/api/alert、/api/alert/config、/api/alert/collect）和一个私有
   状态 alertEvents，不碰轮询、不碰 proxyStatus。唯一的跨视图耦合是
   **概览页的「告警数」徽章**读 alertEvents——通过 events() 暴露，不共享变量。

   依赖（必须先加载，见 dashboard.html head）：
     · mp-kernel.js  → MPKernel.esc / fetchJSON / showReadError / showToast / getToken
     · icons.js      → MPIcons.severity（严重度图标；缺了走内置圆点兜底）
     · MPShell       → 页面壳的加载条 / 离线横幅（dashboard.html 的 IIFE 里定义）
     · views/shadow.js 等 MPViews 兄弟模块与本文件互不依赖

   公开面：window.MPViews.alerts.{ load, events, filter, collect }
           另挂 window.filterAlerts / loadAlertsPage / collectAlerts
           —— HTML 内联 handler 在全局作用域找函数（见内联 handler 全局暴露段）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/alerts] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  var S = global.MPShell;
  if (!S) {
    // 壳没加载时告警页仍可渲染数据，但加载条会残着——宁可喊出来。
    console.error('[views/alerts] 缺少 MPShell：请确认 dashboard.html 定义了页面壳');
  }
  var esc = K.esc;

  // 本视图状态：当前已加载的告警事件。loadAlertsPage 写，filterAlerts / 概览徽章读。
  var alertEvents = [];

  // —— 页面壳薄包装：壳在就转发，壳不在就把问题喊出来而不是静默吞 ——
  function showLoading() {
    if (S && S.showLoading) return S.showLoading();
    console.error('[views/alerts] MPShell.showLoading 缺失');
  }
  function hideLoading() {
    if (S && S.hideLoading) return S.hideLoading();
    console.error('[views/alerts] MPShell.hideLoading 缺失');
  }
  function hideOfflineBanner() {
    if (S && S.hideOfflineBanner) return S.hideOfflineBanner();
    console.error('[views/alerts] MPShell.hideOfflineBanner 缺失');
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ===== 主加载：读失败分别标记，绝不把「API 挂了」渲染成「暂无告警」 =====
  async function load() {
    showLoading();

    // 告警页最忌「API 挂了 → 显示暂无告警」，那等于在真出事的时候告诉用户「没事」。
    // 两个请求各自判定，不互相顶包。
    var results = await Promise.all([
      K.fetchJSON('/api/alert').catch(function (e) { return { __readError: e }; }),
      K.fetchJSON('/api/alert/config').catch(function (e) { return { __readError: e }; }),
    ]);
    var alertResult = results[0] || {};
    var configResult = results[1] || {};
    var alertData = alertResult.__readError ? { events: [], count: 0 } : alertResult;
    var configData = configResult.__readError ? { gateOpen: false } : configResult;

    alertEvents = alertData.events || [];

    // 门控状态。两类「没读到」必须分开说：
    //   403 alert-gate-closed = **已知**的门控关闭（默认 off），显示「告警功能未开启」；
    //   其余读失败才是「读取失败」。把已知态渲染成读取失败，和把读取失败渲染成
    // 「暂无告警」是同一种误导——只是方向相反。
    var gateEl = document.getElementById('alertGateStatus');
    if (gateEl) {
      if (configResult.__readError) {
        var cerr = configResult.__readError;
        var gateClosed = cerr.httpStatus === 403 || (cerr.message || '').indexOf('alert-gate') !== -1;
        gateEl.innerHTML = '<span class="status-badge offline"><span class="dot"></span>' +
          (gateClosed ? '告警功能未开启' : '读取失败') + '</span>';
      } else {
        var gateClass = configData.gateOpen ? 'status-badge online' : 'status-badge offline';
        var gateText = configData.gateOpen ? '门控开启' : '门控关闭';
        gateEl.innerHTML = '<span class="' + gateClass + '"><span class="dot"></span>' + gateText + '</span>';
      }
    }

    // 概览统计卡
    var critical = alertEvents.filter(function (a) { return a.severity === 'critical'; }).length;
    var warning = alertEvents.filter(function (a) { return a.severity === 'warning'; }).length;
    var info = alertEvents.filter(function (a) { return a.severity === 'info'; }).length;
    setText('alertCriticalCount', critical);
    setText('alertWarningCount', warning);
    setText('alertInfoCount', info);
    setText('alertCountSubtitle', '共 ' + alertEvents.length + ' 条告警');

    // 列表。「暂无告警事件」只有在真读到空列表时才配说。
    if (alertResult.__readError) {
      var err = alertResult.__readError;
      // 403 alert-gate-closed 是默认态（PROXY_HEALTH_ALERT 默认 off），
      // 后端的 hint 就是「怎么开」——必须显示出来，否则用户只会看到机器码。
      var isGate = (err.httpStatus === 403 || (err.message || '').indexOf('alert-gate') !== -1);
      K.showReadError('alertList',
        isGate ? '告警功能未开启' : '读取失败',
        err.hint || err.message || '未知错误',
        isGate ? null : '告警数据读不到。管理端恢复后点「采集告警」或刷新本页。', load);
      setText('alertCountSubtitle', isGate ? '告警功能未开启' : '读取失败');
    } else {
      render(alertEvents);
    }
    hideOfflineBanner();
    hideLoading();
  }

  // ===== 列表渲染 =====
  function render(events) {
    var container = document.getElementById('alertList');
    if (!container) return;

    if (!events || events.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div><div class="empty-text">暂无告警事件</div></div>';
      return;
    }

    var sorted = events.slice().sort(function (a, b) {
      return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    });

    container.innerHTML = sorted.map(function (a) {
      var iconClass = a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info';
      // 严重度不用 🔴/🟡/🔵 emoji：跨平台渲染不一致，读屏器只会读出一串颜色名。
      // 等级同时由「形状 + 颜色 + 可读标签」三个通道传达，不靠颜色单通道。
      var sevLabel = { critical: '严重告警', warning: '警告', info: '提示' }[iconClass] || '提示';
      var icon = (global.MPIcons && global.MPIcons.severity)
        ? global.MPIcons.severity(a.severity)
        : '<svg class="icon-svg sev sev-' + iconClass + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/></svg>';
      var time = a.timestamp ? new Date(a.timestamp).toLocaleString('zh-CN') : '-';
      var title = a.rule || a.message || '告警';
      var message = a.message || a.detail || '';

      return '<div class="alert-item">' +
        '<div class="alert-icon ' + iconClass + '" role="img" aria-label="' + sevLabel + '">' + icon + '</div>' +
        '<div class="alert-content">' +
          '<div class="alert-title">' + esc(title) + '</div>' +
          '<div class="alert-message">' + esc(message) + '</div>' +
        '</div>' +
        '<div class="alert-time">' + esc(time) + '</div>' +
      '</div>';
    }).join('');
  }

  // ===== 搜索 / 筛选（HTML oninput/onchange 内联调用）=====
  function filter() {
    var search = (document.getElementById('alertSearch') || {}).value || '';
    var severity = (document.getElementById('alertSeverity') || {}).value || '';
    var source = (document.getElementById('alertSource') || {}).value || '';

    var filtered = alertEvents.filter(function (a) {
      if (severity && a.severity !== severity) return false;
      if (source && a.source !== source) return false;
      if (search) {
        var hay = (a.message + ' ' + a.rule + ' ' + a.providerId).toLowerCase();
        if (hay.indexOf(search.toLowerCase()) === -1) return false;
      }
      return true;
    });

    render(filtered);
  }

  // ===== 手动采集（写操作；HTML onclick 内联调用）=====
  function collect() {
    K.showToast('正在采集告警信号...', 'info');
    K.fetchJSON('/api/alert/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': K.getToken() || '' },
    }).then(function (data) {
      if (data.ok) {
        K.showToast('采集完成，新产生 ' + data.collected + ' 条告警', 'success');
        load();
      } else {
        // 无 else 时：后端返回 200 但 ok:false，用户点了按钮什么都不发生，
        // 只会反复点。采集类操作必须给出「采了但没结果」的原因。
        K.showToast(data.error || '采集未执行', 'error');
      }
    }).catch(function (err) {
      K.showToast('采集失败：' + ((err && err.message) || '未知错误'), 'error');
    });
  }

  global.MPViews = global.MPViews || {};
  global.MPViews.alerts = {
    load: load,
    filter: filter,
    collect: collect,
    // 概览页「告警数」徽章读这里。返回副本：外部改它不该影响本视图状态。
    events: function () { return alertEvents.slice(); },
  };

  // 内联 handler 的全局出口（本文件的三个 HTML 入口）。见 dashboard.html
  // 「内联 handler 的全局暴露」段与守卫 tests/node/panel-inline-handlers.test.js。
  global.filterAlerts = filter;
  global.loadAlertsPage = load;
  global.collectAlerts = collect;
})(typeof window !== 'undefined' ? window : globalThis);
