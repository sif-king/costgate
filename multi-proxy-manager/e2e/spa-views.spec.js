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

// registry 视图专属断言（2026-11-15，2.3b 第四片）
// 为什么单独加：这一片把取数/渲染/筛选/增删改整块搬到 views/registry.js，
// 页面只剩薄包装。最容易出的坏法不是「白屏」，而是「script 没接线 / 顺序错了」——
// 页面骨架照常渲染、tab 照常切换、只有卡片是空的，只点 tab 的 SPA 用例全绿。
// 所以这里同时钉住三件事：真出卡片、筛选真生效、弹窗与动态生成的编辑按钮真点得动。
test('dashboard 子视图「Agent 清单」筛选与弹窗真生效（views/registry.js 接线）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 给确定性的两条数据，链路验证与本机注册表状态无关。写请求也 stub 掉，
  // 避免「点一遍控件」真的往注册表里写脏数据。
  await page.route('**/api/registry/agents', (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, success: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ agents: [
        { id: 'probe-hit-agent', name: '探针 Agent', type: 'codex', capabilityTags: ['probe-hit'], description: '含探针词' },
        { id: 'plain-agent', name: '普通 Agent', type: 'hermes', capabilityTags: [], description: '不含' },
      ] }) });
  });

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  await page.click('#viewTabs .section-tab[data-page="registry"]');
  const panel = page.locator('#page-registry');
  await expect(panel).toHaveClass(/active/, { timeout: 15000 });

  const cards = page.locator('#registryGrid .registry-card');
  await expect(cards, 'stub 的两个 Agent 都应渲染成卡片').toHaveCount(2, { timeout: 15000 });

  // oninput → window.filterRegistry → 过滤渲染（D-017 曾漏挂的那个函数之一）
  await page.fill('#registrySearch', 'probe-hit');
  await page.waitForTimeout(300);
  await expect(cards, '搜索探针词后应只剩 1 张卡').toHaveCount(1);
  await page.fill('#registrySearch', '');
  await page.waitForTimeout(300);
  await expect(cards, '清空搜索词后应恢复 2 张卡').toHaveCount(2);

  // 静态内联「新增 Agent」→ 弹窗；「取消」→ 关掉。
  await page.locator('#page-registry button[onclick="showAddAgentModal()"]').click();
  await expect(page.locator('#agentModal')).toBeVisible({ timeout: 15000 });
  await page.locator('#agentModal button[onclick="closeAgentModal()"]').click();
  await expect(page.locator('#agentModal')).toBeHidden({ timeout: 15000 });

  // 卡片里**动态生成**的 onclick（editAgent）也要真点得动：它挂全局是模块的责任。
  await cards.first().locator('button[onclick^="editAgent("]').click();
  await expect(page.locator('#agentModal')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#agentId'), '编辑态应把 id 填进表单').toHaveValue('probe-hit-agent');
  await page.locator('#agentModal button[onclick="closeAgentModal()"]').click();

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

// cost 视图专属断言（2026-11-15，2.3b 第五片）
// 为什么单独加：这一片把「成本页 / 上周账单 / 账本 Hero」三块搬到 views/cost.js，
// 三者全靠静态内联 onclick 触发，而且都是「读接口 → 拼 HTML」。坏法有三种且都
// 只点 tab 查不出来：① script 没接线（点了刷新抛 ReferenceError，但首次进入由
// switchPage 调的是页面薄包装，看起来正常）② 只渲染容器不渲染数（空壳）③ 把
// 「读不到」渲染成「没有」。所以这里 stub 掉三个接口，断言三块区域都出**具体数值**，
// 再真点「刷新」验证链路活着、没有全局异常。
test('dashboard 子视图「成本」余额/预算/周报真出数，刷新按钮真触发（views/cost.js 接线）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const watchtower = {
    ok: true,
    window: { fromDay: '2026-11-08', toDay: '2026-11-14' },
    spend: { actualCost: 12.5, requestCount: 7, currency: 'CNY' },
    saved: { computable: true, byRouting: 3, baselineCost: 15.5 },
    zeroCost: { ratio: 0.25, requestCount: 2 },
    dataQuality: { unknownModelRatio: 0, unknownModelCount: 0, entryCount: 7, unknownAgentCount: 0 },
    byAgent: [{ agent: 'probe-cost-agent', actualCost: 12.5, requests: 7, topModel: 'probe-model' }],
    caveats: ['口径：省下的钱是按对标价格反算的'],
    tracking: { enabled: true, hint: '已开启记账' },
  };

  // 三个接口都给确定性数据；watchtower 同时喂「成本页」和「总览账本 Hero」。
  await page.route('**/api/balances', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ balances: [{ provider: 'probe-provider', amount: 42.5 }] }),
  }));
  await page.route('**/api/budget', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ level: 'warn', enabled: true, caps: { total: 123.45 }, prices: { 'probe-model': 1 }, configHash: 'deadbeefdeadbeefcafe' }),
  }));
  await page.route('**/api/cost/watchtower**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(watchtower),
  }));

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 账本 Hero 在 init() 里就拉（页面壳本身也会崩，所以先验它）。
  await expect(page.locator('#costSovereigntyBody'), '总览账本卡应显示上周实际花费')
    .toContainText('上周实际花费', { timeout: 15000 });
  await expect(page.locator('#costSovereigntyBody')).toContainText('CNY 12.5');

  await page.click('#viewTabs .section-tab[data-page="cost"]');
  await expect(page.locator('#page-cost')).toHaveClass(/active/, { timeout: 15000 });

  // ① 余额：真出 provider 名 + 金额（不是「暂无余额数据」空态）
  const bal = page.locator('#costBalanceList');
  await expect(bal, 'stub 的 provider 名应渲染出来').toContainText('probe-provider', { timeout: 15000 });
  await expect(bal, '余额金额应渲染出来').toContainText('42.50');

  // ② 预算：level=warn → 文案「警告」，且总上限真印出来
  const bud = page.locator('#costBudgetInfo');
  await expect(bud, 'warn 判级应显示「警告」').toContainText('警告', { timeout: 15000 });
  await expect(bud, '总上限应真印出来').toContainText('123.45');
  await expect(bud, '价表模型数应真印出来').toContainText('1');

  // ③ 周报：卡片数值 + 按 agent 归因 + 口径说明
  const wt = page.locator('#watchtowerSummary');
  await expect(wt, '周报应显示实际花费').toContainText('实际花费', { timeout: 15000 });
  await expect(wt).toContainText('CNY 12.5');
  await expect(wt, '窗口应显示').toContainText('2026-11-08');
  await expect(page.locator('#watchtowerAgents'), '按 agent 归因应出条目').toContainText('probe-cost-agent');
  await expect(page.locator('#watchtowerCaveats'), '口径说明应显示').toContainText('对标价格');

  // ④ 真点「刷新」（静态内联 onclick → 全局作用域解析）：必须无异常且仍出数。
  // 这一下是这条用例的核心——模块没接线时，点它会抛 ReferenceError 而页面看起来没变。
  await page.locator('#page-cost button[onclick="loadCostPage()"]').click();
  await page.waitForTimeout(500);
  await expect(bal, '刷新后余额应重新渲染').toContainText('probe-provider');
  await page.locator('#page-cost button[onclick="loadWatchtower()"]').click();
  await page.waitForTimeout(500);
  await expect(wt, '刷新后周报应重新渲染').toContainText('CNY 12.5');

  // ⑤ 总览账本卡的「刷新」内联 handler 也要真点得动（先切回总览，否则卡片不可见）。
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });
  await page.locator('#costSovereigntyCard button[onclick="loadCostSovereignty()"]').click();
  await page.waitForTimeout(500);
  await expect(page.locator('#costSovereigntyBody')).toContainText('上周实际花费');

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

