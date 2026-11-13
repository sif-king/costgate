// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 运行时数据目录：零行为变更 + 漂移守卫。
// 🔴 基线是「截至 2026-11-13 的观测快照」，不是目标值：Phase 1 每收口一个模块，
//    就从 BASELINE 里删掉一项（或减计数），测试会红着逼你更新——这是进度条，不是永久规则。
//    别把这里的数字抄进长期文档，用前实查本文件。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { DATA_DIR_BASENAME, resolveDataDir, dataFile } = require('../../lib/data-dir');

describe('data-dir 单一真源 · 缺省零行为变更', () => {
  const saved = process.env.MP_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.MP_DATA_DIR;
    else process.env.MP_DATA_DIR = saved;
  });

  it('缺省仍是旧目录（Phase 1 未拍板，不得偷偷切）', () => {
    delete process.env.MP_DATA_DIR;
    expect(DATA_DIR_BASENAME).toBe('.multi-proxy-manager');
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.multi-proxy-manager'));
  });

  it('MP_DATA_DIR 覆盖优先，且不缓存（每次调用读 env）', () => {
    delete process.env.MP_DATA_DIR;
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.multi-proxy-manager'));
    process.env.MP_DATA_DIR = '/tmp/cg-override';
    expect(resolveDataDir()).toBe('/tmp/cg-override');
    expect(dataFile('password')).toBe(path.join('/tmp/cg-override', 'password'));
  });

  it('opts.dir 显式注入优先于 env', () => {
    process.env.MP_DATA_DIR = '/tmp/cg-override';
    expect(resolveDataDir({ dir: '/tmp/cg-injected' })).toBe('/tmp/cg-injected');
  });

  it('opts.home="" 保留干净 HOME 语义（相对路径，供 consent/session-store 收口）', () => {
    delete process.env.MP_DATA_DIR;
    expect(resolveDataDir({ home: '' })).toBe('.multi-proxy-manager');
    expect(resolveDataDir({ home: '/tmp/cg-home' })).toBe(path.join('/tmp/cg-home', '.multi-proxy-manager'));
  });

  it('dataFile 拼文件名', () => {
    delete process.env.MP_DATA_DIR;
    expect(dataFile('agent-token')).toBe(path.join(os.homedir(), '.multi-proxy-manager', 'agent-token'));
  });
});

describe('数据目录漂移守卫', () => {
  // 当前硬写快照（非注释代码行计数）。auth.js 已收口到 lib/data-dir.js，故不在表内。
  // lib/migrate.js 的 OLD_DATA_DIR 常量、lib/error-patterns.js 的错误提示文本属合法保留。
  const BASELINE = {
    'lib/data-dir.js': 1, // 单一真源本身，合法
    'lib/action-audit.js': 1,
    'lib/consent.js': 3,
    'lib/context-store.js': 1,
    'lib/cost-track.js': 2,
    'lib/error-patterns.js': 3,
    'lib/health.js': 1,
    'lib/logger.js': 1,
    'lib/migrate.js': 1,
    'lib/process-manager.js': 1,
    'lib/provider-health.js': 1,
    'lib/provider-isolation-executor.js': 1,
    'lib/session-store.js': 1,
    'lib/worktree-manager.js': 1,
    'routes/budget.js': 1,
    'routes/free-llm-plugin.js': 1,
    'routes/meta.js': 1,
    'routes/side-effect-guard.js': 1,
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
    // 功能级注入验证：在临时树里造一个含硬写的新模块，scan 必须真的把它扫出来。
    // 不往项目 lib/ 写文件，避免并行套件读到半成品。
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
