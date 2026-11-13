// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ==================== 路由：元信息（autostart / health / version / installed / env-check） ====================
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const { requireAuth } = require('../lib/auth');
const pm = require('../lib/process-manager');
const { readRecentHealth } = require('../lib/health');
const gates = require('../lib/gates');
const gateEvidence = require('../lib/gate-evidence');

const router = express.Router();

// ==================== 开机自启管理 ====================
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.multi-proxy-manager.plist');
const INSTALL_SH = path.join(__dirname, '..', '..', 'install.sh');

router.get('/autostart', (_req, res) => {
  res.json({ enabled: fs.existsSync(LAUNCHD_PLIST) });
});

router.post('/autostart', requireAuth, async (req, res) => {
  try {
    const { enable } = req.body;
    if (enable) {
      execFile('bash', [INSTALL_SH, '--autostart'], (error) => {
        if (error) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.json({ success: true, enabled: true });
        }
      });
    } else {
      execFile('bash', [INSTALL_SH, '--autostop'], (error) => {
        if (error) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.json({ success: true, enabled: false });
        }
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 健康检查（浅探针：仅证明进程活着 + 路由已挂载）
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== 就绪探针（真实就绪契约） ====================
// `/health` 永远返回 {status:'ok'}，只能证明「manager 进程活着 + 路由挂载」，
// 无法区分「manager 起来了但 9 个代理全挂了」。过去状态判断只能靠「端口在听就当健康」，
// 是脆弱推断（端口被僵尸进程/别的程序占用都会误判）。
// `/readyz` 聚合每个代理的真实 /health 响应，给监控 / ingress 一个可判定的就绪信号：
//   - status='ready'：manager 可读 + 全部配置代理可达
//   - status='degraded'：manager 可读，但部分代理不可达（代理可被有意关停，故不判 not-ready）
//   - status='not-ready'(HTTP 503)：manager 自身关键依赖不可读
// 只读 GET，不需 auth（与 /health 一致）。
function probeProxyHealth(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(bomb);
      resolve(v);
    };
    // 🔴 硬时限兜底（2026-11-09）：http.get 的 `timeout` 选项只作用于**已建立的 socket**。
    //    连接本身挂住时它不生效 —— 典型场景是 listen backlog 满：内核把 SYN 丢掉，
    //    连接一直 pending，socket 还没被分配，于是 timeout 永远不触发。
    //    而 /readyz 是给监控/ingress 判死活用的，它一旦挂住，「服务是否就绪」这个问题的
    //    答案就变成「没有答案」，比返回 degraded 更糟。所以必须有一个不依赖 socket 的总时限。
    //    实测证据：全量 jest 并发跑时 health-graph 的 readyz 用例会 30s 超时，单跑 12/12 绿。
    const bomb = setTimeout(() => {
      if (req) {
        try {
          req.destroy();
        } catch {
          /* 已经坏了，不用管 */
        }
      }
      done({ reachable: false, reason: 'connect-timeout' });
    }, timeoutMs + 500);
    req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* 非 JSON 也按可达处理 */ }
          done({ reachable: true, statusCode: res.statusCode, health: parsed });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); done({ reachable: false, reason: 'timeout' }); });
    req.on('error', (e) => done({ reachable: false, reason: e.code || e.message }));
  });
}

router.get('/readyz', async (_req, res) => {
  const configs = pm.getProxyConfigs();
  // manager 自身关键依赖：代理配置能加载（非空集），门控真源能求值。
  const managerReady = Object.keys(configs).length > 0;

  const details = await Promise.all(
    Object.entries(configs).map(async ([name, cfg]) => {
      const r = await probeProxyHealth(cfg.port);
      const rawStatus = r.health && typeof r.health.status === 'string' ? r.health.status : null;
      return {
        name,
        port: cfg.port,
        reachable: r.reachable,
        status: r.reachable ? (rawStatus || 'unknown') : 'down',
        // 原因必须带出来：只说 down，用户无法区分「没启动」和「启动了但卡住」，
        // 这两种的处置完全相反（前者去 start，后者去看日志）。
        // probeProxyHealth 本来就算了 reason（timeout / ECONNREFUSED），
        // 之前没往上传，等于把最有用的一半丢了。
        reason: r.reachable ? null : (r.reason || 'unreachable'),
        health: r.health || null,
      };
    })
  );

  const reachable = details.filter((d) => d.reachable).length;
  const down = details.filter((d) => !d.reachable);

  let status = 'ready';
  if (!managerReady) status = 'not-ready';
  else if (down.length > 0) status = 'degraded';

  res
    .status(status === 'not-ready' ? 503 : 200)
    .json({
      status,
      timestamp: new Date().toISOString(),
      manager: { ready: managerReady, proxiesConfigured: details.length },
      proxies: { total: details.length, reachable, down: down.length, details },
    });
});

