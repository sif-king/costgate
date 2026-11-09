// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
