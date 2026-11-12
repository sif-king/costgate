// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// 当 github.com:443 连不上而 api.github.com 正常时，用 REST API 把本地 HEAD 快进到远端。
// 只处理「远端是本地祖先」的快进情形；不是快进就报错退出，不硬来。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.REPO || 'sif-king/costgate';
const ROOT = process.env.REPO_ROOT || process.cwd();
const TOKEN = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token']).toString().trim();
const API = 'https://api.github.com';

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

    // 只允许快进：远端必须是本地祖先，否则说明有别人的提交，不能覆盖
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', remoteSha, localHead], { cwd: ROOT });
    } catch {
        throw new Error('不是快进：远端有本地没有的提交，别用这个脚本覆盖');
    }

    const files = git('diff', '--name-only', `${remoteSha}..${localHead}`).split('\n').filter(Boolean);
    if (!files.length) {
        console.log('没有文件差异');
        return;
    }
    console.log('待上传：', files.length, '个文件');

    const baseTree = (await call('GET', `/repos/${REPO}/git/commits/${remoteSha}`)).tree.sha;
    const tree = [];
    for (const f of files) {
        const abs = path.join(ROOT, f);
        if (!fs.existsSync(abs)) {
            console.log('  跳过（本地已删除）：', f);
            continue;
        }
        const content = fs.readFileSync(abs).toString('base64');
        const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
        const mode = fs.statSync(abs).mode & 0o111 ? '100755' : '100644';
        tree.push({ path: f, mode, type: 'blob', sha: blob.sha });
        const localSha = execFileSync('git', ['hash-object', f], { cwd: ROOT }).toString().trim();
        if (localSha !== blob.sha) throw new Error(`blob 不一致：${f}（本地 ${localSha.slice(0, 7)}，远端 ${blob.sha.slice(0, 7)}）`);
        console.log('  上传', f, blob.sha.slice(0, 7));
    }

    const newTree = await call('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
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
