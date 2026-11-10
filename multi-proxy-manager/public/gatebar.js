// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// 能力门控状态条（全站公共，2026-10-24）
//
// 存在理由：外部审计的核心结论——README 承诺的能力按「非侵入」铁律默认门控关闭，
// 而面板从头到尾不告诉用户「没开」，于是用户把「未开启」读成「没做 / 假功能」。
// 这一条 UI 的天职只有一个：**永远直说当前开没开**。
//
// 三条不可退让的纪律（违反任何一条都会让它变回谎言）：
//   ① 读失败 ≠ 全关。/api/gates 挂了必须渲染成「读不到」并给重试，
//      绝不能 fallback 成「全部未开启」——那正是我们要消除的那个误读。
//   ② 跨进程门控（cursor 等其它进程持有）读不到就标「未知」，不拿默认值冒充当前值。
//   ③ 每一项都给出可复制的开启方式，用户不用去翻 README。
//
// 集成方式：在 states.js 之后引入本文件即可，无需页面写占位 DOM——
// 它会自己找一个合适的落点插进去；页面若已有 #gateBar 则直接复用。
// 想关掉某页：<body data-gatebar="off">。
//
// 合流重设计（2026-10-25，N-04）——三层结构，把「用户语言」与「技术明细」分开：
//   顶行（默认常驻）：系统点（绿/红）+ 3 个用户语言「姿态」chip（路由 / 成本 / 编排）
//   ＋「开箱默认态 / 灰度中 N 项」整体徽标 ＋「展开全部」入口。
//   展开后：全部技术 chip（绿=已开 / 灰=未开 / 琥珀=影子·只记录）＋逐门禁明细表（含运行痕迹）＋开启方式。
//  拍板定调（老板 2026-10-25）：
//   ① 3 用户语言 chip 为骨架，全部技术 chip 折叠进「展开全部」（默认隐藏，DOM 仍在，
//      所以「未开启≠缺失」口径不因折叠而减弱；折叠只是视觉，不删数据）。
//   ② 影子/观察中主色统一成琥珀黄（--color-warning 族），绿=生效、灰=关闭/未配置，与
//      states.js 的 warn 族同源（colors_and_type.css / tokens.css 全 9 页已定义）。
//   ③ 影子↔生效保持「改 .env + 重启」，状态条只做状态提示，不提供一键改热路径的开关。
//  这 3 个「姿态」chip 不是新数据，是把 /api/gates 的既有 gate / summary 重排成用户读得懂的话。
//
// 第四层：运行证据（2026-11-08）——回答「开着，但真的跑过吗？」
//   背景：上面三层都在说「开没开」，但「开着」有两种含义用户分不出来：
//     (a) 开着且在跑（有入账/命中）　(b) 开着但一次没走过（可能根本没接线）
//   两种都画绿 ⇒ (b) 被读成 (a)，是「假功能」指控的同一种落差换了个位置。
//   做法：/api/gates 每项带 evidence（hits / lastAt / source，由 lib/gate-evidence.js 采）。
//     · 成本姿态 chip：有正数 → 绿 +「真入账 N 笔」；开着但 0 → 琥珀「空转」；采不到 →「无运行证据」
//     · 技术 chip：只在有正数时挂「 · N 笔」（13 项都挂「0 次」会把真数字淹掉）
//     · 明细表「运行痕迹」列：有数字绿 / 0 琥珀 / 读不到灰 / 无采集点写「无采集点」
//   纪律：**「无采集点」≠「没生效」，「0 次」≠「没做」**。这两种误读必须靠文案当场掐掉，
//   否则这一层就成了新造的一个谎。

