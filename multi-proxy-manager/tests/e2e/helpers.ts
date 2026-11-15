// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * Shared helpers for the legacy tests/e2e matrix (2026-10-16, 手工考古用).
 *
 * 🔴 2026-11-15 重写：原 login() 通过登录页提交密码，而服务端在「回环 + 无密码」时
 * 会把提交值当成首启密码落盘 —— 这套矩阵直连真实 HOME 时，就把 TEST_PASSWORD
 * 写成了用户真密码（实测哈希可对上）。现在两层都堵了：
 *   ① 服务端拒绝回环 setup（routes/auth.js）；
 *   ② 本 helper 改为**直接签 token 注入**，不再走登录页、不写任何密码文件；
 * 数据目录由 playwright.config.js 隔离到临时目录（MP_DATA_DIR / JWT_SECRET_FILE）。
 *
 * 真凭据在用户的 ~ 下，测试永远不该碰。
 */

import { Page } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';

// 永不默认生产 18792；测试服固定 18801（config 里的 webServer 会用同一端口）。
export const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:18801';
// 仅供「显式设置密码后再验登录」的用例使用；不再被 login() 隐式写入。
export const TEST_PASSWORD = 'TestPass123!';

// 与 playwright.config.js 同一份隔离数据目录（config 里导出 E2E_DATA_DIR 会引入
// @playwright/test 的 defineConfig，这里只复制同一表达式并由守卫断言两处一致）。
// 只隔离数据目录，不碰密钥：密钥走 home 的密钥文件，与测试服同源（CI 由 workflow 预写）。
export const E2E_DATA_DIR = process.env.MP_E2E_DATA_DIR || path.join(os.tmpdir(), 'costgate-e2e-data');
process.env.MP_DATA_DIR = process.env.MP_DATA_DIR || E2E_DATA_DIR;

export const PASSWORD_FILE = path.join(E2E_DATA_DIR, 'password');

/** 清掉隔离目录里的密码文件（只动临时目录，绝不碰真实 HOME）。 */
export function clearPasswordFile(): void {
  try {
    const { execSync } = require('child_process');
    execSync(`rm -f "${PASSWORD_FILE}"`, { stdio: 'ignore' });
  } catch { /* 不存在即目的达成 */ }
}

/** 往隔离目录写一个 bcrypt 密码哈希（模拟「用户已设密码」的部署形态）。 */
export function setPasswordFile(password: string = TEST_PASSWORD): void {
  const bcrypt = require('bcryptjs');
  const fs = require('fs');
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  fs.writeFileSync(PASSWORD_FILE, bcrypt.hashSync(password, 10), { mode: 0o600 });
}

function managerToken(): string {
  const jwt = require('jsonwebtoken');
  const fs = require('fs');
  // 与 lib/auth.js 同源：走 data-dir 的单一真源（不认 MP_DATA_DIR，只认 JWT_SECRET_FILE 或 home）。
  const secretFile: string = require('../../lib/data-dir').resolveJwtSecretFile();
  let secret = '';
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch (e) {
    throw new Error(
      `E2E 读不到 JWT 密钥：${secretFile}\n`
      + '测试服必须用同一把密钥（默认都读 home 下的密钥文件；CI 由 workflow 预写），否则签出的 token 必然 401。'
    );
  }
  return jwt.sign({ authenticated: true, ts: Date.now() }, secret, { expiresIn: '2h' });
}

/**
 * 进面板：直接注入 token（不经过登录页）。
 * 回环部署本来就不需要登录，旧版「走登录页」既慢又会污染密码文件。
 */
export async function login(page: Page, _password: string = TEST_PASSWORD): Promise<string> {
  const token = managerToken();
  await page.addInitScript((t: string) => {
    try { sessionStorage.setItem('auth_token', t); } catch (e) {}
    try { localStorage.setItem('auth_token', t); } catch (e) {}
  }, token);
  await page.goto(`${BASE_URL}/dashboard.html`);
  return token;
}

/** 清 token（配合「已设密码」形态验证登录态）。 */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => sessionStorage.removeItem('auth_token'));
}
