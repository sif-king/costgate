// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// relay-ledger 单测 —— L2 编排「agent 间接力开销」账本（P2 观测件 2026-10-13）。
//
// 覆盖三层：
//   ① 纯函数 extractUsage / summarize（含「挖不到不填 0」的诚实性用例）；
//   ② Orchestrator 集成（注入才记账；未注入 = 返回形状逐字不变 = 零行为变更证明）；
//   ③ 路由 sidecar（门控默认关 → /run 无 relay 字段、GET /relay 403）。
//
// 隔离纪律：全内联 mock（无 mock-l1/mock-h3web 网络依赖）；env 用完即清，防污染其它套件。

const path = require('path');
const express = require('express');
const request = require('supertest');

const L2 = path.join(__dirname, '../../../l2');
const { extractUsage, summarize, createRelayLedger, gateOpen } = require(path.join(L2, 'relay-ledger.js'));
const { Orchestrator } = require(path.join(L2, 'orchestrator.js'));

// executor-bind + l1-agent-adapter 真实链路形状（照码读实，非臆造）：
//   executor 返回 { adapterId, bound, kind, raw: adapterReturn }
//   adapterReturn.result.raw = 上游 OpenAI 兼容 parsed 响应（usage 随行）
function chatValueWithUsage({ prompt = 100, completion = 50, adapterId = 'codex' } = {}) {
    return {
        adapterId, bound: true, kind: 'chat',
        raw: {
            task_id: 'l1_x', type: 'chat', state: 'done', agent: adapterId,
            result: {
                content: 'ok', contentSource: 'content', model: 'm', id: 'x',
                raw: { id: 'x', model: 'm', usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } },
            },
            error: null,
        },
    };
}

describe('relay-ledger · extractUsage 纯函数', () => {
    test('真实链路形状（value.raw.result.raw.usage）→ 提取', () => {
        const u = extractUsage(chatValueWithUsage({ prompt: 120, completion: 30 }));
        expect(u).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
    });

    test('直挂 value.usage 形态 → 提取', () => {
        const u = extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
        expect(u).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    });

    test('total_tokens 缺失 → prompt+completion 现算（不猜别的）', () => {
        const u = extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 5 } });
        expect(u.totalTokens).toBe(10);
    });

    test('shadow 值 / h3web 任务队列 / 发现调用 → null（挖不到就是挖不到）', () => {
        expect(extractUsage({ shadow: true, subtaskId: 'a' })).toBeNull();
        expect(extractUsage({ adapterId: 'h3web', kind: 'task-queue', taskId: 't', raw: { result: { output: 'video.mp4' } } })).toBeNull();
        expect(extractUsage({ adapterId: 'hermes', raw: { type: 'discovery', result: { available_models: ['a'] } } })).toBeNull();
    });

    test('垃圾输入（null / 字符串 / 无 usage 对象）→ null 且不抛', () => {
        for (const v of [null, undefined, 'str', 42, {}, { usage: null }, { usage: 'x' }, { raw: 1 }, { raw: { result: null } }]) {
            expect(extractUsage(v)).toBeNull();
        }
    });
});

