// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · 今天（today）
   ----------------------------------------------------------------------------
   阶段 2.3b 第三片（2026-11-14）。数据源只有一个端点 /api/today，它内部调
   l2/report.js —— 与 `costgate today` 是同一个函数。这里**不做二次计算**
   （不再自己加总、不再自己算平均）：一旦前端开始自己算，CLI 和面板迟早给出
   两个不同的数，那种账不如没有。

   本片自治度最高：全部辅助函数（todayNum / todayTokens / todayHm / 横幅 /
   日期下拉 / 文件行渲染 / who 查询）只服务本视图，不碰轮询、不碰共享状态、
   连页面壳的加载条都不用（账本读得快，不值得一根进度条）。

   依赖：mp-kernel.js（esc / fetchJSON / getToken），必须先加载。
   公开面：window.MPViews.today.{ load, loadDays }
           window.loadTodayPage / window.lookupWho（HTML 内联 handler 出口）
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/today] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  var esc = K.esc;

function todayNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}
function todayTokens(n) {
  var v = Number(n || 0);
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return todayNum(v);
}
function todayHm(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '--:--';
  var p = function (x) { return String(x).padStart(2, '0'); };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function showTodayBanner(text) {
  var b = document.getElementById('todayBanner');
  var t = document.getElementById('todayBannerText');
  if (!b || !t) return;
  t.textContent = text;
  b.classList.remove('hidden');
}
function hideTodayBanner() {
  var b = document.getElementById('todayBanner');
  if (b) b.classList.add('hidden');
}

// 日期下拉：只列账本里真有的日子，不造空日期（造了会让人以为"那天跑了但没记"）
function loadTodayDays() {
  var sel = document.getElementById('todayDayPicker');
  if (!sel) return;
  K.fetchJSON('/api/today/days', { headers: { 'x-auth-token': K.getToken() || '' } }).then(function (d) {
    var cur = sel.value;
    var keep = ['<option value="">今天</option>'];
    (d.days || []).slice().reverse().forEach(function (day) {
      keep.push('<option value="' + esc(day) + '">' + esc(day) + '</option>');
    });
    sel.innerHTML = keep.join('');
    sel.value = cur || '';
  }).catch(function () { /* 日期列表拿不到不影响主数据，静默跳过 */ });
}

async function loadTodayPage(day) {
  var q = day ? ('?day=' + encodeURIComponent(day)) : '';
  try {
    var data = await K.fetchJSON('/api/today' + q, { headers: { 'x-auth-token': K.getToken() || '' } });
    renderTodayReport(data);
    loadTodayDays();
  } catch (e) {
    // 读失败绝不渲染成「今天 0 次请求」—— 那会让人以为今天没花钱，是最危险的一种假绿
    showTodayBanner('读不到账本：' + (e.message || e) + '。这不代表今天没有请求，只代表这次没读到。');
    ['todayRequests', 'todayTokens', 'todayFiles'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    var msg = '<div class="empty-state"><div class="empty-text">读不到账本，重试一次</div></div>';
    var al = document.getElementById('todayAgentList'); if (al) al.innerHTML = msg;
    var fl = document.getElementById('todayFileList'); if (fl) fl.innerHTML = msg;
  }
}

function renderTodayReport(data) {
  if (!data || !data.ok) { showTodayBanner('接口返回异常，这次没读到账。'); return; }
  var r = data.report;
  if (data.mode === 'fallback') {
    r = data.fallback.lastDay;
    showTodayBanner(data.note + '（下面显示的是 ' + r.day + '）');
  } else if (data.mode === 'empty') {
    showTodayBanner('账本里还没有任何记录。把 agent 的 base_url 指到 costgate 的端口跑一次，或者跑一次 costgate watch 开始记文件改动。');
  } else if ((r.usage || {}).requests === 0 && r.hasData) {
    // 有文件改动、但一次请求都没记到 —— 这多半是 agent 还没指向本机端口，
    // 不是"今天没干活"。不说清楚的话，那个 0 会被读成"没在记账"。
    showTodayBanner('今天还没有 agent 请求经过 costgate（文件改动已记 ' + todayNum(r.files.total)
      + ' 条）。把 agent 的 base_url 指向 127.0.0.1:18880，请求就会开始进账本。');
  } else {
    hideTodayBanner();
  }

  var hint = document.getElementById('todayModeHint');
  if (hint) hint.textContent = (r.day === data.today) ? '今天的账 · ' + r.day : r.day + ' 的账';

  var u = r.usage || {};
  var tokens = (u.prompt || 0) + (u.completion || 0);
  var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('todayRequests', todayNum(u.requests));
  set('todayTokens', todayTokens(tokens));
  set('todayFiles', todayNum(r.files ? r.files.total : 0));
  set('todayUnattributed', todayNum(r.files ? r.files.unattributed : 0));

  // —— 按 agent 分：请求账和文件账并排，因为同一个 agent 的两本账放在一行才对得上 ——
  var usageBy = {};
  (r.byAgent || []).forEach(function (a) { usageBy[a.agent] = a; });
  var fileBy = {};
  ((r.files && r.files.byAgent) || []).forEach(function (a) { fileBy[a.agent] = a; });
  var names = Object.keys(usageBy);
  Object.keys(fileBy).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); });
  names.sort(function (a, b) {
    var ra = (usageBy[a] ? usageBy[a].requests : 0);
    var rb = (usageBy[b] ? usageBy[b].requests : 0);
    if (rb !== ra) return rb - ra;
    return ((fileBy[b] ? fileBy[b].count : 0) - (fileBy[a] ? fileBy[a].count : 0));
  });

  var sub = document.getElementById('todayAgentSub');
  if (sub) {
    // 「未归因」不是某个 agent，别把它数进 agent 个数里 —— 否则读起来像真有这么个 agent
    var real = names.filter(function (n) { return n !== 'unknown'; });
    var parts = [];
    if (real.length) parts.push('共 ' + real.length + ' 个 agent 有记录');
    if (names.indexOf('unknown') >= 0) {
      parts.push('另有 ' + todayNum((r.files && r.files.unattributed) || 0) + ' 个文件改动归不到具体 agent');
    }
    sub.textContent = parts.length ? parts.join(' · ') : '这一天没有任何 agent 记录';
  }

  var box = document.getElementById('todayAgentList');
  if (box) {
    if (!names.length) {
      box.innerHTML = '<div class="empty-state"><div class="empty-text">这一天没有记录</div></div>';
    } else {
      box.innerHTML = names.map(function (name) {
        var ua = usageBy[name] || { requests: 0, prompt: 0, completion: 0, cost: 0, unpriced: 0, topModels: [] };
        var fa = fileBy[name] || { count: 0, creates: 0, modifies: 0, deletes: 0 };
        var isUnknown = (name === 'unknown');
        var models = (ua.topModels || []).join(' · ');
        var left = '<div style="font-size:13px;font-weight:600;">' + esc(isUnknown ? '未归因' : name) + '</div>'
          + (models ? '<div style="font-size:12px;color:var(--color-text-tertiary);">' + esc(models) + '</div>' : '');
        var right = [];
        if (ua.requests) right.push(todayNum(ua.requests) + ' 次请求');
        if (ua.requests) right.push(todayTokens((ua.prompt || 0) + (ua.completion || 0)) + ' tokens');
        if (fa.count) {
          var f = todayNum(fa.count) + ' 个文件';
          if (fa.deletes) f += '（删 ' + fa.deletes + '）';
          right.push(f);
        }
        return '<div class="alert-item">'
          + '<div style="flex:1;min-width:0;overflow:hidden;">' + left + '</div>'
          + '<div style="font-size:12px;color:var(--color-text-secondary);text-align:right;white-space:nowrap;">'
          + esc(right.join(' · ')) + '</div>'
          + '</div>';
      }).join('');
    }
  }

  // —— 文件账明细：给具体路径。只给汇总等于没回答「谁动了我的文件」 ——
  var fsub = document.getElementById('todayFileSub');
  if (fsub) {
    fsub.textContent = (r.recentFiles && r.recentFiles.length)
      ? '按时间倒序，最近 ' + r.recentFiles.length + ' 条'
      : '这一天没有文件改动记录';
  }
  var flist = document.getElementById('todayFileList');
  if (flist) {
    flist.innerHTML = renderFileRows(r.recentFiles || []);
  }

  // —— 要注意 ——
  var card = document.getElementById('todayAlertsCard');
  var list = document.getElementById('todayAlertList');
  if (card && list) {
    if (!r.alerts || !r.alerts.length) {
      card.classList.add('hidden');
      list.innerHTML = '';
    } else {
      card.classList.remove('hidden');
      list.innerHTML = r.alerts.map(function (a) {
        var items = (a.items || []).map(function (it) {
          return '<div style="font-size:12px;color:var(--color-text-tertiary);">' + esc(it.path) + '</div>';
        }).join('');
        return '<div class="alert-item"><div style="flex:1;">'
          + '<div style="font-size:13px;font-weight:600;">' + esc(a.text) + '</div>' + items
          + '</div></div>';
      }).join('');
    }
  }
}

