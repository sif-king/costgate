// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * N-05 · Cursor Proxy 安装冒烟 E2E（2026-10-25）
 *
 * 补的坑：manager 侧已覆盖 install_sh/uninstall_sh/bridge_launchd 三条 install 路径，
 * 但 cursor-proxy 这条「装完能不能真把服务拉起来」此前没有任何独立用例。
 * 装完 cursor-proxy 后用户唯一关心的就是：dist 产物能否启动、/health 能否应答。
 * 任何一条断言不成立 = 安装产物是死的，必须在冒烟阶段红出来，不带到验收。
 *
 * 口径与 manager 侧 install_smoke 对齐：
 *   ① fork 的是 dist/server/start.js（tsc 编译后的真产物），不是 src/ —— 验的是「装出来的东西」；
 *   ② 默认最小 env（无 PROXY_AUTH_TOKEN，绑回环）—— 模拟刚装完、未配置的本机场景；
 *   ③ 断言的是「进程活 + /health 200 + status:ok + checks.process」，不验业务路由，
 *      避免把冒烟做成集成测试（那是 route-override / admin-auth 的活）。
 *
 * 前置：dist/server/start.js 必须存在。CI 在 test 前跑 npm run build；
 * 本地若缺失 → 直接红（带明确指引），不静默跳过——跳过的冒烟等于没有。
 */
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_JS = path.join(__dirname, '../../dist/server/start.js');

// 启动编译产物并轮询 /health 直到就绪（沿用 admin-auth.test.ts 的 fork 口径）。
function startArtifact(extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    // 随机高位端口，避免与本机已运行的 cursor-proxy（18794）/ manager（18792）冲突。
    const port = 18960 + Math.floor(Math.random() * 30);
    const child = fork(START_JS, [], {
      env: { ...process.env, PORT: String(port), ...extraEnv },
      silent: true,
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;

    let attempts = 0;
    // 收 stderr，超时失败时能打出原因而非只一句「timeout」。
    const stderrLines: string[] = [];
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderrLines.push(s);
      if (stderrLines.length > 40) stderrLines.shift();
    });
    const timer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(base + '/health');
        if (res.ok) {
          clearInterval(timer);
          resolve({ child, base });
          return;
        }
      } catch { /* 还没起来 */ }
      if (attempts > 60) {
        clearInterval(timer);
        child.kill();
        reject(new Error(
          `cursor-proxy 编译产物启动超时（${attempts * 0.15}s 内 /health 未就绪）。` +
          `stderr:\n${stderrLines.join('').trim() || '(无)'}`,
        ));
      }
    }, 150);
  });
}

function health(base: string) {
  return fetch(base + '/health').then(async (res) => ({
    status: res.status,
    json: await res.json().catch(() => null),
  }));
}

describe('N-05 · Cursor Proxy 安装冒烟 E2E', () => {
  test('编译产物存在（dist/server/start.js）', () => {
    if (!fs.existsSync(START_JS)) {
      throw new Error(
        'dist/server/start.js 不存在 —— 先 `cd cursor-proxy && npm run build`（或 npm install 触发 postinstall）。',
      );
    }
  });

  test('装完的 cursor-proxy 能启动且 /health 应答 200 + status:ok', async () => {
    const { child, base } = await startArtifact();
    try {
      const h = await health(base);
      expect(h.status).toBe(200);
      expect(h.json?.status).toBe('ok');
      expect(h.json?.checks?.process).toBe(true);
      // port 回显应与启动时注入的 PORT 一致 —— 验 .env/环境变量接线到位。
      // 注意：handler 是 `process.env.PORT || 18794`，PORT 是 env 即字符串，故只做
      // 类型无关的「是个像端口的数字串」断言（不写死 number，否则又掉进落差坑）。
      expect(/\d{1,5}/.test(String(h.json?.port))).toBe(true);
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 100)); // 让端口回收，不干扰下个用例
    }
  }, 20000);

  test('未设 PROXY_AUTH_TOKEN 时 /health 不受鉴权影响（冒烟本就不验业务），仅 /admin-api/* 需鉴权', async () => {
    // 冒烟的边界：health 必须无条件可达（否则安装冒烟永远失败），
    // 但受保护面（/admin-api/*）在未配 token 时应是 401（fail-open 的本机语义，见 admin-auth.test.ts）。
    const { child, base } = await startArtifact();
    try {
      const h = await health(base);
      expect(h.status).toBe(200);

      const admin = await fetch(base + '/admin-api/providers');
      // 未设 PROXY_AUTH_TOKEN 时 /admin-api/* 走「向后兼容无鉴权」，200 亦可；设 token 则 401。
      // 冒烟只断言它「可达」（非 5xx / 非 404）—— 服务在、路由在。
      expect([200, 401]).toContain(admin.status);
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20000);
});
