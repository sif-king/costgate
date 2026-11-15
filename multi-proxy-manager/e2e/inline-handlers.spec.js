// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// dashboard 内联控件「真浏览器点得到」守卫（2026-11-15）
//
// 触发案例（PANEL-HEALTH-CHECK-2026-11-15 §二 发现 A）：工作区把 D-017 的修复回退后，
// 15 个内联 handler 引用的函数不在 window 上，真点 4 个控件全抛 ReferenceError；
// 而当时 node 37/37、coherence 六项、E2E 50/50 **全绿**。原因是两层缺口：
//   ① E2E 的 SPA 用例只点 tab，从不点控件 —— 异常只在点击那一刻才发生；
//   ② 静态守卫 tests/node/panel-inline-handlers.test.js 既没进 CI，本身还能被随手删掉，
//      删了以后没有任何闸门会喊。
// 本文件补的是「运行态」那一层：真浏览器里逐个把内联控件点一遍，并收集全局异常。
// 与静态守卫互补——静态守卫管「引用 ⊆ 挂载 ⊆ 真身」，这里管「真点下去不炸、且真干活」。
//
// 控件清单**从静态 HTML 自动派生**，不手写：以后新增 onclick/onchange 会自动被覆盖，
// 不会出现「加了新控件、守卫还盯着旧清单」的盲区。

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { seedAuth } = require('./helpers/auth');

const DASHBOARD = path.join(__dirname, '..', 'public', 'dashboard.html');
const EVENTS = ['click', 'change', 'input', 'keydown', 'keyup'];

// 关键字与浏览器内建：出现在 handler 代码里，但不是页面自定义函数。
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'var', 'let', 'const',
  'typeof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'String',
  'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Math', 'isNaN', 'alert',
  'confirm', 'prompt', 'setTimeout', 'fetch', 'event', 'this', 'super',
]);

// 剥掉 <script> 后剩下的 on*= 只可能来自静态 HTML；JS 字符串里动态拼出来的
// onclick（toggleProxy/editAgent/deleteAgent 等）不归本守卫管，也不该混进来——
// 它们在页面加载时并不存在，无法用「逐个点」覆盖。
function readInlineHandlers() {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const attrRe = /\son(click|change|input|keydown|keyup)\s*=\s*"([^"]*)"/g;
  const list = [];
  let m;
  while ((m = attrRe.exec(stripped)) !== null) list.push({ event: m[1], code: m[2] });
  return list;
}

function fnNames(code) {
  const cleaned = code.replace(/\.\s*[A-Za-z_$][\w$]*\s*\(/g, '');
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (!BUILTIN.has(m[1])) out.push(m[1]);
  }
  return out;
}

async function openDashboard(page) {
  await seedAuth(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page, '不应被踢到登录页').not.toHaveURL(/\/login/, { timeout: 15000 });
  // 探针必须挑「页面 IIFE 末尾才挂上」的东西。
  // 2026-11-15（D-019）修正：原来用 window.MPShell，但页面壳已抽到 mp-shell.js
  // 并在 <head> 就挂载 —— 它会在页面 IIFE 执行之前就满足，契约层可能在
  // window 挂载段跑完前取值，造成「该红的没红 / 不该红的红」。改用 switchPage：
  // 它在 IIFE 末尾的全局暴露段挂载，出现即代表整段页面脚本执行到底。
  await page.waitForFunction(() => typeof window.switchPage === 'function', null, { timeout: 15000 });
}

