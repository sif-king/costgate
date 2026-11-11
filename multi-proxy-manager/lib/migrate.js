// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ==================== costgate 数据目录 / JWT 密钥 back-compat 迁移 ====================
//
// 背景（2026-11-11 老板拍板，见 PROJECT-STATE/COSTGATE-RENAME-MIGRATION）：
//   仓库/品牌 multi-proxy → costgate。数据目录 ~/.multi-proxy-manager、JWT 密钥
//   ~/.multi-proxy-jwt-secret 是「既有安装里存着真实计费/路由/配置/会话」的活路径。
//
// 决策 2/3 落地口径：
//   ① 默认不变：resolveDataDir / resolveJwtSecretFile 缺省仍是旧路径（零行为变更，纯增量）。
//   ② 回退读旧：dataDirForRead / jwtSecretFileForRead 在「新路径不存在」时回退读旧路径，
//      不报错、不丢数据（决策 3「自动回退读旧」而非强制重登）。
//   ③ 迁移靠手动命令：migrateDataDir / migrateJwtSecret 默认 dry-run（只报计划），
//      apply:true 才真迁移；rename 优先（原子），跨卷/权限失败回退 cp + 保留旧路径 + 告警（可回滚）。
//
// 本模块**不自动挂进启动路径**——启动时仍用 resolveDataDir/resolveJwtSecretFile（旧默认），
// 只有用户显式 `manage.sh migrate [--apply]` 才触发迁移。这是「盲改数据」红线的落点。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 旧/新命名（会随迭代变，故集中在常量；迁移脚本读这些，不散落硬编码）
const OLD_DATA_DIR = '.multi-proxy-manager';
const NEW_DATA_DIR = '.costgate';
const OLD_JWT_FILE = '.multi-proxy-jwt-secret';
const NEW_JWT_FILE = '.costgate-jwt-secret';

function home() {
  return process.env.HOME || os.homedir();
}

// ---- 解析：缺省 = 旧路径（零行为变更）；env 可覆盖 ----
function resolveDataDir() {
  return process.env.MP_DATA_DIR || path.join(home(), OLD_DATA_DIR);
}
function resolveJwtSecretFile() {
  return process.env.JWT_SECRET_FILE || path.join(home(), OLD_JWT_FILE);
}

// ---- 回退读旧：优先新路径，新不存在则回退读旧路径（都不存在则返回新路径，交由调用方生成）----
// 注意：这里「优先」的 new 路径是 NEW_*（不是 resolve* 的 inert 旧默认）——
// 回退读旧是「切到新默认后」的语义：先试新，新缺了才回退旧。
function dataDirForRead() {
  const nd = process.env.MP_DATA_DIR || path.join(home(), NEW_DATA_DIR);
  if (fs.existsSync(nd)) return nd;
  const old = process.env.MP_LEGACY_DATA_DIR || path.join(home(), OLD_DATA_DIR);
  if (fs.existsSync(old) && old !== nd) return old;
  return nd;
}
function jwtSecretFileForRead() {
  const nd = process.env.JWT_SECRET_FILE || path.join(home(), NEW_JWT_FILE);
  if (fs.existsSync(nd)) return nd;
  const old = process.env.JWT_SECRET_LEGACY_FILE || path.join(home(), OLD_JWT_FILE);
  if (fs.existsSync(old) && old !== nd) return old;
  return nd;
}

