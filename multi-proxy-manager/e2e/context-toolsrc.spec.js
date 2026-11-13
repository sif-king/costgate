// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 「工具 schema 来源」面板 E2E（2026-11-12）
//
// 为什么单独一条：这段逻辑是纯前端累加（把窗口内每请求的 toolsBySource 加总 → 取 Top-5 → 出图例），
// 后端没有对应断言，smoke 只验「页面不崩」验不到算错。所以这里用拦截接口喂**确定性数据**，
// 钉死三件事：
//   ① 跨请求累加（180 / 125 这类是两条 row 相加的结果，不是单条）；
//   ② Top-5 + 「其他」合并（第 6 名及以后进「其他」，不能悄悄丢数）；
//   ③ 标签映射（named→命名工具、mcp:xxx→MCP · xxx、其余原样）。
// 用合成数据而非真账本：真账本内容随时间变，断言会 flaky；这里验的是算法不是数据。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

// total = 344：named 180 / mcp:fs 125 / mcp:github 25 / unnamed 10 / x1 1 / 其余 3
const ROWS = [
  {
    ts: 1762900000000, agent: 'codex', clientKey: 'k1', model: 'm', total: 1000,
    source: 'estimate', byCategory: { tools: 300 }, events: [],
    toolsBySource: { named: 120, 'mcp:fs': 80 },
  },
  {
    ts: 1762900001000, agent: 'codex', clientKey: 'k1', model: 'm', total: 900,
    source: 'estimate', byCategory: { tools: 200 }, events: [],
    toolsBySource: { named: 60, 'mcp:fs': 40, unnamed: 10 },
  },
  {
    ts: 1762900002000, agent: 'claude', clientKey: 'k2', model: 'm', total: 800,
    source: 'estimate', byCategory: { tools: 100 }, events: [],
    toolsBySource: { 'mcp:github': 25, 'mcp:fs': 5, x1: 1, x2: 1, x3: 1, x4: 1 },
  },
];

test('工具 schema 来源面板：跨请求累加 + Top-5 + 其他合并', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/context/recent*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: ROWS }) }));
  await seedAuth(page);
  await page.goto('/context', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  // 等真实图例出现再断言。别等「innerHTML 非空」——加载骨架本身就非空，
  // 会提前放行（本用例第一版就栽在这里：单跑过、并发跑偶发拿到空图例）。
  // 色块 .sw 只有真实数据才渲染，是唯一可靠信号。
  await page.waitForFunction(() => {
    const legend = document.getElementById('toolsrc-legend');
    return !!legend && legend.querySelectorAll('.item .sw').length > 0;
  }, { timeout: 20000 });

  const legend = await page.locator('#toolsrc-legend').innerText();
  // ① 累加：named 120+60=180、mcp:fs 80+40+5=125
  expect(legend).toContain('180');
  expect(legend).toContain('125');
  // ② 标签映射
  expect(legend).toContain('命名工具');
  expect(legend).toContain('MCP · fs');
  expect(legend).toContain('MCP · github');
  expect(legend).toContain('未识别');
  // ③ 占比（180/344≈52%、125/344≈36%、25/344≈7%）
  expect(legend).toContain('52%');
  expect(legend).toContain('36%');
  // ④ Top-5 之后进「其他」，不丢数（x2/x3/x4 共 3）
  expect(legend).toContain('其他 3');

  // 堆叠条：Top-5 段 + 1 段「其他」，宽度合计应约 100%
  const widths = await page.locator('#toolsrc-stack > div').evaluateAll((els) =>
    els.map((e) => parseFloat(e.style.width) || 0));
  const sum = widths.reduce((a, b) => a + b, 0);
  expect(widths.length, '应是 Top-5 + 其他 = 6 段').toBe(6);
  expect(sum, `段宽合计应接近 100%，实际 ${sum}`).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

// 下钻（2026-11-13）：纯前端按 agent / 模型切片，复用 summary.perAgent 与每行 model。
// 这条钉死三件事：
//   ① 切到 agent:codex 后，面板只反映 2 条 codex 行（观测请求=2、趋势 2 行）；
//   ② 成本卡在切片下由前端按 PRICING join（1900 tokens × ¥10/1e6 ≈ ¥0.02），不是整窗数；
//   ③ 切到 model:m 回到 3 条整窗（观测请求=3）。
// 同样用合成数据：验算法不验数据。
const SUMMARY = {
  requests: 3, windowMs: 86400000,
  byCategory: { system: 0, tools: 200, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
  peak: 1000, actualCoverage: 0, events: {}, warnings: {},
  perAgent: { codex: 2, claude: 1 }, dropped: 0, diskErrors: 0, lastUpdated: 1762900002000,
  estimatedCny: 0.05, costBasis: '估算 · 窗口各请求按模型 input 价目',
};
const PRICING = { m: { input: 10, output: 0 } };

test('下钻：按 Agent 切片只反映该 agent 行，成本由前端 join', { tag: ['@tier1', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/context/summary*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUMMARY) }));
  await page.route('**/api/context/recent*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: ROWS }) }));
  await page.route('**/api/context/pricing*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pricing: PRICING }) }));
  await seedAuth(page);
  await page.goto('/context', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  // 等下钻选项由 buildDrill 填好（summary+recent+pricing 三路 resolve 后）。
  await page.waitForFunction(() => {
    const s = document.getElementById('drillSel');
    return !!s && s.options.length > 1;
  }, { timeout: 20000 });

  // 切到 agent:codex
  await page.selectOption('#drillSel', 'agent:codex');
  await page.waitForFunction(() => {
    const m = document.getElementById('meta');
    return !!m && /agent = codex/.test(m.textContent || '') && /2 请求/.test(m.textContent || '');
  }, { timeout: 10000 });
  await expect(page.locator('#kpi')).toContainText('观测请求');
  await expect(page.locator('#kpi')).toContainText('2');
  // 切片成本 ≈ ¥0.02（1900 tokens × ¥10/1e6，四舍五入）
  await expect(page.locator('#kpi')).toContainText('¥0.02');
  // 趋势只含 2 条（codex 两行）
  const trendCount = await page.locator('#trend .trow').count();
  expect(trendCount, 'agent:codex 应只剩 2 行趋势').toBe(2);

  // 切到 model:m（全量）
  await page.selectOption('#drillSel', 'model:m');
  await page.waitForFunction(() => {
    const m = document.getElementById('meta');
    return !!m && /model = m/.test(m.textContent || '') && /3 请求/.test(m.textContent || '');
  }, { timeout: 10000 });
  const trendCountAll = await page.locator('#trend .trow').count();
  expect(trendCountAll, 'model:m 应是全部 3 行').toBe(3);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

