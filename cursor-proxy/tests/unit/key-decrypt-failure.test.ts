// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * 回归测试：上游 API Key 解不开时，服务必须活着并说清原因。
 *
 * 2026-11-08 实测踩到（复现步骤：把 data/proxy.db 拷到一台没有 .encryption-key
 * 的机器 / Docker 重建没挂载密钥文件 / 隔离 HOME 跑测试）：
 *
 *   Error: Unsupported state or unable to authenticate data
 *       at Decipheriv.final
 *       at SecretsManager.decrypt (dist/utils/crypto.js)
 *       at findProviderConfig (dist/server/handlers/chatHandler.js)
 *       at handleChatCompletion (dist/server/handlers/chatHandler.js)
 *   [cursor-proxy] 代理服务异常退出，代码 1
 *
 * 两个问题叠在一起：
 *   ① findProviderConfig 里三处 secrets.decrypt 没有 try/catch
 *      （同文件的 findProviderByType / loadEnabledProviderConfigs 都有——
 *        所以这不是「设计如此」，是同文件纪律漏了一处）
 *   ② handleChatCompletion 是 async，Express 4 不接管 async 异常 ⇒
 *      unhandledRejection ⇒ Node 22 默认直接结束进程
 *
 * 症状与原因完全脱节：用户看到「服务莫名退出」，日志一段堆栈；实际原因是
 * 某一个上游的 key 解不开。
 *
 * 本测试锁两件事，缺一件这个 bug 就能换个形态回来：
 *   A. 解密失败抛出的错误必须自带 code=KEY_DECRYPT_FAILED + 修复指引
 *      （不能是裸的 crypto 错误——那样上层无从分辨，用户也无从修）
 *   B. asyncHandler 必须接住 rejection：不抛到进程顶层，改成 422/500 响应
 *      （只做 A 不做 B，进程照样死）
 */
import { jest } from '@jest/globals';
import { db } from '../../src/db/database.js';
import { findProviderConfig } from '../../src/server/handlers/chatHandler.js';
import { asyncHandler } from '../../src/server/routes/chatRoutes.js';

/** 一条 provider：api_key 是随机十六进制，任何密钥都解不开（GCM tag 校验必失败） */
const BAD_PROVIDER_ID = 'test-bad-key-provider';
const BAD_MODEL = 'test-bad-key-model';

