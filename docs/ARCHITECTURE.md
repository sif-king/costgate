<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
本文件是项目 SSOT（架构真相源），改动需同步 docs/FEATURES.md 与 docs/DECISIONS.md。
-->

# ARCHITECTURE.md — costgate 架构真相源

> **读者**：任何接手本项目的 agent 或人。**目的**：在改任何一行代码之前，先知道东西在哪一层、归属谁、从哪个入口进。
> **纪律**：本文件写的是**现在是什么样**，不是"应该是什么样"。目标态写进 `docs/DECISIONS.md` 的待决策条目。
> **最后核对**：2026-11-14（所有路径均本机 `ls`/`grep` 实查，端口抄自 `manage.sh:27-36`）。

---

## 一、一句话

costgate 是**本地 AI 编码工具的网关 + 中台**：把 Codex / Claude / Cursor / Hermes / DSH / OpenCode / Generic 等工具的请求统一收口到本机一个地址，顺手记一笔真实的账（花了多少、花在哪），并把"改行为"（路由 / 熔断 / 编排）做成可开关的能力。

它**不是**通用 Agent 编排引擎，**不做**多租户控制面，**不重复造**云端 AI 网关的合规治理层（`docs/01-feature-matrix.md` 已把这三条标为 No Plan）。

---

## 二、分层（从外到内）

```
┌─ 交付层 ──────────────────────────────────────────────┐
│  client/   macOS 原生应用（Swift + AppKit + WKWebView）  │
│            起服务 / 探活 / 崩溃自愈 / 原生菜单 / 开机自启   │
│            ↓ 只做容器：webView.load(18792/dashboard.html) │
├─ 表示层 ──────────────────────────────────────────────┤
│  multi-proxy-manager/public/   12 个 HTML 页（真正的 UI）  │
│            nav.js（导航单一来源） icons.js（图标单一来源）   │
│            gatebar.js（门控状态条）                        │
├─ 控制面 ──────────────────────────────────────────────┤
│  multi-proxy-manager/  Express：路由 + 进程管理 + 认证 +    │
│            成本台账 + 门控判定（lib/gates.js）             │
├─ 编排内核 L2 ──────────────────────────────────────────┤
│  l2/       路由引擎 / 熔断 / 编排 / 告警 / 上下文折叠 /      │
│            知识库 / MCP / 技能宿主（多数默认关，影子运行）    │
├─ 适配层 ──────────────────────────────────────────────┤
│  codex-proxy/ claude-proxy/ cursor-proxy/ hermes-proxy/   │
│  dsh-proxy/ opencode-proxy/ generic-openai-proxy/          │
│  unified-ingress/ free-llm/ opencode-free/                 │
│  各自的 proxy.js，独立 package.json（有意设计，不是重复）    │
└───────────────────────────────────────────────────────┘
```

**关键正交关系**：`client/`（壳）与 `l2/`（内核）互不依赖，两者都只跟 manager（18792）讲话。改壳不影响内核，改内核不影响壳。

---

## 三、目录职责（谁负责什么）

| 目录 | 职责 | 别放什么 |
|---|---|---|
| `client/` | macOS 原生应用：窗口 / 菜单 / 服务守护 / 崩溃自愈 / 打包签名。**零业务 UI** | 面板页面、业务逻辑 |
| `multi-proxy-manager/public/` | **全部 UI**：12 个页面 + 导航 + 图标 + 门控条 | 后端逻辑、SQL |
| `multi-proxy-manager/routes/` | HTTP 端点（一个文件一个领域） | 业务内核实现 |
| `multi-proxy-manager/lib/` | 控制面内核：`gates.js`（门控唯一真源）/ 进程管理 / 认证 / 成本台账 | 路由注册 |
| `l2/` | 编排内核：路由、熔断、告警、编排、上下文折叠、知识库、MCP、技能宿主 | HTTP 层 |
| `*-proxy/` | 各工具的协议适配（Anthropic / OpenAI 兼容 / 自有协议） | 跨代理共享逻辑（走 `l2/`） |
| `scripts/` | 守卫与工具：`preflight.sh`（能不能过 CI）、`doctor.sh`（环境）、`verify.sh`（项目）、各 `check-*.sh` | 业务代码 |
| `docs/` | 文档。**本仓入口是 `docs/ARCHITECTURE.md`（SSOT）**；`docs/INDEX.md` 是本机维护的索引（不入仓），`docs/01-feature-matrix.md` 是历史台账 | 一次性草稿 |
| `PROJECT-STATE/` | 本机工作台账（append-only 日志、交接单、报告）。**不入仓**（`.gitignore:28`） | 对外文档 |

---

## 四、端口（真源 = `manage.sh:27-36`，用前实查）

