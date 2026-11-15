// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// multi-proxy E2E smoke 配置（v1.0 收口，2026-10-16）
// 真浏览器加载 8 个壳页（dashboard/floor/logs/sessions/knowledge/skills/settings/context），
// 断言「真浏览器里能渲染、不崩」。测试服旁路首启同意门（MP_CONSENT_BYPASS=1）。
// 本机 clash 代理上游失效导致 chromium 下不动，故用「系统 Chrome」（channel: chrome）绕开下载。
// CI（GitHub Actions）无此限制，改用 Playwright 自带的 chromium（npx playwright install chromium），
// 避免 CI 环境再装一份系统 Chrome 的复杂度——靠 process.env.CI 切换，本地行为不变。
// 用法：npx playwright test    （测试服 18801 由 webServer 复用；系统 Chrome 在 /Applications/Google Chrome.app）
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');

// CI 环境用 bundled chromium；本地用系统 Chrome（channel: chrome）。
const CI = !!process.env.CI;
const browserChannel = CI ? undefined : 'chrome';

// 🔴 E2E 数据目录必须是隔离的（2026-11-15）。
// 事故：测试服原来只写 `PORT=18801 node server.js`，没有 MP_DATA_DIR ⇒ 继承真实 HOME 的
// ~/.multi-proxy-manager。又因为 /api/auth/login 曾在回环下走 setup 分支，
// 一次「以为在登录」的提交就把 E2E 的测试密码写成了真密码 —— 用户下次开面板凭空多出一道登录门。
// 现在服务端已拒绝回环 setup（routes/auth.js），这里再加一道：测试数据只落临时目录。
//
// ⚠️ 只隔离 MP_DATA_DIR，**不要**顺手设 JWT_SECRET_FILE（第一版设了，CI 直接红）：
//   · lib/data-dir.js 的 resolveJwtSecretFile() 不读 MP_DATA_DIR，只认 JWT_SECRET_FILE 或 home；
//   · 而 lib/auth.js 见到 JWT_SECRET 环境变量就**不落盘**（CI 的 e2e-tier0 会预写密钥并导出 JWT_SECRET）；
//   · 于是「指定了一个文件路径」+「服务端根本不写这个文件」⇒ helper 读空 ⇒ 所有用例起不来。
// 不设它反而天然同源：测试服与 helper 都走 home 的同一个密钥文件。
const E2E_DATA_DIR = process.env.MP_E2E_DATA_DIR || path.join(os.tmpdir(), 'costgate-e2e-data');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: true,
  workers: 4,
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        // 本地用系统 Chrome 绕开下载；CI 用 bundled chromium
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  webServer: {
    // MP_DATA_DIR 不是可选装饰：没有它，测试就会读写真实用户数据目录（密码文件、账本全在 ~ 下）。
    // mkdir -p 先建目录，否则服务端首次写数据会 ENOENT。
    // providers.json 用仓库里的公开示例垫底：数据目录一隔离，配置就是空的，
    // 「代理卡片 ≥1 / proxyConfigNames 非空」这类断言会红在「没数据」而不是「代码坏了」。
    command: `D="${E2E_DATA_DIR}" && mkdir -p "$D" && { [ -f "$D/providers.json" ] || cp providers.sample.json "$D/providers.json"; } && `
      + `MP_CONSENT_BYPASS=1 PORT=18801 MP_DATA_DIR="$D" `
      + `AUTH_RATE_MAX=100 AUTH_LOCKOUT_MAX=100 node server.js`,
    url: 'http://localhost:18801/login',
    reuseExistingServer: !CI,
    timeout: 60000,
  },
  use: {
    baseURL: 'http://localhost:18801',
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
  },
});

module.exports.E2E_DATA_DIR = E2E_DATA_DIR;
