// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// jest test for createMinPrivilegePolicy（动作级最小权限引擎 · P1-27 ③ 纯函数层）
//
// 钉死 ③ 的「role 表 + actionAllowlist + default-deny 判序 + 不可逆挂人工确认」四条，
// 证明它可作为 SideEffectGuard.gate 的 drop-in（gate(toolName, session, record) => { blocked, reason }）。
// 全部零副作用，可离线跑（无盘 / 无网络 / 无审计写）。

const {
    createMinPrivilegePolicy,
    matchAction,
    DEFAULT_IRREVERSIBLE,
} = require('../../lib/min-privilege');

// 测试用角色：窄化不可逆集合，免得每个用例都撞默认不可逆表
function mkPolicy(overrides = {}) {
    return createMinPrivilegePolicy({
        roles: {
            observer: { actions: ['read:*'], requireConfirm: [] },
            editor: { actions: ['read:*', 'write:*'], requireConfirm: ['write:publish'] },
            admin: { actions: ['*'], requireConfirm: ['delete:*', 'refund'] },
        },
        irreversible: ['delete:*', 'refund', 'write:publish'],
        roleMap: { 'agent:coding-1': 'editor', 'agent:root-0': 'admin' },
        policyVersion: 'test',
        ...overrides,
    });
}

describe('matchAction', () => {
    test('exact / prefix-glob / star', () => {
        expect(matchAction('read:order', 'read:order')).toBe(true);
        expect(matchAction('read:*', 'read:order')).toBe(true);
        expect(matchAction('read:*', 'read:anything')).toBe(true);
        expect(matchAction('read:*', 'write:order')).toBe(false);
        expect(matchAction('*', 'delete:order')).toBe(true);
        expect(matchAction('read:order', 'read:other')).toBe(false);
    });
});

describe('createMinPrivilegePolicy · default-deny 判序', () => {
    test('① 解析不出角色 → 拒（fail-closed）', () => {
        const p = mkPolicy();
        const g = p.gate('read:order', null, { action: 'read:order' }); // 无 role 无 actor
        expect(g.blocked).toBe(true);
        expect(g.reason).toBe('policy:role-unresolved(default-deny)');
    });

    test('defaultRole 兜底（可选，缺省 null 即 default-deny）', () => {
        const p = mkPolicy({ defaultRole: 'observer' });
        const ok = p.gate('read:order', null, {});
        const no = p.gate('write:order', null, {});
        expect(ok.blocked).toBe(false);
        expect(no.blocked).toBe(true);
        expect(no.reason).toBe('policy:action-not-allowed(observer:write:order)');
    });

    test('② allowlist 命中 / 不命中', () => {
        const p = mkPolicy();
        expect(p.gate('read:order', null, { role: 'observer' }).blocked).toBe(false);
        const g = p.gate('write:order', null, { role: 'observer' });
        expect(g.blocked).toBe(true);
        expect(g.reason).toBe('policy:action-not-allowed(observer:write:order)');
    });

    test('③ 可逆动作过 allowlist 即放行（editor write:order 不在 requireConfirm）', () => {
        const p = mkPolicy();
        expect(p.gate('write:order', null, { role: 'editor' }).blocked).toBe(false);
    });

    test('③ 不可逆 + requireConfirm 命中且未签核 → 拒（挂人工）', () => {
        const p = mkPolicy();
        const g = p.gate('write:publish', null, { role: 'editor' });
        expect(g.blocked).toBe(true);
        expect(g.reason).toBe('policy:irreversible-needs-confirm(editor:write:publish)');
    });

    test('③ 签核落地后放行（record.confirmedBy 或 session.confirmedBy）', () => {
        const p = mkPolicy();
        expect(p.gate('write:publish', null, { role: 'editor', confirmedBy: 'boss@x' }).blocked).toBe(false);
        expect(p.gate('write:publish', { confirmedBy: 'boss@x' }, { role: 'editor' }).blocked).toBe(false);
    });

    test('admin 通配 '*' 允许任意动作，但不可逆 delete:* / refund 须签核', () => {
        const p = mkPolicy();
        expect(p.gate('read:order', null, { role: 'admin' }).blocked).toBe(false);
        expect(p.gate('write:order', null, { role: 'admin' }).blocked).toBe(false);
        expect(p.gate('delete:order', null, { role: 'admin' }).blocked).toBe(true); // 未签核
        expect(p.gate('delete:order', null, { role: 'admin', confirmedBy: 'boss@x' }).blocked).toBe(false);
        expect(p.gate('refund', null, { role: 'admin', confirmedBy: 'boss@x' }).blocked).toBe(false);
    });

    test('① 角色解析：roleMap[actor] 命中 → 按该角色判（agent:coding-1 → editor）', () => {
        const p = mkPolicy();
        // editor：read ok，write:publish 需签核
        expect(p.gate('read:order', null, { actor: 'agent:coding-1' }).blocked).toBe(false);
        expect(p.gate('write:publish', null, { actor: 'agent:coding-1' }).blocked).toBe(true);
        // 显式 role 优先于 roleMap
        expect(p.gate('read:order', null, { role: 'observer', actor: 'agent:coding-1' }).blocked).toBe(false);
    });
});

describe('createMinPrivilegePolicy · 诊断 & 不变式', () => {
    test('isIrreversible 判动作类', () => {
        const p = mkPolicy();
        expect(p.isIrreversible('delete:order')).toBe(true);
        expect(p.isIrreversible('refund')).toBe(true);
        expect(p.isIrreversible('read:order')).toBe(false);
        expect(p.isIrreversible('write:order')).toBe(false);
    });

    test('explain 返回判序明细（被哪一步卡住）', () => {
        const p = mkPolicy();
        const miss = p.explain('write:order', { role: 'observer' });
        expect(miss.allowed).toBe(false);
        expect(miss.reason).toBe('policy:action-not-allowed(observer:write:order)');
        expect(miss.checks).toContain('allowlist:observer miss');
        const ok = p.explain('write:order', { role: 'editor' });
        expect(ok.allowed).toBe(true);
        expect(ok.checks).toContain('allowlist:editor ok');
    });

    test('gate 返回形状 == SideEffectGuard.gate 契约 { blocked, reason }', () => {
        const p = mkPolicy();
        for (const [toolName, ctx] of [
            ['read:order', { role: 'observer' }],
            ['delete:order', { role: 'admin' }],
            ['read:order', {}],
        ]) {
            const g = p.gate(toolName, null, ctx);
            expect(typeof g.blocked).toBe('boolean');
            expect(typeof g.reason).toBe('string');
        }
    });

    test('DEFAULT_IRREVERSIBLE 覆盖 buildDefaultRoles：admin 缺省自动含全部不可逆动作', () => {
        const p = createMinPrivilegePolicy({}); // 全默认
        expect(DEFAULT_IRREVERSIBLE).toContain('delete:*');
        expect(p.roles.admin.requireConfirm).toEqual(expect.arrayContaining(['delete:*', 'refund', 'publish']));
        // 默认 admin：delete:* 须签核
        expect(p.gate('delete:order', null, { role: 'admin' }).blocked).toBe(true);
        expect(p.gate('delete:order', null, { role: 'admin', confirmedBy: 'boss@x' }).blocked).toBe(false);
    });
});
