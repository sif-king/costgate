// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 动作级最小权限引擎（P1-27 ③「最小权限」纯函数层）
//
// 定位：给 SideEffectGuard 的 ① gate seam 喂一个「有策略的」gate，而不是裸
// `() => ({ blocked: false })`。本层只负责「判序 + 产出 { blocked, reason }」，
// 零副作用（不读盘 / 不网络 / 不写审计），因此可被 jest 单测全量钉死、可被
// 离线跑。
//
// 判序（default-deny，fail-closed）：
//   ① 解析角色：record.role → 命中 roles 表；否则 roleMap[record.actor]；都解析不出 → 拒
//   ② 动作在不在该角色 allowlist（支持 '*' 与 'prefix:*' 通配）→ 不在 → 拒
//   ③ 该角色 requireConfirm 命中此动作 且 未带人工签核（record.confirmedBy / session.confirmedBy）→ 拒（挂人工确认）
//   ④ 全过 → 放行
//
// 接线边界（本层「不做」、属底座 D2 需老板 signoff）：
//   - 把本 gate 接进 SideEffectGuard 的 gate seam、接真实写端点 routes、常驻
//   - actor→role 的解析策略（roleMap 由编排层喂入，本层只查表）
//   - 与 ② action-audit / ③ 不可逆 的人工确认 UI 联调
//
// 语义锚（对齐 58- 权限语义判据化 + 04 P1-27 ③ 原文「role 表 + actionAllowlist +
// default-deny 判序 + 不可逆动作挂人工确认」）：不可逆动作（delete:/refund/pay/
// publish）缺省进 requireConfirm，签核前一律 blocked，签核落地后放行。

const ACTION_CLASS = Object.freeze({
    REVERSIBLE: 'reversible',
    IRREVERSIBLE: 'irreversible',
});

// 缺省不可逆动作表（buildDefaultRoles 用来自动填 requireConfirm；也可被 opts.irreversible 覆盖）
const DEFAULT_IRREVERSIBLE = Object.freeze([
    'delete:*',
    'refund',
    'pay',
    'publish',
    'write:publish',
]);

// 缺省角色表（老板可整体或按名覆盖）：
//   actions       = 允许动作（'*' 全允许；'prefix:*' 通配该前缀）
//   requireConfirm = 该角色下须人工签核的动作（不可逆动作缺省进这里）
function buildDefaultRoles(overrides) {
    const base = {
        observer: { actions: ['read:*'], requireConfirm: [] },
        editor: { actions: ['read:*', 'write:*'], requireConfirm: ['write:publish'] },
        admin: { actions: ['*'], requireConfirm: [] },
    };
    const out = {};
    for (const name of Object.keys(base)) {
        out[name] = {
            actions: base[name].actions.slice(),
            requireConfirm: base[name].requireConfirm.slice(),
        };
    }
    // admin 缺省把不可逆动作全进 requireConfirm（buildDefaultRoles 自动补，除非被覆盖）
    if (!overrides || !overrides.admin || !(overrides.admin.requireConfirm && overrides.admin.requireConfirm.length)) {
        out.admin.requireConfirm = DEFAULT_IRREVERSIBLE.slice();
    }
    for (const name of Object.keys(overrides || {})) {
        out[name] = {
            actions: ((overrides || {})[name].actions || []).slice(),
            requireConfirm: ((overrides || {})[name].requireConfirm || []).slice(),
        };
    }
    return out;
}

// 通配匹配：'x' 精确；'prefix:*' 匹配 'prefix:' 前缀；'*' 匹配一切
function matchAction(pattern, action) {
    if (pattern === '*' || pattern === action) return true;
    if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1); // 保留 'prefix:' 形态
        return action.startsWith(prefix);
    }
    return false;
}

