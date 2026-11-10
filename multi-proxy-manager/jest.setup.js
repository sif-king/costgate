// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// jest 测试隔离：把 logger + error-patterns + 成本账本的全部文件写入重定向到 tmp，
// 避免 17 个测试文件里打 error 级日志污染真实 ~/.multi-proxy-manager 历史/模式/账本文件。
const os = require('os');
const path = require('path');

const pid = process.pid;
const loggerTmp = path.join(os.tmpdir(), `jest-requests-${pid}.log`);
const errHistTmp = path.join(os.tmpdir(), `jest-error-history-${pid}.jsonl`);
const errPatTmp = path.join(os.tmpdir(), `jest-error-patterns-${pid}.json`);
const phTmp = path.join(os.tmpdir(), `jest-provider-health-${pid}.json`);
// 成本账本（cost-track 的 cost-ledger.jsonl）：走 env 而不是 setLedgerFile，
// 因为 ledgerFile() 每次调用都读 PROXY_COST_LEDGER。不重定向的话，任何在门控开时
// 落账的用例都会往真实账本里塞假数据（2026-10-03 实测一次全量套件写了 14 行）。
const ledgerTmp = path.join(os.tmpdir(), `jest-cost-ledger-${pid}.jsonl`);
process.env.PROXY_COST_LEDGER = ledgerTmp;

// 2026-11-06：对齐 CI 的 manager job 级 env（.github/workflows/p0-security-gate.yml）。
// lib/auth.js 的 needsPasswordSetup() 认这个 env：本机若无 ~/.multi-proxy-manager/password
// 且未注入该 env，「回环免鉴权」默认激活 → 8 个「无 token 应 401」套件恒假红。
// CI 注释里「本机 Jason 有密码文件」是已过期前提（本机实测该文件不存在）。
// 必须放在 setupFiles：这里设的值才会进入 jest.setup-afterenv.js 的 envSnap，被 afterEach 全程保持；
// 若在测试文件 module-load 顶层设，第一个 afterEach 就会把它删掉。
// 想测「无密码回环放行」的测试自行 delete/save-restore（loopback-auth.test.js 已如此），实测全量不冲突。
// 实测：注入前 111 套件 8 failed / 1651 passed；注入后 111 套件全绿、1662/1662。
process.env.MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'jest-local-account-mode';

const logger = require('./lib/logger');
const ep = require('./lib/error-patterns');

logger.setLogFile(loggerTmp);
ep.setHistoryFile(errHistTmp);
ep.setPatternFile(errPatTmp);
const ph = require('./lib/provider-health');
ph.setHealthFile(phTmp);
ph.resetProviderHealth();
