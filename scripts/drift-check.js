#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
'use strict';

/**
 * drift-check.js — 文档↔代码「存在性」漂移守卫（L5 落差防线 2.0，最小版）
 *
 * 抓的病（2026-10-29 铁证 B）：文档比代码落后 14 天。下一个 agent 照旧文档会去改
 *   已删/已做的东西。本守卫与 `stale-map-check.js`（git-diff 驱动的「改到哪要更新哪」）
 *   互补——它不读 diff，只问「文档在 backtick 里点名的文件/符号，在当前真树里还在不在」。
 *   路径已删 / `file:line` 指向的行已不存在 / 文档宣称的符号在代码里查无 → 漂移 = 红。
 *
 * 设计取向（对齐 gap-guard run.js）：启发式，会误报，所以每条都带 `doc:line ← ref`
 *   让人当场核实，不让人盲信。宁可多报一条让人看一眼，也别漏掉一个「文档说还在、其实没了」。
 *
 * 用法：
 *   node scripts/drift-check.js                 扫默认 watch-list，有漂移即 exit 1
 *   node scripts/drift-check.js --warn         有漂移也只 warn（exit 0）——CI 基线期用
 *   node scripts/drift-check.js --scan <glob>  覆盖 watch-list（递归 glob，node 端展开）
 *   node scripts/drift-check.js --selftest     对内建 fixture 跑一遍（已知漂移必红）
 *   node scripts/drift-check.js --root <dir>   改仓库根（默认脚本所在目录的上一级）
 *
 * 忽略机制（防历史文档淹没）：
 *   - 跳过 scripts/drift-ignore.txt 里列的「已知历史/有意保留」ref（每行一个 glob 或字串）
 *   - 默认跳过 agent-infra/（跨仓，属另一仓库）与 MEMORY/ 前缀、archive/ 目录下的历史产物
 *
 * 退出码：0 = 无漂移或 --warn；1 = 有漂移未 --warn；2 = --selftest 发现自检失败。
 */

const fs = require('fs');
const path = require('path');

// ---------- CLI ----------
const argv = process.argv.slice(2);
let WARN = false;
let SELFTEST = false;
let EXACT = false;
let SCAN = null;
let ROOT = path.resolve(path.join(__dirname, '..'));
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--warn') WARN = true;
  else if (a === '--selftest') SELFTEST = true;
  else if (a === '--exact') EXACT = true;
  else if (a === '--scan') SCAN = argv[++i] || null;
  else if (a === '--root') ROOT = path.resolve(argv[++i] || '.');
  else if (a === '--json') process.env.DRIFT_JSON = '1';
}

const IGNORE_FILE = path.join(ROOT, 'scripts', 'drift-ignore.txt');

// 仅这些后缀的 backtick token 才当「代码/文档引用」（其余当散文滤掉，降误报）
const EXTS = ['js', 'ts', 'tsx', 'py', 'sh', 'html', 'css', 'json', 'md', 'go', 'rs', 'java', 'yaml', 'yml'];
const EXT_RE = new RegExp('\\.(' + EXTS.join('|') + ')$', 'i');

// 默认 watch-list：只盯「会被下一个 agent 照抄」的核心交付文档，不扫全树（防噪声）。
// 🔴 只许放**入库**文档。CI 的 verify-delivery job 在干净 checkout 上跑本脚本，列一个
//    .gitignore 掉的本地私有件进去（docs/INDEX.md / docs/RELEASE-CHECKLIST.md / PROJECT-STATE/），
//    结果是「watch-list 文档本身缺失」在 CI 恒红、本地恒绿 —— 两边看到的现象完全不同，
//    谁都不信这个门禁。assertWatchTracked() 就是防这件事的：本地跑也会红。
const DEFAULT_WATCH = [
  'docs/01-feature-matrix.md',
  'README.md',
];

// ---------- ref 解析 ----------

