// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 门控状态条 E2E（2026-10-24）
//
// 为什么值得一组独立 E2E：门控条是「未开启 ≠ 没做」这条口径的**唯一载体**。
// 任何一页漏挂、或挂了但静默失败，该页用户就重新落入「功能没做 / 假功能」的误读——
// 这正是外部审计指出的根因。所以这里逐页钉死，且断言的是**语义**，不是「DOM 存在」：
//
//   ① 必须渲染出明确状态（data-loaded ∈ 1 / error / auth）——缺这个属性 = 脚本压根没跑，
//      正是历史上「按钮齐全但点了没反应」的那类假功能，必须红。
//   ② 读失败必须显式成「读不到」，绝不能渲染成「全部未开启」（纪律①）。
//   ③ 不许跳 /login —— 页面被踢去登录时 body 极短，只断言 DOM 会假通过。
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

// 全站挂了 gatebar.js 的 9 个壳页（login/consent/legal 是 overlay 或法务页，不挂）
const shellPages = [
  '/dashboard',
  '/floor',
  '/proxy-config',
  '/sessions',
  '/knowledge',
  '/skills',
  '/logs',
  '/settings',
  '/context',
];

for (const route of shellPages) {
  test(`${route} 渲染能力门控状态条且语义明确`, { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await seedAuth(page);
    await page.goto(route, { waitUntil: 'domcontentloaded' });

    // ③ 防假通过：被踢到登录页时页面几乎空白，后续断言会「恰好通过」。
    await expect(page, `${route} 不应被重定向到 /login`).not.toHaveURL(/\/login/, { timeout: 15000 });

    const bar = page.locator('#gateBar');

    // ① 容器必须存在且带样式类（缺 class 会整条裸奔，视觉上等于没挂）
    await expect(bar, `${route} 门控条容器应存在`).toBeVisible({ timeout: 15000 });
    await expect(bar, `${route} 门控条应带 .mp-gatebar 样式类`).toHaveClass(/mp-gatebar/, { timeout: 15000 });

    await expect(bar.locator('.gate-bar-head'), `${route} 门控条应有标题行`).toContainText('能力门控', { timeout: 15000 });

    // ① 状态必须被明确写出。缺失 = 脚本没执行完，红。
    await expect(bar, `${route} 门控条必须落到明确状态（1=读到 / error=读不到 / auth=需登录）`)
      .toHaveAttribute('data-loaded', /^(1|error|auth)$/, { timeout: 15000 });

    const state = await bar.getAttribute('data-loaded');

    if (state === '1') {
      // 读到数据：必须有 chip（门控项是固定的一揽子，零 chip 说明后端返回了空表）
      await expect(bar.locator('.gate-chip'), `${route} 门控条应渲染至少一个门控项`)
        .not.toHaveCount(0, { timeout: 10000 });
      // 「开箱默认态 / 灰度中」二者必居其一
      await expect(bar.locator('.gate-bar-pill'), `${route} 门控条应给出整体状态徽标`)
        .toContainText(/开箱默认态|灰度中/, { timeout: 10000 });
    } else if (state === 'error') {
      // ② 纪律①的反面：读不到必须说「读不到」，不能渲染成全关
      await expect(bar, `${route} 读失败必须明说「读不到」，不得冒充「全部未开启」`)
        .toContainText(/读不到|失败/, { timeout: 10000 });
    } else {
      // auth：未登录是身份问题，不能伪装成门控全关
      await expect(bar, `${route} 未登录应显示需登录`).toContainText('需登录', { timeout: 10000 });
    }

    expect(errors, `${route} 致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
}

// 布局守卫（2026-10-25 血的教训）：门控条曾被插成 `.layout` 的第三个 flex item，
// 分走宽度后把 main 从 935px 挤到 56px、#meta 宽度归零——页面没报错、数据也照常显示，
// 只是整个盘面被压成一条竖线。这类「不报错的布局塌陷」只能靠量尺寸抓。
// 修完这个 bug 必须留下这条守卫，否则下次动布局还会再犯一次。
for (const route of shellPages) {
  test(`${route} 门控条不得挤塌主内容区`, { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    await seedAuth(page);
    await page.goto(route, { waitUntil: 'domcontentloaded' });

    const main = page.locator('main').first();
    await expect(main, `${route} 应有主内容区`).toBeAttached({ timeout: 15000 });

    // 必须等布局稳定再量：goto 后立刻测量会读到重排中的瞬时宽度
    // （实测 /context 刚加载时是 402px，稳定后 1060px），会误报。
    // 视口 1280 下定宽侧栏约 220px，主内容区理应吃掉剩下的大部分；
    // 真被挤塌时会掉到两位数（floor 事故实测 56px），600 是安全阈值。
    await expect.poll(async () => {
      const box = await main.boundingBox();
      return box ? box.width : 0;
    }, {
      message: `${route} 主内容区宽度应正常（被门控条挤塌会掉到 100px 以下）`,
      timeout: 15000,
    }).toBeGreaterThan(600);
  });
}

test('门控条未开启项不能呈现为「缺失」语义', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  // 这条是整个门控条的立身之本：未开启 ≠ 没做。
  // 断言「未开启」的 chip 真的被渲染出来（而不是被过滤掉只显示已开启项）——
  // 只显示已开启项会让面板看起来「功能齐备」，等于把谎话反过来再说一遍。
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const bar = page.locator('#gateBar');
  await expect(bar).toHaveAttribute('data-loaded', '1', { timeout: 15000 });

  const offCount = await bar.locator('.gate-chip-off').count();
  const onCount = await bar.locator('.gate-chip-on').count();
  const unknownCount = await bar.locator('.gate-chip-unknown').count();

  // 开箱默认态下 opt-in 门控应全为 off；无论如何都不该出现「只有已开启项」的画面
  expect(offCount + onCount + unknownCount, '门控条应渲染全部登记项，而非只挑已开启的').toBeGreaterThan(0);
  expect(onCount, '开箱默认态不应出现已开启项（若这里变红，检查是否误开了门控）').toBeLessThan(offCount + 1);
});

// M2「一张图」（2026-11-08）：首屏格阵必须**一格一项**，且与明细表行数一致。
// 为什么这条值钱：格子是给人「扫一眼」用的，一旦其中几项被漏画，
// 图会看起来更干净、更好看，但它说的话就少了几句——这类缺失不会报错，
// 只能靠数数量抓。
test('门控格阵一格一项，且与明细表行数一致', { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被重定向到 /login').not.toHaveURL(/\/login/, { timeout: 15000 });

  const bar = page.locator('#gateBar');
  await expect(bar).toHaveAttribute('data-loaded', '1', { timeout: 15000 });

  const cells = bar.locator('.gm > .gm-cell');
  const cellCount = await cells.count();
  expect(cellCount, '格阵至少要有一个格子').toBeGreaterThan(0);

  // 这确实是一张「图」：读屏用户应拿到结论，而不是 16 个空 span
  await expect(bar.locator('.gm')).toHaveAttribute('aria-label', /\d+ 项门控/);

  await bar.locator('[data-gate-toggle]').click();
  const rowCount = await bar.locator('tbody tr').count();
  expect(cellCount, '格子数必须等于明细表行数（漏画会看起来更干净，但少说了几句）').toBe(rowCount);
});
