// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// public/gatebar.js — 「开着 ≠ 跑过」这条口径的行为守卫（2026-11-08）
//
// 背景：门控条原来只回答「这一项在环境里开没开」。但「开着」有两种含义，
// 用户从绿色 chip 上分不出来：
//   (a) 开着，而且真的在跑（有入账/命中）
//   (b) 开着，但一次都没被走过（可能根本没接线）
// 两种都画绿 ⇒ (b) 被读成 (a)，是「假功能」指控的同一种落差换了个位置。
//
// 本文件钉住三件事，防止那条口径被后来的人删掉/改回去：
//   ① 成本项有正数证据 ⇒ 必须显示数字（交付证据要可见，不能只说「已开」）；
//   ② 成本项开着但零入账 ⇒ 必须降级成琥珀「空转」，不许继续画绿；
//   ③ 「无采集点」「0 次」「读不到」三种情况的文案必须各说各话，不许合并成一种。
//
// 这里用真函数测（不读源码字符串）：gatebar.js 把 leadChips/evTail/evCell 挂在
// window.MPGateBar 上，本文件用一个极简 DOM stub 让它跑完 IIFE 再取出来调。
// 纯字符串断言只能防「整段被删」，改个变量名就失效，不足以钉语义。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../../public/gatebar.js');

function loadGatebar() {
    // 极简 DOM stub：只够 IIFE 跑完并挂上 window.MPGateBar。
    // readyState='loading' ⇒ boot() 只注册 DOMContentLoaded，不 mount、不 fetch、不碰网络。
    const listeners = {};
    global.document = {
        readyState: 'loading',
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
        getElementById: () => null,
        querySelector: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, textContent: '' }),
        head: { appendChild() {} },
        body: { getAttribute: () => 'off' },
    };
    global.window = global;

    // 每次重新求值，避免缓存住上一次的 window.MPGateBar
    delete require.cache[require.resolve(SRC)];
    require(SRC);
    const api = global.MPGateBar;
    if (!api) throw new Error('gatebar.js 未挂载 window.MPGateBar');
    return api;
}

const gate = (over) => Object.assign({
    id: 'cost-track', env: 'PROXY_COST_TRACK', label: '成本记账',
    on: true, unknown: false, reason: null, shadow: false, impact: '',
    evidence: { available: true, hits: 0, unit: '笔', lastAt: null, unknown: false, source: '~/.multi-proxy-manager/cost-ledger.jsonl', detail: 'x' },
}, over);

describe('gatebar — 环境证据渲染（evTail / evCell）', () => {
    let api;
    beforeAll(() => { api = loadGatebar(); });

    it('有正数时 chip 后缀带数字和单位', () => {
        expect(api.evTail(gate({ evidence: { available: true, hits: 1054, unit: '笔', unknown: false } })))
            .toBe(' · 1054 笔');
    });

    it('0 次不在 chip 上挂后缀（避免 13 项全挂「0 次」把真数字淹掉）', () => {
        expect(api.evTail(gate({ evidence: { available: true, hits: 0, unit: '笔', unknown: false } }))).toBe('');
    });

    it('证据读不到时明说「读不到」，不当作 0 也不留空', () => {
        expect(api.evTail(gate({ evidence: { available: true, hits: null, unknown: true } })))
            .toBe(' · 证据读不到');
    });

    it('无采集点时 chip 不加后缀（采不到只在明细里说）', () => {
        expect(api.evTail(gate({ evidence: { available: false, hits: null, unknown: false } }))).toBe('');
    });

    it('明细表：有正数走绿、0 走琥珀、读不到走灰、无采集点写「无采集点」且带「不代表性」口径', () => {
        const hit = api.evCell({ available: true, hits: 5, unit: '笔', unknown: false, detail: '已入账 5 笔', source: '~/ledger' });
        expect(hit).toContain('ev-hit');
        expect(hit).toContain('已入账 5 笔');
        expect(hit).toContain('~/ledger');       // 证据必须可核对，路径要露出来

        expect(api.evCell({ available: true, hits: 0, unit: '笔', unknown: false, detail: '账本为空' }))
            .toContain('ev-zero');

        expect(api.evCell({ available: true, hits: null, unknown: true, detail: '读取失败' }))
            .toContain('ev-mute');

        const none = api.evCell({ available: false, hits: null, unknown: false, detail: '' });
        expect(none).toContain('无采集点');
    });
});