| 服务 | 端口 | 变量 |
|---|---|---|
| codex-proxy | 18790 | `CODEx_PORT` |
| claude-proxy | 18791 | `CLAUDE_PORT` |
| **multi-proxy-manager（面板 + API）** | **18792** | `MANAGER_PORT` |
| hermes-proxy | 18793 | `HERMES_PORT` |
| cursor-proxy | 18794 | `CURSOR_PORT` |
| dsh-proxy | 18797 | `DSH_PORT` |
| opencode-proxy | 18798 | `OPENCODE_PORT` |
| generic-openai-proxy | 18799 | `GENERIC_PORT` |
| unified-ingress | 18880 | `UNIFIED_PORT` |

> 别在别处再抄一张端口表。这张表的真源是 `manage.sh` 的变量块；本文件只是它的投影，两者不一致时以 `manage.sh` 为准。

---

## 五、三条用户旅程 → 代码落点

这是判断"一个功能该不该存在、该归谁"的唯一标准。**不属于任何一条旅程的功能，不该出现在主界面。**

### 旅程① 看账（Ledger）
> 用户问题：「我这个月 AI 花了多少？哪个工具花的？」

| 环节 | 落点 |
|---|---|
| 请求级成本 | `l2/cost.js`、`multi-proxy-manager/lib/cost-track.js`（`PROXY_COST_TRACK` 默认开） |
| 当日账 | `routes/today.js` → `dashboard.html` 的「今天」tab |
| 实时盘面 | `routes/floor.js` → `floor.html` |
| 上下文构成（钱花在哪类 token） | `routes/context.js` + `l2/context-fold.js` → `context.html`（`PROXY_CONTEXT_TRACK` 默认关） |
| 余额 | 各代理 `BALANCE_ENDPOINTS` → `proxy-config.html` 余额区 |

### 旅程② 改行为（Routing / Circuit-break / Orchestration）
> 用户问题：「这条请求走哪个上游？挂了会不会自动切？贵的模型能不能自动降级？」

| 环节 | 落点 | 现状 |
|---|---|---|
| 路由 | `l2/route-engine.js`、`findProvider` | 可用；入口在 `proxy-config.html`（归属待收口） |
| 熔断 | `l2/circuit-breaker.js` | 默认 observe；**面板只有门控条状态，无控制面** |
| 编排 | `l2/orchestrator.js` | `PROXY_ORCHESTRATION` 默认影子；面板只有 dashboard「路由预演」只读 |
| 预算闸门 | `routes/budget.js` | 只读判级 + 越限告警 |

### 旅程③ 接入配置代理（Onboarding）
> 用户问题：「五六个工具各配一个 base_url，端口记不住。」

| 环节 | 落点 |
|---|---|
| 代理启停 | `manage.sh` + `lib/process-manager.js` |
| 配置页 | `proxy-config.html`（≈2.5k 行单体，见 §六 债 1） |
| 首启引导 | `consent.html`（同意门）→ `dashboard.html` |

---

## 六、面板结构（表示层）

**12 个页面**（`multi-proxy-manager/public/*.html`，本机 `ls` 实数）：

| 页面 | 用途 | 导航入口 |
|---|---|---|
| `dashboard.html` | 总览 + 6 个页内 tab（今天/健康/告警/Agent 清单/成本/路由预演） | 总览 |
| `floor.html` | 实时盘面 | 实时盘面 |
| `context.html` | 上下文构成 | 上下文构成（2026-11-14 补回） |
| `proxy-config.html` | 代理配置 / 路由模式 / 模型 / 余额 / 历史 | 代理配置 |
| `sessions.html` | 任务级 session（abort / resume） | 任务管理 |
| `logs.html` | 日志 + 错误模式 | 日志 |
| `knowledge.html` | 知识库（`PROXY_KNOWLEDGE_BASE` 默认关） | 知识库（可选能力） |
| `skills.html` | 技能宿主（`PROXY_L2_SKILLHOSTS` 默认关） | 技能（可选能力） |
| `settings.html` | 设置 / 撤销授权 / 配置导出 / 免费模型插件 / 法务 | 设置 |
| `login.html` | 登录（前置页） | 不入导航 |
| `consent.html` | 首启同意门（前置页） | 不入导航 |
| `legal.html` | 法务文本 | 入口在同意门/设置 |

**共用资产（单一来源，别各页自造）**：
- 导航：`public/nav.js` 的 `GROUPS`（侧栏）+ `SPA_VIEWS`（dashboard 页内 tab）。改导航只改这里。
- 图标：`public/icons.js` 的 `nav` 集。`nav.js` 有一份同形回退副本，改图标两边都要改。
- 门控条：`public/gatebar.js`。三态写 `data-loaded`，**读失败绝不 fallback 成「全部未开启」**。
- 共享助手：`public/mp-kernel.js` 的 `MPKernel` = `esc` / `fetchJSON` / `showReadError` / `showToast` / `getToken`。
  8 个页面原先各抄一份 `esc`（已分叉成两族写法），现收敛为「1 份实现 + 8 个别名」。
  边界：只放跨页**机制**，不放任何一页的业务；`showReadError` 因存在两套视觉**仍暂缓**；
  `nav.js` / `states.js` / `gatebar.js` 的私有 `esc` **不动**（要能被单独加载，见 D-013）。
