// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// M1 DAG 健康依赖图 —— lib/health.js 归一化 + 持久化单元测试。
// 覆盖：
//    - 三套 /health 契约归一化（codex 'healthy' / cursor 'ok' / degraded / 拉取失败 down）
//    - faultSignal 强制降级 overall
//    - 健康历史持久化（jsonl 追加、读取倒序、limit、容错坏行）
//    - /api/health-history 端点空态
const fs = require('fs');
const path = require('path');
const os = require('os');

const health = require('../../lib/health');

function normalize(raw, opts) {
  return health.normalizeProxyHealth('codex', raw, opts);
}

describe('M1 lib/health normalizeProxyHealth', () => {
  it('codex healthy → ok', () => {
    const r = normalize({ status: 'healthy', checks: { process: true, config: true }, reasons: [] });
    expect(r.status).toBe('ok');
    expect(r.overall).toBe('ok');
    expect(r.checks.process).toBe(true);
  });

  it('cursor ok → ok', () => {
    const r = normalize({ status: 'ok', checks: { process: true }, reasons: [] });
    expect(r.status).toBe('ok');
    expect(r.overall).toBe('ok');
  });

  it('degraded passes through with reasons', () => {
    const r = normalize({ status: 'degraded', checks: { process: true, config: false }, reasons: ['better-sqlite3 native module 缺失'] });
    expect(r.status).toBe('degraded');
    expect(r.overall).toBe('degraded');
    expect(r.reasons[0]).toContain('better-sqlite3');
    expect(r.checks.config).toBe(false);
  });

  it('null raw → down with reason', () => {
    const r = normalize(null);
    expect(r.status).toBe('down');
    expect(r.overall).toBe('down');
    expect(r.reasons[0]).toMatch(/未运行|不响应/);
  });

  it('faultSignal forces overall=down even if raw is ok', () => {
    const r = normalize({ status: 'ok', checks: { process: true } }, { faultSignal: true });
    expect(r.status).toBe('ok');        // 原始 status 保留
    expect(r.overall).toBe('down');     // 但 overall 被 fault 拉低
    expect(r.reasons.some(s => /熔断/.test(s))).toBe(true);
  });

  it('missing checks.process → overall down', () => {
    const r = normalize({ status: 'ok', checks: {} });
    expect(r.overall).toBe('down');
  });
});

describe('M1 lib/health 持久化', () => {
  let tmpFile;
  let origHome;

  beforeEach(() => {
    origHome = process.env.HOME;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-health-'));
    tmpFile = path.join(tmpDir, 'health-history.jsonl');
    health.setHistoryFile(tmpFile);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (tmpFile && fs.existsSync(path.dirname(tmpFile))) {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    }
  });

  it('persistHealthHistory appends a JSONL line', () => {
    health.persistHealthHistory({ ts: new Date().toISOString(), proxy: 'codex', status: 'ok', overall: 'ok', checks: {}, reasons: [] });
    const content = fs.readFileSync(tmpFile, 'utf8');
    expect(content.split('\n').filter(l => l.trim()).length).toBe(1);
    const parsed = JSON.parse(content.trim());
    expect(parsed.proxy).toBe('codex');
    expect(parsed.overall).toBe('ok');
  });

  it('readRecentHealth returns entries in reverse order', () => {
    health.persistHealthHistory({ proxy: 'codex', status: 'ok' });
    health.persistHealthHistory({ proxy: 'hermes', status: 'degraded' });
    const recent = health.readRecentHealth(10);
    expect(recent.length).toBe(2);
    expect(recent[0].proxy).toBe('hermes'); // 倒序：最新在前
    expect(recent[1].proxy).toBe('codex');
  });

  it('readRecentHealth respects limit and ignores corrupt lines', () => {
    health.persistHealthHistory({ proxy: 'codex', status: 'ok' });
    health.persistHealthHistory({ proxy: 'hermes', status: 'degraded' });
    fs.appendFileSync(tmpFile, 'this is not json\n');
    health.persistHealthHistory({ proxy: 'cursor', status: 'ok' });
    const recent = health.readRecentHealth(1);
    expect(recent.length).toBe(1);
    expect(recent[0].proxy).toBe('cursor');
  });

  it('trimHistory 裁剪后行数落在 [MAX, MAX+500] 区间（计数触发式，同 logger.js）', () => {
     // 写入 MAX+550 行，触发点在 500/1000/1500/2000/2500；
     // 仅当某触发点处行数 > MAX 时才裁剪 → 保留最后 MAX 行，落在 [MAX, MAX+500]。
    const total = health.MAX_HISTORY_LINES + 550;
    for (let i = 0; i < total; i++) {
      health.persistHealthHistory({ proxy: 'codex', n: i });
     }
    const recent = health.readRecentHealth(health.MAX_HISTORY_LINES + 500);
    expect(recent.length).toBeGreaterThan(health.MAX_HISTORY_LINES - 1);
    expect(recent.length).toBeLessThanOrEqual(health.MAX_HISTORY_LINES + 500);
     // 最新在前 → n 最大
    expect(recent[0].n).toBe(total - 1);
     // 早期条目已被裁掉（n=0..~499 不应还在）
    expect(recent[recent.length - 1].n).toBeGreaterThan(400);
   });
});

