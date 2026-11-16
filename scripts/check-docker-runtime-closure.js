#!/usr/bin/env node
// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.
//
// 镜像「运行时闭包」体检：镜像里跑 `node xxx.js`，它 require 出去的每个文件，
// 真的在镜像里的**那个路径**上吗？
//
// 为什么要这条（2026-11-17）：同一个病根咬了三次，每次都是「构建全绿、容器起来立刻 MODULE_NOT_FOUND」：
//   ① Dockerfile.manager 漏 COPY l2/ 与 packs/，还把 manager 落到 /app/manager
//      （应是 /app/multi-proxy-manager，否则 packs/sandbox-egress 里的 ../../multi-proxy-manager 对不上）
//   ② Dockerfile.codex 漏 COPY l2/（proxy.js 有 require('../l2/circuit-breaker.js')）
//   ③ 补了 l2 又炸在 require('../tools/token-policy-bridge.js')，它再拉 packs/curator/policies/*
//   与 check-docker-context.js 同一个病根：**只对外部用户失败**，维护者本机永远看不出。
//   那条守「COPY 的源在不在上下文里」，这条守另一端「代码要去哪儿找，镜像有没有放那儿」。
//
// 判据（关键：不许自证循环）
//   ① 从 Dockerfile 的 CMD 入口出发，递归解析相对 require/import，得到运行时闭包 + 边（谁 require 谁）；
//   ② 用 COPY 规则把每个仓库文件映射成**镜像绝对路径**；
//   ③ 逐条边比对：从「require 方」的镜像路径按相对关系推出去，必须恰好等于「被 require 方」的镜像路径。
//      —— 两边都由 COPY 决定，所以「目录名落错」一定暴露：不能靠同一条 COPY 自证。
//   ④ 闭包里没有 COPY 覆盖的文件单独报（漏 COPY）。
//
// 用法：
//   node scripts/check-docker-runtime-closure.js             # 有违规则 rc=1
//   node scripts/check-docker-runtime-closure.js --verbose    # 逐条边都打出来
//   node scripts/check-docker-runtime-closure.js --root DIR   # 体检另一棵树（测试用）
//
// 刻意不做的（避免用「猜」代替「判」）：
//   - 只认 CommonJS `require('…')` 与 ESM `import … from '…'` 的相对路径；动态拼路径看不见
//   - `COPY --from=<stage>` 的源在别的构建阶段，无法追，涉及这些文件的边一律跳过
//   - Python 服务（hermes-proxy）不做 import 图分析，跳过并打印原因

const fs = require('fs');
const path = require('path');

const argRoot = process.argv.indexOf('--root');
const ROOT = path.resolve(argRoot > -1 ? process.argv[argRoot + 1] : path.join(__dirname, '..'));
const VERBOSE = process.argv.includes('--verbose');
const posix = path.posix;

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function parseDockerfile(text) {
  const copies = [];
  let workdir = '/';
  let cmd = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const w = line.match(/^WORKDIR\s+(\S+)/i);
    if (w) {
      workdir = posix.isAbsolute(w[1]) ? posix.normalize(w[1]) : posix.normalize(posix.join(workdir, w[1]));
      continue;
    }
    if (/^COPY\s/i.test(line)) {
      let body = line.replace(/^COPY\s+/i, '').trim();
      let from = null;
      const fm = body.match(/^--from=(\S+)\s+/);
      if (fm) {
        from = fm[1];
        body = body.slice(fm[0].length).trim();
      }
      body = body.replace(/^--\S+\s+/g, '').trim();
      let parts;
      if (body.startsWith('[')) {
        try {
          parts = JSON.parse(body);
        } catch {
          continue;
        }
      } else {
        parts = body.split(/\s+/).filter(Boolean);
      }
      if (parts.length < 2) continue;
      const dest = parts[parts.length - 1];
      const srcs = parts.slice(0, -1).map((x) => x.replace(/\/+$/, ''));
      copies.push({ srcs, dest, from, workdir });
      continue;
    }
    const c = line.match(/^CMD\s+(.+)$/i);
    if (c) cmd = c[1];
  }
  return { copies, workdir, cmd };
}

function copyDestAbs(c) {
  return posix.isAbsolute(c.dest) ? posix.normalize(c.dest) : posix.normalize(posix.join(c.workdir, c.dest));
}

/** 仓库文件 → 镜像绝对路径（后出现的 COPY 覆盖前面的，与 docker 行为一致） */
function buildImageMap(copies) {
  const rules = [];
  for (const c of copies) {
    if (c.from) continue;
    const destAbs = copyDestAbs(c);
    for (const src of c.srcs) rules.push({ srcAbs: path.join(ROOT, src), destAbs });
  }
  return function imageOf(repoAbs) {
    let hit = null;
    for (const r of rules) {
      if (repoAbs === r.srcAbs) continue;
      if (!repoAbs.startsWith(r.srcAbs + path.sep)) continue;
      const relToSrc = path.relative(r.srcAbs, repoAbs).split(path.sep).join('/');
      hit = posix.normalize(posix.join(r.destAbs, relToSrc));
    }
    return hit;
  };
}

