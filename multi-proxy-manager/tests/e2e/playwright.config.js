// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ⚠️ 这套 tests/e2e 是 2026-10-16 的历史矩阵（50 个用例），不在 package.json scripts、不在 CI。
// 当前主用的是 e2e/ + playwright.config.js（tier0）。本 config 仅保留给手工考古。
//
// 🔴 两条硬约束（2026-11-15 补）：
//   ① baseURL 曾经写死 http://localhost:18792 —— 那是**真实运行的面板**。
//      历史上就是这么把 E2E 的测试密码写进真实 HOME 的（见 routes/auth.js 回环守卫注释）。
//      现在统一走 18801 测试端口，本 config 自带 webServer。
//   ② 测试服必须带 MP_DATA_DIR 隔离目录，否则测试会读写 ~/.multi-proxy-manager。
//
// ⚠️ 契约差异：01-auth-flow 的用例基于「回环首启设密码」旧流程，该流程已废除
// （2026-11-15：回环 + 无密码时 /api/auth/login 直接 400，面板不再要求登录）。
// 跑这套前请先按新契约核对，别把旧断言的红当成代码回归。
const { defineConfig } = require('@playwright/test');
const path = require('path');
const os = require('os');

const CI = !!process.env.CI;
const E2E_DATA_DIR = process.env.MP_E2E_DATA_DIR || path.join(os.tmpdir(), 'costgate-e2e-data');
const PORT = 18801;

module.exports = defineConfig({
  testDir: path.join(__dirname, '.'),
  testMatch: '**/*.test.ts',
  fullyParallel: true,
  timeout: 30000,
  webServer: {
    command: `mkdir -p "${E2E_DATA_DIR}" && MP_CONSENT_BYPASS=1 PORT=${PORT} `
      + `MP_DATA_DIR="${E2E_DATA_DIR}" JWT_SECRET_FILE="${E2E_DATA_DIR}/jwt-secret" `
      + `AUTH_RATE_MAX=100 AUTH_LOCKOUT_MAX=100 node server.js`,
    cwd: path.join(__dirname, '..', '..'),
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !CI,
    timeout: 60000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 5000,
    navigationTimeout: 10000,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  retries: 2,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      // 本机与仓库根 E2E 同策略：本地用系统 Chrome，CI 用 bundled chromium。
      use: { browserName: 'chromium', ...(CI ? {} : { channel: 'chrome' }) },
    },
  ],
});
