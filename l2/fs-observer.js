// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

/**
 * L2 公共模块：文件层观测（fs-observer）
 *
 * 定位：请求层账本记「花了多少钱」，本模块记「动了哪些文件」。两者同目录、同 JSONL，
 * 可以按同一条时间线对账。这是 costgate 与纯网关类工具（magpie / Astra Gate）分开的那一层：
 * 它们只看请求，看不到文件系统。
 *
 * 归因（谁改的）分三档，**绝不猜**：
 *   high    —— 文件落在一个 agent 进程的 cwd 之下，且只有一个候选
 *   medium  —— 多个候选时，只有其中一个在最近 120s 内发过请求（读 cost-ledger），仍然唯一
 *   unknown —— 以上都不成立，照实记 unknown，不写「大概是」
 *
 * 为什么不做精确 pid 归因：`fs.watch` 只给路径不给 pid；要 pid 只能上 `fs_usage`，
 * 那需要 sudo。本地自用不接受 sudo，所以归因天然是概率性的，档位必须写进账本，
 * 让读账的人自己判断这条能不能用。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_DIR = path.join(os.homedir(), '.multi-proxy-manager');
const LEDGER_NAME = 'fs-ledger.jsonl';
const COST_LEDGER_NAME = 'cost-ledger.jsonl';
const REQ_WINDOW_MS = 3 * 60 * 1000;

const IGNORE_RE = new RegExp(
  [
    '(^|/)(node_modules|\\.git|logs|dist|build|\\.next|\\.nuxt|__pycache__|\\.venv|venv|\\.cache)(/|$)',
    '\\.(log|tmp|swp|swo|lock|pid)$',
    '(^|/)\\.DS_Store$',
    '\\.verify-probe',
    '(^|/)\\.multi-proxy-manager/',
  ].join('|')
);

const CMD_RULES = [
  { agent: 'codex', re: /(^|[\s/])codex(\.js|c)?(\s|$)|@openai\/codex/i },
  { agent: 'claude', re: /(^|[\s/])claude(\.js)?(\s|$)|@anthropic-ai\/claude-code/i },
  { agent: 'opencode', re: /(^|[\s/])opencode(\s|$)|opencode-ai/i },
  { agent: 'cursor', re: /Cursor\.app\/Contents\/(MacOS|Frameworks)/i },
  { agent: 'dsh', re: /(^|[\s/])dsh(\.js)?(\s|$)|DSH\.app\/Contents\//i },
  { agent: 'hermes', re: /(^|[\s/])hermes(\s|$)/i },
];

// 这些命令行里出现 agent 名字不算 agent 进程：代理本身、编辑器插件、本工具
const CMD_EXCLUDE = /(-proxy|fs-observer|codebuddy|workbuddy|grep|rg\s)/i;

function isUnder(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 从命令行判断这条进程是不是某个 agent；不是则返回 null */
function matchAgent(cmd) {
  if (!cmd || CMD_EXCLUDE.test(cmd)) return null;
  for (const r of CMD_RULES) {
    if (r.re.test(cmd)) return r.agent;
  }
  return null;
}

/** 事件类型：文件不存在=delete，其余按 watcher 给的 rename/change 归一 */
function normalizeEvent(kind, exists) {
  if (!exists) return 'delete';
  return kind === 'rename' ? 'create' : 'modify';
}

/**
 * 归因。procs: [{pid, agent, cwd}]；recentReqs: {agent: lastTsMs}
 * 返回 {agent, confidence, why}，不确定一律 unknown。
 */
function attribute(absPath, tsMs, procs, recentReqs) {
  const candidates = (procs || []).filter((p) => p.cwd && isUnder(absPath, p.cwd));
  if (candidates.length === 1) {
    return { agent: candidates[0].agent, confidence: 'high', why: `cwd:${candidates[0].cwd}` };
  }
  if (candidates.length > 1) {
    const recent = candidates.filter(
      (p) => recentReqs && recentReqs[p.agent] && tsMs - recentReqs[p.agent] <= REQ_WINDOW_MS
    );
    if (recent.length === 1) {
      return { agent: recent[0].agent, confidence: 'medium', why: 'cwd+recent-request' };
    }
    return {
      agent: null,
      confidence: 'unknown',
      why: `ambiguous:${candidates.map((c) => c.agent).sort().join('|')}`,
    };
  }
  // 没有 cwd 证据（agent 进程刚退出 / 抓不到进程表）时，退到请求时间窗：
  // 谁在最近 3 分钟内发过请求，谁就是改文件的那个。仍然要求唯一。
  const recentAgents = Object.entries(recentReqs || {})
    .filter(([, t]) => Number.isFinite(t) && tsMs - t >= 0 && tsMs - t <= REQ_WINDOW_MS)
    .map(([a]) => a);
  if (recentAgents.length === 1) {
    return { agent: recentAgents[0], confidence: 'medium', why: 'recent-request-only' };
  }
  if (recentAgents.length > 1) {
    return {
      agent: null,
      confidence: 'unknown',
      why: `no-cwd;recent:${recentAgents.sort().join('|')}`,
    };
  }
  return { agent: null, confidence: 'unknown', why: 'no-cwd-match' };
}

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 进程快照：只跑一次 ps，再对有 cwd 需求的 pid 各跑一次 lsof。
 * 拿不到进程表（沙箱 EPERM / ps 不存在）时返回空数组，不抛：归因会降级成 unknown，
 * 但「谁改了哪个文件」照样记账——少一档证据，不少一条记录。
 */
