<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
本文件是项目 SSOT（决策真相源）。新决策 append，不改旧条目；推翻旧决策要写新条目并注明推翻谁。
-->

# DECISIONS.md — 架构决策记录（ADR-lite）

> **为什么要有它**：本项目最贵的错误不是写错代码，是**同一个问题被反复重新决策**——每次新会话的 agent 都从零判断"面板该归谁""桌面用什么壳"，于是同一件事被改三次、结论互相打脸。
> **用法**：改架构前先搜这里。已有决策就遵守；要推翻就写新条目并注明推翻哪条，不许默默改。
> **格式**：背景 → 决策 → 后果 → 什么情况下该推翻它（没有第四项的不是决策，是口号）。

---

## D-001 · 面板的归属是 `multi-proxy-manager/public/`

- **状态**：已定（2026-11-14）
- **背景**：多次出现"客户端在哪"的误判。`client/` 是原生应用壳，不含任何业务 UI。
- **决策**：**全部 UI 在 `multi-proxy-manager/public/`（12 个 HTML 页）**。`client/` 只做容器：加载 `http://127.0.0.1:18792/dashboard.html`。
- **后果**：找 UI 去 `public/`；找壳行为去 `client/src/main.swift`。两者互不引用。
- **推翻条件**：若改为原生控件渲染主要界面，此决策作废（见 D-003）。

---

## D-002 · 桌面形态 = 原生 Swift，Electron 退场

- **状态**：已定（2026-10-31 老板拍板，本机台账 `docs/INDEX.md` #98；#99 补齐 watchdog 与首启清理）
- **背景**：曾有两套壳并存（Electron `desktop/` + 原生 `client/`），用户不知道该用哪个，团队也不知道该修哪个。
- **决策**：走原生 Swift（AppKit + WKWebView，无 Electron、无第三方依赖）；`desktop/` 已 `git rm` 退场。
- **后果**：打包链是 `client/build.sh`（swiftc + icns + adhoc 签名，版本号运行时读 `VERSION` + git SHA）。**不要重新引入 Electron**。
- **推翻条件**：需要 Windows / Linux 桌面版时。那时是新增平台，不是回退 Electron。

---

## D-003 · 客户端分两层：原生壳（已完成）+ Web 内容（现状）；原生 UI 化未定

- **状态**：**待老板决策**
- **背景**：`client/` 的原生壳已经做完了——原窗、原生菜单（启动服务/重载/开机自启/关于）、服务守护（探 18790+18792 并自行拉起）、渲染崩溃自愈、打包签名。**但界面 100% 是 Web**。老板 2026-11-14 指出："之前咱们说过要做 mac 原生应用，后来被上下文淹没了。"
- **事实澄清**：这件事没丢，是被"客户端功能乱"这个说法盖住了——乱的是容器里的 Web 面板（12 页、单体、重复看账面），容器本身 1123 行、职责单一、干净。
- **待选方案**：

| 方案 | 做法 | 代价 | 适合什么阶段 |
|---|---|---|---|
| **A. 原生壳 + 重组后的 Web 面板**（推荐先做） | 先按业务域把 12 页收口成 3 域，容器不动 | 低；纯前端重构 | 现在。先把"乱"解决，再谈原生 |
| **B. 关键页原生控件化** | 只把「今天这本账」用 `NSTableView` 原生实现，其余仍 Web | 中；两套渲染并存，需处理数据同步 | 面板收口之后，作为差异化演示 |
| **C. 全原生** | 12 页全部改成 AppKit 界面 | 高；等于重写一遍 UI，且失去 Web 的迭代速度 | 除非确定要上架 App Store 卖 |

- **建议**：**先 A 后 B**。理由：现在的痛点是"乱"，不是"不够原生"。A 解决乱且零风险；B 在 A 完成后能拿"今天这本账"做原生体验的样板，成本可控。C 在功能还没稳定时做，等于把重构成本乘二。
- **推翻条件**：若产品定位改为"卖给不装命令行的小白用户"，C 才有意义——那时 Web 面板反而是负担。

---

## D-004 · 孤儿后端先标注，不急着补 UI 也不急着删