/** 把 backtick 内的裸 token 判成「类代码引用」并归一化（去掉 :line / 通配 *）。 */
function isCodeRef(tok) {
  if (!tok || /\s/.test(tok)) return false;                // 任一空格 = 命令/散文，非路径
  if (/^https?:\/\//i.test(tok) || tok.startsWith('//')) return false;   // URL
  if (/[<>]/.test(tok)) return false;                                    // 模板占位符（<agent>/<reader>-to-<target> 之类），非真文件名
  if (tok.startsWith('agent-infra/')) return false;        // 跨仓（属 agent-infra 仓）
  if (tok.startsWith('MEMORY-') || tok.includes('/archive/')) return false; // 历史产物
  // 形如 a/b.js:123 取冒号前；带通配尾（*.service 之类）去掉星号再核存在
  const base = tok.split(':')[0];
  if (!base) return false;
  if (/[?*]/.test(base)) return false;                        // 通配/glob（l2/*.js 等），非具体文件，存在性不可核对
  if (/^\.[A-Za-z0-9]+$/.test(base)) return false;            // 裸扩展名（.html/.js），是散文不是路径
  if (EXT_RE.test(base)) return true;
  // 以 / 或 . 结尾的 token（如 l2/）也算引用
  if (/[/.]$/.test(base)) return true;
  return false;
}

/** glob（含 * ? []）是否匹配一个字串路径。手写最小匹配，避免引 minimatch。 */
function globMatch(g, s) {
  const rx = new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$');
  return rx.test(s);
}

function loadIgnore() {
  const out = [];
  if (fs.existsSync(IGNORE_FILE)) {
    for (const raw of fs.readFileSync(IGNORE_FILE, 'utf8').split('\n')) {
      const l = raw.trim();
      if (l && !l.startsWith('#')) out.push(l);
    }
  }
  return out;
}

function ignored(ref, ignore) {
  return ignore.some((g) => globMatch(g, ref) || ref === g || ref.startsWith(g));
}

/** 收集一份文档里的 backtoken，逐条核对存在性 + 行界。返回 drift 列表。
 *  root/pathIdx 可覆盖（自测用）。
 *  回退匹配语义：文档引用 `lib/consent.js` 这类裸名时，按根解析不到不代表「没了」——
 *  只要全树里 basename/后缀还能撞上（如 multi-proxy-manager/lib/consent.js），就不报；
 *  仅当整个树都找不到才判「引用已删」。--exact 关掉回退，只认根解析（更严、噪声更多）。 */
// 只跳过「纯缓存/易变产物」（node_modules 等）；dist/build/archive 里也可能被文档合法引用，
// 纳入索引只会让「引用是否还在」判得更准（少报假阳性），且不会产生新漂移（漂移仅在「全树都找不到」时报）。
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'out']);

function buildPathIndex(root, ignore) {
  const idx = new Set();
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel || '.')); }
    catch (e) { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) { idx.add((rel ? rel + '/' : '') + e + '/'); continue; }
      const full = rel ? rel + '/' + e : e;
      let st;
      try { st = fs.statSync(path.join(root, full)); }
      catch (err) { continue; }
      idx.add(full);
      if (st.isDirectory()) {
        idx.add(full + '/');
        const norm = full + '/';
        const ig = ignore.some((g) => globMatch(g, norm) || norm.startsWith(g.replace(/\/$/, '')));
        if (!ig) walk(full);
      }
    }
  };
  walk('');
  return idx;
}

// base 是否在任意路径里对得上。命中即「文档指的东西还在」，不报漂移。
function existsAny(base, pathIdx, exact) {
  const bslash = base.replace(/\/$/, '');
  const rootHit = pathIdx.has(base) || pathIdx.has(bslash) || pathIdx.has(bslash + '/');
  if (rootHit) return true;
  if (exact) return false;
  const name = bslash.split('/').pop();
  for (const p of pathIdx) {
    if (!name) { if (base.endsWith('/') && p.startsWith(base)) return true; continue; }
    if (p === bslash) return true;
    if (p.endsWith('/' + name)) return true;   // 同名（同根或更深）
    if (base.endsWith('/') && p.startsWith(base)) return true; // 目录前缀
  }
  return false;
}

