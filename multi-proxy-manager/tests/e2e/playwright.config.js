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
    // 只隔离 MP_DATA_DIR，**不设** JWT_SECRET_FILE：密钥走 resolveJwtSecretFile()（home 或
    // workflow 预写的那个），与测试进程天然同源；指定一个服务端不会去写的路径只会让 helper 读空。
    command: `D="${E2E_DATA_DIR}" && mkdir -p "$D" && { [ -f "$D/providers.json" ] || cp providers.sample.json "$D/providers.json"; } && `
      + `MP_CONSENT_BYPASS=1 PORT=${PORT} MP_DATA_DIR="$D" `
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
    // video 关掉：录屏要 ffmpeg 二进制，本机没装就整个用例起不来（报
    // "Executable doesn't exist ... ffmpeg-mac"，看着像代码坏了，其实只是缺工具）。
    // 这套是手工考古用，截图够定位；真要录屏先 `npx playwright install ffmpeg`。
    video: 'off',
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
