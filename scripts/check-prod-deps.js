#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
//
// check-prod-deps.js —— 生产依赖里有没有「没人用」的包？
//
// 为什么需要它：2026-11-09 实测发现 multi-proxy-manager 的生产依赖里有 playwright，
// 而它在整个仓库里唯一的引用者是 UI-AUDIT/shoot.js —— 那个目录是 .gitignore 掉的
// 内部脚本，外部用户 clone 下来根本不存在。于是每一位新用户的 `npm install --omit=dev`
// 都要为一份自己永远用不到的东西付 18MB 流量（26MB 里占 69%），并且 playwright 的
// postinstall 还会尝试下载 Chromium（百兆级），网络受限时整个安装直接失败。
//
// 这类问题不会自己暴露：本地装着 UI-AUDIT、依赖也早就装好了，谁都不会去数
// 「这 26MB 里有多少是我要的」。所以必须由机器数。
//
// 判据：dependencies 里的每个包，必须至少被一个**版本控制里的、非测试的**源文件引用。
//   · 用 git ls-files 而不是扫磁盘 —— 不入库的文件（UI-AUDIT/、PROJECT-STATE/ 等）
//     对用户不存在，不能拿它当「有人用」的证据。这是本案的分水岭。
//   · 源代码后缀要覆盖 .js/.mjs/.cjs/.ts/.tsx —— cursor-proxy 的源码是 TypeScript，
//     只看 .js 会把 commander/compression/helmet 全判成孤儿（实测假红 3 条）。
//
// 它**不**判断的：某个包「应该」在 dependencies 还是 devDependencies（那要看语义）。
// 它只回答一个事实问题：这个包，仓库里有没有人 require/import。
//
// 用法：
//   node scripts/check-prod-deps.js            # 检查，有孤儿则退出码 1
//   node scripts/check-prod-deps.js --verbose  # 连命中的包一起列出来
//
// 退出码：0 全部有主 / 1 存在孤儿 / 2 无法检查（无 .git，不算通过）

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// 需要检查的服务（有 package.json 的目录）。新增服务时加进来即可。
const SERVICES = [
  'multi-proxy-manager',
  'codex-proxy',
  'claude-proxy',
  'hermes-proxy',
  'cursor-proxy',
];

// 显式豁免：包名 → 理由。**不填理由等于没豁免**，脚本会把它当孤儿照报。
// 只有在「确实没有源文件 require 它，但生产环境确需安装」时才有资格进来
// （例如某个包只提供 bin，由 npm scripts 调用）。当前为空 —— 一旦你要往里加，
// 先问自己：外部用户装它，换来了什么？
const EXEMPT = {};

// 开发工具黑名单：这些包的语义是「开发/测试/审计时用」，产品服务端运行时不需要。
// 出现在 dependencies 里一律算错 —— 不管有没有人 require。
//
// 为什么光靠「有没有人 require」不够（2026-11-09 实测）：
//   多代理管理器里曾把 playwright 放在 dependencies，仓库里唯一的引用者是
//   gb-render-check.cjs —— 一个注释里写着 "one-off: eyeball the real rendered
//   #gateBar" 的一次性人工目检脚本。它**入库**，于是孤儿检测认为「有人用」，
//   判为合格。而事实上没有任何产品路径需要 chromium：每个用户为一次早已完成
//   的目检付 18MB，还搭上一次可能失败的 postinstall 浏览器下载。
//   ⇒ 「有人在 require」不等于「产品要用」。两条判据互补，缺一条就有盲区。
const DEV_ONLY_TOOLS = [
  'playwright',
  '@playwright/test',
  'puppeteer',
  'jest',
  'mocha',
  'vitest',
  'supertest',
  'electron',
  'typescript',
  'eslint',
  'prettier',
  'nodemon',
];

const SRC_GLOBS = ['*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx'];

