// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// ==================== 运行时数据目录 · 单一真源 ====================
// Phase 1（2026-11-14 老板拍板）：缺省切到 ~/.costgate / ~/.costgate-jwt-secret。
//
// 🔴 零负向的关键不在「改一行常量」，在下面这条回退规则：
//    新目录/文件存在 → 用新；只有旧的存在 → 仍然读旧；两个都不存在 → 用新（首次写入会创建）。
//    于是老安装不用重登、不用先跑迁移、账本也不会看起来丢了；全新安装才落新目录。
//    想真把旧数据搬过去，停服务后跑 `bash manage.sh migrate --apply`（见 README）。
//
// 优先级：显式注入 opts.dir/opts.file > MP_DATA_DIR / JWT_SECRET_FILE（未注入 home 时）> 回退解析。
// 🔴 opts.home 在生产里也会传真实 HOME（consent.js / session-store.js），所以**不能**把
//    「传了 home」当成测试标记而跳过探测——那会让老安装直接读不存在的新目录。
//    只有 home === '' 才当作干净 HOME 测试语义，返回相对 basename 且不探测。
//
// 旧名常量是迁移与回退必须知道的观测值，不算漂移；其余模块一律走这里。
// 漂移由 tests/unit/data-dir.test.js 机器判：任何模块新增硬写旧目录都会红。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR_BASENAME = '.costgate';
const LEGACY_DATA_DIR_BASENAME = '.multi-proxy-manager';
const JWT_SECRET_BASENAME = '.costgate-jwt-secret';
const LEGACY_JWT_SECRET_BASENAME = '.multi-proxy-jwt-secret';

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// 新优先、旧回退。返回值永远是一个可直接读的路径。
function pickExisting(home, newBasename, legacyBasename) {
  const fresh = path.join(home, newBasename);
  if (exists(fresh)) return fresh;
  const legacy = path.join(home, legacyBasename);
  if (exists(legacy)) return legacy;
  return fresh;
}

function resolveDataDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (opts.home === undefined && process.env.MP_DATA_DIR) return process.env.MP_DATA_DIR;
  const home = opts.home !== undefined ? opts.home : os.homedir();
  if (home === '') return DATA_DIR_BASENAME;
  return pickExisting(home, DATA_DIR_BASENAME, LEGACY_DATA_DIR_BASENAME);
}

function resolveJwtSecretFile(opts) {
  opts = opts || {};
  if (opts.file) return opts.file;
  if (opts.home === undefined && process.env.JWT_SECRET_FILE) return process.env.JWT_SECRET_FILE;
  const home = opts.home !== undefined ? opts.home : os.homedir();
  if (home === '') return JWT_SECRET_BASENAME;
  return pickExisting(home, JWT_SECRET_BASENAME, LEGACY_JWT_SECRET_BASENAME);
}

function dataFile(name, opts) {
  return path.join(resolveDataDir(opts), name);
}

module.exports = {
  DATA_DIR_BASENAME, LEGACY_DATA_DIR_BASENAME,
  JWT_SECRET_BASENAME, LEGACY_JWT_SECRET_BASENAME,
  resolveDataDir, resolveJwtSecretFile, dataFile,
};
