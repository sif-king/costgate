// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 首屏 onboarding 归属守卫（2026-11-15，2.3b 第八片）
//
// 为什么要有它：这一片搬走的是「三态判定 + 一次性关闭 + 接入 URL 复制」。三种坏法
// 全都不报错、不白屏：
//   ① 页面又长出 `var ONBOARD_DISMISS` / `onboardDismissWired`（合并冲突 / 复制旧代码）：
//      两套关闭状态各自记各自的那份 —— 点过「不再提示」的卡换个路径又回来，
//      而 localStorage 里键名相同、值不同，排查时看着像缓存问题；
//   ② 页面把三步文案/判定留了一份（`onboardStepsHtml` / `onboardStateLine`）：
//      界面显示 A 口径、模块算 B 口径，改一处忘一处；
//   ③ 薄包装 `loadOnboarding` / `copyUnifiedIngressUrl` 被当死码删掉：init()、静态内联
//      handler（onclick）、showReadError 的重试回调都还按名字调用它们 ——
//      表现为「首屏卡片永远停在『正在读取运行状态…』」「点复制毫无反应」。
//
// 还有一条只属于这一片的：**统一接入 URL 的字面量只许有一份**。原来复制逻辑在页面
// IIFE、可见文本在 HTML 静态标签里手写，两份必然漂移（改端口改一处：界面显示 A、
// 复制出去 B）。真源收进 views/onboarding.js 的 UNIFIED_URL，页面内联脚本不许再出现。
//
// 判据纯静态、剥纯注释行（D-022 的教训：整段剥 `/* */` 会被不平衡的注释吞掉半页）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const PAGE = path.join(PUBLIC, 'dashboard.html');
const VIEW = path.join(PUBLIC, 'views', 'onboarding.js');

// 只丢纯注释行（`//` / `/*` / `*` 开头）：没有跨行状态，吞不掉代码。
function codeLines(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

function inlineScript(html) {
  const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  return codeLines(blocks.map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n'));
}

const pageCode = inlineScript(fs.readFileSync(PAGE, 'utf8'));
const viewCode = codeLines(fs.readFileSync(VIEW, 'utf8'));

test('onboarding 状态只有一份：页面不再声明关闭状态与三步判定', () => {
  const leaked = [];
  const decls = [
    /\bvar\s+ONBOARD_DISMISS\b/,
    /\bvar\s+onboardDismissWired\b/,
    /\bfunction\s+onboardStateLine\b/,
    /\bfunction\s+onboardStepsHtml\b/,
    /\bfunction\s+renderOnboarding\b/,
  ];
  decls.forEach((re) => { if (re.test(pageCode)) leaked.push(re.source); });
  assert.deepStrictEqual(leaked, [],
    'dashboard.html 又持有了 onboarding 私有实现：' + leaked.join(' / ')
    + '——判定与关闭状态只能有一份，在 views/onboarding.js');
});

test('持有者必须真在 views/onboarding.js：关闭键 / 三步判定 / 公开面', () => {
  const missing = [];
  if (!/\bvar\s+DISMISS_KEY\b/.test(viewCode)) missing.push('var DISMISS_KEY');
  if (!/\bfunction\s+onboardStateLine\b/.test(viewCode)) missing.push('function onboardStateLine');
  if (!/\bfunction\s+onboardStepsHtml\b/.test(viewCode)) missing.push('function onboardStepsHtml');
  if (!/global\.MPViews\.onboarding\s*=/.test(viewCode)) missing.push('global.MPViews.onboarding =');
  if (!/\bload:\s*load\b/.test(viewCode)) missing.push('load: load');
  if (!/\bcopyUnifiedUrl:\s*copyUnifiedUrl\b/.test(viewCode)) missing.push('copyUnifiedUrl: copyUnifiedUrl');
  assert.deepStrictEqual(missing, [],
    'views/onboarding.js 少了：' + missing.join('、')
    + '（少了判定 = 卡片停加载态；少了挂载 = 页面薄包装永远走 console.error）');
});

test('页面两个薄包装必须还在，并且真转发到视图（不许自己再实现一遍）', () => {
  const missing = [];
  for (const fn of ['loadOnboarding', 'copyUnifiedIngressUrl']) {
    if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(pageCode)) missing.push('function ' + fn + '(');
  }
  if (!/MPViews\.onboarding\.load\s*\(/.test(pageCode)) missing.push('MPViews.onboarding.load(');
  if (!/MPViews\.onboarding\.copyUnifiedUrl\s*\(/.test(pageCode)) missing.push('MPViews.onboarding.copyUnifiedUrl(');
  assert.deepStrictEqual(missing, [],
    'dashboard.html 少了：' + missing.join('、')
    + '—— init()/静态内联 handler/重试回调按名字调用它们，删掉就是「卡片永远加载中」与「点复制没反应」');
});

test('统一接入 URL 字面量只有一份：在模块里，页面内联脚本不许再出现', () => {
  const re = /['"]http:\/\/127\.0\.0\.1:18880\/v1['"]/g;
  const onPage = (pageCode.match(re) || []).length;
  const onView = (viewCode.match(re) || []).length;
  assert.strictEqual(onView, 1,
    'views/onboarding.js 里统一接入 URL 应恰好出现 1 次（UNIFIED_URL），实际 ' + onView
    + ' —— 多了就是又抄了一份，改端口会漂移');
  assert.strictEqual(onPage, 0,
    'dashboard.html 的内联脚本还在写接入 URL 字面量（' + onPage + ' 处）——'
    + '复制目标与界面显示必须是同一个值，请走 MPViews.onboarding.unifiedUrl / copyUnifiedUrl');
});
