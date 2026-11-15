// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 壳鉴权归属守卫（2026-11-15，壳第三片）
//
// 为什么要有它：鉴权这块最危险的不是「搬错」，是**静默失效**。
//   · 真实现搬进壳、页面忘了留薄包装 ⇒ 内联调用点抛 ReferenceError，被 catch 吃掉，
//     页面照常出数据，只是没人画登录墙；
//   · 页面又装了一份 fetch 拦截器 ⇒ 两层拦截，token 注入两次（无害），但 401 跳转
//     会走两遍（有日志/有抖动），而且「谁说了算」重新变成两个答案；
//   · mp-shell.js 被 login.html 也引了 ⇒ 登录页拿到全局 401 跳转，输错密码时
//     **自己跳回自己**，看起来像死循环刷新。
// 这三条都不会让测试跑红，只会让线上行为慢慢歪。所以判定只能靠树里有什么。
//
// 钉五条：
//   ① 真实现唯一在 mp-shell.js（探登录态 / 登录墙 / 全局 fetch 注入 + 401 跳转四要素齐）；
//   ② dashboard.html 的 checkAuth / showLoginRequired 只能是纯薄包装；
//   ③ dashboard.html 不再改写 window.fetch（那是「所有请求的必经之路」，只许壳来装）；
//   ④ head 加载顺序 mp-kernel → mp-shell → 第一个 views/*.js（壳要读 kernel 的 token，
//      又必须早于所有视图取数）；
//   ⑤ mp-shell.js 只被 dashboard.html 引用（其他页面一旦引入，401 跳转语义就变了）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const SHELL = read('mp-shell.js');
const DASH = read('dashboard.html');

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
const SHELL_CODE = stripLineComments(SHELL);
const DASH_CODE = stripLineComments(DASH);

test('① 鉴权四要素的真实现唯一在 mp-shell.js', () => {
  // 探登录态
  assert.ok(SHELL_CODE.includes("'/api/auth/status'"),
    'mp-shell.js 不再探 /api/auth/status（登录墙没人触发）');
  // 注入 token
  assert.ok(SHELL_CODE.includes("'x-auth-token'"),
    'mp-shell.js 不再注入 x-auth-token（受保护接口全 401）');
  // 401 跳登录页，且排除 /api/auth/*
  assert.match(SHELL_CODE, /res\.status\s*===\s*401/,
    'mp-shell.js 的 401 分支没了（会话过期不再跳登录页）');
  assert.ok(SHELL_CODE.includes("'/api/auth/'"),
    'mp-shell.js 丢了 /api/auth/* 豁免：登录页输错密码会被自己跳回自己');
  // 登录墙 DOM
  assert.ok(SHELL_CODE.includes('login-required-container'),
    'mp-shell.js 里没有登录墙 DOM');
  // token 读入口只认 kernel（不许自己读 sessionStorage 造成第二份口径）
  assert.ok(SHELL_CODE.includes('MPKernel.getToken'),
    'mp-shell.js 未从 MPKernel 取 token');
  // 防重入标记：重复引入/重复调用不许叠两层拦截
  assert.ok(SHELL_CODE.includes('__mpAuthInstalled'),
    'mp-shell.js 缺 fetch 拦截器防重入标记（重复装会叠两层）');
  // 挂到 MPShell 上
  for (const name of ['checkAuth', 'showLoginRequired', 'installFetchAuth']) {
    assert.match(SHELL_CODE, new RegExp('\\b' + name + '\\s*[,:]'),
      `mp-shell.js 未把 ${name} 纳入 MPShell`);
  }
});

test('② dashboard.html 的 checkAuth / showLoginRequired 只能是纯薄包装', () => {
  for (const name of ['checkAuth', 'showLoginRequired']) {
    const m = DASH_CODE.match(new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}'));
    assert.ok(m, `dashboard.html 缺 ${name} 薄包装（init() 会 ReferenceError）`);
    const body = m[1].trim();
    assert.match(body, new RegExp('^return\\s+window\\.MPShell\\.' + name + '\\(\\);?$'),
      `${name} 不是纯薄包装，页面持了第二份鉴权逻辑：${body}`);
  }
});

test('③ dashboard.html 不再改写 window.fetch，也不再持 authToken 快照', () => {
  assert.ok(!/window\.fetch\s*=/.test(DASH_CODE),
    'dashboard.html 又改写了 window.fetch（全局拦截只许壳装，否则两层 401 跳转）');
  assert.ok(!DASH_CODE.includes('_origFetch'),
    'dashboard.html 又出现 _origFetch（fetch 拦截器残留）');
  assert.ok(!DASH_CODE.includes('/api/auth/status'),
    'dashboard.html 又自己探 /api/auth/status（真实现应在壳里）');
  assert.ok(!/var\s+authToken\s*=/.test(DASH_CODE),
    'dashboard.html 又抄了一份 authToken 快照（token 读入口只许 MPKernel.getToken）');
  // 401 分支只许在壳里。注意**不能**拿 removeItem('auth_token') 当判据：页面的
  // handleLogout 本来就要清 token（主动退出 ≠ 会话过期），照抄会误红。
  assert.ok(!/status\s*===\s*401/.test(DASH_CODE),
    'dashboard.html 又在处理 401（会话过期跳转应在壳里）');
});

test('④ head 加载顺序：mp-kernel → mp-shell → 第一个 views/*.js', () => {
  // 只认 <script src=...> 形态：注释里也会出现 views/*.js 这几个字（本片自己的
  // 说明就写过），拿裸字符串 indexOf 会被注释抢到前面 —— 那是判据取错位置，
  // 不是加载顺序错。
  const tag = (needle) => {
    const m = [...DASH.matchAll(/<script\s+src="([^"]+)"/g)].find((x) => x[1].indexOf(needle) !== -1);
    return m ? m.index : -1;
  };
  const ik = tag('mp-kernel.js');
  const is = tag('mp-shell.js');
  const iv = tag('views/');
  assert.ok(ik !== -1 && is !== -1 && iv !== -1, 'dashboard.html head 少了 mp-kernel/mp-shell/views 之一');
  assert.ok(ik < is, 'mp-shell.js 早于 mp-kernel.js：壳里的 checkAuth 读不到 MPKernel.getToken');
  assert.ok(is < iv, 'mp-shell.js 晚于 views/*.js：视图加载时 global.MPShell 还是 undefined');
});

test('⑤ mp-shell.js 只被 dashboard.html 引用（401 跳转语义不外溢）', () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  const users = pages.filter((f) => read(f).indexOf('mp-shell.js') !== -1);
  assert.deepStrictEqual(users.sort(), ['dashboard.html'],
    `mp-shell.js 被多个页面引入（${users.join(', ')}）：它自带全局 401 跳登录页，` +
    'login.html 一旦引入就会「输错密码跳回自己」');
});
