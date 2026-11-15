// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 视图模块作用域隔离守卫（2026-11-15，2.3b 第五片）
//
// 为什么要有它：把 dashboard 的视图整块搬进 public/views/*.js 时，最容易漏的不是
// 业务逻辑，而是**作用域**——被搬走的代码原来住在页面 IIFE 里，随手就能用到
// `var fetchJSON = MPKernel.fetchJSON` 这类本地别名、以及页面私有的 `authToken` /
// `proxyStatus` / `PROXY_CONFIGS`。模块里没有那个作用域，裸调就是 ReferenceError。
//
// 实测代价（第五片真发生）：cost 抽离后 `loadCostPage` 裸调 `fetchJSON` → 三个接口
// 一个都没请求 → 余额区静静停在「暂无余额数据」。页面不白屏、tab 照常切换，看起来
// 像「你没有余额」，实际是「代码根本没跑」。这类失败极易被当成数据问题放过。
//
// 判据（纯静态，不跑页面）：
//   ① views/*.js 里不许**裸用**页面 IIFE 的本地名（除非该文件自己声明了同名变量）；
//   ② 每个模块必须至少有一处 global./window. 挂载（否则加载了也不暴露任何东西）。
// 模块要用这些能力，必须显式从 MPKernel / MPShell 取——已声明的模块内别名不受限。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const VIEWS = path.join(PUBLIC, 'views');

// 页面 IIFE 的私有名字：模块里出现即视为「以为自己在页面作用域里」。
const PAGE_LOCALS = [
  'fetchJSON', 'showReadError', 'showToast', 'esc',
  'authToken', 'proxyStatus', 'PROXY_CONFIGS', 'versionCache',
  'showLoading', 'hideLoading', 'showOfflineBanner', 'hideOfflineBanner',
  'reasonText', 'renderProviderIsolation', 'showProviderReadError',
];

// 剥掉注释与字符串字面量：只在「真代码」里找裸标识符。
// 字符串里出现 `onclick="switchPage('cost')"` 是合法的（那是交给浏览器的 HTML），
// 不能算依赖页面作用域。
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function declaredNames(code) {
  const found = new Set();
  const re = /\b(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) found.add(m[1]);
  // 解构与多变量声明（var a = 1, b = 2）也覆盖一下
  const re2 = /\b(?:var|let|const)\s+[^;\n]+/g;
  while ((m = re2.exec(code)) !== null) {
    const names = m[0].match(/\b([A-Za-z_$][\w$]*)\s*=/g) || [];
    names.forEach((s) => found.add(s.replace(/\s*=$/, '').trim()));
  }
  return found;
}

function bareUses(code, name) {
  // 前面不是 . 或标识符字符 ⇒ 不是成员访问、不是更长名字的一部分
  const re = new RegExp('(^|[^.\\w$])' + name + '(?![\\w$])', 'g');
  return re.test(code);
}

const viewFiles = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.js'));

test('views/*.js 不许裸用页面 IIFE 的本地名（否则运行时 ReferenceError）', () => {
  assert.ok(viewFiles.length >= 5, `views 目录应有多个模块，实际 ${viewFiles.length}`);

  const violations = [];
  for (const file of viewFiles) {
    const raw = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    const code = stripCommentsAndStrings(raw);
    const declared = declaredNames(code);
    for (const name of PAGE_LOCALS) {
      if (declared.has(name)) continue;       // 模块自己声明了，合法
      if (!bareUses(code, name)) continue;    // 只在注释/字符串里出现，合法
      violations.push(`views/${file} 裸用了页面局部名 ${name}（模块里没有这个作用域，运行会抛 ReferenceError）`);
    }
  }

  assert.deepStrictEqual(violations, [],
    '视图模块必须显式从 MPKernel / MPShell 取能力，不许假设页面 IIFE 的本地别名存在：\n  '
    + violations.join('\n  '));
});

test('每个 views/*.js 都真的把入口挂出去（加载了不暴露 = 静默空壳）', () => {
  const dead = [];
  for (const file of viewFiles) {
    const raw = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    const code = stripCommentsAndStrings(raw);
    if (!/\b(?:global|window)\.[A-Za-z_$]/.test(code)) dead.push(`views/${file}`);
  }
  assert.deepStrictEqual(dead, [], '这些模块没有任何 global./window. 挂载，页面拿不到入口：' + dead.join(', '));
});
