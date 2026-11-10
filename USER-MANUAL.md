<!--
costgate（原 multi-proxy）— 用户手册
面向第一次接触本项目的读者：从「它为什么存在」到「遇到问题找谁」。
事实以 README.md 为真源；本文不重复技术细节，只把同一件事讲到人能听懂。
-->

# costgate · 用户手册

> **把你本机那些 AI 编码工具的模型请求收到一处，记一本你自己能查的花销账。**
>
> 装好只用一条命令，不用任何 API key。账本是磁盘上一个纯文本文件，另有一条只读命令把它读给你听——包括每项能力**真跑过几次**。

（项目原名 `multi-proxy`，**已于 2026-11-11 更名为 `costgate`**——名字变了，因为它干的不只是「代理」，更在管出口、记一笔你能核查的账。GitHub 仓库现为 `sif-king/costgate`。下文品牌名用 costgate；**代码内部模块名、端口、数据目录暂时仍叫 multi-proxy**（尚未随改），等你看到它们别被绕晕：同一套东西，换个名。）

---

## 一、这是给谁的

如果你正在**同时用 Claude Code、Codex CLI、Cursor、opencode、Cline、Aider 里的两个以上**，并且有过下面任一种时刻，这就是给你用的：

- 月底想问「这个月 AI 一共花了多少、哪个工具花的最多」，却答不上来；
- 五个工具各配一个 `base_url`，端口记不住，改了 A 忘了 B；
- cc-switch、Cursor 自带的代理、你自己的代理同时想认领同一个 agent，流量到底去了哪说不清；
- 有些请求绝对不能出这台机器，但你不敢确定它真的没出去。

它不是一个要替代你现有工具的「更聪明的代理」。它是**收口 + 记账**的那一层：让所有工具的模型请求都从这一个口子出去，并留下你随时能翻的账。

---

## 二、它替你解决四件事

| 你遇到的事 | 它怎么办 | 你自己怎么确认 |
|---|---|---|
| 五六个工具各配一个 `base_url`，端口记不住 | **一个地址接所有**：`http://127.0.0.1:18880` 按路径自动分发到对应代理 | `curl --noproxy '*' http://127.0.0.1:18880/v1/models` |
| 月底问「AI 花了多少、哪个工具花的」答不上来 | **一本账**：按代理 / 模型 / 客户端（Cline、Aider、OpenHands 分得开）三个方向记账 | `tail -3 ~/.multi-proxy-manager/cost-ledger.jsonl` |
| cc-switch、Cursor 自带代理、你的代理同时认领一个 agent，去向说不清 | **同一条 `base_url` 同一时刻只允许一个所有者**，被占用就拒开，不抢不覆写 | `bash tools/agent-proxy-switch` |
| 有些请求不能出这台机器 | **本地是一档路由条件**：打上隐私标记的请求只落 `127.0.0.1`，不上云 | `MP_QS_UPSTREAM=ollama bash scripts/quickstart.sh` |

上游没给单价时，这笔账 `cost` 记 0、`pricingSource` 记 `unknown`——「真免费」和「没价」在账上分得开，不会回落一个瞎估的、看着漂亮的数字。

---

## 三、三十秒跑起来（第一次可能慢一点，正常）

**一条命令，看到第一笔真实账单。** 本机实测 7 秒到 97 秒，差别全在 npm 要不要现下依赖——脚本末尾会报这次的真实秒数，别把秒数当承诺。

```bash
git clone https://github.com/sif-king/costgate && cd costgate
bash scripts/quickstart.sh
```

它做五件事，每一步屏幕上都可核对：

1. **装依赖**（只在首次，约 20–30s，之后每次都是十几秒）；
2. **找一个免 key 的上游**（Kilo 匿名免费池 → 本机 Ollama，零 key 也能跑通）；
3. **起两个进程**（codex-proxy 转发 + manager 记账）；
4. **发一条真实请求**（脚本只发一句 `pong`，不含你的任何内容）；
5. **打印账本里刚落地的那一行**——这是上面那笔账单。

你会看到这样一段（2026-11-08 本机真跑，除了末尾提示外一字未改）：

```
[5/5] 发一条真请求，核对账本
  ✓ 上游回复：「pong」
  ✓ 本次真实用量：输入 50 · 输出 26 · 合计 76 tokens

  ┌─ 第一笔真实账单 ────────────────────────────────
  │ 时间    03:42:07
  │ 代理    codex-proxy     模型  kilo-auto/free
  │ 用量    输入 50     输出 26     缓存命中 0
  │ 计费    ¥0（免费额度，数字来自上游真实 usage）
  │ 耗时    2077ms
  └──────────────────────────────

冷启完成，用时 26s
```

