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

// CI 环境用 bundled chromium；本地用系统 Chrome（channel: chrome）。
const CI = !!process.env.CI;
const browserChannel = CI ? undefined : 'chrome';

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
    command: 'MP_CONSENT_BYPASS=1 PORT=18801 node server.js',
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
