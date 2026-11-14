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
  // 「今天」是 2026-11-13 新增的第一个，也是默认页——它最容易出的问题是
  // 「数据没到就停在一堆加载态」，所以必须被这条盯着。
  { id: 'today', label: '今天' },
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

    // 2026-11-13 导航重排：这 5 个视图从侧栏挪到 dashboard 页内 tab。
    // 断言目标跟着改，但守的东西没变：点了必须真切换、真渲染、不卡加载态。
    // 别把这条放宽成「元素存在就算过」——那样「控件齐全、点击无声」会重新变成盲区。
    const btn = page.locator(`#viewTabs .section-tab[data-page="${view.id}"]`);
    // 按钮不存在 = 页内 tab 没渲染出这个入口，直接红（不静默跳过）
    await expect(btn, `页内 tab 应有「${view.label}」入口`).toBeVisible({ timeout: 15000 });

    await btn.click();

    const panel = page.locator(`#page-${view.id}`);
    await expect(panel, `点击后 #page-${view.id} 应变为活动视图`).toHaveClass(/active/, { timeout: 15000 });
    await expect(panel, `点击后 #page-${view.id} 应可见`).toBeVisible({ timeout: 15000 });

    // 渲染出真东西：面板文本非零散空白
    const text = (await panel.innerText()).trim();
    expect(text.length, `#page-${view.id} 应有实际内容（真渲染，非白屏）`).toBeGreaterThan(20);

    // 不允许卡在加载态：加载态文案残留 = 数据请求挂了却没人告诉用户
    expect(text, `#page-${view.id} 不应停留在加载态`).not.toMatch(/^加载中|正在加载…?$/);

    // 2026-11-14 加：不允许「假成功」——面板上出现「加载失败」/ 未定义函数名，
    // 意味着数据没到却静默停在错误提示。shadow 视图过去就是这样：getAuthHeader
    // 从未定义，但面板「看起来渲染了」（19 字「加载失败：getAuthHeader is not defined」
    // 也 >20），假绿了几个月。这是「控件齐全、点击无声」的下位变体：点了有反应，
    // 但反应是错误提示。
    expect(text, `#page-${view.id} 不应显示加载失败类错误（过去是假绿）`)
      .not.toMatch(/加载失败|is not defined|读取失败|Failed to fetch|NetworkError/i);

    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}

// shadow 视图的专属断言：CI 只跑 @tier0，必须盯住它
// 为什么单独加一条：路由预演页 2026-11-14 才发现 getAuthHeader 从未被定义，
// 面板上只有「加载失败」一行小字，E2E 只断言「切换 + 文本 >20 字」一直假绿。
// 这条把「必须真的出卡片」钉死，防止回归。
test('dashboard 子视图「路由预演」必须真出能力卡片，不允许停在失败提示', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  await page.click('#viewTabs .section-tab[data-page="shadow"]');
  const panel = page.locator('#page-shadow');
  await expect(panel).toHaveClass(/active/, { timeout: 15000 });

  // 关键判据：真实渲染出至少一张能力卡片。
  // 过去假绿是因为「加载失败：getAuthHeader is not defined」这一行文本长度 >20，
  // 恰好骗过了「面板文本非空白」这条。真数据下 /api/l2/shadow-map 一定返回能力。
  const cards = page.locator('#shadowGrid .shadow-card');
  await cards.first().waitFor({ state: 'attached', timeout: 15000 });
  const cardN = await cards.count();
  expect(cardN, '路由预演必须真出能力卡片（否则接口或鉴权链路坏了）').toBeGreaterThanOrEqual(1);

  // 失败提示必须真的消失：banner 的 display 从 block 变回 none。
  const alert = page.locator('#shadowAlert');
  await expect(alert).toHaveCSS('display', 'none', { timeout: 15000 });

  // 政策徽章必须真的填上（不再是「策略：—」）
  await expect(page.locator('#shadowPolicy'), '政策徽章应被填上实际策略名')
    .not.toHaveText(/^无候选策略：—$/, { timeout: 15000 });

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

// alerts 视图的专属断言：搜索过滤必须真生效（2026-11-14，2.3b 第二片）
// 为什么单独加：filterAlerts 曾是「从未挂到 window」的 13 个函数之一——搜索框
// oninput 抛 ReferenceError、列表纹丝不动，E2E 只点 tab 没人发现。这条把
// 「输入 → 过滤 → 输出变化」整条链钉死：搜一个必然无匹配的词，列表必须真的变。
test('dashboard 子视图「告警中心」搜索框过滤真生效（filterAlerts 链路）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // stub 告警接口：过滤链路要验证「有条目 → 搜出子集 → 清空恢复」，本机告警
  // 功能默认门控关（alertEvents 恒空），没法产生可见的过滤差异。给确定性的
  // 两条假数据（一条含探针词、一条不含），链路验证就与环境无关。
  await page.route('**/api/alert', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ events: [
      { severity: 'critical', rule: 'probe-hit 规则', message: '含探针词 probe-hit 的告警', timestamp: '2026-11-14T10:00:00Z' },
      { severity: 'info', rule: '另一条', message: '不含探针词的普通告警', timestamp: '2026-11-14T09:00:00Z' },
    ], count: 2 }),
  }));
  await page.route('**/api/alert/config', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ gateOpen: true }),
  }));

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  await page.click('#viewTabs .section-tab[data-page="alerts"]');
  const panel = page.locator('#page-alerts');
  await expect(panel).toHaveClass(/active/, { timeout: 15000 });

  // 等 load() 真收敛：stub 下应渲染出 2 个 .alert-item。
  // 必须等收敛——否则竞态：fill 先触发 filter 渲染空列表、load 结果后到覆盖回去，
  // 断言取到的是被覆盖后的文本（这个竞态在真跑里实际发生过）。
  const items = page.locator('#alertList .alert-item');
  await expect(items, 'stub 的两条告警都应渲染出来').toHaveCount(2, { timeout: 15000 });

  // 输入探针词：oninput → window.filterAlerts → 过滤渲染。
  // filterAlerts 曾从未挂到 window，这条链断了没有任何测试会红。
  await page.fill('#alertSearch', 'probe-hit');
  await page.waitForTimeout(300);
  await expect(items, '搜索探针词后应只剩含词的 1 条').toHaveCount(1);

  // 清空搜索词 → 恢复 2 条
  await page.fill('#alertSearch', '');
  await page.waitForTimeout(300);
  await expect(items, '清空搜索词后应恢复 2 条').toHaveCount(2);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});
