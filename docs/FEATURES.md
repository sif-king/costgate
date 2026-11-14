<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
本文件是项目 SSOT（功能真相源）。改功能归属必须同步本文件，否则守卫之外没人知道。
-->

# FEATURES.md — 功能清单与归属矩阵

> **用途**：回答三件事——① 这个项目到底有哪些功能；② 每个功能归哪个业务域、代码在哪；③ 哪些是孤儿（有代码没入口）或半接线（有入口没后端）。
> **判据**：一个功能是否存在，看**用户能不能从主界面走到**，不看代码里有没有。代码在但点不到 = 半成品，不是功能。
> **最后核对**：2026-11-14，本机 `ls`/`grep`/`Read` 实查。

---

## 一、归属判据：三条用户旅程

任何功能必须先回答"它服务哪条旅程"，答不出来就不该出现在主界面。

| # | 旅程 | 用户问题 | 归属域 |
|---|---|---|---|
| ① | 看账 | 我这个月花了多少？哪个工具花的？钱花在哪类 token？ | `ledger` |
| ② | 改行为 | 这条请求走哪个上游？挂了会切吗？贵的能降级吗？ | `behavior` |
| ③ | 接入配置 | 五六个工具各配 base_url，端口记不住 | `onboarding` |

> 现状：`public/` **没有按这三个域分目录**，12 个页面平铺。这是"乱"的结构性原因（见 §四 债 2）。

---

## 二、功能清单（按旅程分组）

### ① 看账 `ledger`

| 功能 | 页面 / 入口 | 后端 | 状态 | 备注 |
|---|---|---|---|---|
| 今天这本账 | `dashboard.html`「今天」tab | `/api/today` | ✅ 可用 | 请求账 + 文件账两本合成 |
| 请求成本 | 同上「成本」tab | `/api/cost/*`、`lib/cost-track.js` | ✅ 默认开 | `PROXY_COST_TRACK`（OOBE 红线，关了整个成本面空表） |
| 实时盘面 | `floor.html` | `/api/floor` | ✅ 可用 | 只读聚合（cost-track + provider-health） |
| 上下文构成 | `context.html` | `/api/context/*`、`l2/context-fold.js` | ⚠️ 数据默认不采 | `PROXY_CONTEXT_TRACK` 默认关，**且未登记进 gates.js**（§五） |
| 余额 | `proxy-config.html` 余额区 | 各代理 `BALANCE_ENDPOINTS` | ✅ 可用 | 每代理独立实现 |
| 预算闸门 | 无独立页面（告警通道） | `/api/budget` | ✅ 可用 | 配置文件是 `~/.multi-proxy-manager/budget.json`（运行时文件，不在仓内，可用 `PROXY_BUDGET_FILE` 覆盖）；不配 ⇒ `enabled:false`，零行为变更 |

**重复问题**：today / cost / floor / context 四个面都在回答"用了多少"，用户会问"哪个是真的"。四者的唯一职责应明确为：
- `today` = **按天**的账（今天的）
- `cost` = **按维度**的账（按 agent / 模型 / 总量）
- `floor` = **此刻**的账（实时滚动）
- `context` = **按类别**的账（钱花在哪几类 token 上）

### ② 改行为 `behavior`

| 功能 | 页面 / 入口 | 后端 / 内核 | 状态 | 备注 |
|---|---|---|---|---|
| 路由模式 | `proxy-config.html` `#routingModeItem` | `l2/route-engine.js`、`findProvider` | ✅ 可用 | **归属可疑**：属旅程②却藏在"代理配置"页 |
| 路由预演 | `dashboard.html`「路由预演」tab | `/api/l2/shadow-map` | ✅ 只读 | 只展示会怎么路由，不真转发 |
| 熔断 | 无控制面 | `l2/circuit-breaker.js` | ⚠️ 默认 observe | 面板只有门控条状态，无开关、无可视化 |
| 编排 | 无控制面 | `l2/orchestrator.js` | ⚠️ 默认影子 | `PROXY_ORCHESTRATION`；只记账不动路由 |
| 告警 | `dashboard.html`「告警中心」tab | `/api/alert`、`l2/alert.js` | ✅ shadow | `PROXY_HEALTH_ALERT` 默认关 = observe |
| 故障隔离 | 门控条 | `PROXY_HEALTH_ISOLATE` | ⚠️ 默认 observe | 无控制面 |
| 预算越限动作 | 无 | `routes/budget.js` | ✅ | 复用 alert 内核 |

**结论**：旅程② 是**最弱的一环**——用户能"看见状态"，但基本"改不了行为"。这是"功能有点杂"的另一面：入口不少，能真操作的少。

### ③ 接入配置 `onboarding`