- **状态**：已执行（2026-11-14）
- **背景**：7 条 `/api/*` 路由已挂载可用，但面板零引用（`grep` 实查 = 0）。此前没有标记，导致两种误判："以为没做"和"以为坏了"。
- **决策**：在 `server.js` 对应行标 `BACKEND-ONLY: <真实调用方>`；不加假 UI，不删路由。
- **后果**：守卫 `scripts/check-panel-coherence.sh` 强制"零引用必须有标注"，且"标了却有人引用"也算红（防假标注）。
- **推翻条件**：某条路由被确认无人使用超过一个发布周期 → 单独切片删除（先 `grep` 全仓确认）。

---

## D-005 · 重构分阶段 + 人闸门 + 切片可回滚

- **状态**：已定（2026-11-14）
- **背景**：此前"AI 打地鼠"的成因是局部修改在混乱全局里互相制造新症状。
- **决策**：五阶段推进——0 测试网 → 1 隔离死码 → 2 按 feature 收口 → 3 清 shared → 4 UI 回归。每阶段开新上下文、只喂本阶段文档、阶段间人闸门、切片前 commit、跑偏即回退不打补丁。
- **后果**：单次改动变小、可回滚；代价是总周期变长。
- **推翻条件**：若某阶段发现"必须先动另一处才能验"，允许调序，但要在 `PROJECT-STATE` 当天日志写明为什么调。

---

## D-006 · 先建刹车网，再动代码

- **状态**：已执行（2026-11-14，阶段 0）
- **背景**：面板拆改最隐蔽的故障是"页面还在、入口没了"和"后端挂着、前端没调"——都不报错。
- **决策**：先写 `scripts/check-panel-coherence.sh` 钉住三件事（页面清单双向一致 / 有导航登记的页面必须有 href / 零引用路由必须标注），接入 `preflight.sh` 3b，**然后**才开始改面板。
- **后果**：改面板时若把某个入口弄丢，preflight 立刻红。守卫本身做过注入验证（真仓 exit 0 / 注入 exit 1）。
- **推翻条件**：若页面数量降到 3 个以内且导航手工可维护，可降级为人工检查——但要写明"为什么不需要守卫了"。

---

## D-007 · "功能存在"的判据是用户可达，不是代码里有

- **状态**：已定（2026-11-14）
- **背景**：多次出现"README 说有、代码也在、但用户点不到"，被读成"这功能是假的"。
- **决策**：功能状态只有三种——✅ 用户可达 / ⚠️ 有代码但默认关或无入口 / ❌ 未做。**不允许把 ⚠️ 写成 ✅**，也不允许把"代码在"当成"做完了"。
- **后果**：`docs/FEATURES.md` 的状态列必须按此口径填；默认关的能力在门控条上必须可见（见 D-008）。
- **推翻条件**：无。这是对外承诺的底线。

---

## D-008 · 门控必须登记进 `gates.js`，不许只读 env

- **状态**：已定 + 已修（2026-11-14）
- **背景**：`gates.js` 是门控唯一真源，面板门控条靠它决定显示什么。但 `PROXY_CONTEXT_TRACK` 只被 `l2/context-report.js:35` 直接读，**没登记**——于是门控条看不见它，用户界面上开不了，属"隐形门控"。
- **决策**：任何新门控必须同时做两件事：① 在 `gates.js` 登记（`kind` / `source` / 默认值）；② 判定逻辑留在原处不改（注册表只管登记，不接管判定）。
- **后果**：`context-track` 已登记（group 账本主权，kind opt-in，`scope: 'repo'` 因判定落在仓根的 `l2/`）。并加 crossCheck 测试对拍模块自身 `enabled()`——该测试当场抓到第二个 bug：`context-report` 裸比 env（大小写敏感），`'ON'` 判关而注册表判开；已按该文件注释自称的「与 cost-track 同构」改为 `trim().toLowerCase()`。
- **推翻条件**：无。

---

## D-009 · 文档 SSOT 三件套，取代散落文档

- **状态**：已执行（2026-11-14）
- **背景**：`docs/` 顶层 46 项、根目录 11 个 `MEMORY-*.md` 快照，同一事实多处表述且互相矛盾（"前端 4 页"vs 实际 12 页；"管理三个代理"vs 实际 9 个服务）。
- **决策**：三件套为唯一真相源——`ARCHITECTURE.md`（在哪一层）、`FEATURES.md`（有哪些功能/归谁）、`DECISIONS.md`（为什么这么定）。其它文档引用它们，不复制它们。
- **后果**：新文档若与三件套冲突，以三件套为准，并修掉冲突方。
- **推翻条件**：无。若要换载体（如迁到 wiki），需同时给出"如何保证不漂移"的机器判据。

