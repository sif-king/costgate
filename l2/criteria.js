// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

/**
 * L2 公共模块：判据引擎（criteria）
 *
 * 只放「机器能判、不许交模型」的判据。三条，全部来自真实亏损：
 *
 *   C-001 声称≠实现   文档说有的能力，代码里必须有落点。
 *                     来历：README 曾写「没有 failover / 重试 / 熔断」，而五个代理都接了熔断器；
 *                     GitHub 描述写「多 Agent 编排中枢」，而编排默认是影子模式。外部模型照此
 *                     连着判错两轮。判据只管事实，不管措辞好不好听。
 *   C-002 门控口径一致  文档写「默认开 / 默认关」，必须与 gates.js 的 kind 对得上。
 *                     来历：面板写「默认开」而 gates 缺省是关，等于状态条说谎。
 *   C-003 引用可达    文档里的 `path:line` 必须指得到真实文件和行。
 *                     来历：搬文档后行号整体漂移，读者按图索骥全落空。
 *
 * 输出形状固定：{id, title, verdict: pass|fail|skip, evidence[]}。
 * 不许只吐一个分——「8 分不通过」没法让 agent 改。
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'logs', '.cache', 'coverage', 'vendor']);

// 文档里出现即视为「声称有能力」的词，以及它在代码里该有的落点
const CAPABILITIES = [
  { key: 'failover', label: 'failover / 失败自动切换', doc: /failover|失败自动切/i, code: /failover/i },
  { key: 'circuit-breaker', label: '熔断', doc: /熔断|circuit.?breaker/i, code: /circuit-?breaker|createRecommendedBreaker|CircuitBreaker/i },
  { key: 'round-robin', label: '轮询 / round-robin', doc: /round.?robin|轮询/i, code: /round.?robin|roundRobin/i },
  { key: 'retry', label: '重试', doc: /重试|retry/i, code: /retry|http-retry/i },
  { key: 'redact', label: '出网脱敏', doc: /脱敏|redact/i, code: /redact/i },
  { key: 'orchestration', label: '编排', doc: /编排|orchestrat/i, code: /orchestrat/i },
  { key: 'budget', label: '预算 / 限额', doc: /预算|budget|限额/i, code: /budget/i },
];

// 否定语境：匹配点前面出现这些词，就不算「声称」
const NEGATION = /(没有|未实现|不做|不支持|尚无|还没|缺失|无|不提供|不包含|nor|not)\s*[^。\n]{0,12}$/i;

function walk(root, exts, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, exts, out, depth + 1);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 统计某正则在文本里「肯定语境」命中的次数 */
function countPositive(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  let m;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (!NEGATION.test(before)) n++;
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return n;
}

function criterionClaimedNotImplemented({ root }) {
  const docs = [
    path.join(root, 'README.md'),
    path.join(root, 'llms.txt'),
    path.join(root, 'SECURITY.md'),
  ].filter((p) => fs.existsSync(p));
  if (!docs.length) {
    return { id: 'C-001', title: '声称≠实现', verdict: 'skip', evidence: ['没找到 README.md / llms.txt，跳过'] };
  }
  const codeFiles = walk(root, ['.js', '.ts', '.mjs', '.py', '.swift']);
  // 逐文件累加，不拼大字符串：1590 个文件拼起来会把内存打爆（实测 SIGKILL）。
  const codeHits = new Map(CAPABILITIES.map((c) => [c.key, 0]));
  let scanned = 0;
  for (const f of codeFiles) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.size > 400 * 1024) continue;
    const text = read(f);
    if (!text) continue;
    scanned++;
    for (const cap of CAPABILITIES) {
      if (codeHits.get(cap.key) > 0) continue;
      if (countPositive(text, cap.code) > 0) codeHits.set(cap.key, codeHits.get(cap.key) + 1);
    }
  }
  const docText = docs.map(read).join('\n');

  const bad = [];
  const ok = [];
  for (const cap of CAPABILITIES) {
    const claimed = countPositive(docText, cap.doc);
    if (claimed === 0) continue;
    const hits = codeHits.get(cap.key);
    if (hits === 0) bad.push(`${cap.label}：文档声称 ${claimed} 处，代码 0 处落点`);
    else ok.push(`${cap.label}：文档 ${claimed} · 代码 ${hits} 个文件`);
  }

  if (bad.length) {
    return {
      id: 'C-001',
      title: '声称≠实现',
      verdict: 'fail',
      evidence: [...bad, `（扫了 ${scanned} 个代码文件；否定语境已排除）`],
    };
  }
  return { id: 'C-001', title: '声称≠实现', verdict: 'pass', evidence: ok.slice(0, 4) };
}