// createMinPrivilegePolicy(opts?) -> { gate, resolveRole, isIrreversible, explain, roles, irreversible, policyVersion }
//
// opts:
//   roles:        { [name]: { actions: string[], requireConfirm: string[] } }  覆盖/补角色
//   irreversible: string[]      覆盖不可逆动作表（缺省 DEFAULT_IRREVERSIBLE）
//   roleMap:      { [actorId]: role }  actor→role 查表（编排层喂入）
//   defaultRole:  string|null   解析不出 role 时兜底（缺省 null＝default-deny，fail-closed）
//   policyVersion: string       版本锚（对账/审计用）
function createMinPrivilegePolicy(opts = {}) {
    const irreversible = Object.freeze((opts.irreversible || DEFAULT_IRREVERSIBLE).slice());
    const roles = Object.freeze(
        Object.fromEntries(
            Object.entries(buildDefaultRoles(opts.roles)).map(([k, v]) => [k, Object.freeze({
                actions: Object.freeze(v.actions),
                requireConfirm: Object.freeze(v.requireConfirm),
            })]),
        ),
    );
    const roleMap = Object.freeze({ ...(opts.roleMap || {}) });
    const defaultRole = opts.defaultRole != null ? opts.defaultRole : null;

    function resolveRole(ctx) {
        if (ctx && ctx.role && Object.prototype.hasOwnProperty.call(roles, ctx.role)) return ctx.role;
        if (ctx && ctx.actor && Object.prototype.hasOwnProperty.call(roleMap, ctx.actor)) return roleMap[ctx.actor];
        return defaultRole; // null = default-deny
    }

    function isIrreversible(action) {
        return irreversible.some((pat) => matchAction(pat, action));
    }

    // drop-in gate：签名严格对齐 SideEffectGuard.gate(toolName, session, record)
    function gate(toolName, session, record) {
        const ctx = record || {};
        const role = resolveRole(ctx);
        if (!role) {
            return { blocked: true, reason: 'policy:role-unresolved(default-deny)' };
        }
        const pol = roles[role];
        if (!pol.actions.some((pat) => matchAction(pat, toolName))) {
            return { blocked: true, reason: `policy:action-not-allowed(${role}:${toolName})` };
        }
        const needsConfirm = pol.requireConfirm.some((pat) => matchAction(pat, toolName));
        if (needsConfirm) {
            const confirmed = !!(ctx.confirmedBy || (session && session.confirmedBy));
            if (!confirmed) {
                return { blocked: true, reason: `policy:irreversible-needs-confirm(${role}:${toolName})` };
            }
        }
        return { blocked: false, reason: '' };
    }

    // 诊断用：跑同一套判序，返回被哪一步卡住（非门控，给审计/对账/单测看）
    function explain(toolName, ctx) {
        const role = resolveRole(ctx || {});
        const checks = [];
        if (!role) {
            return { toolName, role: null, allowed: false, reason: 'policy:role-unresolved(default-deny)', checks: checks.concat('role-unresolved') };
        }
        const pol = roles[role];
        const allowedByRole = pol.actions.some((pat) => matchAction(pat, toolName));
        checks.push(allowedByRole ? `allowlist:${role} ok` : `allowlist:${role} miss`);
        const needsConfirm = pol.requireConfirm.some((pat) => matchAction(pat, toolName));
        if (needsConfirm) {
            const confirmed = !!(ctx && ctx.confirmedBy);
            checks.push(confirmed ? 'confirm:ok' : 'confirm:missing');
        }
        const allowed = allowedByRole && (!needsConfirm || !!(ctx && ctx.confirmedBy));
        let reason = '';
        if (!allowed) {
            reason = !allowedByRole
                ? `policy:action-not-allowed(${role}:${toolName})`
                : `policy:irreversible-needs-confirm(${role}:${toolName})`;
        }
        return { toolName, role, allowed, reason, checks, irreversible: isIrreversible(toolName) };
    }

    return Object.freeze({
        gate,
        resolveRole,
        isIrreversible,
        explain,
        roles,
        irreversible,
        defaultRole,
        actionClass: ACTION_CLASS,
        policyVersion: opts.policyVersion || 'p1-27-min-priv-0.1',
    });
}

module.exports = { createMinPrivilegePolicy, matchAction, buildDefaultRoles, DEFAULT_IRREVERSIBLE, ACTION_CLASS };
