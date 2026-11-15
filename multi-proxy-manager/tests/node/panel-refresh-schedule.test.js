// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 自动刷新调度归属（2026-11-15，2.3b 收口后第一片「壳」）
//
// 为什么要这条静态守卫：运行态由 e2e/auto-refresh.spec.js 守着，但那条要起真浏览器、
// 只跑在 tier0 闸门；而这一个 bug 的形态是「多了一个 clearInterval / 少了一次 apply」
// 这种一行之差的写法回潮，静态能秒判。两者不是重复：E2E 证明「用户看到的是对的」，
// 这里证明「没人把生命周期重新拆成两家」。
//
// 被守的那次事故（真跑量到的）：
//   switchPage 里写着「离开概览就 clearInterval」，但回来时没人重建 ⇒ 点一次别的 tab
//   再回来，自动刷新永久死掉，开关还画着 ON，数字只是停住不动。
//   同族的另外两个：拨开关关掉不落盘（刷新页面又自己开）；存进去的间隔不在选项里
//   ⇒ parseInt('') = NaN ⇒ setInterval(fn, NaN) 被当成 0 ⇒ 实测 1.5 秒 212 次请求。
//
// 判据全部落在**代码**上（不是散文）：先按行剥注释，再断言结构与调用。
// D-018 / D-022 两个方向的教训都吃过：散文既能满足判据，也能弄红判据。
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const PAGE = path.join(__dirname, '..', '..', 'public', 'dashboard.html');

// 按行过滤（只丢纯注释行，不跨行）：D-022 那次用整段正则剥 /* */，被页面里一处
// 不平衡的 /* 吞掉了后半页 JS（89k→49k），于是「不许出现 X」在真注入之后仍然通过。
function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
      return true;
    })
    .join('\n');
}

// 取某个函数声明的函数体（靠花括号配平，从声明处往后数），拿不到就返回 null。
function functionBody(code, name) {
  const decl = 'function ' + name + '(';
  const start = code.indexOf(decl);
  if (start === -1) return null;
  const open = code.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

// 只取页面自己的内联脚本：外链模块（mp-kernel / views/*）本来就不该碰壳调度。
function inlineScript(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.join('\n');
}

const html = fs.readFileSync(PAGE, 'utf8');
const code = stripCommentLines(inlineScript(html));

test('定时器的建与清只在 applyRefreshInterval 一处（壳里不许出现第二个调度者）', () => {
  const body = functionBody(code, 'applyRefreshInterval');
  assert.ok(body, 'applyRefreshInterval 不见了：调度入口被改名或删除，本判据与 E2E 同时失效');
  assert.match(body, /setInterval\(/, 'applyRefreshInterval 不再建定时器（那刷新是谁在管？）');
  assert.match(body, /clearInterval\(/, 'applyRefreshInterval 不再清旧定时器（改间隔会把旧的留在后台）');

  const creates = (code.match(/setInterval\(/g) || []).length;
  assert.strictEqual(creates, 1,
    `页面内联脚本里出现了 ${creates} 处 setInterval：调度只许有一个出口，`
    + '多出来的那处就是「两家各管一段生命周期」，早晚出现清掉没人重建');
});

test('switchPage 不许再碰定时器（离开页只该停刷，不该把调度者一起杀掉）', () => {
  const body = functionBody(code, 'switchPage');
  assert.ok(body, 'switchPage 不见了：SPA 分支表被改名或删除');
  assert.ok(!body.includes('__statusInterval'),
    'switchPage 又碰 __statusInterval 了 —— 这正是那次「点一次别的 tab 再回来就不刷了」的写法。'
    + '切页只管切页，刷哪一屏由 refreshTick 看活动页决定');
  assert.ok(!/clearInterval\s*\(/.test(body), 'switchPage 里出现 clearInterval：调度者又变成两家了');
});

test('关/开必须落盘，且「开关」与「关闭档」是同一条状态', () => {
  assert.ok(code.includes("'autoRefreshEnabled'"),
    '开关状态没有独立存储键：拨开关关掉后刷新页面又会自己开始刷（两种关闭方式行为不一致）');
  // 写的和读的必须是同一个键（写死字面量两处、写错一处就会静默失效）。
  const writes = (code.match(/setItem\(\s*REFRESH_ENABLED_KEY/g) || []).length;
  const reads = (code.match(/getItem\(\s*REFRESH_ENABLED_KEY/g) || []).length;
  assert.ok(writes >= 1, 'REFRESH_ENABLED_KEY 从未被写入：等于没持久化');
  assert.ok(reads >= 1, 'REFRESH_ENABLED_KEY 从未被读取：写了也没人用，刷新后照样回到默认开');

  // 「关闭」这一档（间隔 0）与开关同义：选 0 必须把开关一起关掉，否则界面上
  // 开关画着 ON、间隔写着「关闭」，两个控件互相打脸。
  const body = functionBody(code, 'readRefreshState');
  assert.ok(body, 'readRefreshState 不见了（状态归一化被删）');
  assert.match(body, /interval\s*===\s*0\s*\)\s*enabled\s*=\s*false/,
    'readRefreshState 不再把「间隔 0」归一成「关闭」：会同时出现「开关 ON + 间隔关闭」的自相矛盾状态');
});

test('合法档位来自 <select> 的选项，不是写死的数组', () => {
  const body = functionBody(code, 'refreshIntervals');
  assert.ok(body, 'refreshIntervals 不见了：说明档位校验被内联或删除');
  assert.match(body, /\.options/, '合法档位不再从 select.options 读 —— 写死数组会在下次改选项时悄悄过期，'
    + '旧值变非法 ⇒ select.value 变空串 ⇒ parseInt(\'\') = NaN ⇒ setInterval(fn, NaN) 被当成 0 延迟 ⇒ 请求风暴');

  // 页面上不该出现「把档位写死成常量表」的写法（[5,10,30,60] / [5, 10, 30, 60]）。
  assert.ok(!/\[\s*5\s*,\s*10\s*,\s*30\s*,\s*60\s*\]/.test(code),
    '页面里出现了写死的档位数组 [5,10,30,60]：档位真源应是 DOM 选项，两处各说一套必然漂移');
});
