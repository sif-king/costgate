// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * 回归测试：免鉴权上游（本机 Ollama、LM Studio、vLLM、Kilo 匿名池）不能被强行塞一个
 * `Authorization: Bearer` 头。
 *
 * 2026-11-08 实测踩到：想给 cursor-proxy 配零 key 上游（Kilo 匿名池），
 * providers 表 api_key 是 NOT NULL 且 POST 把它列为必填，于是只能填个占位串；
 * 结果 chatHandler 无条件发 `Authorization: Bearer placeholder...`，Kilo 回
 *   401 {"code":"INVALID_TOKEN","message":"Your authentication token is invalid."}
 * 从用户视角看是「key 填错了」，实际是这条上游根本不该收到鉴权头。
 *
 * 两处一起改才有意义：
 *   1. POST /admin-api/providers 允许 api_key 留空（不再逼人编一个假 key）
 *   2. 发请求时 api_key 为空/纯空白就不发 Authorization（prod: providers/base.ts bearerAuth）
 *
 * 本测试用「本地假上游 + 隔离数据目录」验证真实发出的字节，不依赖外网：
 *   · 假上游录下每个请求的 authorization 头
 *   · cursor-proxy 整份 dist 复制到临时目录，providers 库跟着走临时目录，不碰真实库
 *   · 顺带覆盖：data/ 目录不存在时进程能自己建（此前直接崩在
 *     "Cannot open database because the directory does not exist"）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '../..');
const SRC_DIST = path.join(PKG_ROOT, 'dist');
const SRC_NODE_MODULES = path.join(PKG_ROOT, 'node_modules');

const PID_ANON = 'test-anon-lane';      // 空 key 上游
const PID_KEYED = 'test-keyed-lane';    // 有 key 上游
const MODEL_ANON = 'test-anon-model';
const MODEL_KEYED = 'test-keyed-model';

/** 假上游：录下每次请求的 authorization，回一个合法的 OpenAI 响应 */
function startFakeUpstream(): Promise<{ server: http.Server; port: number; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        seen.push(String(req.headers.authorization ?? '<none>'));
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'fake-1',
              object: 'chat.completion',
              model: 'fake',
              choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
            })
          );
        });
        return;
      }
      // /models 之类的探活
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, seen });
    });
  });
}

/** 把 dist 复制到临时目录后再启动：数据目录跟着走，不污染真实 cursor-proxy/data */
function startIsolatedServer(tmp: string, port: number): Promise<{ child: any; base: string }> {
  return new Promise((resolve, reject) => {
    const appDir = path.join(tmp, 'cursor-proxy');
    fs.mkdirSync(appDir, { recursive: true });
    fs.cpSync(SRC_DIST, path.join(appDir, 'dist'), { recursive: true });
    // 故意不建 appDir/data —— 由 database.ts 自己建
    fs.symlinkSync(SRC_NODE_MODULES, path.join(appDir, 'node_modules'), 'dir');

    const child = fork(path.join(appDir, 'dist/server/start.js'), [], {
      env: { ...process.env, PORT: String(port), ENCRYPTION_KEY: 'test-only-key-0123456789abcdef' },
      silent: true,
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(base + '/health');
        if (res.ok) {
          clearInterval(timer);
          resolve({ child, base });
          return;
        }
      } catch {
        /* 还没起来 */
      }
      if (attempts > 900) {
        // cursor 冷启实测 18–30s，给够 90s
        clearInterval(timer);
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('cursor-proxy 90s 内没起来'));
      }
    }, 100);
  });
}

describe('免鉴权上游：api_key 为空时不该发 Authorization', () => {
  let tmp = '';
  let child: any;
  let base = '';
  let fake: { server: http.Server; port: number; seen: string[] };
  let anonProviderId = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cursor-auth-'));
    fake = await startFakeUpstream();
    const port = 19310 + Math.floor(Math.random() * 60);
    ({ child, base } = await startIsolatedServer(tmp, port));

    const upstreamBase = `http://127.0.0.1:${fake.port}/v1`;

    const rAnon = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: PID_ANON,
        provider_id: 'openai',
        api_key: '', // ← 关键：留空
        base_url: upstreamBase,
        enabled: true,
      }),
    });
    if (!rAnon.ok) throw new Error(`建空 key 上游失败: ${rAnon.status} ${await rAnon.text()}`);
    anonProviderId = (await rAnon.json()).id;

    const rKeyed = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: PID_KEYED,
        provider_id: 'generic',
        api_key: 'sk-test-123',
        base_url: upstreamBase,
        enabled: true,
      }),
    });
    if (!rKeyed.ok) throw new Error(`建有 key 上游失败: ${rKeyed.status} ${await rKeyed.text()}`);
    const keyedId = (await rKeyed.json()).id;

    // 默认 routing_mode=failover → 按模型名精确找上游
    for (const [mName, pId] of [
      [MODEL_ANON, anonProviderId],
      [MODEL_KEYED, keyedId],
    ]) {
      const r = await fetch(`${base}/admin-api/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: mName, provider_id: pId, name: mName, enabled: true }),
      });
      if (!r.ok) throw new Error(`建模型映射失败: ${r.status} ${await r.text()}`);
    }
  }, 120000);

  afterAll(async () => {
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => fake?.server.close(() => r()));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function chat(model: string) {
    return fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }),
    });
  }

  it('空 api_key 的上游能建成（不再被 MISSING_FIELDS 拦下）', () => {
    expect(anonProviderId).toBeTruthy();
  });

  it('请求空 key 上游时，上游收到的第一件事是没有 authorization 头', async () => {
    fake.seen.length = 0;
    const res = await chat(MODEL_ANON);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe('pong');
    expect(fake.seen).toHaveLength(1);
    // 核心断言：不是 `Bearer `（空值），而是压根没有这个头
    expect(fake.seen[0]).toBe('<none>');
  });

  it('有 key 的上游照旧发 Bearer，且用真实值（别为了免鉴权把正常的也关掉）', async () => {
    fake.seen.length = 0;
    const res = await chat(MODEL_KEYED);
    expect(res.status).toBe(200);
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toBe('Bearer sk-test-123');
  });

  it('缺 base_url 仍然是 400，且提示里说清 api_key 可以留空', async () => {
    const res = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-base-url', provider_id: 'ollama', api_key: '' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe('MISSING_FIELDS');
    expect(String(body.error)).toMatch(/api_key 可留空/);
  });

  it('data/ 目录不存在时进程自己建（不是崩在「directory does not exist」）', () => {
    expect(fs.existsSync(path.join(tmp, 'cursor-proxy/data/proxy.db'))).toBe(true);
  });

  it('源码级：chatHandler 里不再有裸的 `Bearer ${providerConfig.apiKey}`', () => {
    const src = fs.readFileSync(path.join(PKG_ROOT, 'src/server/handlers/chatHandler.ts'), 'utf8');
    // 只看代码行，注释里提到这个写法不算违规
    const codeLines = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(codeLines).not.toMatch(/Bearer \$\{providerConfig\.apiKey\}/);
    expect(codeLines).toMatch(/bearerAuth\(providerConfig\.apiKey\)/);
  });

  it('源码级：四个发上游请求的地方都不再有裸 `Bearer ${...}`', () => {
    const files = [
      'src/providers/openai-compatible.ts',
      'src/providers/generic.ts',
      'src/monitoring/healthMonitor.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(PKG_ROOT, f), 'utf8');
      const codeLines = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect({ file: f, hit: /Bearer \$\{/.test(codeLines) }).toEqual({ file: f, hit: false });
    }
  });
});
