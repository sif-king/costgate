// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// ==================== 路由：今天这本账（GET /api/today） ====================
// 面板「今天」页的唯一数据源，口径与 `costgate today` 子命令**必须是同一份**
// （l2/report.js）。所以这里只做三件事：取参数、调 report、原样吐 JSON。
// 一旦这里开始自己算数，CLI 和面板就会给出两个不同的数字，那种账不如没有。
//
// 为什么要有这个端点（2026-11-13）：
//   cost-ledger.jsonl 早就记着每一笔请求，但它此前只能被 CLI 和开发者盘面读到。
//   面板里叫「成本」的那一页讲的是 provider 余额与预算判级，**不是「我今天花了多少」**。
//   于是桌面 App 打开看半天，也看不到自己今天到底跑了多少次、动了哪些文件。
//
// 口径（与 l2/report.js 头注释一致，改这里之前先读那里）：
//   · 用量优先于费用：本地全走免费池时 cost 恒为 0，把 ¥0.00 放头版是骗人。
//     响应里 cost 照实给，但 UI 必须先展示 requests / tokens。
//   · unknown 就是 unknown：归因不了的文件改动不许塞给某个 agent（错的账比没账更糟）。
//
// 鉴权：requireAgentAuth（界面 JWT 或机器 token）。只读也要鉴权 ——
// 账本里含本机绝对路径，匿名可读等于把家目录结构挂到 127.0.0.1 上。
const express = require('express');
const os = require('os');
const { requireAgentAuth } = require('../lib/auth');
const report = require('../../l2/report.js');
const fsObs = require('../../l2/fs-observer.js');

const router = express.Router();

function dirOf() {
  return process.env.COSTGATE_LEDGER_DIR || undefined;
}

// 路径相对 home 显示。绝对路径一排排铺满屏幕时，真正有信息量的「相对哪一段变了」
// 反而被截断掉；CLI 的 printDay 也是这么做的，两边保持一致。
const HOME = os.homedir();
function relPath(p) {
  if (!p) return '';
  return (HOME && p.startsWith(HOME + '/')) ? p.slice(HOME.length + 1) : p;
}

// 当天的文件改动明细（最近 N 条，倒序）。聚合数字在 report.files 里，
// 但「谁动了我的文件」这个问题的答案是一个个具体路径，只给汇总等于没答。
function recentFileEvents(dir, day, limit = 30) {
  return fsObs.readLedger({ dir, day })
    .slice(-limit)
    .reverse()
    .map((r) => ({
      ts: r.ts,
      event: r.event,
      path: r.path,
      rel: relPath(r.path),
      agent: r.agent || 'unknown',
      confidence: r.confidence || 'unknown',
    }));
}

// 今天（本地时区）。别用 toISOString()——那是 UTC，北京晚 8 点后会变成"明天"。
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// GET /api/today?day=YYYY-MM-DD   指定某天（不给=今天）
// GET /api/today?days=7           最近 N 天汇总
// 今天没有记录时，附带 fallback（最近 7 天汇总 + 最近有数据的那一天），
// 免得首屏是一张白纸 —— 与 CLI 的降级顺序完全一致。
router.get('/', requireAgentAuth, (req, res) => {
  try {
    const dir = dirOf();
    const days = Number(req.query.days);
    if (Number.isFinite(days) && days > 0) {
      return res.json({ ok: true, mode: 'range', report: report.buildRangeReport({ dir, days }) });
    }

    const wanted = String(req.query.day || '').trim();
    const day = wanted || localDay();
    const today = report.buildDayReport({ dir, day });
    today.recentFiles = recentFileEvents(dir, day);
    if (today.hasData || wanted) {
      return res.json({ ok: true, mode: 'day', today: localDay(), report: today });
    }

    // 今天空 → 给能看的东西，但必须明说"今天是空的"，不许拿旧数据冒充今天
    const all = report.availableDays({ dir });
    if (!all.length) {
      return res.json({ ok: true, mode: 'empty', today, report: today, note: '账本里还没有任何记录' });
    }
    const lastDay = all[all.length - 1];
    const last = report.buildDayReport({ dir, day: lastDay });
    last.recentFiles = recentFileEvents(dir, lastDay);
    res.json({
      ok: true,
      mode: 'fallback',
      today,
      report: today,
      note: `今天（${today}）还没有记录，下面是最近的情况`,
      fallback: {
        range: report.buildRangeReport({ dir, days: 7 }),
        lastDay: last,
      },
    });
  } catch (e) {
    // 读失败不许 fallback 成"今天没花钱"——那是最危险的一种假绿
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/today/days —— 有记录的日期（给日期切换用）
router.get('/days', requireAgentAuth, (_req, res) => {
  try {
    res.json({ ok: true, days: report.availableDays({ dir: dirOf() }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/today/file?match=xxx —— 这个文件被谁动过（= costgate who）
router.get('/file', requireAgentAuth, (req, res) => {
  const match = String(req.query.match || '').trim();
  if (!match) return res.status(400).json({ ok: false, error: '缺 match 参数' });
  try {
    const rows = report.fileTimeline({ dir: dirOf(), match, limit: Number(req.query.limit) || 50 })
      .map((r) => ({ ...r, rel: relPath(r.path) }));
    res.json({ ok: true, match, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
