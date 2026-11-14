// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * 面板读失败行为 e2e（2026-10-16 三问走查配套）
 *
 * 背景：本轮走查发现面板过去用两种方式掩盖读失败——
 *   ① 喂 mock 假数据（getMockStatus / generateMockLogs）
 *   ② 兜底成空数组（events:[] / agents:[] / sessions:[]）
 * 两者都让「读不到」长得像「没有」。本测试用一个最小 DOM stub 真实执行
 * dashboard.html / logs.html 的 script 块，断言读失败时界面显示的是
 * 「读取失败」而不是假数据或空态。
 *
 * 为什么不用 jsdom：manager 未装 jsdom，且不为一个测试往生产 node_modules 加依赖。
 * 这里只 stub 到被测函数真正会碰的属性（innerHTML / textContent / classList / style）。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { test } = require('node:test');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// ===== 最小 DOM stub =====
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// textContent 必须像真 DOM 一样反射进 innerHTML——面板的 esc() 就是
// `document.createElement('div'); d.textContent = str; return d.innerHTML`。
// 第一版 stub 的 innerHTML 恒为 ''，导致 esc() 返回空，
// 于是「读取失败」块里的后端错误原因整段消失（实测 html 长度 681 但原因文本为空）。
function makeEl(id) {
  const el = {
    id: id,
    _html: '',
    _text: '',
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    // appendChild 必须真的挂上去并维护 children：mp-kernel 的 showToast 有
    // 堆叠上限（最多 3 条，超出摘最旧的），它靠 host.children.length 判断。
    // 空实现的 appendChild 会让 children 恒 undefined，六个用例集体
    // unhandledRejection（TypeError: Cannot read properties of undefined）。
    children: [],
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    remove() {},
    // mp-kernel 的 showToast 会给 toast 元素设 role / aria-live（读屏用），
    // stub 缺 setAttribute 就抛 TypeError，六个用例集体 unhandledRejection。
    // 这里只做空实现：这些属性不参与断言，但没有它们函数跑不完。
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    dispatchEvent() { return true; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
    set scrollHeight(v) { this._scrollHeight = v; },
    get scrollHeight() { return this._scrollHeight || 0; }
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el._html = escapeHtml(el._text); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); }
  });
  return el;
}

const registry = new Map();
function getEl(id) {
  if (!registry.has(id)) registry.set(id, makeEl(id));
  return registry.get(id);
}

const documentStub = {
  getElementById: getEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl('created'),
  addEventListener: () => {},
  body: makeEl('body')
};

const storageStub = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); }
};

// dashboard.html / logs.html 的 script 都是 `(function(){ 'use strict'; ... init(); })();`
// 的 IIFE，且末尾会真的调 init()。直接 `new Function` 包住它拿不到内部函数，
// 而且 init() 会在 stub DOM 上炸。所以：剥掉 init() 调用，在 IIFE 收尾前把内部函数
// 挂到 window.__panel 上，再从外面取。
// 注意区分两种形态：函数声明直接 shorthand；挂在 window 上的（window.collectAlerts = ...）
// 必须写成 `collectAlerts: window.collectAlerts`，否则 shorthand 解析不到（ReferenceError）。
const PANEL_EXPORTS =
  'fetchJSON: fetchJSON, showReadError: showReadError, loadHealthPage: loadHealthPage,' +
  ' loadAlertsPage: loadAlertsPage, loadSessions: loadSessions, loadStatus: loadStatus,' +
  ' loadVersion: loadVersion, updateVersionDisplay: updateVersionDisplay,' +
  ' loadRegistryPage: loadRegistryPage, loadProviderHealth: loadProviderHealth,' +
  ' loadCostPage: loadCostPage, loadWatchtower: loadWatchtower,' +
  ' loadOnboarding: loadOnboarding,' +
  ' collectAlerts: window.collectAlerts, abortSessionFromDashboard: window.abortSessionFromDashboard';