---

## D-010 · 一个数据面只允许一个「详细渲染归属」

- **状态**：已执行（2026-11-14，阶段 2.1 首片）
- **背景**：总览页「账本主权 · 上周节省」卡与成本页「上周账单」卡**调的是同一个 `/api/cost/watchtower?days=7`**，各渲染一遍，连"为什么这样算？· 账本主权"的解释块都抄了两份。两处口径迟早漂移，用户也分不清哪个准。
- **决策**：同一份数据只允许一个面做详细渲染；其它面最多报**一个数 + 一个入口**。
  - 总览 → 只报「上周实际花费」一个数 + 「看成本明细」按钮（跳 `switchPage('cost')`）
  - 成本页 → 余额 / 预算判级 / 上周账单（按 agent·模型归因、省了多少、零花费占比）唯一归属
- **后果**：新增看账卡前必须先答"它属于哪个面"。不许在总览复制明细。
- **推翻条件**：若某面必须离线可读（无 JS 降级），须显式声明并配对拍测试。

---

## D-011 · 面板行为测试必须进闸门，且「不匹配就大声报错」

- **状态**：已执行（2026-11-14）
- **背景**：`multi-proxy-manager/tests/node/` 三个文件（共 29 条断言）**不在任何 CI、也不在 preflight 里**。页面重构后脚手架跟不上，实测长期 `panel-read-failure` 5 条 + `proxy-config-write-safety` 6 条假红，无人知晓。三个真根因：
  1. 页面改用 `window.MPStates`（states.js 空态四件套），沙箱没 stub → `ReferenceError`
  2. 取内联脚本的正则 `/<script\b[^>]*>/` 第一个匹配到 `<script src="./theme.js">`（外链，正文为空）→ `code` 恒为 `''`
  3. `logs.html` 把函数挂在 `window` 上且 IIFE 收尾形态不同 → 导出注入正则不匹配 → `__panel` 为 undefined
- **决策**：
  - ① 行为断言必须同时进 **preflight（3c）** 与 **CI（manager job）** 双入口；
  - ② 脚手架跟不上页面结构时**修脚手架**，并保留"匹配不到就 throw"的判据——**不许降级成 skip**（skip 会让下一个人以为它过了）；
  - ③ 修假红先做**基线对照**（stash 前后跑出同样条数），证明不是自己改出来的；
  - ④ 沙箱要 stub 页面真实依赖（`MPStates`/`addEventListener`），而不是让页面为测试让步。
- **后果**：三个文件 29 条断言全绿；`preflight` 3c 与 CI 同步。
- **推翻条件**：无。

---

## D-012 · 容器无入口即为死码；读失败提示必须写进用户看得见的容器

- **状态**：已执行（2026-11-14，阶段 2.1b+2.1c）
- **背景**：`dashboard.html` 里的 `page-sessions` 容器有内容、被 `loadSessions()` 持续渲染，但**用户永远看不到它**——`SPA_VIEWS` 里没有 `sessions`、侧栏「任务管理」走 `/sessions`（`server.js:229` 发独立页 `sessions.html`）、全仓无 `switchPage('sessions')`。更糟的是读失败提示也写进它（`sessionsListFull`），于是**可见**的那张卡只剩「暂无运行中任务」：读失败被渲染成「没有任务」。当时的测试断言目标正是那个看不见的容器，所以一直绿着——**测试在为假绿背书**。
- **决策**：
  - ① 页面内每个 `.page` 容器必须有四类入口之一：`SPA_VIEWS` 登记 / 硬编码 `data-page` / `switchPage('x')` 跳转 / 默认 `active`。否则视为死码，删掉或补入口。此判据已进 `scripts/check-panel-coherence.sh` 第 4 项，机器判。
  - ② 读失败的提示只能写进**用户当前看得见**的容器；不许写进隐藏/死容器，也不许先渲染空态再改副标题（那会同时出现「所有 Provider 健康」+「读取失败」）。
  - ③ 合并重复渲染时，若两处行为不一致，**取更严的那一侧**（这里是健康页的 `showReadError` + 清副标题），不是取更省事的那一侧。
