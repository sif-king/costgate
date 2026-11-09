// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 按分支/叶子归成本单测（2026-11-06，外部对照总表 #123 候选核项 ③ 实施）。
//
// 定级结论：原始数据不缺 —— relay-ledger 每跳已带 runId + subtaskId，
// 缺的只是「按分支看成本」的聚合口径。故本轮只新增一个纯函数，
// 不改 summarize / report / record 的任何返回形状（AGENTS.md §3 零行为变更）。
// ⚠️ 门控 PROXY_L2_RELAY_LEDGER 仍默认关；本测试用独立实例，不触碰单例。

const path = require('path');
const L2 = path.join(__dirname, '../../../l2');
const { createRelayLedger, groupBySubtask, summarize } = require(path.join(L2, 'relay-ledger.js'));

// executor-bind + l1-agent-adapter 真实链路形状（与 relay-ledger.test.js 同口径）
function chatValue(totalTokens) {
    return {
        adapterId: 'codex', bound: true, kind: 'chat',
        raw: {
            result: {
                raw: { usage: { prompt_tokens: totalTokens, completion_tokens: 0, total_tokens: totalTokens } },
            },
        },
    };
}

const SUMMARIZE_KEYS = [
    'hopCount', 'usageFound', 'usageMissing', 'shadowHops', 'promptTokens',
    'completionTokens', 'totalTokens', 'perAdapter', 'finalHopTokens', 'relayRatio', 'topHops',
].sort();

describe('relay-ledger · groupBySubtask（按分支归成本）', () => {
    test('按 subtaskId 聚合并按 token 降序', () => {
        const led = createRelayLedger();
        led.record({ runId: 'r1', subtaskId: 'a', adapterId: 'codex', value: chatValue(100) });
        led.record({ runId: 'r1', subtaskId: 'a', adapterId: 'claude', value: chatValue(50) });
        led.record({ runId: 'r1', subtaskId: 'b', adapterId: 'codex', value: chatValue(300) });
        expect(groupBySubtask(led.getHops('r1'))).toEqual([
            { subtaskId: 'b', hops: 1, usageFound: 1, usageMissing: 0, tokens: 300, viaFallback: false },
            { subtaskId: 'a', hops: 2, usageFound: 2, usageMissing: 0, tokens: 150, viaFallback: false },
        ]);
    });

    test('挖不到 usage 的跳只计 hops，不把 null 当 0；viaFallback 如实标记', () => {
        const led = createRelayLedger();
        led.record({ runId: 'r2', subtaskId: 'x', adapterId: 'codex', value: {} });
        led.record({ runId: 'r2', subtaskId: 'x', viaFallback: 'orig', value: chatValue(20) });
        expect(groupBySubtask(led.getHops('r2'))).toEqual([
            { subtaskId: 'x', hops: 2, usageFound: 1, usageMissing: 1, tokens: 20, viaFallback: true },
        ]);
    });

    test('跨 run 不混；缺 subtaskId 归 <unknown>；空输入返回空数组', () => {
        const led = createRelayLedger();
        led.record({ runId: 'r1', subtaskId: 'a', value: chatValue(10) });
        led.record({ runId: 'r2', value: chatValue(99) });
        expect(groupBySubtask(led.getHops('r1'))).toHaveLength(1);
        expect(groupBySubtask(led.getHops('r2'))[0].subtaskId).toBe('<unknown>');
        expect(groupBySubtask([])).toEqual([]);
        expect(groupBySubtask(null)).toEqual([]);
    });

    test('🔴 零行为变更证明：summarize / report 返回形状逐字不变', () => {
        const led = createRelayLedger();
        led.record({ runId: 'r', subtaskId: 'a', value: chatValue(10) });
        expect(Object.keys(summarize(led.getHops('r'))).sort()).toEqual(SUMMARIZE_KEYS);
        expect(Object.keys(led.report('r')).sort()).toEqual(SUMMARIZE_KEYS);
    });
});
