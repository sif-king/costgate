// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 当 github.com:443 连不上而 api.github.com 正常时，用 REST API 把本地 HEAD 同步到远端 main。
//
// 两种情形都支持：
//   ① 快进：远端是本地祖先 → 走原来的 diff 逻辑；
//   ② 分叉：远端 SHA 本地根本没有（上一次也是用本脚本推的，提交对象是 API 现造的，
//      本地历史里不存在这个 SHA）→ 改为**逐 blob 比对两棵树**算差异。
//      这种情况早先版本直接报错退出，于是「网络一断就只能等」。
//
// 安全边界：本脚本会打印「远端独有、本地没有」的文件；有这类文件时必须人工确认
// 它们确实该删（默认只报告并继续，加 --strict 则直接退出）。
// 每个上传的 blob 都用 git hash-object 与 API 返回的 sha 逐字节核对，不一致立刻停。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.REPO || 'sif-king/costgate';
const ROOT = process.env.REPO_ROOT || process.cwd();
const TOKEN = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token']).toString().trim();
const API = 'https://api.github.com';
const STRICT = process.argv.includes('--strict');

async function call(method, url, body) {
    const res = await fetch(API + url, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'costgate-push',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        /* 非 JSON 响应 */
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    return json;
}

(async () => {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT }).toString().trim();

    const localHead = git('rev-parse', 'HEAD');
    const remote = await call('GET', `/repos/${REPO}/git/ref/heads/main`);
    const remoteSha = remote.object.sha;
    console.log('remote main:', remoteSha.slice(0, 7), 'local HEAD:', localHead.slice(0, 7));

    if (remoteSha === localHead) {
        console.log('已经一致，无需推送');
        return;
    }

    // 远端 tree（recursive）→ path -> blob sha
    const remoteCommit = await call('GET', `/repos/${REPO}/git/commits/${remoteSha}`);
    const remoteTreeRes = await call('GET', `/repos/${REPO}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
    const remoteMap = new Map();
    for (const e of remoteTreeRes.tree || []) {
        if (e.type === 'blob') remoteMap.set(e.path, e.sha);
    }

    // 本地 tree → path -> {mode, sha}
    // core.quotePath=false：不加这个，中文路径会被转成 \346\234\252 形式，与 API 的 UTF-8 对不上，
    // 结果是「整棵树的文件名都算差异」（本轮真踩过，白比对一次）。
    const lsOut = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', localHead], { cwd: ROOT }).toString();
    const localMap = new Map();
    for (const line of lsOut.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        const meta = line.slice(0, tab).split(' ');
        localMap.set(line.slice(tab + 1), { mode: meta[0], sha: meta[2] });
    }

    const upserts = [];
    for (const [p, info] of localMap) {
        if (remoteMap.get(p) !== info.sha) upserts.push({ path: p, mode: info.mode });
    }
    const deletes = [];
    for (const p of remoteMap.keys()) if (!localMap.has(p)) deletes.push(p);

    console.log(`本地 ${localMap.size} 个文件，远端 ${remoteMap.size} 个；待上传 ${upserts.length}，远端独有 ${deletes.length}`);
    if (deletes.length) {
        // 远端独有 = 这次同步会让它们消失。必须看得见，不能静默删。
        console.log('🔴 远端独有（本次同步会从远端移除）：');
        for (const p of deletes.slice(0, 40)) console.log('   -', p);
        if (deletes.length > 40) console.log(`   …还有 ${deletes.length - 40} 个`);
        if (STRICT) throw new Error('远端有本地没有的文件，--strict 下不继续');
    }
    if (!upserts.length && !deletes.length) {
        console.log('两棵树逐 blob 一致，只是提交不同，直接用远端 SHA 做父提交重建即可');
    }

    const tree = [];
    for (const f of upserts) {
        const abs = path.join(ROOT, f.path);
        const content = fs.readFileSync(abs).toString('base64');
        const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
        tree.push({ path: f.path, mode: f.mode, type: 'blob', sha: blob.sha });
        const localSha = execFileSync('git', ['hash-object', abs], { cwd: ROOT }).toString().trim();
        if (localSha !== blob.sha) {
            throw new Error(`blob 不一致：${f.path}（本地 ${localSha.slice(0, 7)}，远端 ${blob.sha.slice(0, 7)}）`);
        }
        console.log('  上传', f.path, blob.sha.slice(0, 7));
    }
    // 删除：tree 条目里 sha 给 null 即表示移除
    for (const p of deletes) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

    const newTree = await call('POST', `/repos/${REPO}/git/trees`, { base_tree: remoteCommit.tree.sha, tree });
    const message = git('log', '-1', '--pretty=%B', localHead);
    const commit = await call('POST', `/repos/${REPO}/git/commits`, {
        message,
        tree: newTree.sha,
        parents: [remoteSha],
    });
    await call('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: false });
    console.log('已推送（API）：', commit.sha.slice(0, 7));
    console.log('\n注意：本地与远端 SHA 已分叉（内容相同）。网络恢复后跑：');
    console.log('  git fetch origin && git reset --hard origin/main');
})().catch((e) => {
    console.error('失败：', e.message);
    process.exit(1);
});