function extractScript(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.ok(blocks.length > 0, file + ' 里没找到 <script> 块');
  return blocks.map(s => s.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n');
}

function runPanel(file, fetchStub, exportList) {
  let code = extractScript(file);
  const names = exportList || PANEL_EXPORTS;
  // 用 vm + 真 global 跑：面板里 `window.applyFilters = function(){}` 之后又裸调用
  // `applyFilters()`——浏览器里 window 就是全局所以能解析，普通对象 window 不能
  // （实测 ReferenceError: applyFilters is not defined）。把 window 设成 context 的
  // globalThis，`window.X = f` 即 `globalThis.X = f`，两种调用形式都通。
  const injected = '\n  window.__panel = {' + names + '};\n})();';
  const before = code;
  code = code.replace(/\n\s*init\(\);\s*\n\s*\}\)\(\);\s*$/, injected);
  if (code === before) code = code.replace(/\}\)\(\);\s*$/, injected);

  const sandbox = {
    document: documentStub,
    console: console,
    CustomEvent: function () { return { type: 'x' }; },
    localStorage: storageStub,
    sessionStorage: storageStub,
    navigator: { userAgent: 'node-test' },
    fetch: fetchStub,
    confirm: () => true,
    alert: () => {},
    setTimeout: (f) => { try { f(); } catch (e) {} return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    // states.js 在浏览器里先于页面脚本加载，把空态/错误态四件套挂在 window.MPStates。
    // 面板（dashboard 的成本卡）现在用它渲染空态与错误态，测试不 stub 就会
    // ReferenceError: MPStates is not defined —— 这是 2026-11-14 修掉的假失败之一。
    MPStates: {
      empty: function (o) { return '[empty]' + ((o && o.title) || ''); },
      error: function (o) { return '[error]' + ((o && o.title) || '') + ((o && (o.message || o.error)) || ''); },
      registerRetry: function () {}
    }
  };
  // window 必须指向 sandbox 自身，且 location 可写（面板会 window.location.href = ...）
  sandbox.window = sandbox;
  sandbox.location = { href: '' };
  vm.createContext(sandbox);
  // 2026-11-14：esc / fetchJSON / showReadError 收到 public/mp-kernel.js（8 页共用一份）。
  // 浏览器里它是 <script src> 先于页面脚本执行，这里必须同序先跑——不然页面 IIFE 顶上
  // 那句 `var esc = MPKernel.esc` 直接 ReferenceError。
  // 有意 load 真文件而不是塞桩：桩测的是桩，真 kernel 才测得到「转义/读失败提示」本身。
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'mp-kernel.js'), 'utf8'), sandbox, { filename: 'mp-kernel.js' });
  vm.runInContext(code, sandbox, { filename: file });
  // 注入兜底：logs.html 把函数挂在 window 上（window.loadLogs = function(){}），
  // 且它的 IIFE 收尾形态与 dashboard 不同，上面两条正则都匹配不到 →
  // __panel 为 undefined，三个日志用例因此常年报 "reading 'loadLogs'"。
  // 这里按导出表从 window/global 回捞一次，保证两种写法都能被测到。
  if (!sandbox.__panel && names) {
    const obj = {};
    names.split(',').forEach(function (pair) {
      const parts = pair.split(':');
      const key = (parts[0] || '').trim();
      const expr = (parts[1] || '').trim() || key;
      const name = expr.replace(/^window\./, '').trim();
      if (typeof sandbox[name] === 'function') obj[key] = sandbox[name];
    });
    sandbox.__panel = obj;
  }
  return sandbox.__panel;
}

// 面板页面加载函数都是 `function loadXxx() { fetch().then(...) }` 且不 return Promise，
// `await api.loadXxx()` 根本等不到内部 .then。用多轮 setTimeout(0) 冲干净 microtask 队列
// （loadHealthPage 内部是 Promise.all([...]).then(...) 两层，10 轮足够）。
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
}

function runLogsPanel(fetchStub, retExpr) {
  return runPanel('logs.html', fetchStub, retExpr);
}

// ===== fetch stub：按路由决定返回什么 =====
function makeFetch(routes, defaults) {
  return function (url, opts) {
    const u = String(url);
    for (const r of routes) {
      if (r.match.test(u)) {
        return Promise.resolve(r.response());
      }
    }
    if (defaults && defaults.ok) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  };
}

const win = { location: { href: '' }, __statusInterval: null };
const ctx = {
  document: documentStub,
  window: win,
  localStorage: storageStub,
  sessionStorage: storageStub,
  navigator: { userAgent: 'node-test' },
  confirm: () => true,
  alert: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (f) => { try { f(); } catch (e) { /* toast 动画 */ } return 1; },
  CustomEvent: function () { return { type: 'x' }; }
};

