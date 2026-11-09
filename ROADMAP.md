<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# multi-proxy 路线图（ROADMAP）

> 产品级路线图，对外透明。详细的待办真相源在内部 `PROJECT-STATE/OPEN-ITEMS`（不随公开树分发）。
> **能力默认态**：opt-in 门控默认关，开箱只做转发与观测；门控实时清单见 `GET /api/gates`（`multi-proxy-manager/lib/gates.js` 为唯一真源）。

## 已实现（代码事实，非设计图）
- 多编码代理调度层：Codex / Claude Code / Cursor / DSH / OpenCode / Generic / OpenCode-Free / WorkBuddy-Shim 统一出口
- 所有权冲突检测（`GET /api/conflicts`）：开代理前校验各 agent 的 `base_url` 未被占用
- 用量归一记账（按 agent / 模型 / 客户端归因），上游单价 unknown 时记「未知」不瞎估
- 只读接入适配器（5 个），绝不写回 agent 配置
- 本地模型一等公民（路由 `privacy=true` 架构性落本机）
- 进程管理 + Web 管理台 + Electron 桌面壳（端口动态探测，不靠写死）
- 能力门控状态条（`/api/gates`）：直说「你现在是关着的」，消除「未开启 = 没做」误读
- 就绪探针 `/readyz`：聚合各代理真实健康，替代「端口在听就当健康」的脆弱推断

## 进行中 / 规划中
- 编排引擎真实接管（当前默认影子·只记账不动路由）
- 故障隔离执行（`PROXY_HEALTH_ISOLATE`，默认关）
- 跨代理记忆 / 技能服务落地
- 成本定时调度与告警（`PROXY_COST_SCHEDULE` / `PROXY_HEALTH_ALERT`，默认关）

## 明确不做（No Plan）
为避免范围蔓延与预期错位，以下明确不做：
- **不自研通用 LLM 网关**：我们是本地代理调度层（管理层），不是又一个 LiteLLM / one-api。
- **不云同步 / 不做 SaaS 多租户**：本地优先，数据不出本机；不为多租户改造成中心化服务。
- **不绑死单一供应商**：`base_url` 可配任意 OpenAI / Anthropic 兼容端点。
- **不做开源版的企业级 SSO / 多租户分账**：这些能力走商业授权（见 `LICENSE-COMMERCIAL.md`）；AGPL-3.0 开源版不含。

## 诚实边界
- 不是「两分钟跑起来的轻量网关」——它是为多 agent 同机 + 数据不出本机做重的；纯省钱场景下单端口轻量网关更合适。
- 高可用路由（failover / 重试 / 熔断）不是开箱能力，仅 cursor-proxy(18794) 与 opt-in 故障隔离提供。
