// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 跨页鉴权层守卫（2026-11-15 壳第四片）
//
// 为什么要有它：鉴权这块最危险的不是「搬错」，是**静默失效**。
//   · 某个页面自己又装一份 fetch 拦截器 ⇒ 两层拦截，401 跳转走两遍，
//     「谁说了算」重新变成两个答案；
//   · 某个页面忘了引 mp-auth.js ⇒ 请求不带 token，受保护接口全 401，
//     而页面只会把 401 显示成「读取失败」——把「掉线」伪装成「没数据」；
//   · login.html 引了 mp-auth.js ⇒ 输错密码被自己的 401 拦截器当成会话过期，
//     **自己跳回自己**，看起来像死循环刷新；
//   · mp-auth.js 晚于页面首个内联 <script> ⇒ 内联第一件事就是 checkAuth，
//     那一刻还没装拦截器，首个请求裸奔。
// 这四条都不会让人肉眼看出问题，只会让线上行为慢慢歪。所以判定只能靠树里有什么。
//
// 钉七条：
//   ① 真实现唯一在 mp-auth.js（探登录态 / 登录墙 / 注入 / 401 跳转 / 防重入 五要素齐）；
//   ② 任何页面都不许再改写 window.fetch（那是「所有请求的必经之路」，只许这一层装）；
//   ③ 凡打 /api/ 的页面都必须引 mp-auth.js（floor.html 例外：/api/floor 不鉴权）；
//   ④ 加载顺序 mp-kernel → mp-auth → 页面内联；dashboard 另有 mp-auth → mp-shell → views；
//   ⑤ login / consent / legal 三个无鉴权页不得引 mp-auth.js；
//   ⑥ mp-shell.js 不再持鉴权（它只是 dashboard 专属壳），dashboard 的两个薄包装指向 MPAuth；
//   ⑦ 运行态：在假 window 里真跑 mp-auth.js——注入、豁免、401 跳转、幂等四件事都对。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const htmlFiles = () => fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

// 按行剥 `//` 注释，且**引号内不动**：本文要断言字符串常量（'/api/auth/status'、
// 'x-auth-token'）在不在，剥字符串会把判据一起剥掉；而整页跨行剥又会像 D-022 那样
// 被不平衡引号吞掉半页。行级 + 引号感知两头都避开。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { out += c + (line[i + 1] || ''); i++; continue; }
        if (c === quote) quote = null;
        out += c;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
      if (c === '/' && line[i + 1] === '/') break;
      out += c;
    }
    return out;
  }).join('\n');
}

const AUTH = read('mp-auth.js');
const AUTH_CODE = stripLineComments(AUTH);
const SHELL_CODE = stripLineComments(read('mp-shell.js'));
const DASH_CODE = stripLineComments(read('dashboard.html'));

// 「这一页引了 mp-auth.js」只认 <script src=...> 标签，不认裸字符串。
// 踩过的坑：改成 `src.includes('mp-auth.js')` 时，页面注释里那句「现由 mp-auth.js
// 统一安装」就让判据恒真——把引入删掉照样绿。散文满足判据是 D-021/D-025 同族，
// 判据必须落在会执行的形态上。
const hasAuthScript = (src) => /<script\s+src="[^"]*mp-auth\.js"/.test(src);

test('① 鉴权真实现唯一在 mp-auth.js', () => {
  // 探登录态
  assert.ok(AUTH_CODE.includes("'/api/auth/status'"),
    'mp-auth.js 不再探 /api/auth/status（登录墙没人触发）');
  // 注入 token
  assert.ok(AUTH_CODE.includes("'x-auth-token'"),
    'mp-auth.js 不再注入 x-auth-token（受保护接口全 401）');
  // 401 跳登录页，且排除 /api/auth/*
  assert.match(AUTH_CODE, /res\.status\s*===\s*401/,
    'mp-auth.js 的 401 分支没了（会话过期不再跳登录页）');
  assert.ok(AUTH_CODE.includes("'/api/auth/'"),
    'mp-auth.js 丢了 /api/auth/* 豁免：登录页输错密码会被自己跳回自己');
  // 登录墙 DOM
  assert.ok(AUTH_CODE.includes('login-required-container'),
    'mp-auth.js 里没有登录墙 DOM');
  // token 读入口只认 kernel（不许自己读 sessionStorage 造成第二份口径）
  assert.ok(AUTH_CODE.includes('MPKernel.getToken'),
    'mp-auth.js 未从 MPKernel 取 token');
  // 防重入标记：重复引入/重复调用不许叠两层拦截
  assert.ok(AUTH_CODE.includes('__mpAuthInstalled'),
    'mp-auth.js 缺 fetch 拦截器防重入标记（重复装会叠两层）');
  // 加载即安装：不能只在某个页面 init 时才装（否则 head 里的取数脚本裸奔）
  assert.match(AUTH_CODE, /^\s*installFetchAuth\(\);/m,
    'mp-auth.js 没有在加载时自装拦截器（页面首个内联请求会不带 token）');
});

