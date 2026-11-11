// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * Dashboard page tests
 * Verifies HTML structure, CSS classes, JS functions, and API endpoints
 * the dashboard frontend consumes.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../../server');

const PUBLIC_DIR = path.join(__dirname, '../../../public');

// Helper: read a static HTML file as a string
function readHtml(filename) {
  return fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
}

describe('Dashboard Page', () => {

  describe('HTML Structure', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should serve the dashboard HTML page', () => {
      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('costgate - 总览');
    });

    it('should include shared CSS files', () => {
      expect(html).toContain('colors_and_type.css');
      expect(html).toContain('shared-styles.css');
    });

    it('should have sidebar with navigation', () => {
      expect(html).toContain('id="sidebar"');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('class="sidebar-brand"');
      expect(html).toContain('class="sidebar-nav"');
      expect(html).toContain('costgate');
    });

    it('should source sidebar nav from single nav.js and cover key pages (P0-5)', () => {
      // P0-5：4 页主导航统一由 public/nav.js 在运行时注入（单一导航来源），
      // 静态 dashboard.html 不再硬编码 <div data-page="...">；主导航改 <a href> 路由。
      // proxy-config.html 仍由页内动态 proxy-nav 引用（见 dashboard.html buildProxyNavItems）。
      expect(html).toContain('nav.js');       // 引单一来源
      expect(html).toContain('renderNav');     // 运行时注入调用
      expect(html).toContain('proxy-config.html'); // 动态 proxy-nav 仍引用
      var nav = fs.readFileSync(path.join(PUBLIC_DIR, 'nav.js'), 'utf8');
      expect(nav).toContain("id: 'dashboard'"); // 真源覆盖：总览/日志/代理配置
      expect(nav).toContain("id: 'logs'");
      expect(nav).toContain("/proxy-config");
    });

    it('should have version info element in sidebar footer', () => {
      expect(html).toContain('id="sidebarVersion"');
    });

    it('should have logout button', () => {
      expect(html).toContain('handleLogout');
    });

    it('should have dark mode toggle button', () => {
      expect(html).toContain('id="darkModeToggle"');
    });

    it('should have mobile menu button', () => {
      expect(html).toContain('id="mobileMenuBtn"');
    });

    it('should have sidebar overlay for mobile', () => {
      expect(html).toContain('class="sidebar-overlay"');
    });

    it('should have offline banner', () => {
      expect(html).toContain('id="offlineBanner"');
      expect(html).toContain('offline-banner');
    });
  });

  describe('Auto-Refresh Controls', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have auto-refresh toggle', () => {
      expect(html).toContain('id="autoRefreshToggle"');
      expect(html).toContain('auto-refresh-panel');
    });

    it('should have auto-refresh interval selector with expected options', () => {
      expect(html).toContain('id="autoRefreshInterval"');
      expect(html).toContain('option value="5"');
      expect(html).toContain('option value="10"');
      expect(html).toContain('option value="30"');
      expect(html).toContain('option value="60"');
      expect(html).toContain('option value="0"');
    });
  });

  describe('Stat Cards', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have proxy status stat card', () => {
      // block1 HIG 重构:代理统计卡从 .stat-card accent-blue 改为 .hig-stat-card blue,
      // 旧 proxyStatusDetail 元素按新设计删除(统计行已并入 .hig-card 列表)。
      // count/label 能力仍在,断言跟到新真源(见 dashboard.html .hig-stat-card blue block)。
      expect(html).toContain('id="proxyStatusCount"');
      expect(html).toContain('class="hig-stat-card blue"');
      expect(html).toContain('class="hig-stat-value"');
    });

    it('should have installed count stat card', () => {
      // block1 HIG:已安装卡从 .stat-card accent-green 改为 .hig-stat-card green,
      // 旧 installedDetail 元素按新设计删除。count 能力仍在(见 .hig-stat-card green block)。
      expect(html).toContain('id="installedCount"');
      expect(html).toContain('class="hig-stat-card green"');
      expect(html).toContain('class="hig-stat-value"');
    });

    it('should have version info card', () => {
      expect(html).toContain('id="versionInfo"');
      expect(html).toContain('管理器版本');
      expect(html).toContain('Codex Proxy');
      expect(html).toContain('Hermes Proxy');
      expect(html).toContain('Cursor Proxy');
    });
  });

  describe('Proxy Status Cards', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have proxy status list container', () => {
      expect(html).toContain('id="proxyStatusList"');
    });

    it('should fetch PROXY_CONFIGS from server instead of hardcoding (2026-10-27 收口)', () => {
      // 2026-10-27 收口 PROXY_CONFIGS 多副本：前端不再硬编码代理配置，
      // 改为启动时从 GET /api/proxy-configs 拉取（buildProxyConfigs() 为唯一真源）。
      // 原测试钉死前端副本的键名与端口——那正是会漂移的「声明态≠运行态」来源；
      // 现在改为断言页面委托给服务端端点，端口正确性由 api.test.js 的 D7 守卫负责。
      expect(html).toContain('/api/proxy-configs');
      expect(html).toContain('fetchProxyConfigs');
      // 页面不应再内联一份「有内容的」PROXY_CONFIGS 字面量副本（空对象 {} 是合法的占位，不算）
      expect(html).not.toMatch(/PROXY_CONFIGS\s*=\s*\{\s*(codex|hermes|cursor|claude|dsh|opencode|generic)/);
    });

    it('should not hardcode proxy ports as config literal (D7: ports live server-side)', () => {
      // 端口是「状态字段」，必须来自服务端单一真源；前端不得再写死配置副本。
      // 注意：帮助面板里有 "claude 18791" 这类说明文字（合法），故只钉旧副本的
      // `port: 18800` 字面量写法，不钉裸数字，避免误伤文档文本。
      expect(html).not.toContain('port: 18800');
      expect(html).not.toContain('port: 18791');
      expect(html).not.toContain('port: 18793');
      expect(html).not.toContain('port: 18794');
    });

    it('should have proxy cards with toggle buttons', () => {
      expect(html).toContain('btn-toggle-');
      expect(html).toContain('toggleProxy');
    });

    it('should have start/stop API endpoints dynamically constructed', () => {
      // The dashboard constructs /api/{action}/{name} dynamically via fetch
      expect(html).toContain("'/api/'");
      expect(html).toContain('action');
    });

    it('should surface backend fault state in status badge (P2)', () => {
      // 后端 /api/status 返回 fault: true 时，卡片显示"故障熔断"而非笼统的"未运行"
      expect(html).toContain('status.fault');
      expect(html).toContain('故障熔断');
    });
  });

  describe('JavaScript Functions', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should reference handleLogout in logout button', () => {
      // handleLogout is defined in the shared auth.js module
      // The dashboard button calls it via onclick
      expect(html).toContain('onclick="handleLogout()"');
    });

    it('should define toggleProxy on window', () => {
      // toggleProxy is defined in the dashboard script
      expect(html).toContain('toggleProxy');
    });

    it('toggleProxy action must only be \'start\' or \'stop\'', () => {
      // Extract the action assignment from toggleProxy in the HTML
      // Expected pattern: var action = status && status.running ? 'stop' : 'start';
      var toggleMatch = html.match(/var action\s*=\s*([^;]+);/);
      expect(toggleMatch).not.toBeNull();
      var expr = toggleMatch[1];
      // Must use ternary with exactly 'start' and 'stop'
      expect(expr).toMatch(/\?\s*['"]stop['"]/);
      expect(expr).toMatch(/:\s*['"]start['"]/);
      // No other string literals should appear in the action assignment
      var strings = expr.match(/['"](.*?)['"]/g);
      expect(strings).toEqual(['\'stop\'', '\'start\'']);
    });

    it('should have init function that runs on load', () => {
      expect(html).toContain('function init()');
      expect(html).toContain('init();');
    });

    it('should use showToast pattern (defined in toast.js shared module (inline in page))', () => {
      // showToast is implemented inline in the page (designer's new architecture)
      expect(html).toContain('showToast');
    });

    it('should have loadStatus function for polling', () => {
      expect(html).toContain('function loadStatus');
    });

    it('should have loadVersion function', () => {
      expect(html).toContain('function loadVersion');
    });

    it('should have applyRefreshInterval for auto-refresh control', () => {
      expect(html).toContain('applyRefreshInterval');
    });

    it('should have dismissApiKeyBanner function', () => {
      expect(html).toContain('function dismissApiKeyBanner');
    });
  });

  describe('Health Page 诊断文案语义', () => {
    // 实测踩过的坑：徽章已经写了「未运行」，诊断又拼一句「不可达（原因未知）」，
    // 结果屏幕上出现「不可达 · 不可达（原因未知）」——既重复又没信息。
    // 只断言代码，不断言注释（注释里出现的反例正是这次修复的说明）。
    function reasonTextCode() {
      const html = readHtml('dashboard.html');
      const start = html.indexOf('function reasonText(');
      const end = html.indexOf('function loadHealthPage(');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return html.slice(start, end)
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))   // 去整行注释
        .join('\n');
    }

    it('诊断函数接收 running，才能区分「没启动」与「启动了但卡住」', () => {
      const html = readHtml('dashboard.html');
      expect(html).toContain('function reasonText(r, running)');
      expect(html).toMatch(/reasonText\(rz\s*&&\s*rz\.reason,\s*!!status\.running\)/);
    });

    it('不再把「不可达」重复拼进诊断文字', () => {
      const html = readHtml('dashboard.html');
      expect(html).not.toContain("'不可达 · ' + reasonText");
      // 函数代码里不许再以「不可达」开头返回（外层徽章负责说这句话）。
      // 注意 '网络不可达' 是 EHOSTUNREACH 的真实原因描述，属合法文案，不在此列。
      expect(reasonTextCode()).not.toMatch(/return\s+['"]不可达/);
    });

    it('reason 缺失时仍给可执行判断，不写「原因未知」', () => {
      const code = reasonTextCode();
      expect(code).not.toContain('原因未知');
      expect(code).toContain('该代理未运行');
    });

    it('全部不可达时要说明「不是故障，是代理没启动」并给起法', () => {
      const html = readHtml('dashboard.html');
      expect(html).toContain('没有任何代理在运行');
      expect(html).toContain('bash manage.sh start all');
    });
  });

  describe('API Endpoints (supertest)', () => {
    it('should serve dashboard HTML at /dashboard route', async () => {
      const res = await request(app).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Dashboard');
    });

    it('should have /api/status endpoint returning proxy status data', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });

    it('should have /api/version endpoint', async () => {
      const res = await request(app).get('/api/version');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('proxies');
    });

    it('should have /api/installed endpoint returning proxy list', async () => {
      const res = await request(app).get('/api/installed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should have /api/env-check endpoint', async () => {
      const res = await request(app).get('/api/env-check');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });
  });
});