// 文件改动行。事件名、置信档都照实写 —— 置信 unknown 不等于"没记到"，是"记到了但归因不了"。
// 路径显示相对 home（后端给的 rel），绝对路径一排排铺满屏幕时，
// 真正有信息量的「哪一段变了」反而被截断掉。
function renderFileRows(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-text">没有文件改动记录</div></div>';
  return rows.map(function (r) {
    var ev = r.event === 'delete' ? '删除' : (r.event === 'create' ? '新建' : '修改');
    var who = (r.agent === 'unknown' || !r.agent) ? '未归因' : r.agent;
    var color = r.event === 'delete' ? 'var(--color-danger, #d33)' : 'var(--color-text-secondary)';
    var shown = r.rel || r.path;
    return '<div class="alert-item" style="padding:10px 14px;">'
      + '<div style="font-size:12px;color:var(--color-text-tertiary);width:44px;flex:none;">' + esc(todayHm(r.ts)) + '</div>'
      + '<div style="font-size:12px;width:34px;flex:none;color:' + color + ';">' + esc(ev) + '</div>'
      + '<div style="font-size:12px;width:88px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(r.agent || 'unknown') + '">' + esc(who) + '</div>'
      + '<div style="flex:1;min-width:0;font-size:12px;font-family:var(--font-mono, ui-monospace, monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(r.path || shown) + '">' + esc(shown) + '</div>'
      + '</div>';
  }).join('');
}

