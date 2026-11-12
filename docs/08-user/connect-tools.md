<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 接上你的工具

> 本页原为 `README.md` 的一节，2026-11-12 拆出——各工具接线片段很长，留在 README 会淹没主路径。

上游加好之后（quickstart 会替你做，或见下面「加一个上游」），改工具里的地址就行。**下面这些 `export` 只影响当前 shell，不写全局环境。**

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18880
export ANTHROPIC_MODEL=<你的上游实际模型名>
```

统一入口没起时，可改指 `http://127.0.0.1:18791` 直连 claude-proxy（要先装：`bash install.sh --claude`）。`ANTHROPIC_MODEL` 必须填上游真实名字，填错就是 404。

<details>
<summary><b>Claude Code 也能零 key 跑通（2026-11-08 实测，附原始返回）</b></summary>

Kilo 的网关除了 OpenAI 协议还吃 Anthropic 的 `/v1/messages`，而 claude-proxy 遇到非 deepseek/moonshot 的上游会兜底拼 `{base_url}/messages`。两件事凑一起：**Claude Code 不需要任何 API key 就能冷启**。

一条命令：

```bash
MP_QS_CLIENT=claude bash scripts/quickstart.sh   # 起 claude-proxy + manager，发一条 /v1/messages
```

它会把 Kilo 这条上游写进 `~/.multi-proxy-manager/providers.json`（顶层数组）：

```json
[
  { "name": "kilo-free", "provider_id": "kilo-free", "api_key": "",
    "base_url": "https://api.kilo.ai/api/gateway/v1",
    "enabled": true, "models": ["kilo-auto/free"] }
]
```

然后把 Claude Code 指过来即可：`ANTHROPIC_BASE_URL=http://127.0.0.1:18791`、`ANTHROPIC_MODEL=kilo-auto/free`。

实测那条 `POST /v1/messages`（无任何 key 头）拿到的是：

```json
{"type":"message","role":"assistant",
 "content":[{"type":"thinking","thinking":"The user wants me to reply with exactly \"pong\". Simple."},
            {"type":"text","text":"pong"}],
 "model":"reflection/beam-free","stop_reason":"end_turn",
 "usage":{"input_tokens":50,"output_tokens":24,"cost":0}}
```

`usage` 是上游给的，会照常落进同一本账。**这条链路只验到「能通、能记账」**：Claude Code 客户端本身的流式与工具调用没在这条链上压过（见下面「现在还没做的」第 1 条）。

</details>

**Codex CLI**

它**不认环境变量**，读的是 `~/.codex/config.toml`。加一段 provider，再把顶层 `model_provider` 指过去：

```toml
model_provider = "multi-proxy"

[model_providers.multi-proxy]
name = "multi-proxy"
base_url = "http://127.0.0.1:18790/v1"
wire_api = "responses"
```

`wire_api = "responses"` 要照写：Codex CLI 默认走 `/v1/responses`，这里写成 `chat` 会让两边的协议对不上。key 那几行（`env_key` / `experimental_bearer_token`）按你的 codex 版本该写什么写什么，值填任意非空字符串即可——代理只在设了 `PROXY_AUTH_TOKEN` 时才校验 `x-proxy-auth`，不看你填的 key。

**想让它能改代码，还得再加两行。** Codex CLI 的沙箱默认是**只读**——接上代理、能对话，但让它「创建 hello.txt」会被自己的沙箱拒掉，表现是模型回一句「环境层面的失败，文件没建成」。看着像代理的问题，其实是安全默认值：

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

两块必须成对出现。`workspace-write` 会把**网络一起掐掉**，那时连不上本机代理，症状变成「模型一直不回话」——比只读更难查，因为它不报错。`bash scripts/doctor.sh` 会检查这两项，缺了哪一块都会指出来。