(function (global) {
  'use strict';

  var STYLE_ID = 'mp-gatebar-style';
  var CSS =
    '.mp-gatebar{border:1px solid var(--color-border);border-radius:10px;padding:12px 14px;' +
    'margin-bottom:14px;background:var(--color-bg-secondary)}' +
    '.mp-gatebar .gate-bar-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;' +
    'font-size:13px;font-weight:600;color:var(--color-text)}' +
    '.mp-gatebar .gateway-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto}' +
    '.mp-gatebar .gateway-dot-ok{background:var(--color-success,#10b981)}' +
    '.mp-gatebar .gateway-dot-err{background:var(--color-danger,#dc2626)}' +
    '.mp-gatebar .mp-lead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-right:2px}' +
    '.mp-gatebar .gate-bar-pill{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;' +
    'border:1px solid var(--color-border);color:var(--color-text-secondary)}' +
    '.mp-gatebar .gate-bar-pill-stock{background:var(--color-warning-light);color:var(--color-warning-deep);' +
    'border-color:var(--color-warning)}' +
    // —— 3 个用户语言「姿态」chip（骨架层，默认常驻）—— 琥珀=影子/观察中、绿=生效、灰=关闭/未配置
    '.mp-gatebar .gate-chip-lead{font-size:12px;padding:4px 10px;border-radius:999px;font-weight:600;' +
    'border:1px solid transparent}' +
    '.mp-gatebar .gate-chip-lead.gate-chip-shadow{background:var(--color-warning-light,#fef3c7);' +
    'color:var(--color-warning-deep,#92400e);border-color:var(--color-warning)}' +
    '.mp-gatebar .gate-chip-lead.gate-chip-on{background:var(--color-success-light,#d1fae5);' +
    'color:var(--color-success-deep,#065f46)}' +
    '.mp-gatebar .gate-chip-lead.gate-chip-off{background:var(--color-bg-tertiary,#f1f5f9);' +
    'color:var(--color-text-tertiary,#5a6779)}' +
    '.mp-gatebar .gate-bar-note{font-size:12px;color:var(--color-text-tertiary);margin-top:6px;line-height:1.6}' +
    // —— 折叠区（默认隐藏，[data-expanded="1"] 时展开）。DOM 始终在，折叠只是视觉 ——
    '.mp-gatebar .mp-gatebar-expand{display:none}' +
    '.mp-gatebar[data-expanded="1"] .mp-gatebar-expand{display:block}' +
    '.mp-gatebar .gate-bar-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}' +
    '.mp-gatebar .gate-chip{font-size:11px;padding:3px 8px;border-radius:6px;' +
    'border:1px solid var(--color-border);color:var(--color-text-tertiary);cursor:default}' +
    '.mp-gatebar .gate-chip.gate-chip-on{border-color:var(--color-success);color:var(--color-success)}' +
    '.mp-gatebar .gate-chip.gate-chip-off{border-color:var(--color-border)}' +
    '.mp-gatebar .gate-chip.gate-chip-unknown{border-style:dashed}' +
    '.mp-gatebar .gate-chip.gate-chip-shadow{border-color:var(--color-warning);color:var(--color-warning-deep,#92400e);' +
    'background:var(--color-warning-light,#fef3c7)}' +
    '.mp-gatebar .gate-chip-lead .lsub{font-size:10px;color:var(--color-text-tertiary)}' +
    '.mp-gatebar .gate-bar-toggle{font-size:12px;color:var(--color-primary);cursor:pointer;' +
    'background:none;border:none;padding:0;text-decoration:underline;margin-left:auto}' +
    // 🔴 table-layout:fixed 是必需的：默认 auto 布局下「运行痕迹」列会被最长的
    // impact 列挤到极窄，中文竖排成一行一个字，行高炸开（2026-11-08 实测踩到）。
    // 列宽由下面的 colgroup 给定，auto 布局没法保证。
    '.mp-gatebar table{width:100%;border-collapse:collapse;margin-top:10px;table-layout:fixed}' +
    // 中文/路径允许在任意位置断行，但不要 break-all 那种逐字断
    '.mp-gatebar td{word-break:normal;overflow-wrap:anywhere;vertical-align:top}' +
    '.mp-gatebar th{text-align:left;font-size:11px;font-weight:600;color:var(--color-text-tertiary);' +
    'padding:0 10px 4px 0;border-bottom:1px solid var(--color-border)}' +
    '.mp-gatebar .ev-src{font-size:11px;color:var(--color-text-tertiary);margin-top:2px;overflow-wrap:anywhere}' +
    '.mp-gatebar .ev-hit{color:var(--color-success)}' +
    '.mp-gatebar .ev-zero{color:var(--color-warning-deep,#92400e)}' +
    '.mp-gatebar .ev-mute{color:var(--color-text-tertiary)}' +
    '.mp-gatebar .ev-none{color:var(--color-text-tertiary);font-size:11px}' +
    // —— 门控格阵（2026-11-08）：M2「一张图」——16 个方块一眼可判 ——
    // 语义与 chip/明细表同源，但压缩成一个可在首屏截图的小块：
    //   实心绿=开着且真跑过 / 空心绿=开着但还没数据 / 实心灰=关闭 / 虚线=读不到 / 琥珀=影子
    // 用固定 8 列 grid 而不是 flex-wrap：wrap 会排成 12+4 那种散点，看着像装饰
    // 而不是「一张图」。固定列 + 外框才读得出「这是一组、共 16 个」。
    '.mp-gatebar .gm{display:inline-grid;grid-template-columns:repeat(8,11px);gap:3px;' +
    'padding:4px 5px;border:1px solid var(--color-border);border-radius:6px;' +
    'background:var(--color-bg);vertical-align:middle}' +
    '.mp-gatebar .gm-cell{width:11px;height:11px;border-radius:3px;display:block;box-sizing:border-box;' +
    'border:1px solid transparent}' +
    '.mp-gatebar .gm-on-hit{background:var(--color-success,#10b981)}' +
    '.mp-gatebar .gm-on-idle{border-color:var(--color-success,#10b981);background:transparent}' +
    '.mp-gatebar .gm-off{background:var(--color-border,#cbd5e1)}' +
    // 「读不到」保持灰虚线而不是琥珀：琥珀已经表示「影子·在跑但不动路由」，
    // 两者含义相反（一个是不知道，一个是知道且在跑），颜色必须能分开。
    '.mp-gatebar .gm-unknown{border:1px dashed var(--color-text-tertiary,#94a3b8);background:transparent}' +
    '.mp-gatebar .gm-shadow{background:var(--color-warning,#f59e0b)}' +
    '.mp-gatebar .gm-legend{font-size:11px;color:var(--color-text-tertiary);margin-top:8px}' +
    '.mp-gatebar .gm-legend span{display:inline-flex;align-items:center;gap:4px;margin-right:12px}' +
    '.mp-gatebar .gm-legend i{width:11px;height:11px;border-radius:3px;display:inline-block;' +
    'box-sizing:border-box;border:1px solid transparent}';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function authHeaders() {
    var t = '';
    try {
      t = sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token') || '';
    } catch (e) {}
    return t ? { 'x-auth-token': t } : {};
  }

  // 找一个不破坏既有布局的落点。
  //
  // 🔴 硬约束：**绝不能作为主容器的兄弟节点插入**。页面的外层布局多是
  // `.layout { display:flex }` + `aside(定宽) + main(flex:1)`，一旦把状态条插成第三个 flex item，
  // 它会分走宽度并把 main 挤扁（实测 floor：main 935px → 56px，#meta 宽度归零）。
  // 所以候选落点一律是「主容器的后代」：页头之后，或主容器内部顶部。
  function resolveHost() {
    var own = document.getElementById('gateBar');
    if (own) {
      // 页面自带占位不一定带样式类（样式全部挂在 .mp-gatebar 下），补上，否则整条裸奔。
      own.className = (own.className ? own.className + ' ' : '') + 'mp-gatebar';
      return own;
    }

    // ① 页头之后：页头本身就在主容器内部，插它后面最贴合视觉顺序
    var header = document.querySelector('.page-header');
    if (header && header.parentNode) {
      var afterHeader = document.createElement('div');
      afterHeader.id = 'gateBar';
      afterHeader.className = 'mp-gatebar';
      header.parentNode.insertBefore(afterHeader, header.nextSibling);
      return afterHeader;
    }

    // ② 兜底：插进主容器内部顶部（是后代，不参与外层 flex 分配）
    var main = document.querySelector('main') ||
               document.querySelector('.content') ||
               document.querySelector('#mainContent');
    if (!main) return null;

    var box = document.createElement('div');
    box.id = 'gateBar';
    box.className = 'mp-gatebar';
    main.insertBefore(box, main.firstChild);
    return box;
  }

  // 按 env 名 / label 关键词找某个门控项（不依赖固定下标，新增/删减门控项都不破）。
  function findBy(list, re) {
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var hay = (g.env || '') + ' ' + (g.label || '') + ' ' + (g.id || '');
      if (re.test(hay)) return g;
    }
    return null;
  }

  // ── 运行证据（2026-11-08）──
  // 门控「开着」和「真跑过」是两件事。后端 /api/gates 每项带 evidence：
  //   { available, hits, lastAt, unknown, unit, source, detail }
  // 这里只在**有正数**时给 chip 加后缀——正数 = 有交付证据，让它成为视觉焦点；
  // 0 次不加后缀（13 项都挂「0 次」会把真数字淹掉），0 与「读不到」的解读放在明细表
  // 和成本姿态 chip 上，那里是逐项核对的地方。
  function evTail(g) {
    var ev = g && g.evidence;
    if (!ev || !ev.available) return '';
    if (ev.unknown) return ' · 证据读不到';
    if (ev.hits > 0) return ' · ' + ev.hits + ' ' + (ev.unit || '次');
    return '';
  }

  // 明细表「运行痕迹」列。四态各说各话，不许合并：
  //   有数字 → 绿（真跑过）／ 0 → 琥珀（接线了但没数据，要看是不是空转）
  //   读不到 → 灰（不知道）／ 无采集点 → 灰 + 「无采集点」（采不到 ≠ 没生效）
  function evCell(ev) {
    if (!ev || !ev.available) {
      return '<span class="ev-none">无采集点</span>';
    }
    if (ev.unknown) {
      return '<span class="ev-mute">' + esc(ev.detail || '证据读不到') + '</span>';
    }
    var cls = ev.hits > 0 ? 'ev-hit' : 'ev-zero';
    var html = '<span class="' + cls + '">' + esc(ev.detail || '') + '</span>';
    if (ev.source) html += '<div class="ev-src">' + esc(ev.source) + '</div>';
    return html;
  }

  // 门控格阵（M2「一张图」）：16 个格子压缩成一块，首屏可截图。
  // 与 chip/明细表同一套语义，只是把「一眼可判」这件事做到极致：
  //   一眼看到「一片灰 + 两个绿」= 开箱默认态；「实心绿」= 有运行证据的那几项。
  // 不是新数据——全部来自 /api/gates 的 gate.on / shadow / evidence。
  var GM_MEANING = {
    'gm-on-hit': '已开启 · 有运行证据',
    'gm-on-idle': '已开启 · 暂无数据',
    'gm-off': '未开启（默认门控关闭）',
    'gm-unknown': '读不到（跨进程）',
    'gm-shadow': '影子 · 只记录不动路由',
  };

  function gmClass(g) {
    if (g.unknown || g.on === null) return 'gm-unknown';
    if (!g.on) return 'gm-off';
    if (g.shadow) return 'gm-shadow';
    var ev = g.evidence;
    if (ev && ev.available && !ev.unknown && ev.hits > 0) return 'gm-on-hit';
    return 'gm-on-idle';
  }

  function gateMatrix(list) {
    var cells = list.map(function (g) {
      var cls = gmClass(g);
      var label = g.label + '：' + GM_MEANING[cls] +
        (g.evidence && g.evidence.hits > 0 ? '（' + g.evidence.hits + ' ' + (g.evidence.unit || '次') + '）' : '');
      return '<span class="gm-cell ' + cls + '" title="' + esc(label) + '"></span>';
    }).join('');
    var counts = {};
    list.forEach(function (g) { var c = gmClass(g); counts[c] = (counts[c] || 0) + 1; });
    var aria = list.length + ' 项门控：' + Object.keys(GM_MEANING)
      .filter(function (k) { return counts[k]; })
      .map(function (k) { return GM_MEANING[k] + ' ' + counts[k]; })
      .join('，');
    // role="img"+aria-label：这确实是一张图，读屏用户拿到的应是结论而不是 16 个空 span
    return '<span class="gm" role="img" aria-label="' + esc(aria) + '">' + cells + '</span>';
  }

  // 展开区的图例：顶行放不下，但少了它，格子的颜色就得靠猜。
  function gmLegend() {
    function item(cls, text) {
      return '<span><i class="gm-cell ' + cls + '"></i>' + esc(text) + '</span>';
    }
    return '<div class="gm-legend">' +
      item('gm-on-hit', '开着 · 真跑过') +
      item('gm-on-idle', '开着 · 还没数据') +
      item('gm-off', '关闭') +
      item('gm-shadow', '影子') +
      item('gm-unknown', '读不到') +
    '</div>';
  }

  // 3 个「用户语言」姿态 chip：把技术 gate/summary 重排成老板一眼能读的状态。
  // 影子/观察中=琥珀（--color-warning），生效=绿，关闭/未配置=灰。
  function leadChips(list, sum) {
    sum = sum || {};
    var total = sum.total, on = sum.on, off = sum.off, unknown = sum.unknown;

    // ① 路由姿态：读 gate-summary 的整体开/关态（manager 可控的那部分），
    //    而非 cursor 持有、manager 读不到的 route-override（那个在明细里标「未知」）。
    var routeState, routeLabel, routeSub;
    if (sum.stock) {
      routeState = 'shadow'; routeLabel = '路由 · 影子模式';
      routeSub = '只记录 · 未生效（开关在 cursor）';
    } else if (off > 0) {
      routeState = 'shadow'; routeLabel = '路由 · 灰度中';
      routeSub = (sum.optInOn || on) + ' 项已开 / ' + (sum.optInTotal || total) + ' 项未开';
    } else if (total > 0) {
      routeState = 'on'; routeLabel = '路由 · 已开启';
      routeSub = total + ' 项已生效';
    } else {
      routeState = 'off'; routeLabel = '路由 · 暂无门控'; routeSub = '读不到门控项';
    }

    // ② 成本追踪：这是 3 个姿态里**唯一有运行证据**的一项，所以它要回答的
    //    不只是「开没开」，而是「开着有没有真在记账」——后者才是用户想知道的。
    //    绿=真入账；琥珀=开着但零入账（空转或还没请求）；灰=关/未配置。
    var cost = findBy(list, /COST|成本/);
    var costState, costLabel, costSub;
    var cev = cost && cost.evidence;
    if (!cost) { costState = 'off'; costLabel = '成本追踪 · 未接入'; }
    else if (cost.unknown || cost.on === null) { costState = 'off'; costLabel = '成本追踪 · 未配置'; }
    else if (!cost.on) { costState = 'off'; costLabel = '成本追踪 · 关闭'; }
    else if (cev && cev.available && !cev.unknown && cev.hits > 0) {
      // 真跑过：这是本组件唯一能拿出「交付证据」的地方，必须显示数字
      costState = 'on'; costLabel = '成本追踪 · 已开'; costSub = '真入账 ' + cev.hits + ' ' + (cev.unit || '笔');
    } else if (cev && cev.available && !cev.unknown) {
      // 开着但零入账：不能画绿，否则「已开」被读成「已经在记账」——这正是要消除的落差
      costState = 'shadow'; costLabel = '成本追踪 · 已开但空转'; costSub = '0 笔入账';
    } else {
      // 采不到证据（文件读不到/无采集点）：说「无运行证据」，不猜
      costState = 'on'; costLabel = '成本追踪 · 已开'; costSub = '无运行证据';
    }

    // ③ 编排引擎：未启用=灰；已启用=琥珀「观察中」（影子是默认运行形态，非绿）。
    var orch = findBy(list, /ORCH|编排/);
    var orchState, orchLabel, orchSub;
    if (!orch) { orchState = 'off'; orchLabel = '编排引擎 · 未接入'; }
    else if (orch.unknown || orch.on === null) { orchState = 'off'; orchLabel = '编排引擎 · 读不到'; }
    else if (orch.on) { orchState = 'shadow'; orchLabel = '编排引擎 · 已配置';
      orchSub = '观察中 · 可回'; }
    else { orchState = 'off'; orchLabel = '编排引擎 · 未启用'; }

    function chip(text, sub, state) {
      var cls = 'gate-chip gate-chip-lead gate-chip-' + state;
      var inner = esc(text) + (sub ? ' <span class="lsub">' + esc(sub) + '</span>' : '');
      return '<span class="' + cls + '" title="' + esc(text + (sub ? ' · ' + sub : '')) +
        '">' + inner + '</span>';
    }
    return '<div class="mp-lead">' +
      chip(routeLabel, routeSub, routeState) +
      chip(costLabel, costSub || null, costState) +
      chip(orchLabel, orchSub || '', orchState) +
    '</div>';
  }

  function render(box, opts) {
    var expanded = box.getAttribute('data-expanded') === '1';

    // 占位：先把「读取中」画出来，避免白屏。
    box.innerHTML =
      '<div class="gate-bar-head" role="status" aria-live="polite">' +
        '<span class="gateway-dot gateway-dot-ok" title="状态读取中"></span>' +
        '<span style="color:var(--color-text-tertiary);font-weight:400;">能力门控状态读取中…</span></div>';

    var req = fetch('/api/gates', { headers: authHeaders(), credentials: 'same-origin' });

    req.then(function (res) {
      // 401/403 = 没登录或没权限，是「身份」问题，不是「门控全关」，
      // 更不能当成「读取失败」——三种状态必须各说各话。
      if (res.status === 401 || res.status === 403) {
        box.setAttribute('data-loaded', 'auth');
        box.innerHTML =
          '<div class="gate-bar-head">' +
            '<span class="gateway-dot gateway-dot-err">能力门控</span>' +
            '<span class="gate-bar-pill">需登录</span></div>' +
          '<div class="gate-bar-note">门控状态属于管理数据，登录后可查看。</div>';
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return; // 上面已渲染 401/403

      var list = (data && data.gates) || [];
      var sum = (data && data.summary) || {};

      // 整体徽标：开箱默认态（绿灰）/ 灰度中 N 项。
      var pill = sum.stock
        ? '<span class="gate-bar-pill gate-bar-pill-stock">开箱默认态</span>'
        : '<span class="gate-bar-pill">灰度中 ' + esc(sum.optInOn != null ? sum.optInOn : sum.on) +
            '/' + esc(sum.optInTotal) + '</span>';

      // 默认折叠态的一句人话。
      var note = sum.stock
        ? '能力代码都在，按非侵入铁律<b>默认全关</b>——未开启 ≠ 没做，展开全部看逐项明细。'
        : '已开启 ' + esc(sum.on) + ' 项 / 共 ' + esc(sum.total) + ' 项；未开启项是默认门控关闭，非缺失。';

      // 全部技术 chip（折叠区；影子=琥珀、开=绿、关=灰、未知=虚线）。
      var chips = list.map(function (g) {
        var unknown = g.unknown || g.on === null;
        // 🔴 shadow 只在**真的开着**时才是琥珀「影子·只记录」。
        // shadow:true 的含义是「开了也只记账不动路由」（这个能力本身是影子性质），
        // 不是「现在正在影子运行」。对 on=false 的项标「只记录」是自相矛盾：
        // 它一次都没跑，记什么？2026-11-08 发现 chip 与格阵对同一项给出两种状态
        // （chip 琥珀「影子」/ 格阵灰「关闭」），根因就在这里。
        var shadow = g.shadow && g.on;
        var cls;
        if (unknown) cls = 'gate-chip gate-chip-unknown';
        else if (shadow) cls = 'gate-chip gate-chip-shadow';
        else cls = g.on ? 'gate-chip gate-chip-on' : 'gate-chip gate-chip-off';
        var mark = unknown ? '?' : (shadow ? '◐' : (g.on ? '●' : '○'));
        var tail = evTail(g);   // 有正数才挂：` · 1054 笔`
        var impactTail = g.impact
          ? '（' + esc(g.env) + '）— ' + g.impact
          : '（' + esc(g.env) + '）';
        var suffix = shadow ? ' · 影子·只记录' : '';
        var evTitle = (g.evidence && g.evidence.available && g.evidence.detail)
          ? '｜运行痕迹：' + g.evidence.detail : '';
        return '<span class="' + cls + '" title="' + esc(g.label + suffix + tail + ' ' + impactTail + evTitle) + '">' +
                 esc(mark + ' ' + g.label + suffix + tail) + '</span>';
      }).join('');

      var detail = list.map(function (g) {
        var unknown = g.unknown || g.on === null;
        // 🔴 unknown 的 reason 不能直接写进「当前状态」列：它可能很长
        // （「PROXY_ROUTE_OVERRIDE 由 cursor-proxy 进程持有，manager 读不到」），
        // 而该列只有 9% 宽 + nowrap ⇒ 文字会溢出压到隔壁「运行痕迹」列上（实测踩到）。
        // 故列里只写「未知」，完整原因进 title。
        var state, stateTitle = '';
        if (unknown) {
          stateTitle = g.reason || '跨进程读不到';
          state = '<span style="color:var(--color-text-tertiary);">未知</span>';
        } else if (g.on) {
          state = '<span style="color:var(--color-success);">已开启' + (g.shadow ? ' · 影子·只记录' : '') + '</span>';
        } else {
          state = '<span style="color:var(--color-text-tertiary);">未开启</span>';
        }
        return '<tr style="border-top:1px solid var(--color-border);">' +
                 '<td style="padding:6px 10px 6px 0;font-size:12px;">' + esc(g.label) + '</td>' +
                 '<td style="padding:6px 10px;font-size:12px;color:var(--color-text-tertiary);">' +
                   '<code>' + esc(g.env) + '</code></td>' +
                 '<td style="padding:6px 10px;font-size:12px;white-space:nowrap;"' +
                   (stateTitle ? ' title="' + esc(stateTitle) + '"' : '') + '>' + state + '</td>' +
                 // 运行痕迹：本列回答的是「真跑过没有」，与左边「开没开」是两回事
                 '<td style="padding:6px 10px;font-size:12px;">' + evCell(g.evidence) + '</td>' +
                 '<td style="padding:6px 0;font-size:12px;color:var(--color-text-tertiary);">' +
                   esc(g.impact || '') + '</td>' +
               '</tr>';
      }).join('');

      var toggleText = expanded ? '收起明细' : '展开全部 · ' + list.length + ' 项门禁';

      box.innerHTML =
        '<div class="gate-bar-head" role="status" aria-live="polite">' +
          '<span class="gateway-dot gateway-dot-ok" title="系统正常 · /api/gates 可读"></span>' +
          '<span>能力门控</span>' +
          leadChips(list, sum) +
          pill +
          // M2「一张图」：16 个格子，一眼可判「开了几项 / 哪项真跑过 / 哪项默认关」
          gateMatrix(list) +
          '<button class="gate-bar-toggle" type="button" data-gate-toggle>' + esc(toggleText) + '</button>' +
        '</div>' +
        '<div class="gate-bar-note">' + note + '</div>' +
        // 折叠区：DOM 始终存在，display 由 data-expanded + CSS 控制。未开启项不会被过滤掉。
        '<div class="mp-gatebar-expand">' +
          gmLegend() +
          '<div class="gate-bar-list">' + chips + '</div>' +
          '<table>' +
            // 列宽固定：能力 / 环境变量 / 当前状态 / 运行痕迹 / 开启后会发生什么。
            // 运行痕迹要放「已入账 1054 笔，最近 11-03 04:52」+ 路径两行，给 26%；
            // impact 是最长的自然语言，给 36% 让它自己换行。
            '<colgroup>' +
              '<col style="width:13%"><col style="width:17%"><col style="width:9%">' +
              '<col style="width:25%"><col style="width:36%">' +
            '</colgroup>' +
            '<thead><tr>' +
              '<th>能力</th><th>环境变量</th><th>当前状态</th><th>运行痕迹</th><th>开启后会发生什么</th>' +
            '</tr></thead>' +
            '<tbody>' + detail + '</tbody>' +
          '</table>' +
          // 「运行痕迹」列的口径必须写在旁边，否则「无采集点」会被读成「没跑过」——
          // 那正是这一列要想消灭的误读，换个位置又造一个就白做了。
          '<div class="gate-bar-note">「运行痕迹」只报<b>可核对的次数</b>（真入账几笔 / 真命中几次）。' +
            '「无采集点」= 这一项没有落盘痕迹可查，<b>不代表它没生效</b>；' +
            '「0 次」= 采到了但确实还没有数据，可能是刚启用，也可能还没人用。</div>' +
          '<div class="gate-bar-note">改动方式：默认关闭的项设 <code>PROXY_XXX=1</code> 打开；' +
            '默认开启的项若要关，设 <code>PROXY_XXX=0</code>（写 =1 对它是空操作）。' +
            '改完重启 manager 生效——状态条只提示状态，不替你改热路径。</div>' +
        '</div>';

      box.setAttribute('data-loaded', '1');
      // 折叠/展开只切 CSS 显隐，不重新 fetch / 不整条重渲（避免每次点击都重新拉 /api/gates 闪烁）。
      box.setAttribute('data-expanded', expanded ? '1' : '0');
      var btn = box.querySelector('[data-gate-toggle]');
      if (btn) {
        btn.addEventListener('click', function () {
          var now = box.getAttribute('data-expanded') === '1';
          box.setAttribute('data-expanded', now ? '0' : '1');
          btn.textContent = now ? ('展开全部 · ' + list.length + ' 项门禁') : '收起明细';
        });
      }
    }).catch(function (e) {
      // 纪律①：读失败就明说读不到 + 给重试。绝不 fallback 成「全部未开启」。
      var key = opts.retryKey || 'gatebar';
      if (global.MPStates && global.MPStates.error && global.MPStates.registerRetry) {
        global.MPStates.registerRetry(key, function () { render(box, opts); });
        box.innerHTML = global.MPStates.error({
          title: '门控状态读取失败',
          detail: (e && e.message) || '未知错误',
          hint: '这里显示的是「读不到」，不是「全部未开启」——两者不能混。',
          retryKey: key
        });
      } else {
        box.innerHTML =
          '<div class="gate-bar-head" role="alert">' +
            '<span class="gateway-dot gateway-dot-err">' +
              '<span style="color:#dc2626;">门控状态读取失败</span></span></div>' +
          '<div class="gate-bar-note">' + esc((e && e.message) || '未知错误') +
          '　（这是「读不到」，不是「全部未开启」）</div>';
      }
      box.setAttribute('data-loaded', 'error');
    });
  }

  // states.js 在本文件之前加载，理论上就绪；但页面脚本顺序一旦被改动就会 RaceCondition，
  // 这里沿用已验证的轮询守卫，超时则走自带降级 HTML（宁可降级也不白屏）。
  function withStates(cb) {
    if (global.MPStates || typeof global.MPStates !== 'undefined') return cb();
    var n = 0;
    (function poll() {
      if (global.MPStates || n++ > 60) return cb();
      setTimeout(poll, 30);
    })();
  }

  function mount(opts) {
    opts = opts || {};
    if (document.body && document.body.getAttribute('data-gatebar') === 'off') return null;
    injectStyle();
    var box = resolveHost();
    if (!box) return null;
    withStates(function () { render(box, opts); });
    return box;
  }

  function boot() {
    try {
      mount({ retryKey: 'gatebar:' + (location.pathname || '/') });
    } catch (e) {
      // 状态条是附加信息，任何异常都不许拖垮宿主页面
      if (global.console && console.warn) console.warn('[gatebar] mount failed:', e && e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // evTail / evCell 一并导出：它们是「开着≠跑过」这条口径的唯一实现，
  // 必须能被单测直接钉住（与 esc/leadChips 同规格），否则只能靠读源码猜。
  global.MPGateBar = {
    mount: mount, render: render, esc: esc, leadChips: leadChips, findBy: findBy,
    evTail: evTail, evCell: evCell, gateMatrix: gateMatrix, gmClass: gmClass,
  };
})(window);
