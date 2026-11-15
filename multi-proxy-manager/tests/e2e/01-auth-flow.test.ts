// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * E2E Test Group 1: 认证契约 — 2026-11-15 重写。
 *
 * 为什么整组重写：旧用例断言「回环 + 无密码 → 显示设置密码表单 → 设置即登录」。
 * 那条流程本身就是 bug 源：`/api/auth/status` 对回环早已报 needsSetup:false（面板不显示表单），
 * 而 `/api/auth/login` 却仍按 needsPasswordSetup() 走 setup 分支 —— 于是一次「以为在登录」的
 * 提交就把提交值固化成真密码。实测：本机密码文件里的哈希正好等于 TEST_PASSWORD。
 *
 * 新契约（routes/auth.js 回环守卫 + login.html 直跳）：
 *   ① 回环 + 无密码 → 面板免鉴权，登录页直接把本机用户送进 dashboard，不渲染表单；
 *   ② 回环 + 无密码时，登录端点返回 400 且**绝不**创建密码文件；
 *   ③ 真要鉴权 = 显式设 MANAGER_PASSWORD 或已存在密码文件（此时回环也要登录）。
 *
 * 数据目录隔离见 playwright.config.js（MP_DATA_DIR / JWT_SECRET_FILE → 临时目录），
 * 本文件所有读写都只发生在那个临时目录里。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { BASE_URL, clearPasswordFile, setPasswordFile, TEST_PASSWORD, PASSWORD_FILE } from './helpers';

test.describe.serial('E2E Group 1: 回环免登录契约', () => {
  test.afterEach(() => {
    clearPasswordFile();
  });

  test('无密码 + 回环：登录页把本机用户直接送进面板，不渲染表单', async ({ page }) => {
    clearPasswordFile();
    await page.goto(`${BASE_URL}/login.html`);
    await expect(page).toHaveURL(/dashboard\.html/);
    await expect(page.locator('#setupMode')).toBeHidden();
    await expect(page.locator('#loginMode')).toBeHidden();
  });

  test('无密码 + 回环：登录端点不得把提交值落盘成密码', async ({ request }) => {
    clearPasswordFile();
    const resp = await request.post(`${BASE_URL}/api/auth/login`, { data: { password: TEST_PASSWORD } });
    expect(resp.status(), '回环下的登录提交必须被拒，不能悄悄变成「设密码」').toBe(400);
    const body = await resp.json();
    expect(body.loopback).toBe(true);
    expect(fs.existsSync(PASSWORD_FILE), '回环下任何登录提交都不许创建密码文件').toBe(false);
  });

  test('已设密码：登录页要求密码，错密码被拒', async ({ page }) => {
    setPasswordFile(TEST_PASSWORD);
    await page.goto(`${BASE_URL}/login.html`);
    await expect(page.locator('#loginMode')).toBeVisible();
    await page.locator('#loginPassword').fill('WrongPassword123!');
    const respP = page.waitForResponse(r => r.url().includes('/api/auth/login'));
    await page.locator('#loginForm button[type="submit"]').click();
    await respP;
    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#loginError')).toContainText(/invalid password/i);
    await expect(page.locator('#loginMode')).toBeVisible();
  });

  test('已设密码 + 正确密码可登录进面板', async ({ page }) => {
    setPasswordFile(TEST_PASSWORD);
    await page.goto(`${BASE_URL}/login.html`);
    await expect(page.locator('#loginMode')).toBeVisible();
    const respP = page.waitForResponse(r => r.url().includes('/api/auth/login'));
    await page.locator('#loginPassword').fill(TEST_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await respP;
    await expect(page).toHaveURL(/dashboard\.html/);
  });

  test('dashboard 免 token 可加载（回环放行）', async ({ page }) => {
    clearPasswordFile();
    await page.goto(`${BASE_URL}/dashboard.html`);
    // 首屏默认落在「今日」（#page-today 是 HTML 里唯一带 active 的容器），
    // 概览是 #page-dashboard，要切 tab 才显示 —— 别照抄旧断言去等它可见。
    await expect(page.locator('#page-today')).toBeVisible();
    await expect(page.locator('#sidebarNav .nav-item').first()).toBeVisible();
  });
});