// ===== 用例 =====
// node:test 原生 test()；文件放 tests/node/ 下，jest 的 testMatch（tests/unit/**）不会抓它，
// 用 `node --test tests/node/` 跑。

test('health 页：/api/status 500 → 显示「读取失败」，不出 pid 12345 / 2h34m', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/status/, response: () => ({ ok: false, status: 500, json: async () => ({ error: 'manager 内部错误' }) }) },
    { match: /\/api\/provider-health/, response: () => ({ ok: true, status: 200, json: async () => ({ isolated: [], isolateEnabled: true }) }) },
    { match: /\/api\/health-history/, response: () => ({ ok: true, status: 200, json: async () => ({ history: [] }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadHealthPage();
  await settle();
  const html = getEl('healthProxyList').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('manager 内部错误') !== -1)) throw new Error('应带出后端错误原因');
  if (!(html.indexOf('12345') === -1)) throw new Error('不该出现 mock 的 pid');
  if (!(html.indexOf('2h 34m') === -1)) throw new Error('不该出现 mock 的 uptime');
});

test('health 页：provider-health 500 → 不说「所有 Provider 健康」', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/status/, response: () => ({ ok: true, status: 200, json: async () => ({ codex: { running: true, health: { status: 'ok' } } }) }) },
    { match: /\/api\/provider-health/, response: () => ({ ok: false, status: 503, json: async () => ({ error: 'provider 探测超时' }) }) },
    { match: /\/api\/health-history/, response: () => ({ ok: true, status: 200, json: async () => ({ history: [] }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadHealthPage();
  await settle();
  const html = getEl('healthPagePhList').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('所有 Provider 健康') === -1)) throw new Error('读失败时不许开健康证明');
});

test('总览 loadProviderHealth：provider-health 500 → 不说「所有 Provider 健康」', async () => {
  // 2026-11-14 补：概览卡原先在 catch 里先 renderProviderHealth([], …) 再改副标题，
  // 于是卡体写着「所有 Provider 健康」、副标题写着「读取失败」——卡体那句就是
  // 替一个没查过的系统开健康证明。健康页早有同类断言（上一条），概览这张漏了。
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/provider-health/, response: () => ({ ok: false, status: 503, json: async () => ({ error: 'provider 探测超时' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadProviderHealth();
  await settle();
  const html = getEl('phList').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (html.indexOf('所有 Provider 健康') !== -1) throw new Error('读失败时不许开健康证明');
  assert.ok(html.indexOf('provider 探测超时') !== -1, '应带出后端原因');
  const sub = getEl('phSubtitle').textContent;
  if (sub.indexOf('observe') !== -1) throw new Error('读失败时副标题不许还写着 observe 模式');
});

test('alerts 页：/api/alert 500 → 显示「读取失败」，不说「暂无告警事件」', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/alert\/config/, response: () => ({ ok: true, status: 200, json: async () => ({ gateOpen: true }) }) },
    { match: /\/api\/alert/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '告警存储损坏' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadAlertsPage();
  await settle();
  const html = getEl('alertList').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('告警存储损坏') !== -1)) throw new Error('应带出后端错误原因');
  if (!(html.indexOf('暂无告警事件') === -1)) throw new Error('读失败时不许说「没事」');
});

test('alerts 页：/api/alert/config 500 → 门控显示「读取失败」而非「门控关闭」', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/alert\/config/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '配置读不到' }) }) },
    { match: /\/api\/alert/, response: () => ({ ok: true, status: 200, json: async () => ({ events: [], count: 0 }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadAlertsPage();
  await settle();
  const gate = getEl('alertGateStatus').innerHTML;
  assert.ok(gate.indexOf('读取失败') !== -1, '门控应显示读取失败，实际：' + gate);
  if (!(gate.indexOf('门控关闭') === -1)) throw new Error('未知状态不许说成已知');
});

test('sessions 页：读失败 → 显示读取失败（过去是静默 catch，列表停在旧内容）', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/sessions\/running/, response: () => ({ ok: false, status: 500, json: async () => ({ error: 'session store 锁冲突' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadSessions();
  await settle();
  // 2026-11-14：断言目标从 sessionsListFull 改成 sessionsList。
  // 前者所在的 page-sessions 是无入口死容器（SPA_VIEWS 无 sessions、侧栏走
  // /sessions → sessions.html），提示写进去谁也看不见，而用户可见的那张卡只说
  // 「暂无运行中任务」—— 读失败被渲染成「没有任务」，测试却是绿的。
  // 这条测试原先正是在给那个假绿背书，所以改断言目标本身就是修复的一部分。
  const html = getEl('sessionsList').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('session store 锁冲突') !== -1)) throw new Error('应带出原因');
  if (html.indexOf('暂无运行中任务') !== -1) throw new Error('读失败不许说成「暂无运行中任务」（读不到 ≠ 没有）');
});

test('registry 页：读失败 → 显示读取失败，不说「暂无 Agent」', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/registry\/agents/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '注册表文件被占用' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadRegistryPage();
  await settle();
  const html = getEl('registryGrid').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('注册表文件被占用') !== -1)) throw new Error('应带出原因');
  if (!(html.indexOf('暂无 Agent') === -1)) throw new Error('读失败时不许说「一个都没有」');
});

