<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 对外文档怎么写 —— 从四个真实仓库抽象出来的方法论

> 这份文件只回答一件事：**陌生人打开仓库前 90 秒，我们该让他看到什么、按什么顺序看到。**
> 它不是文风指南（不要形容词、不要排比句那种），是**结构**指南。
> 改 `README.md` / `COMPATIBILITY.md` / `SECURITY.md` 之前先读它；改完由
> `tests/shell/readme-structure.test.bats` 机检结构、`tests/shell/readme.test.bats` 机检事实。

---

## 0 · 一句话结论

**可读性不是文笔问题，是结构问题。**

陌生人打开一个仓库，前 90 秒只问三件事：

1. **这是什么、值不值得我继续读？**（一句话能不能被我复述给同事）
2. **怎么在两分钟内看到它动一下？**（命令能复制、跑完知道"成了"长什么样）
3. **它和我已经在用的东西是什么关系？**（重叠在哪、我该换还是在上面加一层）

热门仓库把这三件事排在最前面，把细节折叠起来。**我们之前的毛病不是"不诚实"，是把诚实写成了密集**——
真实的免责声明、真实的分段耗时、真实的边界，全部平铺在主干道上，结果第 200 行还没出现一张图。
诚实是加分项，但**它得待在"读完主路径之后"的位置**，否则读者在建立心智模型之前就被细节淹死了。

---

## 1 · 样本与观察（2026-11-12 抓取原文，非印象）

| 仓库 | 形态 | 前 3 屏做对了什么 | 具体手法（原文措辞） |
|---|---|---|---|
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | Python AI Gateway | 定位句同时给出**类别 + 数量 + 格式 + 部署形态** | `Open Source AI Gateway for 100+ LLMs. Self-hosted. Enterprise-ready. Call any LLM in OpenAI format.` |
| 同上 | | 能力不写散文，写**折叠块**，每个能力自带代码 | `## Features` → `<details open><summary><b>LLMs</b> - Call 100+ LLMs (Python SDK + AI Gateway)</summary>` |
| 同上 | | 先把"两种用法"用一张**两列对比表**切开，再往下走 | `## Get Started` 下的表头是 `Use Case / Who Uses It? / Key Features` |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | TypeScript AI Gateway | 快速开始直接标时长，并**拆成 1/2/3 步**，每步一块可复制命令 | `## Quickstart (2 mins)` → `### 1. Setup your AI Gateway` / `### 2. Make your first request` / `### 3. Routing & Guardrails` |
| 同上 | | 每一步都写"跑完你会看到什么" | `The Gateway is running on http://localhost:8787/v1` |
| 同上 | | 生态兼容性用**矩阵表**，一屏看完 | `## Agents` 下的 `Framework / Call 200+ LLMs / Advanced Routing / Caching / …` |
| 同上 | | 关键提示用 GitHub callout，不混进正文 | `> [!TIP]` / `> [!IMPORTANT]` |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 自托管 AI 平台 | 第一段就是**定义句**，且点明最不一样的约束 | `Open WebUI is a home for AI: an extensible, easy-to-use, self-hosted platform built to run entirely offline.` |
| 同上 | | 安装方式按**环境**分块，块后紧跟**参数表** | `### Installation` → Python / Docker / Desktop；Docker 后面跟镜像 tag 表 + 环境变量表 |
| 同上 | | 安全与许可**单独成节**，不埋在正文 | `### Security` / `#### License`（还点明品牌保留条款） |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | 中文 LLM 分发系统 | 顶部一行**锚点导航**，长文档也能跳 | `部署教程 · 使用方法 · 意见反馈 · 截图展示 · 在线演示 · 常见问题 · 相关项目` |
| 同上 | | 一句斜体定位语，读完就知道是什么 | `通过标准的 OpenAI API 格式访问所有的大模型，开箱即用` |
| 同上 | | 合规与危险默认值提到**最顶部**，用 callout 强调 | `> [!NOTE]`（合规）/ `> [!WARNING]`（务必修改默认密码） |

**四个仓库的共同点**：没有一个是靠"写得优美"取胜的，全部靠**信息在正确的位置**。

---

## 2 · 八条可执行规则

每条都给出：规则 → 样本里谁这么做 → 本项目怎么落 → **哪条守卫钉它**。

