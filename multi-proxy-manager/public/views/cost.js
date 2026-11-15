// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 成本 / 上周账单 / 账本 Hero（cost）
   ----------------------------------------------------------------------------
   阶段 2.3b 第五片（2026-11-15）。为什么这一片可以抽：三个加载函数只依赖
   token + MPStates + 五个固定容器 id（costBalanceList / costBudgetInfo /
   watchtowerSummary / watchtowerAgents / watchtowerCaveats / costSovereigntyBody），
   不读 proxyStatus、不写共享状态、不被别的视图调用 —— 与 registry 同形，都是自治片。

   口径纪律（与 l2/watchtower-report.js 同一套，改一处必须改两处）：
     · 算不出的一律画「—」，**绝不折算成 0**（0 会被读成「没花钱 / 没省下」）。
     · 不知道币种就不印货币符号。
     · 「已省金额」是反事实重算，负值如实显示（意思是「路由帮你多花了钱」）。
     · 「读不到」与「没有」必须分开：读失败要带出后端原因，不许伪装成空态。

   依赖（必须先加载，见 dashboard.html head）：
     · mp-kernel.js → MPKernel.fetchJSON / getToken
     · states.js    → MPStates.empty / error / registerRetry（运行时才用到，晚于本文件加载也算可用）

   公开面：window.MPViews.cost.{ loadPage, loadWatchtower, loadSovereignty }
           另挂 window.loadCostPage / loadWatchtower / loadCostSovereignty
           —— 三者都是**静态 HTML 内联 handler**（成本页「刷新」、周报「刷新」、
           总览账本卡「刷新」），按全局作用域解析函数名（见 D-017 / D-018）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/cost] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  // 页面 IIFE 里有 `var fetchJSON = MPKernel.fetchJSON` 这类本地别名，模块里没有
  // 那个作用域 —— 直接裸调 `fetchJSON(...)` 会抛 ReferenceError（实测：成本页三个
  // 接口全不请求，余额区静静停在「暂无余额数据」，看起来像「没有数据」）。
  // 所以模块一律显式从 K 取，不假设任何页面本地别名存在。
  var fetchJSON = K.fetchJSON;

  // ---- P5 成本页：各 provider 余额 + 当前周期预算判级 ----
 function loadCostPage() {
   var balList = document.getElementById('costBalanceList');
   var budInfo = document.getElementById('costBudgetInfo');
   var hdr = document.getElementById('costPageSubtitle') || document.querySelector('div#page-cost .page-subtitle');
   var authHdr = { 'x-auth-token': K.getToken() || '' };

   // /api/balances — 各 provider 实时余额
   // 2026-10-24：原先裸 fetch + 不判 res.ok，后端 500 时响应体被当正常数据读，
   // items 为空 → 渲染「暂无余额数据」。「读不到」被显示成「没有」，正是本项目
   // unknown 态对账纪律明令禁止的那种混淆。改用 fetchJSON + 三态。
   fetchJSON('/api/balances', { headers: authHdr })
     .then(function(data) {
       var items = Array.isArray(data) ? data : (data.balances || []);
       if (items.length === 0) {
         balList.innerHTML = MPStates.empty({ title: '暂无余额数据', hint: '配置 provider 并完成一次请求后这里才会出数。' });
       } else {
         balList.innerHTML = items.map(function(item) {
           // 支持两种格式: {name, amount} 数组 或 {providerName: value} 对象
           var name = item.name || item.provider || 'unknown';
           var amount = item.amount != null ? item.amount : (typeof item === 'object' ? item[Object.keys(item)[0]] : item);
           var amountStr = typeof amount === 'number' ? '\u00a5' + amount.toFixed(2) : String(amount);
           return '<div class="proxy-card-item" style="padding:10px 14px;border-bottom:1px solid var(--border,#eef2f7);">' +
             '<div style="display:flex;justify-content:space-between;align-items:center;">' +
             '<span style="font-weight:600;color:var(--foreground);">' + name + '</span>' +
             '<span style="font-size:14px;color:var(--muted-foreground);">' + amountStr + '</span>' +
             '</div></div>';
         }).join('');
       }
     })
     .catch(function(e) {
       MPStates.registerRetry('dashboard:balances', loadCostPage);
       balList.innerHTML = MPStates.error({
         title: '余额读取失败',
         detail: (e && e.message) || '未知错误',
         hint: '这是「读不到」，不是「没有余额」。',
         retryKey: 'dashboard:balances'
       });
     });

   // /api/budget — 当前周期预算判级快照（P7-2 起含 prices/caps/configHash）
   // 同 balances：原先不判 res.ok，后端 500 时 b.level 缺失 → 显示「未配置预算」，
   // 把「读不到」显示成「你没配」。
   fetchJSON('/api/budget', { headers: authHdr })
     .then(function(b) {
       // P0 修：后端 /api/budget 返回的是 level（ok|warn|blocked），不是 status；
       // 读 status 恒为 undefined ⇒ 配了预算也永远显示"未配置"。
       // 2026-11-07 修两处落差（D7）：
       // ① 原 hint 让用户去设 PROXY_COST_BUDGET 再重启——那个变量只喂 alert 阈值
       //    (routes/alert.js:69)，对本路由零影响；/api/budget 只认 budget.json 且 hardCap>0
       //    (routes/budget.js:64)。照原提示做，卡片永远停在「未配置」＝声明态≠运行态。
       // ② 原判断把「配置畸形/读失败」与「没配」并成同一个空态＝unknown 降级成 negative。
       //    现按返回的 reason 分开：只有 no-budget-config 才是真的没配。
       if (!b || !b.level) {
         var budReason = (b && b.reason) || '';
         var budUnconfigured = !!(b && b.enabled === false &&
           (budReason === 'no-budget-config' || budReason === ''));
         if (budUnconfigured) {
           budInfo.innerHTML = MPStates.empty({
             title: '未配置预算 · 零行为变更',
             hint: '建本机预算文件（hardCap > 0）后刷新即可看到判级；该文件只负责显示，是否真拦截由预算开关控制（默认关）。'
           });
         } else {
           budInfo.innerHTML = MPStates.error({
             title: '预算读不到 · 不是「没配预算」',
             detail: budReason || '返回里既无 level 也无 reason',
             hint: '修好 ~/.multi-proxy-manager/budget.json 后刷新重试。'
           });
         }
         return;
       }
       var levelClass = b.level === 'ok' ? 'green' : b.level === 'warn' ? 'orange' : 'red';
       var levelText = b.level === 'ok' ? '正常' : b.level === 'warn' ? '警告' : '越限';
       var caps = b.caps || {};
       var priceCount = b.prices ? Object.keys(b.prices).length : 0;
       budInfo.innerHTML =
         '<div style="display:flex;gap:16px;flex-wrap:wrap;">' +
         '<div style="flex:1;min-width:160px;padding:14px;background:var(--border);border-radius:8px;">' +
           '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:4px;">当前判级</div>' +
           '<div style="font-size:20px;font-weight:700;color:var(--' + levelClass + '-accent,#' + (b.level==='ok'?'10b981':b.level==='warn'?'f59e0b':'ef4444') + ');">' +
             levelText + '</div>' +
           '</div>' +
         '<div style="flex:1;min-width:160px;padding:14px;background:var(--border);border-radius:8px;">' +
           '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:4px;">价表模型数</div>' +
           '<div style="font-size:20px;font-weight:700;color:var(--foreground);">' + priceCount + '</div>' +
           '</div>' +
         '<div style="flex:1;min-width:160px;padding:14px;background:var(--border);border-radius:8px;">' +
           '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:4px;">总上限</div>' +
           '<div style="font-size:20px;font-weight:700;color:var(--foreground);">' +
             (caps.total ? '\u00a5' + caps.total : '不限制') +
           '</div>' +
           '</div>' +
         '</div>' +
         (b.configHash ?
           '<div style="margin-top:10px;font-size:11px;color:var(--muted-foreground);">configHash: ' + b.configHash.slice(0,16) + ' ...</div>' : '');
     })
     .catch(function() { budInfo.innerHTML = '<div class="empty-state"><div class="empty-text">无法获取预算数据</div></div>'; });
  }

 // ---- 上周账单（Watchtower v1，2026-10-16）----
 // 口径纪律（与 l2/watchtower-report.js 同一套，改一处必须改两处）：
 //   - 算不出的一律画「—」，**绝不折算成 0**。0 会被读成「没花钱 / 没省下」。
 //   - 不知道币种就不印货币符号（report.spend.currency 为 null 时）。
 //   - 「已省金额」是反事实重算（对标花费 − 实际花费），负值如实显示，
 //     意思是「路由帮你多花了钱」——截断成 0 会把这个信号藏掉。
 function wtMoney(v, cur) {
   if (v === null || v === undefined || !isFinite(v)) return '—';
   var s = (cur ? cur + ' ' : '') + (Math.round(v * 10000) / 10000);
   return s;
 }
 function wtEsc(s) {
   return String(s === null || s === undefined ? '' : s)
     .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
 }
 function loadWatchtower() {
   var sum = document.getElementById('watchtowerSummary');
   var ags = document.getElementById('watchtowerAgents');
   var cav = document.getElementById('watchtowerCaveats');
   var authHdr = { 'x-auth-token': K.getToken() || '' };

   fetch('/api/cost/watchtower?days=7', { headers: authHdr })
     .then(function(r) { return r.json(); })
     .then(function(w) {
       if (!w || w.ok !== true) {
         // 读失败必须带出后端原因：只说「周报读取失败」不说为什么，
         // 读者无法判断是 manager 挂了、账本被锁，还是自己没开记账。
         sum.innerHTML = '<div class="empty-state">' +
           '<div class="empty-text" style="color:#d97706;">周报读取失败</div>' +
           '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:6px;max-width:420px;">' +
           wtEsc((w && w.error) || '未知错误') + '</div></div>';
         ags.innerHTML = ''; cav.innerHTML = '';
         return;
       }
       var cur = (w.spend && w.spend.currency) || null;
       var win = (w.window && w.window.fromDay && w.window.toDay)
         ? (w.window.fromDay + ' ~ ' + w.window.toDay) : '—';
       // 门控提示条：PROXY_COST_TRACK 默认关，「没开记账」和「开了但没流量」
       // 在面板上长得一模一样（都是空），读者会默认前者是工具坏了。
       // 所以 hint 必须比卡片先出现——先解释为什么空，再给数字。
       var hintHtml = '';
       if (w.tracking && w.tracking.hint) {
         var warn = !w.tracking.enabled;
         hintHtml =
           '<div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.6;' +
           'background:' + (warn ? 'rgba(239,68,68,0.08)' : 'var(--color-bg-secondary)') + ';' +
           'border:1px solid ' + (warn ? 'rgba(239,68,68,0.35)' : 'var(--color-border)') + ';' +
           'color:' + (warn ? '#ef4444' : 'var(--muted-foreground)') + ';">' +
           (warn ? '未开启记账 · ' : '') + wtEsc(w.tracking.hint) + '</div>';
       }
       var cards = [
         { label: '实际花费', value: wtMoney(w.spend && w.spend.actualCost, cur),
           sub: ((w.spend && w.spend.requestCount) || 0) + ' 次请求' },
         { label: '模型重写已省', value: w.saved && w.saved.computable ? wtMoney(w.saved.byRouting, cur) : '—',
           sub: w.saved && w.saved.computable
             ? ('对标花费 ' + wtMoney(w.saved.baselineCost, cur))
             : ('算不出：' + wtEsc(w.saved && w.saved.reason)) },
         { label: '零花费请求占比', value: (w.zeroCost && w.zeroCost.ratio !== null && w.zeroCost.ratio !== undefined)
             ? Math.round(w.zeroCost.ratio * 100) + '%' : '—',
           sub: ((w.zeroCost && w.zeroCost.requestCount) || 0) + ' / ' + ((w.spend && w.spend.requestCount) || 0) },
         // 账本完整度：字段缺失比例高时，上面三个数都别太当真。
         { label: '账本完整度', value: (w.dataQuality && w.dataQuality.unknownModelRatio !== null && w.dataQuality.unknownModelRatio !== undefined)
             ? Math.round((1 - w.dataQuality.unknownModelRatio) * 100) + '%' : '—',
           sub: (w.dataQuality
               ? ('缺模型名 ' + w.dataQuality.unknownModelCount + '/' + w.dataQuality.entryCount + ' 条'
                  + (w.dataQuality.unknownAgentCount > 0 ? ' · 缺 agent ' + w.dataQuality.unknownAgentCount + ' 条' : ''))
               : '—') }
       ];
       sum.innerHTML = hintHtml +
         '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:10px;">窗口 ' + wtEsc(win) + '</div>' +
         '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
         cards.map(function(c) {
           var neg = (c.value.indexOf('-') === 0);
           return '<div style="flex:1;min-width:150px;padding:14px;background:var(--color-bg-secondary);border-radius:8px;">' +
             '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:4px;">' + c.label + '</div>' +
             '<div style="font-size:20px;font-weight:700;color:' + (neg ? '#ef4444' : 'var(--foreground)') + ';">' + wtEsc(c.value) + '</div>' +
             '<div style="font-size:11px;color:var(--muted-foreground);margin-top:4px;">' + c.sub + '</div>' +
           '</div>';
         }).join('') +
         '</div>';

       if (!w.byAgent || w.byAgent.length === 0) {
         ags.innerHTML = '<div class="empty-state"><div class="empty-text">本窗口没有账本记录（门控未开 / 代理未上报 / 无流量）</div></div>';
       } else {
         ags.innerHTML =
           '<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:6px;">按 agent</div>' +
           w.byAgent.map(function(a) {
             return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--color-border);">' +
               '<span style="font-weight:600;">' + wtEsc(a.agent) + '</span>' +
               '<span style="color:var(--muted-foreground);">' + wtMoney(a.actualCost, cur) +
               ' · ' + a.requests + ' 次 · ' + wtEsc(a.topModel || '—') + '</span>' +
             '</div>';
           }).join('');
       }

       cav.innerHTML = (w.caveats && w.caveats.length)
         ? '<div style="font-size:11px;color:var(--muted-foreground);line-height:1.6;">口径说明：<br>' +
           w.caveats.map(function(c) { return '· ' + wtEsc(c); }).join('<br>') + '</div>'
         : '';
     })
     .catch(function() {
       sum.innerHTML = '<div class="empty-state"><div class="empty-text">无法获取周报（manager 未运行或未登录）</div></div>';
       ags.innerHTML = ''; cav.innerHTML = '';
     });
 }

 // ---- 账本主权 Hero（2026-10-21）----
 // 与 loadWatchtower 同源（/api/cost/watchtower），但只取首屏最该被看见的三数 + 一条差异化宣言。
 // 口径纪律同 loadWatchtower：算不出一律画「—」，绝不折算成 0。
 function loadCostSovereignty() {
   var body = document.getElementById('costSovereigntyBody');
   if (!body) return;
   fetch('/api/cost/watchtower?days=7', { headers: { 'x-auth-token': K.getToken() || '' } })
     .then(function(r) { return r.json(); })
     .then(function(w) {
       if (!w || w.ok !== true) {
         // 读失败必须带出后端原因（同 loadWatchtower 纪律），不要只说「读取失败」。
         body.innerHTML = '<div class="empty-state"><div class="empty-text" style="color:#d97706;">账本读取失败</div>' +
           '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:6px;">' + wtEsc((w && w.error) || '未知错误') + '</div></div>';
         return;
       }
       // 2026-11-14（梳理 2.1 · 看账面唯一职责）：
       // 同一份 /api/cost/watchtower 曾在本卡与「成本」页各渲染一遍，连「为什么这样算」的
       // 解释块都抄了两份 —— 两处口径迟早漂移，用户也分不清哪个是准的。
       // 现在本卡只承担一件事：总览报「上周花了多少」这一个数 + 一个入口；
       // 按 agent/模型归因、省了多少、零花费占比的明细与口径统一归「成本」页（loadWatchtower）。
       var cur = (w.spend && w.spend.currency) || null;
       var actual = wtMoney(w.spend && w.spend.actualCost, cur);
       var reqs = (w.spend && w.spend.requestCount) || 0;
       body.innerHTML =
         '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">' +
           '<div style="font-size:28px;font-weight:700;line-height:1;' +
             (String(actual).charAt(0) === '-' ? 'color:#ef4444;' : '') + '">' + wtEsc(actual) + '</div>' +
           '<div style="font-size:12px;color:var(--muted-foreground);">上周实际花费 · ' + reqs + ' 次请求</div>' +
         '</div>' +
         '<div style="font-size:12px;color:var(--muted-foreground);line-height:1.7;margin:10px 0 12px;">' +
           '按 agent / 模型归因、模型重写省了多少、零花费占比 —— 明细与口径在「成本」页。' +
         '</div>' +
         '<button class="btn btn-outline btn-sm" type="button" onclick="switchPage(\'cost\')">看成本明细</button>';
     })
     .catch(function() {
       body.innerHTML = '<div class="empty-state"><div class="empty-text">无法获取账本（manager 未运行或未登录）</div></div>';
     });
 }

  // ===== 全局暴露（内联 handler 在全局作用域解析，见 D-017）=====
  global.loadCostPage = loadCostPage;
  global.loadWatchtower = loadWatchtower;
  global.loadCostSovereignty = loadCostSovereignty;

  global.MPViews = global.MPViews || {};
  global.MPViews.cost = {
    loadPage: loadCostPage,
    loadWatchtower: loadWatchtower,
    loadSovereignty: loadCostSovereignty
  };
})(window);
