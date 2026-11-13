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
// 2026-11-14 追加（老板点名「别用像辩论赛一样的表达」）：
//   D11 辩论赛腔词表，出处＝文章体系 去AI味操作手册 §三 改法 4（模板句）/ 改法 6（无主断言），
//   写作自进化机制 门禁 B14 与坑库 K113 / K114。同一批指纹在文章体系靠人读抓，这里做成机器判。
//   同时把 site/index.html 纳入覆盖：落地页是陌生人第一眼读的文案，此前不在 TARGETS 里，
//   等于这层文案一直没有门禁。HTML 会先剥掉标签 / 样式 / 脚本，再按同一套规则判。
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
  'site/index.html',
];

const RULES = {
  // 密度是为了长文档不被「按比例放行」；绝对值是为了短文档不因为分母小而被放过。
  // 两个上限同时生效，任一超出即违规（de-ai-writing 的基线口径是「破折号全篇最多 3 个」）。
  D1: { name: '破折号 ——', limit: 0.8, unit: '‰', absMax: 3, hard: true },
  D2: { name: '反问句 ？', limit: 0.5, unit: '‰', absMax: 2, hard: true },
  D3: { name: '元话语', limit: 0.6, unit: '‰', hard: true },
  D4: { name: '套话 / 对举', limit: 0, unit: '次', hard: true },
  D5: { name: '直角引号「」', limit: 0, unit: '次', hard: true },
  // —— 以下五条是「句子形状」层（2026-11-13 老板第二轮：标点干净了，读起来还是不像人写的）——
  // 出处：文章体系 去AI味操作手册 §二（三个可数指标）、§三 改法 2/6、写作自进化机制 门禁 B8/B14。
  // 35%：118 篇成稿实测中位 37%、p25 27.8%（分母＝≥2 句且 ≥40 汉字的普通段落）。
  // 卡在 35 的意思是「你得比作者一半以上的旧文更不像模板」，不是凭空拍的整数。
  D6: { name: '判断式开头段', limit: 35, unit: '%', hard: true, minParas: 5 },
  // D7 只报数不判红：机器分不清「源码运行，不是安装包」（事实区分，删了伤准确性）
  // 和「不是降级开关，是认知」（修辞对举，纯节奏）。硬卡会逼作者删掉前者。
  // 出处：去AI味操作手册 §八 停手线第 2 条——对称句「不要为凑数硬拆」。
  D7: { name: '对称对举句', limit: 2.0, unit: '‰', absMax: 8, hard: false },
  D8: { name: '绝对化词', limit: 0.4, unit: '‰', absMax: 3, hard: true },
  D9: { name: '计数/分层套话', limit: 0, unit: '次', hard: true },
  D10: { name: '超长段', limit: 0, unit: '次', hard: true },
  // D11：辩论赛腔。去掉主语、把话写成格言或「既然 A 就 B」的顺推，读起来像在打辩题。
  // 词表先在 12 份对外文档上实测过 0 命中，才设成 hard（不许拿新规则去砸存量稿）。
  D11: { name: '辩论赛腔', limit: 0, unit: '次', hard: true },
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

// D7：对称对举。骨架能前后互换的句子，读的时候读者能预判下半句。
// D4 已经管「不是……而是……」的严格形，这里补两种更松的变体。
const PARALLEL_PATTERNS = [
  /不是[^。\n]{1,24}?[，,]\s*是/g,
  /[^。\n]{2,24}?[，,]\s*不是[^。，\n]{1,24}?[。\n]/g,
];

// D8：绝对化词。文档里真讲不变量时可以用，但必须少；
// 「永远」「绝不」在讲「我们保证永不」这类承诺时是合法的，所以只限密度不限零。
const ABSOLUTE_PATTERNS = [
  /无一例外/g,
  /唯一(?!的?标识|索引|键)/g,
  /必然/g,
  /绝对(?!路径|值)/g,
  /永远不/g,
  /从来不会/g,
];

// D9：把定性内容套上「计数 / 分层 / 极值」外壳（去AI味操作手册 改法 6 的完整词表）。
// 这些几乎不会被技术文档真正需要：真在讲财务会写金额，真在讲架构会写层次名。
const COUNTING_PATTERNS = [
  /算[^。，\n]{0,4}[一二三四五六七八九十几多\d]\s*笔账/g,
  /\d+\s*层(?!协议|缓存|网络|应用|传输)/g,
  /分\s*[一二三四五六七八九十几多]\s*层/g,
  /最值钱的/g,
  /标个刻度/g,
  /一把尺子/g,
  /(落在|交到)哪一格/g,
  /(能|数得)数出来的/g,
  /同一件事/g,
  /同一道题/g,
];

// 文章体系 改法 4 的模板句 + 改法 6 / K114 的「无主断言、格言体」。
// 这些句子单看都通顺，成串出现就像在打辩论赛：推理太顺、不给主语、替读者下结论。
const DEBATE_PATTERNS = [
  /既然是[^。\n]{1,20}就能/g,
  /真正该看的是/g,
  /比[^。\n]{1,20}更值得[^。\n]{1,20}因为/g,
  /三条都指向/g,
  /关键补一刀|补一刀/g,
  /说到底/g,
  /显而易见/g,
  /与其说[^。\n]{1,20}不如说/g,
  /恰恰(是|在于|说明)/g,
  /顺着[^。\n]{1,20}看，比[^。\n]{1,20}清楚/g,
];

function stripProse(md, isHtml) {
  let src = md;
  if (isHtml) {
    src = src
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      // 块级标签换成空行：不换的话整个页面会挤成一段，D6/D10 的段落形状就失真了。
      .replace(/<\/(p|div|h[1-6]|li|tr|section|header|footer|pre|table|nav|main)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }
  return (
    src
      // 引用块豁免：`<!-- doc-tone:off -->` 到 `<!-- doc-tone:on -->` 之间是逐字引用的
      // 坏句子（D1–D5 的对照表要用原文，改成转述就失去示范价值）。豁免必须显式成对写，
      // 且每次运行都会把「豁免了几段」打出来，避免它变成静默后门。
      .replace(/<!--\s*doc-tone:off\s*-->[\s\S]*?<!--\s*doc-tone:on\s*-->/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^```[\s\S]*?^```/gm, '')
      // 行内代码换成等长的中性占位符：直接删掉会让句子看起来变短，
      // D6 会把「**协议版本口径**：OpenAI 侧认 `X` 与 `Y`」误判成 15 字以内的短判断句。
      .replace(/`[^`\n]*`/g, (m) => '□'.repeat(Math.min(m.length, 16)))
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

/// 只取「普通正文段落」：标题、表格、列表、引用、代码围栏都不算。
/// D6/D10 判的是段落形状，把表格行混进来会让占比失去意义。
function plainParagraphs(prose) {
  const blocks = prose.split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const isPlain = lines.every(
      (l) => !/^\s*(#{1,6}\s|\||[-*+]\s|\d+\.\s|>|<\/?[a-zA-Z])/.test(l)
    );
    if (isPlain) out.push(lines.join(''));
  }
  return out;
}

/// 句长按「字符数」算（去掉空白与标点），不按汉字数：
/// 技术句里混着英文标识符，只数汉字会把一句完整的话算成短的。
function charLen(s) {
  return s.replace(/[\s，。、；：""''（）()《》【】「」…·,.;:!?]/g, '').length;
}

function sentencesOf(p) {
  return p
    .split(/(?<=[。！？])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  const prose = stripProse(raw, /\.html?$/i.test(abs));
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

  const dashHits = hits([/——/g], prose);
  const dash = dashHits.length;
  const meta = hits(META_PATTERNS, prose);
  const cliche = hits(CLICHE_PATTERNS, prose);
  const corner = (prose.match(/「/g) || []).length;
  const parallel = hits(PARALLEL_PATTERNS, prose);
  const absolute = hits(ABSOLUTE_PATTERNS, prose);
  const counting = hits(COUNTING_PATTERNS, prose);
  const debate = hits(DEBATE_PATTERNS, prose);

  // 段落形状：只看「≥2 句且 ≥40 汉字」的普通段落——
  // 一句成段（列表式短段）没有「开头判断 + 后文解释」的结构，不计入分母，
  // 否则短文档会被结构本身判成超标。
  // FAQ / 术语条目是问答体（「**要全装吗？**不用。」），短答句是它的正常形状，
  // 拿「判断式开头」去判它属于口径错，和方法论文档里 D2 对 FAQ 的豁免是同一条道理。
  const isFaq = (p) => /^\s*(?:[-*]\s+)?\*\*[^*]*[？?]\*\*/.test(p);
  const paras = plainParagraphs(prose).filter((p) => !isFaq(p));
  const shaped = paras
    .map((p) => ({ p, s: sentencesOf(p), han: countHan(p) }))
    .filter((x) => x.s.length >= 2 && x.han >= 40);
  const judgementOpen = shaped.filter((x) => charLen(x.s[0]) <= 15);
  const longParas = paras
    .map((p) => ({ p, s: sentencesOf(p), han: countHan(p) }))
    .filter((x) => x.han > 150 && x.s.length >= 3);
  const openRatio = shaped.length ? (judgementOpen.length / shaped.length) * 100 : 0;
  // 段落太少时占比会在 0/50/100 之间跳，判它没有意义（实测里 2 段文档常被误判）。
  const d6Enough = shaped.length >= (RULES.D6.minParas || 5);

  const dens = (n) => (n / han) * 1000;
  const results = [
    {
      id: 'D1',
      value: dash,
      density: dens(dash),
      all: dashHits.map((h) => `L${lineOf(prose, h.at)}: ${prose.slice(Math.max(0, h.at - 12), h.at + 12).replace(/\n/g, ' ')}`),
      samples: [],
    },
    {
      id: 'D2',
      value: questionMarks,
      density: dens(questionMarks),
      all: nonHeading
        .split('\n')
        .filter((l) => l.includes('？'))
        .map((l) => l.trim().slice(0, 60)),
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
    {
      id: 'D6',
      skip: !d6Enough,
      value: Number(openRatio.toFixed(1)),
      density: openRatio,
      all: judgementOpen.map(
        (x) => `${x.s[0]}｜后文：${x.s.slice(1).join('').slice(0, 34)}`
      ),
      samples: judgementOpen
        .slice(0, 3)
        .map((x) => `${judgementOpen.length}/${shaped.length} 段以短判断句开头：${x.s[0]}`),
    },
    {
      id: 'D7',
      value: parallel.length,
      density: dens(parallel.length),
      all: parallel.map((h) => `L${lineOf(prose, h.at)}: ${h.text.trim()}`),
      samples: parallel.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text.trim()}`),
    },
    {
      id: 'D8',
      value: absolute.length,
      density: dens(absolute.length),
      all: absolute.map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
      samples: absolute.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
    },
    {
      id: 'D9',
      value: counting.length,
      density: counting.length,
      all: counting.map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
      samples: counting.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text}`),
    },
    {
      id: 'D10',
      value: longParas.length,
      density: longParas.length,
      all: longParas.map((x) => `${x.han} 汉字 / ${x.s.length} 句：${x.p.slice(0, 50)}…`),
      samples: longParas.slice(0, 3).map((x) => `超长段 ${x.han} 汉字 / ${x.s.length} 句：${x.p.slice(0, 40)}…`),
    },
    {
      id: 'D11',
      value: debate.length,
      density: debate.length,
      all: debate.map((h) => `L${lineOf(prose, h.at)}: ${h.text.trim()}`),
      samples: debate.slice(0, 3).map((h) => `L${lineOf(prose, h.at)}: ${h.text.trim()}`),
    },
  ];
  return { rel, han, exempt, results, paras: shaped.length };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const explainIdx = args.indexOf('--explain');
  const explain = explainIdx >= 0 ? args[explainIdx + 1] : null;
  // 只排掉 --explain 的值；explainIdx 为 -1 时不能顺手排掉 args[0]，
  // 否则「只查一个文件」会静默退化成「查全集」——测试里注入的坏句子因此从没变红过。
  const files = args.filter(
    (a, i) => !a.startsWith('--') && !(explainIdx >= 0 && i === explainIdx + 1)
  );
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
      const isBad = over && !allowed && rule.hard && !item.skip;
      if (isBad) bad.push(item.id);
      const shown =
        rule.unit === '‰'
          ? `${item.density.toFixed(2)}‰`
          : rule.unit === '%'
            ? `${item.value}%`
            : `${item.value} 次`;
      const caps =
        rule.absMax !== undefined ? `上限 ${rule.limit}${rule.unit} 且 ≤${rule.absMax} 次` : `上限 ${rule.limit}${rule.unit}`;
      const mark = item.skip ? '·' : allowed ? '·' : isBad ? '✗' : '✓';
      if (!json) {
        console.log(
          `  ${mark} ${item.id} ${rule.name.padEnd(12, ' ')} ${shown.padStart(9, ' ')}（${caps}）` +
            (allowed ? `｜白名单：${allowReason}` : '') +
            (item.skip ? `｜样本不足（${r.paras} 段），本条不判` : '') +
            (overAbs && !overDensity ? '｜超绝对值' : '')
        );
        if (explain && explain === item.id && item.all) {
          for (const s of item.all) console.log(`      ${s}`);
        } else {
          for (const s of item.samples) console.log(`      ${s}`);
        }
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
