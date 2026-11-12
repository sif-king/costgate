<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 实现细节（给想深入的）

> 本页原为 `README.md` 的一节，2026-11-12 拆出：内部机制对首次阅读是噪音，对想深挖的人是信号。

<details>
<summary><b>一次请求怎么走完（给的是符号名，不是行号）</b></summary>

路径都是仓库相对路径。**故意不写行号**：行号每改一次代码就会漂，写死的行号三个月后就是假的，而假的坐标比没有坐标更糟。下面的函数名/字段名搜一下就能定位。

| # | 跳 | 位置 |
|---|---|---|
| 1 | 入站 | `codex-proxy/proxy.js` 的 `PORT`（默认 18790）、`app.listen(PORT, BINDING)` 默认只 bind `127.0.0.1` |
| 2 | 认证 | 同文件 `requireAuth`，校 `x-proxy-auth`；未设 `PROXY_AUTH_TOKEN` 时 fail-open 并 WARN |
| 3 | 选 provider | 同文件 `findProvider(modelName)`：精确 → 子串 → 内置 env 上游，三级匹配。**只选一个，不重试** |
| 4 | 转发 | OpenAI wire 直通；Anthropic wire 走 `anthropicMessagesUrl(provider)` 三级挂载判定（显式 `anthropicBaseUrl` → deepseek/moonshot 的 `/anthropic/v1/messages` → 兜底 `base/messages`） |
| 5 | 攒字节防丢账 | 同文件 `pipeUpstreamBytes()` tee 一份副本，为的是流末 usage 不被丢掉 |
| 6 | 报用量 | 同文件 `reportUsage()` 旁路 POST 到 manager `/api/cost/report` |
| 7 | 归一 wire | `multi-proxy-manager/lib/usage-probe.js` 的 `detectWire()` 从 usage 字段形态认（`input_tokens`=Anthropic、`prompt_tokens`=OpenAI、`usage_metadata`=Gemini，都认不出记 `custom` 而不是丢） |
| 8 | 落账 | `multi-proxy-manager/lib/cost-track.js` 计价（cacheHit 单独计价、thinking 只计数不计费），再 `appendFileSync` 追加一行 jsonl |

“接入方不用写 parser”的意思是：报用量时只贴上游原样 `raw`，`wire` 由 manager 侧认。三家字段各不相同、Anthropic 流式还在末事件包一层，硬写三份解析器会在跨版本升级时反复返工，这是三笔故意做重的工程账之一。

另两笔：`multi-proxy-manager/lib/agent-owner.js` 读 `base_url` 实际指向而非端口（端口在听 ≠ 正在代理这个 agent）；本地在路由表里是一档 `privacy` 条件，不是一个开关。

</details>

<details>
<summary><b>门控体系与默认态</b></summary>

唯一真源是 `multi-proxy-manager/lib/gates.js`，`GET /api/gates` 消费它，面板门控条展示它。判定范式四种，别合并：`opt-in`（1/true/on 才开）、`opt-out`（0/false/off 才关）、`opt-out-off-only`（只认 `off`）、`strict-1`（只认 `1`）。

装完不配任何环境变量时是**开箱默认态**：opt-in 能力全关。这不是功能没做，是刻意的非侵入默认：面板顶部状态条会直说"你在默认态，以下 N 项需显式开启"，并给出能真正翻转状态的命令（不是无脑 `=1`）。

运行证据层（`multi-proxy-manager/lib/gate-evidence.js`）只读、无副作用，回答的是"真跑过没有"：成本记账读账本笔数、出网脱敏读命中记录、沙箱巡检按 kind 分组。没有采集点的项老实写“无采集点”，不拿 0 冒充。

</details>

<details>
<summary><b>测试与验收</b></summary>

```bash
cd multi-proxy-manager && MANAGER_PASSWORD=x npx jest -w 2 --silent --forceExit
cd codex-proxy && npx jest --silent --forceExit
cd hermes-proxy && python3 -m pytest tests/ -q
bats tests/shell/*.bats                                    # shell 行为测试
cd multi-proxy-manager && npx playwright test              # e2e（需系统 Chrome）
```

`MANAGER_PASSWORD` 现在不用手动设：`jest.setup.js` 会补一个本地占位值，避免那批“无 token → 401”的用例因回环免鉴权整批误挂（2026-11-06 起）。想显式给也行，CI 就是这么对齐的。

最近一次全量真跑：2026-11-08，manager **114 suites / 1710 tests**，其中 1 条 `health-graph` 因并发抖动挂了、单跑 12/12 全绿（这类环境抖动我们不藏，也不拿它当通过）。2026-11-08 同一批还补了守卫（门控表、运行证据、门控条、README、shell），每一条都用**注入回归**验证过"改坏了真会变红"，没验证过会变红的守卫等于没写。测试数字会变，命令不会：想核当前值就自己跑一遍。

</details>

<details>
<summary><b>目录结构</b></summary>

```
multi-proxy/
├── codex-proxy/            # 核心网关 18790（OpenAI 兼容 + Responses）
├── claude-proxy/           # Claude Code 18791（Anthropic /v1/messages）
├── multi-proxy-manager/    # 面板 + 账本 + 门控 18792
├── hermes-proxy/           # Hermes 18793（Python/Flask；换模型，不转发流量）
├── cursor-proxy/           # Cursor 18794（TypeScript + SQLite）
├── dsh-proxy/              # DeepSeek Harness 18797
├── opencode-proxy/         # opencode 18798
├── generic-openai-proxy/   # Cline/Aider/OpenHands 18799
├── unified-ingress/        # 统一入口 18880（按路径分发）
├── l2/                     # 编排内核（影子模式，未完成）
├── packs/                  # token 策略等可选包
├── tools/agent-proxy-switch# 跨所有者安全切换器
├── scripts/                # quickstart.sh / verify.sh
├── client/                 # 原生 macOS 桌面壳（Swift）
├── tests/shell/            # bats 行为测试
└── manage.sh               # 进程管理
```

`docs/quickstart.md` 是完整安装流程，`docs/00-codebase-map.md` 是代码地图。

> **关于文档里指向不存在的路径**：本仓 docs/ 下的一部分技术文档（尤其 `04-tech`、`07-ops`、`design`）会引用**未随仓发布的内部资产**：项目状态台账、设计评审、立项与商业化文档等。完整清单见 [`docs/00-未随仓发布文档清单.md`](docs/00-未随仓发布文档清单.md)（哪些随仓发布、哪些是内部件、哪些是代码片段误报，分三桶写清楚；要自查可跑 `git ls-files docs/`）。所以你在这些文档里点到不存在的路径时，属于“引用了内部件”，不是链接写错；能复现、能跑起来的证据都在本仓里，那部分是完整的。

</details>

<details>
<summary><b>安全</b></summary>

JWT + bcrypt 认证（管理密码可选设；本机回环默认免鉴权）、登录失败 5 次锁 15 分钟；spawn 路径白名单防命令注入；API 转发端点白名单；CSP / CORS；生产环境错误脱敏；cursor-proxy 的 API Key 走 AES-256-GCM。

内容注入 / 目标劫持守卫（`MULTI_PROXY_CONTENT_GUARD`，默认关）：记忆写入与动作执行前扫描嵌入指令与目标重定向，命中即拦截不落盘。

出网管控（tenant 级 egress 策略）不在这个仓库，属企业版范围。
</details>
