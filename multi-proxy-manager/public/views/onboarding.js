// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 首屏 onboarding（2.3b 第八片，2026-11-15）
   ----------------------------------------------------------------------------
   回答「我下一步点哪」，信号全部来自真实运行态，不写死、不猜。三态必须各说各话：
     加载 / 下一步（含全没跑时的「这不是故障」说明）/ 读失败 → 重试
   ——**绝不**把「读不到」渲染成空态或整卡隐藏（这是本仓最忌讳的那种混淆）。

   为什么这一片可以抽：它只读两个接口（/api/readyz 主信号、/api/cost/watchtower
   次信号 best-effort）和六个固定容器 id，不读 proxyStatus、不写共享状态、
   不被别的视图调用 —— 与 registry / cost 同形，是自治片。

   依赖（必须先加载，见 dashboard.html head）：
     · mp-kernel.js → MPKernel.fetchJSON / showReadError / showToast / esc / copyText
     · mp-shared.js → MPShared.reasonText（「配了但没跑」时带出原因 + 处置）
     · 运行期才用到页面壳的 global.switchPage（「查看账本 →」跳成本页），
       不假设页面 IIFE 的任何本地别名存在（D-020 的教训：裸调 fetchJSON 会静默空壳）。

   公开面：window.MPViews.onboarding.{ load, copyUnifiedUrl, statusLine, unifiedUrl }
           页面保留同名薄包装 loadOnboarding / copyUnifiedIngressUrl（init() 与静态
           内联 onclick 都按名字调用它们，抽离对页面壳零改动）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/onboarding] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  // 页面 IIFE 里有同名本地别名，模块里没有那个作用域 —— 一律显式从 K 取（D-020）。
  var fetchJSON = K.fetchJSON;
  var showReadError = K.showReadError;
  var showToast = K.showToast;
  var esc = K.esc;

  // ---- 统一接入 URL：全站唯一字面量 ----
  // 原来复制逻辑在 dashboard.html 的 IIFE 里（`var url = 'http://127.0.0.1:18880/v1'`），
  // 而首屏 Hero 的可见文本是 HTML 里手写的同一串。两份手写必然漂移（改端口时改一处忘一处，
  // 用户在界面上看到 A、复制到 B）。这里收成一份常量，并在 load() 时把 #unifiedIngressUrl
  // 的文本同步过去（幂等）：HTML 里那份降级成首屏占位，不再承担真源。
  var UNIFIED_URL = 'http://127.0.0.1:18880/v1';

  // reasonText 归 mp-shared.js（单一真源）。共享层没就位时不许把原因退化成空白——
  // 原样出原因码，至少让人知道「不是没原因，是这层没加载」。
  function reasonOf(r, running) {
    var S = global.MPShared;
    if (S && typeof S.reasonText === 'function') return S.reasonText(r, running);
    return r ? ('原因码 ' + String(r)) : (running ? '进程在跑但探测不通' : '该代理未运行');
  }

  var DISMISS_KEY = 'mp-onboarding-dismissed';
  var dismissWired = false;

  function isDismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }

  // 一次性关闭：诚实的「不再提示」，整卡隐藏，不做任何自证注脚。幂等——重复渲染不叠监听。
  function wireDismiss() {
    if (dismissWired) return;
    var btn = document.getElementById('onboardingDismiss');
    if (!btn) return;
    dismissWired = true;
    btn.addEventListener('click', function () {
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
      var c = document.getElementById('onboardingCard');
      if (c) c.style.display = 'none';
    });
  }

  // 复制推荐单端点 URL。复制失败必须说话（2026-11-15 CI 实测 headless Linux 上
  // writeText 被拒）：原来只接成功分支，浏览器禁剪贴板时点完毫无反应。
  // copyText 永不 reject，这里按 true/false 分别提示，把 URL 本身露出来让人手抄。
  function copyUnifiedUrl() {
    return K.copyText(UNIFIED_URL).then(function (ok) {
      if (ok) showToast('已复制接入 URL', 'success', 1500);
      else showToast('复制被浏览器拒绝，请手动复制：' + UNIFIED_URL, 'error', 5000);
      return ok;
    });
  }

  // 主信号 /api/readyz（无 auth、最稳）：配了几个 / 几个在跑 / 哪个卡住。
  // 次信号 /api/cost/watchtower 全时段请求数：best-effort——读失败或账本未开都不阻断主判据，
  // 只是少一句「已跑通 N 笔」的确认。
  function load() {
    var card = document.getElementById('onboardingCard');
    var body = document.getElementById('onboardingBody');
    if (!card || !body) return;
    // 可见 URL 与复制目标同源（见 UNIFIED_URL 注释）。
    var urlEl = document.getElementById('unifiedIngressUrl');
    if (urlEl) urlEl.textContent = UNIFIED_URL;
    // 诚实的一次性关闭：点过「不再提示」就整卡隐藏，不反复打扰。
    if (isDismissed()) { card.style.display = 'none'; return; }
    card.style.display = '';
    wireDismiss();

    // 加载态：内联「读取中」，不依赖 states.js（states.js 没及时到也不白屏）。
    body.innerHTML = '<div class="empty-state"><div class="empty-icon">' +
      '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
      '<div class="empty-text">正在读取运行状态…</div></div>';

    fetchJSON('/api/readyz')
      .then(function (rz) {
        // 次信号 best-effort：读失败/未开账本都退回 req=null，不影响「下一步」判断。
        return fetchJSON('/api/cost/watchtower?days=3650')
          .then(function (w) {
            var req = (w && w.spend && w.spend.requestCount) || 0;
            render(rz, req);
          })
          .catch(function () { render(rz, null); });
      })
      .catch(function (err) {
        // 读失败绝不渲染成「空/隐藏」：明说读不到 + 重试。用本面板既有的 showReadError
        // （role=alert + 注册式重试，与 loadHealthPage 等同一套），不引入 MPStates 依赖——
        // 面板读不到时仍给重试，绝不装「没有代理」。
        showReadError('onboardingBody',
          '运行状态读不到',
          (err && err.message) || 'manager 不可达',
          '这里显示的是「读不到」，不是「没有代理」——两者不能混。可点重试，或确认 manager 是否在运行。',
          load);
      });
  }

  // 把 readyz + 请求数算成「现在到第几步 / 下一步做什么」。
  function render(rz, reqCount) {
    var body = document.getElementById('onboardingBody');
    var sub = document.getElementById('onboardingSubtitle');
    var dismiss = document.getElementById('onboardingDismiss');
    if (!body) return;

    var proxies = (rz && rz.proxies) || {};
    var total = proxies.total || 0;
    var running = proxies.reachable || 0;
    var details = proxies.details || [];
    var done = (typeof reqCount === 'number' && reqCount > 0);

    if (sub) sub.textContent = onboardStateLine(total, running, done, reqCount);

    // 已跑通：整卡收成一行确认 + 看账本入口，不再列三步（不 nag）。
    if (done) {
      body.innerHTML =
        '<div class="empty-state">' +
          '<div class="empty-icon" style="color:var(--color-success);">' +
            '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</div>' +
          '<div class="empty-text">已跑通 ' + reqCount + ' 笔请求 · 能力已在生效</div>' +
          '<div class="empty-hint">每笔花销按 agent 归因、本地流量零成本、账本归你。</div>' +
          '<button class="btn btn-outline btn-sm" type="button" style="margin-top:8px;" data-onboard-cost>查看账本 →</button>' +
        '</div>';
      if (dismiss) dismiss.style.display = 'none';
      wireCtas(body);
      return;
    }

    // 未跑通：列三步，高亮「现在该做」的那一步；全没跑时明说「这不是故障」。
    body.innerHTML = onboardStepsHtml(total, running, details);
    if (dismiss) dismiss.style.display = '';
    wireCtas(body);
  }

  function onboardStateLine(total, running, done, reqCount) {
    if (done) return '现在：' + running + ' 个代理在跑 · 已接入 ' + reqCount + ' 笔请求';
    if (total === 0) return '现在：还没装任何代理';
    if (running === 0) return '现在：配了 ' + total + ' 个代理，但一个都没在跑';
    return '现在：' + running + ' 个代理在跑 · 还没发过请求';
  }

  // 三步黄金路径。current：0=还没装 / 1=该起代理 / 2=该接 agent 发请求。
  // 文案全部是事实（哪一步、为什么），不自证、不装饰。
  function onboardStepsHtml(total, running, details) {
    var current = total === 0 ? 0 : (running === 0 ? 1 : 2);

    // 全没跑时的「这不是故障」说明：九行红字本身不构成信息，第一次进来的人只会把
    // 「都没在跑」读成「整机坏了」，所以必须当场把常态说破。
    var note;
    if (total === 0) {
      note = '还没装任何代理 —— 这是「刚 clone 完、还没装代理」的常态，不是故障。'
        + '先装：<code>bash install.sh --all</code>，再回到这里。';
    } else if (running === 0) {
      // 配了但一个没跑：把第一个卡住代理的「原因 + 该干什么」带出来（复用 health 页判据）。
      var downOne = null;
      for (var i = 0; i < details.length; i++) {
        if (details[i] && !details[i].reachable) { downOne = details[i]; break; }
      }
      var why = downOne ? ' · ' + reasonOf(downOne.reason, false) : '';
      note = '没有任何代理在运行 —— 这是「装了但还没起」的常态，不是故障。'
        + '起法：<code>bash manage.sh start</code>' + why + '。';
    } else {
      note = '还没发过请求 —— 代理已经在跑、能力随时可用，这不是故障。'
        + '把 agent 指过来发一笔，下方「账本主权」卡就会亮出第一笔真实账单。';
    }

    var steps = [
      { t: '起一个代理', d: '「代理状态」卡点「启动」，或终端跑 <code>bash manage.sh start</code>。' },
      { t: '把 agent 指过来', d: '复制接入 URL，让 agent 的模型出口指向它——只改一个环境变量，不写 agent 文件。' },
      { t: '发第一个请求', d: '发一次请求，回来在「账本主权」看第一笔真实账单，这就是「能力已生效」的证据。' }
    ];

    var rows = steps.map(function (s, i) {
      var status, mark, color;
      if (i < current) { status = 'done'; mark = '✓ 已完成'; color = 'success'; }
      else if (i === current) { status = 'active'; mark = '● 现在做'; color = 'primary'; }
      else { status = 'todo'; mark = '○ 待办'; color = 'text-tertiary'; }
      return '<div class="onboard-step onboard-step-' + status + '" style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--color-border-light);">' +
        '<span style="min-width:64px;font-size:12px;font-weight:600;color:var(--color-' + color + ');">' + mark + '</span>' +
        '<div style="flex:1;font-size:13px;color:var(--color-text-secondary);line-height:1.6;">' +
          '<b style="color:var(--color-text);">' + esc(s.t) + '</b><br>' + s.d +
        '</div>' +
      '</div>';
    }).join('');

    return '<div style="padding:8px 12px;border-radius:8px;background:var(--color-bg-secondary);margin-bottom:10px;font-size:12px;line-height:1.6;color:var(--color-text-secondary);">' + note + '</div>' +
      rows +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
        '<button class="btn btn-primary btn-sm" type="button" data-onboard-copy>复制接入 URL</button>' +
        '<button class="btn btn-outline btn-sm" type="button" data-onboard-tour>3 分钟跑通</button>' +
      '</div>';
  }

  // 接 agent 的 CTA 复用统一接入 URL（单一真源，不复制字面量）；「3 分钟跑通」复制一条
  // 零副作用的演示命令（demo-tour.sh 自带「不改本机任何东西」的零副作用保证）。
  // 全部 addEventListener 绑定（不写内联 onclick 调模块内函数——那会 ReferenceError）。
  function wireCtas(body) {
    var copyBtn = body.querySelector('[data-onboard-copy]');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyUnifiedUrl(); });
    var tourBtn = body.querySelector('[data-onboard-tour]');
    if (tourBtn) tourBtn.addEventListener('click', function () {
      var cmd = 'bash scripts/demo-tour.sh';
      // 与原实现的一处小改：原代码先判 navigator.clipboard 存在，没有就只提示命令、
      // 不尝试复制。copyText 自带 execCommand 兜底且永不 reject，统一走它，
      // 「复制失败也要说话」只有一套口径。
      K.copyText(cmd).then(function (ok) {
        if (ok) showToast('已复制：' + cmd, 'success', 1800);
        else showToast('复制被浏览器拒绝，请手动执行：' + cmd, 'error', 5000);
      });
    });
    var costBtn = body.querySelector('[data-onboard-cost]');
    if (costBtn) costBtn.addEventListener('click', function () {
      // 页面壳的公开面：switchPage 由 dashboard.html 挂到 window（内联 handler 也用它）。
      if (typeof global.switchPage === 'function') global.switchPage('cost');
      else console.error('[views/onboarding] switchPage 未挂载，无法跳到成本页');
    });
  }

  global.MPViews = global.MPViews || {};
  global.MPViews.onboarding = {
    load: load,
    copyUnifiedUrl: copyUnifiedUrl,
    // 单测/排查用：三态文案判定单独可调，不必起浏览器。
    statusLine: onboardStateLine,
    // 单一真源的对外读数（E2E 用它断言「界面显示的 URL = 复制出去的 URL」）。
    unifiedUrl: UNIFIED_URL
  };
})(typeof window !== 'undefined' ? window : globalThis);
