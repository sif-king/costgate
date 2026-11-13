// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// ==================== 运行时数据目录 · 单一真源 ====================
// 🔴 缺省严格 = 旧路径（零行为变更）。Phase 1 切 `.costgate` 只需改 DATA_DIR_BASENAME 一行，
//    但前提是老板真机先跑 `bash manage.sh migrate --apply` 并复核密码 / agent-token / 账本都在，
//    否则 auth.js 会在新目录里找不到旧密码而要求重设（负向）。未拍板前不要改这一行。
//
// 优先级：显式注入 opts.dir > MP_DATA_DIR（未注入 home 时）> 缺省目录。
// opts.home 注入保留 consent.js / session-store.js 的「干净 HOME」测试语义：
//   传 '' 时得到相对路径 '.multi-proxy-manager'，与原实现逐字节一致。
// 缺省用 os.homedir()（与 auth.js 原实现一致），不额外掺入 process.env.HOME 判断。
//
// 漂移由 tests/unit/data-dir.test.js 机器判：任何模块新增硬写旧目录都会红。

const os = require('os');
const path = require('path');

const DATA_DIR_BASENAME = '.multi-proxy-manager';

function resolveDataDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (opts.home === undefined && process.env.MP_DATA_DIR) return process.env.MP_DATA_DIR;
  const home = opts.home !== undefined ? opts.home : os.homedir();
  return path.join(home, DATA_DIR_BASENAME);
}

function dataFile(name, opts) {
  return path.join(resolveDataDir(opts), name);
}

module.exports = { DATA_DIR_BASENAME, resolveDataDir, dataFile };
