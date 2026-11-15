// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 复制失败必须说话（2026-11-15，CI 抓到的真缺陷）
//
// 来历：P0/E2E 两个 workflow 在 82fde8e 上双红，失败点不是业务断言，而是
//   NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.
// headless Linux 默认不给剪贴板权限；原实现 `writeText(x).then(成功提示)` 没接拒绝
// 分支 ⇒ 用户点「复制」后页面**毫无反应**，只有控制台多一条 unhandled rejection。
// macOS 本地跑是绿的（权限放行），所以这条只有 CI 能抓到——也正是它必须进 @tier0 的原因。
//
// 这条用例把「失败模式本身」钉死，不依赖运行环境是否允许剪贴板：
//   ① 强制 writeText → reject，且 execCommand → false（两条路都断）
//   ② 真点复制按钮
//   ③ 必须出现错误提示、必须把 URL 露出来让人手抄、必须没有全局异常
// 判据不是「弹了个 toast」，而是「失败被说成了失败」，且没有 unhandled rejection。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

test('剪贴板被拒时复制按钮必须报失败并给出可手抄的内容（不许点了没反应）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 在任何页面脚本之前注入：剪贴板两条路都断掉。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
    // execCommand 兜底也要断：否则 headless 下它可能返回 true，用例就变成
    // 「环境相关」——这类用例迟早被标成 flaky 然后被跳过，等于没守卫。
    document.execCommand = () => false;
  });

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 默认视图是「今天」，统一入口卡在总览页 —— 先切过去，否则按钮不可见。
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });

  await page.locator('button[onclick="copyUnifiedIngressUrl()"]').click();

  // 失败必须被说成失败：出现 error 态 toast，且带出 URL 本身（让用户能手抄）。
  const toast = page.locator('.toast.error, .toast-error');
  await expect(toast, '复制被拒时必须弹错误提示（点完没反应=用户以为坏了）').toBeVisible({ timeout: 15000 });
  await expect(toast, '错误提示里要带出可手抄的 URL').toContainText('http://127.0.0.1:18880/v1');
  await expect(toast, '要说清是「被拒绝」而不是含糊的失败').toContainText('拒绝');

  // 关键：写失败被接住 ⇒ 不该有 unhandled rejection / 未捕获异常。
  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});
