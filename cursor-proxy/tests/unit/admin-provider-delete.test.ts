// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * 回归测试：删上游时如果它下面还挂着模型，必须说清「先删模型」。
 *
 * 2026-11-08 实测踩到（配零 key 上游时想腾出 openai 槽位）：
 *   DELETE /admin-api/providers/<id>
 *   → {"error":{"message":"Internal server error"}}   ← 500，没有任何原因
 *
 * 真实原因：models.provider_id 外键指向 providers.id，没有 ON DELETE CASCADE，
 * SQLite 抛 FOREIGN KEY constraint failed，冒到全局 error handler 变成一句
 * 通用 500。人只能靠猜——我当时猜过「id 不存在」「权限」「库锁了」，都不是。
 *
 * 现在返回 409 + code=PROVIDER_IN_USE + 还挂着几个模型。本测试锁住它。
 *
 * 方式与 admin-auth.test.ts 一致：fork dist 起真 HTTP 服务（随机高位端口），
 * 打真接口。测试用的 provider/model 用固定 id，前后都清，不留脏数据。
 */
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_JS = path.join(__dirname, '../../dist/server/start.js');

const PID_PROVIDER = 'test-in-use-provider';
const PID_MODEL = 'test-in-use-model';

function startServer(): Promise<{ child: any; base: string }> {
  return new Promise((resolve, reject) => {
    const port = 19190 + Math.floor(Math.random() * 60);
    const child = fork(START_JS, [], {
      env: { ...process.env, PORT: String(port) },
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
      if (attempts > 100) {
        clearInterval(timer);
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('server did not start'));
      }
    }, 100);
  });
}

async function cleanup(base: string): Promise<void> {
  // 先删 model 再删 provider（这就是被测的那个顺序）
  await fetch(`${base}/admin-api/models/${PID_MODEL}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${base}/admin-api/providers/${PID_PROVIDER}`, { method: 'DELETE' }).catch(() => {});
}

describe('删上游：还挂着模型时说清原因，不是一句 500', () => {
  let child: any;
  let base = '';

  beforeAll(async () => {
    ({ child, base } = await startServer());
    await cleanup(base);
    const p = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: PID_PROVIDER,
        name: 'test-in-use-lane',
        // 只用 'test-only-type'：providers.provider_id 上有 UNIQUE 索引，
        // 用真类型名（openai/deepseek…）会撞掉库里的既有记录。
        provider_id: 'test-only-type',
        api_key: 'placeholder',
        base_url: 'http://127.0.0.1:9/v1',
        enabled: true,
      }),
    });
    if (!p.ok) throw new Error(`setup provider failed: ${p.status} ${await p.text()}`);
    const m = await fetch(`${base}/admin-api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PID_MODEL, provider_id: PID_PROVIDER, name: PID_MODEL, enabled: true }),
    });
    if (!m.ok) throw new Error(`setup model failed: ${m.status} ${await m.text()}`);
  }, 30000);

  afterAll(async () => {
    if (base) await cleanup(base);
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  });

  it('有模型引用时返回 409 PROVIDER_IN_USE，并说明还挂着几个', async () => {
    const res = await fetch(`${base}/admin-api/providers/${PID_PROVIDER}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe('PROVIDER_IN_USE');
    expect(body.modelCount).toBe(1);
    // 不能只是「失败」——得让人知道下一步做什么
    expect(String(body.error)).toMatch(/先删/);
  });

  it('模型删掉之后，同一个上游可以正常删掉', async () => {
    const dm = await fetch(`${base}/admin-api/models/${PID_MODEL}`, { method: 'DELETE' });
    expect(dm.ok).toBe(true);
    const res = await fetch(`${base}/admin-api/providers/${PID_PROVIDER}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
  });

  it('删一个不存在的上游仍然是 404（别把「有引用」和「不存在」混成一个错）', async () => {
    const res = await fetch(`${base}/admin-api/providers/definitely-not-a-real-provider-id`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.code).toBe('PROVIDER_NOT_FOUND');
  });
});
