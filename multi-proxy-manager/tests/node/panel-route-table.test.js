/*
 * costgate · 面板页路由表守卫（D-029）
 * Copyright (c) 2026 sif-king
 *
 * 背景：`switchPage` 的「切到哪页拉什么」原是一串 if / else if。漏一行、或把 id 写错
 * 一个字母，症状都是「页面切过去了、数据永远不出现」——不白屏、不报错、控制台无声。
 * 这类沉默故障没法靠人眼守，只能靠「表里的键」和「页面上真实存在的容器」双向比对。
 *
 * 这个文件守的就是那条比对，外加三条防回退。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', '..', 'public');
const DASH = fs.readFileSync(path.join(PUB, 'dashboard.html'), 'utf8');
const NAV = fs.readFileSync(path.join(PUB, 'nav.js'), 'utf8');

// ── 扫描工具 ────────────────────────────────────────────────────────────────
// 一律用「逐字符扫描 + 字符串/注释状态」，不用整段正则剥注释：
// D-022 踩过整段剥 `/* *\/` 被页面里不平衡的 `/*` 吞掉半页（89k→49k）。
// 这里的实现只在「已经定位到的字面量内部」工作，不碰整页。

function scan(src, from, onChar) {
  let inS = null, inLC = false, inBC = false, esc = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLC) { if (c === '\n') inLC = false; continue; }
    if (inBC) { if (c === '*' && n === '/') { inBC = false; i++; } continue; }
    if (inS) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && n === '/') { inLC = true; i++; continue; }
    if (c === '/' && n === '*') { inBC = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    const stop = onChar(c, i);
    if (stop) return i;
  }
  return -1;
}

/** 从 `declToken` 起找到第一个 `{` 或 `[`，返回配对括号之间的内容 */
function readBraced(src, declToken) {
  const start = src.indexOf(declToken);
  assert.notStrictEqual(start, -1, `找不到 ${declToken}`);
  // 必须认「第一个出现的括号」而不是写死 `{`：SPA_VIEWS 是数组，找 `{` 会圈住
  // 第一个条目的对象体，于是只解析出 1 个 id —— 判据变成「只验 1/6」的假绿。
  const openIdx = src.slice(start).search(/[{\[]/);
  assert.notStrictEqual(openIdx, -1, `${declToken} 后面没有 { 也没有 [`);
  const open = start + openIdx;
  const o = src[open];
  const closer = o === '{' ? '}' : ']';
  let depth = 0;
  const close = scan(src, open, (c) => {
    if (c === o) depth++;
    else if (c === closer) { depth--; if (depth === 0) return true; }
    return false;
  });
  assert.notStrictEqual(close, -1, `${declToken} 的 ${o} 没有闭合`);
  return src.slice(open + 1, close);
}

/** 按 top-level 分隔符切分（忽略字符串/注释/括号内部的同名字符） */
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, last = 0;
  scan(s, 0, (c, i) => {
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (depth === 0 && c === sep) { parts.push(s.slice(last, i)); last = i + 1; }
    return false;
  });
  parts.push(s.slice(last));
  return parts;
}

/** 只剥掉注释，保留代码与字符串（用于取「键名」这类不能带注释的片段） */
function stripComments(s) {
  let out = '';
  let inS = null, inLC = false, inBC = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLC) { if (c === '\n') { inLC = false; out += c; } continue; }
    if (inBC) { if (c === '*' && n === '/') { inBC = false; i++; } continue; }
    if (inS) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && n === '/') { inLC = true; i++; continue; }
    if (c === '/' && n === '*') { inBC = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; continue; }
    out += c;
  }
  return out;
}

// ── 被测对象 ────────────────────────────────────────────────────────────────

