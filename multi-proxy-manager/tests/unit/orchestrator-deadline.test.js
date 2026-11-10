// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// 编排层 deadline 单测（2026-11-06，外部对照总表 #123 候选核项 ② 实施）。
//
// 复现的故障：`orchestrator.js:105` 的 `Promise.all` 与 `:260` 的 `await executor`
// 没有超时包裹，一个不返回的 executor 会让整个 run 永不收敛（while 卡在 processed < total）。
//
// 纪律（AGENTS.md §3 非侵入铁律）：deadlineMs 不传 = 逐字零行为变更。
// 所有「永不 resolve」的用例都套外层 guard，避免把 jest 挂死。

const path = require('path');
const L2 = path.join(__dirname, '../../../l2');
const { Orchestrator } = require(path.join(L2, 'orchestrator.js'));

const dagOne = { edges: [], subtasks: [{ id: 'a', type: 'code', complexity: 'low', prompt: 'p', deps: [] }] };

// 外层守卫：run 不收敛时让测试 fail，而不是把 runner 卡住
function withGuard(promise, ms = 800) {
    let timer;
    const guard = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`run did not converge within ${ms}ms`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

describe('orchestrator · 编排层 deadline（默认关）', () => {
    test('未传 deadlineMs：行为与既有逐字一致', async () => {
        const orch = new Orchestrator({ executor: async () => ({ ok: true }), shadowMode: false });
        const out = await orch.run(dagOne);
        expect(out.results.a.status).toBe('done');
        expect(Object.keys(out).sort()).toEqual(['history', 'report', 'results']);
    });

    test('🔴 复现：永不返回的 executor 不能让 run 挂死', async () => {
        const orch = new Orchestrator({ executor: () => new Promise(() => {}), shadowMode: false });
        const out = await withGuard(orch.run(dagOne, { deadlineMs: 60 }));
        expect(out.results.a.status).toBe('failed');
        expect(out.results.a.timedOut).toBe(true);
    });

    test('deadline 是整 run 的绝对时刻，并发子任务共享', async () => {
        const dag = {
            edges: [],
            subtasks: [
                { id: 'fast', type: 'code', complexity: 'low', prompt: 'p', deps: [] },
                { id: 'slow', type: 'code', complexity: 'low', prompt: 'p', deps: [] },
            ],
        };
        const executor = async (st) => (st.id === 'slow' ? new Promise(() => {}) : { ok: true });
        const orch = new Orchestrator({ executor, shadowMode: false });
        const out = await withGuard(orch.run(dag, { deadlineMs: 60 }));
        expect(out.results.fast.status).toBe('done');
        expect(out.results.slow.status).toBe('failed');
        expect(out.results.slow.timedOut).toBe(true);
    });

    test('超时不走重试/fallback，不把剩余预算耗在注定失败的重试上', async () => {
        let calls = 0;
        const dag = {
            edges: [],
            subtasks: [
                { id: 'a', type: 'code', complexity: 'low', prompt: 'p', deps: [], retry: 3, fallback: 'fb' },
                { id: 'fb', type: 'code', complexity: 'low', prompt: 'p', deps: ['a'] },
            ],
        };
        const executor = async () => { calls += 1; return new Promise(() => {}); };
        const orch = new Orchestrator({ executor, shadowMode: false });
        const out = await withGuard(orch.run(dag, { deadlineMs: 60 }));
        expect(calls).toBe(1);
        expect(out.results.a.status).toBe('failed');
        expect(out.results.a.timedOut).toBe(true);
    });
});
