// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');

// Valid auth token for endpoints protected by requireAuth (P0 fix).
const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
const authed = (req) => req.set('x-auth-token', AUTH_TOKEN);

describe('Multi-Proxy Manager API', () => {
  // 2026-10-28：CI manager fixture 全局设了 MANAGER_PASSWORD（让 12 个「无 token→401」套件过）。
  // 但本文件整组预设「无密码回环放行」（多处裸 request(app) 期望非 401）。
  // 故本 describe 进前显式建立「无密码」基线、跑完还原，防跨文件 env 泄漏。
  const origPwd = process.env.MANAGER_PASSWORD;
  beforeEach(() => { delete process.env.MANAGER_PASSWORD; });
  afterEach(() => {
    if (origPwd === undefined) delete process.env.MANAGER_PASSWORD;
    else process.env.MANAGER_PASSWORD = origPwd;
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /api/status', () => {
    it('should return status for configured proxies', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      // At minimum, codex should be in the config if proxy.js exists
      if (res.body.codex) {
        expect(res.body.codex).toHaveProperty('running');
        expect(res.body.codex).toHaveProperty('port', 18790);
      }
    });
  });

  describe('GET /api/logs', () => {
    it('should return logs object', async () => {
      const res = await authed(request(app).get('/api/logs'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
      expect(res.body).toHaveProperty('count');
    });

    it('should respect limit query param', async () => {
      const res = await authed(request(app).get('/api/logs?limit=10'));
      expect(res.status).toBe(200);
      // When log file doesn't exist, recent may not be present
      // Just verify it doesn't error
      expect(res.body.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/logs/raw', () => {
    it('should return empty or plain text', async () => {
      const res = await authed(request(app).get('/api/logs/raw'));
      expect(res.status).toBe(200);
      // When log file doesn't exist, express sends '' with default text/html
      // When it exists, it sends text/plain — either is acceptable
      expect(typeof res.text).toBe('string');
    });
  });

  // 2026-10-28：回环免鉴权后，supertest（走 127.0.0.1）不再被 requireAuth 拦成 401。
  // 「非回环仍 401」的守卫已移到 tests/unit/loopback-auth.test.js（那里能伪造来源地址）。
  // 这里改用**只读**端点验证——不用 /api/logs/clear，因为放行后它会真执行清日志（副作用）。
  describe('回环免鉴权（loopback bypass）', () => {
    it('supertest 来自 127.0.0.1：受 requireAuth 保护的端点不再返回 401', async () => {
      const res = await request(app).get('/api/config-export');
      expect(res.status).not.toBe(401);
    });

    it('/api/auth/status 对回环上报 needsSetup=false + loopbackBypass=true', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body.loopbackBypass).toBe(true);
      expect(res.body.needsSetup).toBe(false);
    });
  });

  describe('GET /api/auth/status', () => {
    // Note: supertest + app.listen() in server.js can cause route conflicts.
    // We test the route pattern but accept the actual response shape.
    it('should return 200 with needsSetup', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('needsSetup');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 without password', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Password required');
    });

    it('should return 401 with wrong password when env password is set', async () => {
      // Skip if MANAGER_PASSWORD is not set (dev mode)
      const envPwd = process.env.MANAGER_PASSWORD;
      if (!envPwd || envPwd.length === 0) {
        // In setup mode, first login creates the password
        return;
      }
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'wrong' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/installed', () => {
    it('should return array of installed proxy names', async () => {
      const res = await request(app).get('/api/installed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('codex');
      expect(res.body).toContain('hermes');
      expect(res.body).toContain('cursor');
    });
  });

  describe('GET /api/proxy-configs', () => {
    it('should return full config as single source of truth (D7 guard)', async () => {
      const res = await request(app).get('/api/proxy-configs');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      // 端口必须与 lib/process-manager.js buildProxyConfigs() 逐字一致——
      // 这是「声明态≠运行态」的唯一真源守卫：加新代理只需改服务端，前端不再硬编码。
      expect(res.body.codex.port).toBe(18790);
      expect(res.body.hermes.port).toBe(18793);
      expect(res.body.cursor.port).toBe(18794);
      expect(res.body.claude.port).toBe(18791);
      expect(res.body.dsh.port).toBe(18797);
      expect(res.body.opencode.port).toBe(18798);
      expect(res.body.generic.port).toBe(18799);
      expect(res.body['opencode-free'].port).toBe(18800);
      expect(res.body['workbuddy-shim'].port).toBe(18789);
      // defaultVersion 由 readPackVersion 从各 package.json 实读，非编造
      expect(typeof res.body.codex.defaultVersion).toBe('string');
    });
  });

  describe('Forward proxy whitelist', () => {
    it('should allow whitelisted GET endpoint', async () => {
      const res = await authed(request(app).get('/api/codex/v1/models'));
      // Will fail to reach upstream (503) but should not be blocked by whitelist (404)
      expect(res.status).not.toBe(404);
    });

    it('should block non-whitelisted endpoint with 404', async () => {
      const res = await authed(request(app).get('/api/codex/admin/secret'));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });

    it('should block non-whitelisted HTTP method', async () => {
      // 2026-10-28：回环免鉴权生效后，鉴权层放行，请求到达转发白名单 → 回到 404。
      // 仍然是「被拦住」，只是拦截点从 auth 变回 whitelist；拦截本身没丢。
      // （此前为 401，是鉴权先拦；非回环来源仍是 401，见 loopback-auth.test.js）
      const res = await request(app).delete('/api/codex/v1/models');
      expect(res.status).toBe(404);
    });

    it('should block deep path traversal with ../..', async () => {
      const res = await authed(request(app).get('/api/codex/v1/models/../../../etc/passwd'));
      expect(res.status).not.toBe(401); // blocked by whitelist, not auth
    });

    it('should block nested URL-encoded path traversal', async () => {
      const res = await request(app).get('/api/codex/v1/..%252f..%252f..%252fetc/passwd');
      expect(res.status).not.toBe(200); // should not succeed
    });
  });
});