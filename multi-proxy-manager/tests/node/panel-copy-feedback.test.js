// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 复制反馈守卫（2026-11-15）
//
// 为什么要有它：CI 在 headless Linux 上真点「复制统一入口」时，页面抛
// `NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.`
// —— 全站 7 处 `navigator.clipboard.writeText(x).then(成功提示)` 里 6 处没接拒绝分支。
// 浏览器禁剪贴板时（无手势上下文 / 权限策略 / 非安全上下文）用户点完**毫无反应**：
// 没有提示、没有兜底，控制台多一条 unhandled rejection。这类「点了没反应」极难发现：
// 按钮在、事件也派发了、代码也执行了，只有那条 Promise 被拒后没人管。
//
// 判据（只看树里有什么）：
//   ① `navigator.clipboard.writeText(` 只允许出现在**两个**地方：
//        · public/mp-kernel.js —— 全站唯一入口 copyText()，内含 legacy 兜底 + 双分支
//        · public/login.html  —— 该页刻意不加载 mp-kernel（只引 nav.js），自带兜底
//      新增第三处 = 又多了一份「各写各的复制」，直接红。
//   ② kernel 的 copyText 必须真的接住拒绝（有 legacy 兜底、且导出到 MPKernel）。
//   ③ login.html 的调用必须带拒绝分支（两参数 then 或 .catch）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const NEEDLE = 'navigator.clipboard.writeText(';

// 允许直接调 writeText 的例外（新增必须在此登记并说明理由）
const ALLOWED = new Set(['mp-kernel.js', 'login.html']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.(html|js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

test('复制只许有一个入口：writeText 只出现在 mp-kernel.js 与登记过的例外里', () => {
  const offenders = [];
  for (const abs of walk(PUBLIC)) {
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes(NEEDLE)) continue;
    const rel = path.relative(PUBLIC, abs);
    if (!ALLOWED.has(rel)) offenders.push('public/' + rel);
  }
  assert.deepStrictEqual(offenders, [],
    '这些文件绕过 MPKernel.copyText 直接调 clipboard（失败时无法统一兜底）：\n  '
    + offenders.join('\n  ') + '\n应改为 MPKernel.copyText(text).then(function (ok) {...})');
});

test('kernel.copyText 必须接住拒绝并导出', () => {
  const kernel = fs.readFileSync(path.join(PUBLIC, 'mp-kernel.js'), 'utf8');
  assert.match(kernel, /function copyText\(/, 'mp-kernel.js 缺 copyText 实现');
  assert.match(kernel, /function legacy\(\)/, 'copyText 必须有 execCommand 兜底（writeText 被拒时还能试一次）');
  // 拒绝分支：两个回调的 then（成功 → true，失败 → legacy）
  assert.match(kernel, /\.then\(\s*function \(\) \{ return true; \},\s*function \(\) \{ return legacy\(\); \}/,
    'copyText 必须显式处理 writeText 的拒绝（否则就是一条 unhandled rejection）');
  assert.match(kernel, /copyText: copyText/, 'copyText 没导出到 MPKernel，页面拿不到');
});

test('login.html（不加载 kernel）的复制调用必须自带拒绝分支', () => {
  const login = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8');
  const idx = login.indexOf(NEEDLE);
  assert.ok(idx > 0, 'login.html 里没有 writeText 调用，守卫前提失效（核对该页是否已改用 kernel）');
  const tail = login.slice(idx, idx + 400);
  assert.match(tail, /,\s*function\s*\(/, 'login.html 的 writeText 没有第二个（拒绝）回调');
});