/** PAGE_LOADERS 的 { 键 -> 值表达式文本 }（保序） */
function pageLoaders() {
  const body = readBraced(DASH, 'var PAGE_LOADERS = {');
  const map = new Map();
  for (const raw of splitTopLevel(body, ',')) {
    const part = stripComments(raw).trim();
    if (!part) continue;
    const m = part.match(/^([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:\s*([\s\S]*)$/);
    assert.ok(m, `PAGE_LOADERS 里有解析不了的条目：${JSON.stringify(part.slice(0, 60))}`);
    const key = m[1].replace(/^['"]|['"]$/g, '');
    map.set(key, m[2].trim());
  }
  return map;
}

/** 页面上真实存在的 .page 容器 id（page- 后的那段） */
function pageContainers() {
  const ids = new Set();
  const re = /id="page-([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(DASH))) ids.add(m[1]);
  return ids;
}

/** 页内 tab 数据源（nav.js 的 SPA_VIEWS）里的 id */
function spaViewIds() {
  const body = readBraced(NAV, 'var SPA_VIEWS = [');
  const ids = [];
  const re = /id:\s*'([a-z0-9-]+)'/g;
  let m;
  while ((m = re.exec(body))) ids.push(m[1]);
  assert.ok(ids.length > 0, 'nav.js 的 SPA_VIEWS 里一个 id 都没解析到');
  // 防「只圈住第一个条目」那类解析失败：每个条目都有 label，个数必须对得上。
  // 少了就是圈错了范围（本次实现踩过：数组被当成对象体，只解析出 1/6）。
  const labels = (body.match(/label:\s*'/g) || []).length;
  assert.strictEqual(ids.length, labels,
    `SPA_VIEWS 解析出 ${ids.length} 个 id 但有 ${labels} 个 label：解析范围不对，判据会退化成只验一部分`);
  return ids;
}

// ── 判据 ────────────────────────────────────────────────────────────────────

test('① PAGE_LOADERS 的键与页面 .page 容器一一对上（双向，缺/多都报）', () => {
  const keys = new Set(pageLoaders().keys());
  const containers = pageContainers();

  const noLoader = [...containers].filter((id) => !keys.has(id));
  const noContainer = [...keys].filter((id) => !containers.has(id));

  assert.deepStrictEqual(noLoader, [],
    `这些 .page 容器没有加载函数（切过去就是一张空壳，且不报错）：${noLoader.join(', ')}`);
  assert.deepStrictEqual(noContainer, [],
    `这些加载函数指向不存在的 .page 容器（点了只会留住当前页）：${noContainer.join(', ')}`);
});

test('② 页内 tab（nav.js SPA_VIEWS）每个 id 都有容器和加载函数', () => {
  const keys = new Set(pageLoaders().keys());
  const containers = pageContainers();
  const bad = spaViewIds().filter((id) => !keys.has(id) || !containers.has(id));
  assert.deepStrictEqual(bad, [],
    `这些 tab 点下去没有内容可显示（SPA_VIEWS 有、路由表或容器没有）：${bad.join(', ')}`);
});

test('③ 静态 tab 的 data-page 也得是路由表里的键', () => {
  // 静态 tab 指 HTML 里手写的那几个（目前只有「概览」），不走 nav.js 生成。
  const keys = new Set(pageLoaders().keys());
  const re = /class="section-tab"[^>]*data-page="([a-z0-9-]+)"/g;
  const bad = [];
  let m;
  while ((m = re.exec(DASH))) if (!keys.has(m[1])) bad.push(m[1]);
  assert.deepStrictEqual(bad, [],
    `这些手写 tab 的 data-page 不在 PAGE_LOADERS 里：${bad.join(', ')}`);
});

test('④ 路由表的值必须是「可立即解析的函数」，不许出现字符串或裸 undefined', () => {
  // 为什么单独守这一条：表的值写成字符串（'loadHealthPage'）或拼错成未声明的名字时，
  // 运行时是「点了没反应」或 ReferenceError，而不是构建期红灯。这里把它们前置成红灯。
  const loaders = pageLoaders();
  assert.ok(loaders.size > 0, 'PAGE_LOADERS 是空的');

  const problems = [];
  for (const [key, value] of loaders) {
    if (/^function\b/.test(value)) continue;                  // 内联函数：合法
    if (/^[A-Za-z_$][\w$]*$/.test(value)) {                   // 裸标识符：必须真有这个声明
      const declared = new RegExp(
        String.raw`function\s+${value}\s*\(`).test(DASH);
      if (!declared) problems.push(`${key} → ${value}（本页没有这个 function 声明）`);
      continue;
    }
    problems.push(`${key} → ${JSON.stringify(value.slice(0, 40))}（既不是内联函数，也不是裸函数名）`);
  }
  assert.deepStrictEqual(problems, [], `PAGE_LOADERS 有值不可调用：\n  ${problems.join('\n  ')}`);
});

test('⑤ switchPage 体内不许再长回 if / else if 链（防回退）', () => {
  const body = readBraced(DASH, 'function switchPage(pageId) {');
  assert.ok(/PAGE_LOADERS\[\s*pageId\s*\]/.test(body),
    'switchPage 没有走 PAGE_LOADERS 查表，路由表被架空了');
  assert.ok(!/pageId\s*===\s*['"]/.test(body),
    'switchPage 里又出现了按 pageId 逐条比较的分支：加一页就等于在链子中间插一行，' +
    '漏一行的症状是「切过去没数据且不报错」。请改成往 PAGE_LOADERS 加一行。');
});

test('⑥ 未知 pageId 必须报错且不许动 DOM（先验后改）', () => {
  const body = readBraced(DASH, 'function switchPage(pageId) {');
  const lookup = body.indexOf('PAGE_LOADERS[pageId]');
  const firstDom = body.indexOf('querySelectorAll');
  assert.notStrictEqual(lookup, -1, 'switchPage 里找不到 PAGE_LOADERS[pageId]');
  assert.ok(lookup < firstDom,
    'switchPage 先改 DOM 再验 id：未知 id 会把所有 .page 的 active 摘光，留下一片空白屏');
  assert.ok(/console\.error\(/.test(body.slice(lookup)),
    '未知 pageId 静默 return：分不清是路由漏了一行还是后端挂了');
});

test('⑦ 侧栏项是指向独立页面的链接，不存在 .nav-item[data-page]', () => {
  // 这条锁定「切换 tab 时不需要（也无法）更新侧栏高亮」这个判断：
  // nav.js 的 nav-item 模板是 <a href>，从不带 data-page。若哪天改成页内切换，
  // 这里会红，提醒把侧栏高亮补回 switchPage。
  assert.ok(/'<a class="nav-item/.test(NAV),
    'nav.js 的 nav-item 不再是 <a href> 链接模板：页面里那段「切页更新侧栏高亮」的' +
    '逻辑需要重新补回 switchPage');
  assert.ok(/href="/.test(NAV), 'nav.js 的 nav-item 模板里没有 href');
  assert.ok(!/\.nav-item\[data-page=/.test(DASH),
    'dashboard.html 又出现 .nav-item[data-page=...] 查询：侧栏项从不带 data-page，这句永远不命中');
});