// M1: 健康历史回溯（最近 N 条 /api/status 持久化的归一化健康记录，倒序）
router.get('/health-history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json({ history: readRecentHealth(limit) });
});

// ==================== 版本信息 ====================
// 原先这里读 `../../..` + `package.json`：从 routes 上溯三级已经跑到仓库**外面**那一层了
// （routes → manager → 仓库根 → 上一级目录），再加仓库根本来就没有 package.json，
// 于是每次都 catch 到硬编码 1.0.0：概览页那个版本号从来就是假的，也没人发现。
// 2026-10-04 收口：仓库根放 VERSION 当唯一版本源（上溯两级即到），子包各读各自的 package.json。
// 读不到的写 'unknown'，不许拿一个像样的假数糊过去（跟 C0-3 那条假成本数字同一个毛病）。
const ROOT_DIR = path.join(__dirname, '..', '..');

function readRootVersion() {
  try {
    const lines = fs.readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!/^\d+\.\d+\.\d+/.test(lines[0] || '')) return { version: 'unknown', date: null };
    return { version: lines[0], date: lines[1] || null };
  } catch (e) {
    return { version: 'unknown', date: null };
  }
}

function readPackVersion(packDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, packDir, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) {
    // hermes-proxy 是 Python 项目，压根没有 package.json。一次发版是同一个版本号，
    // 读不到就跟着仓库的 VERSION 走（比显示 unknown 更接近事实），
    // 仓库 VERSION 也读不到时自然落到 'unknown'。
    return readRootVersion().version;
  }
}

router.get('/version', (_req, res) => {
  const root = readRootVersion();
  res.json({
    version: root.version,
    date: root.date,   // VERSION 第二行；以前是硬编码 2026-06-27，改一次版本就得记得改代码
    proxies: {
      codex: readPackVersion('codex-proxy'),
      hermes: readPackVersion('hermes-proxy'),
      cursor: readPackVersion('cursor-proxy'),
      // 2026-10-22 P0-1：面板已管 9 个代理，版本卡跟着补齐（键名与 buildProxyConfigs() 一致）。
      claude: readPackVersion('claude-proxy'),
      dsh: readPackVersion('dsh-proxy'),
      opencode: readPackVersion('opencode-proxy'),
      generic: readPackVersion('generic-openai-proxy'),
      'opencode-free': readPackVersion('opencode-free'),
      'workbuddy-shim': readPackVersion('workbuddy-shim'),
    },
  });
});

// 已安装的代理列表
router.get('/installed', (_req, res) => {
  res.json(Object.keys(pm.getProxyConfigs()));
});

// 2026-10-27 收口 PROXY_CONFIGS 多副本：服务端单一真源。
// 前端 dashboard / logs 启动时拉取本端点，拿「会漂移的状态字段」（name/port/defaultVersion），
// 删掉各自硬编码的 PROXY_CONFIGS 字面量副本。icon/iconClass 仍由前端 icons.js（决策 E 全站单一图标源）解析，
// 本端点只负责状态字段，正面消除 D7「声明态≠运行态」——加新代理不必再手动同步三处前端。
// 端口取 buildProxyConfigs() 实值；defaultVersion 复用 readPackVersion（与 /version 同源）。
router.get('/proxy-configs', (_req, res) => {
  const configs = pm.getProxyConfigs();
  const out = {};
  for (const [name, cfg] of Object.entries(configs)) {
    const packDir = cfg.cwd ? path.basename(cfg.cwd) : name;
    out[name] = {
      name: cfg.name,
      port: cfg.port,
      defaultVersion: readPackVersion(packDir),
    };
  }
  res.json(out);
});

// API Key 完整性检查
router.get('/env-check', (_req, res) => {
  const baseDir = path.join(__dirname, '..', '..', '..');
  const emptyKeys = [];

  for (const proxy of ['codex-proxy', 'hermes-proxy']) {
    const envPath = path.join(baseDir, proxy, '.env');
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      // Parse .env line-by-line, splitting on first '=' to handle values with spaces
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        if (['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'AGNES_API_KEY'].includes(k) && !v) {
          emptyKeys.push({ proxy, key: k });
        }
      }
    } catch (e) {
      // skip unreadable files
    }
  }

  res.json({ emptyKeys, totalCount: emptyKeys.length });
});

