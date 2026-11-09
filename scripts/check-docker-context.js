#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
//
// 镜像构建上下文体检：每个 Dockerfile 的 COPY 源，真的会在构建上下文里出现吗？
//
// 为什么要这条（2026-11-09）：
//   Dockerfile.lite-mvp 的注释自称「对外可 build 的最小形态」，但它靠
//   `COPY cursor-proxy/dist` —— 而 .dockerignore 里写着 `dist`，且 cursor-proxy/dist
//   根本不入库（它是 tsc 产物）。也就是说：从干净 clone 构建这个镜像**必然失败**，
//   而这行注释已经在那儿挂了很久，没人发现，因为没人真去 build 过。
//
//   这类问题的共同点：**只对外部用户失败**。维护者机器上 dist 存在、node_modules 装好了，
//   所以本地永远看不出。与「孤儿依赖」同一个病根（见 scripts/check-prod-deps.js）。
//
// 判据（两条，分别对应两种失败原因）：
//   ① 源路径在版本控制里存在吗（git ls-files 命中，或目录下有入库文件）
//   ② 源路径会不会被 .dockerignore 排除（被排除 = 即使磁盘上有也不进上下文）
//
// 用法：
//   node scripts/check-docker-context.js            # 有违规则 rc=1
//   node scripts/check-docker-context.js --verbose  # 每条 COPY 都打出来
//
// 已知问题登记在 scripts/docker-context-allow.txt，一行一条：
//   <Dockerfile>  <源路径>  <理由>
// 登记过的不算失败，但每次都会打印出来——它是一条待还的债，不是一个开关。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const ALLOW_FILE = path.join(ROOT, 'scripts', 'docker-context-allow.txt');

function gitLsFiles(args) {
  try {
    return execFileSync('git', ['ls-files', ...args], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null; // 不是 git 仓
  }
}

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  // 源码包分发时没有 .git：本检查答不了「入不入库」，必须明说，不能冒充通过
  console.error('✗ 这里没有 .git，无法判断文件是否入库 —— 本次不算通过。');
  process.exit(2);
}

const tracked = gitLsFiles(['--cached', '-z']);
const trackedList = tracked && tracked.length ? gitLsFiles([]) : [];
if (!trackedList || trackedList.length === 0) {
  console.error('✗ 从 git 读不到文件清单 —— 本次不算通过。');
  process.exit(2);
}
const trackedSet = new Set(trackedList);

// .dockerignore 的简易匹配：只处理本仓实际用到的形态
// （目录名、`*.ext`、具体路径前缀），不做完整的 Docker 匹配语义。
const ignorePatterns = fs.existsSync(path.join(ROOT, '.dockerignore'))
  ? fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  : [];

function ignoredBy(src) {
  const p = src.replace(/^\.\//, '');
  const base = path.basename(p);
  for (const pat of ignorePatterns) {
    const clean = pat.replace(/^\//, '');
    if (clean === p) return pat;
    if (clean.includes('*') && clean.startsWith('*.')) {
      if (base.endsWith(clean.slice(1))) return pat;
      continue;
    }
    if (clean.includes('*')) continue; // 其它通配：本仓未用，跳过不误报
    if (p === clean || p.startsWith(clean + '/')) return pat;
    if (base === clean) return pat;
  }
  return null;
}

function inRepo(src) {
  const p = src.replace(/^\.\//, '').replace(/\/+$/, '');
  if (trackedSet.has(p)) return true;
  const prefix = p + '/';
  for (const t of trackedSet) if (t.startsWith(prefix)) return true;
  return false;
}

// 允许清单
const allow = new Map();
if (fs.existsSync(ALLOW_FILE)) {
  for (const line of fs.readFileSync(ALLOW_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [df, src, ...rest] = t.split(/\s{2,}|\t/);
    if (!df || !src) continue;
    allow.set(`${df} ${src}`, (rest.join(' ') || '').trim());
  }
}

const dockerfiles = fs
  .readdirSync(ROOT)
  .filter((f) => /^Dockerfile(\..+)?$/.test(f))
  .sort();

if (dockerfiles.length === 0) {
  console.log('（仓库里没有 Dockerfile，跳过）');
  process.exit(0);
}

let checked = 0;
const problems = [];
const known = [];

for (const df of dockerfiles) {
  const lines = fs.readFileSync(path.join(ROOT, df), 'utf8').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!/^(COPY|ADD)\s/.test(line)) return;
    if (/^(COPY|ADD)\s+--from=/.test(line)) return; // 从前一阶段拷，与上下文无关
    const tokens = line.split(/\s+/).slice(1).filter((t) => !t.startsWith('--'));
    if (tokens.length < 2) return;
    const sources = tokens.slice(0, -1);
    for (const src of sources) {
      checked++;
      // `package-lock.json*` 这类通配：退化成前缀判断
      const isGlob = src.endsWith('*');
      const bare = isGlob ? src.slice(0, -1) : src;
      const exists = isGlob
        ? [...trackedSet].some((t) => t.startsWith(bare.replace(/^\.\//, '')))
        : inRepo(bare);
      const ign = ignoredBy(bare.replace(/\/+$/, ''));
      const reasons = [];
      if (!exists) reasons.push('版本控制里没有这个路径（干净 clone 上不存在）');
      if (ign) reasons.push(`.dockerignore 里被 “${ign}” 排除（即使磁盘上有也不进上下文）`);
      const why = reasons.length ? reasons.join('；') : null;
      if (!why) {
        if (VERBOSE) console.log(`  ✓ ${df}:${i + 1} ${src}`);
        continue;
      }
      const key = `${df} ${bare}`;
      if (allow.has(key)) known.push({ df, line: i + 1, src, why, reason: allow.get(key) });
      else problems.push({ df, line: i + 1, src, why });
    }
  });
}

console.log(`\n检查了 ${dockerfiles.length} 个 Dockerfile 里的 ${checked} 条 COPY 源。`);

if (known.length) {
  console.log(`\n已登记的问题（${known.length} 条，不算通过也不算失败，但每次都会提醒）：`);
  for (const k of known) {
    console.log(`  ~ ${k.df}:${k.line} ${k.src}`);
    console.log(`      原因：${k.why}`);
    console.log(`      登记理由：${k.reason || '（没写理由 —— 补上，否则下一个人不知道该不该修）'}`);
  }
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} 条 COPY 源在构建上下文里拿不到：`);
  for (const p of problems) console.error(`    ${p.df}:${p.line}  ${p.src}\n        ${p.why}`);
  console.error('\n  三种修法：');
  console.error('    1. 该文件应该入库 → 去掉 .gitignore 里那条，或改成构建时生成（多阶段 build）');
  console.error('    2. 不该入库但构建需要 → 在 Dockerfile 里加构建阶段自己产出它');
  console.error('    3. 确实暂时修不了 → 写进 scripts/docker-context-allow.txt 并写清理由');
  console.error('\n  为什么这条重要：这类失败只发生在**别人的机器 + docker build** 上，');
  console.error('  维护者本地永远看不出（dist 在、node_modules 在）。而 Dockerfile 里那句');
  console.error('  「对外可 build」会让外部用户以为是自己环境坏了。');
  process.exit(1);
}

if (known.length) {
  console.log(`\n✓ 没有新问题。但上面 ${known.length} 条已登记的仍然存在 —— 不算通过，只是不算新账。`);
} else {
  console.log('\n✓ 所有 COPY 源都能在构建上下文里拿到。');
}
process.exit(0);