describe('relay-ledger · summarize 汇总', () => {
    const hop = (o) => Object.assign({
        ts: 1, runId: 'r', subtaskId: 's', adapterId: 'codex', usageFound: true,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, shadow: false,
    }, o);

    test('基本汇总 + perAdapter + topHops 排序', () => {
        const rep = summarize([
            hop({ subtaskId: 'a', adapterId: 'codex', totalTokens: 100 }),
            hop({ subtaskId: 'b', adapterId: 'claude', totalTokens: 300 }),
            hop({ subtaskId: 'c', adapterId: 'codex', totalTokens: 50 }),
        ]);
        expect(rep.hopCount).toBe(3);
        expect(rep.usageFound).toBe(3);
        expect(rep.usageMissing).toBe(0);
        expect(rep.totalTokens).toBe(450);
        expect(rep.perAdapter.codex).toEqual({ hops: 2, usageFound: 2, tokens: 150 });
        expect(rep.perAdapter.claude).toEqual({ hops: 1, usageFound: 1, tokens: 300 });
        expect(rep.topHops[0]).toEqual({ subtaskId: 'b', adapterId: 'claude', totalTokens: 300 });
        // 最后一跳 c=50 → relayRatio = 450/50 = 9（为接力多付 8 倍）
        expect(rep.finalHopTokens).toBe(50);
        expect(rep.relayRatio).toBe(9);
    });

    test('挖不到 usage 的跳单列 usageMissing，不并进 totalTokens（不填 0 冒充没花）', () => {
        const rep = summarize([
            hop({ subtaskId: 'a', totalTokens: 100 }),
            hop({ subtaskId: 'b', usageFound: false, totalTokens: null }),
            hop({ subtaskId: 'c', usageFound: false, shadow: true, totalTokens: null }),
        ]);
        expect(rep.hopCount).toBe(3);
        expect(rep.usageFound).toBe(1);
        expect(rep.usageMissing).toBe(2);
        expect(rep.shadowHops).toBe(1);
        expect(rep.totalTokens).toBe(100);
    });

    test('没有分母（全缺 usage）→ relayRatio=null，不硬算比值；单跳=1（无接力基线）', () => {
        expect(summarize([hop({ usageFound: false, totalTokens: null })]).relayRatio).toBeNull();
        expect(summarize([hop({ totalTokens: 42 })]).relayRatio).toBe(1);
        expect(summarize([]).relayRatio).toBeNull();
    });

    test('topHops 截断到 10 条', () => {
        const many = Array.from({ length: 15 }, (_, i) => hop({ subtaskId: `s${i}`, totalTokens: i + 1 }));
        expect(summarize(many).topHops.length).toBe(10);
        expect(summarize(many).topHops[0].totalTokens).toBe(15);
    });
});

describe('relay-ledger · createRelayLedger 实例', () => {
    test('record → report(runId) 只汇该 run；getHops 可追溯', () => {
        const led = createRelayLedger();
        led.record({ runId: 'r1', subtaskId: 'a', adapterId: 'codex', value: chatValueWithUsage({ prompt: 10, completion: 5 }) });
        led.record({ runId: 'r2', subtaskId: 'a', adapterId: 'codex', value: chatValueWithUsage({ prompt: 99, completion: 1 }) });
        const r1 = led.report('r1');
        expect(r1.hopCount).toBe(1);
        expect(r1.totalTokens).toBe(15);
        expect(led.report('r2').totalTokens).toBe(100);
        expect(led.report().hopCount).toBe(2);
        expect(led.getHops('r1')[0].adapterId).toBe('codex');
        expect(led.size()).toBe(2);
    });

    test('环形容量裁剪（不无限增长）', () => {
        const led = createRelayLedger({ logCapacity: 3 });
        for (let i = 0; i < 5; i++) led.record({ runId: 'r', subtaskId: `s${i}`, adapterId: 'codex', value: chatValueWithUsage() });
        expect(led.size()).toBe(3);
        expect(led.getHops('r').map((h) => h.subtaskId)).toEqual(['s2', 's3', 's4']);
    });

    test('门控：默认关；1/true/on 才开', () => {
        const prev = process.env.PROXY_L2_RELAY_LEDGER;
        try {
            delete process.env.PROXY_L2_RELAY_LEDGER;
            expect(gateOpen()).toBe(false);
            for (const v of ['1', 'true', 'on', 'TRUE']) { process.env.PROXY_L2_RELAY_LEDGER = v; expect(gateOpen()).toBe(true); }
            for (const v of ['0', '', 'yes']) { process.env.PROXY_L2_RELAY_LEDGER = v; expect(gateOpen()).toBe(false); }
        } finally {
            if (prev == null) delete process.env.PROXY_L2_RELAY_LEDGER; else process.env.PROXY_L2_RELAY_LEDGER = prev;
        }
    });
});

