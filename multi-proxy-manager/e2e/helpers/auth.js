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
const jwt = require('jsonwebtoken');

// 🔴 与 playwright.config.js 共用同一个 E2E 数据目录（2026-11-15）。
// 测试进程与 webServer 是两个进程，密钥必须落在同一处：
// 若这里回退去读真实 HOME，签出的 token 与测试服校验用的密钥就不是一把，表现为 401 假绿；
// 更糟的是测试服的密码文件也会写进真实 HOME（历史事故，见 playwright.config.js 注释）。
// 直接取 config 导出的常量，避免两处各写一份路径后悄悄漂移。
const E2E_DATA_DIR = require('../../playwright.config').E2E_DATA_DIR;
process.env.MP_DATA_DIR = process.env.MP_DATA_DIR || E2E_DATA_DIR;
process.env.JWT_SECRET_FILE = process.env.JWT_SECRET_FILE || require('path').join(E2E_DATA_DIR, 'jwt-secret');

// 与 lib/auth.js 同源：密钥文件走 lib/data-dir.js 单一真源（含「新不存在回退读旧」），
// 测试服继承同一 JWT_SECRET_FILE；不在这里另写一份路径，否则切目录后会出现 401 假绿。
function managerToken() {
  const secretFile = require('../../lib/data-dir').resolveJwtSecretFile();
  let secret;
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch (e) {
    // 读不到就直说，别让 addInitScript 用空串签出一个必然 401 的 token（那是假绿）。
    throw new Error(
      'E2E 读不到 JWT 密钥：' + secretFile
      + '\n测试服的 JWT_SECRET_FILE 必须与本进程一致，且测试服已启动（webServer 会建目录）。'
    );
  }
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
