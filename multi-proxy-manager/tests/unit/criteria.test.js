// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const criteria = require('../../../l2/criteria.js');

function mkRepo(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-crit-'));
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    return root;
}

describe('criteria · C-001 声称≠实现', () => {
    test('文档声称 failover，代码里没有 → fail', () => {
        const root = mkRepo({
            'README.md': '# x\n\n本仓支持 failover，上游挂了自动换。\n',
            'src/a.js': 'module.exports = 1;\n',
        });
        const r = criteria.criterionClaimedNotImplemented({ root });
        expect(r.verdict).toBe('fail');
        expect(r.evidence.join(' ')).toContain('failover');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('文档写「没有 failover」不算声称', () => {
        const root = mkRepo({
            'README.md': '# x\n\n核心网关是单次转发，没有 failover。\n',
            'src/a.js': 'module.exports = 1;\n',
        });
        const r = criteria.criterionClaimedNotImplemented({ root });
        expect(r.verdict).toBe('pass');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('声称了，代码里也有 → pass', () => {
        const root = mkRepo({
            'README.md': '# x\n\n支持 failover。\n',
            'src/failover.js': '// failover logic\nmodule.exports = () => {};\n',
        });
        const r = criteria.criterionClaimedNotImplemented({ root });
        expect(r.verdict).toBe('pass');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('criteria · C-002 门控口径', () => {
    test('文档写默认开，门控实际默认关 → fail', () => {
        const root = mkRepo({
            'README.md': '# x\n\n`PROXY_DEMO` 默认开，装上就有。\n',
            'multi-proxy-manager/lib/gates.js':
                "module.exports = { GATES: [{ id: 'demo', env: 'PROXY_DEMO', kind: 'opt-in' }] };\n",
        });
        const r = criteria.criterionGateWording({ root });
        expect(r.verdict).toBe('fail');
        expect(r.evidence.join(' ')).toContain('PROXY_DEMO');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('「门控 X 默认关 / shadow 默认开」不会把 shadow 的默认开算到门控头上', () => {
        const root = mkRepo({
            'docs/03-architecture/a.md': '| 编排 | 门控 `PROXY_DEMO` 默认关 / shadow 默认开 |\n',
            'multi-proxy-manager/lib/gates.js':
                "module.exports = { GATES: [{ id: 'demo', env: 'PROXY_DEMO', kind: 'opt-in' }] };\n",
        });
        const r = criteria.criterionGateWording({ root });
        expect(r.verdict).toBe('pass');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('历史记录（PROJECT-STATE）不参与判定', () => {
        const root = mkRepo({
            'PROJECT-STATE/2026-01-01.md': '`PROXY_DEMO` 默认开\n',
            'multi-proxy-manager/lib/gates.js':
                "module.exports = { GATES: [{ id: 'demo', env: 'PROXY_DEMO', kind: 'opt-in' }] };\n",
        });
        const r = criteria.criterionGateWording({ root });
        expect(r.verdict).toBe('skip');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('criteria · C-003 引用可达', () => {
    test('行号超出文件总行数 → fail', () => {
        const root = mkRepo({
            'README.md': '见 `src/a.js:99`。\n',
            'src/a.js': 'line1\nline2\n',
        });
        const r = criteria.criterionRefReachable({ root });
        expect(r.verdict).toBe('fail');
        expect(r.evidence.join(' ')).toContain('超出文件行数');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('行号在范围内 → pass', () => {
        const root = mkRepo({
            'README.md': '见 `src/a.js:2`。\n',
            'src/a.js': 'line1\nline2\n',
        });
        const r = criteria.criterionRefReachable({ root });
        expect(r.verdict).toBe('pass');
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('裸文件名不算路径引用', () => {
        const root = mkRepo({
            'README.md': '这个逻辑在 forward.js 里（不给出处的叙述）。\n',
        });
        const r = criteria.criterionRefReachable({ root });
        expect(r.verdict).toBe('skip');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('criteria · runAll 形状', () => {
    test('每条至少吐 id/title/verdict/evidence，不只吐一个分', () => {
        const root = mkRepo({ 'README.md': '# x\n' });
        const res = criteria.runAll({ root });
        expect(res.results.length).toBe(3);
        for (const r of res.results) {
            expect(r.id).toMatch(/^C-00\d$/);
            expect(typeof r.title).toBe('string');
            expect(['pass', 'fail', 'skip']).toContain(r.verdict);
            expect(Array.isArray(r.evidence)).toBe(true);
        }
        expect(res.pass + res.fail + res.skip).toBe(3);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
