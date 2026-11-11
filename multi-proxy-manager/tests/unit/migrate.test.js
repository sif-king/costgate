// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

const M = require('../../lib/migrate');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 每个用例隔离一个临时 home，避免污染真实 ~/.multi-proxy-manager
let home;
let oldDir, newDir, oldJwt, newJwt;
const saved = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-migrate-'));
  oldDir = path.join(home, M.OLD_DATA_DIR);
  newDir = path.join(home, M.NEW_DATA_DIR);
  oldJwt = path.join(home, M.OLD_JWT_FILE);
  newJwt = path.join(home, M.NEW_JWT_FILE);
  saved.HOME = process.env.HOME;
  saved.MP_DATA_DIR = process.env.MP_DATA_DIR;
  saved.JWT_SECRET_FILE = process.env.JWT_SECRET_FILE;
  saved.MP_LEGACY_DATA_DIR = process.env.MP_LEGACY_DATA_DIR;
  saved.JWT_SECRET_LEGACY_FILE = process.env.JWT_SECRET_LEGACY_FILE;
  process.env.HOME = home;
  delete process.env.MP_DATA_DIR;
  delete process.env.JWT_SECRET_FILE;
  delete process.env.MP_LEGACY_DATA_DIR;
  delete process.env.JWT_SECRET_LEGACY_FILE;
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('migrate: resolve*（默认不变，零行为变更）', () => {
  test('resolveDataDir 缺省 = 旧路径 ~/.multi-proxy-manager', () => {
    expect(M.resolveDataDir()).toBe(oldDir);
  });
  test('resolveJwtSecretFile 缺省 = 旧路径 ~/.multi-proxy-jwt-secret', () => {
    expect(M.resolveJwtSecretFile()).toBe(oldJwt);
  });
  test('MP_DATA_DIR / JWT_SECRET_FILE env 覆盖', () => {
    process.env.MP_DATA_DIR = '/tmp/x/data';
    process.env.JWT_SECRET_FILE = '/tmp/x/secret';
    expect(M.resolveDataDir()).toBe('/tmp/x/data');
    expect(M.resolveJwtSecretFile()).toBe('/tmp/x/secret');
  });
});

describe('migrate: 回退读旧（决策 3：自动回退读旧，不报错）', () => {
  test('新目录存在 → 读新', () => {
    fs.mkdirSync(newDir);
    expect(M.dataDirForRead()).toBe(newDir);
  });
  test('新目录不存在 + 旧目录存在 → 回退读旧', () => {
    fs.mkdirSync(oldDir);
    expect(M.dataDirForRead()).toBe(oldDir);
  });
  test('新旧都不存在 → 返回新路径（交调用方生成）', () => {
    expect(M.dataDirForRead()).toBe(newDir);
  });
  test('JWT 密钥回退读旧同理', () => {
    fs.writeFileSync(oldJwt, 'old-secret', { mode: 0o600 });
    expect(M.jwtSecretFileForRead()).toBe(oldJwt);
    fs.writeFileSync(newJwt, 'new-secret', { mode: 0o600 });
    expect(M.jwtSecretFileForRead()).toBe(newJwt);
  });
});

describe('migrate: 数据目录迁移（决策 2：手动 + 默认 dry-run）', () => {
  test('旧存在/新不存在 + dry-run（默认）→ planned，且盘上未动', () => {
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'routing-mode.json'), '{}');
    const r = M.migrateDataDir({ apply: false, oldDir, newDir });
    expect(r.status).toBe('planned');
    expect(fs.existsSync(oldDir)).toBe(true);   // 旧目录原样
    expect(fs.existsSync(newDir)).toBe(false);   // 没创建新
    expect(r.message).toMatch(/dry-run/);
  });
  test('旧存在/新不存在 + apply → migrated（rename），旧没了新在', () => {
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'routing-mode.json'), '{}');
    const r = M.migrateDataDir({ apply: true, oldDir, newDir });
    expect(r.status).toBe('migrated');
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'routing-mode.json'))).toBe(true);
  });
  test('新目录已存在 → already-migrated（幂等，不动盘）', () => {
    fs.mkdirSync(newDir);
    const r = M.migrateDataDir({ apply: true, oldDir, newDir });
    expect(r.status).toBe('already-migrated');
  });
  test('旧目录不存在 → nothing-to-migrate', () => {
    const r = M.migrateDataDir({ apply: true, oldDir, newDir });
    expect(r.status).toBe('nothing-to-migrate');
    expect(fs.existsSync(newDir)).toBe(false);
  });
  test('跨卷（rename 抛 EXDEV）→ 回退 cp + 保留旧目录 + 告警', () => {
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'profiles.json'), '{}');
    // 模拟 EXDEV：临时把 renameSync 换成抛错
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
    try {
      const r = M.migrateDataDir({ apply: true, oldDir, newDir });
      expect(r.status).toBe('copied-kept-old');
      expect(fs.existsSync(oldDir)).toBe(true);        // 旧保留（可回滚）
      expect(fs.existsSync(path.join(newDir, 'profiles.json'))).toBe(true);
    } finally {
      fs.renameSync = orig;
    }
  });
});

describe('migrate: JWT 密钥迁移（决策 3：复制不 rename，保留旧 + 0600）', () => {
  test('旧存在 + apply → migrated，新文件 0600 且旧保留', () => {
    fs.writeFileSync(oldJwt, 'the-secret', { mode: 0o600 });
    const r = M.migrateJwtSecret({ apply: true, oldFile: oldJwt, newFile: newJwt });
    expect(r.status).toBe('migrated');
    expect(fs.existsSync(oldJwt)).toBe(true);
    expect(fs.readFileSync(newJwt, 'utf8')).toBe('the-secret');
    const mode = fs.statSync(newJwt).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  test('dry-run → planned，不创建新文件', () => {
    fs.writeFileSync(oldJwt, 's');
    const r = M.migrateJwtSecret({ apply: false, oldFile: oldJwt, newFile: newJwt });
    expect(r.status).toBe('planned');
    expect(fs.existsSync(newJwt)).toBe(false);
  });
});

describe('migrate: migrateAll 汇总', () => {
  test('同时迁数据目录 + JWT（apply）', () => {
    fs.mkdirSync(oldDir);
    fs.writeFileSync(oldJwt, 's');
    const all = M.migrateAll({ apply: true, oldDir, newDir, oldFile: oldJwt, newFile: newJwt });
    expect(all['data-dir'].status).toBe('migrated');
    expect(all['jwt-secret'].status).toBe('migrated');
  });
});