describe('relay-ledger · Orchestrator 集成', () => {
    const dag = {
        input: 'demo',
        template: 'chain',
        edges: [['a', 'b'], ['b', 'c']],
        subtasks: [
            { id: 'a', type: 'plan', prompt: 'a', deps: [] },
            { id: 'b', type: 'code', prompt: 'b', deps: ['a'] },
            { id: 'c', type: 'test', prompt: 'c', deps: ['b'] },
        ],
    };

    test('注入 ledger + 非 shadow：三跳全记账，relayRatio = 总/最后一跳', async () => {
        const led = createRelayLedger();
        const orch = new Orchestrator({
            shadowMode: false,
            relayLedger: led,
            executor: async (st) => chatValueWithUsage({
                prompt: 100, completion: st.id === 'c' ? 50 : 200,
                adapterId: st.id === 'a' ? 'codex' : 'claude',
            }),
        });
        const out = await orch.run(dag, {});
        expect(Object.keys(out.results).sort()).toEqual(['a', 'b', 'c']);
        expect(out.relay).toBeDefined();
        expect(out.relay.hopCount).toBe(3);
        expect(out.relay.usageFound).toBe(3);
        expect(out.relay.totalTokens).toBe(300 + 300 + 150); // 每跳 prompt 100 + completion（a/b=200，c=50）
        expect(out.relay.perAdapter.codex.tokens).toBe(300); // a: 100+200
        expect(out.relay.perAdapter.claude.tokens).toBe(450); // b+c: 300+150
        expect(out.relay.finalHopTokens).toBe(150);          // c: 100+50
        expect(out.relay.relayRatio).toBeCloseTo(750 / 150, 3); // 为接力多付 4 倍
    });

    // 2026-11-06 第六轮（补）：reportBySubtask 离线端到端断言。
    // 用假 executor 返回真 usage 形状（不触下游／不花钱／不开门控），验证「按子任务（分支/叶子）聚合」口径：
    // ① 300/300/150 归到 a/b/c；② 降序末位是 c；③ 聚合总额与 summarize 对账；④ 跨 ledger 不混。
    test('reportBySubtask：假 executor 真 usage → 按叶子聚合、降序、跨 ledger 不混', async () => {
        const led = createRelayLedger();
        const orch = new Orchestrator({
            shadowMode: false,
            relayLedger: led,
            executor: async (st) => chatValueWithUsage({
                prompt: 100, completion: st.id === 'c' ? 50 : 200,
                adapterId: st.id === 'a' ? 'codex' : 'claude',
            }),
        });
        const out = await orch.run(dag, {});
        const runId = out.history.runId;
        expect(runId).toBeTruthy();

        const sub = led.reportBySubtask(runId);
        expect(Array.isArray(sub)).toBe(true);
        expect(sub).toHaveLength(3);
        const byId = Object.fromEntries(sub.map((s) => [s.subtaskId, s]));
        expect(byId.a).toMatchObject({ subtaskId: 'a', hops: 1, tokens: 300, usageFound: 1, usageMissing: 0 });
        expect(byId.b).toMatchObject({ subtaskId: 'b', hops: 1, tokens: 300, usageFound: 1, usageMissing: 0 });
        expect(byId.c).toMatchObject({ subtaskId: 'c', hops: 1, tokens: 150, usageFound: 1, usageMissing: 0 });
        // 降序（同 token 时按 id 升序）→ a,b 在前、c(150) 末位
        expect(sub[sub.length - 1].subtaskId).toBe('c');
        expect(sub[0].tokens).toBe(300);

        // 聚合总额与 summarize 对账（单 run，ledger 只此一次；report() 无参＝全量汇总）
        const total = sub.reduce((a, s) => a + (s.tokens || 0), 0);
        expect(total).toBe(300 + 300 + 150);
        expect(led.report().totalTokens).toBe(total);

        // 跨 ledger 隔离：用 runId 查另一个空的 led2 ⇒ 空数组，不把别的 run 混进来
        const led2 = createRelayLedger();
        expect(led2.reportBySubtask(runId)).toEqual([]);
        const orch2 = new Orchestrator({
            shadowMode: false, relayLedger: led2,
            executor: async () => chatValueWithUsage({ prompt: 10, completion: 5, adapterId: 'codex' }),
        });
        const out2 = await orch2.run(dag, {});
        const sub2 = led2.reportBySubtask(out2.history.runId);
        expect(sub2.reduce((a, s) => a + (s.tokens || 0), 0)).toBe(45); // 3×15
        expect(led2.reportBySubtask(runId)).toEqual([]); // 旧 runId 只属 led，led2 查不到
    });

    test('未注入（默认）：返回形状逐字不含 relay 键 —— 零行为变更证明', async () => {
        const orch = new Orchestrator({ shadowMode: true });
        const out = await orch.run(dag, {});
        expect(Object.keys(out).sort()).toEqual(['history', 'report', 'results']);
        expect(out.relay).toBeUndefined();
        expect(out.results.a.status).toBe('done');
    });

    test('shadow 模式：跳照记但 usageFound=false（不拿 0 冒充没花）', async () => {
        const led = createRelayLedger();
        const orch = new Orchestrator({ shadowMode: true, relayLedger: led });
        const out = await orch.run(dag, {});
        expect(out.relay.hopCount).toBe(3);
        expect(out.relay.usageFound).toBe(0);
        expect(out.relay.usageMissing).toBe(3);
        expect(out.relay.shadowHops).toBe(3);
        expect(out.relay.totalTokens).toBe(0);
        expect(out.relay.relayRatio).toBeNull();
    });

    test('fallback 成功路径也记账（viaFallback 留痕）', async () => {
        const led = createRelayLedger();
        const orch = new Orchestrator({
            shadowMode: false,
            relayLedger: led,
            // 'a' 每次尝试都抛（retry 用尽）→ 才走 fallback 'a2'；'a2' 成功
            executor: async (st) => {
                if (st.id === 'a') throw new Error('boom');
                return chatValueWithUsage({ prompt: 10, completion: 5 });
            },
        });
        const dagFb = {
            input: 'demo', template: 'chain', edges: [],
            subtasks: [
                { id: 'a', type: 'plan', prompt: 'a', deps: [], fallback: 'a2' },
                { id: 'a2', type: 'plan', prompt: 'a2', deps: [] },
            ],
        };
        const out = await orch.run(dagFb, {});
        expect(out.results.a.status).toBe('done');
        expect(out.results.a.via).toBe('a2');
        // a2 兼「fallback 目标」与「独立子任务」两职，调度器两个都跑 → 2 跳全记账。
        // 两跳并发完成、记录顺序不定 → 按特征查找，不断言顺序。
        const hops = led.getHops();
        expect(hops.length).toBe(2);
        expect(out.relay.totalTokens).toBe(30);
        const fbHop = hops.find((h) => h.viaFallback === 'a');
        expect(fbHop).toBeDefined();                              // a 走 fallback 成功那一跳
        expect(fbHop.totalTokens).toBe(15);
        const standalone = hops.find((h) => h.subtaskId === 'a2' && !h.viaFallback);
        expect(standalone).toBeDefined();                         // a2 作为独立子任务那一跳
        expect(standalone.totalTokens).toBe(15);
    });
});

