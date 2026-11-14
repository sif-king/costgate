// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 门控「重新检测」按钮必须真能点（2026-11-15 全站体检揪出）
//
// 背景：knowledge.html / skills.html 里各有一个 `function checkGate()` 声明在页面
// IIFE 内，而静态 HTML 写的是 `onclick="checkGate()"`。内联 handler 在**全局作用域**
// 解析函数名，看不见 IIFE 里的局部声明——真浏览器实测两页点击均抛
// `ReferenceError: checkGate is not defined`，`window.checkGate === undefined`。
// 这两页的按钮是「门控没开 / 读失败」时用户唯一的自救入口，坏了等于把用户锁死。
//
// 为什么此前全绿：smoke 只断言「页面能加载、有标题、无 pageerror」，而错误只在
// **点击时**才发生，加载阶段一片安静。与 D-016（shadow 假成功）、D-017（13 个内联
// handler）同族：控件齐全、点击无声。
//
// 这条钉住两件事：① 函数真的挂到了 window；② 真点下去没有致命 JS 异常。
// 只断言①不够——挂了 undefined 也能骗过 typeof 的粗检查；只断言②不够——按钮
// 若因门控态恰好不可见，点击会被跳过，异常也不会发生。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

for (const [route, label] of [['/knowledge', '知识库'], ['/skills', '技能']]) {
  test(`${label}页「重新检测」按钮必须真能点（checkGate 挂 window）`, { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedAuth(page);
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

    // ① 挂载契约：必须是可调用的函数，不是 undefined
    await expect.poll(
      () => page.evaluate(() => typeof window.checkGate),
      { timeout: 15000, message: 'checkGate 必须挂到 window（内联 onclick 在全局作用域解析）' }
    ).toBe('function');

    // ② 真点按钮：静态 HTML 里的 onclick 必须真的调到函数
    const btn = page.locator('button[onclick="checkGate()"]').first();
    await expect(btn, `「重新检测」按钮应渲染出来`).toBeAttached({ timeout: 15000 });
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(400);
    }

    expect(errors, `点击「重新检测」不应有致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}
