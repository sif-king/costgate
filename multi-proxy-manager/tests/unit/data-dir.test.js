// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 运行时数据目录：Phase 1 已切 .costgate（2026-11-14 老板拍板）。
// 🔴 切缺省本身没有价值，「老安装不用重登、账本不丢」才是判据，所以这里真建临时目录测三态，
//    不靠断言常量。漂移守卫的 BASELINE 是观测快照，不是目标值：收口一个模块就删一项。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DD = require('../../lib/data-dir');
const {
  DATA_DIR_BASENAME, LEGACY_DATA_DIR_BASENAME,
  JWT_SECRET_BASENAME, LEGACY_JWT_SECRET_BASENAME,
  resolveDataDir, resolveJwtSecretFile, dataFile,
} = DD;

const ENV_KEYS = ['MP_DATA_DIR', 'JWT_SECRET_FILE'];

describe('data-dir 单一真源 · Phase 1 缺省已切 .costgate', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function tmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dd-home-'));
  }

  it('新名已切、旧名只作为回退常量保留', () => {
    expect(DATA_DIR_BASENAME).toBe('.costgate');
    expect(LEGACY_DATA_DIR_BASENAME).toBe('.multi-proxy-manager');
    expect(JWT_SECRET_BASENAME).toBe('.costgate-jwt-secret');
    expect(LEGACY_JWT_SECRET_BASENAME).toBe('.multi-proxy-jwt-secret');
  });

  it('【零负向核心 1】只有旧目录存在 → 仍然读旧（老安装不重登、账本不丢）', () => {
    const home = tmpHome();
    try {
      fs.mkdirSync(path.join(home, LEGACY_DATA_DIR_BASENAME));
      expect(resolveDataDir({ home })).toBe(path.join(home, LEGACY_DATA_DIR_BASENAME));
      expect(dataFile('password', { home })).toBe(path.join(home, LEGACY_DATA_DIR_BASENAME, 'password'));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('【零负向核心 2】新目录存在 → 用新（跑过 migrate --apply 之后）', () => {
    const home = tmpHome();
    try {
      fs.mkdirSync(path.join(home, LEGACY_DATA_DIR_BASENAME));
      fs.mkdirSync(path.join(home, DATA_DIR_BASENAME));
      expect(resolveDataDir({ home })).toBe(path.join(home, DATA_DIR_BASENAME));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('【零负向核心 3】两个都不存在 → 用新（全新安装首次写入会创建）', () => {
    const home = tmpHome();
    try {
      expect(resolveDataDir({ home })).toBe(path.join(home, DATA_DIR_BASENAME));
      expect(resolveJwtSecretFile({ home })).toBe(path.join(home, JWT_SECRET_BASENAME));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('JWT 密钥同样三态回退：旧文件存在时沿用，老 token 不失效', () => {
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, LEGACY_JWT_SECRET_BASENAME), 'legacy-secret');
      expect(resolveJwtSecretFile({ home })).toBe(path.join(home, LEGACY_JWT_SECRET_BASENAME));
      fs.writeFileSync(path.join(home, JWT_SECRET_BASENAME), 'new-secret');
      expect(resolveJwtSecretFile({ home })).toBe(path.join(home, JWT_SECRET_BASENAME));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('干净 HOME（home=""）返回相对 basename，不探测磁盘', () => {
    expect(resolveDataDir({ home: '' })).toBe('.costgate');
    expect(resolveJwtSecretFile({ home: '' })).toBe('.costgate-jwt-secret');
    expect(resolveDataDir({ home: '/tmp/cg-home' })).toBe(path.join('/tmp/cg-home', '.costgate'));
  });

  it('env 覆盖优先、不缓存（每次调用都读）', () => {
    process.env.MP_DATA_DIR = '/tmp/cg-override';
    process.env.JWT_SECRET_FILE = '/tmp/cg-secret';
    expect(resolveDataDir()).toBe('/tmp/cg-override');
    expect(resolveJwtSecretFile()).toBe('/tmp/cg-secret');
    expect(dataFile('password')).toBe(path.join('/tmp/cg-override', 'password'));
    delete process.env.MP_DATA_DIR;
    expect(resolveDataDir()).not.toBe('/tmp/cg-override');
  });

  it('opts.dir / opts.file 显式注入优先于 env', () => {
    process.env.MP_DATA_DIR = '/tmp/cg-override';
    expect(resolveDataDir({ dir: '/tmp/cg-injected' })).toBe('/tmp/cg-injected');
    expect(resolveJwtSecretFile({ file: '/tmp/cg-jwt' })).toBe('/tmp/cg-jwt');
  });

  it('本机真场景：旧目录在、新目录不在时，缺省解析确实回退读旧', () => {
    // 条件式断言：CI 干净 checkout 两者都没有，此时跳过而不是假绿/假红。
    const home = os.homedir();
    const hasOld = fs.existsSync(path.join(home, LEGACY_DATA_DIR_BASENAME));
    const hasNew = fs.existsSync(path.join(home, DATA_DIR_BASENAME));
    if (hasOld && !hasNew) {
      expect(resolveDataDir()).toBe(path.join(home, LEGACY_DATA_DIR_BASENAME));
    } else {
      expect(resolveDataDir()).toBe(path.join(home, DATA_DIR_BASENAME));
    }
  });
});

describe('数据目录漂移守卫', () => {
  // 收口后的观测快照：只剩两个「必须知道旧名字」的常量（回退与迁移）。
  // 其余模块一律走 lib/data-dir.js；新模块新增硬写即红。
  const BASELINE = {
    'lib/data-dir.js': 1,
    'lib/migrate.js': 1,
  };

  function scan(root = ROOT) {
    const found = {};
    for (const dir of ['lib', 'routes']) {
      const abs = path.join(root, dir);
      for (const f of fs.readdirSync(abs).filter(x => x.endsWith('.js'))) {
        const rel = dir + '/' + f;
        const lines = fs.readFileSync(path.join(abs, f), 'utf8').split('\n');
        let count = 0;
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
          if (line.includes("'.multi-proxy-manager'") || line.includes('".multi-proxy-manager"') ||
              line.includes('/.multi-proxy-manager')) count++;
        }
        if (count) found[rel] = count;
      }
    }
    return found;
  }

  it('硬写点不得新增：新模块一律走 lib/data-dir.js', () => {
    expect(scan()).toEqual(BASELINE);
  });

  it('守卫本身能抓到注入（否则是假绿）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dd-drift-'));
    try {
      fs.mkdirSync(path.join(tmp, 'lib'));
      fs.mkdirSync(path.join(tmp, 'routes'));
      fs.writeFileSync(path.join(tmp, 'lib', 'probe.js'),
        "const x = path.join(home, '.multi-proxy-manager');\n");
      expect(scan(tmp)).toEqual({ 'lib/probe.js': 1 });
      expect(scan(tmp)).not.toEqual(BASELINE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    expect(scan()).toEqual(BASELINE);
  });
});

// 2026-11-14 P0 Security Gate 红项复盘：这次的变量不在代码树里，在 HOME 里。
// 干净 checkout 的 preflight 抓不到「本机有 ~/.multi-proxy-manager 所以断言恒绿」，
// CI runner 的 /home/runner 是空的，解析到 .costgate，写死的断言当场红。
// 于是把「测试里写死生产默认 basename」这件事本身变成机器判的。
describe('测试断言不得写死生产默认目录名', () => {
  function scanTestAssumptions(root = ROOT) {
    const base = path.join(root, 'tests', 'unit');
    if (!fs.existsSync(base)) return [];
    const found = [];
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const r = rel + '/' + ent.name;
        if (ent.isDirectory()) { walk(abs, r); continue; }
        if (!ent.name.endsWith('.test.js')) continue;
        // 唯一例外：本文件同时持有词表和注入样本字符串，扫自己必然自指。
        // 精确到这一个路径，不放大成目录/前缀豁免；其余单测文件全部在扫描范围内。
        if (r === 'tests/unit/data-dir.test.js') continue;
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const cur = lines[i].trim();
          if (!cur || cur.startsWith('//') || cur.startsWith('*') || cur.startsWith('/*')) continue;
          const nxt = (lines[i + 1] || '').trim();
          const nextIsComment = !nxt || nxt.startsWith('//') || nxt.startsWith('*') || nxt.startsWith('/*');
          const windowText = lines[i] + (nextIsComment ? '' : ' ' + (lines[i + 1] || ''));
          // 精确形：path.join(os.homedir(), '.multi-proxy-manager', ...)。
          // 不用「同现即命中」——守卫自己就持有这个词表，会把自身判成违规（第一跑实测踩过）。
          if (/os\.homedir\(\)\s*,\s*['"]\.multi-proxy-manager['"]/.test(windowText)) {
            found.push(r);
            break;
          }
        }
      }
    };
    walk(base, 'tests/unit');
    return found.sort();
  }

  it('单测断言生产默认路径时一律走 lib/data-dir.js 真源', () => {
    expect(scanTestAssumptions()).toEqual([]);
  });

  it('守卫本身能抓到注入（否则是假绿）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dd-assert-'));
    try {
      fs.mkdirSync(path.join(tmp, 'tests', 'unit'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tests', 'unit', 'probe.test.js'),
        "expect(X).toBe(path.join(os.homedir(), '.multi-proxy-manager', 'x.json'));\n");
      expect(scanTestAssumptions(tmp)).toEqual(['tests/unit/probe.test.js']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    expect(scanTestAssumptions()).toEqual([]);
  });
});