| 功能 | 页面 / 入口 | 后端 | 状态 |
|---|---|---|---|
| 代理启停 / 重启 | `proxy-config.html` | `/api/installed`、`/start`、`/stop`、`/restart`、`lib/process-manager.js` | ✅ |
| 供应商 CRUD | `proxy-config.html` | `/api/proxy-configs`、`routes/proxy-api.js` | ✅ |
| 模型切换 / 拉取 | `proxy-config.html` | `/api/fetch-models`、`routes/proxy-control.js` | ✅ |
| 连通性测试 | `proxy-config.html` | `/api/test-connection` | ✅ |
| 历史 | `proxy-config.html` | `/api/<proxy>/history` | ✅ |
| 首启同意门 | `consent.html` | `/api/consent/*` | ✅ |
| 登录 | `login.html` | `/api/auth/*`、`lib/auth.js` | ✅ |
| 法务 | `legal.html` | `/api/legal` | ✅ |

> `proxy-config.html` 2504 行把上面 5 件事 + 余额 + 路由模式全塞一页，是"杂"最集中的地方。

### 通用 / 运维

| 功能 | 页面 | 后端 | 状态 |
|---|---|---|---|
| 任务级 session（abort/resume） | `sessions.html` | `/api/sessions/*`、`lib/session-keepalive.js` | ✅ 23/23 jest |
| 日志 + 错误模式 | `logs.html` | `/api/logs`、`/api/errors/patterns` | ✅ |
| 设置 / 撤销授权 / 配置导出 | `settings.html` | `/api/consent/revoke`、`/api/config-export` | ⚠️ 关注点混杂 |
| 免费模型插件 | `settings.html` 内 | `/api/free-llm-plugin/*` | ⚠️ 与设置混在一页 |
| 知识库 | `knowledge.html` | `/api/knowledge/*` | 默认关（`PROXY_KNOWLEDGE_BASE`） |
| 技能宿主 | `skills.html` | `/api/skill-hosts/*` | 默认关（`PROXY_L2_SKILLHOSTS`） |
| 桌面客户端 | `client/` | 直连 18792 | ⚠️ 壳完整，UI 全是 Web（§三） |

---

## 三、桌面客户端现状（客户端的准确口径）

**`client/` 是 macOS 原生应用**，不是"误归的壳"：2026-10-31 老板拍板「桌面二选一 → 走原生 Swift」，Electron `desktop/` 退场（决策台账见本机 `docs/INDEX.md` #98/#99，该索引不入仓）。

已实现（`client/src/main.swift`，1123 行，AppKit + WKWebView，无 Electron 无第三方依赖）：

| 能力 | 落点 |
|---|---|
| 原生窗口 | `NSWindow`（`main.swift:718`） |
| 原生菜单：检查并启动服务 / 重载面板 / 开机自启 / 可选集成 / 关于 / 退出 | `buildMenu()`（`main.swift:759-784`） |
| 服务守护：探 18790 health + 18792 面板，不在就自己拉起 | `startBase()`、`startManager()`（`main.swift:298+`） |
| 渲染进程崩溃自愈 | `webViewWebContentProcessDidTerminate`（`main.swift:1100`） |
| 打包 / 图标 / adhoc 签名 / 版本号运行时读 | `client/build.sh` |

**未实现（被上下文淹没的待办，不是设计如此）**：

| 缺口 | 影响 | 归属 |
|---|---|---|
| **UI 全是 Web 页面，原生层只是容器** | "Mac 原生应用"实际是"原生外壳 + 网页内容"；用户感知不到原生 | `client/`（需决策，见 DECISIONS D-003） |
| 无原生首启向导 | 首次双击后要等 Web 面板加载，中间无原生反馈 | `client/` |
| 无状态栏（menu bar）常驻 | 看账要开窗，不能一眼看今天花了多少 | `client/` |
| 无原生通知 | 预算越限/代理挂了只有面板内提示 | `client/` |

> 判定：**"客户端功能乱"说的是容器里的 Web 面板乱，不是容器本身乱。** 容器 1123 行、职责单一、有崩溃自愈，是干净的。把这两件事混在一起谈，就会去重构不该动的地方。

---

## 四、结构债清单（本机实查，file 级可引）

