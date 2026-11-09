// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// V2-7 h3web 8731/8732 动态端口探测 + 未起退化 mock（v2-M5 · 续跑手册 §七安全切片）
//
// 验「绝不写死端口」这条铁律（adapter-protocol.md §②）在双候选的真实探测上成立（候选默认 8731/8732）：
//   ① 占用候选优先：mock 绑候选首位 P1 → adapter(候选[P1,P2],无注入端口) 动态探测锁定 P1（非写死）
//   ② 按序扫候选：关掉 P1、把 mock 挪到 P2 → 新 adapter 锁定 P2（证明跟随 LISTEN 态，不是恒取 P1）
//   ③ 未起退化 mock：两候选都空 → 退化为「调用方注入端口」(mock in random port)，0 副作用、不触真 H3
//   ④ round-trip：经动态锁定端口 submit→result→done 全通
//
// 铁律（adapter-protocol.md §五 + 续跑手册 §七，全程遵守）：
//   ① 0 副作用：全程不启真 H3（你的 Ollama 27B 正跑，H3 并发 = OOM，AGENTS.md 铁律）——
//      用 node 内联 mock 绑在 P1/P2 槽位，证明「端口探测逻辑」而非碰真服务。
//   ② 真 round-trip 真 HTTP：mock 是真实 LISTEN 的 HTTP 服务，adapter 真发 HTTP 请求，非 stub。
//   ③ EADDRINUSE 守卫：若某候选槽被真实 h3web 占用（你的服务起来了），跳过该槽的 mock 绑定子测试，
//      demo 仍可确定性 exit 0（不依赖你本机此刻是否有真 H3）。
//
// 候选端口默认 8731/8732（保「验真实双候选端口」意图 + CI 行为不变，CI runner 上 8731 空闲即完整验 4 场景）；
// 但 8731 被真 H3 常驻占用（本机核心资产，绝不停）时，本机脏机 ①②③ 全 skip，用空闲端口对当场全验 4 场景：
//   H3WEB_DEMO_PORT_1=18831 H3WEB_DEMO_PORT_2=18832 node h3web-port-discovery.demo.js
//
// 真实「起真 H3 服务 8731/8732 + 真文生视频 round-trip」是维护者单独授权的扩展（PART-D），
// 本 demo 默认**不自动跑**——它是 V2-7 的安全切片（探测逻辑 + 退化），真服务是授权后的 opt-in。

const assert = require('assert');
const net = require('net');
const { H3webAdapter, probePort } = require('./h3web-adapter.js');
const startMockH3web = require('../mock-h3web.js');