/** 从 gates.js 的 kind 推出每个门控的默认开/关 */
function gateDefaults(root) {
  const gatesPath = path.join(root, 'multi-proxy-manager', 'lib', 'gates.js');
  if (!fs.existsSync(gatesPath)) return null;
  let mod;
  try {
    delete require.cache[require.resolve(gatesPath)];
    mod = require(gatesPath);
  } catch (e) {
    return null;
  }
  const list = (mod.GATES || mod.gates || []).map((g) => ({
    env: g.env,
    id: g.id,
    defaultOn: g.kind === 'opt-out' || g.kind === 'opt-out-off-only',
  }));
  return list.length ? list : null;
}

// 历史留痕不算当前承诺：MEMORY / PROJECT-STATE / initiatives 按项目规矩「保留作历史，不回溯改写」，
// 拿它们判当前口径只会产出永远修不完的红（实测）。
const HISTORICAL = /(^|\/)(MEMORY|PROJECT-STATE|HANDOFF|CHANGE-MAP)\b[^/]*(\/|$)|(^|\/)10-initiatives\//;

// 「对外承诺面」白名单：用户会读到、并据此产生期待的文档。C-002 / C-003 只判这些。
// 设计稿、商业稿、内部笔记不算承诺——判它们等于让作者为三个月前的草稿改口。
const PUBLIC_DOC = /(^|\/)(README\.md|llms\.txt|SECURITY\.md|docs\/01-feature-matrix\.md)$|(^|\/)docs\/03-architecture\//;

function isHistorical(p) {
  return HISTORICAL.test(p);
}

function isPublicDoc(p) {
  return PUBLIC_DOC.test(p);
}

function criterionGateWording({ root }) {
  const gates = gateDefaults(root);
  if (!gates) {
    return { id: 'C-002', title: '门控口径一致', verdict: 'skip', evidence: ['没找到 gates.js 或表为空，跳过'] };
  }
  // 文档只读一次，且只留含 PROXY_ 的行：按「门控 × 全部行」匹配会把这一步拖到十几秒（实测）。
  const docs = walk(root, ['.md'])
    .filter((p) => isPublicDoc(p))
    .map((p) => {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        return null;
      }
      if (st.size > 500 * 1024) return null;
      const rows = read(p)
        .split('\n')
        .filter((l) => l.includes('PROXY_'));
      return rows.length ? { file: p, rows } : null;
    })
    .filter(Boolean);

  const bad = [];
  let checked = 0;
  for (const g of gates) {
    for (const d of docs) {
      for (const line of d.rows) {
        const i = line.indexOf(g.env);
        if (i < 0) continue;
        // 只认 env 之后**第一个**「默认开/关」。原文常有「门控 X 默认关 / shadow 默认开」这种
        // 一行两态写法，取「存在即算」会把 shadow 的默认开算到门控头上（实测误报）。
        const after = line.slice(i + g.env.length, i + g.env.length + 40);
        const m = /默认(开|关)/.exec(after);
        if (!m) continue;
        checked++;
        const saysOn = m[1] === '开';
        if (saysOn && !g.defaultOn) bad.push(`${path.relative(root, d.file)}: 写「默认开」，实际 ${g.env} 缺省是关（${g.id}）`);
        if (!saysOn && g.defaultOn) bad.push(`${path.relative(root, d.file)}: 写「默认关」，实际 ${g.env} 缺省是开（${g.id}）`);
      }
    }
  }
  if (bad.length) return { id: 'C-002', title: '门控口径一致', verdict: 'fail', evidence: bad.slice(0, 6) };
  return {
    id: 'C-002',
    title: '门控口径一致',
    verdict: checked ? 'pass' : 'skip',
    evidence: checked ? [`${gates.length} 个门控，${checked} 处文档口径逐条对上`] : ['文档里没有写默认开/关的门控，无可对'],
  };
}

