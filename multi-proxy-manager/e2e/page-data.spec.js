// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 页面真实数据渲染 E2E（2026-10-24）
//
// 补的是 smoke 的第二层缺口：smoke 只断言「body 有文字」，
// 而一个卡在「加载中…」转圈的页面同样满足 body 有文字——它看起来像在正常加载，
// 实际上是请求挂了没人管。这类「静默等待」和「读失败渲染成空」是同一家族的问题。
//
// 所以这里断言的不是「有数据」，而是**加载态必须收敛**：
// 要么拿到数据，要么落到明确空态，要么落到明确错误态——唯独不许停在「正在加载」。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

test('/floor 盘面初始化必须收敛，不得停在加载态', { tag: ['@tier1'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await seedAuth(page);
  await page.goto('/floor', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 初始文案是「正在加载…」；auto-retry 断言会一直等，永不变化即超时报红。
  const meta = page.locator('#meta');
  await expect(meta).toBeVisible({ timeout: 15000 });
  await expect(meta, '盘面元信息应完成加载（停在「正在加载」= 请求挂了却无人告知）')
    .not.toHaveText(/正在加载/, { timeout: 15000 });

  const text = (await meta.innerText()).trim();
  expect(text.length, '加载完成后的元信息不应为空字符串').toBeGreaterThan(0);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

test('/sessions 会话列表初始化必须收敛，不得停在加载态', { tag: ['@tier1'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await seedAuth(page);
  await page.goto('/sessions', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  const list = page.locator('#sessionsList');
  await expect(list).toBeVisible({ timeout: 15000 });
  await expect(list, '会话列表应完成加载（停在「加载中」= 请求挂了却无人告知）')
    .not.toHaveText(/加载中/, { timeout: 15000 });

  // 收敛后必须是三态之一：有条目 / 明确空态 / 明确错误态。不能是空白。
  const text = (await list.innerText()).trim();
  expect(text.length, '会话列表收敛后应有可见文案（有数据 / 空态 / 错误态之一）').toBeGreaterThan(0);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

for (const [route, sel, label] of [
  ['/logs', '#errorList', '错误模式列表'],
  ['/knowledge', '#docsList', '文档列表'],
  ['/skills', '#skillTable', '技能表'],
]) {
  test(`${route} ${label}容器存在且页面非空白`, { tag: ['@tier1'] }, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedAuth(page);
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

    const box = page.locator(sel);
    await expect(box, `${label}容器应存在`).toBeAttached({ timeout: 15000 });

    const body = (await page.locator('body').innerText()).trim();
    expect(body.length, `${route} 页面应渲染出实际内容`).toBeGreaterThan(20);

    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}

// ==================== 版本号必须来自接口（2026-11-14 拍板）====================
// 背景：侧栏 #sidebarVersion 曾在 nav.js 里写死 'v1.0.0'，九个页面常年显示同一个
// 假版本；设置页「关于」卡另写死「1.0（v1.0 收尾）」。版本号是判断「要不要升级」
// 的依据，写死等于永远告诉用户「已是最新」。这两条断言分别锁住：
//   ① 正常路径：显示值必须等于 /api/version 的返回值（写死就必然对不上）；
//   ② 读失败：必须明说读失败，不许回退成任何像样的版本号。
test('侧栏版本号取自 /api/version，不是写死的字面量', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  const api = await page.evaluate(() => fetch('/api/version').then((r) => r.json()));

  // 先等填充完成（初始是 '—'），再比对；写死 'v1.0.0' 会因为缺少 'Manager ' 前缀而失败。
  await expect(page.locator('#sidebarVersion')).toHaveText(new RegExp('Manager\\s+' + api.version.replace(/\./g, '\\.')), { timeout: 15000 });
});

test('侧栏版本号读失败时明说读失败，不回退成假版本', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.route('**/api/version', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  const el = page.locator('#sidebarVersion');
  await expect(el).toHaveText(/版本读取失败/, { timeout: 15000 });
  // 不许出现任何形如 x.y.z 的版本串——那意味着兜底了一个像样的假值。
  await expect(el).not.toHaveText(/\d+\.\d+\.\d+/);
});

test('设置页「关于」版本行取自 /api/version', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  const api = await page.evaluate(() => fetch('/api/version').then((r) => r.json()));
  const ver = page.locator('#aboutVersion');
  await expect(ver).toContainText(api.version, { timeout: 15000 });
  if (api.date) await expect(ver).toContainText(api.date);
});

// ==================== 键值行必须有间距（2026-11-14）====================
// 为什么测「间距」这种视觉细节：.kv / .kv-row / .kv-k / .kv-v 从首个公开快照起
// 就写在 settings.html 里，而全站 CSS **从未定义过这四个类**——标签和值渲染成
// 「应用costgate」，谁都没发现，因为没人测过它长什么样。「加了类名」不等于
// 「有了样式」，只有量出来的 computed layout 才算数。
test('设置页键值行标签与值之间有间距，且值不溢出卡片', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await page.click('.tab[data-tab="about"]');

  const rows = page.locator('.kv-row');
  await expect(rows.first()).toBeVisible({ timeout: 5000 });
  const n = await rows.count();
  expect(n, '「关于」卡片应有 4 条键值行').toBeGreaterThanOrEqual(4);

  for (let i = 0; i < n; i++) {
    const m = await rows.nth(i).evaluate((row) => {
      const k = row.querySelector('.kv-k'), v = row.querySelector('.kv-v');
      const kb = k.getBoundingClientRect(), vb = v.getBoundingClientRect();
      const rb = row.getBoundingClientRect();
      return { gap: Math.round(vb.x - kb.right), overflow: Math.round(vb.right - rb.right),
               text: row.textContent.trim() };
    });
    expect(m.gap, `第 ${i + 1} 行「${m.text}」标签与值间距应 ≥ 8px（0 表示类名没有样式）`).toBeGreaterThanOrEqual(8);
    expect(m.overflow, `第 ${i + 1} 行「${m.text}」的值不应溢出行的右边界`).toBeLessThanOrEqual(0);
  }
});
