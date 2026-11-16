<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# CHANGELOG

首个版本 `v1.0.0`，2026-11-16。版本号以 `multi-proxy-manager/package.json` 为真源；
各子包 `package.json` 里的 version 是模块自身版本，与产品版本独立。本文件记录“现在能用什么、已知限制”，
而非逐 commit 的开发流水。

## [未发布]

### 修复（Docker 路径 + 进程退出，2026-11-17 真机实测）

- **`docker compose up -d` 现在四个容器真能起来并响应**。此前有三种“构建全绿、容器起来就废”的形态：
  - `Dockerfile.manager` 漏 `COPY l2/ packs/`，且 manager 目录落成 `/app/manager`（应为 `/app/multi-proxy-manager`），
    容器起来立刻 `MODULE_NOT_FOUND`；
  - `Dockerfile.codex` 漏 `l2/`（`require('../l2/circuit-breaker.js')`），补完 `l2/` 又炸在
    `require('../tools/token-policy-bridge.js')` → 连带 `packs/curator/policies/*`；
  - `cursor-proxy` 镜像里没绑 `0.0.0.0`，容器 `Up` 但宿主端口连不上（codex 同理，它的变量叫 `PROXY_BIND_HOST`）。
- **`kill -TERM` 不再假停**：`server.js` 的 SIGTERM handler 只停文件观测、不 `process.exit()`，
  Node 注册信号监听器后就不再自动退出 ⇒ 进程留在原地、端口继续占着，`launchd` / `docker stop`
  最后只能升级成 SIGKILL。现在统一在入口注册并 `exit(0)`，观测关掉时同样能干净退出。
- `docker-compose.yml`：四个 `env_file` 改 `required: false`（干净 clone 里没有那几个 `.env` 也能起）；
  三个代理的宿主侧端口缺省只绑 `127.0.0.1`（`PROXY_BIND=0.0.0.0` 才对外）。

### 新增守卫
- `scripts/check-docker-runtime-closure.js`（+ `tests/shell/docker-runtime-closure.test.bats`，已进 CI）：
  从每个 Dockerfile 的 CMD 入口求 require 闭包，按 COPY 规则把文件映射成镜像路径，**逐条边**比对。
  漏 COPY 会报“没有被任何 COPY 覆盖”，目录名错位会报“按相对路径它要找 X，实际在 Y”。
  与 `check-docker-context.js` 互补：那条守“源在不在”，这条守“落点对不对”。

## [1.0.0] · 2026-11-16

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
| `bash scripts/quickstart.sh`（`git archive` 干净导出 + 零配置 HOME，无 `node_modules`） | 第一笔真实账单：入 18 / 出 68 = **86 tokens**，¥0，6569ms；全程 **26s**（依赖 9s / 探测上游+起服务+请求 17s），退出码 **0** |

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
- **两个托管镜像（`Dockerfile.manager` / `Dockerfile.lite-mvp`）仍未经运行时构建验证**：
  原先 `COPY cursor-proxy/dist` 在干净 clone 上会失败（`dist` 不入库、又被 `.dockerignore` 排除）。
  2026-11-16 已改成多阶段构建：cursor 由 builder 跑 `tsc` 自产 `dist` 并装依赖、codex 由 builder 装依赖，
  最终 stage 用 `COPY --from` 搬入，`scripts/check-docker-context.js` 从 2 条已知债变为全绿。
  但这两个镜像的 `docker build` **仍未在真机上跑过**（开发机无 docker daemon），
  所以容器部署形态继续不对外承诺；有机器时一条命令可验：`docker build -f Dockerfile.lite-mvp .`。
  剩余缺口：`hermes-proxy` 是 Python（Flask），托管镜像里没有 Python 运行时，
  单容器形态下它会注册成功但起不来，修法需 python builder + `site-packages` 路径对齐。
- **`manage.sh stop` 对 manager 是假停（已复现）**：`server.js` 的 `SIGTERM` handler 只停文件观测、不退出进程，
  Node 注册 handler 后不再自动结束 ⇒ `kill -TERM` 被吞（2026-11-15 重启时实测）。2026-11-16 用隔离实例真跑复现：发 SIGTERM 后进程仍存活、端口仍被占。当前靠桌面 App 的 watchdog
  拉起；修法已明确（handler 末尾补 `process.exit(0)`；`_fsObserver.stop()` 走的是同步 `appendFileSync` + `close`，不会丢观测记录），但 `server.js` 工作区里有并行会话的未提交改动，同文件提交会把对方改动一并带入，故本轮未改。
- **跨平台与外部复验的口径**：判据 I 的冷启链路已在 macOS 本机真跑（干净导出 + 零配置 HOME，
  见上方实测记录），Windows 原生环境仍未验；那次 npm 依赖有缓存（9s），不能当冷装基准。
  判据 IV 首次 11-10 由第三方在 Windows 达成，用的是改名前的地址与 `621c6e5` 之前的代码，
  改名后的复验材料备在 `PROJECT-STATE/2026-11-11.md` §7.1，尚未由外部真人重跑。
  对外口径只到“macOS 干净环境已验证”，不说成“第三方已复验”。
- **单机单用户**：多租户 / SSO / 企业分账不在本仓库（见 `LICENSE-COMMERCIAL.md`）。
