// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 概览（overview）
   ----------------------------------------------------------------------------
   阶段 2.3b 第七片（2026-11-15）。前六片都刻意绕开了这一块，理由写在 D-021：
   它「读写 proxyStatus、是首屏与轮询宿主」，倾向判定为页面壳。本片把它整块迁过来
   之后，D-019 登记的那个前置条件——「共享状态单一真源迁移（proxyStatus 20+ 处、
   versionCache 5 处）」——由「搬走持有者」而不是「造一个全局 store」解决：
     · proxyStatus / versionCache / 状态翻转快照 全部只在本模块里存在；
     · 页面一个都不再持有（原先页面自己也在 loadStatus / toggleProxy 里写，两份快照
       会让「卡片显示的状态」和「按钮判断的状态」来自不同时刻，文案和动作可能相反）；
     · 唯一的跨视图读取口是 MPViews.overview.status(name)（侧栏代理徽章 ON/OFF 用）。

   为什么可以整体搬（而不是只搬渲染）：
     清点后只有四处读 proxyStatus（概览卡、侧栏徽章、toggle、轮询的写回），
     versionCache 只在 loadVersion / toggle / 概览渲染之间流动 —— 没有第三处消费者。
     所以「轮询 + 首屏渲染 + 开关代理」可以一起走，不必留半套在页面里。

   三条口径（搬过来一字未改，都是被真 bug 换来的）：
     · 读失败 ≠ 没有代理：/api/status 挂了要独立错误态 + 重试，绝不喂 mock 三代理
       （过去 getMockStatus 会给出 pid 12345 / uptime 2h34m 这种「像真的」假数据）。
     · 版本读失败显示「读取失败」，不保留上一次成功值（那会让用户放弃一次该做的升级）。
     · 端口冲突检测失败必须说出来：「未检测到冲突 ≠ 没有冲突」。

   依赖（顺序见 dashboard.html head 与 coherence 第 7 项）：
     mp-kernel.js → mp-shell.js → mp-shared.js → views/*.js → 页面内联脚本
     · mp-kernel.js → MPKernel.fetchJSON / esc / showToast / getToken
     · mp-shell.js  → MPShell.showLoading / hideLoading / showOfflineBanner / hideOfflineBanner
     · mp-shared.js → MPShared.get（代理显示名 / 端口 / 图标 / 默认版本）/ latencyText / uptimeText
     · states.js    → MPStates.error / registerRetry（运行时才用，见 loadStatus 的 catch）

   公开面：window.MPViews.overview.{ loadStatus, loadVersion, checkProxyConflicts,
                                    status, statusEntries, toggle }
           另挂 window.toggleProxy —— 概览卡里的 onclick 是**动态生成**的（写进
           innerHTML），按全局作用域解析，见 D-017 / D-018。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  var S = global.MPShell;
  var SH = global.MPShared;
  if (!K || !S || !SH) {
    console.error('[views/overview] 缺少 MPKernel / MPShell / MPShared：请按 head 顺序加载 mp-kernel.js → mp-shell.js → mp-shared.js');
    return;
  }

  var esc = K.esc;
  var fetchJSON = K.fetchJSON;
  var showToast = K.showToast;

  // ===== 本视图私有状态（页面不再持有，见文件头）=====
  var proxyStatus = {};
  var versionCache = {};
  // 因果动效（2026-11-01 · Stageshow「every motion has a cause / change only what
  // changed」）：状态翻转前快照，重渲染后只对 running/fault/health 真变了的代理卡片
  // 加一瞬强调，没变的不动；reduced-motion 直接不闪。
  var prevStatusSnapshot = null;

  // 与 proxy-config 同一处时序竞争：/api/status 可能先于 nav.js 建好 #proxyNavItems
  // 返回，早到那次若直接 return，9 个代理就时有时无。改为暂存 + 等容器就绪事件补画。
  var pendingProxyNavEntries = null;

  // 2026-11-15 壳第二片：原 hideDemoBanner() 局部副本整体删除——#demoBanner
  // 元素早就不在 DOM（全仓 grep 仅三处对不存在的元素空打），两处调用点一并去掉。
  // 真正读成功时要收的是 offlineBanner，由 S.hideOfflineBanner() 负责，就在这两处调用里。

  // ===== 概览首屏 =====
  function render(versionData) {
    var proxies = Object.entries(proxyStatus);
    var running = proxies.filter(function(entry) { return entry[1].running; }).length;
    var total = proxies.length;

    var statusEl = document.getElementById('proxyStatusCount');
    var installedEl = document.getElementById('installedCount');
    var sessionEl = document.getElementById('sessionCount');
    var alertEl = document.getElementById('alertCount');

    if (statusEl) statusEl.textContent = total > 0 ? running + '/' + total : '0/0';
    if (installedEl) installedEl.textContent = total;
    if (sessionEl) sessionEl.textContent = document.querySelectorAll('.session-item').length;
    if (alertEl) {
      // alertEvents 已随告警页抽进 views/alerts.js（2.3b 第二片），概览从这里读副本。
      var alertEvts = (global.MPViews && global.MPViews.alerts) ? global.MPViews.alerts.events() : [];
      alertEl.textContent = alertEvts.filter(function(a) { return a.severity === 'critical' || a.severity === 'warning'; }).length;
    }

    renderProxyCards(proxies, versionData);
    renderProxyNavItems(proxies);
  }

  function renderProxyCards(proxies, versionData) {
    var container = document.getElementById('proxyStatusList');
    if (!container) return;

    if (proxies.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="empty-text">暂无代理，请先安装代理程序</div></div>';
      return;
    }

    container.innerHTML = proxies.map(function(entry) {
      var name = entry[0];
      var status = entry[1];
      var config = SH.get(name) || { name: name, icon: '', iconClass: '', port: 0, defaultVersion: '' };
      var isRunning = status.running;
      var isFault = !!status.fault;
      var statusClass = isRunning ? 'running' : (isFault ? 'fault' : 'stopped');
      var statusText = isRunning ? '运行中' : (isFault ? '故障熔断' : '未运行');
      var btnClass = isRunning ? 'btn-danger' : 'btn-success';
      var btnText = isRunning ? '停止' : '启动';
      var btnIcon = isRunning ? '<svg class="icon-svg icon-svg-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' : '<svg class="icon-svg icon-svg-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

      var statusBadge = '<span class="status-badge ' + statusClass + '"><span class="dot"></span>' + statusText + '</span>';
      var healthBadge = '';
      if (status.health) {
        var healthStatus = status.health.status;
        var healthClass, healthText, healthReason = '';
        var reasonsArr = Array.isArray(status.health.reasons) ? status.health.reasons : [];
        if (reasonsArr.length > 0) healthReason = reasonsArr[0];

        if (healthStatus === 'ok') { healthClass = 'status-badge online'; healthText = '健康'; }
        else if (healthStatus === 'degraded') { healthClass = 'status-badge degraded'; healthText = '降级' + (healthReason ? '·' + healthReason : ''); }
        else { healthClass = 'status-badge offline'; healthText = healthReason || '异常'; }
        var titleText = (reasonsArr.length > 0 ? reasonsArr.join('；') : healthText);
        healthBadge = '<span class="' + healthClass + '" title="' + (titleText ? esc(titleText.slice(0, 200)) : '') + '"><span class="dot"></span>' + esc(healthText.slice(0, 60)) + '</span>';
      } else if (!isRunning) {
        healthBadge = '<span class="status-badge offline"><span class="dot"></span>未检测</span>';
      }

      // 延迟 / 运行时间：字段名归一在 mp-shared.js（接口给 latencyMs / rawHealth.uptime，
      // 旧概览卡读 latency / uptime，于是这两项从来没显示过）。
      var upText = SH.uptimeText(status);
      var upLatency = SH.latencyText(status.health);
      var uptimeText = upText ? '运行 ' + upText : '';
      var latencyText = upLatency ? '延迟 ' + upLatency : '';
      var versionValue = versionData && versionData.proxies && versionData.proxies[name] ? versionData.proxies[name] : (config.defaultVersion || '');
      var versionBadge = versionValue ? '<span class="proxy-version-badge">' + esc(versionValue) + '</span>' : '';

      return '<div class="proxy-card" id="proxy-card-' + name + '">' +
        '<div class="proxy-icon ' + config.iconClass + '">' + config.icon + '</div>' +
        '<div class="proxy-info">' +
          '<div class="proxy-name-row">' +
            '<span class="proxy-name">' + config.name + '</span>' +
            '<span class="proxy-port-badge">:' + (status.port || config.port) + '</span>' +
            versionBadge +
          '</div>' +
          '<div class="proxy-meta">' +
            statusBadge +
            (uptimeText ? '<span>' + esc(uptimeText) + '</span>' : '') +
            (latencyText ? '<span>' + esc(latencyText) + '</span>' : '') +
            healthBadge +
          '</div>' +
        '</div>' +
        '<div class="proxy-actions">' +
          '<button class="btn ' + btnClass + ' btn-sm" id="btn-toggle-' + name + '" onclick="toggleProxy(\'' + name + '\')">' + btnIcon + ' ' + btnText + '</button>' +
          '<button class="btn btn-outline btn-sm" onclick="window.location.href=\'proxy-config.html?proxy=' + name + '\'">配置</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderProxyNavItems(proxies) {
    if (proxies) pendingProxyNavEntries = proxies;
    var container = document.getElementById('proxyNavItems');
    if (!container) return;
    var entries = pendingProxyNavEntries || [];
    container.innerHTML = entries.map(function(entry) {
      var name = entry[0];
      var status = entry[1];
      var config = SH.get(name) || { name: name, icon: '' };
      var badgeClass = status.running ? 'running' : 'stopped';
      var badgeText = status.running ? 'ON' : 'OFF';
      return '<a href="proxy-config.html?proxy=' + name + '" class="nav-item proxy-nav-item" data-proxy="' + esc(name) + '" data-tooltip="' + esc(config.name) + '" tabindex="0">' +
        '<span class="nav-icon">' + config.icon + '</span>' +
        config.name +
        '<span class="nav-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '</a>';
    }).join('');
  }

  document.addEventListener('mp-nav-rendered', function () {
    if (pendingProxyNavEntries) renderProxyNavItems(pendingProxyNavEntries);
  });

  // ===== 版本明细卡 =====
  // 只管概览页那张版本明细卡。**侧栏那个 #sidebarVersion 不归这里**——侧栏由 nav.js 的
  // renderNav 重建，页面写进去的值会被下一次渲染冲掉；取数与填充统一在 nav.js 的
  // fillSidebarVersion()（2026-11-14 收口）。
  function renderVersion(versionData) {
    var container = document.getElementById('versionInfo');

    if (container) {
      if (versionData) {
        var rows = [];
        if (versionData.version) rows.push({ label: '管理器版本', value: versionData.version });
        if (versionData.proxies) {
          Object.keys(versionData.proxies).forEach(function(key) {
            var ver = versionData.proxies[key];
            var config = SH.get(key);
            rows.push({ label: config ? config.name : key, value: ver });
          });
        }
        // 版本字符串来自仓库 VERSION 与各子包 package.json：只有根版本过了
        // ^\d+\.\d+\.\d+ 校验，子包版本原样透传。进 innerHTML 前一律转义。
        container.innerHTML = rows.map(function(row) {
          return '<div class="version-item"><span class="ver-label">' + esc(row.label) + '</span><span class="ver-value">' + esc(row.value) + '</span></div>';
        }).join('');
      } else {
        // null = 读失败。不能保留上一次成功的值——那会让用户以为版本没变，
        // 从而放弃一次本该做的升级。也不能显示空（那像「没有版本信息」）。
        container.innerHTML =
          '<div class="version-item"><span class="ver-label">管理器版本</span>' +
          '<span class="ver-value" style="color:#d97706;">读取失败</span></div>';
      }
    }
  }

  // ===== 状态翻转强调 =====
  function highlightStatusChanges(prev, next) {
    if (!prev || !next) return;
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var name in next) {
      if (!next.hasOwnProperty(name)) continue;
      var p = prev[name] || {};
      var n = next[name] || {};
      var nHealth = (n.health && n.health.status) || '';
      var changed = (p.running !== n.running) || (p.fault !== n.fault) || (p.health !== nHealth);
      if (!changed) continue;
      var card = document.getElementById('proxy-card-' + name);
      if (!card) continue;
      card.classList.add('status-changed');
      (function(el) { setTimeout(function() { el.classList.remove('status-changed'); }, 900); })(card);
    }
  }

  // ===== 轮询 =====
  function loadStatus() {
    S.showLoading();
    prevStatusSnapshot = {};
    for (var pk in proxyStatus) {
      if (!proxyStatus.hasOwnProperty(pk)) continue;
      var ps = proxyStatus[pk] || {};
      prevStatusSnapshot[pk] = {
        running: !!ps.running,
        fault: !!ps.fault,
        health: (ps.health && ps.health.status) || ''
      };
    }
    return fetchJSON('/api/status')
      .then(function(data) {
        Object.assign(proxyStatus, data);
        render(versionCache);
        highlightStatusChanges(prevStatusSnapshot, proxyStatus);
        prevStatusSnapshot = null;
        S.hideOfflineBanner();
      })
      .catch(function(err) {
        // 过去这里在 proxyStatus 为空时喂 getMockStatus()——三个假代理，
        // codex「运行中 pid 12345 uptime 2h34m 延迟 45ms」。
        // 总览页是用户第一眼看到的地方，在这里显示「像真的」假数据最危险：
        // 他会以为代理都在跑，直到真的调不通才发现。宁可显示「读不到」。
        if (Object.keys(proxyStatus).length === 0) {
          // 读失败 ≠ 没有代理：给独立错误态 + 重试，而不是渲染「暂无代理」空态
          var MS = global.MPStates;
          if (MS && MS.registerRetry) MS.registerRetry('dashboard:status', loadStatus);
          var box = document.getElementById('proxyStatusList');
          if (box) box.innerHTML = MS.error({
            title: '读取失败',
            detail: (err && err.message) || 'manager 不可达',
            hint: '代理状态读不到，不代表没有安装代理程序。可点重试，或检查 manager 是否在运行。',
            retryKey: 'dashboard:status'
          });
          S.showOfflineBanner();
          showToast('代理状态读取失败：' + ((err && err.message) || 'manager 不可达'), 'error', 6000);
        }
      })
      .finally(S.hideLoading);
  }

  function checkProxyConflicts() {
    // 2026-10-24：原先裸 fetch + 不判 res.ok。/api/conflicts 500 时 body 没有 conflicts
    // 字段 → occupied 为空 → 直接 return，界面显示「没冲突」。冲突检测失败被显示成
    // 检测通过，是这段里最危险的一种静默。改成读失败就明说。
    return fetchJSON('/api/conflicts', { headers: { 'x-auth-token': K.getToken() || '' } })
      .then(function(data) {
        var conflicts = data.conflicts || {};
        var occupied = Object.keys(conflicts).filter(function(k) { return conflicts[k] && conflicts[k].occupied; });
        if (occupied.length === 0) return;
        var names = occupied.map(function(k) {
          var c = conflicts[k];
          var cc = SH.get(k);
          var label = cc ? cc.name : k;
          return label + '（base_url → ' + (c.baseUrl || c.by) + '）';
        });
        var msg = '检测到以下代理被其它工具占用，本服务无法接管：\n' + names.join('\n') +
                  '\n请先关闭占用工具（如 cc-switch）对这些代理的代理，再开启本服务开关。';
        showToast(msg, 'error', 8000);
      })
      .catch(function(e) {
        // 不阻断主界面，但必须说出来：静默 = 把「检测失败」显示成「没冲突」。
        showToast('端口冲突检测读取失败（' + ((e && e.message) || '未知错误') +
                  '）——未检测到冲突 ≠ 没有冲突，请手动确认。', 'error', 8000);
      });
  }

  function loadVersion() {
    S.showLoading();
    return fetchJSON('/api/version')
      .then(function(data) {
        versionCache = data;
        renderVersion(data);
        S.hideOfflineBanner();
      })
      .catch(function(err) {
        // 过去这里兜底 getMockVersion()——假的 '1.0.3' + 三个假子版本号。
        // 版本号是「我装的是不是最新」的判断依据，喂假值会让用户放弃升级。
        versionCache = null;
        renderVersion(null);
        S.showOfflineBanner();
        showToast('版本信息读取失败：' + ((err && err.message) || 'manager 不可达'), 'error', 6000);
      })
      .finally(S.hideLoading);
  }

  // ===== 启停 =====
  function toggle(name) {
    var btn = document.getElementById('btn-toggle-' + name);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var originalContent = btn.innerHTML;
    btn.innerHTML = '<span class="loading-spinner"></span>';

    var status = proxyStatus[name];
    var action = status && status.running ? 'stop' : 'start';

    fetch('/api/' + action + '/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': K.getToken() || '' } })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          showToast((SH.get(name) ? SH.get(name).name : name) + ' 已' + (action === 'start' ? '启动' : '停止'), 'success');
          proxyStatus[name] = Object.assign({}, proxyStatus[name], { running: action === 'start' });
          render(versionCache);
        } else if (action === 'start' && data.conflict) {
          showToast(data.error || '该代理被其它工具占用，无法开启', 'error', 6000);
          btn.innerHTML = originalContent;
          btn.disabled = false;
        } else {
          showToast((action === 'start' ? '启动' : '停止') + '失败: ' + (data.error || '未知错误'), 'error');
          btn.innerHTML = originalContent;
          btn.disabled = false;
        }
      })
      .catch(function(err) {
        showToast((action === 'start' ? '启动' : '停止') + '失败: ' + err.message, 'error');
        btn.innerHTML = originalContent;
        btn.disabled = false;
      });
  }

  // ===== 全局暴露（内联 handler 在全局作用域解析，见 D-017）=====
  // 概览卡里的 onclick="toggleProxy('name')" 是动态拼进 innerHTML 的，静态 HTML 里
  // 搜不到（panel-inline-handlers 守卫也只看静态属性），所以这一挂必须由生成处负责。
  global.toggleProxy = toggle;

  global.MPViews = global.MPViews || {};
  global.MPViews.overview = {
    loadStatus: loadStatus,
    loadVersion: loadVersion,
    checkProxyConflicts: checkProxyConflicts,
    toggle: toggle,
    // 侧栏代理徽章（页面 renderDynamicProxyNav）唯一允许的读取口：
    // 状态只有一份，持有者在这里。
    status: function (name) { return proxyStatus[name]; },
    statusEntries: function () { return Object.entries(proxyStatus); }
  };
})(window);
