// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 守卫：测试不许往真实用户数据目录写密码（2026-11-15）
//
// 事故复盘（不是推测，是实测）：
//   ~/.multi-proxy-manager/password 里的 bcrypt 哈希，与 tests/e2e/helpers.ts 的
//   TEST_PASSWORD 比对通过 ⇒ 不是用户设的密码，是测试写的。
//   链路：旧 playwright 配置的测试服只写 `PORT=18801 node server.js`，没隔离 MP_DATA_DIR
//   ⇒ 继承真实 HOME；tests/e2e 的 baseURL 甚至直指生产的 18792。
//   而 /api/auth/login 在「回环 + 无密码」时走 setup 分支落盘 —— 一次「以为在登录」的
//   提交就把测试常量固化成了用户的新密码。
//
// 本守卫钉三件事：
//   ① 服务端行为：回环 + 无密码时登录端点必须 400，且**真的不产生** password 文件（子进程真跑）；
//   ② 登录页行为：回环 + 无密码时必须直跳面板，不许渲染表单（否则用户随手一输又被写成密码）；
//   ③ 测试隔离：两份 playwright 配置的测试服必须带 MP_DATA_DIR / JWT_SECRET_FILE，
//      且任何配置都不许指向生产端口 18792。
// 判定只看「代码在会执行的形态上写了什么」+ 真跑一次，不信注释。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const MANAGER = path.join(__dirname, '..', '..');
const ROOT = path.join(MANAGER, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

test('回环 + 无密码时，登录端点 400 且不落盘密码（真跑路由）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-auth-guard-'));
  const script = `
    const express = require('express');
    const request = require('supertest');
    const router = require('./routes/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', router);
    request(app).post('/api/auth/login').send({ password: 'guard-probe-123' })
      .then((res) => {
        process.stdout.write('\\n__RESULT__' + JSON.stringify({ status: res.status, body: res.body }) + '\\n');
      })
      .catch((e) => {
        process.stdout.write('\\n__RESULT__' + JSON.stringify({ error: String(e && e.stack || e) }) + '\\n');
      });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: MANAGER,
    env: {
      ...process.env,
      MP_DATA_DIR: tmp,
      JWT_SECRET_FILE: path.join(tmp, 'jwt-secret'),
      // 限流器默认 5/min，单次探针不受影响；写死只为不受外部环境干扰。
      AUTH_RATE_MAX: '100',
      AUTH_LOCKOUT_MAX: '100',
    },
    encoding: 'utf8',
  });

  const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, '子进程没有回传结果（脚本或依赖炸了）:\n' + out);
  const result = JSON.parse(line.slice('__RESULT__'.length));
  assert.ok(!result.error, '真跑登录路由抛错：' + result.error);

  assert.strictEqual(result.status, 400,
    '回环 + 无密码时 /api/auth/login 必须 400（否则「登录」会静默变成「设密码」）');
  assert.strictEqual(result.body.loopback, true,
    '拒绝响应要带 loopback:true，前端/运维才知道是本机免鉴权而不是密码错误');
  assert.strictEqual(fs.existsSync(path.join(tmp, 'password')), false,
    '回环登录提交创建了 password 文件 —— 这正是把测试密码写进用户 HOME 的那条路');
});

test('登录页：回环 + 无密码必须直跳面板，不渲染表单', () => {
  const login = read(path.join(MANAGER, 'public', 'login.html'));
  // 判据落在会执行的分支上：这条 if 的条件表达式本身就是行为，散文注释满足不了。
  assert.match(login, /if\s*\(\s*data\.loopbackBypass\s*&&\s*!data\.hasPassword\s*\)/,
    'login.html 少了「回环且无密码 → 直接进面板」的分支');
  assert.match(login, /location\.replace\(\s*['"]\/dashboard\.html['"]\s*\)/,
    'login.html 的回环分支必须真的跳转（只判断不跳 = 用户仍面对空表单）');
});

test('两份 playwright 配置的测试服都必须隔离数据目录，且不许指向生产端口', () => {
  const configs = [
    path.join(MANAGER, 'playwright.config.js'),
    path.join(MANAGER, 'tests', 'e2e', 'playwright.config.js'),
  ];
  for (const file of configs) {
    const src = read(file);
    const rel = path.relative(ROOT, file);
    assert.match(src, /MP_DATA_DIR=/, `${rel}: webServer 必须设 MP_DATA_DIR，否则测试读写真实 HOME`);
    assert.match(src, /JWT_SECRET_FILE=/, `${rel}: webServer 必须设 JWT_SECRET_FILE，否则测试服与测试进程不是同一把密钥（401 假绿）`);
    assert.ok(!/18792/.test(src.replace(/\/\/.*$/gm, '')),
      `${rel}: 配置里出现了生产端口 18792（去掉注释后仍在）——测试绝不许打真实面板`);
  }
});

test('E2E helper 与配置用同一个隔离目录（两处路径必须可对上）', () => {
  const rootCfg = read(path.join(MANAGER, 'playwright.config.js'));
  const helper = read(path.join(MANAGER, 'e2e', 'helpers', 'auth.js'));
  const legacyHelper = read(path.join(MANAGER, 'tests', 'e2e', 'helpers.ts'));

  // 根 E2E helper 取 config 导出的常量（零漂移）；
  assert.match(helper, /require\(['"]\.\.\/\.\.\/playwright\.config['"]\)\.E2E_DATA_DIR/,
    'e2e/helpers/auth.js 必须复用 config 的 E2E_DATA_DIR，不要自己再写一份路径');
  assert.match(helper, /process\.env\.JWT_SECRET_FILE\s*=/, 'e2e/helpers/auth.js 必须设 JWT_SECRET_FILE');

  // 旧矩阵 helper 是 TS、不便 require CJS config，允许复制表达式，但必须与 config 同形。
  assert.match(rootCfg, /path\.join\(os\.tmpdir\(\),\s*['"]costgate-e2e-data['"]\)/,
    'playwright.config.js 的 E2E_DATA_DIR 形态变了（临时目录 + 固定名）');
  assert.match(legacyHelper, /path\.join\(os\.tmpdir\(\),\s*['"]costgate-e2e-data['"]\)/,
    'tests/e2e/helpers.ts 的目录表达式必须与 playwright.config.js 一致');
  assert.match(legacyHelper, /process\.env\.JWT_SECRET_FILE\s*=/, 'tests/e2e/helpers.ts 必须设 JWT_SECRET_FILE');
});

test('服务端：回环守卫只拦 setup，不是把整条登录路封死', () => {
  const auth = read(path.join(MANAGER, 'routes', 'auth.js'));
  // 守卫必须在 needsPasswordSetup() 分支内 —— 若被挪到函数开头，已设密码的用户会被一起挡在门外。
  const setupIdx = auth.indexOf('if (needsPasswordSetup())');
  const guardIdx = auth.indexOf('if (isLoopbackRequest(req))');
  assert.ok(setupIdx > -1, 'routes/auth.js 的 setup 分支不见了（登录端点结构被改）');
  assert.ok(guardIdx > setupIdx,
    '回环守卫必须写在 needsPasswordSetup() 分支内部；放到函数开头会连「已有密码的用户登录」一起禁掉');
  assert.match(auth, /error:\s*'[^']*MANAGER_PASSWORD[^']*'/, '拒绝时要告诉用户正确出口是 MANAGER_PASSWORD');
});
