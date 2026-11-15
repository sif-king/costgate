// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 壳横幅归属守卫（2026-11-15，壳第二片）
//
// 为什么要有它：横幅机制最容易被「看着接好了」骗过——页面留个同名薄包装、壳里
// 却没真实现，调用点照跑不报错，横幅就是不弹/不收。反过来也一样：真实现搬走了，
// 页面忘了留薄包装，内联 onclick 点了抛 ReferenceError（被静默路径吃掉）。
// 判定只看「树里有什么」，不看「我跑了一下没问题」。
//
// 钉四条：
//   ① apiKey 横幅四函数的**真实现**唯一在 mp-shell.js（带 localStorage + TTL 逻辑）；
//   ② dashboard.html 这四函数只能是薄包装（return window.MPShell.xxx()），不持第二份逻辑；
//   ③ demo 横幅三函数与 overview.js 的副本不得复活（#demoBanner 元素早不在 DOM）；
//   ④ initDarkMode / 页面级 darkMode 键不得复活（暗色真源 = theme.js + nav.js）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const SHELL = read('mp-shell.js');
const DASH = read('dashboard.html');
const OVERVIEW = read('views/overview.js');

// 剥注释与字符串，只在真代码里找标识符（与 panel-view-isolation 同族手法：
// 注释里写 "showApiKeyBanner" 不算实现，字符串里的 onclick 也不算）。
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
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
const SHELL_CODE = stripCommentsAndStrings(SHELL);

// dashboard.html 有 2000+ 行，内联脚本里含正则字面量/带引号字符串。整段剥字符串会让
// 一处不平衡的引号吞掉半页（D-022 实测：89k→49k 假绿），所以这里**按行**剥 `//`
// 注释即可：薄包装与死码判据都看行首形态，行级处理既避开注释误判又不跨行吞页。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  }).join('\n');
}
const DASH_CODE = stripLineComments(DASH);

test('① apiKey 横幅四函数真实现唯一在 mp-shell.js（不是空壳）', () => {
  for (const name of ['showApiKeyBanner', 'hideApiKeyBanner', 'isApiKeyBannerDismissed', 'dismissApiKeyBanner']) {
    // 挂到 MPShell 上
    assert.match(SHELL_CODE, new RegExp('\\b' + name + '\\s*[,:]'),
      `mp-shell.js 未把 ${name} 纳入 MPShell`);
  }
  // 真实现带「关闭记忆」逻辑：读 localStorage + 24h TTL + 写时间戳
  assert.match(SHELL_CODE, /localStorage\.getItem\(\s*API_KEY_DISMISSED_KEY/,
    'isApiKeyBannerDismissed 未读关闭时间戳（空壳）');
  assert.match(SHELL_CODE, /API_KEY_DISMISS_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    '关闭记忆的 24h TTL 不在壳里');
  assert.match(SHELL_CODE, /localStorage\.setItem\(\s*API_KEY_DISMISSED_KEY/,
    'dismissApiKeyBanner 未写关闭时间戳（空壳）');
});

test('② dashboard.html 四函数只能是薄包装（不持第二份横幅逻辑）', () => {
  for (const name of ['showApiKeyBanner', 'hideApiKeyBanner', 'isApiKeyBannerDismissed', 'dismissApiKeyBanner']) {
    const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}');
    const m = DASH_CODE.match(re);
    assert.ok(m, `dashboard.html 缺 ${name} 薄包装（内联 onclick / init() 会 ReferenceError）`);
    // 薄包装体只允许一句 return window.MPShell.xxx()：不许再碰 localStorage / DOM。
    const body = m[1].trim();
    assert.match(body, new RegExp('^return\\s+window\\.MPShell\\.' + name + '\\(\\);?$'),
      `${name} 不是纯薄包装，页面持了第二份逻辑：${body}`);
  }
  // 页面里不许再出现横幅的 localStorage 键（那是真实现该待的地方）
  assert.ok(!DASH_CODE.includes('apiKeyBannerDismissed'),
    'dashboard.html 还在读写 apiKeyBannerDismissed，横幅逻辑没收干净');
});

test('③ demo 横幅三函数与 overview.js 副本不得复活（元素早不在 DOM）', () => {
  for (const [label, code] of [['dashboard.html', DASH_CODE], ['views/overview.js', stripCommentsAndStrings(OVERVIEW)]]) {
    for (const name of ['showDemoBanner', 'hideDemoBanner', 'dismissDemoBanner']) {
      assert.ok(!new RegExp('function\\s+' + name + '\\b').test(code),
        `${label} 的 ${name} 死码复活了（#demoBanner 元素不在 DOM，这是空打）`);
    }
    assert.ok(!code.includes('demoBanner'),
      `${label} 还在操作 demoBanner，横幅遗迹复活`);
  }
});

test('④ initDarkMode / 页面级 darkMode 键不得复活（暗色真源 = theme.js + nav.js）', () => {
  assert.ok(!/function\s+initDarkMode\b/.test(DASH_CODE),
    'dashboard.html 的 initDarkMode 复活了（#darkModeToggle 按钮早不在本页 DOM）');
  assert.ok(!DASH_CODE.includes('darkMode'),
    'dashboard.html 又出现页面级 darkMode 键（真源是 theme.js 的 data-theme 三态）');
  // 真源必须在位：theme.js 设 data-theme，nav.js 有三态切换器
  const theme = read('theme.js');
  const nav = read('nav.js');
  assert.match(theme, /setAttribute\(\s*['"]data-theme['"]/,
    'theme.js 不再设 data-theme，暗色真源丢了');
  assert.match(nav, /mp-theme-switch/, 'nav.js 的三态主题切换器没了');
});
