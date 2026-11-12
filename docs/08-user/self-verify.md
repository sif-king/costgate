<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 不信面板？自己验

> 本页原为 `README.md` 的一节，2026-11-12 拆出：README 太长，主路径只留最短验证，细节放这里。

面板是我们自己画的。所以有一条**只读**命令，直接读你机器上的文件和本地接口，全程不经过界面：

```bash
bash scripts/verify.sh
```

下面是 2026-11-08 真跑的**节选**（当时 codex-proxy 是停着的，注意账本照样读得出来）。为了不刷屏，省了【1】环境、【5】脱敏记录，以及中间几个按需代理；省略处用 `…` 标出，其余逐字照抄：

```
【2】服务
  ✓ manager      18792  在跑
  ! codex-proxy  18790  未在跑 —— 不会有新的账落下来
  - hermes-proxy     18793  未在跑（按需安装，不算故障）
  - cursor-proxy     18794  未在跑（按需安装，不算故障）
  …（dsh / claude / opencode / generic 同形，一个不落全列出来）
  ✓ unified-ingress  18880  在跑

【3】账本 —— 最硬的证据
  ✓ 已入账 1054 笔，最近一笔 2026-11-03 04:52
    ~/.multi-proxy-manager/cost-ledger.jsonl
    想自己核对：tail -3 ~/.multi-proxy-manager/cost-ledger.jsonl

【4】门控（能力开关 + 真跑过没有）
  16 项：开 3 · 关 12 · 读不到 1（开箱默认态：opt-in 能力全关，是设计不是缺漏）

  ✓ 成本记账               1054 笔    已入账 1054 笔，最近 11-03 04:52
  · 出网沙箱巡检           0 次       尚无记录 · 门控关闭时不记录；开着也只在命中时才写
  · 出网脱敏               0 次       尚无命中 · 接线正常但从未遇到敏感串，或还没有请求出网（0 次≠没生效）

  「0 次」= 采到了但还没有数据（刚启用/没人用），不等于没生效。
  「无采集点」= 这一项没有落盘痕迹可查，也不代表没生效。

结论：没有硬问题。
```

三条口径值得单说，每条都有测试钉住：

- **开着 ≠ 跑过**。门控那栏除了“开没开”，还报**每项真跑过几次**。一个装上了却一次没被走过的能力显示 `0 次`，看得见，不会被绿色“已开启”盖住。
- **服务全停也能跑**。账本和命中记录都在磁盘上，manager 挂了只影响“门控当前值”一段。
- **“读不到”不会报成“0 笔”**。IO 失败时明说读不到并 exit 1；“没装”的代理只打 `-`，不算故障。把故障说成正常，是这类工具最常见的谎。

## 环境跑不动？先看它

`verify.sh` 回答的是“项目工作得怎么样”；`doctor.sh` 回答的是**另一个问题**：“我的环境为什么让它跑不起来”。两个问题不一样，所以是两条命令，不是一条。

```bash
bash scripts/doctor.sh
```

它同样只读、不发会花钱的请求。区别是每条都带**原因和修法**，不只是报个红。真跑输出（2026-11-09，本机）：

```
【1】外部命令能跑吗 —— 「装了」和「能用」是两件事
  ✓ codex 可用（codex-cli 0.153.4）
    /Applications/ChatGPT.app/Contents/Resources/codex
  ✓ node 可用（v22.22.2）

【2】桌面 app 完整性 —— 改过别人的 app 就会这样
  ✓ ChatGPT.app 签名自洽
    显示名 ChatGPT，内部标识 com.openai.codex —— 这是同一个 app 的两张脸，不是两个产品

【3】Codex CLI 的配置指向
  ✓ base_url 指向本机 18790（正确）

【4】服务端口
  ✓ codex        18790 在跑
  ✓ manager      18792 在跑
  ✓ codex-proxy /v1/models 真能应答（200）
```

为什么值得单独做一条：`codex --version` 曾经返回 **137**，零输出。那不是“没装好”，是进程被内核直接杀掉了（签名证书被吊销 / 内存不够 / 沙箱拒绝），而与此同时 `config.toml` 里的 `base_url` 写得完全正确。**只检查配置文件的检查，发现不了这件事**：它证明的是“我写对了”，不是“它能用”。

## 再进一步：让每个代理真跑一条请求

`verify.sh` 全程不出网。如果你想验的是“这些代理真的能把请求转出去、真能拿到上游的用量”，跑这个：

```bash
bash scripts/verify-lanes.sh            # 6 个代理逐个来
bash scripts/verify-lanes.sh codex dsh  # 只验指定的
```

它会为每个代理起一次真进程、发一条真请求、把上游回来的 `usage` 打出来。2026-11-08 在本机的实测（全量，未删行）：

```
── codex（端口 18960）
  ✓ 健康检查通过
  wire: openai → http://127.0.0.1:18960/v1/chat/completions
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 24 · 合计 74 tokens
── claude（端口 18929）
  ✓ 健康检查通过
  wire: anthropic → http://127.0.0.1:18929/v1/messages
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 26 · 合计 76 tokens
── opencode（端口 18980）
  ✓ 健康检查通过
  wire: openai → http://127.0.0.1:18980/v1/chat/completions
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 32 · 合计 82 tokens
── generic（端口 18937）
  ✓ 健康检查通过
  wire: openai → http://127.0.0.1:18937/v1/chat/completions
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 26 · 合计 76 tokens
── dsh（端口 18906）
  ✓ 健康检查通过
  wire: openai → http://127.0.0.1:18906/v1/chat/completions
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 24 · 合计 74 tokens
── cursor（端口 18935）
  ✓ 健康检查通过
  ✓ 上游已写入临时库（SQLite，未碰你的 data/proxy.db）
  wire: openai → http://127.0.0.1:18935/v1/chat/completions
  ✓ 上游回复：「pong」
  ✓ 真实用量：输入 50 · 输出 28 · 合计 78 tokens
──────────── 小结 ────────────
通过 6 · 失败 0 · 跳过 0
```

> 输出里的端口每次不一样（从 18900 高位段随机挑空闲的）；token 数也会变，那是上游真算的，不是你看到的固定值。

四条口径：

- **它不碰你的配置**。每个代理用独立的临时目录，`providers.json` 写在里面，跑完删掉；端口取 18900 高位段，不占你的默认端口。cursor 的上游存在 SQLite 里（加密的），没法用一份 JSON 配出来，所以它走另一条路：把编译好的 `dist` 复制到临时目录再启动，数据库跟着落进临时目录，密钥用一次性的 `ENCRYPTION_KEY` 环境变量，你项目根目录下那把真的 `.encryption-key` 和 `data/proxy.db` 全程没被读写。
- **它要联网**（这正是它和 `verify.sh` 分开的原因），会消耗零点几次免费额度。
- **没装的代理算“跳过”不算“失败”**，退出码 0 仍算通过；一条都没验成才是 exit 2。
- **cursor 要先构建**（`bash install.sh --cursor`）。没有 `dist` 就跳过并告诉你去装，不会报成失败。