function insertBadProvider(): void {
  // 不能用 INSERT OR REPLACE：它会先 DELETE，而 models 有外键指向 providers，
  // 删除被拒（FOREIGN KEY constraint failed）。也不能用真实类型名当 provider_id
  // —— providers.provider_id 上有 UNIQUE 索引，真库里早有一条 'openai' 了。
  // 这里只需要「能被 findProviderConfig 选中且解不开」，类型名无所谓。
  db.prepare('DELETE FROM models WHERE id = ?').run(BAD_MODEL);
  db.prepare('DELETE FROM providers WHERE id = ?').run(BAD_PROVIDER_ID);
  db.prepare(
    `INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(BAD_PROVIDER_ID, 'bad-key-lane', 'test-only-type', 'deadbeef'.repeat(8), 'http://127.0.0.1:9/v1');
  db.prepare(
    `INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, 1)`
  ).run(BAD_MODEL, BAD_PROVIDER_ID, BAD_MODEL);
}

function cleanup(): void {
  try {
    db.prepare('DELETE FROM models WHERE id = ?').run(BAD_MODEL);
  } catch {
    /* 忽略 */
  }
  try {
    db.prepare('DELETE FROM providers WHERE id = ?').run(BAD_PROVIDER_ID);
  } catch {
    /* 忽略 */
  }
}

/** 假的 res：只记录被调用的 status/json/end，够断言用 */
function fakeRes() {
  const calls: { status?: number; body?: any; ended: boolean; headersSent: boolean } = {
    ended: false,
    headersSent: false,
  };
  return {
    res: {
      headersSent: false,
      status(code: number) {
        calls.status = code;
        return this;
      },
      json(body: any) {
        calls.body = body;
        return this;
      },
      end() {
        calls.ended = true;
        return this;
      },
    } as any,
    calls,
  };
}

describe('解密失败：可识别 + 不崩进程', () => {
  beforeEach(() => {
    // 干净起点：确保上一轮留下的脏数据不影响
    cleanup();
    insertBadProvider();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES ('routing_mode', 'priority', 'string')").run();
  });

  afterEach(() => {
    cleanup();
  });

  it('A. findProviderConfig 对坏密文抛 KEY_DECRYPT_FAILED，且消息里给得出修复办法', () => {
    let caught: any = null;
    try {
      findProviderConfig(BAD_MODEL);
    } catch (e) {
      caught = e;
    }
    // 没抛说明这条 provider 根本没被选中（测试前提失效），或者解密被静默吞了
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('KEY_DECRYPT_FAILED');
    // 消息必须是「人能照着修」的，不能只回一句 Internal server error
    expect(String(caught.message)).toMatch(/加密密钥/);
    expect(String(caught.message)).toMatch(/\.encryption-key/);
    // 原始 crypto 报错不能是唯一信息（那样看不出是哪个上游）
    expect(String(caught.message)).toMatch(/bad-key-lane/);
  });

  it('B. asyncHandler 接住 rejection：不抛到顶层，改成 500 + code', () => {
    const boom = async () => {
      const e = new Error('无法解密上游「x」的 API Key') as any;
      e.code = 'KEY_DECRYPT_FAILED';
      e.status = 500;
      throw e;
    };
    const { res, calls } = fakeRes();
    // 关键断言：这一行不能抛（抛了就是进程退出，Node 22 的默认行为）
    expect(() => {
      asyncHandler(boom as any)({} as any, res);
    }).not.toThrow();
    // 返回的是 Promise，等它 settle 后再断言（不等就是空的绿）
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(calls.status).toBe(500);
        expect(calls.body?.success).toBe(false);
        expect(calls.body?.code).toBe('KEY_DECRYPT_FAILED');
        resolve();
      });
    });
  });

  it('B2. 没有 code 的普通异常 → 500 INTERNAL_ERROR，不透传内部细节', () => {
    const boom = async () => {
      throw new Error('some internal detail that must not leak verbatim to a client');
    };
    const { res, calls } = fakeRes();
    expect(() => {
      asyncHandler(boom as any)({} as any, res);
    }).not.toThrow();
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(calls.status).toBe(500);
        expect(calls.body?.code).toBe('INTERNAL_ERROR');
        resolve();
      });
    });
  });

  it('B3. 已经开始流式输出（headersSent）时只收尾，不再写 JSON', () => {
    const boom = async () => {
      throw new Error('boom mid-stream');
    };
    const { res, calls } = fakeRes();
    res.headersSent = true;
    expect(() => {
      asyncHandler(boom as any)({} as any, res);
    }).not.toThrow();
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(calls.body).toBeUndefined(); // 不能再 json，否则 Express 会抛 ERR_HTTP_HEADERS_SENT
        expect(calls.ended).toBe(true);
        resolve();
      });
    });
  });
});

describe('C. 路由确实接到了 asyncHandler 上（否则 A/B 全绿、生产照崩）', () => {
  // 这条看着多余，其实是本 bug 最容易被「修一半」的地方：
  // 把 asyncHandler 写好、测好，却忘了把 router.post 挂上去，
  // 于是测试全绿而线上照样 unhandledRejection 退出进程。
  it('chatRoutes 里 /chat/completions 挂的是 asyncHandler(handleChatCompletion)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../../src/server/routes/chatRoutes.ts'), 'utf8');
    expect(src).toMatch(/router\.post\(\s*['"]\/chat\/completions['"]\s*,\s*asyncHandler\(\s*handleChatCompletion\s*\)/);
  });

  it('findProviderConfig 的三处解密都走 safeDecrypt（不留裸 secrets.decrypt）', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../../src/server/handlers/chatHandler.ts'), 'utf8');
    // findProviderConfig 函数体（从定义到下一个顶层 export）
    const start = src.indexOf('export function findProviderConfig');
    expect(start).toBeGreaterThan(-1);
    const nextExport = src.indexOf('\nexport ', start + 10);
    const body = src.slice(start, nextExport === -1 ? undefined : nextExport);
    // 热路径里不允许出现裸调用；有就已经是「服务会退出」的那种 bug
    expect(body).not.toMatch(/secrets\.decrypt\(/);
    expect((body.match(/safeDecrypt\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
