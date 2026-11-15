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
  {
    file: 'tests/node/panel-view-isolation.test.js',
    must: ['PAGE_LOCALS', 'stripCommentsAndStrings', '裸用了页面局部名'],
    why: '视图模块作用域隔离（防模块裸用页面 IIFE 本地名，如 cost 抽离后 fetchJSON 未定义的静默空壳）',
  },
  {
    file: 'tests/node/panel-overview-ownership.test.js',
    // 关键字带转义反斜杠：只可能出现在**判据正则**里，写一句注释或 message 满足不了
    // （D-018 / D-021④ 的同族教训：只查文本的登记表会被散文骗过）。
    must: ['var\\s+proxyStatus', 'MPViews\\.overview\\.status', 'global\\.toggleProxy'],
    why: '概览状态归属（搬走的是持有者：页面不许再长第二份 proxyStatus/versionCache，薄包装不许被当死码删）',
  },
  {
    file: 'tests/node/panel-copy-feedback.test.js',
    must: ['ALLOWED', 'copyText', '只许有一个入口'],
    why: '复制只有一个入口且失败必反馈（CI 实测 headless 下 writeText 被拒 → 点了毫无反应）',
  },
  {
    file: 'tests/node/panel-onboarding-ownership.test.js',
    // 同样只用判据正则里的形态（转义反斜杠 + 唯一字面量计数），散文满足不了。
    must: ['var\\s+ONBOARD_DISMISS', 'MPViews\\.onboarding\\.copyUnifiedUrl', '统一接入 URL 字面量只有一份'],
    why: '首屏 onboarding 归属（三态判定/关闭状态/接入 URL 字面量各只有一份，页面只留转发薄包装）',
  },
  {
    file: 'e2e/copy-feedback.spec.js',
    must: ['@tier0', 'copyUnifiedIngressUrl', 'NotAllowedError'],
    why: '强制剪贴板被拒后真点复制按钮（把 CI 那个失败模式本身钉死，不依赖环境是否放行）',
  },
  {
    file: 'tests/node/panel-sessions-ownership.test.js',
    // 关键字同样是判据正则里的形态（转义反斜杠 / 正则前缀），散文满足不了。
    must: ['function\\s+renderSessionsList', 'MPViews\\.providerHealth\\.load', 'global\\.abortSessionFromDashboard'],
    why: '概览次级卡归属（运行中任务 + Provider 隔离：取数只在模块里，动态 onclick 只挂一处，隔离卡不许长第二真源）',
  },
  {
    // 第九片两条 E2E 的锚点也在这里。关键字必须是**测试里真有的断言**：
    // 第一版写 'abortSessionFromDashboard' / mp-shared 的提示原文，均不在 spec 里，
    // 于是登记表自己红（这次是登记表救了它自己 —— 别用「应该有」的词当锚点）。
    file: 'e2e/spa-views.spec.js',
    must: ['@tier0', 'healthProxyList', 'window.MPShared.proxyConfigNames().length > 0',
           '/api/sessions/running', 'sess-probe-1/abort', 'Provider 隔离状态读不到'],
    why: '健康视图经共享层取数并真渲染 + 概览次级卡（运行中任务 / Provider 隔离）的运行态守门人',
  },
  {
    // 第十片（壳·自动刷新调度）的两个守门人。关键字同样只用**代码里的形态**：
    // `functionBody` 是取函数体的辅助函数名、`\.options/` 只可能来自判据正则
    // （`/\.options/`），散文里写「从 select.options 读」满足不了带转义的那一版。
    file: 'tests/node/panel-refresh-schedule.test.js',
    must: ['functionBody', '\\.options/', "'autoRefreshEnabled'", 'setInterval\\('],
    why: '自动刷新调度归属（定时器只在 applyRefreshInterval 一处建与清、switchPage 不许碰、关/开必须落盘、档位来自 DOM 选项）',
  },
  {
    file: 'e2e/auto-refresh.spec.js',
    must: ['@tier0', '@pr-gate', '__statusInterval', 'autoRefreshEnabled', '请求风暴'],
    why: '自动刷新的运行态守门人（跨 tab 存活 / 关掉要记住 / 非法档位不许变请求风暴 / 两条关闭路径同一条状态）',
  },
  {
    // 壳第二片（横幅收口）的守门人。关键字只用判据正则里的形态（带转义反斜杠）
    // 与辅助函数名，散文注释满足不了 —— 否则改写判据为「打印式」就能骗过登记表。
    file: 'tests/node/panel-shell-banners.test.js',
    must: ['API_KEY_DISMISS_TTL_MS\\s*=', 'stripLineComments', 'function\\s+initDarkMode\\b'],
    why: '壳横幅归属（apiKey 四函数真实现唯一在壳、页面只留薄包装、demo 与 initDarkMode 死码不复活）',
  },
  {
    // 壳第三片（鉴权收口）的守门人。登记表用 src.includes(kw) 逐个比字面量，
    // 所以关键字要取「判据正则的**源码形态**」（如 window\.fetch\s*=），
    // 散文写「我们检查了 window.fetch」骗不过这一项。
    file: 'tests/node/panel-shell-auth.test.js',
    must: ['__mpAuthInstalled', 'res\\.status\\s*===\\s*401', 'window\\.fetch\\s*=', 'mp-shell.js'],
    why: '壳鉴权归属（探测/登录墙/fetch 注入唯一在壳、页面只留薄包装、不许再改写 window.fetch、加载顺序与引用面）',
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
  // 2026-11-15 补：第 7 项新加了 mp-shared.js 的顺序判据（views/health.js 加载时即取
  // global.MPShared）。若有人把这段检查删掉，顺序错了也没人喊 —— 所以连这条判据一起钉住。
  // 判据必须落在**代码**上：`shared_line=$(grep` 这行只可能是实现，不可能出现在注释里，
  // 光断言「文件里出现 mp-shared.js 字样」会被一句注释满足（D-018 同族假绿）。
  const coherence = fs.readFileSync(path.join(ROOT, 'scripts/check-panel-coherence.sh'), 'utf8');
  assert.match(coherence, /shared_line=\$\(grep/,
    'check-panel-coherence.sh 的 mp-shared.js 顺序检查被删或改写（共享层晚于视图加载会导致健康页整体不加载且无报错）');
  assert.match(coherence, /vline" -lt "\$shared_line/,
    'check-panel-coherence.sh 丢了「views 早于 mp-shared.js」的判定行（只留变量赋值等于没检查）');
});