describe('M1 /api/health-history 端点', () => {
  // 这条要按「加载成本」给时间，不是按业务逻辑给时间。
  // 它故意 jest.resetModules() 后重新 require 整个路由图，实测这台机器上
  // require('routes/meta') 单独就要 3.5–8.6 秒（require('jsonwebtoken') 自己
  // 2.4 秒，正常机器是百毫秒级——本机沙箱对每个文件 open 都加开销）。
  // 默认 30 秒在整仓并发跑时会被冲破，报成「端点超时」，而端点本身只要 15ms。
  // 2026-11-08 实测：默认超时下红 / --testTimeout=120000 下 12/12 全绿。
  // 断言没变松，只是不让加载耗时冒充业务失败。
  it('returns { history: [] } when empty', async () => {
    const request = require('supertest');
    const express = require('express');
    const origHome = process.env.HOME;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-hist-'));
    process.env.HOME = tmpDir;
    jest.resetModules();
    const metaRouter = require('../../routes/meta');
    // meta.js 在加载时已绑定 os.homedir() 缓存到 HEALTH_HISTORY_FILE，
    // 但 persist/read 走 setHistoryFile，故这里指向 tmp 保证空读。
    const metaHealth = require('../../lib/health');
    metaHealth.setHistoryFile(path.join(tmpDir, 'health-history.jsonl'));
    const standalone = express();
    standalone.use('/api', metaRouter);
    const res = await request(standalone).get('/api/health-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
    expect(res.body.history.length).toBe(0);
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 60000);
});

describe('M1 /api/readyz 就绪探针（真实就绪契约）', () => {
  it('返回就绪结构（代理未起时为 degraded 但仍 200）', async () => {
    const request = require('supertest');
    const express = require('express');
    jest.resetModules();
    const metaRouter = require('../../routes/meta');
    const standalone = express();
    standalone.use('/api', metaRouter);
    const res = await request(standalone).get('/api/readyz');
    expect([200, 503]).toContain(res.status);
    expect(['ready', 'degraded', 'not-ready']).toContain(res.body.status);
    expect(Array.isArray(res.body.proxies.details)).toBe(true);
    expect(res.body.proxies.total).toBeGreaterThan(0);
    // 「状态带原因」是这一层存在的理由：只说 down，用户分不清「没启动」和
    // 「起来了但卡住」，这两种处置完全相反。所以：
    //   reachable=true  → reason 必须是 null（有值就说明在替正常状态编原因）
    //   reachable=false → reason 必须是非空字符串（不许只丢一个 down 了事）
    res.body.proxies.details.forEach((d) => {
      expect(Object.prototype.hasOwnProperty.call(d, 'reason')).toBe(true);
      if (d.reachable) {
        expect(d.reason).toBeNull();
      } else {
        expect(typeof d.reason).toBe('string');
        expect(d.reason.length).toBeGreaterThan(0);
      }
    });
    // 🔴 显式放宽到 60s（2026-11-09）：这条用例的时间不花在探测上——实测 9 个端口并发
    //    探测一共 7ms，而 `jest.resetModules()` + require routes/meta 的加载链要十几秒。
    //    全量 -w 2 并发跑时这个加载成本被进一步放大，于是撞上 jest 默认的 30s 上限并报
    //    「Exceeded timeout」——单跑 12/12 全绿，全量里红，典型的并发假红。
    //    与同文件其他用例（health-history 那条也是 60000）保持一致。
  }, 60000);
});
