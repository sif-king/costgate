// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 入口路由回归（2026-10-25 订正）
//
// 原断言「/index.html → redirect 到 dashboard.html」是**过期断言**：
// index.html 已于 2026-10-23（决策 D：入口屏合并进 dashboard）删除，
// 实测 GET /index.html 返回 `Cannot GET`（404）——这条测试一直在测一个不存在的文件。
// 现在的契约是：`/` 由 SPA fallback 直出 dashboard.html，没有 index 这一跳。
//
// 顺带修掉原第二条用例的恒真断言 `(text || 'Proxy Manager').length > 0`：
// 兜底字符串让断言永远为真，等于没测。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

test('/ 直出 dashboard，且不白屏', { tag: ['@tier1'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // 不应有 .html 这一跳，也不应被踢去登录
  await expect(page, '/ 应停留在根路径（SPA fallback 直出）').toHaveURL(/\/$/, { timeout: 15000 });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 直出的是 dashboard：拿 dashboard 独有的门控条作指纹，比 title 更硬
  await expect(page.locator('#gateBar'), '/ 应直出 dashboard（含门控条）').toBeVisible({ timeout: 15000 });

  // 真渲染：body 得有实际内容（不再用 `|| 'Proxy Manager'` 兜底，那是恒真）
  const text = (await page.locator('body').innerText()).trim();
  expect(text.length, '/ 应渲染出实际内容，不白屏').toBeGreaterThan(100);
});

test('/dashboard 正常渲染且不白屏', { tag: ['@tier1'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await expect(page.locator('#gateBar')).toBeVisible({ timeout: 15000 });

  const title = await page.title();
  expect(title.trim().length, 'document.title 应非空').toBeGreaterThan(0);
});