function listTrackedSources() {
  const patterns = SRC_GLOBS.map((g) => `"${g}"`).join(' ');
  const out = execSync(`git ls-files ${patterns}`, { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

// 测试文件不算生产引用：测试依赖本行就声明在 devDependencies，
// 若把测试里的 require 也算进来，devDeps 误挪进 deps 就永远抓不到。
function isTestFile(f) {
  return (
    /(^|\/)tests?\//.test(f) ||
    /(^|\/)__tests__\//.test(f) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
  );
}

function main() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('✗ 没有 .git —— 无法判定「哪些文件随仓库发布」，本次不算通过。');
    console.error('  （源码包分发场景请在有 git 的环境里跑，或显式接受这一项未检查）');
    return 2;
  }

  let tracked;
  try {
    tracked = listTrackedSources();
  } catch (e) {
    console.error('✗ git ls-files 失败：' + e.message);
    return 2;
  }
  if (tracked.length === 0) {
    console.error('✗ 版本控制里没有任何源文件，检查无意义，不算通过。');
    return 2;
  }

  const prodFiles = tracked.filter((f) => !isTestFile(f));
  const sources = [];
  for (const f of prodFiles) {
    try {
      sources.push([f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
    } catch {
      // 读不了的（权限、LFS 占位符）不计入，也不因此判某包有主
    }
  }

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const usersOf = (dep) => {
    const esc = escRe(dep);
    // require('dep') / require('dep/sub') / import ... from 'dep' / require(`dep`)
    const re = new RegExp(
      `(require\\(\\s*['"\`]${esc}(['"/\`])|from\\s+['"]${esc}(['"/]))`
    );
    const hits = [];
    for (const [f, c] of sources) if (re.test(c)) hits.push(f);
    return hits;
  };

  const orphans = [];
  const misplaced = [];
  let total = 0;

  for (const svc of SERVICES) {
    const pkgPath = path.join(ROOT, svc, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    if (deps.length === 0) continue;

    console.log(`\n${svc}（生产依赖 ${deps.length} 个）`);
    for (const dep of deps) {
      total++;
      // 先判黑名单：它比「有没有人 require」更硬，不看引用者是谁
      if (DEV_ONLY_TOOLS.includes(dep)) {
        misplaced.push({ svc, dep });
        console.log(`  ✗ ${dep} —— 开发工具被放进了 dependencies`);
        continue;
      }
      const hits = usersOf(dep);
      if (hits.length === 0) {
        if (EXEMPT[dep]) {
          console.log(`  ~ ${dep} —— 已豁免：${EXEMPT[dep]}`);
          continue;
        }
        orphans.push({ svc, dep });
        console.log(`  ✗ ${dep} —— 版本控制里没有非测试源文件引用它`);
      } else if (VERBOSE) {
        console.log(`  ✓ ${dep.padEnd(22)} ${hits.length} 处，例：${hits[0]}`);
      }
    }
  }

  console.log('');
  if (orphans.length === 0 && misplaced.length === 0) {
    console.log(`✓ ${total} 个生产依赖全部有主（版本控制内的非测试代码会用到它们），且没有开发工具混入。`);
    return 0;
  }

  if (misplaced.length > 0) {
    console.error(`✗ ${misplaced.length} 个开发工具被放进了生产依赖：`);
    for (const { svc, dep } of misplaced) console.error(`    ${svc} → ${dep}`);
    console.error('');
    console.error('  它们应在 devDependencies。用户的 `npm install --omit=dev`（quickstart /');
    console.error('  Dockerfile 用的就是这条）不该把这堆测试与浏览器自动化工具一起拉下来。');
    console.error('  修法：挪到 devDependencies，再同步 lockfile：');
    console.error('    cd <service> && npm install --package-lock-only --no-audit --no-fund');
    console.error('  （注意：lock 的根包 deps/devDeps 必须与 package.json 一致，否则 CI 的 npm ci 会直接失败）');
    console.error('');
  }

  if (orphans.length > 0) {
    console.error(`✗ ${orphans.length} 个生产依赖找不到用处：`);
    for (const { svc, dep } of orphans) console.error(`    ${svc} → ${dep}`);
    console.error('');
    console.error('  三种修法，按优先级：');
    console.error('    1. 真不需要 → 从 dependencies 删掉（并同步 lockfile）');
    console.error('    2. 只是开发/测试/审计要用 → 挪到 devDependencies');
    console.error('    3. 确实要装但没人 require（只提供 bin）→ 在脚本顶部 EXEMPT 里登记，并写清理由');
    console.error('');
    console.error('  为什么这条重要：孤儿包不报错、不影响本机，只会在**别人**机器上变成');
    console.error('  多下载、多一个可能失败的 postinstall。本机永远测不出来。');
    console.error('');
  }

  return 1;
}

process.exit(main());