test('② 任何页面都不许再改写 window.fetch', () => {
  const offenders = htmlFiles().filter((f) => /window\.fetch\s*=/.test(read(f)));
  assert.deepStrictEqual(offenders, [],
    `这些页面自装了 fetch 拦截器（${offenders.join(', ')}）：` +
    '全局拦截只许 mp-auth.js 装一次，否则 401 跳转会走两遍、「谁说了算」又是两个答案');
  const leftovers = htmlFiles().filter((f) => read(f).includes('origFetch'));
  assert.deepStrictEqual(leftovers, [],
    `这些页面还留着 _origFetch 残留（${leftovers.join(', ')}）`);
  // mp-shell.js 也早已不该碰 fetch（它是 dashboard 专属壳，只认 DOM）
  assert.ok(!/window\.fetch\s*=/.test(SHELL_CODE),
    'mp-shell.js 又在改写 window.fetch：鉴权已迁到 mp-auth.js');
});

test('③ 凡打 /api/ 的页面都必须引 mp-auth.js', () => {
  // 豁免清单不是「懒得改」，每一条都是「这页的接口本来就不鉴权」：
  //   · floor.html   → 只打 /api/floor，routes/floor.js 里没有 requireAuth；
  //   · login.html   → 只打 /api/auth/*，401 本来就被豁免；而且它**就是**登录页，
  //                    引鉴权层等于让「密码错误」触发跳回自己（⑤ 另行钉死）；
  //   · consent.html → /api/consent/*，server.js 明写「本机单人面，读写均不加 requireAuth」；
  //   · legal.html   → /api/legal，同上（公开内容，不带 token）。
  // 加新条目必须能和上面对上；对不上就说明这页真的缺鉴权，该引 mp-auth.js。
  const EXEMPT = new Set(['floor.html', 'login.html', 'consent.html', 'legal.html']);
  const missing = [];
  for (const f of htmlFiles()) {
    if (EXEMPT.has(f)) continue;
    const src = read(f);
    const hits = (src.match(/fetch\(\s*['"]\/api\//g) || []).length;
    if (hits > 0 && !hasAuthScript(src)) missing.push(`${f}(${hits})`);
  }
  assert.deepStrictEqual(missing, [],
    `这些页面在打 /api/ 却没引 mp-auth.js（${missing.join(', ')}）：请求不会带 token，` +
    '401 会被显示成「读取失败」，用户不知道自己已经掉线');
});

test('④ 加载顺序：mp-kernel → mp-auth → 页面首个内联 <script>', () => {
  const scriptTags = (src) => [...src.matchAll(/<script\s+src="([^"]+)"/g)];
  for (const f of htmlFiles()) {
    const src = read(f);
    if (!hasAuthScript(src)) continue;
    const tags = scriptTags(src);
    const ik = tags.findIndex((m) => m[1].indexOf('mp-kernel.js') !== -1);
    const ia = tags.findIndex((m) => m[1].indexOf('mp-auth.js') !== -1);
    assert.ok(ik !== -1, `${f} 引了 mp-auth.js 却没引 mp-kernel.js（token 读不到）`);
    assert.ok(ik < ia, `${f} 里 mp-auth.js 早于 mp-kernel.js：currentToken 拿不到 MPKernel`);
  }
  // dashboard 另有一条：mp-auth → mp-shell → views/*.js（壳与视图都依赖鉴权层已就位）
  const tags = scriptTags(read('dashboard.html'));
  const ia = tags.findIndex((m) => m[1].indexOf('mp-auth.js') !== -1);
  const is = tags.findIndex((m) => m[1].indexOf('mp-shell.js') !== -1);
  const iv = tags.findIndex((m) => m[1].indexOf('views/') !== -1);
  assert.ok(ia !== -1 && is !== -1 && iv !== -1,
    'dashboard.html head 少了 mp-auth / mp-shell / views 之一');
  assert.ok(ia < is, 'mp-shell.js 早于 mp-auth.js');
  assert.ok(is < iv, 'mp-shell.js 晚于 views/*.js：视图加载时 global.MPShell 还是 undefined');
});

test('⑤ 无鉴权页不得引 mp-auth.js（否则输错密码跳回自己）', () => {
  for (const f of ['login.html', 'consent.html', 'legal.html']) {
    assert.ok(!hasAuthScript(read(f)),
      `${f} 引了 mp-auth.js：它自带全局 401 跳登录页，登录页会把「密码错误」当成会话过期`);
  }
});

test('⑥ mp-shell.js 不再持鉴权，dashboard 薄包装指向 MPAuth', () => {
  assert.ok(!SHELL_CODE.includes('/api/auth/status'),
    'mp-shell.js 又自己探 /api/auth/status（真实现应在 mp-auth.js）');
  assert.ok(!SHELL_CODE.includes('x-auth-token'),
    'mp-shell.js 又持 token 注入逻辑（真实现应在 mp-auth.js）');
  assert.ok(!/status\s*===\s*401/.test(SHELL_CODE),
    'mp-shell.js 又在处理 401（真实现应在 mp-auth.js）');

  for (const name of ['checkAuth', 'showLoginRequired']) {
    const m = DASH_CODE.match(new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}'));
    assert.ok(m, `dashboard.html 缺 ${name} 薄包装（init() 会 ReferenceError）`);
    const body = m[1].trim();
    assert.match(body, new RegExp('^return\\s+window\\.MPAuth\\.' + name + '\\(\\);?$'),
      `${name} 不是纯薄包装，页面持了第二份鉴权逻辑：${body}`);
  }
});

// ── ⑦ 运行态：静态判据证明「代码在不在」，证明不了「装上以后对不对」 ──────────
// 这一段把 mp-auth.js 原文件塞进一个假 window 里真跑：token 真进 header、
// /api/auth/* 的 401 真不跳、其他 401 真跳、重复安装真不叠层。
//
// 叠层的观测点是 removeItem 命中次数，**不是**底层 fetch 调用次数——层与层是包着的，
// 叠三层仍然只发一次网络请求，只是每个 wrapper 各挂一个 .then，于是 401 处理跑三遍。
// 第一版这里数的是网络调用，注入「删掉防重入标记」照样全绿，是典型判据取错观测点。
function loadAuthModule() {
  const store = { auth_token: 'tk-real' };
  const state = { removeCalls: 0 };
  const sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { state.removeCalls++; delete store[k]; },
  };
  const calls = [];
  const STATUS = { '/api/status': 401, '/api/auth/login': 401, '/api/ok': 200 };
  const win = {
    MPKernel: { getToken: () => sessionStorage.getItem('auth_token') },
    sessionStorage: sessionStorage,
    document: { getElementById: () => null, querySelector: () => null },
    location: { href: '' },
    fetch: (url, opts) => {
      calls.push({ url: url, opts: opts });
      return Promise.resolve({ status: STATUS[url] || 200 });
    },
  };
  win.window = win;
  // 参数白名单就是 mp-auth.js 里用到的裸标识符：window / document / sessionStorage / globalThis。
  const run = new Function('window', 'document', 'sessionStorage', 'globalThis',
    AUTH + '\nreturn window;');
  run(win, win.document, sessionStorage, win);
  return { win: win, calls: calls, store: store, state: state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('⑦ 运行态：注入 / 非 api 不动 / 豁免 / 401 跳转 / 幂等', async () => {
  const m = loadAuthModule();
  const win = m.win;

  // (a) /api/ 请求自动带 token
  await win.fetch('/api/ok', {});
  assert.strictEqual(m.calls[0].opts.headers['x-auth-token'], 'tk-real',
    '拦截器没有把 token 注进 /api/ 请求头');

  // (b) 非 /api/ 请求不动 header
  await win.fetch('./static.json', {});
  assert.ok(!m.calls[1].opts.headers || !m.calls[1].opts.headers['x-auth-token'],
    '拦截器把 token 注入到了非 /api/ 请求（跨站泄漏风险）');

  // (c) /api/auth/* 的 401 不跳转（登录页输错密码必须留在原地）
  await win.fetch('/api/auth/login', {});
  await flush();
  assert.strictEqual(win.location.href, '',
    '/api/auth/* 的 401 触发了跳转：登录页会把「密码错误」当成会话过期，跳回自己');
  assert.strictEqual(m.state.removeCalls, 0, '/api/auth/* 的 401 不该清本地 token');

  // (d) 其他 401 → 清 token + 跳登录页
  await win.fetch('/api/status', {});
  await flush();
  assert.strictEqual(win.location.href, 'login.html',
    '非 auth 的 401 没有跳登录页（会话过期后页面会一直显示「读取失败」）');
  assert.ok(!('auth_token' in m.store), '401 之后没有清掉本地 token（下次请求仍带过期令牌）');
});

test('⑦b 幂等：重复安装不许叠层（叠一次 401 处理就跑两遍）', async () => {
  const m = loadAuthModule();
  m.win.MPAuth.installFetchAuth();
  m.win.MPAuth.installFetchAuth();
  await m.win.fetch('/api/status', {});
  await flush();
  assert.strictEqual(m.state.removeCalls, 1,
    `401 处理跑了 ${m.state.removeCalls} 遍：installFetchAuth 的防重入标记失效，` +
    '每多一层就多一次清 token + 跳转，日志与跳转都会抖');
});
