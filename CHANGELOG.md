<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# CHANGELOG

本项目尚未打正式版本 tag。当前 `main` 是可交付状态，本文件记录“现在能用什么、已知限制”，
而非逐 commit 的开发流水。打首个 tag 是发布动作，需维护者拍板；版本号以 `multi-proxy-manager/package.json`
为真源（当前 `1.0.0`），tag 命名待维护者定。

## [Unreleased] · 当前 main（截至 2026-11-16）

### 可交付（已实测）
- 零 key 一条命令冷启：`git clone … && bash scripts/quickstart.sh`，看到第一笔真实账单。
- 6 条代理链路跑通（codex / claude / opencode / generic / dsh / cursor）：`bash scripts/verify-lanes.sh`。
- 账本纯文本落盘（`~/.multi-proxy-manager/cost-ledger.jsonl`），另有只读命令把账读给你听。
- Shield 出站脱敏默认开（`lib/redact.js` 6 条规则 + 入站工具检查，见 `SECURITY.md`）。
- 数据出境显式披露 + 纯本地 Ollama 替代路径（见 `SECURITY.md §2`）。
- 协议边界如实声明：主路径 OpenAI/Anthropic 兼容；MCP bridge 仅 `2025-03-26`、默认关
  （见 `COMPATIBILITY.md`）。
- 面板 `/context` 的“工具 schema 来源”Top-5（估算轨，纯前端累加 `toolsBySource`，不碰记账热路径）；
  算法有 E2E 回归钉死（`e2e/context-toolsrc.spec.js`）。
- CI 双门：`E2E Tier0 (PR Gate)`（真浏览器 8 壳页 + 门控条语义，共 9 页）+ `P0 Security Gate`。
- 面板本机回环免登录（2026-11-15 修复）：此前 E2E 的测试密码被误写进真实 HOME 的 `password` 文件，
  导致本机面板凭空多出一道登录门。现已删除该文件，并从三层封堵复发（回环 setup 返回 400 不落盘 /
  登录页回环无密码直入 / 两份 E2E 配置隔离数据目录）。要账号体系仍可设 `MANAGER_PASSWORD`。
- 面板前端壳分层收口（D-015～D-031）：`dashboard.html` 由 3121 行拆到约 2000 行，`views/` 分模块 +
  `mp-kernel`→`mp-auth`→`mp-shell` 分层；全局 fetch 凭证收口到 `mp-auth.js`；页内切换改用 `PAGE_LOADERS`
  路由表；切页内 tab 不再误摘侧栏高亮。均为内部重构，不改对外命令与端口。

### 实测记录（2026-11-12 · `main`）

> sha 会随后续提交前进，所以这里**不钉死某一个 sha**，判断这份记录是否仍适用看两条：热路径（代理转发/记账）
> 有没有改、CI 徽章是否仍绿。本次记录取自 `c38cc0e`，其后提交为文档与前端展示改动，行为未变。

让一个陌生人**三条命令内独立复现绿灯**（结果来自真跑，非文档摘录）：

| 命令 | 实测结果 |
|---|---|
| `bash scripts/quickstart.sh`（本机） | 第一笔真实账单：入 18 / 出 56 tokens，¥0，12962ms；冷启 34s（含首次 npm 下包） |
| `bash scripts/test-all.sh --fast` | 合计 **145 PASS / 0 FAIL**（l2 118 + dsh-proxy 27 + workbuddy-shim 退出码 + meta-guard mcp-gate 成对成立），退出码 0 |
| CI 双门（`main` @ `a6ae2c4`） | `E2E Tier0 (PR Gate)` **success**（53s）+ `P0 Security Gate` **success** |

**2026-11-15/16 增量真跑**（面板壳重构 + 密码事故修复后，命令与结果均来自实跑）：

| 命令 | 实测结果 |
|---|---|
| `node --test tests/node/*.test.js` | **88 PASS / 0 FAIL** |
| `bash scripts/check-panel-coherence.sh` | 七项全过 |
| `node scripts/drift-check.js` | 无漂移 |
| `npx jest --forceExit -w 4` | **123 套件 / 1838 用例全绿**（11-15 真跑，长时；其后仅文档改动） |
| `npx playwright test --grep @tier0` | **58/58**（11-15 真跑） |
| `gh run list`（`main` @ `1d447de`） | `P0 Security Gate` + `E2E Tier0` 双 **success** |

> CI 历史里能看到 `cancelled` / `failed`：那是 PR 迭代中的红→绿循环（含 GitHub runner 网络抖动触发的自动重试），
> 非当前 main 状态，当前 HEAD 双门全绿。`MANAGER_PASSWORD` 已由 `jest.setup.js` 回退本地占位，跑测试无需手动设密码。

### 已知限制（明确、可在代码里指认，非“没想过”）
- **hermes 不转发请求**：只改写 `~/.hermes/config.yaml`，用量不进账本，不在“转发+记账”范围。
- **无 failover / 重试 / 熔断**：只在 cursor-proxy 的路由模式里有两档，非开箱高可用。
- **Key 配额只有总量**：无日/周/月滚动窗口。
- **一实例绑一上游**：不做“一虚拟模型名映射多 Key 负载均衡”。
- **MCP bridge 仅 `2025-03-26`**：对 `2026-07-28` stateless client 不保证通，dual-era 未排近期 roadmap。
- **流式与工具调用未逐链路压过**：只验到“能通、有真 usage”。
- **Windows 原生 PowerShell 通道只有安装脚本**；Git Bash 下 `quickstart.sh` 可直接跑。
- **两个 Dockerfile 干净 clone 不能直接 build**（`COPY cursor-proxy/dist` 源在 `.dockerignore` 下）：
  容器部署形态未对外承诺。修法已定（复用 `Dockerfile.cursor` 多阶段样板），待有 docker 的机器验证。
- **`manage.sh stop` 对 manager 可能是假停**：`server.js` 的 `SIGTERM` handler 只停文件观测、不退出进程，
  Node 注册 handler 后不再自动结束 ⇒ `kill -TERM` 被吞（2026-11-15 重启时实测）。当前靠桌面 App 的 watchdog
  拉起；根治需在 handler 里补 `process.exit()`，该文件属并行会话资产，未改。
- **判据 I / IV 的"外部真人复跑"尚未完成**：I 的真机冷启本沙箱跑不出完整端到端（npm 冷缓存 confound），
  IV 首次 11-10 达成但用的是旧地址 + 修复前代码，改名后复验材料见 `PROJECT-STATE/2026-11-11.md` §7.1。
  这两条的执行者必须是外部真人，agent 不能代跑。
- **单机单用户**：多租户 / SSO / 企业分账不在本仓库（见 `LICENSE-COMMERCIAL.md`）。