// ==================== 配置导出（设置页「备份」卡） ====================
// 2026-10-24：设置页那个「导出配置」按钮此前 href="/#/api/config-export"——
// 全仓根本没有这个路由，点下去只改 URL hash，什么也不会发生，是标准的假入口。
// 这里把它做真：只读导出 providers.json / pricing.json 副本，供迁移与备份。
// 🔴 安全红线：providers.json 里带 provider 的密钥字段，原样导出等于把钥匙写进
// 一个会被随手存进网盘/贴进工单的文件。导出一律按**字段名**脱敏（正则脱敏
// 认不出自定义格式的 key，字段名脱敏才靠得住），并在响应里回报脱敏了哪些字段。
const CONFIG_DIR = require('../lib/data-dir').resolveDataDir();
const SECRET_FIELD_RE = /(key|token|secret|password|passwd|credential|authorization)/i;

function maskSecrets(value, hitFields, trail) {
  if (Array.isArray(value)) return value.map((v, i) => maskSecrets(v, hitFields, trail + '[' + i + ']'));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const at = trail ? trail + '.' + k : k;
      if (SECRET_FIELD_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        if (v !== '' && v != null) hitFields.push(at);
        out[k] = (v === '' || v == null) ? v : '<REDACTED>';
      } else {
        out[k] = maskSecrets(v, hitFields, at);
      }
    }
    return out;
  }
  return value;
}

function readConfigFile(name) {
  const p = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(p)) return { present: false, data: null };
  try {
    return { present: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    // 解析失败就明说，不许塞一个空对象冒充「没有配置」
    return { present: true, data: null, error: 'parse-failed: ' + e.message };
  }
}

router.get('/config-export', requireAuth, (_req, res) => {
  const hitFields = [];
  const files = {};
  for (const name of ['providers.json', 'pricing.json']) {
    const { present, data, error } = readConfigFile(name);
    if (!present) { files[name] = { present: false }; continue; }
    if (error) { files[name] = { present: true, error }; continue; }
    files[name] = { present: true, data: maskSecrets(data, hitFields, '') };
  }
  res.json({
    exportedAt: new Date().toISOString(),
    files,
    redactedFields: hitFields,
    note: '密钥类字段已按字段名脱敏（<REDACTED>）。导出件不含可用凭据，恢复到另一台机器后需重新填 key。',
  });
});

// ==================== 能力门控状态（面板顶部状态条的唯一数据源） ====================
// 2026-10-24 外部审计（DeepSeek）指出的核心体验问题：README 承诺的能力按非侵入铁律
// 默认门控关闭，但面板上没有任何一处告诉用户「你现在是关着的」，于是「未开启」
// 被用户读成「功能没做 / 假功能」。这个端点把这些门控的真实当前值暴露出来，
// 让面板能直说「你现在在开箱默认态，以下 N 项能力需要显式开启」。
// 只读 GET，不需 auth（与本文件其它元信息端点一致）。
//
// 2026-11-08：每项挂 `evidence`（运行证据）。理由见 lib/gate-evidence.js 头注释——
// 「门控开着」和「真跑过」是两件事，此前状态条只答前者，用户把「开着但一次没走过」
// 也当成交付了。证据只带**次数与时间**，不带金额、不带模型名，所以不构成
// 需要鉴权的运营数据；顺手也避免了这个免 auth 端点变成用量泄露口。
router.get('/gates', (_req, res) => {
  try {
    const rows = gates.list().map((g) => ({ ...g, evidence: gateEvidence.forGate(g.evidenceKey) }));
    res.json({ gates: rows, summary: gates.summary() });
  } catch (e) {
    res.status(500).json({ error: '读取门控状态失败', detail: e.message });
  }
});

// ==================== M3 方向三：错误模式库查询（只读） ====================
// /api/errors/patterns  — 全部模式（按频次降序），前端"常见问题"面板用
// /api/errors/history   — 结构化错误历史（最新在前），支持 ?q= 关键词检索
// 只读 GET，不需 auth（与本文件其它元信息端点一致）
const errorPatterns = require('../lib/error-patterns');

router.get('/errors/patterns', (_req, res) => {
  try {
    res.json({ patterns: errorPatterns.getPatterns(true) });
   } catch (e) {
    res.status(500).json({ error: '读取错误模式失败', detail: e.message });
   }
});

router.get('/errors/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const history = q ? errorPatterns.searchHistory(q, limit) : errorPatterns.getHistory(limit);
    res.json({ history });
   } catch (e) {
    res.status(500).json({ error: '读取错误历史失败', detail: e.message });
   }
});

module.exports = router;

// 测试辅助：配置导出的脱敏函数是安全相关逻辑（漏脱一个字段 = 导出件带可用凭据），
// 必须可单测。路由本身不暴露它。
router._maskSecrets = maskSecrets;
