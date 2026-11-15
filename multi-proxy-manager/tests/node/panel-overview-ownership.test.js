// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 概览状态归属守卫（2026-11-15，2.3b 第七片）
//
// 为什么要有它：这一片搬的不是代码，是**状态的持有者**。`proxyStatus` / `versionCache`
// 从页面 IIFE 迁进 views/overview.js 之后，最危险的两种坏法都不报错：
//   ① 页面又长出第二个 `var proxyStatus = {}`（复制粘贴旧代码 / 合并冲突），于是
//      卡片读模块那份、按钮判断读页面那份，两份快照来自不同时刻 —— 文案和动作会相反，
//      而界面上看不出任何异常；
//   ② 页面那几个薄包装（loadStatus / loadVersion / checkProxyConflicts）被当成死码删掉，
//      可是 init()、自动刷新、BroadcastChannel 跨页同步、MPStates 重试回调都还按名字
//      调用它们 —— 表现为「面板不刷新」「别的标签页启停后这页不动」，控制台一条
//      undefined is not a function，但页面照常渲染。
//
// 判据（纯静态，剥掉注释再判，避免被一句注释满足或误伤）：
//   ① 页面不许声明 proxyStatus / versionCache，也不许再按下标读它们；
//   ② 持有者必须真在 views/overview.js 里声明并暴露（删了就是两边都没有：卡片永远空态，不报错）；
//   ③ 页面三个薄包装必须还在，且侧栏勋章只经 MPViews.overview.status() 读；
//   ④ 动态生成的 onclick="toggleProxy(...)" 必须由模块挂到 window（D-017）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const PAGE = path.join(PUBLIC, 'dashboard.html');
const VIEW = path.join(PUBLIC, 'views', 'overview.js');

// 只留「代码行」：按行丢掉纯注释行（`//` 开头 / `/*` 开头 / `*` 续行）。
// 🔴 第一版用整段正则剥 `/* ... */`，注入验证时**假绿**了：页面里某处字符串/样式里的
// 一个不平衡 `/*` 把后面半页 JS 全吞掉（实测 89k → 49k），于是「页面不许声明
// proxyStatus」这条在页面真的重新声明之后仍然通过 —— 拿「文件变小了」当证据。
// 按行过滤没有跨行状态，吞不掉代码；代价是行尾注释留着，但它拼不出 `var X =` 这种形态。
function codeLines(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

// 页面：只取内联 <script> 块（静态 HTML 里的 `id="proxyStatusCount"` 之类不参与判定）
function inlineScript(html) {
  const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  return codeLines(blocks.map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n'));
}

const pageCode = inlineScript(fs.readFileSync(PAGE, 'utf8'));
const viewCode = codeLines(fs.readFileSync(VIEW, 'utf8'));

test('状态只有一份：页面不再声明 proxyStatus / versionCache', () => {
  const leaked = [];
  if (/\bvar\s+proxyStatus\b/.test(pageCode)) leaked.push('var proxyStatus');
  if (/\bvar\s+versionCache\b/.test(pageCode)) leaked.push('var versionCache');
  assert.deepStrictEqual(leaked, [],
    'dashboard.html 又持有了 ' + leaked.join(' / ') + '：状态持有者只能是 views/overview.js（两份快照会让卡片文案与按钮动作相反）');
});

test('状态只有一份：页面不再按下标读 proxyStatus（那会 ReferenceError）', () => {
  assert.doesNotMatch(pageCode, /\bproxyStatus\s*\[/,
    '页面已无 proxyStatus，裸读即 ReferenceError —— 侧栏勋章请走 MPViews.overview.status(name)');
});

test('持有者必须真在 views/overview.js：两个状态 + MPViews.overview + window.toggleProxy', () => {
  const missing = [];
  if (!/\bvar\s+proxyStatus\s*=/.test(viewCode)) missing.push('var proxyStatus =');
  if (!/\bvar\s+versionCache\s*=/.test(viewCode)) missing.push('var versionCache =');
  if (!/global\.MPViews\.overview\s*=/.test(viewCode)) missing.push('global.MPViews.overview =');
  if (!/global\.toggleProxy\s*=/.test(viewCode)) missing.push('global.toggleProxy =（动态生成的 onclick 按全局解析，见 D-017）');
  assert.deepStrictEqual(missing, [],
    'views/overview.js 少了：' + missing.join('、') + '（少了状态声明 = 卡片永远空态且不报错；少了挂载 = 点按钮毫无反应）');
});

test('页面三个薄包装必须还在，侧栏勋章只经视图读状态', () => {
  const missing = [];
  for (const fn of ['loadStatus', 'loadVersion', 'checkProxyConflicts']) {
    if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(pageCode)) missing.push('function ' + fn + '(');
  }
  if (!/MPViews\.overview\.status\s*\(/.test(pageCode)) missing.push('MPViews.overview.status(');
  assert.deepStrictEqual(missing, [],
    'dashboard.html 少了：' + missing.join('、') + '—— init()/自动刷新/跨页同步按名字调用它们，删掉就是「面板不刷新」而页面照常渲染');
});
