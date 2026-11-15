// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 自动刷新调度 E2E（2026-11-15，2.3b 收口后第一片「壳」）
//
// 为什么单独一个 spec：自动刷新是**唯一一个「开关状态」与「实际行为」可以互相
// 说谎**的功能。开关画在界面上是 ON，定时器却可能已经没了 —— 界面对，行为不对，
// 而屏幕上的数字只是停住不动。tick 里那句注释自己写着这个后果有多糟：
// 「否则开着面板对着不动的数字，会让人以为记账停了（这个功能最怕的就是"看起来没在记"）」。
//
// 三条用例对应三个**真出现过/真会出**的坏法：
//   ① 点一次别的 tab 再回来，自动刷新就永久死掉（定时器被 clear 却没人重建）
//      —— 这是本轮实测发现的，开关还亮着，数字再也不动。
//   ② 「关掉」记不住：刷新页面又自己开始刷（两种关闭方式行为不一致：
//      把间隔选成「关闭」会持久化，拨开关关掉不会）。
//   ③ 存进去的间隔不在选项里（旧版本留下的 45 秒 / 手改过 / 以后删了某个选项）
//      ⇒ select.value 变空串 ⇒ parseInt('') = NaN ⇒ setInterval(fn, NaN) 被当成 0
//      ⇒ 每几毫秒一次请求的**自我风暴**。这条用「限定时间内的请求数」判，
//      不判实现细节：风暴是行为，不是写法。
//
// 口径：不只断言控件长得对（那是 jest 的活），只断言**真发不发请求**。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

// 这个文件天生比别的慢：要真等一个刷新周期（5 秒档）才看得见「刷了 / 没刷」。
// 全量跑（4 worker）时时序被拉长，30 秒默认超时会先把被测物掐死再报「失败」——
// 那是假红。所以显式抬高本文件的上限，让它等的就等够。
test.describe.configure({ timeout: 90000 });

// 只 stub 掉会被本轮计数的接口，让「请求次数」这件事可控可复现。
async function stubPanelApis(page) {
  await page.route('**/api/today/days', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ days: [] }),
  }));
  await page.route('**/api/today*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      day: '2026-11-15', requests: 0, tokens: 0, files: [],
      totals: { requests: 0, tokens: 0, cost: 0 },
    }),
  }));
}

function countRequests(page, pattern) {
  const hits = [];
  page.on('request', (r) => { if (pattern.test(r.url())) hits.push(r.url()); });
  return hits;
}

// 等「首屏自己的那一次取数」真的结束。
// 为什么必须有这一闸：init 里 loadStatus 排在 checkAuth → fetchProxyConfigs 之后，
// 慢一点就会晚到几百毫秒。若在它之前开始计数，「关掉之后有没有偷跑」会把这次正常首屏
// 加载算进去 —— 那是**假红**（本仓栽过的两类假绿的反面，一样要防）。
// 判据用统计卡是否还在转圈：它由 loadStatus 的渲染结果决定，不靠固定 sleep。
async function waitFirstPaint(page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('proxyStatusCount');
    if (!el) return false;
    return !el.querySelector('.loading-spinner') && el.textContent.trim() !== '';
  }, null, { timeout: 30000 });
}

test('自动刷新要跨 tab 活着：去别的页再回来，数字仍按间隔刷新（开关亮着就必须真在刷）', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await stubPanelApis(page);
  const todayCalls = countRequests(page, /\/api\/today(\?|$)/);

  // 间隔调到最小档（5 秒）再进页面：这条要真等一个周期，不能靠探针糊过去。
  await page.addInitScript(() => {
    try { localStorage.setItem('autoRefreshInterval', '5'); } catch (e) {}
  });
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 首屏默认在「今天」：定时器必须已经建起来（这条现在就是绿的，留作基线）。
  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '首屏就应有自动刷新定时器').toBe(true);

  // 去「健康状态」再回到「今天」—— 这一步之后定时器曾经永久消失。
  await page.click('#viewTabs .section-tab[data-page="health"]');
  await expect(page.locator('#page-health')).toHaveClass(/active/, { timeout: 15000 });
  await page.click('#viewTabs .section-tab[data-page="today"]');
  await expect(page.locator('#page-today')).toHaveClass(/active/, { timeout: 15000 });

  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '切回「今天」后定时器必须还在（开关亮着却没人重建 = 自动刷新永久死掉）').toBe(true);

  // 行为证据：切回后 basename 计数，再等一个周期，必须真多刷一次。
  const before = todayCalls.length;
  await expect.poll(() => todayCalls.length - before,
    '切回来后必须真的按 5 秒周期继续刷新 /api/today（只恢复探针不恢复请求也算失败）')
    .toBeGreaterThan(0, { timeout: 12000 });

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

