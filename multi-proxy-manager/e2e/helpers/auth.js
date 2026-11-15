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
// 为什么必须共用：测试服写进隔离目录的密码/账本，测试进程若读真实 HOME，两边看到的不是同一套状态。
// 但**只共用数据目录，不碰密钥路径**：密钥走 lib/data-dir.js 的 resolveJwtSecretFile()，
// 与测试服天然同源（都读 home 那个文件，CI 里由 workflow 预写并导出 JWT_SECRET）。
// 第一版在这里另设 JWT_SECRET_FILE 指向临时目录，结果服务端见到 JWT_SECRET env 就不落盘，
// helper 读空 —— CI 全红。别再把密钥也「隔离」进来。
const E2E_DATA_DIR = require('../../playwright.config').E2E_DATA_DIR;
process.env.MP_DATA_DIR = process.env.MP_DATA_DIR || E2E_DATA_DIR;

// 与 lib/auth.js 同源：密钥文件走 lib/data-dir.js 单一真源（含「新不存在回退读旧」）。
function managerToken() {
  const secretFile = require('../../lib/data-dir').resolveJwtSecretFile();
  let secret;
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch (e) {
    // 读不到就直说，别让 addInitScript 用空串签出一个必然 401 的 token（那是假绿）。
    throw new Error(
      'E2E 读不到 JWT 密钥：' + secretFile
      + '\n测试服必须与本进程用同一把密钥（默认都读 home 下的密钥文件；CI 由 workflow 预写）。'
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
