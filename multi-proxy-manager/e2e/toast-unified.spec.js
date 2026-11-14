// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// toast 视觉统一 E2E（2026-11-14，老板拍板「视觉合成一套」）
//
// 统一前三套并存：
//   A. dashboard / logs / proxy-config：右上角、白底左色条、带图标、`.toast <type>`
//   B. knowledge / sessions / skills：右下角、纯色底白字、无图标、`.toast-<type>`
//   C. settings：右上角、`.toast--info`（CSS 里根本没定义这个类）
//
// 现在只留 A。这条测试钉住「新的一套真的生效了」，而不只是「代码里写了对的类名」：
//   ① 出现在右上角（B 家族的特征是右下角，所以位置能反证没收错）
//   ② 有图标（B 与 C 都没有）
//   ③ 类名是 `.toast <type>`（不是 `.toast-<type>` 也不是 `.toast--info`）
//   ④ 背景是白/浅色而非纯色块（B 家族是 --color-success 纯色底）
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

async function boxOf(locator) {
  const b = await locator.boundingBox();
  expect(b, 'toast 应该可见（有实际尺寸）').not.toBeNull();
  return b;
}

test('settings 触发 toast：右上角 + 带图标 + 类名契约', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 「检查更新」是页面里最稳的一个 toast 入口：更新源未接入，点了只提示、不联网。
  await page.click('#chkUpdate');

  const toast = page.locator('#toastContainer .toast').first();
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toHaveClass(/\btoast\s+info\b/);
  await expect(toast.locator('.toast-icon svg'), 'must have an icon (family B/C did not)').toHaveCount(1);
  await expect(toast.locator('.toast-msg')).toContainText('更新源');

  const box = await boxOf(toast);
  const vp = page.viewportSize();
  expect(box.x, 'toast 应在视口右半侧（B 家族在右下、A 在右上）').toBeGreaterThan(vp.width / 2);
  expect(box.y, 'toast 应贴顶部（≤120px），而不是 bottom: 24px').toBeLessThan(120);

  // 背景必须是浅色（白/近白），不是 B 家族的纯色块。
  const bg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(m, `背景色应可解析，实际 ${bg}`).not.toBeNull();
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const isLight = (r + g + b) / 3 > 200;
  expect(isLight, `背景应为浅色（A 家族白底），实际 ${bg}——纯色块说明还在用 B 家族的样式`).toBe(true);
});

test('knowledge 页也用同一套 toast（B 家族样式已删）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 该页没有「一键出 toast」的按钮，直接走 kernel 的公开入口——
  // 这同时验证了「本页确实加载了 mp-kernel 且能用」。
  await page.evaluate(() => window.MPKernel.showToast('验证提示', 'error'));

  const toast = page.locator('#toastContainer .toast').first();
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toHaveClass(/\btoast\s+error\b/);
  await expect(toast.locator('.toast-icon svg')).toHaveCount(1);

  const box = await boxOf(toast);
  const vp = page.viewportSize();
  expect(box.y, 'knowledge 的 toast 也必须在顶部（原先固定在 bottom:24px）').toBeLessThan(120);

  // 旧的连字符类名不能再出现（它对应的纯色样式已从页面内联 CSS 删除）
  await expect(toast).not.toHaveClass(/toast-error/);
});