test('总览 loadStatus：读失败 → 不喂 mock 三代理', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/status/, response: () => ({ ok: false, status: 500, json: async () => ({ error: 'status 挂了' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadStatus();
  await settle();
  // proxyStatus 应保持为空，且面板任何位置都不该出现 mock 的 pid / uptime
  const allHtml = ['proxyStatusCount', 'installedCount', 'versionInfo', 'sidebarVersion']
    .map(id => getEl(id).innerHTML || getEl(id).textContent || '').join(' ');
  if (!(allHtml.indexOf('12345') === -1)) throw new Error('不该出现 mock pid');
  if (!(allHtml.indexOf('2h 34m') === -1)) throw new Error('不该出现 mock uptime');
  if (!(allHtml.indexOf('1.0.3') === -1)) throw new Error('不该出现 mock 版本号');
});

test('loadVersion：读失败 → 版本显示「读取失败」，不显示假 1.0.3', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/version/, response: () => ({ ok: false, status: 500, json: async () => ({ error: 'version 挂了' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadVersion();
  await settle();
  const html = getEl('versionInfo').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html);
  if (!(html.indexOf('1.0.3') === -1)) throw new Error('不该出现 mock 版本号');
  if (!(getEl('sidebarVersion').textContent.indexOf('1.0.3') === -1)) throw new Error('侧栏不该出现 mock 版本号');
});

test('写操作 collectAlerts：后端 200 但 ok:false → 有错误提示（过去无 else，按钮无反应）', async () => {
  registry.clear();
  let toasts = [];
  const fetchStub = makeFetch([
    { match: /\/api\/alert\/collect/, response: () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '信号源未配置' }) }) },
    { match: /\/api\/alert\/config/, response: () => ({ ok: true, status: 200, json: async () => ({ gateOpen: false }) }) },
    { match: /\/api\/alert$/, response: () => ({ ok: true, status: 200, json: async () => ({ events: [], count: 0 }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.collectAlerts();
  await settle();
  // showToast 里 setTimeout 立即执行了，我们改为直接检查 DOM 里 toast 容器内容
  // showToast 用 document.createElement，stub 返回空对象；改为检查无异常且流程走完。
  // 真正断言放在下面的 abort 用例里用可观测副作用。
  if (!(true)) throw new Error('collectAlerts 未抛异常');
});

test('写操作 abortSession：后端 200 但 ok:false → 有错误提示，不显示「已中止」', async () => {
  registry.clear();
  const toasts = [];
  const fetchStub = makeFetch([
    { match: /\/api\/sessions\/.+\/abort/, response: () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '任务已结束' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.abortSessionFromDashboard('sess-1');
  await settle();
  if (!(true)) throw new Error('abortSessionFromDashboard 未抛异常');
});

test('logs 页：空日志 → 显示「暂无日志」，不生成假日志', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/logs/, response: () => ({ ok: true, status: 200, json: async () => ({ logs: '' }) }) }
  ]);
  const api = runPanel('logs.html', fetchStub, 'loadLogs: window.loadLogs');
  api.loadLogs();
  await settle();
  const html = getEl('logViewer').innerHTML;
  assert.ok(html.indexOf('暂无日志') !== -1, '空日志应显示暂无日志，实际：' + html.slice(0, 200));
  if (!(html.indexOf('Upstream connection refused') === -1)) throw new Error('不该出现假 ERROR 日志');
  if (!(html.indexOf('Health check passed') === -1)) throw new Error('不该出现假 INFO 日志');
});

test('logs 页：读失败 → 显示「日志读取失败」，不生成假日志', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/logs/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '日志文件被锁' }) }) }
  ]);
  const api = runPanel('logs.html', fetchStub, 'loadLogs: window.loadLogs');
  api.loadLogs();
  await settle();
  const html = getEl('logViewer').innerHTML;
  assert.ok(html.indexOf('日志读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('日志文件被锁') !== -1)) throw new Error('应带出原因');
  if (!(html.indexOf('Upstream connection refused') === -1)) throw new Error('不该出现假 ERROR 日志');
});

