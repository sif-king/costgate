// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// E2E 鉴权种子（2026-10-25）
//
// 为什么必须有这个文件：manager 在生产态是**设了密码**的（/api/auth/status → hasPassword:true）。
// 不注入 token 时所有受保护接口返回 401，页面既有拦截器把浏览器踢去 login.html，
// 于是「页面加载成功」的断言测的其实是登录页——body 非空、无 pageerror、
// 看起来一片绿，实际一个业务元素都没验到。这是典型的**假通过**。
//
// 所以：任何断言业务 DOM 的 E2E，都必须先 seedAuth，并断言「没有被踢到 /login」。
// 缺这两步的 E2E 一律视为无效。
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

// 与 lib/auth.js 同源：密钥文件在 home 下，测试服继承同一 HOME。
function managerToken() {
  const secretFile = path.join(os.homedir(), '.multi-proxy-jwt-secret');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  return jwt.sign({ authenticated: true, ts: Date.now() }, secret, { expiresIn: '2h' });
}

// 必须在 page.goto 之前调用：addInitScript 在页面任何脚本之前执行，
// 这样页面自身的鉴权初始化一上来就能读到 token。
async function seedAuth(page) {
  const token = managerToken();
  await page.addInitScript((t) => {
    try { sessionStorage.setItem('auth_token', t); } catch (e) {}
    try { localStorage.setItem('auth_token', t); } catch (e) {}
  }, token);
  return token;
}

module.exports = { seedAuth, managerToken };