function criterionRefReachable({ root }) {
  // 只判「带目录的路径引用」（含 `/`）。裸文件名（`forward.js`）是叙述，不是可点的引用——
  // 全判会产出几十条误报，判据一旦误报就没人在意它了。
  const docs = walk(root, ['.md'])
    .filter((p) => isPublicDoc(p))
    .slice(0, 80);
  const refRe = /([\w@.-]+\/[\w@./-]+\.(?:js|ts|tsx|mjs|py|sh|swift|json|md|html)):(\d+)(?:-(\d+))?/g;
  const bad = [];
  const missing = [];
  let total = 0;
  for (const d of docs) {
    let st;
    try {
      st = fs.statSync(d);
    } catch {
      continue;
    }
    if (st.size > 300 * 1024) continue;
    const text = read(d);
    let m;
    while ((m = refRe.exec(text)) !== null) {
      const rel = m[1];
      if (/^https?:/.test(rel) || rel.includes('example.com')) continue;
      if (rel.startsWith('node_modules/')) continue;
      // 三个基准：引用者所在目录、仓库根、manager 目录（很多代码引用是相对 multi-proxy-manager/ 写的）
      const candidates = [
        path.resolve(path.dirname(d), rel),
        path.join(root, rel),
        path.join(root, 'multi-proxy-manager', rel),
      ];
      const hit = candidates.find((p) => fs.existsSync(p));
      if (!hit) {
        if (rel.startsWith('..')) continue;
        missing.push(`${path.relative(root, d)} → ${rel}`);
        continue;
      }
      total++;
      const lines = read(hit).split('\n').length;
      const last = Number(m[3] || m[2]);
      if (last > lines) {
        bad.push(`${path.relative(root, d)}: ${rel}:${m[2]}${m[3] ? '-' + m[3] : ''} 超出文件行数 ${lines}`);
      }
    }
  }
  // 只有「文件在、行号越界」判 fail：那是纯漂移，零误报。
  // 「文件找不到」多是引用别的项目（dsh-context、Raven 等），只作提示，不判红。
  const uniqBad = [...new Set(bad)].slice(0, 8);
  if (uniqBad.length) return { id: 'C-003', title: '引用可达', verdict: 'fail', evidence: uniqBad };
  const note = missing.length ? [`另有 ${new Set(missing).size} 处引用指向本仓外的文件（多为跨项目引用，不判）`] : [];
  return {
    id: 'C-003',
    title: '引用可达',
    verdict: total ? 'pass' : 'skip',
    evidence: [`${total} 处带路径的 file:line 引用行号全部在范围内`, ...note],
  };
}

function runAll({ root = process.cwd() } = {}) {
  const abs = path.resolve(root);
  const results = [];
  for (const fn of [criterionClaimedNotImplemented, criterionGateWording, criterionRefReachable]) {
    try {
      results.push(fn({ root: abs }));
    } catch (e) {
      results.push({
        id: 'C-???',
        title: fn.name,
        verdict: 'skip',
        evidence: [`执行出错：${e.message}`],
      });
    }
  }
  return {
    root: abs,
    results,
    pass: results.filter((r) => r.verdict === 'pass').length,
    fail: results.filter((r) => r.verdict === 'fail').length,
    skip: results.filter((r) => r.verdict === 'skip').length,
  };
}

module.exports = { runAll, CAPABILITIES, criterionClaimedNotImplemented, criterionGateWording, criterionRefReachable, countPositive };