- **后果**：`page-sessions` 已删（原位留注释说明依据）；`renderProviderIsolation` / `showProviderReadError` 由概览卡与健康页共用；`loadSessions` / `loadProviderHealth` 读失败均指向可见容器。
- **推翻条件**：若将来恢复页内 sessions 视图，须同时补 `SPA_VIEWS` 登记 + tab 入口 + 守卫通过。

---

## D-013 · 跨页共享助手收进 `mp-kernel.js`；去重前先分族，同语义才合并

- **状态**：已执行（2026-11-14，阶段 2.3a）；其中 `showToast` 部分**当日已被 D-014 推翻并执行**（老板拍板视觉统一）
- **背景**：`esc` 在 `public/` 下被抄了 **8 份**（dashboard / context / floor / knowledge / logs / proxy-config / sessions / skills），`showToast` 抄了 6 份，`showReadError` 抄了 2 份，`auth_token` 这个存储键散布在 10 个文件 26 处。抄本本身不致命，致命的是**会分叉**：`esc` 已经分成两族（`textContent+innerHTML` 与正则五替换），输出等价纯属巧合；一旦有人只改其中一份，同一套面板就会对同一段字符串给出两种转义。
- **决策**：
  - ① 抽 `public/mp-kernel.js`，公开面**只放机制**：`esc` / `fetchJSON` / `showReadError` / `getToken`。不放任何一页的业务（不碰 `PROXY_CONFIGS`、不碰页面状态、不碰 `/api` 语义）。
  - ② **去重前先分族**：只有「同一件事的不同写法」可以合并；「不同的事长得像」不许合并。本轮据此**暂缓**了两处——注意「暂缓」不等于「永不合并」，它只是要求先把视觉决定做完（见 D-014）：
     - `showToast`：dashboard / logs / proxy-config 是「右上角 + 图标 + `.toast.<type>`」，knowledge / sessions / skills 是「右下角 + 纯色底 + `.toast-<type>`」，各有本地 CSS 撑着。合并＝改三个页面的观感，属于视觉决定，不混进去重。→ **当日由老板拍板统一，D-014 执行完毕。**
     - `showReadError`：dashboard 那份是 empty-state 族（带图标、含重试按钮），proxy-config 那份是内联 padding 块（无图标）。合并同上，**仍暂缓**。
  - ③ **模块自足优先于去重**：`nav.js` / `states.js` / `gatebar.js` 里的私有 `esc` **保持不动**。它们能被单独加载（`login.html` / `consent.html` / `legal.html` 只引 `nav.js`），依赖 kernel 就多一条隐形前置。
  - ④ `getToken()` **每次现读** `sessionStorage`，不缓存——页内登录/登出会改这个值，缓存一份就是拿过期令牌去请求，然后把 401 显示成「读取失败」。
- **后果**：
  - 8 份 `esc` → 1 份实现 + 8 个别名；`fetchJSON` / `showReadError` 同理（dashboard）。
  - `tests/unit/esc.test.js` 的契约从「每个页面源码里必须含转义策略」改为「页面要么自带实现、要么引用 `MPKernel.esc`，引用者不得再留本地副本」，并新增**真跑 kernel** 的行为用例（`vm` 里加载真文件，断实体逐项正确 + XSS 语料中性化 + `getToken` 不缓存）。
  - 三个 `tests/node/` 沙箱改为**先加载真 `mp-kernel.js`** 再跑页面脚本，而不是塞桩——桩测的是桩。
- **推翻条件**：`showReadError` 若要合并，同样必须先做一次显式的视觉统一（dashboard 的 empty-state 族 vs proxy-config 的内联块），并同步改两页断言。`showToast` 的推翻条件已由 D-014 兑现。

---

## D-014 · toast 视觉合成一套（老板拍板）；同时把版本号收成单一来源

