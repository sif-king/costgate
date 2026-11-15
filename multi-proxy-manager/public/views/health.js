// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 健康（health）
   ----------------------------------------------------------------------------
   阶段 2.3b 第六片（2026-11-15）。这一片比前五片难：它不自治。
   它原先读页面 IIFE 的三样共享物——
     · proxyStatus（`/api/status` 的结果）
     · PROXY_CONFIGS（代理显示名 / 图标）
     · reasonText / renderProviderIsolation / showProviderReadError（共享渲染件）
   所以先落了一层只读共享层 public/mp-shared.js（配置仓 + 诊断文案 + Provider 隔离渲染），
   本模块只从 MPShared 取，不再跨 IIFE。

   🔴 与旧实现的一处**有意差异**：旧 loadHealthPage 会把 `/api/status` 结果写回
   页面 IIFE 的 `proxyStatus`。本模块改为私有 `healthStatus`，不写页面状态。
   理由：页面自己的 `proxyStatus` 只在 loadStatus()/toggleProxy() 里被消费并重渲染，
   切回总览并不会重画代理卡——所以那次写回既不影响界面，又会让「卡片显示的旧状态」
   和「toggleProxy 判断用的新状态」来自两份快照（按钮文案与实际动作可能相反）。
   现在两者都只来自 loadStatus()，反而更一致。

   三条口径（本仓反复强调的）：
     · 读失败 ≠ 没有：`/api/status` 挂了不许渲染空态，必须 showReadError + 重试。
     · 三个请求各自标失败：一路挂掉不让另外两路跟着变空白。
     · 可达性判据：/api/readyz 的真探测优先，缺数据才退回 /api/status 的 health 推断。

   依赖（见 dashboard.html head 与 coherence 第 7 项）：
     · mp-kernel.js → MPKernel.fetchJSON / esc / showReadError
     · mp-shell.js  → MPShell.showLoading / hideLoading / hideOfflineBanner
     · mp-shared.js → MPShared.get / reasonText / latencyText / uptimeText /
                      renderProviderIsolation / showProviderReadError
   三者都必须先于本文件加载（加载时即取引用）。

   公开面：window.MPViews.health.load()
           另挂 window.loadHealthPage / window.loadHealthHistory
           —— 后者是静态 HTML 内联 handler（健康页「刷新」按钮、历史条数下拉），
           按全局作用域解析函数名（见 D-017 / D-018）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  var S = global.MPShell;
  var SH = global.MPShared;
  if (!K || !S || !SH) {
    console.error('[views/health] 缺少 MPKernel / MPShell / MPShared：请按 head 顺序加载 mp-kernel.js → mp-shell.js → mp-shared.js');
    return;
  }

  var fetchJSON = K.fetchJSON;
  var esc = K.esc;
  var showReadError = K.showReadError;

  // 本视图私有状态：不上 window、不写页面壳（见文件头「有意差异」）。
  var healthStatus = {};

  function load() {
    S.showLoading();
    // 历史条数取下拉框当前值（默认 50）。2026-11-14 之前这个下拉的
    // onchange="loadHealthHistory()" 引用的是一个**从未定义**的函数——换了条数
    // 只会抛 ReferenceError、列表纹丝不动。现在 loadHealthHistory 就是本函数的
    // 别名（见文件末尾的全局暴露段），条数在这里读一次。
    var limitSel = document.getElementById('healthHistoryLimit');
    var historyLimit = parseInt((limitSel && limitSel.value) || '50', 10) || 50;
    // 三个请求各自标记读失败：一个挂了不让另外两个也跟着变空白，
    // 但绝不喂 mock 假数据——挂掉的那段必须显示「读不到」。
    Promise.all([
      fetchJSON('/api/status').catch(function(e) { return { __readError: e }; }),
      fetchJSON('/api/provider-health').catch(function(e) { return { __readError: e }; }),
      fetchJSON('/api/health-history?limit=' + historyLimit).catch(function(e) { return { __readError: e }; }),
      // /api/readyz 会对每个代理真发一次 /health 请求（不是看端口在不在听）。
      // /api/status 的 health 可能是缓存或推断，两者冲突时以 readyz 为准。
      fetchJSON('/api/readyz').catch(function(e) { return { __readError: e }; })
    ]).then(function(results) {
      var statusResult = results[0] || {};
      var phResult = results[1] || {};
      var historyResult = results[2] || {};
      var readyzResult = results[3] || {};
      var statusFailed = !!statusResult.__readError;
      healthStatus = statusFailed ? {} : (statusResult.proxies || statusResult);
      var phData = phResult.__readError ? { isolated: [] } : phResult;
      var historyData = historyResult.__readError ? { history: [] } : historyResult;
      // 名 → 真实探测结果。readyz 读不到时留空，渲染侧会退回 /api/status 的推断。
      var readyMap = {};
      if (!readyzResult.__readError && readyzResult.proxies && readyzResult.proxies.details) {
        readyzResult.proxies.details.forEach(function(d) { if (d && d.name) readyMap[d.name] = d; });
      }

      // Update stats（同一套判据：readyz 真探测优先，缺数据才退回 /api/status 推断）
      var okCount = 0, degradedCount = 0, downCount = 0;
      Object.keys(healthStatus).forEach(function(name) {
        var s = healthStatus[name] || {};
        var rz = readyMap[name];
        var reachable = rz ? !!rz.reachable : (!!s.health && s.health.status !== 'down' && !!s.running);
        var degraded = !!s.health && s.health.status === 'degraded';
        if (!reachable) downCount++;
        else if (degraded) degradedCount++;
        else okCount++;
      });

      var el = function(id) { return document.getElementById(id); };
      // 🔴 读失败时统计卡必须显示「—」，不许写 0：0 会被读成「测过了，没有」，
      // 真相却是「没读到」。旧实现在 status 读失败时把三个计数写成 0、历史失败时
      // 把条数写成 0 —— 列表明明写着「读取失败」，上面三张卡却说「一切为 0」。
      var DASH = '—';
      if (el('healthOkCount')) el('healthOkCount').textContent = statusFailed ? DASH : okCount;
      if (el('healthDegradedCount')) el('healthDegradedCount').textContent = statusFailed ? DASH : degradedCount;
      if (el('healthDownCount')) el('healthDownCount').textContent = statusFailed ? DASH : downCount;
      if (el('healthHistoryCount')) {
        el('healthHistoryCount').textContent = historyResult.__readError ? DASH : (historyData.history || []).length;
      }

      // Render proxy health list
      var healthList = el('healthProxyList');
      if (healthList) {
        if (statusFailed) {
          // 读不到 ≠ 没有代理。过去这里兜底成 mock 三代理（pid 12345 / uptime 2h34m），
          // 故障被伪装成「三个代理都在跑」——这是本轮修掉的最危险一处。
          showReadError('healthProxyList', '读取失败',
            statusResult.__readError.message || '未知错误',
            'manager 的 /api/status 没返回。若 manager 本身没起来，先看 logs 页的启动日志。', load);
        } else {
          var entries = Object.entries(healthStatus);
          if (entries.length === 0) {
            healthList.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="empty-text">暂无代理数据</div></div>';
          } else {
          healthList.innerHTML = entries.map(function(entry) {
            var name = entry[0], status = entry[1];
            var config = SH.get(name) || { name: name, iconClass: '' };
            var health = status.health;
            var rz = readyMap[name];   // /api/readyz 的真实探测结果（可能缺此项）
            var statusClass = status.running ? 'running' : 'stopped';
            var statusText = status.running ? '运行中' : '未运行';
            // 可达性以 readyz 的真探测为准；没有 readyz 数据才退回 /api/status 的 health 推断。
            var reachable = rz ? !!rz.reachable : (!!health && health.status !== 'down');
            var degraded = !!health && health.status === 'degraded';
            var hClass = reachable ? (degraded ? 'status-badge degraded' : 'status-badge online') : 'status-badge offline';
            var hText;
            if (!reachable) {
              // 只说「不可达」等于什么都没说：用户分不清「没启动」和「起来了但卡住」，
              // 这两种处置完全相反（去 start vs 去看日志）。原因 + 处置必须一起给。
              // 外层徽章已经写了「未运行/运行中」，这里不再重复「不可达」三个字。
              hText = SH.reasonText(rz && rz.reason, !!status.running);
            } else {
              hText = degraded ? '降级' : '健康';
            }
            // 延迟 / 运行时间：字段名归一收到 mp-shared.js（老 bug：接口给 latencyMs
            // 与 rawHealth.uptime，两处渲染却读 latency / uptime，于是恒显示 —）。
            // 不可达时不印延迟：连接失败路径上 latencyMs 也可能被赋值，
            // 把「连接消耗」当成「代理延迟」是另一种假数据。
            var latency = reachable ? (SH.latencyText(health) || '-') : '-';
            var uptime = SH.uptimeText(status) || '-';

            return '<div class="health-row">' +
              '<span class="health-provider"><span class="proxy-icon ' + esc(config.iconClass || '') + '" style="width:28px;height:28px;font-size:14px;">' + (config.icon || '') + '</span> ' + esc(config.name) + '</span>' +
              '<span><span class="status-badge ' + statusClass + '"><span class="dot"></span>' + statusText + '</span> <span class="' + hClass + '"><span class="dot"></span>' + esc(hText) + '</span></span>' +
              '<span style="min-width:80px;text-align:right;font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary);">' + esc(latency) + '</span>' +
              '<span style="min-width:100px;text-align:right;font-size:13px;color:var(--color-text-tertiary);">' + esc(uptime) + '</span>' +
            '</div>';
          }).join('');
          // 全都没跑时，满屏红色不构成信息。把「这不是故障，是代理还没启动」说明白，
          // 否则第一次打开面板的人只会看到九行红字，以为整机坏了。
          if (downCount === entries.length) {
            healthList.innerHTML =
              '<div style="padding:10px 12px;margin:0 0 10px;border-radius:8px;background:rgba(127,127,127,.10);font-size:13px;line-height:1.6;color:var(--color-text-secondary);">' +
              '没有任何代理在运行 —— 这是「只装了管理器、还没启动代理」的常态，不是故障。' +
              '起法：<code>bash manage.sh start all</code>，或逐个启动需要的代理。' +
              '</div>' + healthList.innerHTML;
          }
          }
        }
      }

      // Render provider health（渲染与读失败都走公共函数，见 mp-shared.js）
      var phList = el('healthPagePhList');
      if (phList) {
        if (phResult.__readError) {
          // 「所有 Provider 健康」这句话只有在真读到「无隔离项」时才配说。
          // 读失败时说它，等于替一个没查过的系统开健康证明。
          SH.showProviderReadError('healthPagePhList', 'healthPagePhSubtitle', phResult.__readError, load);
        } else {
          SH.renderProviderIsolation('healthPagePhList', 'healthPagePhSubtitle', phData);
        }
      }

      // Render health history
      var historyList = el('healthHistoryList');
      if (historyList) {
        if (historyResult.__readError) {
          showReadError('healthHistoryList', '读取失败',
            historyResult.__readError.message || '未知错误',
            '读不到健康历史，不代表期间没有发生故障。', load);
        } else {
        var history = historyData.history || [];
        if (history.length === 0) {
          historyList.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div><div class="empty-text">暂无健康历史</div></div>';
        } else {
          historyList.innerHTML = history.slice(0, historyLimit).map(function(h) {
            var hClass = h.status === 'ok' ? 'status-badge online' : h.status === 'degraded' ? 'status-badge degraded' : 'status-badge offline';
            var hText = h.status === 'ok' ? '健康' : h.status === 'degraded' ? '降级' : '故障';
            var time = h.timestamp ? new Date(h.timestamp).toLocaleString('zh-CN') : '-';
            return '<div class="health-row">' +
              '<span class="health-provider">' + esc(h.proxy || h.name || 'unknown') + '</span>' +
              '<span><span class="' + hClass + '"><span class="dot"></span>' + hText + '</span></span>' +
              '<span style="flex:1;font-size:12px;color:var(--color-text-tertiary);">' + esc(h.reason || '-') + '</span>' +
              '<span style="font-size:11px;color:var(--color-text-tertiary);font-family:var(--font-mono);">' + esc(time) + '</span>' +
            '</div>';
          }).join('');
        }
        }
      }

      S.hideOfflineBanner();
      S.hideLoading();
    }).catch(function(err) {
      // 整页读失败：说清楚是哪一路挂了，不要静默 hideLoading 后留一片空白。
      S.hideOfflineBanner();
      showReadError('healthProxyList', '读取失败', err && err.message || '未知错误',
        'manager 不可达或 /api/status 异常。可点上方「重试」。', load);
      S.hideLoading();
    });
  }

  // ===== 全局暴露（内联 handler 在全局作用域解析，见 D-017）=====
  global.loadHealthPage = load;
  // 健康历史条数下拉的原引用 loadHealthHistory 从未定义过（换了条数只会抛
  // ReferenceError，列表纹丝不动）；现在它就是本函数的别名，条数在下拉处读。
  global.loadHealthHistory = load;

  global.MPViews = global.MPViews || {};
  global.MPViews.health = { load: load };
})(window);
