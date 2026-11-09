// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * proxy-default-ports.test.js — 每个代理的「默认端口」必须等于 manage.sh 的口径
 *
 * 背景（2026-11-08 实测踩到，全新用户必踩）：
 *   dsh-proxy/proxy.js 的默认端口还留着 18790（它是从 codex-proxy 拷过来的，
 *   拷贝时没改）。而 dsh-proxy 原本**没有 .env.example**，install.sh 的规则是
 *   「有模板才建 .env」，于是全新用户装完 dsh 根本没有 .env，PORT 就落到那个
 *   默认值上 —— 它去抢 codex 的 18790：
 *     · codex 已在跑 → EADDRINUSE 秒退，manage.sh 只报「DSH Proxy 启动失败」
 *     · codex 没跑   → dsh 占了 18790，之后 codex 起不来
 *   两种症状都和「端口复制错了」看不出关系。
 *
 * 实测证据：临时移走 dsh-proxy/.env 后 `node proxy.js`，日志打印
 *   `Codex Multi-Model Proxy started on 127.0.0.1:18790`
 * （连日志名都是 codex 的，排查时会看错进程）。
 *
 * 所以这里钉两件事，任何一件漏了都会让上面那个 bug 换个形态回来：
 *   ① proxy.js / proxy.py 里的默认端口 === manage.sh 的 <SERVICE>_PORT
 *   ② 每个代理目录都有 .env.example，且其中 PORT= 与默认值一致
 *      （没有 .env.example ⇒ install.sh 不建 .env ⇒ 默认值就是唯一生效值）
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MANAGE_SH = path.join(REPO_ROOT, 'manage.sh');

/** 服务名 → 代理目录。只映射「有独立进程且自己能 listen」的那些。 */
const LANES = {
  codex: { dir: 'codex-proxy', file: 'proxy.js' },
  claude: { dir: 'claude-proxy', file: 'proxy.js' },
  opencode: { dir: 'opencode-proxy', file: 'proxy.js' },
  generic: { dir: 'generic-openai-proxy', file: 'proxy.js' },
  dsh: { dir: 'dsh-proxy', file: 'proxy.js' },
  hermes: { dir: 'hermes-proxy', file: 'proxy.py' },
};

/** 从 manage.sh 解析 <NAME>_PORT=NNNN（大小写不敏感：里面真有 `CODEx_PORT`） */
function managePorts() {
  const src = fs.readFileSync(MANAGE_SH, 'utf8');
  const out = {};
  const re = /^\s*([A-Za-z_]+)_PORT=(\d{2,5})\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1].toUpperCase()] = m[2];
  return out;
}

/** 从源码里抽「端口环境变量取不到时用的默认值」 */
function defaultPortOf(file, src) {
  // JS:  parseInt(process.env.PORT) || 18790
  const js = src.match(/process\.env\.PORT\)?\s*\|\|\s*(\d{2,5})/);
  if (js) return js[1];
  // Python: int(os.environ.get('PORT', 18793))
  const py = src.match(/os\.environ\.get\(\s*['"]PORT['"]\s*,\s*(\d{2,5})\s*\)/);
  if (py) return py[1];
  return null;
}

describe('各代理默认端口 === manage.sh 口径', () => {
  const ports = managePorts();

  it('manage.sh 里能解析出每个 lane 的端口（否则本测试自身失效）', () => {
    for (const svc of Object.keys(LANES)) {
      expect({ svc, port: ports[svc.toUpperCase()] || null }).toEqual({
        svc,
        port: expect.stringMatching(/^\d{4,5}$/),
      });
    }
  });

  for (const [svc, lane] of Object.entries(LANES)) {
    const expected = () => ports[svc.toUpperCase()];

    it(`${svc}: ${lane.dir}/${lane.file} 的默认端口等于 ${svc.toUpperCase()}_PORT`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, lane.dir, lane.file), 'utf8');
      const actual = defaultPortOf(lane.file, src);
      // 解析不出来就红：正则失效会让整条断言变成空转的绿
      expect({ lane: svc, default: actual }).toEqual({ lane: svc, default: expected() });
    });

    it(`${svc}: 有 .env.example，且里面的 PORT= 与默认端口一致`, () => {
      const envPath = path.join(REPO_ROOT, lane.dir, '.env.example');
      // 缺 .env.example ⇒ install.sh 不建 .env ⇒ 默认值是唯一生效值。
      // 这就是 dsh 那次 bug 的前半段，必须单独钉住。
      expect({ lane: svc, envExampleExists: fs.existsSync(envPath) }).toEqual({
        lane: svc,
        envExampleExists: true,
      });
      const envSrc = fs.readFileSync(envPath, 'utf8');
      const m = envSrc.match(/^PORT=(\d{2,5})\s*$/m);
      expect({ lane: svc, envPort: m ? m[1] : null }).toEqual({ lane: svc, envPort: expected() });
    });
  }

  it('默认端口两两不重复（撞了就是必然抢端口）', () => {
    const seen = {};
    for (const [svc, lane] of Object.entries(LANES)) {
      const src = fs.readFileSync(path.join(REPO_ROOT, lane.dir, lane.file), 'utf8');
      const p = defaultPortOf(lane.file, src);
      expect({ port: p, takenBy: seen[p] || null }).toEqual({ port: p, takenBy: null });
      seen[p] = svc;
    }
  });
});