/** 收集一份文档里的 backtoken，逐条核对存在性 + 行界。返回 drift 列表。root/pathIdx 可覆盖（自测用）。 */
function checkDoc(docPath, ignore, root, pathIdx) {
  root = root || ROOT;
  pathIdx = pathIdx || buildPathIndex(root, ignore);
  const abs = path.join(root, docPath);
  if (!fs.existsSync(abs)) {
    // watch-list 里的文档自己都不在了——这是最强的一级漂移（清单指向了幽灵）
    return [{ doc: docPath, line: 0, ref: docPath, reason: 'watch-list 文档本身缺失' }];
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const drift = [];
  lines.forEach((line, idx) => {
    const tokens = (line.match(/`([^`]+)`/g) || [])
      .map((m) => m.slice(1, -1).trim())
      .filter(isCodeRef);
    for (const t of tokens) {
      const hasLine = /:\d+$/.test(t);
      const base = t.split(':')[0].replace(/[*]+$/, ''); // 通配尾去掉核对存在
      if (ignored(base, ignore)) continue;
      // 绝对路径（兄弟仓/本机）、~ 家目录、$ 环境变量：跨仓或运行时引用，超出本守卫「本仓文档↔本仓代码」职责，跳过
      if (base.startsWith('/') || base.startsWith('~') || base.startsWith('$')) continue;
      const atRoot = fs.existsSync(path.join(root, base));
      const gone = !atRoot && !existsAny(base, pathIdx, EXACT); // 全树都找不到才判「没了」
      if (hasLine) {
        if (!atRoot) {
          // 行号引用：根解析不到时，仅在全树也找不到才报（同名他处的行号不可比，跳过）
          if (gone) drift.push({ doc: docPath, line: idx + 1, ref: t, reason: '引用文件已删除' });
          continue;
        }
        const ln = parseInt(t.split(':').pop(), 10);
        const nLines = fs.readFileSync(path.join(root, base), 'utf8').split('\n').length;
        if (ln > nLines) {
          drift.push({ doc: docPath, line: idx + 1, ref: t, reason: `行 ${ln} 超出文件行数 ${nLines}（行号/符号已移位）` });
        }
      } else if (base.endsWith('/')) {
        // 目录引用：根解析不到且全树无此前缀 → 漂移
        if (gone) drift.push({ doc: docPath, line: idx + 1, ref: base, reason: '引用目录已不存在' });
      } else {
        // 文件引用：根解析不到且全树 basename/后缀无同名 → 漂移
        if (gone) drift.push({ doc: docPath, line: idx + 1, ref: base, reason: '引用文件已删除' });
      }
    }
  });
  return drift;
}

// 极简 glob 展开：'docs/**/*.md' → 递归收集。只支持 ** 和 * 两段，够用。
function expandGlob(pattern) {
  const segs = pattern.split('/');
  const out = [];
  const walk = (dir, i) => {
    if (i === segs.length) {
      if (fs.existsSync(path.join(ROOT, dir)) && fs.statSync(path.join(ROOT, dir)).isFile()) out.push(dir);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir ? path.join(ROOT, dir) : path.join(ROOT)); }
    catch (e) { return; }
    for (const e of entries) {
      const pat = segs[i];
      let re;
      if (pat === '**') {
        // ** 可跨多层：递归当前 + 所有子目录
        const sub = dir ? path.join(dir, e) : e;
        if (fs.statSync(path.join(ROOT, sub)).isDirectory()) walk(sub, i); // 同层继续
        walk(sub, i + 1);
      } else {
        re = new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
        if (re.test(e)) walk(dir ? path.join(dir, e) : e, i + 1);
      }
    }
  };
  walk('', 0);
  return out;
}

function collectDocs() {
  let files;
  if (SCAN) {
    files = expandGlob(SCAN);
  } else {
    const found = [];
    for (const e of DEFAULT_WATCH) {
      const abs = path.join(ROOT, e);
      const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
      if (st && st.isDirectory()) found.push(...expandGlob(path.join(e, '**/*.md')));
      else found.push(e);
    }
    files = found;
  }
  return files;
}

/**
 * watch-list 里每一项都必须真的在版本控制里。
 * 病根不是「文件丢了」，是**本地有、CI checkout 没有**：本地跑永远绿、CI 永远红，
 * 而且两边现象完全不同（本地一句提示都没有），于是没人能从任一侧推出真相。
 * 只对默认 watch-list 生效；--scan 是临时指定，不做此检查。
 * .git 不存在（源码包/归档分发）→ 返回 null 表示「查不了」，由调用方明说，不算通过。
 */
function assertWatchTracked() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return null;
  const { spawnSync } = require('child_process');
  const bad = [];
  for (const e of DEFAULT_WATCH) {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', e], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) bad.push(e);
  }
  return bad;
}

// ---------- 自检 ----------

function selftest() {
  const failures = [];
  const cases = [
    // token → 期望是不是 code-ref
    ['`server.js`', true],
    ['`lib/consent.js`', true],
    ['`docs/foo.md`', true],
    ['`a/b.js:123`', true],
    ['`public/index.html`', true],
    ['`MEMORY-2026-01-01.md`', false],   // 历史产物，不当引用
    ['https://x.com/a/b.js', false],      // URL
    ['这是一个普通句子', false],
    ['`node_modules/foo`', false],       // EXT_RE 不命中且非目录 → false（node_modules 无扩展名尾）
  ];
  for (const [tok, want] of cases) {
    const got = isCodeRef(tok.startsWith('`') ? tok.slice(1, -1).trim() : tok);
    if (got !== want) failures.push(`isCodeRef(${tok})=${got}, want ${want}`);
  }
  // 目录尾的 `x/` 算引用
  if (isCodeRef('l2/') !== true) failures.push('dir ref l2/ 应算引用');
  // 行超界 + 文件删除 + 回退命中：在临时 ROOT 下构造 fixture，避免向仓库写测试产物
  const tmpRoot = fs.mkdtempSync(require('os').tmpdir() + '/drift-self-');
  fs.mkdirSync(path.join(tmpRoot, 'sub'));
  fs.writeFileSync(path.join(tmpRoot, 'sub', 'real.js'), 'x');
  fs.writeFileSync(path.join(tmpRoot, 'self.md'), '见 `one.md:99`、`ghost.js`、`sub/real.js`');
  fs.writeFileSync(path.join(tmpRoot, 'one.md'), 'only one line');
  const tIdx = buildPathIndex(tmpRoot, []);
  const d = checkDoc('self.md', [], tmpRoot, tIdx);
  // one.md:99 → 行超界（行 1 但引用第 99 行）；ghost.js → 引用文件已删除；sub/real.js → 根命中，不报
  const goneRefs = d.map((x) => x.ref);
  if (!d.some((x) => x.reason.startsWith('行'))) failures.push('行超界未被检出: ' + JSON.stringify(d));
  if (!d.some((x) => x.reason === '引用文件已删除')) failures.push('已删除引用未被检出: ' + JSON.stringify(d));
  if (goneRefs.includes('sub/real.js')) failures.push('回退命中误报（sub/real.js 应解析到）: ' + JSON.stringify(d));
  // glob
  const gm = globMatch('a/*.md', 'a/b.md');
  if (gm !== true) failures.push('globMatch a/*.md vs a/b.md');
  if (globMatch('a/?.md', 'a/bb.md') === true) failures.push('globMatch ? 不应跨多字');

  if (failures.length) {
    console.error('[drift-check] selftest FAIL:');
    for (const f of failures) console.error('   ' + f);
    process.exit(2);
  }
  console.log('[drift-check] selftest OK（isCodeRef / 行超界 / glob 通过）');
  process.exit(0);
}

// ---------- 主 ----------

if (SELFTEST) { selftest(); }

const ignore = loadIgnore();
const docs = collectDocs();
const pathIdx = buildPathIndex(ROOT, ignore); // 全树路径索引（存在性回退匹配）
const allDrift = [];
if (!SCAN) {
  const untracked = assertWatchTracked();
  if (untracked === null) {
    // 不算通过：明说没跑，别让「没检查」长得像「检查过了」
    process.stderr.write('⚠️  没有 .git，跳过「watch-list 是否入库」检查（未检查，不算通过）\n');
  } else {
    for (const u of untracked) {
      allDrift.push({ doc: u, line: 0, ref: u, reason: 'watch-list 项不在版本控制里（干净 checkout 上必报「文档缺失」）' });
    }
  }
}
for (const d of docs) allDrift.push(...checkDoc(d, ignore, ROOT, pathIdx));

if (process.env.DRIFT_JSON) {
  console.log(JSON.stringify({ root: ROOT, docs: docs.length, drift: allDrift.length, items: allDrift, ignoreFile: IGNORE_FILE }, null, 2));
  process.exit(WARN ? 0 : (allDrift.length ? 1 : 0));
}

console.log(`文档↔代码存在性漂移守卫 · 根 ${ROOT}`);
console.log('='.repeat(60));
console.log(`watch-list：${docs.length} 份文档，忽略规则 ${ignore.length} 条（${IGNORE_FILE}）`);
if (!allDrift.length) {
  console.log('✅ 无漂移：所有文档引用的文件/目录/行都在当前真树。');
  process.exit(0);
}
console.log('');
console.log(`🔴 命中 ${allDrift.length} 条漂移（文档引用了树里已不存在的东西）：`);
console.log('');
for (const x of allDrift) {
  console.log(`  [${x.reason}] ${x.doc}:${x.line || '(缺文档)'} ← \`${x.ref}\``);
}
console.log('');
console.log('注：启发式，会误报。命中即代表「文档在指一个已不存在的东西」，请当场核实是否要更新文档/或进 drift-ignore.txt。');
process.exit(WARN ? 0 : 1);