function snapshotAgents(cb) {
  let settled = false;
  const finish = (list) => {
    if (settled) return;
    settled = true;
    cb(null, list || []);
  };
  try {
    execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return finish([]);
      const found = [];
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid) continue;
        const agent = matchAgent(m[2]);
        if (agent) found.push({ pid, agent, cmd: m[2].slice(0, 200) });
      }
      if (found.length === 0) return finish([]);
      let pending = found.length;
      for (const p of found) {
        const settleOne = () => {
          if (--pending === 0) finish(found.filter((x) => x.cwd));
        };
        try {
          execFile('lsof', ['-p', String(p.pid), '-a', '-d', 'cwd', '-Fn', '-w'], (e2, out2) => {
            if (!e2 && out2) {
              const line = out2.split('\n').find((l) => l.startsWith('n'));
              if (line) p.cwd = line.slice(1);
            }
            settleOne();
          });
        } catch (e) {
          settleOne();
        }
      }
    });
  } catch (e) {
    finish([]);
  }
}

/** 最近 N 分钟各 agent 最后一次请求时间，用于多个 cwd 候选时二次筛选 */
function recentRequestsByAgent(ledgerPath, windowMs = 30 * 60 * 1000, now = Date.now()) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 5000; i--) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const t = Date.parse(o.ts);
    if (!Number.isFinite(t) || now - t > windowMs) continue;
    const agent = String(o.agent || o.proxy || '').replace(/-proxy$/, '');
    if (!agent) continue;
    if (!out[agent] || out[agent] < t) out[agent] = t;
  }
  return out;
}

/** 自动发现要观测的仓库：~/Documents/AI项目 下含 .git 的目录，按 .git 修改时间取前 N 个 */
function discoverRoots(baseDir = path.join(os.homedir(), 'Documents', 'AI项目'), limit = 8) {
  let names;
  try {
    names = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = [];
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const gitDir = path.join(baseDir, d.name, '.git');
    try {
      const st = fs.statSync(gitDir);
      repos.push({ root: path.join(baseDir, d.name), mtime: st.mtimeMs });
    } catch {
      /* 不是 git 仓库，跳过 */
    }
  }
  return repos.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((r) => r.root);
}

/** 只读文件开头若干字节，避免为了拿一行 session_meta 把几十 MB 的 rollout 全读进来 */
function readHead(file, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 从 codex 的会话记录里读「最近在哪些目录干过活」。
 *
 * 为什么需要这一路：`fs.watch` 只给路径，`ps`/`lsof` 在某些环境（沙箱、权限收紧）拿不到，
 * 那样归因会永远落到 unknown。而 codex 的 rollout 第一行就带 `payload.cwd`，
 * 读一行就能知道它最近的工作目录——比抓进程可靠，也不需要它此刻正在跑。
 */
function recentSessionCwds({ home = os.homedir(), days = 7, maxFiles = 40 } = {}) {
  const base = path.join(home, '.codex', 'sessions');
  const cut = Date.now() - days * 86400000;
  const files = [];
  (function collect(dir, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        collect(p, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs >= cut) files.push({ file: p, mtime: st.mtimeMs });
      }
    }
  })(base, 0);

  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const seen = new Set();
  for (const f of files.slice(0, maxFiles)) {
    const head = readHead(f.file, 32768);
    const line = head.split('\n').find((l) => l.includes('"session_meta"'));
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = o && o.payload && o.payload.cwd;
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ agent: 'codex', cwd, ts: f.mtime });
  }
  return out;
}

/**
 * WorkBuddy 的会话目录是以 cwd 编码命名的（/ → -）。所以不用反解路径，
 * 直接拿观测根去正向比对：目录存在，就说明这个 agent 在这个仓库里干过活。
 */
function workbuddyCwds(roots, { home = os.homedir() } = {}) {
  const base = path.join(home, '.workbuddy', 'projects');
  const out = [];
  for (const r of roots || []) {
    // 目录名去掉开头的 / 再把 / 换成 -：/Users/x/a → Users-x-a
    const enc = path.resolve(r).replace(/^\//, '').replace(/\//g, '-');
    const p = path.join(base, enc);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) out.push({ agent: 'workbuddy', cwd: path.resolve(r), ts: st.mtimeMs, from: 'session' });
    } catch {
      /* 没有会话目录，跳过 */
    }
  }
  return out;
}

/** 合并两路 cwd 证据：正在跑的进程优先，会话记录补位（同目录同 agent 只留一条） */
function mergeProcEvidence(procs, sessions) {
  const out = (procs || []).slice();
  const key = (p) => `${p.agent}|${p.cwd}`;
  const have = new Set(out.map(key));
  for (const s of sessions || []) {
    if (have.has(key(s))) continue;
    have.add(key(s));
    out.push({ ...s, from: 'session' });
  }
  return out;
}

