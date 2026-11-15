// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 概览页次级卡归属守卫（2026-11-15，2.3b 第九片：运行中任务 + Provider 隔离）
//
// 为什么要有它：这两张卡是概览页最后两块从页面 IIFE 搬走的代码。它们比前几片
// 多两类坏法，且都不报错：
//   ① **取数回流**：页面重新长出 fetch('/api/sessions/running')，于是同一份数据有两个
//      请求点、两套容器写入顺序 —— 谁后返回谁赢，界面偶发空白，控制台干净。
//   ② **挂载重复或丢失**：卡片里的 onclick="abortSessionFromDashboard('id')" 是动态拼进
//      innerHTML 的（静态 HTML 里搜不到，panel-inline-handlers 只看静态属性）。模块挂一处、
//      页面再挂一处，就是「谁是活的」；一处都不挂，按钮点了毫无反应——而按钮长得完全正常。
//   ③ **第二真源复活**：Provider 隔离卡的渲染与读失败写法在 mp-shared.js 是唯一真源，
//      页面原先那两个同名函数只是纯转发别名。load 一走它们就是死码；死码不占地方，
//      占的是「下一个人以为文案还能在这里改」。
//
// 判据（纯静态，按行剥注释后再判——整段正则会被页面里不平衡的 `/*` 吞掉半页，D-022 实测）：
//   ① 页面内联脚本里不许再出现这两个接口的字面量（取数只在模块里）；
//   ② 页面不许再声明 renderSessionsList / renderProviderIsolation / showProviderReadError，
//      也不许再给 window.abortSessionFromDashboard 赋值（唯一挂载点在模块）；
//   ③ 页面两个薄包装（loadSessions / loadProviderHealth）必须还在且真转发；
//   ④ 模块必须挂 window.abortSessionFromDashboard、不许编造状态文案（「待处理」）；
//   ⑤ provider-health 模块必须走 MPShared 的两个函数，不许自己拼一份 HTML。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const PAGE = path.join(PUBLIC, 'dashboard.html');
const SESSIONS = path.join(PUBLIC, 'views', 'sessions.js');
const PROVIDER = path.join(PUBLIC, 'views', 'provider-health.js');

// 按行丢掉纯注释行（无跨行状态）。见文件头：整段正则剥 /* */ 会假绿。
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
const sessionsCode = codeLines(fs.readFileSync(SESSIONS, 'utf8'));
const providerCode = codeLines(fs.readFileSync(PROVIDER, 'utf8'));

test('取数只有一处：页面内联脚本不再出现 /api/sessions 与 /api/provider-health', () => {
  const leaked = [];
  if (pageCode.includes('/api/sessions')) leaked.push('/api/sessions');
  if (pageCode.includes('/api/provider-health')) leaked.push('/api/provider-health');
  assert.deepStrictEqual(leaked, [],
    'dashboard.html 又自己取数了：' + leaked.join(' / ') +
    '（取数只允许在 views/sessions.js、views/provider-health.js —— 两个请求点 = 谁后返回谁赢，界面偶发空白且控制台干净）');
});

test('页面不再保留实现：renderSessionsList / 转发别名 / window.abortSessionFromDashboard', () => {
  const leaked = [];
  if (/function\s+renderSessionsList\s*\(/.test(pageCode)) leaked.push('function renderSessionsList(');
  if (/function\s+renderProviderIsolation\s*\(/.test(pageCode)) leaked.push('function renderProviderIsolation(（纯转发别名，真源在 mp-shared.js）');
  if (/function\s+showProviderReadError\s*\(/.test(pageCode)) leaked.push('function showProviderReadError(（纯转发别名，真源在 mp-shared.js）');
  if (/window\.abortSessionFromDashboard\s*=/.test(pageCode)) leaked.push('window.abortSessionFromDashboard =（唯一挂载点应在 views/sessions.js）');
  assert.deepStrictEqual(leaked, [],
    'dashboard.html 又长回了：' + leaked.join('、') + '—— 同一件事两处实现，迟早分叉');
});

test('页面两个薄包装必须还在且真转发（init / 自动刷新 / 跨页同步按名字调用）', () => {
  const missing = [];
  if (!/function\s+loadSessions\s*\(/.test(pageCode)) missing.push('function loadSessions(');
  if (!/function\s+loadProviderHealth\s*\(/.test(pageCode)) missing.push('function loadProviderHealth(');
  if (!/MPViews\.sessions\.load\s*\(/.test(pageCode)) missing.push('MPViews.sessions.load(');
  if (!/MPViews\.providerHealth\.load\s*\(/.test(pageCode)) missing.push('MPViews.providerHealth.load(');
  assert.deepStrictEqual(missing, [],
    'dashboard.html 少了：' + missing.join('、') +
    '—— init()、applyRefreshInterval、BroadcastChannel 都按名字调它们，删掉就是「面板不刷新而页面照常渲染」');
});

test('sessions 模块：动态 onclick 必须自己挂 window，且不许编造状态 / 编造年龄', () => {
  const problems = [];
  if (!/global\.abortSessionFromDashboard\s*=/.test(sessionsCode)) {
    problems.push('global.abortSessionFromDashboard =（卡片的 onclick 是动态拼的，静态守卫看不见，D-017）');
  }
  if (!/global\.MPViews\.sessions\s*=/.test(sessionsCode)) problems.push('global.MPViews.sessions =');
  // 「待处理」是旧代码给非 running 状态编的文案：后端只有 running/done/failed/aborted 四种，
  // 编一个不存在的状态，等于把 failed 说成「待处理」。
  // 判据带引号：文件头部的说明文字里也提到这个词（用「」括起），那种出现不算违规 ——
  // 只有真的写成 JS 字符串（'待处理' / "待处理"）才是要拦的编造文案。
  if (/['"]待处理['"]/.test(sessionsCode)) problems.push('「待处理」文案（后端没有这个状态，别编）');
  // createdAt 缺失时旧实现渲染 "NaNs"（同族：uptime 把 epoch 秒渲染成 20772d）。
  if (!/isFinite\s*\(/.test(sessionsCode)) problems.push('isFinite( 守卫（createdAt 不是日期时不许渲染 NaN）');
  assert.deepStrictEqual(problems, [], 'views/sessions.js 少了：' + problems.join('、'));
});

test('provider-health 模块：必须走 MPShared 两个函数，不许自己拼一份 HTML', () => {
  const problems = [];
  if (!/MPShared\.renderProviderIsolation\s*\(|SH\.renderProviderIsolation\s*\(/.test(providerCode)) {
    problems.push('renderProviderIsolation（渲染的唯一真源在 mp-shared.js）');
  }
  if (!/MPShared\.showProviderReadError\s*\(|SH\.showProviderReadError\s*\(/.test(providerCode)) {
    problems.push('showProviderReadError（读失败写法同源，副标题必须一起清空）');
  }
  if (providerCode.includes('所有 Provider 健康')) problems.push('「所有 Provider 健康」字面量（文案真源在 mp-shared.js）');
  if (providerCode.includes('session-item')) problems.push('session-item（自己在拼隔离卡 HTML）');
  assert.deepStrictEqual(problems, [],
    'views/provider-health.js 出现了：' + problems.join('、') + '—— 第二真源就是这次要消灭的东西');
});