// ---- 迁移：默认 dry-run；apply 才动盘；rename 优先，跨卷回退 cp + 保留旧 ----
function migrateDataDir(opts = {}) {
  const apply = !!opts.apply;
  const nd = opts.newDir || path.join(home(), NEW_DATA_DIR);
  const od = opts.oldDir || path.join(home(), OLD_DATA_DIR);
  const result = { kind: 'data-dir', old: od, new: nd, apply, status: 'noop', message: '' };

  // 幂等：新目录已存在 → 不动
  if (fs.existsSync(nd)) {
    result.status = 'already-migrated';
    result.message = 'new dir already exists; nothing to do';
    return result;
  }
  if (!fs.existsSync(od)) {
    result.status = 'nothing-to-migrate';
    result.message = 'old dir does not exist; nothing to migrate';
    return result;
  }
  if (!apply) {
    result.status = 'planned';
    result.message = `would move ${od} -> ${nd} (dry-run; pass --apply to execute)`;
    return result;
  }
  // apply：rename 优先（同卷原子）；失败回退 cp -r + 保留旧目录
  try {
    fs.renameSync(od, nd);
    result.status = 'migrated';
    result.message = `renamed ${od} -> ${nd}`;
  } catch (e) {
    // 跨卷/EXDEV：cp + 保留旧目录 + 告警（绝不删旧，可回滚）
    try {
      fs.cpSync(od, nd, { recursive: true });
      result.status = 'copied-kept-old';
      result.message = `cross-volume: copied ${od} -> ${nd} (old kept for rollback; rename err: ${e.message})`;
    } catch (e2) {
      result.status = 'failed';
      result.message = `migration failed: ${e2.message}`;
      throw e2;
    }
  }
  return result;
}

function migrateJwtSecret(opts = {}) {
  const apply = !!opts.apply;
  const nd = opts.newFile || path.join(home(), NEW_JWT_FILE);
  const od = opts.oldFile || path.join(home(), OLD_JWT_FILE);
  const result = { kind: 'jwt-secret', old: od, new: nd, apply, status: 'noop', message: '' };

  if (fs.existsSync(nd)) {
    result.status = 'already-migrated';
    result.message = 'new secret file already exists; nothing to do';
    return result;
  }
  if (!fs.existsSync(od)) {
    result.status = 'nothing-to-migrate';
    result.message = 'old secret file does not exist; nothing to migrate';
    return result;
  }
  if (!apply) {
    result.status = 'planned';
    result.message = `would copy ${od} -> ${nd} (dry-run; pass --apply to execute)`;
    return result;
  }
  // JWT 密钥：复制（不 rename）——旧密钥文件保留，避免任何读旧逻辑失配；保持 0o600
  try {
    const buf = fs.readFileSync(od);
    fs.writeFileSync(nd, buf, { mode: 0o600 });
    result.status = 'migrated';
    result.message = `copied ${od} -> ${nd} (old kept, mode 0600)`;
  } catch (e) {
    result.status = 'failed';
    result.message = `jwt migration failed: ${e.message}`;
    throw e;
  }
  return result;
}

// 一次跑完数据目录 + JWT 密钥迁移，返回汇总
function migrateAll(opts = {}) {
  return {
    'data-dir': migrateDataDir(opts),
    'jwt-secret': migrateJwtSecret(opts),
  };
}

module.exports = {
  OLD_DATA_DIR, NEW_DATA_DIR, OLD_JWT_FILE, NEW_JWT_FILE,
  resolveDataDir, resolveJwtSecretFile,
  dataDirForRead, jwtSecretFileForRead,
  migrateDataDir, migrateJwtSecret, migrateAll,
};

// ---- CLI 入口：`manage.sh migrate [--apply]` ----
// 默认 dry-run（只报计划），只有显式 --apply 才把 apply:true 传下去动盘。
// 逐条打印 kind/status/message；任一 failed 或迁移函数抛错 → 退出码 1。
function main(argv) {
  const apply = argv.includes('--apply');
  console.log(apply
    ? 'costgate migrate: APPLY (disk changes enabled)'
    : 'costgate migrate: DRY-RUN (no disk changes; pass --apply to execute)');

  let results;
  try {
    results = migrateAll({ apply });
  } catch (e) {
    console.error(`[failed] migrate: ${e.message}`);
    return 1;
  }

  let failed = false;
  for (const [kind, r] of Object.entries(results)) {
    console.log(`[${r.status}] ${kind}: ${r.message}`);
    if (r.status === 'failed') failed = true;
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  // 用 exitCode 而非 process.exit()，避免管道场景下截断 stdout。
  process.exitCode = main(process.argv.slice(2));
}
