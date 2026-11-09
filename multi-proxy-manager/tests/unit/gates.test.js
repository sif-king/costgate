// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// ==================== 能力门控唯一真源（lib/gates.js） ====================
// 2026-10-24：外部审计把「README 承诺的功能是假的」这条反馈钉到了根因上——
// 能力都在代码里，但默认门控关闭而面板从不说明。lib/gates.js 是面板那句
// 「你现在开没开」的唯一数据源，所以**它说谎比不存在更糟**。本文件的天职是
// 钉住它不许说谎：
//   1. 钉住每个门控的默认态与取值范式（改一个 env 语义必须在这里红）；
//   2. crossCheck 拿模块自身导出的 enabled() 与本表对拍，防两处漂移；
//   3. 钉住「跨进程读不到必须报 unknown」，不许拿默认值冒充当前值。
const path = require('path');

const GATES = path.join(__dirname, '..', '..', 'lib', 'gates.js');

function fresh() {
    const p = require.resolve(GATES);
    delete require.cache[p];
    return require(GATES);
}

// 测试期间把可能污染判定的 env 全部清掉，保证「默认态」是真空默认态
const ALL_ENVS = () => require(GATES).GATES.map((g) => g.env);

describe('lib/gates.js — 门控真源', () => {
    let saved;

    beforeEach(() => {
        saved = {};
        for (const env of ALL_ENVS()) {
            saved[env] = process.env[env];
            delete process.env[env];
        }
    });

    afterEach(() => {
        for (const env of ALL_ENVS()) {
            if (saved[env] === undefined) delete process.env[env];
            else process.env[env] = saved[env];
        }
    });

    describe('默认态（无任何 env）', () => {
        it('所有 opt-in 门控默认关，opt-out 门控默认开', () => {
            const rows = fresh().list();
            const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
            // opt-in：编排 / L2 能力 / 告警 / 隔离 / IM / 执行器绑定 / 成本调度 / LLM 拆解
            for (const id of ['orchestration', 'llm-decompose', 'l2-mcp', 'l2-skill', 'l2-skillhosts',
                'l2-memory', 'knowledge-base', 'cost-schedule', 'health-alert', 'health-isolate',
                'im-inbound', 'executor-bind']) {
                expect(byId[id].on).toBe(false);
            }
            // opt-out：成本记账 / 出网脱敏
            expect(byId['cost-track'].on).toBe(true);
            expect(byId['redact'].on).toBe(true);
        });

        it('默认态被判定为「开箱默认」(stock=true)', () => {
            expect(fresh().summary().stock).toBe(true);
            expect(fresh().summary().optInOn).toBe(0);
        });
    });

    describe('取值范式', () => {
        it('opt-in 认 1/true/on，大小写不敏感', () => {
            const g = fresh();
            for (const v of ['1', 'true', 'on', 'TRUE', 'On']) {
                process.env.PROXY_ORCHESTRATION = v;
                expect(g.evaluate({ env: 'PROXY_ORCHESTRATION', kind: 'opt-in' }).on).toBe(true);
            }
            for (const v of ['0', 'false', 'off', '', 'yes', '2']) {
                process.env.PROXY_ORCHESTRATION = v;
                expect(g.evaluate({ env: 'PROXY_ORCHESTRATION', kind: 'opt-in' }).on).toBe(false);
            }
        });

        it('opt-out 仅显式 0/false/off 才关（redact 范式）', () => {
            const g = fresh();
            for (const v of ['0', 'false', 'off', 'OFF']) {
                process.env.PROXY_COST_TRACK = v;
                expect(g.evaluate({ env: 'PROXY_COST_TRACK', kind: 'opt-out' }).on).toBe(false);
            }
            for (const v of ['', '1', 'anything', 'on']) {
                process.env.PROXY_COST_TRACK = v;
                expect(g.evaluate({ env: 'PROXY_COST_TRACK', kind: 'opt-out' }).on).toBe(true);
            }
        });

        // 这条范式是被 crossCheck 逼出来的：cost-track 与 redact 同为「默认开」，
        // 但 cost-track 只认 'off'，redact 认 0/false/off。抹平它要改热路径语义，
        // 不如如实登记——状态条照实说，测试钉住不许漂。
        it("opt-out-off-only 只有显式 'off' 才关（cost-track 范式）", () => {
            const g = fresh();
            process.env.PROXY_COST_TRACK = 'off';
            expect(g.evaluate({ env: 'PROXY_COST_TRACK', kind: 'opt-out-off-only' }).on).toBe(false);
            // '0' / 'false' 在 redact 那里算关，在 cost-track 这里仍算开
            for (const v of ['0', 'false', '', '1', 'true']) {
                process.env.PROXY_COST_TRACK = v;
                expect(g.evaluate({ env: 'PROXY_COST_TRACK', kind: 'opt-out-off-only' }).on).toBe(true);
            }
        });

        it('strict-1 只认字面 1（MCP 门控的历史写法）', () => {
            const g = fresh();
            process.env.PROXY_L2_MCP = '1';
            expect(g.evaluate({ env: 'PROXY_L2_MCP', kind: 'strict-1' }).on).toBe(true);
            // 'true'/'on' 在别处算开，在这一处不算——这正是容易写错的地方，钉住
            process.env.PROXY_L2_MCP = 'true';
            expect(g.evaluate({ env: 'PROXY_L2_MCP', kind: 'strict-1' }).on).toBe(false);
        });
    });

    describe('跨进程门控不许冒充', () => {
        it('PROXY_ROUTE_OVERRIDE 由 cursor 进程持有 → 报 unknown 且 on=null', () => {
            const row = fresh().list().find((r) => r.id === 'route-override');
            expect(row.observable).toBe(false);
            expect(row.on).toBeNull();
            expect(row.unknown).toBe(true);
            expect(row.reason).toMatch(/cursor-proxy/);
        });

        it('unknown 项不计入 on/off 统计，只计入 unknown', () => {
            const s = fresh().summary();
            expect(s.unknown).toBe(1);
            expect(s.total).toBe(s.observable + s.unknown);
        });

        it('即使本进程恰好设了同名 env，也照样报 unknown（读不到就是读不到）', () => {
            process.env.PROXY_ROUTE_OVERRIDE = '1';
            const row = fresh().list().find((r) => r.id === 'route-override');
            expect(row.on).toBeNull();
        });
    });

    describe('防漂移：与模块自身导出的 enabled() 对拍', () => {
        // 状态条一旦与真实判定不一致，用户就会被误导成「功能是假的」。
        // 凡是导出了 enabled() 的模块，都用 crossCheck 字段钉住对拍。
        it('cost-track.enabled() 与本表 cost-track 一致', () => {
            const g = fresh();
            const costTrack = require(path.join(__dirname, '..', '..', 'lib', 'cost-track.js'));
            for (const v of [undefined, '', '1', 'off', 'OFF', '0', 'true']) {
                if (v === undefined) delete process.env.PROXY_COST_TRACK;
                else process.env.PROXY_COST_TRACK = v;
                const row = g.list().find((r) => r.id === 'cost-track');
                expect(row.on).toBe(costTrack.enabled());
            }
        });

        it('redact.enabled() 与本表 redact 一致', () => {
            const g = fresh();
            const redact = require(path.join(__dirname, '..', '..', 'lib', 'redact.js'));
            for (const v of [undefined, '', '1', 'off', '0', 'false', 'true']) {
                if (v === undefined) delete process.env.PROXY_REDACT;
                else process.env.PROXY_REDACT = v;
                const row = g.list().find((r) => r.id === 'redact');
                expect(row.on).toBe(redact.enabled());
            }
        });

        it('每个登记项的 source 都真实存在于对应文件（防门控搬走后真源变谎源）', () => {
            const fs = require('fs');
            const repoRoot = path.join(__dirname, '..', '..', '..');
            for (const g of fresh().GATES) {
                const file = g.source.split(':')[0];
                // source 的基准随 scope 走：manager 门控相对 multi-proxy-manager/，
                // 跨进程门控（cursor-proxy 等）相对仓库根。
                const abs = g.scope
                    ? path.join(repoRoot, file)
                    : path.join(repoRoot, 'multi-proxy-manager', file);
                expect(fs.existsSync(abs)).toBe(true);
                // 该文件里应当仍出现这个 env 名——门控被重命名/搬走时这里会红
                const body = fs.readFileSync(abs, 'utf8');
                expect(body).toContain(g.env);
            }
        });
    });

    describe('出网链路的门控必须全在册（2026-11-08 抓到的真 bug）', () => {
        // 事故：PROXY_PACK_SANDBOX_EGRESS 是 redact 的**外层门**（关掉它两层一起早退），
        // 但此前没登记 ⇒ 状态条只显示 redact「已开启」，用户会得出两个都错的结论：
        //   「关掉 redact 就关完了」（实际外层仍在跑）；「这里开着=整层开着」（实际内层才是脱敏）。
        // 状态条漏掉一层的后果和它说谎等价，所以「在册」本身要有一条守卫。
        it('sandbox-egress（redact 的外层门）与 redact 都必须在册', () => {
            const ids = fresh().GATES.map((g) => g.id);
            expect(ids).toContain('sandbox-egress');
            expect(ids).toContain('redact');
        });

        it('sandbox-egress.enabled() 与本表对拍（真源语义不许漂移）', () => {
            const sb = require('../../../packs/sandbox-egress');
            for (const v of ['', '1', 'true', 'on', '0', 'false', 'off', '  off  ', 'OFF', 'anything']) {
                if (v === '') delete process.env.PROXY_PACK_SANDBOX_EGRESS;
                else process.env.PROXY_PACK_SANDBOX_EGRESS = v;
                const row = fresh().list().find((r) => r.id === 'sandbox-egress');
                expect(row.on).toBe(sb.enabled());
            }
            delete process.env.PROXY_PACK_SANDBOX_EGRESS;
        });

        it('toggleCmd 必须是真能翻转状态的那一条（默认开的项写 =1 是空操作）', () => {
            // 此前 16 项一律给 `${env}=1`。对默认开启的 3 项（cost-track/redact/sandbox-egress）
            // 照着做不会有任何变化，用户还以为自己「关成功了」。这类「给了一条没用还看不出
            // 没用的命令」和直接说谎同效。
            const rows = fresh().list();
            for (const g of fresh().GATES) {
                const row = rows.find((r) => r.id === g.id);
                const defaultOn = String(g.kind).startsWith('opt-out');
                if (defaultOn) {
                    expect(row.toggleCmd).toBe(g.env + '=0');
                    expect(row.toggleHint).toContain('关闭');
                } else {
                    expect(row.toggleCmd).toBe(g.env + '=1');
                    expect(row.toggleHint).toContain('开启');
                }
            }
        });
    });

    describe('summary 语义', () => {
        it('开一个 opt-in 就不再是开箱默认态', () => {
            process.env.PROXY_ORCHESTRATION = '1';
            const s = fresh().summary();
            expect(s.stock).toBe(false);
            expect(s.optInOn).toBe(1);
        });
    });
});