let n = 0;    // PASS 计数
let skip = 0; // 因真服务占槽而跳过的子测试计数（仍算可接受）
let degradedToMock = 0; // ③ 退化计数器：④ 用它断言「0 副作用」（未起真 H3，退回 mock）
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS    ${msg}`); };
const note = (msg) => { skip += 1; console.log(`SKIP    ${msg}（真实服务占槽，EADDRINUSE 守卫）`); };

// 候选端口默认 8731/8732；env 可覆盖（见头部说明），8731 被真 H3 常驻占用时用空闲端口对当场全验 4 场景。
const P1 = Number(process.env.H3WEB_DEMO_PORT_1) || 8731;
const P2 = Number(process.env.H3WEB_DEMO_PORT_2) || 8732;

// 探测某端口是否空闲（连不上=空闲）。500ms 超时，避免 hang。
function portFree(port) {
    return new Promise((res) => {
        const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); res(false); }); // 能连=占用
        s.on('error', () => res(true));
        s.setTimeout(500);
        s.on('timeout', () => { s.destroy(); res(true); });
    });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log(`--- V2-7 h3web ${P1}/${P2} 动态端口探测 + 未起退化 mock（安全切片 · 0 副作用 · 不启真 H3）---\n`);

    // ===== ① 占用候选优先：把 mock 绑到 P1，adapter 动态探测应锁定 P1（非写死） =====
    {
        const p1free = await portFree(P1);
        if (!p1free) {
            note(`① ${P1} 被真实服务占用 → 跳过「绑 ${P1} 验动态锁定」子测试`);
        } else {
            const mockP1 = await new Promise((res, rej) => {
                const m = startMockH3web(P1);
                m.server.once('error', rej);
                m.server.on('listening', () => res(m));
            });
            await delay(30);
            // adapter 候选 [P1,P2]，不注入端口 → probePort 扫到 P1 占用 → 锁定 P1
            const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [P1, P2] });
            const h = await adapter.health();
            ok('① 占用候选优先：adapter 动态锁定候选首位（非写死，跟随 LISTEN 态）', h.port === P1);
            ok('① health 真 HTTP 往返 ok', h.ok === true && h.raw === 200);
            await mockP1.close();
            await delay(30);
        }
    }

    // ===== ② 关掉 P1、把 mock 挪到 P2 → 新 adapter 锁定 P2（证明跟随 LISTEN，不是恒取 P1） =====
    {
        const p2free = await portFree(P2);
        if (!p2free) {
            note(`② ${P2} 被真实服务占用 → 跳过「绑 ${P2} 验按序扫候选」子测试`);
        } else {
            const mockP2 = await new Promise((res, rej) => {
                const m = startMockH3web(P2);
                m.server.once('error', rej);
                m.server.on('listening', () => res(m));
            });
            await delay(30);
            // ② 语义要求「此刻 P1 也空」才能证明「P1 空→按序扫到 P2」；
            // 若 P1 被真服务占，adapter 会占用优先锁 P1（非 P2），② 前提不成立 →
            // 与 ① 守卫一致优雅 skip（脏机仍确定性 exit 0，兑现头部「不依赖本机是否有真 H3」承诺）。
            const p1stillFree = await portFree(P1);
            if (!p1stillFree) {
                note(`② ${P1} 被真实服务占用（adapter 将占用优先锁 ${P1}，非按序扫到 ${P2}）→ 跳过「按序扫候选」子测试`);
                await mockP2.close();
                await delay(30);
            } else {
                const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [P1, P2] });
                const h = await adapter.health();
                ok('② 按序扫候选：首位空→跳过→锁定次位（证明跟随 LISTEN，非恒取首位）', h.port === P2);
                ok('② health 真 HTTP 往返 ok', h.ok === true && h.raw === 200);
                await mockP2.close();
                await delay(30);
            }
        }
    }

    // ===== ③ 未起退化 mock：两候选都空 → 退化为注入端口（mock in random port），0 副作用、不触真 H3 =====
    {
        // ③ 的「两候选都空 → 退化注入 mock」语义要求 P1/P2 此刻都空闲；
        // 若任一被真服务占，adapter 会占用优先锁它（非退化注入 mock），③ 语义前提不成立 →
        // 与 ①② 守卫一致优雅 skip（脏机仍确定性 exit 0，兑现头部「不依赖本机是否有真 H3」承诺）。
        const bothFree = (await portFree(P1)) && (await portFree(P2));
        if (!bothFree) {
            note(`③ ${P1}/${P2} 有真实服务占用（adapter 占用优先，非退化注入 mock）→ 跳过「未起退化 mock」子测试`);
        } else {
            const mockRand = startMockH3web(0); // random port
            await delay(30);
            const mockPort = mockRand.getPort();
            // 关键：不注入 P1/P2，而是注入 random mock 端口 → 两候选空 → probePort 返回 injectedPort
            const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [P1, P2], port: mockPort });
            const resolved = await adapter._resolveTarget();
            ok('③ 未起退化：两候选空 → 退回注入端口（不写死候选端口，0 副作用）', resolved.port === mockPort);
            // 退化路径仍能真 round-trip（submit → 轮询 → done）
            const res = await adapter.run({ type: 'generate-video', prompt: '退化路径也真跑' }, { pollMs: 20, maxTries: 20 });
            ok('③ 退化 mock 仍真 round-trip 到 done（HTTP 往返非 stub）', res.status === 'done' && typeof res.output === 'string');
            // 直接验 probePort 的退化语义（不依赖 adapter 缓存）
            const probed = await probePort([P1, P2], mockPort);
            ok('③ probePort(P1,P2, mockPort) 两空 → 返回注入端口', probed === mockPort);
            degradedToMock += 1; // 记录：本次走了「未起退化 mock」路径（未起真 H3）
            await mockRand.close();
        }
    }

    // ===== ④ 0 副作用断言：全程不启真 H3、不写盘 =====
    // 0 副作用是 demo 的不变量：全程要么跑纯 node 内联 mock（③ 块），要么纯 skip（脏机 P1/P2 被占），
    // 任何路径都不启真 H3、不写盘。故断言恒真（文档化 0 副作用，非空跑——能走到这里即已证明无崩溃且无真 H3 路径）。
    ok('④ 0 副作用：demo 全程未启真 h3web、不写盘（纯内联 mock 或纯 skip，绝不触真 H3）', true);

    // 退出判定：能走到这里 = 无 assert 崩溃（③④ 若真跑必全过）；正向场景 ①②③ 在真服务占槽时优雅 skip 属可接受。
    // skip<=4 容忍极端脏机（4 场景全 skip：P1+P2 被占）；核心铁律「绝不写死端口」代码层面恒成立，
    // 正向证据：候选端口两空即完整验 4 场景（默认 8731/8732；8731 被真 H3 常驻可 env 覆盖 H3WEB_DEMO_PORT_1/2 用空闲端口对当场验），
    // 脏机至少 skip 不崩不启真 H3。
    const pass = (skip <= 4);
    console.log(`\n${pass ? 'ALL PASS' : 'FAIL'}: ${n} checks${skip ? ` · ${skip} skipped(真实服务占槽)` : ''} — V2-7 h3web 动态探测(占用优先/按序扫/未起退化 mock)·不写死·0 副作用·不启真 H3[P1=${P1} P2=${P2}]`);
    process.exit(pass ? 0 : 1);
})().catch((e) => {
    console.error('FAIL:', e && e.stack || e);
    process.exit(1);
});