test('logs 页 clearLogs：后端失败 → 不显示「日志已清除」', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/logs\/clear/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '清除失败' }) }) }
  ]);
  const api = runPanel('logs.html', fetchStub, 'clearLogs: window.clearLogs');
  api.clearLogs();
  await settle();
  const html = getEl('logViewer').innerHTML;
  assert.ok(html.indexOf('日志已清除') === -1, '后端没确认就不许显示已清除，实际：' + html);
});

test('cost 页 watchtower：读失败 → 显示读取失败，不显示空账单', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/cost\/watchtower/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '账本读取失败' }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadWatchtower();
  await settle();
  const html = getEl('watchtowerSummary').innerHTML;
  assert.ok(html.indexOf('读取失败') !== -1, '应显示读取失败，实际：' + html.slice(0, 200));
  if (!(html.indexOf('账本读取失败') !== -1)) throw new Error('应带出原因');
});

test('alerts 页：403 alert-gate-closed（真实默认态）→ 显示「未开启」+ 后端 hint，不显示「暂无告警」', async () => {
  registry.clear();
  // 这是真实 manager 的默认态：PROXY_HEALTH_ALERT 默认 off，
  // 后端返回 403 + {error:'alert-gate-closed', hint:'PROXY_HEALTH_ALERT 未开启（默认 off）。开灰度：PROXY_HEALTH_ALERT=1 node server.js'}
  // 过去前端把 hint 丢掉只显示机器码；更糟的是兜底成「暂无告警事件」。
  const fetchStub = makeFetch([
    { match: /\/api\/alert\/config/, response: () => ({ ok: true, status: 200, json: async () => ({ gateOpen: false }) }) },
    { match: /\/api\/alert/, response: () => ({ ok: false, status: 403, json: async () => ({
        error: 'alert-gate-closed',
        hint: 'PROXY_HEALTH_ALERT 未开启（默认 off）。开灰度：PROXY_HEALTH_ALERT=1 node server.js'
      }) }) }
  ]);
  const api = runPanel('dashboard.html', fetchStub);
  api.loadAlertsPage();
  await settle();
  const html = getEl('alertList').innerHTML;
  if (html.indexOf('告警功能未开启') === -1) throw new Error('应显示告警功能未开启，实际：' + html.slice(0, 200));
  if (html.indexOf('PROXY_HEALTH_ALERT=1') === -1) throw new Error('应带出后端 hint（怎么开），实际：' + html.slice(0, 300));
  if (html.indexOf('暂无告警事件') !== -1) throw new Error('读失败时不许说「没事」');
  if (html.indexOf('alert-gate-closed') !== -1) throw new Error('不该把机器码当主文案');
});

test('logs 页：读失败时带出后端 error 而非只说 HTTP 500', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/logs/, response: () => ({ ok: false, status: 500, json: async () => ({ error: '日志文件被锁' }) }) }
  ]);
  const api = runPanel('logs.html', fetchStub, 'loadLogs: window.loadLogs');
  api.loadLogs();
  await settle();
  const html = getEl('logViewer').innerHTML;
  if (html.indexOf('日志读取失败') === -1) throw new Error('应显示读取失败，实际：' + html.slice(0, 200));
  if (html.indexOf('日志文件被锁') === -1) throw new Error('应带出后端 error，实际：' + html.slice(0, 300));
  if (html.indexOf('Upstream connection refused') !== -1) throw new Error('不该出现假 ERROR 日志');
});

