<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# CHANGELOG

本项目尚未打正式版本 tag。当前 `main` 是可交付状态，本文件记录「现在能用什么、已知限制」，
而非逐 commit 的开发流水。打 `v0.1.0` 是发布动作，需维护者拍板。

## [Unreleased] · 当前 main（截至 2026-11-11）

### 可交付（已实测）
- 零 key 一条命令冷启：`git clone … && bash scripts/quickstart.sh`，看到第一笔真实账单。
- 6 条代理链路跑通（codex / claude / opencode / generic / dsh / cursor）：`bash scripts/verify-lanes.sh`。
- 账本纯文本落盘（`~/.multi-proxy-manager/cost-ledger.jsonl`），另有只读命令把账读给你听。
- Shield 出站脱敏默认开（`lib/redact.js` 6 条规则 + 入站工具检查，见 `SECURITY.md`）。
- 数据出境显式披露 + 纯本地 Ollama 替代路径（见 `SECURITY.md §2`）。
- 协议边界如实声明：主路径 OpenAI/Anthropic 兼容；MCP bridge 仅 `2025-03-26`、默认关
  （见 `COMPATIBILITY.md`）。
- CI 双门：`E2E Tier0 (PR Gate)`（真浏览器 7 壳页 + 门控条语义）+ `P0 Security Gate`。

### 当前 HEAD 实测记录（2026-11-12，HEAD `c38cc0e`）

让一个陌生人**三条命令内独立复现绿灯**（结果来自真跑，非文档摘录）：

| 命令 | 实测结果 |
|---|---|
| `bash scripts/quickstart.sh`（本机） | 第一笔真实账单：入 18 / 出 56 tokens，¥0，12962ms；冷启 34s（含首次 npm 下包） |
| `bash scripts/test-all.sh --fast` | 合计 **145 PASS / 0 FAIL**（l2 118 + dsh-proxy 27 + workbuddy-shim 退出码 + meta-guard mcp-gate 成对成立），退出码 0 |
| CI 双门（`main`） | `E2E Tier0 (PR Gate)` **success**（53s）+ `P0 Security Gate` **success** |

> CI 历史里能看到 `cancelled` / `failed`：那是 PR 迭代中的红→绿循环（含 GitHub runner 网络抖动触发的自动重试），
> 非当前 main 状态——当前 HEAD 双门全绿。`MANAGER_PASSWORD` 已由 `jest.setup.js` 回退本地占位，跑测试无需手动设密码。

### 已知限制（明确、可在代码里指认，非「没想过」）
- **hermes 不转发请求**：只改写 `~/.hermes/config.yaml`，用量不进账本，不在「转发+记账」范围。
- **无 failover / 重试 / 熔断**：只在 cursor-proxy 的路由模式里有两档，非开箱高可用。
- **Key 配额只有总量**：无日/周/月滚动窗口。
- **一实例绑一上游**：不做「一虚拟模型名映射多 Key 负载均衡」。
- **MCP bridge 仅 `2025-03-26`**：对 `2026-07-28` stateless client 不保证通，dual-era 未排近期 roadmap。
- **流式与工具调用未逐链路压过**：只验到「能通、有真 usage」。
- **Windows 原生 PowerShell 通道只有安装脚本**；Git Bash 下 `quickstart.sh` 可直接跑。
- **两个 Dockerfile 干净 clone 不能直接 build**（`COPY cursor-proxy/dist` 源在 `.dockerignore` 下）：
  容器部署形态未对外承诺。
- **单机单用户**：多租户 / SSO / 企业分账不在本仓库（见 `LICENSE-COMMERCIAL.md`）。