| # | 债 | 证据 | 影响 |
|---|---|---|---|
| 1 | 单体页 | `dashboard.html` 3504 行（7 个 `.page` 容器内联）；`proxy-config.html` 2504 行（6 类关注点） | 改一个子视图要读整文件 |
| 2 | 零子目录 | `public/` 是**完全平铺**的：12 个 HTML + 13 个 JS/CSS（`nav.js`/`icons.js`/`gatebar.js`/`states.js`/`theme.js`/`floor-view.js`/`skill-ledger-diff.js` + 6 个 css），无任何子目录 | 三条旅程的代码被切碎在 25 个平级文件里，没有"域"可挂 |
| 3 | 重复看账面 | 三处已收口（2026-11-14）：① 总览「账本主权」与成本页曾各渲染一遍同一个 `/api/cost/watchtower`（解释块都抄两份）→ 总览只报一个数 + 入口；② 概览「运行中任务」与已死的 `page-sessions` 用同一函数渲染两个容器 → 死容器已删；③ Provider 隔离状态在概览卡与健康页各写一遍**逐字相同**的 HTML 生成代码 → 合并为 `renderProviderIsolation`。剩余：today / floor / context 三处数据面本就不同（`/api/today`、`/api/floor`、`/api/context/*`），无需合并 | 用户分不清哪个是真的 |
| 4 | 归属可疑 | 路由模式藏 `proxy-config.html`；设置页混撤销授权 + 插件 | 用户找不到 |
| 5 | 孤儿页 | `context.html` 有路由无导航（**2026-11-14 已补回**） | 只能手敲 URL |
| 6 | 孤儿后端 | 7 条 `/api/*` 面板零引用（已标 `BACKEND-ONLY`） | 以为没做 |
| 7 | 门控未登记 | `PROXY_CONTEXT_TRACK` 曾未进 `gates.js`（**2026-11-14 已登记**，§五） | 门控条看不见、界面开不了 |
| 8 | 文档过时 | `docs/01-feature-matrix.md` 写"前端 4 页"（实为 12 页）；本机索引 `docs/INDEX.md` 项目一句话仍写"管理三个代理"（`manage.sh` 的 `SERVICES` 实为 9 项） | 误导后续 agent 在错的目录/范围里找功能 |
| 9 | 面板测试没人跑 | `multi-proxy-manager/tests/node/` 三个文件共 29 条断言（面板语法 / 读失败不许假绿 / 写失败不许乐观更新）**不在任何 CI 或 preflight 里**，实测长期 5 + 6 条假红。**2026-11-14 已修好并接入 preflight 3c + CI manager job** | 刹车网在硬盘上、闸没拉——页面重构等于裸奔 |
| 10 | 无入口死容器 | `dashboard.html` 的 `page-sessions` 有内容、被 `loadSessions()` 渲染，但无 tab / 无侧栏入口 / 无 `switchPage` 跳转，**用户永远看不到**；读失败提示还写进它，可见的卡只剩「暂无运行中任务」。**2026-11-14 已删**（D-012），并把判据写进守卫第 4 项 | 修的东西写在看不见的地方，测试却是绿的 |

---

## 五、门控登记缺口（已修，2026-11-14）

`PROXY_CONTEXT_TRACK` 原本只被直接读 env，没登记进注册表：

- 读取处：`l2/context-report.js:35`（唯一判定点；`generic-openai-proxy/proxy.js:1149` 只是调 `observe()`，不自己判）
- 注册表：`multi-proxy-manager/lib/gates.js` —— 已新增 `context-track`（group 账本主权 / kind opt-in / `scope: 'repo'`）

登记后加了对拍测试，当场抓到第二个问题：`context-report` 裸比 env（大小写/空白敏感），`'ON'` 判关而注册表判开。该文件注释本就自称「与 `cost-track.enabled()` 同构」，已按注释改为 `trim().toLowerCase()`（只放宽被接受的字面值，默认态仍为关）。

**判据（写进上面的 D-008）**：凡登记进门控表且导出 `enabled()` 的模块，必须配一条 crossCheck 测试，否则"状态条说谎"会再次无声发生。

---

## 六、孤儿 / 半接线完整清单

**孤儿后端（有挂载、可用、面板无入口，已在 `server.js` 标 `BACKEND-ONLY`）**

`/api/orchestration`、`/api/guard`、`/api/skill-service`、`/api/memory-merge`、`/api/mcp`、`/api/h3web`、`/api/im-inbound`

**半接线（有页面但后端默认关，进去只看到"门控关"）**

`knowledge.html`（`PROXY_KNOWLEDGE_BASE`）、`skills.html`（`PROXY_L2_SKILLHOSTS`）、`context.html`（`PROXY_CONTEXT_TRACK`）

**守卫**：`scripts/check-panel-coherence.sh` 钉住"新增挂载路由若无前端引用必须有标注"，已接 preflight 3b。

---

## 七、维护规则

1. **加功能**：先判旅程 → 定域 → 写进本文件 §二 → 再写代码。顺序反了就会出现孤儿。
2. **删功能**：先 `grep -rIl "<名字>" multi-proxy-manager/` 确认无引用 → 从本文件销账 → 再从 `PAGE_REGISTRY` 销账（否则守卫红）。
3. **换归属**：本文件 + `ARCHITECTURE.md` 同时改，并在 `DECISIONS.md` 记一条"为什么换"。
4. **不许写"已完成"但点不到**：状态只有三种——✅ 用户可达、⚠️ 有代码但默认关/无入口、❌ 未做。
