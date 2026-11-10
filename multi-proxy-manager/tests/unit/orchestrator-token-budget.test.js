// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 父子共享 token 预算单测（2026-11-06，外部对照总表 #123 候选核项 ② 二期）。
//
// 纪律（AGENTS.md §3 非侵入铁律）：opts.tokenBudget 不传 = 逐字零行为变更。
// 诚实边界：编排器只做「剩余读数 + 耗尽停发」，不承诺中途截断单个 agent 的 token
//（那是 executor 的职责）；并发 ready 的最后一批可能合计超支，下一轮才停发。

const path = require('path');
const L2 = path.join(__dirname, '../../../l2');
const { Orchestrator } = require(path.join(L2, 'orchestrator.js'));

const chain = (ids) => ({
    input: 'budget-demo', template: 'chain', edges: [],
    subtasks: ids.map((id, i) => ({
        id, type: 'code', complexity: 'low', prompt: id,
        deps: i ? [ids[i - 1]] : [],
    })),
});

const usage = (total) => ({
    usage: {
        prompt_tokens: Math.floor(total / 2),
        completion_tokens: total - Math.floor(total / 2),
        total_tokens: total,
    },
});

describe('orchestrator · 父子共享 token 预算（默认关）', () => {
    test('未传 tokenBudget：ctx 无 budget 字段，行为逐字一致', async () => {
        const seen = [];
        const orch = new Orchestrator({
            shadowMode: false,
            executor: async (st, ctx) => { seen.push(ctx.budget); return usage(10); },
        });
        const out = await orch.run(chain(['a', 'b']));
        expect(seen).toEqual([undefined, undefined]);
        expect(out.results.a.status).toBe('done');
        expect(out.results.b.status).toBe('done');
        expect(Object.keys(out).sort()).toEqual(['history', 'report', 'results']);
    });

    test('传 tokenBudget：每个子任务拿到「剩余」与 min(子欲, 父剩余)', async () => {
        const seen = [];
        const costs = { a: 60, b: 30 };
        const orch = new Orchestrator({
            shadowMode: false,
            executor: async (st, ctx) => {
                seen.push({ id: st.id, remaining: ctx.budget.remaining(), grant: ctx.budget.grant(50) });
                return usage(costs[st.id]);
            },
        });
        const out = await orch.run(chain(['a', 'b']), { tokenBudget: 100 });
        expect(seen).toEqual([
            { id: 'a', remaining: 100, grant: 50 },
            { id: 'b', remaining: 40, grant: 40 },
        ]);
        expect(out.results.a.status).toBe('done');
        expect(out.results.b.status).toBe('done');
    });

    test('预算耗尽：不再启动后续子任务，标 budgetExceeded；executor 不被调用', async () => {
        const called = [];
        const orch = new Orchestrator({
            shadowMode: false,
            executor: async (st) => { called.push(st.id); return usage(100); },
        });
        const out = await orch.run(chain(['a', 'b', 'c']), { tokenBudget: 100 });
        expect(called).toEqual(['a']);
        expect(out.results.a.status).toBe('done');
        expect(out.results.b.status).toBe('failed');
        expect(out.results.b.budgetExceeded).toBe(true);
        expect(out.results.c.status).toBe('skipped');
    });

    test('usage 挖不到：不记账、不假装 0，剩余保持原值', async () => {
        const seen = [];
        const orch = new Orchestrator({
            shadowMode: false,
            executor: async (st, ctx) => { seen.push(ctx.budget.remaining()); return { plain: true }; },
        });
        await orch.run(chain(['a', 'b']), { tokenBudget: 100 });
        expect(seen).toEqual([100, 100]);
    });
});