几点让你安心的话：

- **第一次慢，是因为在从 npm 下那 30 多个包**。程序本身做的事始终是那十几秒；剩下全是你这台机器第一次取依赖。这段只在首次发生，之后重跑就是十几秒那一档。
- **慢在哪，脚本会分段报给你**：「依赖安装」那段是**你自己的网络**，「探测上游 + 起服务 + 请求」那段才是**程序全部耗时**。陌生人看到「95 秒」能立刻判断慢在自己还是慢在程序——这两件事的修法完全不同。
- **万一 `npm install` 本身失败**，脚本会把 npm 的**原话**打到屏幕上，见那行先查自己的网络/代理，别当成安装器坏了。

> **用 Claude Code？** 同一套流程换一个客户端，起的是 claude-proxy（Anthropic 协议）：`MP_QS_CLIENT=claude bash scripts/quickstart.sh`。
>
> **想数据完全不出本机？** 先装 [Ollama](https://ollama.com)，脚本自动优先用它，并挑**体积最小**的模型（机器上有 27B 和 4B 时不会挑 27B）。`MP_QS_UPSTREAM=ollama` 可强制走本地。
>
> **停掉这次？** `bash scripts/quickstart.sh --stop`。

那条命令背后真正发生的事：**你的请求 → codex-proxy 转发到上游 → 上游返回 `usage` → 上报 manager → 追加写进 `~/.multi-proxy-manager/cost-ledger.jsonl`**。token 数来自上游返回的 `usage` 字段，不是估算、不是模拟；请求成功但账本没多一行，脚本会**以退出码 2 报错**——「没记上」不会被说成「成功」。

---

## 四、把工具接上它

装好之后，服务在跑不等于工具已经改道。按你用的工具选一种接法。下面这些 `export` **只影响当前 shell，不写全局环境**，关掉终端就失效。

**OpenAI SDK / Aider / Cline 这类认环境变量的**

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18790/v1
```

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18880
export ANTHROPIC_MODEL=<你上游的真实模型名>
```

`ANTHROPIC_MODEL` 必须填上游真实名字，填错就是 404。统一入口没起时可改指 `http://127.0.0.1:18791` 直连 claude-proxy（要先装：`bash install.sh --claude`）。

**Codex CLI（它不认环境变量，读的是 `~/.codex/config.toml`）**

```toml
model_provider = "multi-proxy"

[model_providers.multi-proxy]
name = "multi-proxy"
base_url = "http://127.0.0.1:18790/v1"
wire_api = "responses"
```

`wire_api = "responses"` 要照写。想让它能改代码，还得**再加两行**（Codex 默认沙箱是只读，不加会被自己的沙箱拒掉，表现是「文件没建成」）：

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

这两块**必须成对**：`workspace-write` 会把网络一起掐掉，那时连不上本机代理，症状变成「模型一直不回话」——比只读更难查，因为它不报错。`bash scripts/doctor.sh` 会检查这两项。

**Cursor**：`Settings → Models → Override OpenAI Base URL` 填 `http://127.0.0.1:18794`，API Key 随便填个非空值，模型名选 18794 `/v1/models` 返回的真名（Cursor 默认的 `gpt-5` / `claude-sonnet-4` 会 404）。

**其余工具**

| 你要接的 | 指向 |
|---|---|
| opencode | `http://127.0.0.1:18798/v1` |
| Cline / Aider / OpenHands | `http://127.0.0.1:18799/v1` |
| DSH（DeepSeek Harness） | `http://127.0.0.1:18797/v1` |
| 其它任意 OpenAI 兼容客户端 | `http://127.0.0.1:18880/v1`（统一入口，按路径分发） |

> **Hermes 是另一类，别把它的端口填进 `base_url`。** `http://127.0.0.1:18793` 有 `/v1/models`（看着像接上了），但 `POST /v1/chat/completions` 是 404——它不转发请求，做的是改写 `~/.hermes/config.yaml` 里的当前模型，真正的模型请求由 Hermes 自己直连上游。所以 **Hermes 的用量不进账本**，没有流量经过它，也就没有账可记。

### 接完之后，确认它真的记上了

接上最容易出的问题不是配置写错，而是**你以为接上了、请求其实没经过代理**——屏幕上一点异常都没有，账本空着，然后你以为「这工具的账本没数据」。跑这条：

```bash
bash scripts/quickstart.sh --watch
```

它盯着账本等你那一笔：等到就打出来是谁的、哪个模型、多少 tokens、花了多少钱；等到 180 秒还没有，就按最常见的三个原因逐条报（工具没走代理 / 端口对不上 / 到了但没报账），而且**先现场探测这两个端口到底有没有在跑**——因为「配置里写了 18790」不等于「18790 上有进程」。

**一行验证**：

```bash
curl --noproxy '*' http://127.0.0.1:18880/v1/models
bash manage.sh status
```

> `--noproxy '*'` 不是可有可无：本机开着代理时，curl 会被劫持去连 127.0.0.1 然后失败，看着像服务挂了。

---

## 五、不信面板？自己验

面板是我们自己画的，你凭什么信。所以有一条**只读**命令，直接读你机器上的文件和本地接口，全程不经过界面：

```bash
bash scripts/verify.sh
```

三条口径值得单说，每条都有测试钉住：

- **开着 ≠ 跑过。** 门控那栏除了「开没开」，还报**每项真跑过几次**。一个装上了却一次没被走过的能力显示 `0 次`，看得见，不会被绿色「已开启」盖住。
- **服务全停也能跑。** 账本和命中记录都在磁盘上，manager 挂了只影响「门控当前值」一段。
- **「读不到」不会报成「0 笔」。** IO 失败时明说读不到并 exit 1；「没装」的代理只打 `-`，不算故障。把故障说成正常，是这类工具最常见的谎。

再进一步，让每个代理**真跑一条请求**（会出网，消耗零点几次免费额度）：

```bash
bash scripts/verify-lanes.sh            # 6 个代理逐个来
bash scripts/verify-lanes.sh codex dsh  # 只验指定的
```

**环境跑不动？** 那是另一个问题——「为什么它在我机器上跑不起来」，跑 `bash scripts/doctor.sh`。它每条都带**原因和修法**，不只是报个红。

---

## 六、它不会动你什么（四条铁律）

这是这份工具能让人放心用下去的原因。违反任何一条都算 bug：

1. **不写 agent 文件。** 对下游 agent 只读，不碰 `~/.codex`、`~/.hermes` 这些。
2. **不注入全局环境变量。** 不跑 `launchctl setenv`，env 只放进程自己的配置里。
3. **不写死端口。** 端口在听才算在跑，谁在 LISTEN 用谁。
4. **新能力默认关。** 加功能默认门控关闭或影子模式，不改变你现有行为。

所以：**把进程停掉，agent 回到原样，不需要回滚任何配置文件。**

---

## 七、局限（诚实说）

写出来比装作没有好。下面这些不是历史 bug，是**明确知道、能在代码里指认的缺口**：

1. **零 key 冷启验过 6 个代理，第 7 个（hermes）根本不属于这一类。** 2026-11-08 逐个实测：codex / claude / opencode / generic / dsh / cursor 都在「独立临时目录 + 上游指向 Kilo 匿名池」的条件下跑通一条真请求，`usage` 是上游回的真数字。这 6 条你现在都能自己复现：`bash scripts/verify-lanes.sh`。唯一例外：hermes 不转发请求，只改写 `~/.hermes/config.yaml` 的当前模型，用量不进账本。
2. **核心网关是单次转发，没有 failover / 重试 / 熔断。** 这三条只在 cursor-proxy 的路由模式里（round-robin / failover 两档）。「高可用路由」不是开箱能力，别按这个预期用。
3. **Key 级配额只有总量，没有日 / 周 / 月滚动窗口。** 只能设硬上限。
4. **一个代理实例绑一个上游**，「一个虚拟模型名映射到多个 Key 自动负载均衡」还做不到。
5. **Windows 只有安装脚本，没有对应的零 key 冷启脚本。**

**它现在稳定吗？** 还是 v1.x：单机单用户，接口会变（版本号看 GitHub tags，别信文档里写死的数字）。当**自用工具是稳的**；当基础设施上生产，请先读完本节。多租户、SSO、企业分账都不在这个开源仓库里（见末尾 License）。

---

## 八、数据与隐私

- **你的 API key 存哪？** 本机 `~/.multi-proxy-manager/providers.json`（cursor-proxy 的 key 额外用 AES-256-GCM 加密）。没有任何遥测、没有回传，`verify.sh` 全程只读本地文件，不发一个出网请求。
- **账本在哪？** `~/.multi-proxy-manager/cost-ledger.jsonl`，一个纯文本文件，`tail` 就能读，你随时能删、能搬、能自己核对。
- **「本地」是一档路由条件，不是降级开关。** 规则打上 `privacy`，下游地址就写死 `127.0.0.1`——是架构保证，不是调参调出来的效果。
- **免费池会把 prompt 用于服务改进**，别发敏感内容；脚本本身只发一句 `pong`。

两个已经踩过的坑，写下来省你一次：

- **僵尸请求**：本地推理慢，客户端 timeout 短会先断连，但 Ollama 那边照样跑完，白烧 CPU。给请求带 `max_tokens`，客户端 timeout 放大，别并发打本地大模型。
- **思考模型会吃光 token 预算**：`max_tokens` 给小了（比如 32），qwen3 这类模型把预算全花在内部推理上，`content` 直接是空串——看着像坏了，其实上游回了。预算给 512 起，并要认三个字段：`reasoning_content`（DeepSeek 风格）、`reasoning`（Ollama 风格）、`content`。

---

## 九、遇到问题怎么办

**先自己排（多数问题到这里就解决了）：**

| 现象 | 怎么查 |
|---|---|
| 服务跑不起来 / 端口连不上 | `bash scripts/doctor.sh`（带原因 + 修法） |
| 面板显示代理「未运行」但感觉在跑 | 管理器靠 `lsof` 查端口；你的 `lsof` 不在标准位置就会误判，`bash manage.sh status` 会说查不到 |
| 接上了工具但账本没数据 | `bash scripts/quickstart.sh --watch`（现场探测端口，逐条报三个最常见原因） |
| 面板打不开 / 忘记密码 | `rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`，下次访问重新引导设置 |
| 想确认整体健康 | `bash scripts/verify.sh`（只读，服务全停也能跑） |

**还是解决不了？** 到项目页提一个 **GitHub Issue**——这是最主要的反馈渠道，公开可追溯、零门槛。提 issue 时顺手附上三条，能省来回：

1. `bash scripts/doctor.sh` 的完整输出；
2. 你跑的命令、操作系统（macOS / Linux / Windows）；
3. 你想做什么、实际发生了什么。

> 出网管控（tenant 级 egress 策略）、多租户、SSO、审计留痕、企业分账属企业版范围，不在开源内核里；这类需求请在 issue 里说明，或直接联系 License 一节的方式。

---

## 十、常见问题

**我要全装吗？** 不用。两个进程（`codex-proxy` + `manager`）就能跑完上面的演示。其余按你实际用哪个工具再加：

```bash
bash install.sh              # 交互式向导，想用哪个装哪个，互不依赖
bash install.sh --all        # 一次装全：7 个代理 + 面板
bash install.sh --uninstall  # 卸载（.env 里的 key 一律保留，账单先备份再清）
bash manage.sh {start|stop|restart|status}
```

开机自启：`bash install.sh --autostart`（macOS launchd / Linux systemd user）。Windows 走 `.\install.ps1` 与 `.\manage.ps1`，原生 PowerShell，不需要 WSL。前置：Node.js 20+、Python3（只有 hermes-proxy 需要）。

**我和 cc-switch 能一起用吗？** 能。cc-switch 解决的是「这个 agent 用哪个上游」，这里解决的是「多个 agent 同时跑时出口和账」。两者会撞的只有一处：同一个 agent 的 `base_url`——撞了这里会报出来，不抢不覆写。

**它会不会改我的 agent 配置？** 不会。反过来，它会**读**各 agent 的配置文件看 `base_url` 指向谁——发现被别的工具占着，就告诉你冲突。想主动切换用 `bash tools/agent-proxy-switch`。

**面板打不开 / 忘记密码？** `rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`，下次访问重新引导设置。

---

## 十一、License 与联系

- **开源版：GNU AGPL-3.0**（见 `LICENSE`）：可自由使用、修改、再分发；但通过网络对外提供服务或分发衍生作品，须同样以 AGPL-3.0 开源其修改。
- **闭源商业产品 / 未开源的商业 SaaS 需单独授权**（`LICENSE-COMMERCIAL.md` / `LICENSE-ENTERPRISE.md`）。
- **反馈与报障：GitHub Issue**（见项目页）。

---

*本手册与 `README.md` 同源：README 讲差异点与验收证据，这份讲「一个新人该怎么从陌生走到放心」。项目 `multi-proxy` 已于 2026-11-11 更名为 `costgate`（GitHub 仓库 `sif-king/costgate`）；代码内部模块名与数据目录暂未随改——看到它们别困惑，是同一套东西。*
