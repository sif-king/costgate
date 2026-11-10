// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ==================== 配置导出 /api/config-export ====================
// 2026-10-24：设置页那个「导出配置」按钮原本 href="/#/api/config-export"，
// 全仓无此路由，点了什么都不发生。做真之后有两条必须钉住的线：
//   1. 安全线：providers.json 里带 provider 凭据，导出件**不许**含可用 key。
//      这是本文件最主要的存在理由——导出功能做成泄密通道比不做更糟。
//   2. 鉴权线：必须 requireAuth，匿名 401。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const metaRoutes = require('../../routes/meta');

const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
const mask = metaRoutes._maskSecrets;

describe('配置导出脱敏（安全相关）', () => {
    it('按字段名脱敏常见凭据字段', () => {
        const hits = [];
        const out = mask({
            name: 'deepseek',
            apiKey: 'sk-abcdefghijklmnop',
            baseUrl: 'https://api.deepseek.com',
            models: [{ id: 'x', token: 'tok-123' }],
        }, hits, '');
        expect(out.apiKey).toBe('<REDACTED>');
        expect(out.models[0].token).toBe('<REDACTED>');
        expect(hits.sort()).toEqual(['apiKey', 'models[0].token'].sort());
        // 非凭据字段原样保留，不然导出件就没用了
        expect(out.name).toBe('deepseek');
        expect(out.baseUrl).toBe('https://api.deepseek.com');
    });

    it('嵌套与数组都覆盖（漏一层就等于漏 key）', () => {
        const hits = [];
        const out = mask({
            providers: [
                { id: 'a', config: { secret: 's1', nested: { password: 'p1' } } },
                { id: 'b', authorization: 'Bearer xxx' },
            ],
        }, hits, '');
        expect(out.providers[0].config.secret).toBe('<REDACTED>');
        expect(out.providers[0].config.nested.password).toBe('<REDACTED>');
        expect(out.providers[1].authorization).toBe('<REDACTED>');
        expect(out.providers[0].id).toBe('a');
    });

    it('空值不算脱敏命中（否则 redactedFields 会虚报）', () => {
        const hits = [];
        const out = mask({ apiKey: '' }, hits, '');
        expect(out.apiKey).toBe('');
        expect(hits).toEqual([]);
    });

    it('自定义格式的 key 也靠字段名挡住（正则认不出的那种）', () => {
        // 反例：这个 key 不长得像 sk-xxx，正则脱敏会漏，字段名脱敏必须拦住
        const hits = [];
        const out = mask({ apiKey: 'my-custom-provider-token-2024' }, hits, '');
        expect(out.apiKey).toBe('<REDACTED>');
        expect(hits).toEqual(['apiKey']);
    });
});

describe('GET /api/config-export', () => {
    it('未授权 → 401（导出件不能匿名拿到）', async () => {
        const res = await request(app).get('/api/config-export');
        expect(res.status).toBe(401);
    });

    it('授权后返回结构完整，且声明了脱敏口径', async () => {
        const res = await request(app).get('/api/config-export').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('exportedAt');
        expect(res.body).toHaveProperty('files');
        expect(res.body).toHaveProperty('redactedFields');
        expect(Array.isArray(res.body.redactedFields)).toBe(true);
        expect(res.body.note).toMatch(/脱敏/);
    });
});