// ── 1. 契约层：每个被引用的名字，在真浏览器里都必须是可调用的全局函数 ──
test('dashboard 内联 handler 引用的函数在真浏览器里都是可调用的全局函数',
  { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    const names = [...new Set(readInlineHandlers().flatMap((h) => fnNames(h.code)))].sort();
    expect(names.length, '提取到的函数数异常（提取逻辑坏了会假绿）').toBeGreaterThanOrEqual(10);

    await openDashboard(page);
    const found = await page.evaluate(
      (ns) => ns.map((n) => [n, typeof window[n]]), names,
    );
    const missing = found.filter(([, t]) => t !== 'function');
    expect(missing,
      `内联 handler 在全局作用域解析，以下函数不可调用（点了就是 ReferenceError）：${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

// ── 2. 运行层：把静态 HTML 里每个内联控件都真派发一次，收集全局异常 ──
// 用 DOM 事件而非「只查 typeof」：内联 handler 的 ReferenceError 只有在事件真正
// 触发时才发生，静态看函数名永远看不出来。全量覆盖而非挑几个代表，是因为
// 上一轮坏掉的 13 个控件分散在 6 个面板，挑代表一定会漏。
test('dashboard 每个静态内联控件真派发事件后不抛全局异常',
  { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    const specs = readInlineHandlers();
    expect(specs.length, '静态内联控件数异常（提取逻辑坏了会假绿）').toBeGreaterThanOrEqual(18);

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // 双保险：页面内自己也收一份，能拿到 Playwright 事件可能漏掉的同步异常，
    // 并让失败信息直接指出是哪个函数没定义。
    await page.addInitScript(() => {
      window.__inlineHandlerErrors = [];
      window.addEventListener('error', (e) => {
        window.__inlineHandlerErrors.push(String((e && e.message) || e));
      });
    });

    // 只拦写请求：GET 走真实服务（页面初始化需要真数据），POST/PUT/DELETE 拦掉，
    // 避免「点一遍控件」真的往 registry / 告警里写脏数据。
    await page.route('**/api/**', async (route) => {
      const method = route.request().method();
      if (method === 'GET' || method === 'HEAD') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, collected: 0, agents: [], agent: {} }),
      });
    });

    await openDashboard(page);

    const fired = await page.evaluate((data) => {
      const wanted = new Set(data.specs.map((s) => s.event + '|' + s.code));
      const nodes = Array.from(document.querySelectorAll(
        data.events.map((e) => '[on' + e + ']').join(','),
      ));
      const out = [];
      for (const el of nodes) {
        for (const ev of data.events) {
          const code = el.getAttribute('on' + ev);
          if (code === null || !wanted.has(ev + '|' + code)) continue;
          if (ev === 'click') el.click();
          else if (ev === 'keydown') el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          else el.dispatchEvent(new Event(ev, { bubbles: true }));
          out.push({ ev, code });
        }
      }
      return out;
    }, { specs, events: EVENTS });

    expect(fired.length,
      `应至少派发 18 个静态内联控件（实际 ${fired.length}），否则选择器/清单已失效`,
    ).toBeGreaterThanOrEqual(18);

    // 覆盖度自查：清单里每一种 (event, code) 组合都至少被派发过一次。
    // 防止「HTML 里加了新 handler，但页面根本没渲染出这个元素」时静默跳过。
    const covered = new Set(fired.map((f) => f.ev + '|' + f.code));
    const skipped = specs.filter((s) => !covered.has(s.event + '|' + s.code));
    expect(skipped, `以下静态内联控件在页面里找不到（守卫有盲区）：${JSON.stringify(skipped)}`).toEqual([]);

    // 等一拍让 async handler 的 fetch 回调跑完，再收错误。
    await page.waitForTimeout(300);
    const inlineErrors = await page.evaluate(() => window.__inlineHandlerErrors || []);
    expect(inlineErrors, `控件点击时抛了全局异常：${inlineErrors.join(' | ')}`).toEqual([]);
    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });

// ── 3. 功能层：真手势 + 真请求，抓「函数存在但什么都没干」 ──
// 前两条能抓 ReferenceError，抓不到「挂载了空壳」。健康页刷新 / 历史条数下拉
// 是上一轮实测抛错的 4 个控件里的 2 个，这里用 Playwright 真手势点，并断言
// 对应的 /api/health-history 请求真的带着新 limit 发出去。
test('健康页刷新与历史条数下拉真点后必须真发请求（不是空壳函数）',
  { tag: ['@tier0', '@pr-gate'] }, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openDashboard(page);

    await page.click('#viewTabs .section-tab[data-page="health"]');
    await expect(page.locator('#page-health')).toHaveClass(/active/, { timeout: 15000 });

    const refreshReq = page.waitForRequest(
      (r) => r.url().includes('/api/health-history'), { timeout: 15000 },
    );
    await page.locator('#page-health button[onclick="loadHealthPage()"]').click();
    expect((await refreshReq).url(), '刷新按钮必须真的重新拉健康历史').toContain('/api/health-history');

    const limitReq = page.waitForRequest(
      (r) => r.url().includes('/api/health-history?limit=20'), { timeout: 15000 },
    );
    await page.locator('#healthHistoryLimit').selectOption('20');
    expect((await limitReq).url(), '换条数必须按新值重拉，而不是纹丝不动').toContain('limit=20');

    expect(errors, `致命 JS 异常: ${errors.join(' | ')}`).toEqual([]);
  });