**OpenAI SDK / 任何 OpenAI 兼容工具**

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18790/v1
```

**Cursor**

`Settings → Models → Override OpenAI Base URL` 填 `http://127.0.0.1:18794`，API Key 随便填个非空值，模型名选 18794 `/v1/models` 返回的真名（Cursor 默认的 `gpt-5` / `claude-sonnet-4` 会 404）。

注意 cursor 这一支和别的不一样：它的上游**按类型分槽**（`openai` / `deepseek` / `anthropic` / `gemini` / `ollama` / `generic` 各一个位置），同一类型只能挂一个上游。想换就先删旧的——删的时候如果它下面还挂着模型，会返回 409 让你先删模型（早期这里只回一句 `Internal server error`，查不出原因）。

**其余工具**

| 你要接的 | 指向 |
|---|---|
| opencode | `http://127.0.0.1:18798/v1` |
| Cline / Aider / OpenHands | `http://127.0.0.1:18799/v1` |
| DSH（DeepSeek Harness） | `http://127.0.0.1:18797/v1` |
| 其它任意 OpenAI 兼容客户端 | `http://127.0.0.1:18880/v1`（统一入口，按路径分发） |

**Hermes 和上面这些不是一类，别把它的端口填进 base_url**

`http://127.0.0.1:18793` 有 `/v1/models`（会返回 200，所以看着像接上了），但 `POST /v1/chat/completions` 是 **404**。它不转发请求，做的是**改写 `~/.hermes/config.yaml` 里的当前模型**（`POST /api/switch-model`），真正的模型请求由 Hermes 自己按那份 config 直连上游。

两个直接后果：想切模型点面板，或者 `curl -X POST 127.0.0.1:18793/api/switch-model -H 'content-type: application/json' -d '{"model":"<模型名>"}'`；**Hermes 的用量不进账本**——没有流量经过它，也就没有账可记。

**加一个上游**（面板里做，比手改文件稳）

打开 `http://127.0.0.1:18792` → 代理配置页 → 供应商 → 新增：

> 本机访问默认**不弹设密码**（回环免鉴权，`/api/auth/status` 里 `loopbackBypass: true`），打开就是总览页，也没有首启协议页——那层门目前在代码里是关着的。只有从别的机器访问才需要设管理密码。
选类型（OpenAI 兼容 / Anthropic / Ollama…）→ 填 `base_url` 和 key（本地 Ollama 不用 key）→ 保存。

配置落在 `~/.multi-proxy-manager/providers.json`。**顶层是数组，不是对象**——写成 `{"providers": [...]}` 会被静默忽略（各代理只认数组；这里踩过，所以写清楚）：

```json
[
  { "name": "my-upstream", "provider_id": "my-upstream",
    "api_key": "sk-...", "base_url": "https://api.example.com/v1",
    "enabled": true, "models": ["model-a"] }
]
```

改完**不用重启**：各代理每次请求都会重读这个文件（`findProvider()` 里现读，不是启动时固化）。

**接完之后：确认它真的记上了**

接上最容易出问题的地方不是配置写错，而是**你以为接上了、请求其实没经过代理**——屏幕上一点异常都没有，账本空着，然后你以为「这工具的账本没数据」。

```bash
bash scripts/quickstart.sh --watch
```

它会盯着账本等你那一笔：等到就打出来是谁的、哪个模型、多少 tokens、花了多少钱；等到 180 秒还没有，就按最常见的三个原因逐条报（工具没走代理 / 端口对不上 / 到了但没报账），并且**先现场探测这两个端口到底有没有在跑**，而不是拿配置里的端口糊弄你。

> 那条「配置里写了 18790」不等于「18790 上有进程」——所以 --watch 报的是实测结果。探测走 TCP 不走 curl：本机开着系统代理时，curl 会被劫持成 `502 upstream connect failed`，看着像服务死了。

**一行验证**

```bash
curl --noproxy '*' http://127.0.0.1:18880/v1/models
bash manage.sh status
```

> `--noproxy '*'` 不是可有可无：如果你本机开着代理，curl 会走代理去连 127.0.0.1 然后失败，看起来像服务挂了。