describe('relay-ledger · 路由 sidecar（/api/orchestration）', () => {
    let app;
    const build = () => {
        app = express();
        app.use(express.json());
        const r = require('../../routes/orchestration');
        r._resetForTest && r._resetForTest();
        app.use('/api/orchestration', r);
        return app;
    };
    const dag = {
        input: 'demo', template: 'single', edges: [],
        subtasks: [{ id: 'a', type: 'plan', prompt: 'a', deps: [] }],
    };

    beforeEach(() => {
        delete require.cache[require.resolve('../../routes/orchestration')];
    });
    afterEach(() => {
        delete process.env.PROXY_ORCHESTRATION;
        delete process.env.PROXY_L2_RELAY_LEDGER;
    });

    // 2026-11-06 第五轮：钉住「开门控清单」的前置依赖链（存在性≠连通性）。
    // 只开 PROXY_L2_RELAY_LEDGER、不开 PROXY_ORCHESTRATION ⇒ 整条 /api/orchestration
    // 被 router.use(gate) 前置拦截，relay 门控根本轮不到判 ⇒ 5 项验收一项都跑不了。
    // 若哪天又有人把单条 env 写成「一键打开」，这条守卫会先红。
    test('依赖链：只开 relay 门控、不开 orchestration → 整条路由 403（前置闸）', async () => {
        process.env.PROXY_L2_RELAY_LEDGER = '1';
        build();
        const run = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
        expect(run.status).toBe(403);
        expect(run.body.error).toBe('orchestration-gate-closed');
        for (const p of ['/relay', '/relay/subtasks']) {
            const g = await request(app).get(`/api/orchestration${p}`);
            expect(g.status).toBe(403);
            expect(g.body.error).toBe('orchestration-gate-closed');
        }
        // 元守卫反向：补上前置门控后同一 app 立刻放行 ⇒ 证明是 env 依赖链，不是启动期缓存。
        process.env.PROXY_ORCHESTRATION = '1';
        const ok = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
        expect(ok.status).toBe(200);
        expect(ok.body.relay.hopCount).toBe(1);
    });

    test('relay 门控关（默认）：/run 200 但响应无 relay 字段；GET /relay 403', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        build();
        const r = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
        expect(r.status).toBe(200);
        expect(r.body.relay).toBeUndefined();       // 逐字零行为变更
        const g = await request(app).get('/api/orchestration/relay');
        expect(g.status).toBe(403);
        expect(g.body.error).toBe('relay-ledger-gate-closed');
    });

    test('relay 门控开：/run 附 relay（shadow → usageMissing 如实）；GET /relay 200', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        process.env.PROXY_L2_RELAY_LEDGER = '1';
        build();
        const r = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
        expect(r.status).toBe(200);
        expect(r.body.relay).toBeDefined();
        expect(r.body.relay.hopCount).toBe(1);
        expect(r.body.relay.usageFound).toBe(0);
        expect(r.body.relay.usageMissing).toBe(1);
        const g = await request(app).get('/api/orchestration/relay');
        expect(g.status).toBe(200);
        expect(g.body.hopCount).toBe(1);
    });

    // 2026-11-06 #123③ 接线：groupBySubtask 不能再只有测试调用，要有真实可达路径。
    test('GET /relay/subtasks 门控关 → 403（与 /relay 同纪律，零行为变更）', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        build();
        const g = await request(app).get('/api/orchestration/relay/subtasks');
        expect(g.status).toBe(403);
        expect(g.body.error).toBe('relay-ledger-gate-closed');
    });

    test('GET /relay/subtasks 门控开 → 按子任务聚合 + ?runId 过滤；/relay 形状不变', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        process.env.PROXY_L2_RELAY_LEDGER = '1';
        build();
        const r = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
        expect(r.status).toBe(200);
        const runId = r.body.runId;
        expect(runId).toBeTruthy();

        const g = await request(app).get('/api/orchestration/relay/subtasks').query({ runId });
        expect(g.status).toBe(200);
        expect(g.body.runId).toBe(runId);
        expect(Array.isArray(g.body.subtasks)).toBe(true);
        expect(g.body.subtasks).toHaveLength(1);
        expect(g.body.subtasks[0]).toMatchObject({
            subtaskId: 'a', hops: 1, usageFound: 0, usageMissing: 1, tokens: 0,
        });

        // 不存在的 runId → 空数组，不把别的 run 混进来
        const g2 = await request(app).get('/api/orchestration/relay/subtasks').query({ runId: 'run_no_such' });
        expect(g2.status).toBe(200);
        expect(g2.body.subtasks).toEqual([]);

        // 既有 /relay 返回形状逐字不变：仍是 summarize 的键，不带 subtasks
        const g3 = await request(app).get('/api/orchestration/relay');
        expect(g3.status).toBe(200);
        expect(g3.body.hopCount).toBe(1);
        expect(g3.body.subtasks).toBeUndefined();
    });
});
