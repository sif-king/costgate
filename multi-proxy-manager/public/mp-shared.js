// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   面板共享层（mp-shared.js）· 阶段 2.3b 第六片（2026-11-15）
   ----------------------------------------------------------------------------
   为什么要有这一层：抽 health 视图时撞上三件「页面壳和视图都要用」的东西——
     ① PROXY_CONFIGS（代理名/端口/图标/默认版本，来自 GET /api/proxy-configs）
     ② reasonText()（不可达时的「原因 + 该干什么」诊断文案）
     ③ renderProviderIsolation / showProviderReadError（Provider 隔离状态渲染）
   过去它们都定义在 dashboard.html 的 IIFE 里，视图模块拿不到，于是只能「不抽」。
   本层不是又一个 store：**只有只读仓 + 纯函数渲染**，没有轮询、没有副作用、
   没有订阅。写入口只有一个（setProxyConfigs，由页面 fetchProxyConfigs 调）。

   三条纪律（都来自本仓已踩过的坑）：
     · 读失败 ≠ 没有：本层只渲染「读到了」；读失败必须走 showProviderReadError。
     · 不认识的码原样露出，不替它编解释（见 reasonText）。
     · 视图模块一律显式从 global.MPShared 取，**不许裸用页面 IIFE 的本地名**
       （D-020：cost 抽离后裸调 fetchJSON 导致余额区静静停在空态）。

   加载顺序（见 dashboard.html head 与 scripts/check-panel-coherence.sh 第 7 项）：
     mp-kernel.js → mp-shell.js → **mp-shared.js** → views/*.js → 页面内联脚本

   公开面：window.MPShared.{ setProxyConfigs, get, proxyConfigNames,
                             reasonText, renderProviderIsolation, showProviderReadError }
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[mp-shared] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  var esc = K.esc;
  var showReadError = K.showReadError;

  // ===== 代理配置只读仓（唯一写入口 setProxyConfigs）=====
  // 2026-10-27 起真源是服务端 buildProxyConfigs()，前端不再硬编码副本。
  var proxyConfigs = {};

  function setProxyConfigs(map) {
    proxyConfigs = map || {};
  }

  function get(name) {
    return proxyConfigs[name] || null;
  }

  function proxyConfigNames() {
    return Object.keys(proxyConfigs);
  }

  // ===== 不可达时的诊断文字 =====
  // 两段：出什么事（原因）+ 该干什么（处置）。
  // 三条纪律：
  //  1. 不再输出带「不可达」前缀的句子——外层徽章已经说了不可达，重复一次就是
  //     「不可达 · 不可达（原因未知）」这种自己骂自己的文案（实测踩过）。
  //  2. reason 缺失时不许写「原因未知」了事：/api/status 的 running 本身就是信息，
  //     进程没跑就是最有用的一句话。缺字段只可能发生在面板与 manager 版本不一致时。
  //  3. 不认识的码原样露出——宁可显示一个陌生字符串，也不要替它编解释。
  function reasonText(r, running) {
    if (r === 'timeout') {
      return running ? '探测超时 · 进程在跑但 2s 内没回 /health，去看日志'
                     : '探测超时 · 进程记录里没在跑，先启动再看';
    }
    if (r === 'ECONNREFUSED') {
      return running ? '连接被拒 · 进程记录说有跑，但端口没人监听，八成启动即崩，去看日志'
                     : '连接被拒 · 该代理未启动（端口没人监听）';
    }
    if (r === 'EHOSTUNREACH' || r === 'ENETUNREACH') return '网络不可达 · 检查本机网络或监听地址';
    if (r) return '原因码 ' + String(r);
    // reason 缺失（未升级的 manager）：仍然给出可执行判断，并标明信息不完整。
    return running ? '进程在跑但探测不通 · 原因字段缺失（面板与 manager 版本不一致，重启面板）'
                   : '该代理未运行';
  }

  // ===== 延迟 / 运行时间文案（两处共用，避免各读各的字段名）=====
  // 🔴 2026-11-15 抽 health 时发现的老 bug：/api/status 给的是
  //   health.latencyMs（不是 health.latency）、rawHealth.uptime（不是 status.uptime），
  // 而概览卡与健康页都按后两个名字读 —— 于是「延迟」「运行时间」两列**恒显示 —**，
  // 看起来像「探不到数据」，实际是字段名读错了。两处渲染本就应该只有一份口径，
  // 所以在这里归一：老字段优先（兼容旧 manager），新字段兜底，都没有才留空。
  function latencyText(health) {
    if (!health) return '';
    if (health.latency) return String(health.latency);
    if (health.latencyMs != null && !isNaN(health.latencyMs)) return health.latencyMs + 'ms';
    return '';
  }

  function uptimeText(status) {
    if (!status) return '';
    if (status.uptime) return String(status.uptime);
    var sec = status.rawHealth && status.rawHealth.uptime;
    if (sec == null || isNaN(sec)) return '';
    sec = Math.round(Number(sec));
    if (sec <= 0) return '';
    // 🔴 hermes-proxy/proxy.py 的 /health 把 uptime 填成 time.time()（**epoch 秒**，
    // 不是进程运行秒数；见 hermes-proxy/proxy.py 的 'uptime': time.time()）。
    // 1e9 秒 ≈ 31.7 年，任何真实运行时长都到不了这里 —— 命中即判「上游给的不是时长」，
    // 宁可留空也不渲染成 20772d5h 这种荒谬假数字（本仓铁律：不许用假数据装正常）。
    // 该 bug 归上游；本函数只负责不把它当真相展示。
    if (sec >= 1e9) return '';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd' + h + 'h';
    if (h > 0) return h + 'h' + m + 'm';
    return m + 'm';
  }

  // ===== Provider 隔离状态（概览卡 + 健康页共用一份渲染）=====
  // 2026-11-14 合并：这两处原先各写一遍几乎逐字相同的 HTML 生成代码（连
  // 「连续失败 N 次 · 来源」那段都一样），同一份数据两处渲染，口径迟早漂。
  //
  // 两条铁律，都是被真 bug 换来的：
  //   ① 这里只负责「读到了」的渲染；读失败必须走 showProviderReadError()。
  //      原概览的 catch 先 renderProviderHealth([], …) 再改副标题，于是卡体写着
  //      「所有 Provider 健康」、副标题写着「读取失败」—— 替一个没查过的系统开了
  //      健康证明。注释明写着不许，实现却这么干了（读失败 ≠ 没有）。
  //   ② 副标题必须一起清空，否则「observe 模式」会和「读取失败」并排出现，
  //      被读成「一切正常，只是没数据」。
  function renderProviderIsolation(containerId, subId, data) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var sub = document.getElementById(subId);
    if (sub) sub.textContent = (data && data.isolateEnabled) ? '自动隔离已开启（live）' : 'observe 模式（仅建议，不改路由）';

    var list = (data && data.isolated) || [];
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="empty-text">所有 Provider 健康</div></div>';
      return;
    }

    container.innerHTML = list.map(function(p) {
      var remainMs = (p.unhealthyUntil || 0) - Date.now();
      var remainMin = Math.max(0, Math.round(remainMs / 60000));
      var corr = p.correlation || {};
      var verdictText = corr.verdict === 'network-wide' ? '全网故障' : '单 Proxy 抖动';
      var verdictClass = corr.verdict === 'network-wide' ? 'badge-error' : 'badge-warning';
      var sources = (corr.sources || []).join(', ') || '—';
      return '<div class="session-item">' +
        '<div class="session-header">' +
          '<span class="session-proxy-badge badge-' + esc(p.providerId) + '">' + esc(p.providerId) + '</span>' +
          '<span class="' + verdictClass + '">' + verdictText + '</span>' +
          '<span class="session-age">⏱ ' + remainMin + 'min 后恢复</span>' +
        '</div>' +
        '<div class="session-id">连续失败 ' + (p.consecutiveFailures || 0) + ' 次 · 来源：' + esc(sources) + '</div>' +
      '</div>';
    }).join('');
  }

  function showProviderReadError(containerId, subId, err, retryFn) {
    var sub = document.getElementById(subId);
    if (sub) sub.textContent = '—';
    showReadError(containerId, '读取失败', (err && err.message) || '未知错误',
      'Provider 隔离状态读不到，不代表 Provider 都健康。', retryFn);
  }

  global.MPShared = {
    setProxyConfigs: setProxyConfigs,
    get: get,
    proxyConfigNames: proxyConfigNames,
    reasonText: reasonText,
    latencyText: latencyText,
    uptimeText: uptimeText,
    renderProviderIsolation: renderProviderIsolation,
    showProviderReadError: showProviderReadError
  };
})(window);