test('自动刷新「关掉」要记住：拨开关关掉后刷新页面，仍是关的、且真的一次都不刷', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const statusCalls = countRequests(page, /\/api\/status(\?|$)/);

  await stubPanelApis(page);
  // 间隔调到最小档：刷新之后要**用请求数**证明「真的没人在刷」。
  // 10 秒档要等 10 秒才可能看见一次偷跑，5 秒档 6.5 秒就够 —— 这条等的就是它。
  await page.addInitScript(() => {
    try { localStorage.setItem('autoRefreshInterval', '5'); } catch (e) {}
  });
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });

  // 控件在「概览」页里，先切过去。
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });
  await waitFirstPaint(page);

  const toggle = page.locator('#autoRefreshToggle');
  await expect(toggle, '默认应是开着的').toBeChecked({ timeout: 15000 });
  // 点的是**滑块**而不是 input：这个开关是 label 包 input + 一个覆盖在上面的
  // span.toggle-slider，用户手指落到的永远是那个 span（直接点 input 会被它拦住）。
  // 用真手势，别用 setChecked 之类的程序化赋值 —— 那样连 change 事件都不一定发。
  await page.locator('#autoRefreshPanel .toggle-slider').click();
  await expect(toggle, '点滑块后应变成关闭').not.toBeChecked({ timeout: 15000 });
  // 关掉 = 定时器真的停（不是只改了个勾）。
  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '关掉自动刷新必须真的清掉定时器').toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('autoRefreshEnabled')),
    '开/关状态必须落 localStorage（否则刷新页面就回来打扰）').toBe('0');

  // 刷新页面：开关不许自己又变回 ON —— 这是「两种关闭方式行为不一致」的那一半：
  // 把间隔选成「关闭」会持久化，拨开关不会。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page, '刷新后不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#autoRefreshToggle'), '刷新后开关必须仍是关的').not.toBeChecked({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('autoRefreshEnabled')),
    '刷新后存储里必须还是「关」').toBe('0');

  // 判据落在**行为**上而不是内部变量上：就算探针被别的东西改名/遮住，这条也照样有效。
  // 基线必须等到「刷新后首屏自己那次取数」落地才算数（否则会把正常首屏算成偷跑）。
  await waitFirstPaint(page);
  const baseline = statusCalls.length;
  await page.waitForTimeout(6500);
  const extra = statusCalls.length - baseline;
  expect(extra, `刷新后 6.5 秒内又请求了 ${extra} 次 /api/status：定时器偷偷重建了（关掉没记住）`)
    .toBe(0);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

test('存进去的间隔不在选项里（旧版本残留/手改）时必须回落默认，不许变成请求风暴', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await stubPanelApis(page);
  const statusCalls = countRequests(page, /\/api\/status(\?|$)/);

  // 45 秒不在当前选项里（选项是 5/10/30/60/0）。旧版本写过、或以后删掉某个选项，
  // 都会落到这支：select.value = '' ⇒ parseInt('') = NaN ⇒ setInterval(fn, NaN)
  // 被当成 0 ⇒ 每几毫秒打一次后端。
  await page.addInitScript(() => {
    try { localStorage.setItem('autoRefreshInterval', '45'); } catch (e) {}
  });
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });

  // 控件必须显示一个**真实存在**的档位，不是空选项。
  await expect(page.locator('#autoRefreshInterval'), '非法值必须回落到默认档位（不能停在空选项）')
    .toHaveValue('10', { timeout: 15000 });

  // 行为证据：1.5 秒内 /api/status 只该有首屏那几次，绝不该是几百次。
  const baseline = statusCalls.length;
  await page.waitForTimeout(1500);
  const extra = statusCalls.length - baseline;
  expect(extra, `1.5 秒内 /api/status 又请求了 ${extra} 次（>5 即为风暴：setInterval 延迟被算成 0）`)
    .toBeLessThanOrEqual(5);

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});

test('两条关闭路径必须是同一条状态：选「关闭」档 = 拨开关，且拨回来能真的重新开始刷', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await stubPanelApis(page);
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });

  const toggle = page.locator('#autoRefreshToggle');
  const select = page.locator('#autoRefreshInterval');
  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '先要有定时器（否则后面「关掉」验不出东西）').toBe(true);

  // 路径 A：把间隔选成「关闭」。
  await select.selectOption('0');
  await expect(toggle, '选「关闭」档必须把开关一起关掉（否则界面自相矛盾：开关 ON + 间隔关闭）')
    .not.toBeChecked({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '选「关闭」档必须真的停掉定时器').toBe(false);
  expect(await page.evaluate(() => JSON.stringify({
    enabled: localStorage.getItem('autoRefreshEnabled'),
    interval: localStorage.getItem('autoRefreshInterval'),
  })), '「关闭」档也要落盘，且开关状态一起落').toBe(JSON.stringify({ enabled: '0', interval: '0' }));

  // 刷新页面：仍是关的，且控件显示的就是「关闭」档（不是空选项）。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page, '刷新后不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  await page.click('#viewTabs .section-tab[data-page="dashboard"]');
  await expect(page.locator('#page-dashboard')).toHaveClass(/active/, { timeout: 15000 });
  await expect(select, '刷新后仍应停在「关闭」档').toHaveValue('0', { timeout: 15000 });
  await expect(toggle, '刷新后开关仍是关的').not.toBeChecked();

  // 路径 B：从「关闭」拨回开启 —— 必须给一个真能用的间隔并真建定时器。
  // 这里最容易出的错是实现把 enabled 翻成 true 但 interval 还是 0，
  // 于是「开关亮着、一个请求都不发」—— 又一个「界面对、行为不对」。
  await page.locator('#autoRefreshPanel .toggle-slider').click();
  await expect(toggle, '拨回来应变成开启').toBeChecked({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!window.__statusInterval),
    '拨回开启必须真的重建定时器（开关亮着却不刷 = 最坏的失败形态）').toBe(true);
  await expect(select, '间隔必须从「关闭」档挪到真实档位，不能停在 0 秒')
    .toHaveValue('10', { timeout: 15000 });

  expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
});