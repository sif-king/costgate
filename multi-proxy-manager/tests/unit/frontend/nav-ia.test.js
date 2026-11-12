// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * 导航信息架构守卫（2026-11-13 立，老板选「方案 2」重排后）
 *
 * 重排前的形状：侧栏 8 个页面 + 5 个页内子视图 + 9 条代理入口全平铺，一屏 22 个入口，
 * 老板的原话是「功能还是很杂」。重排把三类东西分开：页面分组留在侧栏、子视图回页内 tab、
 * 代理列表折叠。
 *
 * 这些断言守的是「回退」而不是「好看」：结构一旦被人顺手改回去，用户又会看到 22 个入口，
 * 而这件事没有任何运行时症状——页面照样能点，只是又开始杂。所以必须静态判。
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../../../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');

describe('导航信息架构（方案 2：页面分组 / 子视图进页内 tab / 代理折叠）', () => {
  let nav;
  let dash;

  beforeAll(() => {
    nav = read('nav.js');
    dash = read('dashboard.html');
  });

  describe('页内子视图不许回到侧栏', () => {
    // 这 5 个是 dashboard 内部视图，不是页面。放回侧栏的症状是「点了地址不变、
    // 右边换一块」，用户分不清它和真页面的区别。
    const SPA_IDS = ['health', 'alerts', 'registry', 'cost', 'shadow'];

    it('GROUPS 里不含任何子视图 id', () => {
      // 只截 GROUPS 定义那一段，避免误伤 SPA_VIEWS 自己的定义
      const start = nav.indexOf('var GROUPS =');
      const end = nav.indexOf('var SETTINGS_ITEM');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const groupsBlock = nav.slice(start, end);
      for (const id of SPA_IDS) {
        expect(groupsBlock).not.toMatch(new RegExp(`id:\\s*'${id}'`));
      }
    });

    it('SPA 清单仍然导出给 dashboard 用（不是删掉了）', () => {
      expect(nav).toContain('global.MPSpaViews');
      for (const id of SPA_IDS) {
        expect(nav).toMatch(new RegExp(`id:\\s*'${id}'`));
      }
    });
  });

  describe('dashboard 的页内 tab', () => {
    it('tab 容器在第一个页面之前（否则它会掉到内容下面）', () => {
      const tabsAt = dash.indexOf('id="viewTabs"');
      const firstPageAt = dash.indexOf('id="page-dashboard"');
      expect(tabsAt).toBeGreaterThan(-1);
      expect(firstPageAt).toBeGreaterThan(-1);
      expect(tabsAt).toBeLessThan(firstPageAt);
    });

    it('tab 由 MPSpaViews 生成，不在页面里抄第二份清单', () => {
      expect(dash).toContain('window.MPSpaViews');
      // 抄了第二份的迹象：dashboard.html 里出现子视图的 label 字面量当 tab 文案
      // （「健康状态」等允许出现在页面标题 h1 里，所以只查 tab 生成段）
      const gen = dash.slice(dash.indexOf('window.MPSpaViews'), dash.indexOf('</script>', dash.indexOf('window.MPSpaViews')));
      expect(gen).not.toContain('健康状态');
    });

    it('点击走委托：switchPage 在 IIFE 里，外部 onclick 拿不到', () => {
      // 第一版就是这里错的：按钮渲染出来了，点下去 ReferenceError，面板不切换。
      expect(dash).toMatch(/viewTabsEl\.addEventListener\('click'/);
      expect(dash).toContain('switchPage(tabPage)');
    });

    it('切页时同步 tab 高亮（否则内容和高亮对不上）', () => {
      const fn = dash.slice(dash.indexOf('function switchPage'), dash.indexOf('function switchPage') + 3000);
      expect(fn).toContain('#viewTabs .section-tab');
      expect(fn).toContain('aria-selected');
    });
  });

  describe('代理列表折叠', () => {
    it('dashboard 默认折叠（它是落地页，9 条代理不该占第一屏）', () => {
      const call = dash.slice(dash.indexOf('renderNav('), dash.indexOf('renderNav(') + 200);
      expect(call).toContain('proxyCollapsed: true');
    });

    it('折叠头保留 #proxySectionLabel / 容器保留 #proxyNavItems', () => {
      // 三个页面（dashboard / proxy-config / logs）各自填充 #proxyNavItems，
      // proxy-config 与 dashboard 还会显隐 #proxySectionLabel。改名 = 那些逻辑静默失效
      // （代理列表变成永远空的，但没人报错）。
      expect(nav).toContain('id="proxySectionLabel"');
      expect(nav).toContain('id="proxyNavItems"');
    });

    it('折叠状态由 data-collapsed 控制，不是 display:none 写死', () => {
      // 写死 display:none 的话，代理配置页（要展开的那个）就没法复用了
      expect(nav).toContain('data-collapsed');
      expect(nav).toContain('body.hidden = !collapsed');
    });
  });

  describe('导航样式跟着 nav.js 走（十页一致）', () => {
    it('样式从 nav.js 注入，不散在各页', () => {
      expect(nav).toContain('mp-nav-styles');
      expect(nav).toContain('injectNavStyles');
    });

    it('当前项高亮按 href 兜底（修 proxy-config 页从不高亮的老问题）', () => {
      expect(nav).toContain('item.href === \'/\' + current');
    });
  });
});