function createObserver(opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const ledger = path.join(dir, LEDGER_NAME);
  const costLedger = path.join(dir, COST_LEDGER_NAME);
  const roots = opts.roots && opts.roots.length ? opts.roots : discoverRoots();
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 250;
  const snapTtlMs = opts.snapTtlMs != null ? opts.snapTtlMs : 3000;

  const watchers = [];
  const pending = new Map();
  let snap = [];
  let snapAt = 0;
  let refreshing = false;
  let sessionCache = { at: 0, list: [] };
  let reqCache = { at: 0, map: {} };
  let written = 0;
  let skipped = 0;
  let stopped = false;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建账本目录 ${dir}: ${e.message}`);
  }

  function refreshSnapshot() {
    if (refreshing) return;
    if (Date.now() - snapAt < snapTtlMs) return;
    refreshing = true;
    // 会话目录变化慢，30 秒刷一次就够，免得每个文件事件都去翻 rollout 文件头。
    if (Date.now() - sessionCache.at > 30000) {
      try {
        sessionCache = { at: Date.now(), list: [...recentSessionCwds(), ...workbuddyCwds(roots)] };
      } catch {
        sessionCache = { at: Date.now(), list: [] };
      }
    }
    const sessions = sessionCache.list;
    snapshotAgents((err, list) => {
      refreshing = false;
      snap = mergeProcEvidence(err ? [] : list, sessions);
      snapAt = Date.now();
    });
  }

  function refreshRequests() {
    if (Date.now() - reqCache.at < 30000) return;
    reqCache = { at: Date.now(), map: recentRequestsByAgent(costLedger) };
  }

  function emit(absPath, kind) {
    if (IGNORE_RE.test(absPath)) {
      skipped++;
      return;
    }
    let st = null;
    try {
      st = fs.statSync(absPath);
    } catch {
      st = null;
    }
    const event = normalizeEvent(kind, !!st);
    const tsMs = Date.now();
    refreshSnapshot();
    refreshRequests();
    const a = attribute(absPath, tsMs, snap, reqCache.map);
    const rec = {
      ts: new Date(tsMs).toISOString(),
      localDay: localDay(new Date(tsMs)),
      path: absPath,
      event,
      size: st ? st.size : 0,
      agent: a.agent,
      confidence: a.confidence,
      why: a.why,
    };
    try {
      fs.appendFileSync(ledger, JSON.stringify(rec) + '\n');
      written++;
    } catch {
      /* 写不进账本不该弄崩 agent 的活，静默跳过，stats 里能看出来 */
    }
  }

  function schedule(absPath, kind) {
    const prev = pending.get(absPath);
    if (prev) clearTimeout(prev.timer);
    // 同一文件连续事件只保留最后一个 kind：delete 优先级最高
    const nextKind = kind === 'rename' && prev && prev.kind === 'rename' ? 'rename' : kind;
    const timer = setTimeout(() => {
      pending.delete(absPath);
      emit(absPath, nextKind);
    }, debounceMs);
    pending.set(absPath, { kind: nextKind, timer });
  }

  function start() {
    for (const root of roots) {
      try {
        const w = fs.watch(root, { recursive: true, persistent: true }, (kind, filename) => {
          if (!filename) return;
          schedule(path.join(root, filename.toString()), kind);
        });
        w.on('error', () => {});
        watchers.push(w);
      } catch (e) {
        // 目录不存在或权限不足：跳过，不阻断其它根目录
      }
    }
    refreshSnapshot();
    return { roots, ledger, watching: watchers.length };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const [p, v] of pending) {
      clearTimeout(v.timer);
      emit(p, v.kind);
    }
    pending.clear();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* 已关闭 */
      }
    }
    watchers.length = 0;
  }

  function stats() {
    return { roots, watching: watchers.length, written, skipped, agents: snap.length };
  }

  return { start, stop, stats, emit, _paths: { ledger, costLedger } };
}

/** 读账本，按天或按时间窗过滤 */
function readLedger({ dir = DEFAULT_DIR, day, sinceMs, path: onlyPath } = {}) {
  const ledger = path.join(dir, LEDGER_NAME);
  let raw;
  try {
    raw = fs.readFileSync(ledger, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (day && o.localDay !== day) continue;
    if (sinceMs && Date.parse(o.ts) < sinceMs) continue;
    if (onlyPath && !o.path.includes(onlyPath)) continue;
    out.push(o);
  }
  return out;
}

module.exports = {
  DEFAULT_DIR,
  LEDGER_NAME,
  COST_LEDGER_NAME,
  IGNORE_RE,
  matchAgent,
  normalizeEvent,
  isUnder,
  attribute,
  localDay,
  snapshotAgents,
  recentSessionCwds,
  workbuddyCwds,
  mergeProcEvidence,
  recentRequestsByAgent,
  discoverRoots,
  createObserver,
  readLedger,
};