- **状态**：已执行（2026-11-14，阶段 2.3b 前置）
- **背景**：D-013 曾以「合并＝改观感」为由**暂缓** `showToast`。老板当日拍板「统一」与「视觉合成一套」，前提条件消失，于是执行。实查发现不只是「两套」而是**三套**，且其中一套根本没样式：
  | 家族 | 页面 | 类名 | 位置 / 观感 |
  |---|---|---|---|
  | A | dashboard / logs / proxy-config | `.toast <type>` | 右上、白底、左色条；**但 proxy-config 那份没图标、时长 2500** |
  | B | knowledge / sessions / skills | `.toast-<type>`（连字符） | 右下 24px、**纯色底白字**、无图标 |
  | C | settings | `.toast--info` | 右上；**该类名在 CSS 里从未定义**，等于加了类没样式 |
- **决策**：
  - ① 统一到 **A**：它是 `components.css`（设计系统新层）的形态，也是三页在用的形态。位置/配色/图标尺寸**全部由 CSS 决定**，`MPKernel.showToast` 只产出结构（`.toast <type>` > `.toast-icon` + `.toast-msg`），页面**不许**再写自己的 `.toast` CSS。
  - ② `.toast-container` 与 `.toasts` 两个历史容器类名都在 `components.css` 指向同一规则；页面统一用前者。
  - ③ `type` 走**白名单**（success / error / warning，其余落 info）。过去 proxy-config 把 type 直接拼进 className，C 的 `.toast--info` 正是这个路子留下的：类名写上了、样式从没定义、也没人发现。
  - ④ 消息用 `textContent`（不是 innerHTML）：提示内容常含后端错误串。
  - ⑤ 顺手补 `role="status"` + `aria-live="polite"`——读屏用户也该听到「保存失败」。
  - ⑥ **版本号同批收口**（老板同一轮拍板「统一」）：唯一源是仓库根 `VERSION`（经 `/api/version` 下发）。过去 `nav.js buildFooter()` 写死 `v1.0.0`，**九个页面的侧栏常年显示同一个假版本**；设置页「关于」另写死「1.0（v1.0 收尾）」。版本号是判断「要不要升级」的依据，写死等于永远告诉用户「已是最新」。
- **后果**：
  - 6 份 `showToast` + settings 2 份 `toast` 全部改为 `MPKernel.showToast` 的薄包装（保留函数声明 hoist，定义前的调用不会变 undefined）。
  - 三页内联纯色 toast CSS（`.toast-container` bottom / `.toast` / `.toast-success|-error|-info` / `@keyframes slideIn`）删除；`shared-styles.css` 的旧 toast 段标注「别名桥，改这里不生效」。
  - 侧栏版本号归 `nav.js` 的 `fillSidebarVersion()`（页面写进去的值会被下一次 `renderNav` 冲掉，所以取数必须归一处）；读失败显示「版本读取失败」，**不回退任何像样的假值**。
  - 守卫：`check-panel-coherence.sh` 加第 5/6 项——`mp-kernel.js` 的 script 标签必须早于页面内联脚本；`#sidebarVersion` / `#aboutVersion` 里不许出现数字或 `v` 开头。
  - 测试：`tests/node/mp-kernel-toast.test.js`（6 条，真跑 kernel：结构契约 / type 白名单 / HTML 载荷 / 容器缺失 / 淡出移除 / duration）+ `e2e/toast-unified.spec.js`（2 条：右上位置 + 图标 + 浅色底；knowledge 页同样一套）+ `e2e/page-data.spec.js`（3 条版本号：正常路径 / 读失败 / 设置页）。
- **推翻条件**：若要改 toast 观感，改 `components.css` 的 `.toast` 段一次即可；改页面内联 CSS 或 `shared-styles.css` 都不会生效（后者加载在前）。

## D-015 · 类名必须有 CSS 定义；toast 遮挡靠「封堆叠高度 + 不挡点击」而不是留安全区

- **状态**：已执行（2026-11-14）
- **背景**：D-014 收口时登记了两条「看起来是本次引入、但没核实」的现象。当日查清了，结论与登记时的猜测**都不同**：
  - **① 设置页键值行「应用costgate」紧贴**：不是某次改动把间距弄丢了，而是 `.kv / .kv-row / .kv-k / .kv-v` **从首个公开快照 `58a1097` 起就写在 `settings.html` 里，而全站 CSS 从未定义过这四个类**（`git log -S ".kv-row" -- '*.css'` 为空）。所以它不是回归，是「类名写上了、样式从来没有、也没人测过它长什么样」——D-014 里 `.toast--info` 的同一个病。
  - **② toast 遮挡「展开全部」按钮**：1440×900 实测**单条不重叠**（toast 16→80，按钮 y=122），我上一轮在截图里看到的是误判。但**堆到 3 条就完全盖住**（16→164，重叠 111×17，即按钮整块被压住）。