- toast：**唯一规范是 `components.css` 的 `.toast` 段**（右上角、白底、左色条、带图标；
  容器 `.toast-container` 与 `.toasts` 规则相同）。`shared-styles.css` 同段已降级为别名桥，
  改它不生效。页面不许再写自己的 `.toast` CSS（见 D-014）。
- 版本号：**唯一源是仓库根 `VERSION`**，经 `/api/version` 下发。侧栏由 `nav.js` 的
  `fillSidebarVersion()` 填（页面自己写会被下一次 `renderNav` 冲掉），设置页「关于」由
  `#aboutVersion` 填。**任何地方都不许写死版本号**——`check-panel-coherence.sh` 第 6 项会拦。

**已确认的结构债**（详细清单见 `docs/FEATURES.md` §四，整改计划见本机台账 `PROJECT-STATE/COSTGATE-UI-COMB-REPORT-2026-11-14.md`，不入仓）：

| # | 债 | 现状 | 判据 |
|---|---|---|---|
| 1 | 单体页 | `dashboard.html` ≈3.4k 行内联 6 子视图；`proxy-config.html` ≈2.5k 行混 6 类关注点（2026-11-14 观测，不是规则） | 改一个子视图要读整文件 |
| 2 | 零子目录 | `public/` 完全平铺：12 个 HTML + 13 个 JS/CSS，没有任何子目录 | 三条旅程的代码被切碎在 25 个平级文件里 |
| 3 | 重复看账面 | 已收口 3 处（2026-11-14）：概览 vs 成本页同一份 watchtower、概览 vs 死容器 sessions、概览卡 vs 健康页逐字相同的 Provider 渲染。余 today / floor / context 三处**数据面本就不同**（`/api/today` / `/api/floor` / `/api/context/*`），不合并 | 用户分不清哪个是真的 |
| 4 | 孤儿后端 | 7 条 `/api/*` 面板零引用 | 已用 `BACKEND-ONLY` 标注，见 §八 |

---

## 七、SSOT 三件套（改代码前必读）

| 文件 | 回答什么问题 | 什么时候必须改 |
|---|---|---|
| `docs/ARCHITECTURE.md`（本文件） | 东西在哪一层、归属谁 | 新增目录 / 新增层 / 端口变更 |
| `docs/FEATURES.md` | 有哪些功能、归哪个域、哪些是孤儿 | 增删功能 / 功能换归属 |
| `docs/DECISIONS.md` | 为什么这么定、哪些还待定 | 做架构决策 / 推翻旧决策 |
| `AGENTS.md` | 硬边界与禁止项（宪法）。**本机私有，不入仓**（`.gitignore:88`） | 新增红线 |

---

## 八、孤儿后端（已标注，不是"没做"）

以下 7 条路由**已挂载且可用**，但面板没有操作面，调用方是 API / CLI / 外部程序。`server.js` 对应行已标 `BACKEND-ONLY`：

| 路由 | 真实调用方 |
|---|---|
| `/api/orchestration` | dashboard「路由预演」只读间接用 + CLI |
| `/api/guard` | 外部项目（如审核平台）经 HTTP 接入 |
| `/api/skill-service` | API/CLI（面板技能页走 `/api/skill-hosts`） |
| `/api/memory-merge` | API/CLI |
| `/api/mcp` | MCP 客户端直连 JSON-RPC |
| `/api/h3web` | 本地服务检测/提醒 |
| `/api/im-inbound` | IM 平台回调 |

**守卫**：`scripts/check-panel-coherence.sh`（已接 `preflight.sh` 第 3b 步）。新增挂载路由若面板零引用又没标注，preflight 直接红。

---

## 九、重构期红线（本次整改期间有效，整改完成后并入 AGENTS.md）

1. **一次只动一个 feature**。跨域改动拆成多个切片，每切片一个 commit。
2. **切片前 commit，跑偏就回退**。不在出错状态就地打补丁——打补丁正是"AI 打地鼠"的成因。
3. **不动热路径**：`l2/forward.js`、各 `*-proxy/proxy.js` 的转发逻辑在纯前端重构里应 0 改动。要动就是另一件事，单独评估。
4. **`PROXY_*` 门控语义不准动**。重构只改"在哪点"，不改"点了之后发生什么"。
5. **删页面前先确认它不是孤儿**：`grep -rIl "<页面名>" multi-proxy-manager/` 有引用就不能直接删。
6. **每切片跑 preflight**（至少 3b 面板一致性 + 相关 jest）。本地绿不算绿，CI 绿才算。
