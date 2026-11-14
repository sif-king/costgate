// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 面板守卫登记表（2026-11-15）——「守卫自己被删了也得有人喊」
//
// 触发案例：PANEL-HEALTH-CHECK-2026-11-15 §二 发现 A。当时工作区回退把
// tests/node/panel-inline-handlers.test.js 一起删了，结果 15 个控件坏了而
// node/coherence/E2E 三套检查全绿。事后又发现更根本的一层：这个静态守卫
// **从来没进过 CI**（p0-security-gate.yml 的 panel behavior tests 步骤只显式
// 列了 4 个文件名），即使文件在，CI 也不会跑它。
//
// 所以光「写一个新守卫」不够，得钉住三件事：
//   ① 关键守卫文件必须在树里、且还带着它该有的判据关键字（防随手删 / 防放宽）；
//   ② CI 的两个闸门必须真的会跑到它们（防「刹车网在硬盘上，闸没拉」重演）；
//   ③ 这条登记表本身也得被跑到 —— p0 gate 改成全量 node --test 后自动覆盖。
// 判定只看「树里有什么」，不看「我跑了一下没问题」。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const MANAGER = path.join(__dirname, '..', '..');
const ROOT = path.join(MANAGER, '..');

const GUARDS = [
  {
    file: 'e2e/inline-handlers.spec.js',
    must: ['@tier0', '@pr-gate', 'readInlineHandlers'],
    why: '真浏览器点控件这一层（D-017 同族回归的唯一运行态守门人）',
  },
  {
    file: 'tests/node/panel-inline-handlers.test.js',
    must: ['extractHandlerRefs', 'unmounted'],
    why: '静态交叉验证（引用 ⊆ 挂载 ⊆ 有真身）',
  },
  {
    file: 'e2e/gate-recheck.spec.js',
    must: ['@tier0', 'checkGate'],
    why: 'knowledge/skills「重新检测」按钮真点守卫',
  },
];

test('关键面板守卫都在树里，且没有被放宽成空壳', () => {
  assert.ok(GUARDS.length >= 3, '登记表条目数异常（登记表被删空会假绿）');
  const missing = [];
  for (const g of GUARDS) {
    const p = path.join(MANAGER, g.file);
    if (!fs.existsSync(p)) {
      missing.push(`${g.file} 不存在（${g.why}）——守卫被删，回归将无人喊`);
      continue;
    }
    const src = fs.readFileSync(p, 'utf8');
    for (const kw of g.must) {
      if (!src.includes(kw)) missing.push(`${g.file} 少了关键字 ${kw}（${g.why}）`);
    }
  }
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

test('CI 两个闸门都真的会跑到面板守卫', () => {
  const tier0 = fs.readFileSync(path.join(ROOT, '.github/workflows/e2e-tier0.yml'), 'utf8');
  assert.match(tier0, /--grep\s+"?@tier0"?/,
    'e2e-tier0.yml 不再跑 @tier0 —— 新增的控件守卫会变成硬盘上的摆设');
  assert.match(tier0, /panel-guard-registry\.test\.js/,
    'tier0 job 缺登记表自检：删掉 E2E 守卫文件后，这个 job 仍会安静地全绿');

  const p0 = fs.readFileSync(path.join(ROOT, '.github/workflows/p0-security-gate.yml'), 'utf8');
  // 曾经这里只显式列 4 个 node 守卫文件，D-017 守卫与新增登记表都不在名单里 → 永不执行。
  // 必须用通配全量跑，以后新增 tests/node/*.test.js 才会自动进闸门。
  assert.match(p0, /node\s+--test\s+tests\/node\/\*\.test\.js/,
    'p0 gate 的 panel behavior tests 必须全量跑 node --test tests/node/*.test.js，不能退回手写文件名单');
  // 2026-11-15 补：check-panel-coherence.sh 此前**只在本地 preflight 跑**，CI 里
  // 完全没有它。第 7 项（views/*.js 接线与 mp-shell.js 顺序）若没进闸，就等于
  // 把「视图忘接线 / 壳机制静默失效」重新放回无人看管的盲区。
  assert.match(p0, /bash\s+scripts\/check-panel-coherence\.sh/,
    'p0 gate 必须跑 check-panel-coherence.sh（面板一致性守卫不能只留在本地 preflight）');
});