- **决策**：
  - ① `.kv` 系列定义进 `components.css`（不放 `unify.css`：kv 是组件不是页面补丁）。`grid-template-columns: 88px minmax(0,1fr)` + `--sp-4` 间距 + 行间 `border-top`；label 列定宽（中文标签最长 4 字）、值列 `minmax(0,1fr)` 允许断词（`~/.multi-proxy-manager/` 这类长路径不断词会撑破卡片）。
  - ② **不给全站顶部留永久安全区**：那是「为 3 秒浮层让 9 个页面集体空一条」，成本错配。改为两条机械保障：
    - 容器 `pointer-events: none` + 单条 `auto`（D-014 已落）⇒ 被盖住也**点得到**（实测 `elementFromPoint` 命中仍是 `button.gate-bar-toggle`）；
    - `MPKernel.showToast` 加**堆叠上限 3**，超出直接摘最旧的（不播淡出：它正被替代，动画只会让右上角同时晃）⇒ 把最长遮挡高度从「无限增长」封到 3 条。
- **后果**：
  - `settings.html` 「关于」段顺手修正缩进（结构本来就对，是缩进错乱到看不出层级）。
  - 测试：`e2e/page-data.spec.js` 加 1 条**量 computed layout** 的断言（每行标签-值间距 ≥8px、值不溢出），注入 `gap:0` 实测红、恢复转绿；`tests/node/mp-kernel-toast.test.js` 加 1 条堆叠上限（原有「type 白名单」用例按 `children[before]` 取值，上限生效后会取到 `undefined`，改为取「最新那条」——这是测试写法假设了无限增长，不是实现退化）。
  - 原「toast 遮挡」这条从待办移出，改为**已知且接受的行为**：遮挡时长 ≤3 条高度内，且不阻断操作。
- **推翻条件**：若将来出现「需要用户停留 >10s 的带操作错误提示」（如 toast 里放按钮），遮挡就从「短暂浮层」变成「持续挡路」，那时必须改成界面留安全区或换成非覆盖式提示条。

## D-016 · dashboard 视图按「一页一文件」抽离；顺带修 shadow 页的假成功

- **状态**：已执行（2026-11-14，阶段 2.3b 第一片）
- **背景**：`dashboard.html` 已 3.4k 行，7 个页内视图的取数 / 渲染全挤在一个 IIFE 里。改一页要在 2k 行代码里找位置，风险与收益都差。抽离顺序按「最自治的先抽」——shadow 只读一个接口、不写盘、不碰轮询、不被别的视图调用，是验证「一页一文件」最便宜的样本。
- **实查意外**：抽 shadow 时先打开页面看它现在长什么样，发现 **`getAuthHeader()` 从未被定义**——全站统一用的是 `x-auth-token` 头，而这一页写的是「`getAuthHeader()`」。fetch 每次抛 ReferenceError，被 try/catch 吞掉，UI 上只剩「加载失败：getAuthHeader is not defined」一行小字。而 `e2e/spa-views.spec.js` 只断言「切换生效 + 面板文本 > 20 字」，恰好那 19 个字符的报错也 >20，假绿了几个月。这是「控件齐全、点击无声」的下位变体：**点了有反应，但反应是错误提示**。
- **决策**：
  - ① 抽 `public/views/shadow.js`（新目录），暴露 `window.MPViews.shadow.load()`。页面 HTML 骨架留在 `dashboard.html`（静态结构跟页面在一起更好读；抽成 JS 字符串要多一层转义风险、还会首屏空白），只有「行为」被抽走。
  - ② 加载顺序：`<head>` 里 `mp-kernel.js` 之后、`nav.js` 之前（模块依赖 kernel；必须早于页面首个内联 script——否则 IIFE 1.3k 行处调用即崩，这是 2.3a 踩过的坑）。
  - ③ 鉴权头改走 `MPKernel.getToken()` + `x-auth-token`（真源头），而不是一个从未存在的函数名。
  - ④ 加两条 E2E 判据防回归：
     - 6 视图通用：面板文本不允许出现 `加载失败 / is not defined / 读取失败 / Failed to fetch / NetworkError`——这类文案意味着数据没到却静默停在错误提示。
     - shadow 专属 `@tier0 @pr-gate`：必须真出 ≥1 张 `shadow-card`、`#shadowAlert` 的 `display` 必须是 `none`、`#shadowPolicy` 不再停在 `—`。
  - ⑤ 注入验证：把 shadow.js 的 fetch headers 临时改回 `getAuthHeader()`，`#shadowGrid .shadow-card` 一条都出不来，E2E 红；恢复即转绿。
