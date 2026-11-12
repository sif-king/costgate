// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

/**
 * L2 公共模块：日报聚合（report）
 *
 * 只做一件事：把两本账（cost-ledger 记请求、fs-ledger 记文件）按天合成一个可读的对象。
 * 渲染交给调用方（CLI / 面板），这里只吐结构化数据，方便测。
 *
 * 三条口径，都是被真实数据逼出来的：
 *   1. **用量优先于费用**。免费池 / 订阅制下 cost 全是 0，把「¥0.00」放大字是骗人。
 *      默认先报请求数与 token；有定价的才报钱，没定价的明写「未定价」。
 *   2. **不猜价**。pricingSource=unknown 时 cost 一律不当真，计入 unpriced 计数。
 *   3. **归因不确定就单列**。unknown 不并进任何 agent，单独一行，数量可见。
 */

const fs = require('fs');
const path = require('path');

const { DEFAULT_DIR, LEDGER_NAME, COST_LEDGER_NAME, localDay, readLedger } = require('./fs-observer.js');

function normalizeAgent(v) {
  const s = String(v || '').trim();
  if (!s || s === '<unknown>' || s === 'unknown') return 'unknown';
  return s.replace(/-proxy$/, '');
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过，不因一行坏掉整本账 */
    }
  }
  return out;
}

function emptyUsageBucket() {
  return { requests: 0, prompt: 0, completion: 0, cacheHit: 0, cacheCreation: 0, thinking: 0, cost: 0, priced: 0, unpriced: 0, models: {} };
}

/** 账本里出现过数据的日期，升序 */
function availableDays({ dir = DEFAULT_DIR } = {}) {
  const recs = readJsonl(path.join(dir, COST_LEDGER_NAME));
  const days = new Set();
  for (const r of recs) if (r.localDay) days.add(r.localDay);
  for (const r of readLedger({ dir })) if (r.localDay) days.add(r.localDay);
  return [...days].sort();
}

/**
 * 一天的账。
 * 返回 {day, hasData, usage, byAgent, cost, files, alerts}
 */
function buildDayReport({ dir = DEFAULT_DIR, day } = {}) {
  const targetDay = day || localDay();
  const costRecs = readJsonl(path.join(dir, COST_LEDGER_NAME)).filter((r) => r.localDay === targetDay);
  const fsRecs = readLedger({ dir, day: targetDay });

  const total = emptyUsageBucket();
  const byAgent = new Map();

  for (const r of costRecs) {
    const agent = normalizeAgent(r.agent || r.proxy);
    if (!byAgent.has(agent)) byAgent.set(agent, emptyUsageBucket());
    const b = byAgent.get(agent);
    const prompt = Number(r.prompt) || 0;
    const completion = Number(r.completion) || 0;
    const cacheHit = Number(r.cacheHit) || 0;
    const cacheCreation = Number(r.cacheCreation) || 0;
    const thinking = Number(r.thinking) || 0;
    const cost = Number(r.cost) || 0;
    const priced = r.pricingSource && r.pricingSource !== 'unknown' ? 1 : 0;
    for (const t of [b, total]) {
      t.requests += 1;
      t.prompt += prompt;
      t.completion += completion;
      t.cacheHit += cacheHit;
      t.cacheCreation += cacheCreation;
      t.thinking += thinking;
      t.cost += cost;
      if (priced) t.priced += 1;
      else t.unpriced += 1;
      if (r.model) t.models[r.model] = (t.models[r.model] || 0) + 1;
    }
  }

  const fileByAgent = new Map();
  const deletes = [];
  for (const r of fsRecs) {
    const agent = r.agent || 'unknown';
    if (!fileByAgent.has(agent)) fileByAgent.set(agent, { agent, count: 0, creates: 0, modifies: 0, deletes: 0 });
    const b = fileByAgent.get(agent);
    b.count += 1;
    if (r.event === 'delete') {
      b.deletes += 1;
      deletes.push({ path: r.path, agent, confidence: r.confidence, ts: r.ts });
    } else if (r.event === 'create') b.creates += 1;
    else b.modifies += 1;
  }

  const agentRows = [...byAgent.entries()]
    .map(([agent, b]) => ({
      agent,
      ...b,
      topModels: Object.entries(b.models)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 2)
        .map(([m]) => m),
    }))
    .sort((a, b) => b.requests - a.requests);

  const fileRows = [...fileByAgent.values()].sort((a, b) => b.count - a.count);

  const alerts = [];
  const unattributedDeletes = deletes.filter((d) => d.agent === 'unknown');
  if (unattributedDeletes.length) {
    alerts.push({
      kind: 'delete-unattributed',
      text: `删除 ${unattributedDeletes.length} 个文件未能归因`,
      items: unattributedDeletes.slice(0, 5),
    });
  }
  if (total.unpriced > 0 && total.priced > 0) {
    alerts.push({
      kind: 'mixed-pricing',
      text: `${total.unpriced} 次请求未定价，费用只统计了有价的 ${total.priced} 次`,
    });
  }

  return {
    day: targetDay,
    hasData: costRecs.length > 0 || fsRecs.length > 0,
    usage: total,
    byAgent: agentRows,
    files: {
      total: fsRecs.length,
      byAgent: fileRows,
      deletes,
      unattributed: fsRecs.filter((r) => !r.agent).length,
    },
    alerts,
  };
}

/** 多天汇总（最近 N 天，含今天） */
function buildRangeReport({ dir = DEFAULT_DIR, days = 7, endDay } = {}) {
  const all = availableDays({ dir });
  const end = endDay || localDay();
  const picked = all.filter((d) => d <= end).slice(-days);
  const reports = picked.map((d) => buildDayReport({ dir, day: d }));
  const sum = (fn) => reports.reduce((n, r) => n + fn(r), 0);
  return {
    days: picked,
    from: picked[0] || null,
    to: picked[picked.length - 1] || null,
    requests: sum((r) => r.usage.requests),
    prompt: sum((r) => r.usage.prompt),
    completion: sum((r) => r.usage.completion),
    cacheHit: sum((r) => r.usage.cacheHit),
    cost: sum((r) => r.usage.cost),
    unpriced: sum((r) => r.usage.unpriced),
    files: sum((r) => r.files.total),
    perDay: reports,
  };
}

/** 某个文件的改动时间线（谁、什么时候、什么动作） */
function fileTimeline({ dir = DEFAULT_DIR, match, limit = 20 } = {}) {
  if (!match) return [];
  return readLedger({ dir, path: match })
    .slice(-limit)
    .map((r) => ({ ts: r.ts, event: r.event, agent: r.agent || 'unknown', confidence: r.confidence, path: r.path }));
}

module.exports = {
  normalizeAgent,
  availableDays,
  buildDayReport,
  buildRangeReport,
  fileTimeline,
  LEDGER_NAME,
  COST_LEDGER_NAME,
};
