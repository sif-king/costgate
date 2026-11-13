// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// ==================== 路由：context-breakdown 上报与查询 ====================
// 口径真源：docs/context-breakdown-口径.md（改字段先改那里）。
//
// POST /api/context/report  lane 上报（requireAgentAuth；契约见口径 §4）
// GET  /api/context/summary 面板聚合（只读；与 /api/floor 同模式不鉴权——
//                           manager 默认只绑 127.0.0.1，纯展示零副作用）
// GET  /api/context/recent  最近 n 条（同上）
//
// 存储：lib/context-store.js（内存环 + ~/.multi-proxy-manager/context-ledger.jsonl）。
// 只存计数，永不存 prompt/回复正文（口径 §4 隐私纪律）。

const express = require('express');
const { requireAgentAuth } = require('../lib/auth');
const contextStore = require('../lib/context-store');
const costTrack = require('../lib/cost-track'); // G3：面板端 join 成本（价目源走既有价表）

const router = express.Router();

// ---- 上报（写面：鉴权，不 fail-open）----
router.post('/report', requireAgentAuth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'bad body: expect { agent?, frame, events }' });
  }
  const r = contextStore.report(body);
  if (!r.ok) {
    return res.status(400).json({ ok: false, error: r.reason });
  }
  res.json({ ok: true, agent: body.agent || 'lane' });
});

// ---- 查询（读面：不鉴权，同 /api/floor）----
router.get('/summary', (req, res) => {
  const windowMs = Number(req.query.windowMs);
  const summary = contextStore.summary({ windowMs });
  // G3（2026-11-13）：面板端 join 成本——复用 costTrack 既有价目（每百万 tokens，CNY），
  // 按窗口内每请求 model+total 估算。纪律：不动 fold 内核；只取 input 口径（无 prompt/completion 拆分）；
  // 标「估算」避免冒充实测账（实测账在 cost-track 落盘，那条线不在这里）。
  const pricing = costTrack.getPricingTable() || {};
  let est = 0;
  const rows = contextStore.rowsInWindow({ windowMs });
  for (const r of rows) {
    const p = (r.model && pricing[r.model]) || (r.requestModel && pricing[r.requestModel]);
    if (!p) continue;
    const rate = (p.input != null ? p.input : 0); // 每百万 tokens，CNY
    est += (Number(r.total) || 0) / 1e6 * rate;
  }
  summary.estimatedCny = Math.round(est * 100) / 100;
  summary.costBasis = '估算 · 窗口各请求按模型 input 价目（每百万 tokens）· 无 prompt/completion 拆分';
  res.json({ ok: true, ...summary });
});

router.get('/recent', (req, res) => {
  const n = Number(req.query.n);
  res.json({ ok: true, rows: contextStore.recent(n) });
});

router.get('/stats', (req, res) => {
  res.json({ ok: true, ...contextStore.stats() });
});

module.exports = router;
