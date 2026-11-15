// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 运行中任务（sessions 卡，2.3b 第九片，2026-11-15）
   ----------------------------------------------------------------------------
   这张卡在概览页（#page-dashboard）上，标题「运行中任务」，数据只来自
   GET /api/sessions/running。它比前几片多一样东西：**写操作**（中止）。
   所以抽它不只是搬取数，还要把「点了到底发生了什么都说得出来」一起搬干净。

   为什么能抽（自治片判据）：一个接口、一个容器（#sessionsList）、无共享状态，
   既有读失败用例（panel-read-failure 「sessions 页：读失败 → 显示读取失败」）
   也只经页面的 loadSessions 薄包装。

   三条口径（都是被真 bug 换来的，别在搬的时候丢掉）：
     ① 读失败 ≠ 没有任务。过去 catch 里什么都不做（静默吞掉），API 一挂列表停在
        旧内容，用户以为「没有任务在跑」——而真相可能是三个任务在跑但没显示出来。
        中止一个你看不见的任务，比没有中止按钮更危险。
     ② 读失败提示必须写进**可见容器**。#sessionsList 就是可见的那个；2026-11-14
        之前提示写进 sessionsListFull（所在 page-sessions 是无入口死容器，已删），
        于是「读失败」谁也看不见，可见的卡只剩「暂无运行中任务」。
     ③ 中止必须有回执。后端 200 但 ok:false 时必须有错误提示，否则用户以为中止成功
        关掉页面，任务继续跑——最坏的一种「无反馈」。成功才刷新列表。

   两个「不编数」的细节（同族：uptime 把 epoch 秒渲染成 20772d）：
     · createdAt 缺失/不是日期 ⇒ 年龄留「—」，不渲染 "NaNs"。
     · 状态文案只认后端真有的四种（running/done/failed/aborted），其余原样出状态串，
       不给一个编出来的「待处理」。注：/api/sessions/running 只会返回 running，
       这张表实际只走 running 一支，其余是「后端将来放宽时别撒谎」的兜底。

   依赖（见 dashboard.html head 与 coherence 第 7 项）：
     · mp-kernel.js → MPKernel.fetchJSON / esc / showReadError / showToast / getToken
   不依赖 MPShared / MPShell（这张卡没有共享渲染件，也不用整页加载条）。

   公开面：window.MPViews.sessions.{ load, abort }
           另挂 window.abortSessionFromDashboard —— 卡片的
           onclick="abortSessionFromDashboard('id')" 是**动态拼进 innerHTML** 的，
           静态 HTML 里搜不到（panel-inline-handlers 守卫只看静态属性），
           所以必须由生成处自己挂（D-017）。
           页面保留同名薄包装 loadSessions（init / 自动刷新 / BroadcastChannel /
           中止后的刷新都按名字调它），抽离对页面壳零改动。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/sessions] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  // 页面 IIFE 有同名本地别名，模块里没有那个作用域 ⇒ 一律显式从 K 取（D-020）。
  var fetchJSON = K.fetchJSON;
  var esc = K.esc;
  var showReadError = K.showReadError;
  var showToast = K.showToast;

  var LIST_ID = 'sessionsList';

  // 后端真有的四种状态（lib/session-store.js 的 SESSION_STATUSES）。
  // 不在这张表里的状态一律原样显示，绝不落到一个编出来的「待处理」上。
  var STATUS_TEXT = { running: '运行中', done: '已完成', failed: '失败', aborted: '已中止' };
  var STATUS_BADGE = {
    running: 'badge-success', done: 'badge-success', failed: 'badge-error', aborted: 'badge-warning',
  };

  // 会话年龄。createdAt 缺失或不是日期时返回「—」：宁可空着，也不拿 "NaNs" 当真相。
  function ageText(createdAt) {
    var t = new Date(createdAt).getTime();
    if (!isFinite(t)) return '—';
    var ms = Date.now() - t;
    if (ms < 0) ms = 0;                       // 时钟回拨/机器间偏差：不显示负年龄
    var min = Math.floor(ms / 60000);
    var sec = Math.floor((ms % 60000) / 1000);
    return min > 0 ? min + 'm' + sec + 's' : sec + 's';
  }

  function emptyHtml() {
    return '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" ' +
      'aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
      '<div class="empty-text">暂无运行中任务</div></div>';
  }

  function render(list) {
    var container = document.getElementById(LIST_ID);
    if (!container) return;

    if (!list || list.length === 0) {
      container.innerHTML = emptyHtml();
      return;
    }

    container.innerHTML = list.map(function (s) {
      var rawStatus = s && s.status;
      var statusText = STATUS_TEXT[rawStatus] || (rawStatus ? String(rawStatus) : '—');
      var statusBadge = STATUS_BADGE[rawStatus] || 'badge-warning';
      var stepsHtml = (s.steps || []).length > 0
        ? '<div class="session-steps"><svg class="icon-svg icon-svg-xs" viewBox="0 0 24 24" aria-hidden="true" ' +
          'focusable="false"><polyline points="9 11 12 14 22 4"/></svg> ' + s.steps.length + ' 步</div>'
        : '';
      var abortBtn = '<button class="btn btn-danger btn-sm" onclick="abortSessionFromDashboard(\'' +
        esc(s.sessionId) + '\')">中止</button>';
      return '<div class="session-item">' +
          '<div class="session-header">' +
            '<span class="session-proxy-badge badge-' + esc(s.proxy) + '">' + esc(s.proxy) + '</span>' +
            '<span class="' + statusBadge + '">' + statusText + '</span>' +
            '<span class="session-age">⏱ ' + ageText(s.createdAt) + '</span>' +
            abortBtn +
          '</div>' +
          '<div class="session-id">' + esc(s.sessionId) + '</div>' +
          '<div class="session-task">' + esc((s.task || {}).title || '无标题') + '</div>' +
          stepsHtml +
        '</div>';
    }).join('');
  }

  function load() {
    fetchJSON('/api/sessions/running', { headers: { 'x-auth-token': K.getToken() || '' } })
      .then(function (data) {
        render((data && data.sessions) || []);
      })
      .catch(function (err) {
        // 口径 ① + ②：不预渲染空态，直接把「读不到」写进用户能看见的那个容器。
        showReadError(LIST_ID, '读取失败', (err && err.message) || '未知错误',
          '会话列表读不到，不代表没有任务在跑。中止操作前请先确认本页能正常加载。', load);
        showToast('会话列表读取失败', 'error');
      });
  }

  function abort(id) {
    if (!confirm('确认中止此任务？')) return;
    fetchJSON('/api/sessions/' + encodeURIComponent(id) + '/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': K.getToken() || '' },
      body: JSON.stringify({ by: 'user' }),
    })
      .then(function (data) {
        if (data && data.ok) {
          showToast('任务已中止', 'success');
          load();                                    // 口径 ③：成功后重渲染，不留旧卡片
        } else {
          // 无 else 时：任务没被中止，界面毫无变化 → 用户以为成功关掉页面，任务继续跑。
          showToast((data && data.error) || '中止未生效', 'error');
        }
      })
      .catch(function (err) {
        showToast('中止失败：' + ((err && err.message) || '未知错误'), 'error');
      });
  }

  // ===== 全局暴露（内联 handler 在全局作用域解析，见 D-017）=====
  // 卡片里的 onclick 是动态拼的，静态 HTML 里没有 ⇒ 必须在这里挂。
  global.abortSessionFromDashboard = abort;

  global.MPViews = global.MPViews || {};
  global.MPViews.sessions = { load: load, abort: abort, render: render };
})(window);
