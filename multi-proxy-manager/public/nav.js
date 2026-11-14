// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// 单一导航来源（P0-5）：dashboard / knowledge / proxy-config / floor 共用。
// 主导航 9 项（真实页面/路由，统一中文化），键盘可激活（<a>/<button>）。
// dashboard 额外渲染页内 SPA 子视图（健康/告警/注册表/成本/影子）+ 动态代理容器，
// 其余页面只渲染主导航，保证 4 页主导航一致。

(function (global) {
  'use strict';

  // ===== 图标（内联 SVG，统一描边风格；与既有 nav 视觉一致）=====
  // 下面是回退副本：正常情况取 icons.js 的 window.MPIcons.nav（决策 E 的全站单一图标集）。
  // 保留副本是为了不因脚本加载顺序把整个导航搞挂；改图标请改 icons.js，两边保持同形。
  var ICON_FALLBACK = {
    overview:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    floor:     '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    proxy:     '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    sessions:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    knowledge: '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    skills:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    logs:      '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    settings:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    health:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    alerts:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    registry:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    cost:      '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    shadow:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M12 6v6l4 2"/></svg>',
    today:     '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    context:   '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
  };

  // 品牌徽标（与既有 .cg-badge / .cg-glyph 同形；侧栏由 nav.js 单源渲染，避免各页 SVG 不一致）
  var CG_BADGE = '<div class="logo-icon cg-badge"><svg class="cg-glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs><linearGradient id="cgGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path d="M32 4 L56 18 V46 L32 60 L8 46 V18 Z" fill="url(#cgGrad)"/><path d="M37 20 H30 A12 12 0 0 0 30 44 H37" fill="none" stroke="#ffffff" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 32 H50" fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round"/><path d="M43 27 L46 30 L53 21" fill="none" stroke="#34d399" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

  var ICON = (global.MPIcons && global.MPIcons.nav) || ICON_FALLBACK;

  // ===== 主导航（真实页面/路由）—— 全页一致 =====
  // 标签去黑话 / 去内部代号（OOBE P1-1.4）：Floor 盘面·开发者 → 实时盘面（用户不需要知道是给开发者的）
  //
  // 2026-11-13 重排（老板选方案 2）：上一版把 8 个页面 + 5 个页内子视图 + 9 条代理入口
  // 全平铺在侧栏，一屏 22 个入口，老板的原话是「功能还是很杂」。改法是把三种不同性质的
  // 东西分开：**页面**按用途分组留在侧栏，**页内子视图**回到页面里做 tab，**代理列表**折叠
  // 成一行（要用时展开）。功能一个没删，只是不再同时出现在第一屏。
  var GROUPS = [
    {
      label: '',            // 首组不额外加标题，紧跟在品牌区下面
      items: [
        { id: 'dashboard', label: '总览',     href: '/dashboard', icon: ICON.overview },
        // 2026-11-14：补回上下文构成。这页一直有路由（server.js 的 /context）却没有导航入口，
        // 用户只能手敲 URL —— 是 11-13 重排侧栏时漏掉的，不是有意隐藏。
        // 归属：它答的是「这笔钱由哪几类 token 组成」，和总览/盘面同属看账面，所以放首组。
        { id: 'context',   label: '上下文构成', href: '/context',  icon: ICON.context },
        { id: 'floor',     label: '实时盘面', href: '/floor',     icon: ICON.floor }
      ]
    },
    {
      label: '运行',
      items: [
        { id: 'proxy',    label: '代理配置', href: '/proxy-config', icon: ICON.proxy },
        { id: 'sessions', label: '任务管理', href: '/sessions',     icon: ICON.sessions },
        { id: 'logs',     label: '日志',     href: '/logs',         icon: ICON.logs }
      ]
    },
    {
      label: '可选能力',    // 默认关闭的 L2 能力归到这里，不跟日常用的页面混排
      items: [
        { id: 'knowledge', label: '知识库', href: '/knowledge', icon: ICON.knowledge },
        { id: 'skills',    label: '技能',   href: '/skills',    icon: ICON.skills }
      ]
    }
  ];

  // 设置单独放末尾：它不是日常来回切的页面，混在分组里会让分组意义变淡
  var SETTINGS_ITEM = { id: 'settings', label: '设置', href: '/settings', icon: ICON.settings };

  // ===== dashboard 页内 SPA 子视图（2026-11-13 起不在侧栏渲染）=====
  // 这 5 个本来就不是独立页面，是 dashboard 内部的视图。之前塞进侧栏的结果是
  // 「侧栏里点一个按钮，地址不变、右边换一块」，用户分不清它和真页面的区别。
  // 现在由 dashboard 自己渲染成页内 tab，这里只负责把清单交出去。
  var SPA_VIEWS = [
    // 「今天」必须在第一个：打开面板想知道的第一个问题是"我今天跑了多少、动了什么"，
    // 而不是"九个代理健康不健康"。健康/告警属于排障时刻才看的，排在后面。
    { id: 'today',    label: '今天',     icon: ICON.today, title: '今天的请求账 + 文件账' },
    { id: 'health',   label: '健康状态', icon: ICON.health },
    { id: 'alerts',   label: '告警中心', icon: ICON.alerts },
    { id: 'registry', label: 'Agent 清单', icon: ICON.registry },
    { id: 'cost',     label: '成本',     icon: ICON.cost },
    { id: 'shadow',   label: '路由预演', icon: ICON.shadow, title: '只读模拟：只展示会怎么路由，不会真的转发' }
  ];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 高亮判定：按 id 或按路径都比一次。
  // 历史 bug：proxy-config 页传的是 current:'proxy-config'，而菜单项 id 是 'proxy'，
  // 于是「代理配置」这一项在它自己的页面上从来不高亮。改成路径兜底后自动对上。
  function isActive(item, current) {
    if (!current) return false;
    if (item.id === current) return true;
    return item.href === '/' + current;
  }

  function linkItem(item, current) {
    var active = isActive(item, current) ? ' active' : '';
    return '<a class="nav-item' + active + '" href="' + esc(item.href) + '">' +
      item.icon + '<span>' + esc(item.label) + '</span></a>';
  }

  // 代理列表折叠头：右箭头 + 数量。数量由 MutationObserver 从列表里数出来，
  // 这样三个页面各自的填充逻辑都不用改。
  var CHEVRON = '<svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="9 6 15 12 9 18"/></svg>';

  function proxyGroup(collapsed) {
    return '<div class="nav-group" data-collapsed="' + (collapsed ? '1' : '0') + '">' +
      '<button type="button" class="nav-group-toggle" id="proxySectionLabel" ' +
        'aria-expanded="' + (collapsed ? 'false' : 'true') + '" style="display:none;">' +
        CHEVRON + '<span>代理服务</span><span class="nav-count" id="proxyNavCount"></span>' +
      '</button>' +
      '<div id="proxyNavItems" class="nav-group-body"' + (collapsed ? ' hidden' : '') + '></div>' +
      '</div>';
  }

  // 导航专用样式：从这里注入而不是每个页面各写一份。
  // 十个页面都引用 nav.js，样式跟着导航走才不会两边漂移（历史教训：侧栏样式曾散落在
  // shared-styles / dashboard 内联 / proxy-config 内联三处）。
  var NAV_CSS = '' +
    '.nav-group-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:9px 12px;' +
      'background:none;border:0;font:inherit;font-size:13px;color:var(--color-text-secondary,' +
      '#64748b);cursor:pointer;border-radius:8px;text-align:left}' +
    '.nav-group-toggle:hover{background:var(--color-bg-hover,rgba(127,127,127,.08));' +
      'color:var(--color-text,#111)}' +
    '.nav-group-toggle .nav-chevron{width:14px;height:14px;flex:0 0 14px;fill:none;' +
      'stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;' +
      'transition:transform .16s ease}' +
    '.nav-group[data-collapsed="0"] .nav-group-toggle .nav-chevron{transform:rotate(90deg)}' +
    '.nav-count{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;' +
      'color:var(--color-text-tertiary,#94a3b8);background:var(--color-bg-tertiary,rgba(127,127,127,.12));' +
      'border-radius:9px;padding:1px 7px}' +
    '.nav-count:empty{display:none}' +
    '.nav-group-body[hidden]{display:none}' +
    '.nav-group-body .nav-item{padding-left:26px}' +
    // 基础项统一样式：nav.js 在所有页面末尾注入，这套会覆盖各页散落的侧栏写法，
    // 直接消掉「好几套」；active 只换底色 + 字重（不加边框/改 padding），避免点不同项时文字乱跳。
    '.nav-item{display:flex;align-items:center;gap:10px;height:36px;padding:0 12px;' +
      'box-sizing:border-box;border-radius:8px;text-decoration:none;' +
      'font-size:13px;line-height:1;color:var(--color-text-secondary,#64748b);' +
      'background:transparent;transition:background-color .12s ease,color .12s ease}' +
    '.nav-item .icon-svg{width:18px;height:18px;flex:0 0 18px;stroke:currentColor;' +
      'stroke-width:1.5;fill:none}' +
    '.nav-item span{white-space:nowrap}' +
    '.nav-item:hover{background:var(--color-bg-hover,rgba(127,127,127,.08));color:var(--color-text,#111)}' +
    '.nav-item.active{background:var(--color-bg-hover,rgba(127,127,127,.10));' +
      'color:var(--color-text,#111);font-weight:500}' +
    '.nav-item.active:hover{background:var(--color-bg-hover,rgba(127,127,127,.12))}' +
    '.nav-label{font-size:11px;font-weight:600;color:var(--color-text-tertiary,#94a3b8);' +
      'padding:16px 12px 6px;margin:0}' +
    // 统一页脚（nav.js 全站单源渲染）：主题三态切换器 + 版本 + 登出
    '.sidebar-footer{display:flex;flex-direction:column;gap:8px;padding:14px 16px;' +
      'border-top:1px solid var(--color-border,rgba(127,127,127,.2))}' +
    '.mp-theme-switch{display:flex;gap:4px}' +
    '.mp-theme-switch button{flex:1;padding:6px 4px;border:1px solid var(--color-border,rgba(127,127,127,.2));' +
      'background:transparent;color:var(--color-text-secondary,#64748b);border-radius:8px;font:inherit;' +
      'font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}' +
    '.mp-theme-switch button:hover{background:var(--color-bg-hover,rgba(127,127,127,.08))}' +
    '.mp-theme-switch button.active{background:var(--color-bg-hover,rgba(127,127,127,.14));' +
      'color:var(--color-text,#111);border-color:var(--color-primary,#3b82f6);font-weight:500}' +
    '.sidebar-foot-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.btn-logout{padding:6px 12px;border:1px solid var(--color-border,rgba(127,127,127,.2));background:transparent;' +
      'color:var(--color-text-secondary,#64748b);border-radius:8px;font:inherit;font-size:12px;cursor:pointer}' +
    '.btn-logout:hover{background:var(--color-bg-hover,rgba(127,127,127,.08));color:var(--color-text,#111)}' +
    '.version-info{font-size:11px;color:var(--color-text-tertiary,#94a3b8)}';

  function injectNavStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('mp-nav-styles')) return;
    var st = document.createElement('style');
    st.id = 'mp-nav-styles';
    st.textContent = NAV_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /**
   * 渲染侧栏导航到指定容器。
   * @param {HTMLElement} container 目标（通常是 <nav id="sidebarNav">）
   * @param {Object} opts { current, spa, proxyNav, proxyCollapsed }
   *   current        : 当前页 id（高亮；也可传页面名，按路径兜底匹配）
   *   spa            : 兼容旧调用；子视图已改为页内 tab，此参数不再参与渲染
   *   proxyNav       : 是否渲染代理列表容器 #proxyNavItems
   *   proxyCollapsed : 代理列表是否默认折叠（dashboard 折叠，代理配置页展开）
   */
  function renderNav(container, opts) {
    if (!container) return;
    opts = opts || {};
    var current = opts.current || '';
    injectNavStyles();

    // 接管整个侧边栏（品牌 + 导航 + 页脚），保证每页渲染一致，消灭「点哪个菜单跳一套」。
    // 旧做法：各页自己写死的品牌/页脚/主题按钮并存，每页都不一样。
    var sidebar = container.closest ? container.closest('.sidebar') : null;
    if (!sidebar && container.parentElement) sidebar = container.parentElement.closest('.sidebar');
    if (!sidebar) sidebar = container;

    var navHtml = '';
    GROUPS.forEach(function (g) {
      if (g.label) navHtml += '<div class="nav-label">' + esc(g.label) + '</div>';
      g.items.forEach(function (it) {
        navHtml += linkItem(it, current);
        // 代理列表挂在「代理配置」下面：它导航到的就是这一页的子状态，
        // 放到末尾会和「设置」抢位置，读起来像另一个分组的开头。
        if (it.id === 'proxy' && opts.proxyNav) navHtml += proxyGroup(opts.proxyCollapsed === true);
      });
    });
    navHtml += linkItem(SETTINGS_ITEM, current);

    sidebar.innerHTML = buildBrand() +
      '<nav class="sidebar-nav" id="sidebarNav">' + navHtml + '</nav>' +
      buildFooter();

    var navEl = sidebar.querySelector('#sidebarNav');
    if (opts.proxyNav) wireProxyGroup(sidebar);

    // 主题三态切换器：全站唯一主题入口，点击直接走 MPTheme.set
    var ts = sidebar.querySelector('.mp-theme-switch');
    if (ts) ts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-theme-opt]') : null;
      if (b && global.MPTheme) { global.MPTheme.set(b.getAttribute('data-theme-opt')); syncThemeSwitch(); }
    });

    // 派发渲染完成事件：本文件常在文档末尾才执行，而页面的 /api/installed 可能先返回，
    // 那时 #proxyNavItems 还不存在 —— 早到的渲染会被丢弃，导致代理列表时有时无。
    // 事件让页面能在容器就绪的瞬间补渲染，而不是靠猜时序。
    try {
      document.dispatchEvent(new CustomEvent('mp-nav-rendered', { detail: { container: navEl } }));
    } catch (e) {}
  }

  // 折叠交互 + 数量同步。数量用 MutationObserver 数，避免改三个页面的填充函数。
  function wireProxyGroup(sidebar) {
    var group = sidebar.querySelector('.nav-group');
    var toggle = sidebar.querySelector('#proxySectionLabel');
    var body = sidebar.querySelector('#proxyNavItems');
    if (!group || !toggle || !body) return;

    if (!group.dataset.wired) {
      group.dataset.wired = '1';
      toggle.addEventListener('click', function () {
        var collapsed = group.getAttribute('data-collapsed') === '1';
        group.setAttribute('data-collapsed', collapsed ? '0' : '1');
        toggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
        body.hidden = !collapsed;
      });
    }

    var count = sidebar.querySelector('#proxyNavCount');
    function sync() {
      if (!count) return;
      var n = body.querySelectorAll('.proxy-nav-item').length;
      count.textContent = n > 0 ? String(n) : '';
    }
    sync();
    if (window.MutationObserver && !body.dataset.observed) {
      body.dataset.observed = '1';
      new MutationObserver(sync).observe(body, { childList: true });
    }
  }

  function buildBrand() {
    return '<div class="sidebar-brand">' + CG_BADGE + '<strong>costgate</strong></div>';
  }

  function buildFooter() {
    // 单一主题切换器（浅色 / 深色 / 跟随系统）—— 全站唯一的主题入口，
    // 其余页面的暗色按钮 / 设置里的主题卡已移除（收口 #3）。
    var theme = '<div class="mp-theme-switch" role="group" aria-label="主题">';
    [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']].forEach(function (p) {
      theme += '<button type="button" data-theme-opt="' + p[0] + '">' + p[1] + '</button>';
    });
    theme += '</div>';
    // 版本 + 登出。法务入口收口到「设置 → 法务」（#2 评估：侧栏不再重复放法务链接）。
    var meta = '<div class="sidebar-foot-meta">' +
      '<span class="version-info" id="sidebarVersion">v1.0.0</span>' +
      '<button class="btn-logout" type="button" onclick="handleLogout()" title="退出登录">登出</button>' +
      '</div>';
    return '<div class="sidebar-footer">' + theme + meta + '</div>';
  }

  function syncThemeSwitch() {
    var cur = (global.MPTheme && global.MPTheme.get && global.MPTheme.get()) || 'auto';
    var wrap = document.querySelector('.mp-theme-switch');
    if (!wrap) return;
    var btns = wrap.querySelectorAll('button[data-theme-opt]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-theme-opt') === cur);
    }
  }

  // 主题变化时同步切换器高亮
  if (typeof document !== 'undefined') {
    document.addEventListener('mp-theme-change', syncThemeSwitch);
  }

  // 全局登出：提升到 nav.js，保证统一侧栏的登出在每个页面都可用（floor / context 此前未定义）
  global.handleLogout = function () {
    try { sessionStorage.removeItem('auth_token'); } catch (e) {}
    window.location.href = 'login.html';
  };

  global.renderNav = renderNav;
  global.syncThemeSwitch = syncThemeSwitch;
  // dashboard 用它渲染页内 tab：子视图清单只有这一份，页面不再自己抄一遍
  global.MPSpaViews = SPA_VIEWS;
})(window);
