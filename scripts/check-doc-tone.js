#!/usr/bin/env node
// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.
//
// 对外文档「语气」体检：结构对了、句子还像 AI 写的，照样没人读完。
//
// 为什么要有这条（2026-11-13）：
//   docs/12-docs/DOCS-METHODOLOGY.md 的 R1–R8 只管骨架（图在哪、表在哪、数字带不带日期），
//   它开头自己写着「不是文风指南」。于是句子层没有任何门禁：README 里 31 个破折号、
//   9 个反问句、每节一句格言收尾，全是结构检查抓不到的。老板读下来的评价是「AI 味儿还是很重」。
//
//   文章体系那边早就把这类问题做成了可复算的门禁（写作自进化机制 §二 门禁 A / §三 门禁 B8、B9、B14，
//   语料基线见 de-ai-writing 的 voice_fingerprint 表）。本脚本把能机检的四类搬过来，
//   人读的那半（每节有没有可核对物、格言收尾）留在 DOCS-METHODOLOGY §7 的 D5/D8。
//
// 判据（密度分母＝正文汉字数，已剔除代码块、行内代码、链接 URL、HTML 注释）：
//   D1 破折号 ——     ≤ 0.8‰   基线 0.12‰（作者 32 篇旧文中位数），取 6 倍宽容
//   D2 反问句 ？      ≤ 0.5‰   正文里的问号；FAQ 那种「问」应写成标题，不写在段落里
//   D3 元话语         ≤ 0.6‰   「这一段回答」「先对号入座」「你会发现」这类向读者报路线的句子
//   D4 套话 / 对举     = 0      「说白了 / 本质上 / 值得注意的是」与「不是……而是……」严格形
//   D5 直角引号「」    = 0      AI 高频特征，中文引号一律用 “”
//
// 用法：
//   node scripts/check-doc-tone.js            # 检查对外文档全集
//   node scripts/check-doc-tone.js README.md  # 只查一份（改稿时用）
//   node scripts/check-doc-tone.js --json     # 给别的脚本吃
//
// 退出码：0 全过；1 有 hard 项超标；2 文件不存在。
//
// 加白名单请改 scripts/doc-tone-allow.txt（格式 `文件<TAB>规则<TAB>理由`），
// 只允许「这份文件这一条确实不该按此判」的理由，不许写「先放过」。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 对外文档集合：陌生人会读到的那一层。内部台账（MEMORY-*.md / PROJECT-STATE）不在范围内，
// 那些是给自己看的，用不上对外语气标准。
const TARGETS = [
  'README.md',
  'COMPATIBILITY.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'docs/quickstart.md',
  'docs/08-user/connect-tools.md',
  'docs/08-user/self-verify.md',
  'docs/08-user/faq.md',
  'docs/04-tech/implementation-notes.md',
  'docs/12-docs/DOCS-METHODOLOGY.md',
];

const RULES = {
  // 密度是为了长文档不被「按比例放行」；绝对值是为了短文档不因为分母小而被放过。
  // 两个上限同时生效，任一超出即违规（de-ai-writing 的基线口径是「破折号全篇最多 3 个」）。
  D1: { name: '破折号 ——', limit: 0.8, unit: '‰', absMax: 3, hard: true },
  D2: { name: '反问句 ？', limit: 0.5, unit: '‰', absMax: 2, hard: true },
  D3: { name: '元话语', limit: 0.6, unit: '‰', hard: true },
  D4: { name: '套话 / 对举', limit: 0, unit: '次', hard: true },
  D5: { name: '直角引号「」', limit: 0, unit: '次', hard: true },
};

// D3：向读者报路线、拉着读者走的句子。判定不看单个词，看这几个固定说法。
const META_PATTERNS = [
  /这一段(回答|讲|说)/g,
  /先(说|讲)(它|这)?不是/g,
  /写出来比[^。]{0,10}好/g,
  /读到这里/g,
  /你会发现/g,
  /对号入座/g,
  /顺便说一句/g,
  /(这句|那件)话的意思是/g,
  /上面(这|那)些/g,
  /你(可能|或许)会/g,
  /你凭什么/g,
  /往下看/g,
];

// D4：空话与伪洞察（文章体系门禁 B9 / B14 的词表），命中一次即违规。
const CLICHE_PATTERNS = [
  /说白了/g,
  /换句话说/g,
  /本质上/g,
  /归根结底/g,
  /综上所述/g,
  /核心在于/g,
  /值得注意的是/g,
  /众所周知/g,
  /毫无疑问/g,
  /不是[^。，\n]{1,20}而是/g,
];