describe('gatebar — 成本姿态 chip 不许把「空转」画成绿', () => {
    let api;
    beforeAll(() => { api = loadGatebar(); });

    const cost = (ev, on) => [gate({ on, evidence: ev })];

    it('真入账时：绿 + 显示笔数（这是唯一能拿出交付证据的地方）', () => {
        const html = api.leadChips(cost({ available: true, hits: 1054, unit: '笔', unknown: false }, true), {});
        expect(html).toContain('已开');
        expect(html).toContain('真入账 1054 笔');
        expect(html).toContain('gate-chip-on');
    });

    it('🔴 开着但零入账：必须是琥珀「空转」，不许画绿（否则「已开」被读成「已在记账」）', () => {
        const html = api.leadChips(cost({ available: true, hits: 0, unit: '笔', unknown: false }, true), {});
        expect(html).toContain('空转');
        expect(html).toContain('0 笔入账');
        expect(html).toContain('gate-chip-shadow');
        // 关键：不能落成绿。看 chip 后跟的 state 类名
        expect(html).not.toMatch(/成本追踪 · 已开<\/span>/);
    });

    it('采不到证据时写「无运行证据」，不猜成零也不猜成有', () => {
        const html = api.leadChips(cost({ available: false, hits: null, unknown: false }, true), {});
        expect(html).toContain('无运行证据');
    });

    it('门控关闭时仍说「关闭」（证据不该盖过开关状态）', () => {
        const html = api.leadChips(cost({ available: true, hits: 999, unit: '笔', unknown: false }, false), {});
        expect(html).toContain('关闭');
        expect(html).not.toContain('真入账 999');
    });
});

describe('gatebar — 源码级守卫（防止整段说明被删）', () => {
    const src = fs.readFileSync(SRC, 'utf8');

    it('折叠区必须保留「无采集点不代表没生效」的口径说明', () => {
        // 这一列存在的意义就是区分「没跑过」和「采不到」。少了这句话，
        // 「无采集点」会被读成「没生效」——那就等于把这个误读换了个位置又造一个。
        expect(src).toMatch(/无采集点[\s\S]{0,80}不代表它没生效/);
    });

    it('改动方式必须区分默认开/默认关（对默认开的项写 =1 是空操作）', () => {
        expect(src).toContain('PROXY_XXX=0');
        expect(src).toContain('空操作');
    });

    it('明细表必须渲染 evidence 列（列被删掉则证据无从核对）', () => {
        expect(src).toContain('evCell(g.evidence)');
    });

    it('影子标记只在真的开着时出现（var shadow = g.shadow && g.on）', () => {
        // 少这个 &&，关着的影子项会被标「影子·只记录」，与格阵/明细表互相打架。
        expect(src).toContain('var shadow = g.shadow && g.on');
    });
});

describe('gatebar — 门控格阵（M2「一张图」）', () => {
    let api;
    beforeAll(() => { api = loadGatebar(); });

    const g = (over) => Object.assign({ label: 'x', on: true, unknown: false, shadow: false, evidence: null }, over);

    it('五态各有自己的类名（开着有证据 / 开着无数据 / 关 / 读不到 / 影子）', () => {
        expect(api.gmClass(g({ on: true, evidence: { available: true, unknown: false, hits: 7 } }))).toBe('gm-on-hit');
        expect(api.gmClass(g({ on: true, evidence: { available: true, unknown: false, hits: 0 } }))).toBe('gm-on-idle');
        expect(api.gmClass(g({ on: true, evidence: null }))).toBe('gm-on-idle');
        expect(api.gmClass(g({ on: false }))).toBe('gm-off');
        expect(api.gmClass(g({ on: null, unknown: true }))).toBe('gm-unknown');
        expect(api.gmClass(g({ on: true, shadow: true }))).toBe('gm-shadow');
    });

    it('每个门控项都渲染成一个格子（不抽样、不省略）', () => {
        const list = [g({ label: 'a' }), g({ label: 'b', on: false }), g({ label: 'c', on: null, unknown: true })];
        const html = api.gateMatrix(list);
        expect((html.match(/gm-cell/g) || []).length).toBe(3);
    });

    it('aria-label 给的是结论而不是空壳（读屏用户拿得到「几项开几项关」）', () => {
        const html = api.gateMatrix([g({ on: true }), g({ on: false })]);
        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label');
        expect(html).toMatch(/已开启/);
        expect(html).toMatch(/未开启/);
    });

    it('关着的影子项必须报 gm-off（没开就别说「只记录」——它一次都没跑）', () => {
        // 2026-11-08 抓到的自相矛盾：orchestration 的 shadow:true + on:false，
        // chip 那侧把它标成琥珀「影子·只记录」，格阵这侧标灰「关闭」，同一条状态条两种答案。
        // shadow 的语义是「开了也只记账不动路由」，不是「现在正在影子运行」。
        expect(api.gmClass(g({ on: false, shadow: true }))).toBe('gm-off');
    });

    it('格子必须有 title（悬停能知道是哪一项、什么状态）', () => {
        const html = api.gateMatrix([g({ label: '成本记账', evidence: { available: true, unknown: false, hits: 9, unit: '笔' } })]);
        expect(html).toContain('title=');
        expect(html).toContain('成本记账');
        expect(html).toContain('9 笔');
    });
});
