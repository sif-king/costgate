// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// lib/gate-evidence.js — 门控运行证据层（2026-11-08）
//
// 这层要回答的问题只有一个：「门控开着」和「真的在跑」是不是同一件事。
// 它能说谎的方式比它能的做的事更多，所以每条纪律都要有守卫：
//   ① 只读 —— 用账本统计时绝不能把历史账重新应用进内存态（看一眼前提是账翻倍）；
//   ② 「读不到」≠「零次」—— IO 失败报 0 就等于把故障说成正常；
//   ③ 「0 次」的含义必须写在文案里 —— 否则用户把「没命中」读成「没生效」；
//   ④ 「无采集点」≠「没生效」—— 采不到只是采不到。
const fs = require('fs');
const os = require('os');
const path = require('path');

const evidence = require('../../lib/gate-evidence');
const costTrack = require('../../lib/cost-track');
const gates = require('../../lib/gates');
const sandboxEgress = require('../../../packs/sandbox-egress');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
    costTrack.reset();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    sandboxEgress.setHitsFile('');
});

const ledgerPath = () => path.join(tmpDir, 'cost-ledger.jsonl');

function writeLedger(lines) {
    fs.writeFileSync(ledgerPath(), lines.map((l) => JSON.stringify(l) + '\n').join(''));
}

describe('门控运行证据 — 成本账本', () => {
    it('有账本时报真实笔数与最近时间（不是猜、不是默认值）', () => {
        writeLedger([
            { ts: '2026-11-01T10:00:00.000Z', proxy: 'codex', model: 'm1', prompt: 10 },
            { ts: '2026-11-02T11:30:00.000Z', proxy: 'codex', model: 'm1', prompt: 20 },
            { ts: '2026-11-03T12:00:00.000Z', proxy: 'codex', model: 'm2', prompt: 30 },
        ]);
        const s = costTrack.ledgerStats(ledgerPath());
        expect(s.entries).toBe(3);
        expect(s.lastAt).toBe('2026-11-03T12:00:00.000Z');
        expect(s.error).toBeNull();
    });

    it('账本不存在 = 0 笔，是正常态，不是错误', () => {
        const s = costTrack.ledgerStats(path.join(tmpDir, 'nope.jsonl'));
        expect(s.exists).toBe(false);
        expect(s.entries).toBe(0);
        expect(s.error).toBeNull();
    });

    it('账本读失败必须是 null + error，绝不能报成 0 笔', () => {
        // 把路径指向一个目录 ⇒ readFileSync 抛 EISDIR
        const dirAsFile = path.join(tmpDir, 'a-directory');
        fs.mkdirSync(dirAsFile);
        const s = costTrack.ledgerStats(dirAsFile);
        expect(s.entries).toBeNull();
        expect(s.error).toBeTruthy();
    });

    it('🔴 看一眼账本不许把账本重新应用进内存态（否则「看一眼前提是账翻倍」）', () => {
        writeLedger([
            { ts: '2026-11-01T10:00:00.000Z', proxy: 'codex', model: 'm1', prompt: 100, completion: 50, cost: 0.01 },
            { ts: '2026-11-02T11:30:00.000Z', proxy: 'codex', model: 'm1', prompt: 200, completion: 80, cost: 0.02 },
        ]);
        const before = JSON.stringify(costTrack.getAll());
        costTrack.ledgerStats(ledgerPath());
        costTrack.ledgerStats(ledgerPath());
        expect(JSON.stringify(costTrack.getAll())).toBe(before);
        // 同时确认它确实没顺手把历史账读进内存（读了的话 getCost 会有请求数）
        expect(costTrack.getAll().totalRequests || 0).toBe(0);
    });

    it('缓存：内容没变时不重复读，追加后能读到新数字', () => {
        writeLedger([{ ts: '2026-11-01T10:00:00.000Z', proxy: 'codex', model: 'm1', prompt: 1 }]);
        expect(costTrack.ledgerStats(ledgerPath()).entries).toBe(1);
        // 同 size 同 mtime ⇒ 命中缓存，结果稳定
        expect(costTrack.ledgerStats(ledgerPath()).entries).toBe(1);
        // 追加一行 ⇒ size 变 ⇒ 缓存失效，必须看到 2
        fs.appendFileSync(ledgerPath(), JSON.stringify({ ts: '2026-11-04T09:00:00.000Z', proxy: 'codex', model: 'm1', prompt: 2 }) + '\n');
        expect(costTrack.ledgerStats(ledgerPath()).entries).toBe(2);
    });

    it('最后一行是半行（append 非原子）时，笔数照报，只把时间当未知', () => {
        fs.writeFileSync(ledgerPath(),
            JSON.stringify({ ts: '2026-11-01T10:00:00.000Z', prompt: 1 }) + '\n' + '{"ts":"2026-11-02T');
        const s = costTrack.ledgerStats(ledgerPath());
        expect(s.entries).toBe(2);          // 半行也是一行，不吞
        expect(s.lastAt).toBeNull();        // 解析不出来就说不知道，不编时间
    });
});

