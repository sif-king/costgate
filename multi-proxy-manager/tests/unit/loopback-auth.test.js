// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * 守卫：回环免鉴权（2026-10-28）
 *
 * 为什么需要这组测试：
 * 「回环放行」是放宽鉴权，方向危险。一旦被误改成「一律放行」，
 * BIND_HOST=0.0.0.0 的部署就会裸奔，而 fail-closed（bind-host-auth.test.js）
 * 只管「绑在哪」、管不了「谁进来」——那一侧不会红，只有这里会红。
 *
 * 因此本文件必须同时钉住两半：回环放行 + 非回环仍 401。
 * 缺任何一半，这条守卫就是残缺的。
 */
const {
  isLoopbackAddr,
  isLoopbackRequest,
  loopbackBypassActive,
  requireAuth,
} = require('../../lib/auth');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

describe('isLoopbackAddr（纯函数）', () => {
  it('回环形态一律判为 true', () => {
    expect(isLoopbackAddr('127.0.0.1')).toBe(true);
    expect(isLoopbackAddr('::1')).toBe(true);
    expect(isLoopbackAddr('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddr('localhost')).toBe(true);
    // 127.0.0.0/8 整段都是回环
    expect(isLoopbackAddr('127.5.5.5')).toBe(true);
  });

  it('非回环一律判为 false（含空值，防 undefined 误判成回环）', () => {
    expect(isLoopbackAddr('192.168.1.5')).toBe(false);
    expect(isLoopbackAddr('10.0.0.3')).toBe(false);
    expect(isLoopbackAddr('8.8.8.8')).toBe(false);
    expect(isLoopbackAddr('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddr(undefined)).toBe(false);
    expect(isLoopbackAddr(null)).toBe(false);
    expect(isLoopbackAddr('')).toBe(false);
  });
});

describe('isLoopbackRequest 取地址来源', () => {
  it('优先用 req.socket.remoteAddress（真实 TCP 对端，不可伪造）', () => {
    // 即便 req.ip 被写成公网地址，也应以 socket 为准
    const req = { socket: { remoteAddress: '127.0.0.1' }, ip: '8.8.8.8' };
    expect(isLoopbackRequest(req)).toBe(true);
  });

  it('socket 缺失时回退 req.ip', () => {
    expect(isLoopbackRequest({ ip: '127.0.0.1' })).toBe(true);
    expect(isLoopbackRequest({ ip: '8.8.8.8' })).toBe(false);
  });
});

describe('requireAuth 回环放行（放宽的一半）', () => {
  // 2026-10-28：CI manager fixture 设了 MANAGER_PASSWORD（让 12 个「无 token→401」套件过），
  // 故本 describe 显式建立「无密码」基线 + 跑完还原，保证「放宽一半」断言不受全局 env 干扰。
  const origPwd = process.env.MANAGER_PASSWORD;
  beforeEach(() => { delete process.env.MANAGER_PASSWORD; });
  afterEach(() => {
    if (origPwd === undefined) delete process.env.MANAGER_PASSWORD;
    else process.env.MANAGER_PASSWORD = origPwd;
  });
  it('回环请求不校验 token 直接放行，并标记 loopback', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const res = mockRes();
    let called = false;
    requireAuth(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(null);
    expect(req.auth && req.auth.loopback).toBe(true);
  });

  it('IPv6 回环同样放行', () => {
    const req = { socket: { remoteAddress: '::1' }, headers: {} };
    let called = false;
    requireAuth(req, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });
});

describe('requireAuth 非回环仍鉴权（收紧的一半 · 关键守卫）', () => {
  it('LAN 来源无 token → 401，不得放行', () => {
    const req = { socket: { remoteAddress: '192.168.1.5' }, headers: {} };
    const res = mockRes();
    let called = false;
    requireAuth(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('公网来源无 token → 401', () => {
    const req = { socket: { remoteAddress: '203.0.113.9' }, headers: {} };
    const res = mockRes();
    requireAuth(req, res, () => { throw new Error('不该放行'); });
    expect(res.statusCode).toBe(401);
  });

  it('非回环 + 伪造 X-Forwarded-For 为 127.0.0.1 → 仍 401（防头伪造绕过）', () => {
    // 这条钉死「回环判定只看真实 socket 地址」这一设计约束。
    // 若将来有人改成用 req.ip + trust proxy，本条会红。
    const req = {
      socket: { remoteAddress: '203.0.113.9' },
      ip: '127.0.0.1',                       // 模拟被 trust proxy 改写后的 req.ip
      headers: { 'x-forwarded-for': '127.0.0.1' },
    };
    const res = mockRes();
    requireAuth(req, res, () => { throw new Error('不该放行'); });
    expect(res.statusCode).toBe(401);
  });

  it('非回环 + 无效 token → 401', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.5' },
      headers: { 'x-auth-token': 'not-a-real-token' },
    };
    const res = mockRes();
    requireAuth(req, res, () => { throw new Error('不该放行'); });
    expect(res.statusCode).toBe(401);
  });
});

describe('loopbackBypassActive：放行只在「未配置鉴权」时成立（保留将来加账号体系的口子）', () => {
  const origEnv = process.env.MANAGER_PASSWORD;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MANAGER_PASSWORD;
    else process.env.MANAGER_PASSWORD = origEnv;
  });

  it('设了 MANAGER_PASSWORD 后，回环也不再放行', () => {
    process.env.MANAGER_PASSWORD = 'some-real-password';
    expect(loopbackBypassActive()).toBe(false);

    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const res = mockRes();
    requireAuth(req, res, () => { throw new Error('设了密码就不该放行'); });
    expect(res.statusCode).toBe(401);
  });

  it('未配置鉴权时，回环放行（默认态）', () => {
    delete process.env.MANAGER_PASSWORD;
    // 注意：若本机已存过密码文件，此断言会失效——那属于「用户已主动设密码」，
    // 此时不放行才是正确行为，故用「放行 ⇒ 一定没密码」的方向来钉：
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const res = mockRes();
    let called = false;
    requireAuth(req, res, () => { called = true; });
    // 放行与否则取决于本机是否已存密码，两者都合法；这里只钉「不变量」：
    expect(called === loopbackBypassActive()).toBe(true);
  });
});
