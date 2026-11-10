#!/usr/bin/env node
// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 元守卫 · MCP 边界门（GATE 1）自证
//
// 为什么需要它：GATE 1 的用例只有在「坏参数真的被拒」时才有意义。
//   若哪天 checkArgs 被删、断言被放宽、或测试被改成只跑成功路径，单测仍可能全绿——那是假绿。
//   普通 CI 只会发现「红了」，发现不了「本该红的地方变绿了」。
//
// 做法：同一份单测跑两遍，两种门控状态必须给出**不同**结果：
//   门开（PROXY_MCP_SCHEMA_GUARD 缺省） → 必须 0 失败
//   门关（=0）                          → 必须恰好 2 失败，且就是 GATE 1 与 decompose 缺 input 两条
//   两者同时成立，才证明「门在拦」且「测试在测门」。
//
// 退出码：0=自证通过；1=自证失败（门失效或测试假绿）；2=环境问题（jest/依赖缺失，fail-closed）
//
// 用法：node scripts/meta-guard-mcp-gate.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'multi-proxy-manager');
const TEST = 'tests/unit/mcp-server.test.js';
const EXPECT = ['GATE 1', 'decompose 缺 input'];

function jestBin() {
  const local = path.join(MANAGER, 'node_modules', '.bin', 'jest');
  if (fs.existsSync(local)) return { bin: local, prefix: [] };
  return { bin: 'npx', prefix: ['jest'] };
}

// guard: 'on' = 缺省（门开） / '0' = 显式关
function runOnce(guard) {
  const out = path.join(os.tmpdir(), `mcp-gate-${process.pid}-${guard}.json`);
  try { fs.unlinkSync(out); } catch (e) { /* 不存在即目标 */ }

  const env = Object.assign({}, process.env, {
    NODE_OPTIONS: '--experimental-vm-modules',
  });
  if (guard === '0') env.PROXY_MCP_SCHEMA_GUARD = '0';
  else delete env.PROXY_MCP_SCHEMA_GUARD;

  const { bin, prefix } = jestBin();
  const args = prefix.concat([TEST, '--json', `--outputFile=${out}`, '--silent', '--forceExit']);
  spawnSync(bin, args, { cwd: MANAGER, env, stdio: 'ignore', timeout: 180000 });

  if (!fs.existsSync(out)) return null;
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (e) {
    return null;
  }
}

function failedTitles(report) {
  const out = [];
  for (const tr of (report.testResults || [])) {
    for (const a of (tr.assertionResults || [])) {
      if (a.status === 'failed') out.push(a.fullName || a.title || '(untitled)');
    }
  }
  return out;
}

function bail(msg) {
  console.error(`X ${msg}`);
  process.exit(2);
}

// ── 第一轮：门开着，必须全绿 ──
const on = runOnce('on');
if (!on) bail('jest 未产出 JSON（检查 multi-proxy-manager 是否已装依赖）');
const onFailed = failedTitles(on);
if (onFailed.length !== 0) {
  console.error(`X 门开时本应全绿，实际失败 ${onFailed.length} 条：`);
  onFailed.forEach((t) => console.error(`   - ${t}`));
  process.exit(1);
}

// ── 第二轮：门关掉，必须恰好那几条红 ──
const off = runOnce('0');
if (!off) bail('第二轮 jest 未产出 JSON');
const offFailed = failedTitles(off);

if (offFailed.length !== EXPECT.length) {
  console.error(`X 门关后预期 ${EXPECT.length} 条红，实际 ${offFailed.length} 条：`);
  offFailed.forEach((t) => console.error(`   - ${t}`));
  console.error('   （少 = 门失效或被旁路；多 = 别的用例依赖了默认门控，需人工复核）');
  process.exit(1);
}

const missing = EXPECT.filter((k) => !offFailed.some((t) => t.includes(k)));
if (missing.length > 0) {
  console.error(`X 预期失败项缺失：${missing.join(' / ')}`);
  console.error('   实际失败：');
  offFailed.forEach((t) => console.error(`   - ${t}`));
  process.exit(1);
}

console.log(`✓ MCP 边界门自证通过：门开 0 失败；门关恰好 ${offFailed.length} 条红（${EXPECT.join(' / ')}）`);
process.exit(0);