describe('门控运行证据 — 沙箱命中记录', () => {
    it('按 kind 分组统计，并把 Date.now() 数字统一成 ISO', () => {
        const f = path.join(tmpDir, 'hits.jsonl');
        fs.writeFileSync(f, [
            JSON.stringify({ ts: 1762000000000, kind: 'outbound-redact', hits: [{ id: 'phone', count: 1 }] }),
            JSON.stringify({ ts: 1762000100000, kind: 'inbound-tool-check', mode: 'observe', findings: ['exfiltrate-env'] }),
            JSON.stringify({ ts: 1762000200000, kind: 'outbound-redact', hits: [{ id: 'key', count: 1 }] }),
        ].join('\n') + '\n');
        const s = sandboxEgress.hitsStats(f);
        expect(s.total).toBe(3);
        expect(s.byKind['outbound-redact']).toBe(2);
        expect(s.byKind['inbound-tool-check']).toBe(1);
        expect(s.lastAt).toBe(new Date(1762000200000).toISOString());
    });

    it('文件不存在 = 0 条，不是错误', () => {
        const s = sandboxEgress.hitsStats(path.join(tmpDir, 'none.jsonl'));
        expect(s.exists).toBe(false);
        expect(s.total).toBe(0);
        expect(s.error).toBeNull();
    });
});

describe('门控运行证据 — 对外口径（文案不许把三种情况说成一种）', () => {
    it('无采集点的项：available=false，且文案写明「采不到 ≠ 没生效」', () => {
        const e = evidence.forGate(null);
        expect(e.available).toBe(false);
        expect(e.hits).toBeNull();
        expect(e.detail).toContain('采不到');
        expect(e.detail).toContain('没生效');
    });

    it('声明了不存在的采集键时，降级成无采集点而不是抛错', () => {
        const e = evidence.forGate('no-such-key');
        expect(e.available).toBe(false);
        expect(e.hits).toBeNull();
    });

    it('0 次命中必须自带「0 次≠没生效」的解释，否则会被读成没做', () => {
        sandboxEgress.setHitsFile(path.join(tmpDir, 'empty-hits.jsonl'));
        const e = evidence.forGate('egress-outbound');
        expect(e.hits).toBe(0);
        expect(e.unknown).toBe(false);
        expect(e.detail).toMatch(/0 次.*≠.*没生效/);
    });

    it('账本读不到时 unknown=true 且 hits=null（不许报 0）', () => {
        // 走 provider 全链路：把 PROXY_COST_LEDGER 指向目录，再清掉缓存
        const dirAsFile = path.join(tmpDir, 'dir-as-ledger');
        fs.mkdirSync(dirAsFile);
        const old = process.env.PROXY_COST_LEDGER;
        process.env.PROXY_COST_LEDGER = dirAsFile;
        costTrack.reset();
        try {
            const e = evidence.forGate('cost-ledger');
            expect(e.hits).toBeNull();
            expect(e.unknown).toBe(true);
        } finally {
            if (old === undefined) delete process.env.PROXY_COST_LEDGER;
            else process.env.PROXY_COST_LEDGER = old;
            costTrack.reset();
        }
    });
});

describe('门控运行证据 — 与门控注册表的一致性', () => {
    it('每个 evidenceKey 都必须是真实存在的采集器（防「声明了却采不到」）', () => {
        const keys = new Set();
        for (const g of gates.list()) {
            if (g.evidenceKey) keys.add(g.evidenceKey);
        }
        expect(keys.size).toBeGreaterThan(0);
        for (const k of keys) {
            expect(evidence.PROVIDERS[k]).toBeDefined();
        }
    });

    it('声明了证据键的项，其 evidence 必须 available=true（否则等于挂着个空承诺）', () => {
        for (const g of gates.list()) {
            if (!g.evidenceKey) continue;
            const e = evidence.forGate(g.evidenceKey);
            expect(e.available).toBe(true);
        }
    });
});