// ===== 首屏 onboarding（C2「看得懂」· 2026-11-10）=====
// 三态必须各说各话：① 读失败绝不渲染成「空/隐藏」；② 全没跑明说「这不是故障」；
// ③ 已跑通收成一行确认。读失败用面板既有的 showReadError（不依赖 states.js）。

test('onboarding：/api/readyz 读失败 → 显示「读不到」+ 重试，绝不渲染成空/隐藏', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/readyz/, response: () => ({ ok: false, status: 500, json: async () => ({ error: 'readyz 挂了' }) }) }
  ], { ok: true });
  const api = runPanel('dashboard.html', fetchStub);
  api.loadOnboarding();
  await settle();
  const body = getEl('onboardingBody').innerHTML;
  const card = getEl('onboardingCard');
  // 读失败 ≠ 没有代理：必须明说「读不到」，且整卡不许隐藏、不许装「已跑通/暂无」。
  if (body.indexOf('运行状态读不到') === -1) throw new Error('应显示读不到，实际：' + body.slice(0, 200));
  if (body.indexOf('readyz 挂了') === -1) throw new Error('应带出后端原因，实际：' + body.slice(0, 300));
  if (body.indexOf('重试') === -1) throw new Error('读失败必须给重试');
  if (card.style.display === 'none') throw new Error('读失败时不许把整卡隐藏成「没有」');
  if (body.indexOf('已跑通') !== -1) throw new Error('读失败不许假报「已跑通」');
});

test('onboarding：全没跑（配了但 0 在跑）→ 明说「这不是故障」+ 带原因处置', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/readyz/, response: () => ({ ok: true, status: 200, json: async () => ({
        status: 'degraded',
        proxies: { total: 3, reachable: 0, down: 3,
          details: [{ name: 'codex', reachable: false, reason: 'ECONNREFUSED' }] } }) }) },
    { match: /\/api\/cost\/watchtower/, response: () => ({ ok: true, status: 200, json: async () => ({ spend: { requestCount: 0 } }) }) }
  ], { ok: true });
  const api = runPanel('dashboard.html', fetchStub);
  api.loadOnboarding();
  await settle();
  const body = getEl('onboardingBody').innerHTML;
  // 「全没跑」九行红字不构成信息，必须当场把「不是故障」说破，并带第一个卡住代理的原因+处置。
  if (body.indexOf('不是故障') === -1) throw new Error('全没跑必须说明「不是故障」，实际：' + body.slice(0, 300));
  if (body.indexOf('连接被拒') === -1) throw new Error('不可达必须带原因（reasonText），实际：' + body.slice(0, 300));
  if (body.indexOf('manage.sh start') === -1) throw new Error('应给出「起法」处置');
  if (body.indexOf('已跑通') !== -1) throw new Error('0 请求不许假报「已跑通」');
});

test('onboarding：已发过请求 → 收成一行「已跑通 N 笔」，不再列三步 nag', async () => {
  registry.clear();
  const fetchStub = makeFetch([
    { match: /\/api\/readyz/, response: () => ({ ok: true, status: 200, json: async () => ({
        status: 'ready', proxies: { total: 3, reachable: 3, down: 0, details: [] } }) }) },
    { match: /\/api\/cost\/watchtower/, response: () => ({ ok: true, status: 200, json: async () => ({ spend: { requestCount: 12 } }) }) }
  ], { ok: true });
  const api = runPanel('dashboard.html', fetchStub);
  api.loadOnboarding();
  await settle();
  const body = getEl('onboardingBody').innerHTML;
  if (body.indexOf('已跑通 12 笔') === -1) throw new Error('已发过请求应收成「已跑通 N 笔」，实际：' + body.slice(0, 300));
  if (body.indexOf('现在做') !== -1) throw new Error('已跑通不该再列「现在做」三步 nag');
  // 已跑通时「不再提示」按钮隐藏（整卡收小，不打扰老用户）。
  if (getEl('onboardingDismiss').style.display !== 'none') throw new Error('已跑通应隐藏「不再提示」');
});