### R1 · 一句话必须能被复述

公式：**`<类别词>` + `<对谁>` + `<最不一样的约束>`**。

- 样本：Portkey `Route to 250+ LLMs with 1 fast & friendly API`；one-api `通过标准的 OpenAI API 格式访问所有的大模型，开箱即用`。
- 本仓：`把你本机那些 AI 编码工具的模型请求收到一处，记一本你自己能查的花销账。`
- 自检：念给一个不用 AI 编码工具的人听，他能不能说出"这是个记账的中间层"。

### R2 · 三步内跑起来，每步都写"成了长什么样"

- 样本：Portkey 的 `Quickstart (2 mins)`，三步各一块命令 + 一句预期输出。
- 本仓：`git clone` → `bash scripts/quickstart.sh` → 屏幕上出现「第一笔真实账单」方框。
- 铁律：**命令必须可直接复制**（不要 `$ ` 前缀，不要省略 `cd`），**成功判据必须是可见的**（不是"没有报错"）。

### R3 · 主路径不放长免责声明——折叠，但不删

- 样本：LiteLLM 把每个能力塞进 `<details>`，主屏只留标题；open-webui 把参数表放在安装块之后。
- 本仓：实测耗时差异、端口/env 细节这类"解释为什么"，收进 `<details>`；**结论留在外面**（"会报真实秒数"），过程收进去。
- 判据：主路径上的每个段落，删掉之后读者还能不能跑通？能删的就不是主路径。

### R4 · 能力用表格，不用散文

- 样本：Portkey 的 framework 矩阵、open-webui 的镜像 tag 表。
- 本仓的专用三列：**「你遇到什么事 / 它怎么办 / 你自己怎么确认」**——第三列是关键，它把"我说我行"变成"你能验"。
- 反例：连续三段都是"我们支持……我们也支持……"——读者读不出差异，只读出推销。

### R5 · 前 200 行内必须有一张图

- 样本：open-webui 首屏就是 demo 动图；LiteLLM / Portkey 没有架构图，这是它们的短板。
- 本仓：`## 30 秒看懂它` 的 mermaid 图（工具 → 统一入口/代理 → 上游 → 账本 → 面板）。
- 为什么重要：文字描述的拓扑，读者要在脑子里搭一次；图是**共用的那一次**。

### R6 · 必须有对比表，而且敢写"什么时候别用我"

- 样本：LiteLLM 用两列表切开 Proxy vs SDK；Portkey 用 `## Gateway Enterprise Version` 把商业版边界写清。
- 本仓：`## 它和别的东西什么关系`——LiteLLM / Portkey / one-api / cc-switch / OpenRouter，每行都写"差在哪、所以你可能选它"。
- 铁律：**不贬损对手**（写事实差异，不写"它们太烂"）；**不编造**（每个对比对象必须在本文件 §5 留可点开的 URL）。

### R7 · 边界单独成节：安全 / 许可 / 已知不做

- 样本：open-webui 的 `### Security` 与 `#### License`；one-api 顶部的合规 NOTE 与默认密码 WARNING。
- 本仓：`SECURITY.md`（拦什么/拦不住什么/数据去哪）+ `COMPATIBILITY.md`（认哪些协议/到哪个版本）+ `## 现在还没做的`。
- 判据：**边界要能被指认到代码**（文件名/门控名），不能只是态度。

### R8 · 数字必须带环境与日期，并解释"为什么每次不一样"

- 样本：三家都写"2 mins / 2 分钟"这类**目标值**，不写"稳定 2 秒"这类**承诺值**。
- 本仓：所有耗时都标日期 + 环境 + 分段，并单独解释"首次要下依赖"——这条是本仓比样本更硬的地方，别为了好看删掉。
- 铁律：**变量不当常量**（版本号、端口、秒数、星数都不写死成规则）。

---

## 3 · 三层检查表（照着打勾就能开工）

**前 30 行（决定读不读）**
- [ ] 一句话定位（R1）
- [ ] 一眼能看出"给谁用"（一句具体场景，不是"给开发者"）
- [ ] 徽章不超过 4 个，且都指向真实存在的东西
- [ ] 审计入口（安全/兼容/变更）在一屏内