// 「这个文件被谁动过」= CLI 的 costgate who。查不到就说查不到，不猜。
async function lookupWho() {
  var input = document.getElementById('todayWhoInput');
  var box = document.getElementById('todayWhoResult');
  if (!input || !box) return;
  var q = input.value.trim();
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="empty-state"><div class="empty-text">查询中…</div></div>';
  try {
    var d = await K.fetchJSON('/api/today/file?match=' + encodeURIComponent(q), { headers: { 'x-auth-token': K.getToken() || '' } });
    if (!d.rows || !d.rows.length) {
      box.innerHTML = '<div class="empty-state"><div class="empty-text">账本里没有 ' + esc(q) + ' 的记录</div></div>';
      return;
    }
    box.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:8px;">'
      + esc(q) + ' · 共 ' + d.rows.length + ' 条</div>' + renderFileRows(d.rows);
  } catch (e) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">查询失败：' + esc(e.message || String(e)) + '</div></div>';
  }
}


  global.MPViews = global.MPViews || {};
  global.MPViews.today = { load: loadTodayPage, loadDays: loadTodayDays };
  // 内联 handler 的全局出口（本文件的两个 HTML 入口）。见 dashboard.html
  // 「内联 handler 的全局暴露」段与守卫 tests/node/panel-inline-handlers.test.js。
  global.loadTodayPage = loadTodayPage;
  global.lookupWho = lookupWho;
})(typeof window !== 'undefined' ? window : globalThis);
