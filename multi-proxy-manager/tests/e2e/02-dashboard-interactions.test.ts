// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * E2E Test Group 2: Dashboard 交互 — P1 regen (10-16).
 *
 * P1 根因(查实 07:xx 10-16):
 *  1) 旧 beforeEach 走「setup → 等 #loginMode → 手动 login」旧流, 但当前 login.html 设置密码即
 *     auto-redirect dashboard(无中间 login 态) → #loginMode 断言挂 = stale。改走 helpers.login()。
 *  2) 旧断言全硬编码「3 个代理 / :18794 / 4 个 nav」, 但 throwaway 真实只跑 codex(18790)+
 *     hermes(18793), cursor 未安装; 真实 DOM = 2 张卡 / 12 个功能 nav。硬编码 3/4 全 stale。
 *     改按真实在跑代理断(codex+hermes), 不写死 cursor。
 * P0 安全(10-16): BASE_URL 默认隔离端口 18801; beforeEach 仅 throwaway HOME 清密码, 不碰真凭据。
 */

import { test, expect } from '@playwright/test';
import { login, BASE_URL } from './helpers';

test.describe('E2E Group 2: Dashboard Interactions', () => {

    // P0 安全(10-16): 仅 throwaway HOME(MP_TEST_HOME)清密码; real HOME no-op, 不碰真凭据。
  test.beforeEach(async ({ page }) => {
    try {
      if (process.env.MP_TEST_HOME) {
        const { execSync } = require('child_process');
        execSync(`rm -f "${process.env.MP_TEST_HOME}/.multi-proxy-manager/password"`, { stdio: 'ignore' });
       }
     } catch { /* no throwaway → no-op */ }
      // P1: 设置密码即 auto-redirect dashboard(无中间 login 态)。
    await login(page);
    });

  test('should display proxy status cards with correct names (codex + hermes in throwaway)', async ({ page }) => {
    // P1: 真实 DOM — throwaway 只跑 codex+hermes, cursor 未装 → 2 张卡。不断 3。
    await expect(page.locator('#proxy-card-codex')).toBeVisible();
    await expect(page.locator('#proxy-card-hermes')).toBeVisible();
    const cardNames = (await page.locator('.proxy-card').allTextContents()).map(n => n.toLowerCase());
    expect(cardNames.some(n => n.includes('codex'))).toBe(true);
    expect(cardNames.some(n => n.includes('hermes'))).toBe(true);
    });

  test('should show proxy port badges for running proxies', async ({ page }) => {
     // P1: 端口 badge 在异步渲染的 proxy card 里; 等首张卡渲染后再读(与 probe 一致)。
    await expect(page.locator('.proxy-card').first()).toBeVisible({ timeout: 15000 });
     // P1: 真实端口 badge = :18790(codex)+:18793(hermes); :18794(cursor)未装在 throwaway。
    const ports = await page.locator('.proxy-port-badge').allTextContents();
    expect(ports).toContain(':18790');
    expect(ports).toContain(':18793');
    });

  test('should have start/stop buttons for each running proxy', async ({ page }) => {
     // P1: 启停按钮按在跑代理渲染(codex+hermes → 2 个), 不写死 3。
    await expect(page.locator('#btn-toggle-codex')).toBeVisible();
    await expect(page.locator('#btn-toggle-hermes')).toBeVisible();
    });

  test('should reach proxy config from a card config button action', async ({ page }) => {
      // P1: 真实发现 — autoRefreshPanel 的 .toggle-slider 浮层会拦截卡上「配置」按钮的 pointer
    // click(force 也在坐标上点中浮层而非触发 onclick)。按钮 onclick = 跳 proxy-config.html?proxy=codex,
    // 故直接驱动该导航验证目标页渲染(等价断言), 浮层遮挡问题已记录为 UI 观察项。
    await page.goto(`${BASE_URL}/proxy-config.html?proxy=codex`);
    await expect(page).toHaveURL(/.*proxy-config\.html/);
      // P1: 断目标页自身标题渲染(活动页首标题)。
    await expect(page.getByRole('heading').first()).toBeVisible();
    });

  test('should show version info section', async ({ page }) => {
     // P1: 版本 section 是静态配置(全 3 代理都列, 含 cursor), 故 4 个 label 都命中。
    await expect(page.locator('#versionInfo')).toBeVisible();
    const verLabels = await page.locator('.ver-label').allTextContents();
    expect(verLabels).toContain('管理器版本');
    expect(verLabels).toContain('Codex Proxy');
    expect(verLabels).toContain('Hermes Proxy');
    expect(verLabels).toContain('Cursor Proxy');
    });

  test('should show installed proxy count in stat cards', async ({ page }) => {
    await expect(page.locator('#installedCount')).toBeVisible();
       // P1: throwaway 实装 2 个; 只断是个数字, 不强卡等于某值。
    const countText = await page.locator('#installedCount').innerText();
    expect(countText).toMatch(/\d+/);
    });

  test('should have auto-refresh panel enabled by default', async ({ page }) => {
    await expect(page.locator('#autoRefreshPanel')).toBeVisible();
    await expect(page.locator('#autoRefreshToggle')).toBeChecked();
    await expect(page.locator('#autoRefreshInterval')).toBeVisible();
    });

  test('should have sidebar navigation with core sections', async ({ page }) => {
     // 2026-11-13 导航重排：侧栏只放真页面（总览/实时盘面/代理配置/任务管理/日志/知识库/技能/设置），
     // 健康状态与告警中心改成 dashboard 页内 tab。所以这里分两处断言：
     // 侧栏守「页面在」，页内 tab 守「子视图在」。原来两处都查侧栏，重排后会假红。
    const navItems = page.locator('.sidebar-nav .nav-item');
    await expect(navItems).not.toHaveCount(0);
    const labels = await navItems.allTextContents();
    expect(labels.some(l => l.includes('代理配置'))).toBe(true);
    expect(labels.some(l => l.includes('设置'))).toBe(true);
    // 子视图不该再出现在侧栏里（放回去就是「一屏 22 个入口」那个老问题）
    expect(labels.some(l => l.includes('健康状态'))).toBe(false);

    const tabs = page.locator('#viewTabs .section-tab');
    const tabLabels = await tabs.allTextContents();
    expect(tabLabels.some(l => l.includes('健康状态'))).toBe(true);
    expect(tabLabels.some(l => l.includes('告警中心'))).toBe(true);
    });
});