**前 200 行（决定试不试）**
- [ ] 一张架构图（R5）
- [ ] 可复制的三步快速开始 + 成功长什么样（R2）
- [ ] 一张能力表，且有"你怎么自证"那一列（R4）
- [ ] 一张对比表，含"什么时候别用我"（R6）

**全文（决定信不信）**
- [ ] 边界单独成节，可指认到代码（R7）
- [ ] 所有数字带日期/环境，变量不写成常量（R8）
- [ ] 没有一张"写了但点不开"的链接（`readme.test.bats` 钉）
- [ ] 已知不做的事，明确写"没做"，不写成"规划中"

---

## 4 · 我们自己犯过的三个反模式（留作反面教材）

1. **把"诚实"写成"密集"**。606 行、15 个二级标题、前 200 行零图零对比——每句都真，但读者在第 3 屏就放弃。
   修法不是删掉诚实，是**给诚实排序**：结论在外面，过程折叠进去。
2. **用形容词代替证据**。"它很安全"没有信息量；`SECURITY.md` 里"6 条正则 + 9 个用例 + 拦不住什么"才有。
3. **对比留白**。不写"我和 LiteLLM 差在哪"，读者的默认假设不是"各有千秋"，而是"你没有差异"。
   留白不会显得谦虚，只会显得没想过。

---

## 5 · 对比对象的出处（防止编造，R6 的配套）

写进 README 对比表的每一个对象，必须在下面留一行可点开的来源。
新增对比对象时**先补这里，再写 README**——顺序反了就容易写出"听说它支持 XX"。

| 对象 | 来源 URL | 本文档引用的关键事实 | 抓取日期 |
|---|---|---|---|
| LiteLLM | https://github.com/BerriAI/litellm | 自述 "Open Source AI Gateway for 100+ LLMs. Self-hosted."；定位面向平台团队（virtual keys / 分账 / 负载均衡） | 2026-11-12 |
| Portkey Gateway | https://github.com/Portkey-AI/gateway | 自述 "Route to 250+ LLMs with 1 fast & friendly API"（仓库描述为 1,600+）；强项是 guardrails / 条件路由 / 缓存 | 2026-11-12 |
| one-api | https://github.com/songquanpeng/one-api | 自述"LLM API 管理 & 分发系统……可用于 key 管理与二次分发。单可执行文件" | 2026-11-12 |
| Open WebUI | https://github.com/open-webui/open-webui | 自述 "self-hosted platform built to run entirely offline"（本文档只取它的**写法**做样本，不作竞品对比） | 2026-11-12 |
| cc-switch | https://github.com/farion1231/cc-switch | 切换某个 agent 用哪个上游；与本仓是互补关系（仓库语言 Rust，与本仓 `AGENTS.md` 记的 Tauri 形态一致） | 2026-11-12 |
| OpenRouter | https://openrouter.ai | 托管式聚合 API（云服务）：统一入口接多家模型，按它的价目计费 | 2026-11-12 |

> 写作时若引用**具体数字**（支持多少模型、多少 star），必须重新抓一次并改日期——
> 这类数字天天变，本文档只保证"抓取当天为真"。

---

## 6 · 怎么让这套东西不腐烂（机制，而不是倡议）

一份方法论写进 `docs/` 就没人读，等于没写。所以它接了三处机器约束：

| 环节 | 落点 | 失效时谁会喊 |
|---|---|---|
| **结构** | `tests/shell/readme-structure.test.bats` | 图没了、对比表没了、章节空了、对比对象没留出处 → 红 |
| **事实** | `tests/shell/readme.test.bats` | 引用路径/脚本/参数不存在、示例输出与脚本不一致 → 红 |
| **接线** | `docs/CHANGE-MAP.md` 的「我想改 README / 对外文档」一行 | 表里路径失效 → `tests/shell/change-map.test.bats` 红 |
| **入口** | `docs/INDEX.md` 一级文档表 + `AGENTS.md §7` | 新增文档不登记 → 靠 review；`INDEX` 是发现链，不是装饰 |

**改动纪律**：任何"结构级"的 README 改动（删章节、换顺序、去图），必须先跑守卫；
守卫变红不许改守卫来迁就文档——**先问"是不是结构真的退化了"**。
守卫本身也要做注入回归（把图删掉跑一遍，确认它真红），否则可能只是"正好没匹配上"。