// health 视图专属断言（2026-11-15，2.3b 第六片）
// 为什么单独加：这一片是**第一个非自治视图**——它原读页面 IIFE 的 proxyStatus、
// PROXY_CONFIGS 与三个共享渲染件，抽离时必须先落 mp-shared.js。坏法比前几片多两种：
//   ① 加载顺序错（views/health.js 早于 mp-shared.js）→ 模块整体 console.error 不加载，
//      健康页停在「正在加载健康状态...」，而 tab 切换、面板可见全都正常（假绿）；
//   ② 模块裸用页面本地名 → ReferenceError 只在交互时抛。
// 所以这里 stub 四个接口 + 配置接口，断言三类统计数、列表真出条目（含配置里的显示名，
// 证明 MPShared 通路活着）、延迟/运行时间两列真有值（老 bug：字段名读错恒显示 —）、
// Provider 隔离与历史真渲染，再真点「刷新」和改下拉条数（内联 onchange）。
test('dashboard 子视图「健康」三类统计/列表/隔离/历史真出数，刷新与条数下拉真触发（views/health.js 接线）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const historyCalls = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/health-history')) historyCalls.push(r.url());
  });

  // 配置接口：显示名故意与 key 不同，用来证明视图真的走了 MPShared.get
  // （走不到就会退化成裸 key 'codex'，断言立刻红）。
  await page.route('**/api/proxy-configs', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ codex: { name: 'Probe Health Proxy', port: 18790, defaultVersion: '9.9.9' } }),
  }));
  // /api/status 真实形状是**扁平 map**（不是 {proxies:...}），这里照抄，
  // 免得测的是一个后端根本不会返回的形状。
  await page.route('**/api/status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      codex: { running: true, port: 18790, fault: false,
               health: { status: 'ok', latencyMs: 12 },
               rawHealth: { uptime: 3720 } },
      claude: { running: false, port: 18791, fault: false },
      cursor: { running: true, port: 18794, fault: false, health: { status: 'degraded', reasons: ['provider 连续失败'] } },
    }),
  }));
  // readyz：真探测优先。claude 带 ECONNREFUSED 原因码，用来验证 reasonText 走共享层。
  await page.route('**/api/readyz', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ proxies: { total: 2, details: [
      { name: 'codex', reachable: true },
      { name: 'claude', reachable: false, reason: 'ECONNREFUSED' },
    ] } }),
  }));
  await page.route('**/api/provider-health', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isolateEnabled: false, isolated: [{
      providerId: 'probe-provider', consecutiveFailures: 3,
      unhealthyUntil: Date.now() + 600000,
      correlation: { verdict: 'single-proxy', sources: ['probe-src-a'] },
    }] }),
  }));
  await page.route('**/api/health-history**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ history: [
      { proxy: 'probe-health-proxy', status: 'degraded', reason: 'probe-reason', timestamp: 1763200000000 },
    ] }),
  }));

  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 等页面 init 的 fetchProxyConfigs 落地再切健康页：配置仓是异步填的，
  // 早于它渲染会退化成裸 key（这正是这条用例要盯的通路，不能靠「等一下」糊过去）。
  await page.waitForFunction(() => window.MPShared && window.MPShared.proxyConfigNames().length > 0, null, { timeout: 15000 });

  // 等页面 init 的 fetchProxyConfigs 落地再切健康页：配置仓是异步填的，
  // 早于它渲染会退化成裸 key（这正是这条用例要盯的通路，不能靠「等一下」糊过去）。
  await page.waitForFunction(() => window.MPShared && window.MPShared.proxyConfigNames().length > 0, null, { timeout: 15000 });

  await page.click('#viewTabs .section-tab[data-page="health"]');
  await expect(page.locator('#page-health')).toHaveClass(/active/, { timeout: 15000 });

  // ① 三类统计：ok=1（codex）、degraded=1（cursor）、down=1（claude）
  const cnt = (id) => page.locator('#' + id);
  await expect(cnt('healthOkCount'), '健康数应为 1').toHaveText('1', { timeout: 15000 });
  await expect(cnt('healthDegradedCount'), '降级数应为 1').toHaveText('1');
  await expect(cnt('healthDownCount'), '故障数应为 1').toHaveText('1');
  await expect(cnt('healthHistoryCount'), '历史条数应为 1').toHaveText('1');

  // ② 列表：配置显示名（MPShared 通路）+ 延迟/运行时间（字段名归一）+ 不可达原因（reasonText）
  const list = page.locator('#healthProxyList');
  await expect(list, '应渲染配置里的显示名（走 MPShared.get）').toContainText('Probe Health Proxy', { timeout: 15000 });
  await expect(list, '延迟列应读 latencyMs（老 bug：恒显示 —）').toContainText('12ms');
  await expect(list, '运行时间应读 rawHealth.uptime（3720s → 1h2m）').toContainText('1h2m');
  await expect(list, '不可达原因应经 reasonText 给出原因+处置').toContainText('连接被拒');

  // ③ Provider 隔离 + 副标题口径（observe 模式）
  await expect(page.locator('#healthPagePhList'), '隔离项应渲染').toContainText('probe-provider');
  await expect(page.locator('#healthPagePhSubtitle'), '副标题应说明 observe 模式').toContainText('observe 模式');

  // ④ 健康历史
  await expect(page.locator('#healthHistoryList'), '历史应渲染原因').toContainText('probe-reason');

  // ⑤ 真点「刷新」：静态内联 onclick → 全局作用域解析，模块没挂 window 就抛 ReferenceError
  const before = historyCalls.length;
  await page.locator('#page-health button[onclick="loadHealthPage()"]').click();
  await expect.poll(() => historyCalls.length, '刷新应重新请求健康历史').toBeGreaterThan(before);
  await expect(list, '刷新后列表仍应出条目').toContainText('Probe Health Proxy');

  // ⑥ 改条数下拉（内联 onchange="loadHealthHistory()"）：必须真带上新 limit 重新取数
  await page.selectOption('#healthHistoryLimit', '20');
  await expect.poll(() => historyCalls.some((u) => /limit=20/.test(u)), '下拉改 20 条应带 limit=20 重新请求').toBe(true);
  await expect(page.locator('#healthHistoryList'), '改条数后历史仍应渲染').toContainText('probe-reason');

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});
