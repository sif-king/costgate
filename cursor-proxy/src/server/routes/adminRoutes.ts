// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

import { Router, Request, Response } from 'express';
import { db } from '../../db/database.js';
import crypto from 'crypto';
import { SecretsManager, getEncryptionKey } from '../../utils/crypto.js';
// Q3 P1-B 成本闭环：/cost 读 cursor-cost.jsonl 实采汇总
import * as costTrack from '../../monitoring/costTrack.js';
// P0-2 路由反馈闭环：只读聚合 taskType × model → 延迟/重试率
import { aggregateFeedback } from '../../routing/routeFeedback.js';

const router = Router();
const secrets = new SecretsManager();

// ==================== Provider CRUD ====================

// GET /admin-api/providers
router.get('/providers', (_req: Request, res: Response) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY name ASC').all();
  // Mask API keys for display
  const safe = providers.map((p: any) => ({
    ...p,
    api_key: p.api_key ? p.api_key.slice(0, 4) + '****' : '(empty)',
  }));
  res.json({ providers: safe });
});

// POST /admin-api/providers
router.post('/providers', (req: Request, res: Response) => {
  const { id: rawId, name, provider_id, api_key, base_url, enabled } = req.body;
  // api_key 允许留空：本机 Ollama / LM Studio / vLLM、以及 Kilo 那类匿名免费池
  // 本来就不需要 key。此前把 api_key 列为必填，等于逼用户给免鉴权上游填一个
  // 假 key，而 adapter 会把它当真实凭据发出去，上游返回 401 INVALID_TOKEN
  // ——用户看到的是"key 错了"，实际是这条上游根本不该发鉴权头。
  if (!name || !provider_id || !base_url) {
    res.status(400).json({
      success: false,
      error: 'Missing required fields: name, provider_id, base_url（api_key 可留空，用于不需要鉴权的上游）',
      code: 'MISSING_FIELDS',
    });
    return;
  }
  const apiKey = typeof api_key === 'string' ? api_key : '';
  const id = rawId || crypto.randomUUID();
  try {
    const encKey = secrets.encrypt(apiKey);
    const stmt = db.prepare(`INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(id, name, provider_id, encKey, base_url, enabled ? 1 : 0);
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(409).json({ success: false, error: e.message, code: 'DUPLICATE_PROVIDER' });
  }
});

// PUT /admin-api/providers/:id — D4: fixed dynamic SQL injection.
// Only allows a strict whitelist of columns and uses parameterized queries.
router.put('/providers/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body;

  const allowedColumns = ['name', 'provider_id', 'api_key', 'base_url', 'enabled'];
  const safeBody: Record<string, unknown> = {};

  for (const col of allowedColumns) {
    if (!(col in body)) continue;
    const val = body[col];
    if (val === undefined || val === null) continue;
    safeBody[col] = val;
  }

  const keys = Object.keys(safeBody);
  if (keys.length === 0) {
    res.status(400).json({ success: false, error: 'No valid fields to update', code: 'EMPTY_UPDATE' });
    return;
  }

  // Build parameterized UPDATE with explicit column mapping.
  const updates: string[] = [];
  const values: unknown[] = [];

  if ('name' in safeBody)            { updates.push('name = ?');             values.push(safeBody.name); }
  if ('provider_id' in safeBody)     { updates.push('provider_id = ?');      values.push(safeBody.provider_id); }
  if ('api_key' in safeBody)         { updates.push('api_key = ?');          values.push(secrets.encrypt(String(safeBody.api_key))); }
  if ('base_url' in safeBody)        { updates.push('base_url = ?');         values.push(safeBody.base_url); }
  if ('enabled' in safeBody)         { updates.push('enabled = ?');          values.push(safeBody.enabled ? 1 : 0); }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE providers SET ${updates.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ success: false, error: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    return;
  }
  res.json({ success: true });
});

// DELETE /admin-api/providers/:id
router.delete('/providers/:id', (req: Request, res: Response) => {
  // models.provider_id 外键指向 providers.id，且没有 ON DELETE CASCADE。
  // 直接 DELETE 会被 SQLite 拒（FOREIGN KEY constraint failed），原来冒到全局
  // error handler，客户端只看到 `{"error":{"message":"Internal server error"}}`
  // ——用户完全不知道是「这个上游下还挂着模型」（2026-11-08 实测踩到，
  // 当时对着 500 猜了很久）。现在先数一遍，有引用就 409 说清怎么处理。
  const id = req.params.id;
  const refRow = db.prepare('SELECT COUNT(*) AS n FROM models WHERE provider_id = ?').get(id) as any;
  const refCount = Number(refRow?.n ?? 0);
  if (refCount > 0) {
    res.status(409).json({
      success: false,
      error: `这个上游下还挂着 ${refCount} 个模型，先删掉这些模型再删上游`,
      code: 'PROVIDER_IN_USE',
      modelCount: refCount,
    });
    return;
  }
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ success: false, error: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    return;
  }
  res.json({ success: true });
});

// ==================== Model CRUD ====================

// GET /admin-api/models
router.get('/models', (_req: Request, res: Response) => {
  const models = db.prepare(`
    SELECT m.*, p.name as provider_name
    FROM models m
    LEFT JOIN providers p ON m.provider_id = p.id
    ORDER BY p.name, m.name
  `).all();
  res.json({ models });
});

// POST /admin-api/models
router.post('/models', (req: Request, res: Response) => {
  const { id, provider_id, name, enabled, alias } = req.body;
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    res.status(400).json({ success: false, error: 'Invalid model id format (allowed: a-zA-Z0-9_- up to 128 chars)', code: 'INVALID_ID' });
    return;
  }
  if (!provider_id || !name) {
    res.status(400).json({ success: false, error: 'Missing required fields: provider_id, name', code: 'MISSING_FIELDS' });
    return;
  }
  db.prepare('INSERT INTO models (id, provider_id, name, enabled, alias) VALUES (?, ?, ?, ?, ?)').run(
    id, provider_id, name, enabled ? 1 : 0, alias || null
  );
  res.json({ success: true });
});

// DELETE /admin-api/models/:id
router.delete('/models/:id', (req: Request, res: Response) => {
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== Route CRUD ====================

// GET /admin-api/routes
router.get('/routes', (_req: Request, res: Response) => {
  const routes = db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
  res.json({ routes });
});

// POST /admin-api/routes
router.post('/routes', (req: Request, res: Response) => {
  const { id, default_model, fallback_chain, rules, max_retries } = req.body;
  db.prepare('INSERT INTO routes (id, default_model, fallback_chain, rules, max_retries) VALUES (?, ?, ?, ?, ?)').run(
    id, default_model, JSON.stringify(fallback_chain || []), JSON.stringify(rules || []), max_retries || 2
  );
  res.json({ success: true });
});

// ==================== Logs ====================

// GET /admin-api/logs
router.get('/logs', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const logs = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit);
  const logsFormatted = (logs as any[]).map((l: any) => {
    const proxyField = l.proxy ? `[${l.proxy}] ` : '';
    return `[${l.timestamp}] ${proxyField}${l.level}: ${l.message}`;
  }).join('\n');
  res.json({ logs: logsFormatted });
});

// ==================== Health ====================

// GET /admin-api/cost — Q3 P1-B 成本闭环：读某日（缺省今天）实采成本汇总（只读，
//  不受采集门控约束——读 API 可查任意时刻历史；数据来自 cursor-cost.jsonl 实采，source='actual'。无数据→空 0 汇总，不产假值）。
router.get('/cost', (_req: Request, res: Response) => {
  try {
    const day = typeof _req.query.day === 'string' && _req.query.day ? _req.query.day : undefined;
    const summary = costTrack.getDailyCost(day);
    res.json({ ok: true, ...summary });
   } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /admin-api/health
router.get('/health', (_req: Request, res: Response) => {
  const providers = db.prepare('SELECT * FROM providers').all();
  const models = db.prepare('SELECT * FROM models WHERE enabled = 1').all();
  res.json({
    status: 'ok',
    providers: providers.length,
    models: models.length,
   });
});

// ==================== Settings ====================

// GET /admin-api/settings
router.get('/settings', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings: Record<string, unknown> = {};
  (rows as any[]).forEach(r => {
    const v = r.value;
    const t = r.value_type || 'string';
    if (t === 'number') settings[r.key] = Number(v);
    else if (t === 'boolean') settings[r.key] = v === 'true';
    else if (t === 'json') settings[r.key] = JSON.parse(v);
    else settings[r.key] = v;
  });
  res.json({ settings });
});

// PUT /admin-api/settings
router.put('/settings', (req: Request, res: Response) => {
  const { key, value, value_type } = req.body;
  let stringValue: string;
  let valueType = value_type || 'string';
  if (typeof value === 'number') {
    stringValue = String(value);
    valueType = 'number';
  } else if (typeof value === 'boolean') {
    stringValue = value ? 'true' : 'false';
    valueType = 'boolean';
  } else if (typeof value === 'object') {
    stringValue = JSON.stringify(value);
    valueType = 'json';
  } else {
    stringValue = String(value);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)').run(key, stringValue, valueType);
  res.json({ success: true });
});

export { router };

// ==================== P0-2 路由反馈闭环（只读）====================
// GET /admin-api/routing-feedback?days=7 → taskType × model 聚合（延迟/重试率/转发数）
router.get('/routing-feedback', (req: Request, res: Response) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days || 7)));
  res.json({ days, groups: aggregateFeedback(days) });
});