function stripProse(md) {
  return (
    md
      // 引用块豁免：`<!-- doc-tone:off -->` 到 `<!-- doc-tone:on -->` 之间是逐字引用的
      // 坏句子（D1–D5 的对照表要用原文，改成转述就失去示范价值）。豁免必须显式成对写，
      // 且每次运行都会把「豁免了几段」打出来，避免它变成静默后门。
      .replace(/<!--\s*doc-tone:off\s*-->[\s\S]*?<!--\s*doc-tone:on\s*-->/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^```[\s\S]*?^```/gm, '')
      .replace(/`[^`\n]*`/g, '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, '')
  );
}

function countExemptBlocks(md) {
  const m = md.match(/<!--\s*doc-tone:off\s*-->/g);
  return m ? m.length : 0;
}

function countHan(s) {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function hits(patterns, text) {
  const out = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text)) !== null) {
      out.push({ at: m.index, text: m[0] });
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function loadAllow() {
  const p = path.join(ROOT, 'scripts/doc-tone-allow.txt');
  if (!fs.existsSync(p)) return new Map();
  const m = new Map();
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [file, rule, reason] = line.split('\t').map((s) => (s || '').trim());
    if (!file || !rule) continue;
    if (!m.has(file)) m.set(file, new Map());
    m.get(file).set(rule, reason || '（未写理由）');
  }
  return m;
}

function checkFile(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { rel, missing: true };
  const raw = fs.readFileSync(abs, 'utf8');
  const prose = stripProse(raw);
  const han = countHan(prose) || 1;
  const exempt = countExemptBlocks(raw);

  // 反问句：只数正文段落里的问号。
  // 两类排除都来自实况而不是偏好：① `#`/`##` 标题里的问号是导航；
  // ② FAQ 那种整行就是一句加粗提问（`**我要全装吗？**`）是条目名，不是反问。
  // 排除之后剩下的问号，才是「你凭什么信我」这种把读者拉进来对话的写法。
  const nonHeading = prose
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => !/^\s*(?:(?:[-*]|\d+\.)\s+)?\*\*[^*]*？\*\*\s*(?:[（(][^）)]*[）)])?\s*$/.test(l))
    .join('\n');
  const questionMarks = (nonHeading.match(/？/g) || []).length;

  const dash = (prose.match(/——/g) || []).length;
  const meta = hits(META_PATTERNS, prose);
  const cliche = hits(CLICHE_PATTERNS, prose);
  const corner = (prose.match(/「/g) || []).length;

  const dens = (n) => (n / han) * 1000;
  const results = [
    { id: 'D1', value: dash, density: dens(dash), samples: [] },
    {
      id: 'D2',
      value: questionMarks,
      density: dens(questionMarks),
      samples: [],
    },
    {
      id: 'D3',
      value: meta.length,
      density: dens(meta.length),
      samples: meta.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
    },
    {
      id: 'D4',
      value: cliche.length,
      density: cliche.length,
      samples: cliche.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
    },
    {
      id: 'D5',
      value: corner,
      density: corner,
      samples: [],
    },
  ];
  return { rel, han, exempt, results };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  const list = files.length ? files : TARGETS;
  const allow = loadAllow();

  const reports = list.map(checkFile);
  let failed = 0;
  let missing = 0;

  if (!json) {
    console.log('对外文档语气体检（判据与出处见 docs/12-docs/DOCS-METHODOLOGY.md §7）');
  }

  for (const r of reports) {
    if (r.missing) {
      missing++;
      if (!json) console.log(`\n[缺失] ${r.rel}`);
      continue;
    }
    const bad = [];
    if (!json) {
      console.log(`\n[${r.rel}] 正文 ${r.han} 汉字`);
      if (r.exempt) console.log(`  · 有 ${r.exempt} 段逐字引用被 doc-tone:off 豁免（对照表用原文，不算正文）`);
    }
    for (const item of r.results) {
      const rule = RULES[item.id];
      const allowReason = allow.get(r.rel) && allow.get(r.rel).get(item.id);
      const allowed = Boolean(allowReason);
      const overDensity = rule.unit === '‰' ? item.density > rule.limit : item.value > rule.limit;
      const overAbs = rule.absMax !== undefined && item.value > rule.absMax;
      const over = overDensity || overAbs;
      const isBad = over && !allowed && rule.hard;
      if (isBad) bad.push(item.id);
      const shown = rule.unit === '‰' ? `${item.density.toFixed(2)}‰` : `${item.value} 次`;
      const caps =
        rule.absMax !== undefined ? `上限 ${rule.limit}${rule.unit} 且 ≤${rule.absMax} 次` : `上限 ${rule.limit}${rule.unit}`;
      const mark = allowed ? '·' : isBad ? '✗' : '✓';
      if (!json) {
        console.log(
          `  ${mark} ${item.id} ${rule.name.padEnd(12, ' ')} ${shown.padStart(9, ' ')}（${caps}）` +
            (allowed ? `｜白名单：${allowReason}` : '') +
            (overAbs && !overDensity ? '｜超绝对值' : '')
        );
        for (const s of item.samples) console.log(`      ${s}`);
      }
    }
    if (bad.length) failed++;
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log('');
    if (missing) console.log(`${missing} 份文件不存在（清单过期了，改 scripts/check-doc-tone.js 的 TARGETS）`);
    if (failed) {
      console.log(`结论：${failed} 份文档有句子层超标（见 ✗）。修文档，不要把阈值调高。`);
    } else if (missing) {
      console.log('结论：没跑全，先修上面的缺失项。');
    } else {
      console.log('结论：对外文档句子层全过。');
    }
  }
  process.exit(missing ? 2 : failed ? 1 : 0);
}

main();
