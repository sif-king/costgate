// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 内联 handler 全局暴露守卫（2026-11-14）
//
// 为什么要有它：dashboard.html 里 onclick/onchange/oninput/onkeydown 引用的函数是在
// **全局作用域**解析的，页面 IIFE 里的局部函数它们看不见。实测（Playwright 逐个真点）
// 发现 13 个被引用的函数从未挂到 window——告警搜索/筛选/刷新、今天页日期选择器/
// 刷新/文件查询、registry 筛选、成本/watchtower/概览刷新、健康页刷新、健康历史条数
// 下拉（引用的函数**从未定义过**）、watchtower 卡跳转、统一入口复制、API key 横幅
// 关闭。症状全部是「控件齐全、点击无声」：按钮渲染出来了，点了抛 ReferenceError。
// E2E 只点过 tab、没点过这些控件，所以假绿至今。
//
// 这条守卫是**纯静态交叉验证**（不跑页面脚本——vm 脚手架对浏览器 API 太脆，炸在
// 半路反而让守卫失效）：
//   ① HTML 内联 handler 引用的每个标识符，必须出现在 `window.NAME =` 挂载清单里；
//   ② 挂载清单里的每个名字，必须在 IIFE 里有 `function NAME(` 或 `var/let NAME =`
//      声明——防「挂载时拼错名字」把 undefined 挂上去。
// 新增内联 handler 引用了没暴露的函数 → 直接红，不用等有人手点。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const FILE = 'dashboard.html';

// 关键字与浏览器内建：出现在 handler 里但不是页面函数。
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'var', 'let', 'const',
  'typeof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'String',
  'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Math', 'isNaN', 'alert',
  'confirm', 'prompt', 'setTimeout', 'fetch', 'event', 'this', 'super',
]);

function extractHandlerRefs(html) {
  const found = new Set();
  // 先剥掉全部 <script> 块再提取：动态生成的 onclick 全在 JS 字符串里（onclick=\"
  // 形态），那批由生成处负责挂 window，历史上一直是对的（toggleProxy/editAgent/
  // deleteAgent/abortSessionFromDashboard）。留在 script 里用正则排除（lookbehind
  // 拦 \"）已被证明不可靠——JS 字符串转义会造出绕过 lookbehind 的形态。剥块是干净的
  // 边界：剩下的 on*= 只可能来自静态 HTML。
  const htmlOnly = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const attrRe = /\son(?:click|change|input|keydown|keyup|submit|load)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(htmlOnly)) !== null) {
    let code = m[1];
    // 成员调用（document.getElementById(...)、x.y(...)）不是全局引用，先抹掉。
    code = code.replace(/\.\s*[A-Za-z_$][\w$]*\s*\(/g, '');
    const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(code)) !== null) {
      if (!BUILTIN.has(c[1])) found.add(c[1]);
    }
  }
  return [...found].sort();
}

// 挂载 → 右侧首个标识符。三种形态：
//   window.foo = function () {...}   → 右侧 'function'
//   window.foo = foo                 → 别名（IIFE 内函数挂出去），右侧 'foo'
//   window.foo = foo.bind(x)        → 右侧 'foo'
function extractWindowMounts(script) {
  const map = new Map();
  const re = /window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(script)) !== null) map.set(m[1], m[2]);
  return map;
}

function extractDeclaredFunctions(script) {
  const found = new Set();
  const re = /\b(?:function\s+([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function)/g;
  let m;
  while ((m = re.exec(script)) !== null) found.add(m[1] || m[2]);
  return found;
}

test('dashboard 内联 handler 引用的每个标识符都挂到了 window，且挂载有真身', () => {
  const html = fs.readFileSync(path.join(PUBLIC, FILE), 'utf8');
  const refs = extractHandlerRefs(html);
  assert.ok(refs.length >= 10, `应至少提取到 10 个标识符（实际 ${refs.length}，提取逻辑坏了会假绿）`);

  const script = (html.match(/<script>[\s\S]*?<\/script>/g) || [])
    .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n');
  const mounts = extractWindowMounts(script);
  assert.ok(mounts.size >= 15, `window 挂载应至少 15 个（实际 ${mounts.size}，挂载段被删了会假绿）`);

  // ① 每个 handler 引用都必须有挂载
  const unmounted = refs.filter((n) => !mounts.has(n));
  assert.deepStrictEqual(unmounted, [],
    `以下函数被内联 handler 引用但没挂到 window（点了就是 ReferenceError）：${unmounted.join(', ')}`);

  // ② 每个被 handler 引用的挂载都必须有真身：右侧是 function 表达式，或右侧标识符
  //    本身有声明（防「window.foo = fo」拼错名字挂了 undefined）。
  //    只检查 refs ∩ mounts：window 上还有非 handler 的挂载（__statusInterval 这类
  //    状态变量），不在本守卫的判定范围。
  const declared = extractDeclaredFunctions(script);
  const ghostMounts = refs.filter((n) => {
    if (!mounts.has(n)) return false;
    const rhs = mounts.get(n);
    return rhs !== 'function' && !declared.has(rhs) && !declared.has(n);
  });
  assert.deepStrictEqual(ghostMounts, [],
    `以下 window 挂载找不到真身（挂了个 undefined）：${ghostMounts.join(', ')}`);
});