/** 闭包 + 边 */
function collectClosure(entryAbs) {
  const seen = new Set();
  const edges = [];
  const missing = [];
  const stack = [entryAbs];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(js|cjs|mjs)$/.test(file)) continue;
    const src = readText(file);
    if (src == null) continue;
    const specs = [];
    for (const m of src.matchAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), spec);
      const target = ['', '.js', '.cjs', '.mjs', '.json', '/index.js']
        .map((ext) => base + ext)
        .find((p) => isFile(p));
      edges.push({ from: file, spec, to: target || null });
      if (!target) missing.push(`${spec}  ← ${path.relative(ROOT, file)}`);
      else stack.push(target);
    }
  }
  return { files: seen, edges, missing };
}

function checkDockerfile(dfPath) {
  const name = path.basename(dfPath);
  const text = readText(dfPath);
  if (text == null) return { name, skip: '读不到' };
  const { copies, workdir, cmd } = parseDockerfile(text);
  if (!cmd) return { name, skip: '没有 CMD' };

  let parts;
  try {
    parts = JSON.parse(cmd);
  } catch {
    parts = cmd.split(/\s+/);
  }
  const entry = parts.find((x) => /\.(js|cjs|mjs|py)$/.test(String(x)));
  if (!entry) return { name, skip: 'CMD 里没有脚本入口' };
  if (/\.py$/.test(entry)) return { name, skip: 'Python 服务，不做 import 图分析' };

  // 入口两种写法：相对服务目录（proxy.js / dist/index.js）或相对仓库根（multi-proxy-manager/server.js）
  const entryAsRepo = path.join(ROOT, entry);
  let svc = null;
  for (const c of copies) {
    if (c.from) continue;
    for (const src of c.srcs) {
      const srcAbs = path.join(ROOT, src);
      let inner = null;
      if (isFile(path.join(srcAbs, entry))) inner = entry;
      else if (isFile(entryAsRepo) && entryAsRepo.startsWith(srcAbs + path.sep)) {
        inner = path.relative(srcAbs, entryAsRepo).split(path.sep).join('/');
      }
      if (inner && (!svc || src.length > svc.rel.length)) svc = { srcAbs, rel: src, inner };
    }
  }
  if (!svc) return { name, skip: `找不到 COPY 提供入口 ${entry}` };

  const entryAbs = path.join(svc.srcAbs, svc.inner);
  const { files, edges, missing } = collectClosure(entryAbs);
  const imageOf = buildImageMap(copies);

  const problems = [];
  const checked = [];

  // ④ 漏 COPY：闭包里的仓库文件没有被任何 COPY 覆盖
  for (const f of files) {
    if (path.relative(ROOT, f).startsWith('..')) continue;
    if (!imageOf(f)) problems.push(`${path.relative(ROOT, f)} → 没有被任何 COPY 覆盖`);
  }

  // ③ 逐边比对镜像路径
  for (const e of edges) {
    if (!e.to) continue;
    const fromImg = imageOf(e.from);
    const toImg = imageOf(e.to);
    if (!fromImg || !toImg) continue; // 已由「漏 COPY」或 --from 阶段覆盖
    const relToTarget = path.relative(path.dirname(e.from), e.to).split(path.sep).join('/');
    const expected = posix.normalize(posix.join(posix.dirname(fromImg), relToTarget));
    const ok = expected === toImg;
    checked.push({ edge: `${path.relative(ROOT, e.from)} → ${path.relative(ROOT, e.to)}`, expected, toImg, ok });
    if (!ok) {
      problems.push(
        `${path.relative(ROOT, e.from)} 在镜像里是 ${fromImg}，按相对路径它要找 ${expected}，` +
          `但被 require 的文件实际在 ${toImg}`
      );
    }
  }

  for (const m of missing) problems.push(`解析不到：${m}`);

  const entryImg = imageOf(entryAbs);
  return {
    name,
    entry: entryImg || '(未覆盖)',
    files: files.size,
    checked,
    problems,
  };
}

function main() {
  const dockerfiles = fs
    .readdirSync(ROOT)
    .filter((f) => /^Dockerfile(\..+)?$/.test(f))
    .map((f) => path.join(ROOT, f))
    .sort();
  if (!dockerfiles.length) {
    console.error('✗ 没找到任何 Dockerfile');
    process.exit(1);
  }
  let failed = 0;
  for (const df of dockerfiles) {
    const r = checkDockerfile(df);
    if (r.skip) {
      console.log(`- ${r.name}: 跳过（${r.skip}）`);
      continue;
    }
    if (r.problems.length) {
      failed++;
      console.log(`✗ ${r.name}（入口 ${r.entry}，闭包 ${r.files} 个文件）`);
      for (const p of r.problems) console.log(`    ${p}`);
    } else {
      console.log(
        `✓ ${r.name}（入口 ${r.entry}，闭包 ${r.files} 个文件，${r.checked.length} 条相对依赖边全部对得上）`
      );
    }
    if (VERBOSE) for (const c of r.checked) console.log(`    ${c.ok ? '·' : '✗'} ${c.edge}: ${c.expected}`);
  }
  if (failed) {
    console.log(`\n${failed} 个 Dockerfile 的运行时闭包对不上 ⇒ 镜像能构建，容器起来会 MODULE_NOT_FOUND。`);
    process.exit(1);
  }
  console.log('\n运行时闭包全部对得上。');
}

main();
