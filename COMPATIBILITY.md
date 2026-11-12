<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# COMPATIBILITY.md · 它到底兼容什么协议

> 这一页只回答一件事：clone 下来，它认哪些协议、到哪个版本、哪些不认。
> 不写“我们支持一切”这种话，写的是**实测过的形态**，没实测的写“未验”。
> 最后更新：2026-11-11。

## 1. 主路径：OpenAI / Anthropic 兼容（这是 costgate 的核心，也是 99% 用户走的路）

costgate 是夹在“AI 编码工具”和“上游”之间的透明代理。它把下游工具发来的
**OpenAI 兼容**或 **Anthropic 兼容**请求，转发到你配的上游，并顺路记一笔账。
主路径**不涉及 MCP 协议版本问题**：它不解析 MCP 握手，只做 OpenAI/Anthropic 两种 wire 的转发 + 记账。

| 下游工具 | 走的 wire | 落到的端点 | 实测 |
|---|---|---|---|
| Codex CLI | OpenAI（`wire_api="responses"` 走 `/v1/responses`；`chat` 走 `/v1/chat/completions`） | `127.0.0.1:18790/v1` | ✅ 零 key 冷启跑通 |
| Claude Code | Anthropic | `127.0.0.1:18791/v1/messages` | ✅ 零 key 冷启跑通 |
| Cursor | OpenAI 兼容（`Override OpenAI Base URL`） | `127.0.0.1:18794/v1` | ✅ 跑通 |
| opencode / Cline / Aider / 任意 OpenAI 兼容工具 | OpenAI 兼容 | `127.0.0.1:18790/v1` 或统一入口 `127.0.0.1:18880/v1` | ✅ 跑通 |
| hermes | **不转发请求**：只改写 `~/.hermes/config.yaml` 的当前模型，`/v1/chat/completions` 返回 404 | — | ⚠️ 用量不进账本，明确不在“转发+记账”范围内 |

**协议版本口径**：OpenAI 侧认 `/v1/chat/completions` 与 `/v1/responses` 两种 body；
Anthropic 侧认 `/v1/messages`。这两组是 costgate 主路径实测过的全部。
没有声明“兼容某 OpenAI/Anthropic SDK 的某个小版本号”，因为代理是**透传**，
只要下游工具发的是标准 OpenAI/Anthropic 请求，上游接得住，costgate 就转得动。

## 2. 可选能力：MCP bridge（默认关，不是主路径）

costgate 里有一个 `l2/mcp-bridge`（`l2/mcp-server.js`），把 L2 的 AgentRegistry +
RouteEngine 能力暴露成标准 MCP 工具。**它默认关闭**（门控 `PROXY_L2_MCP` 未设为 1/true/on 时
`startStdio()` 直接抛 `mcp gate closed`），是 L2 编排层的一个能力暴露口，**不是 costgate 的第一句话**。

### 2.1 它当前支持的 MCP 版本：`2025-03-26`（handshake-era）

- `l2/mcp-server.js` 里 `PROTOCOL_VERSION = '2025-03-26'`，即仍走 `initialize` 握手的旧时代。
- 它是 **server**（暴露工具给 MCP client），不是 client。

### 2.2 关于 MCP `2026-07-28`（stateless core，移除 `initialize` 握手）

MCP 官方在 2026-07-28 把协议改成 stateless：移除 `initialize/initialized` 握手与
`Mcp-Session-Id`（SEP-2575 / SEP-2567），版本信息改走每请求的 `_meta`，新增 `server/discover`。
**官方明确“Nothing breaks on day one”**：一个 server 可以同时服务新旧两个 era，
对新 client 回答 `server/discover` + 每请求 `_meta`，对老 client 继续认 `initialize`。

**costgate 的诚实现状**（不粉饰）：

- `mcp-bridge` 目前**只实现 `2025-03-26`（handshake-era）**，尚未实现 dual-era（同时服务
  `2026-07-28` 的 `server/discover` + 每请求 `_meta`）。
- 因此：**用 `2026-07-28` stateless client 直连 costgate 的 mcp-bridge，可能握手失败**。
  用 `2025-03-26` 及更早的 client 不受影响。
- 而且它**默认关**：绝大多数用户根本不启用 mcp-bridge，这条边界与主路径无关。
- **dual-era 兼容未排进近期 roadmap**；本条是已知缺口，不是“没想过”。要做时按
  “answer `server/discover` + 每请求 `_meta`，同时保留 `initialize`”的官方双 era 策略实现，
  并补 `2026-07-28` 的注入回归。

> 判据：如果你要用 MCP client 连 costgate，先确认你的 client 是 `2025-03-26` 时代；
> 若是 `2026-07-28` stateless client，mcp-bridge 这一路**现在不保证通**。

## 3. 上游侧

costgate 把请求转发到**你配的上游**（README 里 `providers.json` 配）。零 key 冷启默认走
Kilo 匿名免费池（`kilo-auto/free`），本机有 Ollama 时优先本地。上游是什么协议，costgate 就
透传什么：它不限制上游协议，但**对上游不做版本 pin**（见 `SECURITY.md §3`）。

## 4. 未验 / 不在范围（如实列出，别按预期用）

- 流式（SSE）与工具调用（`tools`）**没有逐链路压过**，只验到“能通、有真 usage”。
- failover / 重试 / 熔断**只在 cursor-proxy 的路由模式**里，不是开箱能力。
- 多租户、SSO、企业分账**不在这个仓库**（见 `LICENSE-COMMERCIAL.md`）。
- 这些详见 `README.md` 的“现在还没做的”一节。
