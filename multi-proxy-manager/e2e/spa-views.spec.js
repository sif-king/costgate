// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// dashboard 页内 SPA 子视图 E2E（2026-10-24）
//
// 补的是 smoke 没覆盖的一层：smoke 只验「页面能加载不崩」，而侧栏这 5 个按钮
// 是**页内路由**——按钮渲染出来了不等于点了有反应。这正是「假功能」最高发的形态：
// 控件齐全、点击无声。所以这里逐个真点，并断言目标面板真的变成活动态且有内容。
//
// 口径：不断言具体业务数值（那是 jest 的活），只断言「切换生效 + 渲染出东西 + 不是卡在加载态」。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

const spaViews = [
  { id: 'health', label: '健康状态' },
  { id: 'alerts', label: '告警中心' },
  { id: 'registry', label: 'Agent 清单' },
  { id: 'cost', label: '成本' },
  { id: 'shadow', label: '路由预演' },
];

for (const view of spaViews) {
  test(`dashboard 子视图「${view.label}」点击后真实切换并渲染`, { tag: ['@tier1'] }, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedAuth(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

    const btn = page.locator(`.nav-item[data-page="${view.id}"]`);
    // 按钮不存在 = 侧栏没渲染出这个入口，直接红（不静默跳过）
    await expect(btn, `侧栏应有「${view.label}」入口`).toBeVisible({ timeout: 15000 });

    await btn.click();

    const panel = page.locator(`#page-${view.id}`);
    await expect(panel, `点击后 #page-${view.id} 应变为活动视图`).toHaveClass(/active/, { timeout: 15000 });
    await expect(panel, `点击后 #page-${view.id} 应可见`).toBeVisible({ timeout: 15000 });

    // 渲染出真东西：面板文本非零散空白
    const text = (await panel.innerText()).trim();
    expect(text.length, `#page-${view.id} 应有实际内容（真渲染，非白屏）`).toBeGreaterThan(20);

    // 不允许卡在加载态：加载态文案残留 = 数据请求挂了却没人告诉用户
    expect(text, `#page-${view.id} 不应停留在加载态`).not.toMatch(/^加载中|正在加载…?$/);

    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}
