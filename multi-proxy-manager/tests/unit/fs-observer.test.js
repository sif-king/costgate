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


describe('fs-observer · WorkBuddy 会话目录', () => {
    test('按 cwd 编码匹配仓库根（去前导斜杠、斜杠换横杠）', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wb-'));
        fs.mkdirSync(path.join(home, '.workbuddy', 'projects', 'Users-x-Documents-proj'), { recursive: true });
        const r = obs.workbuddyCwds(['/Users/x/Documents/proj'], { home });
        expect(r.length).toBe(1);
        expect(r[0].agent).toBe('workbuddy');
        expect(r[0].cwd).toBe('/Users/x/Documents/proj');
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('没有对应会话目录就返回空，不瞎猜', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wb2-'));
        const r = obs.workbuddyCwds(['/Users/x/nope'], { home });
        expect(r).toEqual([]);
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('验收探针文件不进账本', () => {
        expect(obs.IGNORE_RE.test('/p/.verify-probe-123.txt')).toBe(true);
    });

    test('测试产物不进账本（跑一次 E2E 不该塞几十条「文件改动」）', () => {
        expect(obs.IGNORE_RE.test('/p/multi-proxy-manager/test-results/a/error.md')).toBe(true);
        expect(obs.IGNORE_RE.test('/p/playwright-report/index.html')).toBe(true);
        // 业务文件不能被误伤
        expect(obs.IGNORE_RE.test('/p/multi-proxy-manager/tests/unit/a.test.js')).toBe(false);
        expect(obs.IGNORE_RE.test('/p/l2/report.js')).toBe(false);
    });

    test('workbuddyCwdFor：命中文件自己的祖先目录，而不只是观测根', () => {
        // 这条修的是真亏损：文章体系 / Portico 是各自独立的 git 仓库，
        // 不在观测根那一层，于是它们下面的改动一天里有八成落成 unknown。
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wb3-'));
        fs.mkdirSync(path.join(home, '.workbuddy', 'projects', 'Users-x-Documents-art'), { recursive: true });
        const got = obs.workbuddyCwdFor('/Users/x/Documents/art/2026/post.md', { home });
        expect(got).toBe('/Users/x/Documents/art');
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('workbuddyCwdFor：没有会话目录就返回 null，不瞎猜', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wb4-'));
        expect(obs.workbuddyCwdFor('/Users/x/nowhere/a.md', { home })).toBe(null);
        fs.rmSync(home, { recursive: true, force: true });
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
