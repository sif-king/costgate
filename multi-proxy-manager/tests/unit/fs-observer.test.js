// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const obs = require('../../../l2/fs-observer.js');

describe('fs-observer · 进程识别', () => {
    test('认得 codex / claude / opencode 的命令行', () => {
        expect(obs.matchAgent('/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
        expect(obs.matchAgent('/opt/homebrew/bin/claude --dangerously-skip-permissions')).toBe('claude');
        expect(obs.matchAgent('/usr/local/bin/opencode')).toBe('opencode');
    });

    test('代理进程本身不算 agent（cmd 里含 -proxy）', () => {
        expect(obs.matchAgent('node /Users/x/costgate/codex-proxy/proxy.js')).toBeNull();
        expect(obs.matchAgent('node /Users/x/costgate/claude-proxy/proxy.js')).toBeNull();
    });

    test('编辑器/检索工具不算 agent', () => {
        expect(obs.matchAgent('grep claude')).toBeNull();
        expect(obs.matchAgent('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy')).toBeNull();
    });
});

describe('fs-observer · 路径与事件', () => {
    test('isUnder 认子路径不认同名前缀', () => {
        expect(obs.isUnder('/a/b/c.txt', '/a/b')).toBe(true);
        expect(obs.isUnder('/a/bc/c.txt', '/a/b')).toBe(false);
        expect(obs.isUnder('/a/b', '/a/b')).toBe(true);
    });

    test('文件不存在一律判 delete', () => {
        expect(obs.normalizeEvent('rename', false)).toBe('delete');
        expect(obs.normalizeEvent('rename', true)).toBe('create');
        expect(obs.normalizeEvent('change', true)).toBe('modify');
    });

    test('噪声目录与临时文件被忽略', () => {
        expect(obs.IGNORE_RE.test('/p/node_modules/x/index.js')).toBe(true);
        expect(obs.IGNORE_RE.test('/p/.git/HEAD')).toBe(true);
        expect(obs.IGNORE_RE.test('/p/a.log')).toBe(true);
        expect(obs.IGNORE_RE.test('/p/src/index.js')).toBe(false);
    });
});

describe('fs-observer · 归因三档', () => {
    const now = Date.parse('2026-11-13T04:00:00Z');

    test('单候选 = high', () => {
        const r = obs.attribute('/proj/a/x.js', now, [{ pid: 1, agent: 'codex', cwd: '/proj/a' }], {});
        expect(r).toEqual({ agent: 'codex', confidence: 'high', why: 'cwd:/proj/a' });
    });

    test('多个 cwd 候选，只有最近请求过的那个 = medium', () => {
        const procs = [
            { pid: 1, agent: 'codex', cwd: '/proj/a' },
            { pid: 2, agent: 'claude', cwd: '/proj/a' },
        ];
        const r = obs.attribute('/proj/a/x.js', now, procs, { codex: now - 5000 });
        expect(r.agent).toBe('codex');
        expect(r.confidence).toBe('medium');
    });

    test('多个候选都没有近期请求 = unknown，不猜', () => {
        const procs = [
            { pid: 1, agent: 'codex', cwd: '/proj/a' },
            { pid: 2, agent: 'claude', cwd: '/proj/a' },
        ];
        const r = obs.attribute('/proj/a/x.js', now, procs, {});
        expect(r.agent).toBeNull();
        expect(r.confidence).toBe('unknown');
        expect(r.why).toBe('ambiguous:claude|codex');
    });

    test('没有 cwd 匹配 = unknown', () => {
        const r = obs.attribute('/elsewhere/x.js', now, [{ pid: 1, agent: 'codex', cwd: '/proj/a' }], {});
        expect(r.confidence).toBe('unknown');
        expect(r.why).toBe('no-cwd-match');
    });
});

describe('fs-observer · 真观测（临时目录端到端）', () => {
    let tmpRoot;
    let tmpLedger;
    let ob;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-observe-'));
        tmpLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ledger-'));
        ob = obs.createObserver({ roots: [tmpRoot], dir: tmpLedger, debounceMs: 60, snapTtlMs: 0 });
        ob.start();
    });

    afterEach(() => {
        if (ob) ob.stop();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(tmpLedger, { recursive: true, force: true });
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    test('新建文件会落进账本，且带置信档位', async () => {
        const f = path.join(tmpRoot, 'hello.js');
        fs.writeFileSync(f, 'const a = 1;\n');
        await sleep(400);
        const recs = obs.readLedger({ dir: tmpLedger });
        const hit = recs.find((r) => r.path === f);
        expect(hit).toBeTruthy();
        expect(['create', 'modify']).toContain(hit.event);
        expect(['high', 'medium', 'unknown']).toContain(hit.confidence);
        expect(typeof hit.ts).toBe('string');
    });

    test('node_modules 里的改动不进账本', async () => {
        const d = path.join(tmpRoot, 'node_modules', 'pkg');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'index.js'), 'x\n');
        await sleep(400);
        const recs = obs.readLedger({ dir: tmpLedger });
        expect(recs.some((r) => r.path.includes('node_modules'))).toBe(false);
    });

    test('删文件记成 delete', async () => {
        const f = path.join(tmpRoot, 'gone.js');
        fs.writeFileSync(f, 'x\n');
        await sleep(250);
        fs.rmSync(f);
        await sleep(400);
        const recs = obs.readLedger({ dir: tmpLedger });
        expect(recs.some((r) => r.path === f && r.event === 'delete')).toBe(true);
    });
});