- **后果**：
  - `dashboard.html` 里 `loadShadowPage` 变成 3 行薄包装（`MPViews.shadow.load()`），`switchPage` 分支表不动。
  - 新增 `public/views/shadow.js` 约 80 行；抽离前 `dashboard.html` 里 shadow 相关的 38 行全部删除。
- **推翻条件**：
  - 若「一页一文件」形状不成立（例如发现视图之间共享变量比共享页面多），回到抽 IIFE 内分段。
  - 若 6 视图通用断言里的 `NetworkError / 读取失败` 与某个页面合法的「读失败三态之一」文案冲突，改为按视图分档而不是全视图一刀切。
- **未抽的其它 6 视图**：`today / health / alerts / registry / cost / dashboard(概览)`。下一片先抽 `alerts`（也只读一个接口，最自治）；`today` 有日期选择器联动、`cost` 有 watchtower 轮询、`registry` 有增删改，风险更大，排在后头。

## D-017 · 内联 handler 引用的函数必须挂到 window（13 个坏控件的根因）

- **状态**：已执行（2026-11-14，随 2.3b 第二、三片）
- **背景**：HTML 里 `onclick/onchange/oninput/onkeydown` 在**全局作用域**解析函数名，页面 IIFE 里的局部函数它们看不见。Playwright 逐个真点实测：**13 个被引用的函数从未挂到 window**——告警搜索/两个筛选/刷新、今天页日期选择器/刷新/文件查询、registry 搜索与筛选、成本/watchtower/概览刷新、健康页刷新、健康历史条数下拉（`loadHealthHistory` 引用的函数**从未定义过**）、watchtower 卡「看成本明细」（`switchPage`）、统一入口复制、API key 横幅关闭。症状全部是「控件齐全、点击无声」：按钮渲染出来了，点了抛 ReferenceError。E2E 只点过 tab、没点过这些控件，假绿至今。与 D-016 修的 shadow 假成功同族（下位变体）。
- **决策**：
  - ① IIFE 末尾统一挂载段：所有被静态 HTML 内联 handler 引用的函数 → `window.X = X`（handler 函数由 views/*.js 实现的，由模块以 `global.X` 挂载，页面不再重复挂）。
  - ② `loadHealthHistory` 从未定义：语义是「按 `#healthHistoryLimit` 当前值重拉健康页」。`loadHealthPage` 改为读下拉值取历史条数（fetch limit + slice 共用），`window.loadHealthHistory = loadHealthPage` 别名。
  - ③ 守卫 `tests/node/panel-inline-handlers.test.js`：**纯静态交叉验证**，不跑页面脚本（vm 脚手架对浏览器 API 太脆，炸在半路守卫就失效）——剥掉 `<script>` 块后的静态 HTML 里，内联 handler 引用的每个标识符 ⊆ window 挂载清单（含 views/*.js 的 `global.X` 挂载）；被引用的每个挂载必须有真身（右侧 function 表达式或已声明标识符，防拼错名字挂了 undefined）。注入两式（删挂载 / 挂载拼错）实测红。
  - ④ **提取边界的坑**：动态生成的 onclick 在 JS 字符串里（`onclick=\"...\"` 形态），先剥 `<script>` 块再提取是干净边界；用 lookbehind 拦 `\"` 已被证明不可靠（JS 转义会造出绕过 lookbehind 的形态）。
- **后果**：真浏览器复测三处链路（告警搜索、今天日期下拉、who 查询）零 pageerror；13 个控件从「点击无声」恢复可用。
- **推翻条件**：若未来把内联 handler 全部改为 addEventListener 委托，守卫的提取对象应随之改为「委托选择器清单」；在那之前新增内联 handler 必须同步进挂载段或模块挂载。
