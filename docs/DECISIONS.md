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

## D-018 · 「真浏览器点控件」进 CI，且守卫自己也要被守卫

- **状态**：已执行（2026-11-15，老板批「按建议来」）
- **背景**：`PROJECT-STATE/PANEL-HEALTH-CHECK-2026-11-15.md`（本地资产，不入仓）发现 A——工作区回退把 D-017 的 13 个 window 挂载一起退掉，真点 4 个控件全抛 `ReferenceError`，而 node 37/37、coherence 六项、E2E 50/50 **三套全绿**。追下去是两层缺口，不是一处：
  - ① **运行态缺口**：`spa-views.spec.js` 只点 tab、smoke 只验加载不崩；内联 handler 的异常只在**交互那一刻**发生，加载阶段永远看不见。
  - ② **闸门缺口**：`tests/node/panel-inline-handlers.test.js` 既**从来没进 CI**（`p0-security-gate.yml` 的 panel behavior tests 步骤手写 4 个文件名，不含它），本身还能被随手删掉；删了以后没有任何一道闸会喊。
  - 附带查出一个真洞：D-017 的 ghost 判据写成 `!declared.has(rhs) && !declared.has(n)`，末项让「左侧函数本身有 IIFE 内声明」短路 ⇒ `window.filterRegistry = filterRegistr`（右侧拼错名）静态守卫恒绿。注入实测 E2E 3 条全红而它 `pass 1 / fail 0`。
- **决策**：
  - ① **基线归位**：会话 A 的 7 个前端 WIP 用 `git stash push -m … -- <7 paths>` 留档（`stash@{0}`，可回看），工作区恢复 `HEAD` 已验证的面板前端状态；会话 B 的 18 个后端文件原样不动、零丢失。继续基于「已推送、有守卫」的基线工作，不把更坏且无守卫的回退态当新起点。
  - ② **运行态守卫** `e2e/inline-handlers.spec.js`（3 条 `@tier0 @pr-gate`），控件清单**从静态 HTML 自动派生**（剥 `<script>` 后提 `on*` 属性），不手写，新增控件自动被覆盖：
    - 契约层：每个被引用的名字在真浏览器里 `typeof window[n] === 'function'`；
    - 运行层：逐个真派发对应 DOM 事件（`click` 用 `el.click()`、`change/input` 用 `Event`、`keydown` 用带 `Enter` 的 `KeyboardEvent`），页面内 `addInitScript` 自收 `error` + Playwright `pageerror` 双保险，并断言「清单里每种组合都真的派发过」（防元素没渲染导致静默跳过）；写请求用 route stub 拦掉，避免点一遍控件真写脏数据；
    - 功能层：真手势点健康页刷新 / 历史条数下拉，断言对应 `/api/health-history` 请求真发出且 `limit=20` 生效——抓「函数存在但什么都没干」。
  - ③ **守卫登记表** `tests/node/panel-guard-registry.test.js`：钉住 3 个关键守卫文件存在且仍带判据关键字，并钉住 CI 两个闸门真的会跑到它们（`e2e-tier0.yml` 保留 `--grep "@tier0"` + 新增登记表自检步骤；`p0-security-gate.yml` 必须是 `node --test tests/node/*.test.js` 全量，不许退回手写名单）。**守卫被删 / 被放宽 / 闸被关，都会红**。
  - ④ **CI 拉闸**：p0 的 panel behavior tests 从「手写 4 个文件名」改成全量通配（以后新增 `tests/node/*.test.js` 自动进闸）；tier0 job 在跑 E2E 前先跑一次登记表自检（零依赖，只用 node 内置）。
  - ⑤ **修 D-017 的 ghost 判据**：只看右侧——`rhs !== 'function' && !declared.has(rhs)`；左侧有没有声明与「右边那个名字存不存在」无关。同时抽出 `findGhostMounts()` 并加一条**构造数据自证**（拼错名必红、合法别名必绿），不让「我在真树上跑了一下是绿的」冒充判据有效。
- **后果**：
  - 数字：node **41/41**、coherence 六项、全量 E2E **56/56**、tier0 闸门 **42/42**。
  - 四种注入全部**真红且恢复干净**：A 删 `window.filterRegistry` 挂载 → E2E 契约层 + 运行层 2 红（运行层拿到真的 `Uncaught ReferenceError: filterRegistry is not defined`）；B 挂载名拼错 → 修复前静态守卫假绿、修复后 `not ok 2 / # fail 1` 精确点名；C 删掉 E2E 守卫文件 → 登记表 `rc=1` 点名「守卫被删，回归将无人喊」；D CI 退回手写名单 → 登记表 `rc=1`。
  - 坑：**注释式注入会让静态守卫假绿**（正则仍匹配注释里的 `window.X = X` 文本），注入验证必须用「改值 / 删文件 / 改 CI 步骤」这类让功能真不跑的形态。
- **推翻条件**：若将来把内联 handler 全改为 addEventListener 委托，运行态守卫的「静态 HTML 属性清单」要换成「委托选择器清单」，登记表条目同步更名；若 `tests/node/` 出现必须单独跑（不能并发）的用例，全量通配要改为分组执行，但仍不许退回手写白名单。

## D-019 · 第四片抽 registry；MPShell 归位 head；共享状态层暂不硬迁

- **状态**：已执行（2026-11-15，2.3b 第四片）
- **背景**：D-016 留了推翻条件「一页一文件形状不成立就回到 IIFE 内分段」。继续抽剩余 `health / cost / registry / 概览` 之前先查共享面：`proxyStatus` 20 处引用、`PROXY_CONFIGS` 13 处、`versionCache` 5 处，且 health 写 `proxyStatus`、概览也写；`reasonText / renderProviderIsolation / showProviderReadError` 是概览与 health 共用的渲染件。若为了抽离把这些平铺到 `window`，那不是分层，是把 IIFE 变量全局化。
- **实查意外（真 bug）**：`views/alerts.js` 在 `<head>` 里执行 `var S = global.MPShell;`，而 MPShell 原本挂在 `dashboard.html` 的 IIFE **末尾（约 3108 行）**。模块加载那一刻它永远是 undefined ⇒ 告警页的 `showLoading / hideLoading / hideOfflineBanner` 三处全走 `console.error` 分支，加载条不亮、离线横幅不收。不报错、不白屏、页面照常出数据，只是壳机制静默失效 —— 与 D-016 的 shadow 假成功、D-017 的控件点击无声同族：**看着接好了，其实没接**。
- **决策**：
  - ① **先抽不需要共享状态的那一**：`registry` 只围绕 `/api/registry/agents` + 两个私有状态（`registryAgents / editingAgentId`），不读 `proxyStatus`、不碰轮询、不被别的视图调用。抽到 `views/registry.js`，私有状态留在模块里、不挂 window；页面只留薄包装，`switchPage` 分支表与 HTML 内联 handler 名字不变。⇒ 「一页一文件」形状仍然成立，D-016 不必推翻。
  - ② **MPShell 归位**：新建 `public/mp-shell.js`，在 `<head>` 里 `mp-kernel.js` 之后、**所有 views/\*.js 之前**加载；`dashboard.html` 保留同名薄包装（函数声明 hoist，定义前调用照旧可用，调用点零改动）。真实现只有一份，视图模块只调用不复制。
  - ③ **不建 MPState 全量共享层**：`health / cost / 概览` 的抽离前置是「共享状态单一真源迁移」，本轮不硬迁 20+13+5 处引用，也不为了凑「继续抽」把变量挂到 window。明确登记为下一片的前置，而非假装做完。
  - ④ **脚手架必须同序**：`tests/node/panel-read-failure.test.js` 的 vm 沙箱原本只跑 `mp-kernel.js + views/alerts.js`，还写着「MPShell 在 IIFE 末尾挂载，页面脚本跑完就有了」——抽离后那句话过期，实测 5 条假红（`Cannot read properties of undefined (reading 'showLoading')` + registry 读失败测不到）。改为按 `<head>` 真实顺序加载 6 个**真文件**（kernel → shell → shadow/alerts/today/registry），不塞桩。
  - ⑤ **静态守卫加第 7 项**：`scripts/check-panel-coherence.sh` 钉「每个 `views/*.js` 都接线」＋「`mp-shell.js` 行号 < 每个 views < 首个内联 `<script>`」。🔴 又查出它**此前只在本地 `preflight.sh` 跑、CI 完全没有** ⇒ 同 D-018 的「闸没拉」病，一并接进 `p0-security-gate.yml` 的 shell job，并让守卫登记表反向钉住这一步不再被摘。
  - ⑥ **运行态守卫**：`e2e/spa-views.spec.js` 加 1 条 `@tier0`（stub 两条 Agent → 真出 2 张卡 → 搜探针词剩 1 → 清空恢复 2 → 真点「新增 Agent／取消」弹窗 → 真点卡片里**动态生成**的 `editAgent` 并断言表单 id 被填入）。
- **后果**：`dashboard.html` 3121 → **2937 行**（−184）。真跑：node **41/41**、coherence **七项**、全量 E2E **57/57**、tier0 闸门 **43/43**。
- **注入验证（全部真红 + SHA 校验恢复）**：A 删掉 `views/registry.js` 接线 → coherence **精确 1 项违规** + registry E2E **1 failed**（卡片渲染不出来）；B 把 `mp-shell.js` 挪到 views 之后 → coherence **4 项顺序违规**；C 摘掉 CI 的 coherence 步骤 → 守卫登记表 **rc=1**（点名「不能只留在本地 preflight」）。
- 🔴 **本轮环境坑（写进日志，不写进代码）**：Bash 命令在沙箱外运行、编辑工具在沙箱内，两者对同一文件可能看到不同视图 —— 跨调用做「备份 → 注入 → 恢复」时，`cp` 备份到的是旧视图，恢复会把污染写回去，表现为「`restored=true` 但文件仍是坏的」。解法：把「修复 + 注入 + 跑守卫 + `cp` 恢复 + `shasum` 校验」放进**同一次调用**，以 `git diff` 的视角为准。
- 🔴 **推送前复核补丁（同日，peer review 指出）**：`e2e/inline-handlers.spec.js` 的「页面脚本已跑到底」探针原本等 `window.MPShell`，而 MPShell 正是本轮挪进 `<head>` 的东西 —— 探针会在页面 IIFE 执行**之前**就满足，契约层可能抢在挂载段跑完前取值，造成该红不红。改用 `window.switchPage`（IIFE 末尾才挂）作探针。同批加固 `check-panel-coherence.sh` 第 7 项：行号匹配从「全文件任意位置」收紧到 `^<script`（行首），否则注释里写一句 `<script src=...>` 就能骗过守卫 —— 与 D-018「注释式注入让静态守卫假绿」同族。
- **推翻条件 / 剩余**：若 health/cost 抽离时证明共享状态「只读不写」，可用 getter 而不必做完整 store；若概览页证明它本质就是页面壳而非业务视图，则保留在 `dashboard.html` 并在此登记为「一页一文件」的明确例外。**仍未抽**：`health / cost / 概览`；前置＝共享状态单一真源迁移（20+13+5 处引用逐个改 `MPState.get/set`）+ 三个共享渲染件归位。

## D-020 · 第五片抽 cost；视图模块作用域隔离；复制收口为单一入口

- **状态**：已执行（2026-11-15，2.3b 第五片 + 修 CI 双红）
- **背景**：D-019 把 `health / cost / 概览` 的前置登记为「共享状态单一真源迁移」。先按引用点精确清点，发现 **cost 是自治片**：`loadCostPage / loadWatchtower / loadCostSovereignty` 只依赖 `authToken`（全文只读不写，共 12 处引用，没有一处赋值）、`MPStates`（运行时才用到）与 6 个固定容器 id；不读 `proxyStatus`、不写共享状态、不被别的视图调用。⇒ 不必为了「凑继续抽」先把 38 处共享状态引用改成 store。
- **决策**：
  - ① **抽 cost 到 `public/views/cost.js`**（成本页余额/预算 + 上周账单 + 账本 Hero，含口径注释一起搬）。页面留三个同名薄包装，`switchPage` 分支表、`init()` 调用点、三个静态内联 handler 全部零改动；token 在模块内改用 `MPKernel.getToken()`（等价于原 `authToken` 快照，且不再跨作用域）。`dashboard.html` **2937 → 2716 行（−221）**。
  - ② 🔴 **抽离当场暴露真 bug（作用域类）**：搬走的代码在原 IIFE 里能直接用到 `var fetchJSON = MPKernel.fetchJSON` 这个本地别名；模块里没有那个作用域，裸调即 `ReferenceError`。实测症状极具迷惑性——`/api/balances` 一次都没请求，余额区静静停在**静态骨架**「暂无余额数据」，不白屏、不收错误提示，看起来像「你没有余额」。修法：模块一律显式 `var fetchJSON = K.fetchJSON`，不假设任何页面本地别名存在。新增 `tests/node/panel-view-isolation.test.js` 静态守卫：`PAGE_LOCALS` 名单（fetchJSON / showReadError / showToast / esc / authToken / proxyStatus / PROXY_CONFIGS / versionCache / 加载条三件 / 三个共享渲染件）+ 剥注释与字符串字面量 + 「模块自己声明过就豁免」+ 「每个模块必须真有 global./window. 挂载」。注入两式真红（删别名 → 精确点名 `views/cost.js` 裸用 fetchJSON；塞一个只加载不挂载的模块 → 点名无挂载），`shasum` 校验恢复。
  - ③ 🔴 **CI 双红（`82fde8e`）两个根因，都不是业务逻辑**：
    - **L5 漂移**：`docs/DECISIONS.md` 里把本地资产写成裸文件名 `` `PANEL-HEALTH-CHECK-2026-11-15.md` ``，不带 `PROJECT-STATE/` 前缀 ⇒ 命不中 `drift-ignore.txt` 的 `PROJECT-STATE/*`，干净 checkout 判定「引用文件已删除」。改法不是删引用（本机 agent 需要这个指针），而是**写全路径并标注「本地资产，不入仓」**。验证按纪律做**干净树**：用 `git ls-files` 拼出 943 个已跟踪文件到临时目录（无 `PROJECT-STATE`）再跑 drift-check → ✅ 无漂移。本地绿不算数，这是 D-018 那条「答案取决于树里有什么」的同一判据。
    - **E2E tier0 真点控件**：CI 上 `NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.`。全站 7 处 `navigator.clipboard.writeText(x).then(成功提示)`，**6 处没接拒绝分支** ⇒ 浏览器禁剪贴板时用户点完毫无反应，控制台多一条 unhandled rejection（macOS 本地放行，所以只有 CI 抓得到）。收口为 `MPKernel.copyText(text) → Promise<boolean>`（**永不 reject**，Clipboard API → `execCommand` 兜底 → false），dashboard 两处、logs 三处、proxy-config 一处（顺手删掉「execCommand 返回值被 try/catch 吞掉、失败也弹已复制」的 `fallbackCopy`）全改按 true/false 分别提示；`login.html` 刻意不加载 kernel，自带两参数 `then` 兜底。新增 `tests/node/panel-copy-feedback.test.js`（`writeText` 只许出现在 kernel 与登记过的 login 例外）+ `e2e/copy-feedback.spec.js`（强制 `writeText` reject **且** `execCommand` 返回 false，真点复制按钮 → 必须出现 error toast、必须带出 URL、必须零 pageerror）。
- **注入验证（全部真红 + SHA 校验恢复）**：① 删 `views/cost.js` 的 `fetchJSON` 别名 → 隔离守卫 rc=1 并点名；② 塞无挂载模块 → 第二条断言 rc=1；③ 把 `copyUnifiedIngressUrl` 退回「只接成功分支」→ copy E2E 失败于「复制被拒时必须弹错误提示」；④ 干净树 drift-check ✅（本地树同时 ✅，两者一致）。
- **后果**：真跑 node **46/46**、coherence **七项**、全量 E2E **59/59**、tier0 闸门 **45/45**；`dashboard.html` **2716 行**。
- **配套断言更新（推 `b8723bd` 后 CI 抓到）**：`tests/unit/frontend/logs.test.js` 原来断言页面里存在字符串 `clipboard.writeText`——契约变了之后这条必然红（`manager full suite`）。不是放宽，而是升级为更硬的判据：走 `MPKernel.copyText`、页面不许再直接调 `navigator.clipboard.writeText(`、三处复制必须各有失败提示。`login.test.js` 同步加「必须带拒绝回调 + 必须有可见失败反馈」。🔴 踩坑：Jest 的 `expect` **只接受一个参数**，照 Playwright 习惯写 `expect(v, '说明')` 会直接报 `Expect takes at most one argument`（两条用例同一个错，第二次才发现）。
- 🔴 **本地全量的读法**：本机除工作树外还有并行会话未提交的后端 WIP（`server.js` +5 行等），实测它会让 `tests/unit/api.test.js` 的回环免鉴权两条恒红（401 而非 404）。判据按既有纪律：**单跑仍红 ≠ 我引入**——该套件与本次改动零引用，且 CI（干净 checkout）上同一提交的 `manager` job 里这两条是绿的。基线读数须以「CI 视角」为准，本地红项要能逐条归因到具体 WIP。
- **推翻条件 / 剩余**：`health` 与 `概览` 仍未抽——前置不变（`proxyStatus` 读写 + `PROXY_CONFIGS` 只读 + `reasonText / renderProviderIsolation / showProviderReadError` 三个共享渲染件）。若抽 health 时证明这些是「只读 + 一个写点」，可先用窄接口注入（把 renderer 归位到一个 shared 模块），不必做全量 `MPState` store；概览若证明它本质是页面壳而非业务视图，就地登记为例外，不再硬抽。

## D-021 · 第六片抽 health；落共享层 mp-shared.js；修「延迟/运行时间恒为 —」

- **状态**：已执行（2026-11-15，2.3b 第六片）
- **背景**：D-020 把 health 的前置登记为「共享状态迁移」，并写明「若证明是只读 + 一个写点，可先用窄接口注入，不必做全量 store」。按引用点清点：
  - `proxyStatus`：1 个声明 + 1 个写点（`loadHealthPage` 里的 `proxyStatus = statusResult.proxies`）+ 概览渲染 / `toggleProxy` / `loadStatus` 若干读点；
  - `PROXY_CONFIGS`：全页 13 处引用，唯一写点 `fetchProxyConfigs`；
  - 共享渲染件 3 个：`reasonText`（health + onboard 步骤条）、`renderProviderIsolation` / `showProviderReadError`（概览卡 + health）。
  ⇒ 结论：**不必做 store**，但要有一个「只读仓 + 纯渲染」的共享层，否则 health 只能继续贴在页面 IIFE 上。
- **决策**：
  - ① **新建 `public/mp-shared.js`**：`setProxyConfigs`（唯一写入口）/ `get` / `proxyConfigNames` + `reasonText` + `latencyText` / `uptimeText` + `renderProviderIsolation` / `showProviderReadError`。定位写清楚：**只读仓 + 纯函数渲染，无轮询、无副作用、无订阅**。页面 `fetchProxyConfigs` 只负责「拼一次 + 写一次」，页面不再持第二份可写副本。
  - ② **新建 `public/views/health.js`**（`MPViews.health.load`，另挂 `window.loadHealthPage` / `loadHealthHistory`）：三路取数、统计、代理健康列表、Provider 隔离、健康历史整体搬走，口径注释一并搬。`dashboard.html` **2719 → 2535 行（−184）**。
  - ③ 🔴 **一处有意行为差异**：旧 `loadHealthPage` 会把 `/api/status` 写回页面 `proxyStatus`。模块改为私有 `healthStatus`，不再写页面状态。理由：页面 `proxyStatus` 只在 `loadStatus()` / `toggleProxy()` 被消费并重渲染，切回总览并不重画代理卡 —— 那次写回既不影响界面，又让「卡片显示的旧状态」和「按钮判断用的新状态」来自两份快照（文案与实际动作可能相反）。现在两者都只来自 `loadStatus()`。
  - ④ 🔴 **抽离当场抓到一个存在已久的口径 bug**：`/api/status` 实际给的是 `health.latencyMs` 与 `rawHealth.uptime`，而概览卡与健康页都读 `health.latency` / `status.uptime` ⇒ **「延迟」「运行时间」两列从来都是 `—`**，看起来像「探不到数据」。这不是本次引入，但属于本仓最忌讳的那类（把「字段名读错」显示成「没有数据」）。修法：归一逻辑收到 `MPShared.latencyText / uptimeText`（老字段优先、新字段兜底、都没有才留空），概览卡与健康页共用一份。E2E 断言 `12ms` 与 `3720s → 1h2m`。
  - ⑤ 🔴 **消除重复挂载**：页面末尾原本还挂着 `window.loadHealthPage / window.loadHealthHistory`（D-017 时期补的），与本片模块挂载重名。同名两处挂载 = 又一份「谁是活的」的歧义，而且会让「模块忘了挂」被页面那份静默掩盖 —— **注入验证时实测踩到**（摘掉模块挂载后两层守卫全绿）。改为视图模块独占，页面不再重复。
  - ⑥ **coherence 第 7 项扩展**：新增 `mp-shared.js` 的存在性与顺序判据（必须在 `mp-kernel.js` 之后、所有 `views/*.js` 之前）。理由同 D-019：`views/health.js` 在加载那一刻就取 `global.MPShared`，晚一步即模块整体不加载 —— 而页面不会白屏、tab 照常切换，只在健康页留下一句「正在加载健康状态...」。
  - ⑦ **守卫登记表补两条**：`e2e/spa-views.spec.js`（健康用例的关键字）与「coherence 里必须仍含 mp-shared 判据」，防新增的守卫本身被悄悄删除。
- **注入验证（全部真红 + sha256 校验恢复）**：
  - A 把 `views/health.js` 提到 `mp-shared.js` 之前 → coherence `rc=1`，精确报「在第 21 行，早于 mp-shared.js 第 22 行」；健康 E2E 红于「健康数应为 1」（模块没加载，页停在加载态）。
  - B 摘掉模块的 `global.loadHealthHistory` 挂载 → 静态守卫 `rc=1` 点名 `loadHealthHistory`；E2E 红于「下拉改 20 条应带 limit=20 重新请求」。
  - C 把延迟退回读 `health.latency` → E2E 红于「延迟列应读 latencyMs」。
- **后果**：真跑 node **46/46**、coherence **七项**、全量 E2E **60/60**、tier0 闸门 **46/46**；`dashboard.html` **2535 行**（本片净 −184，含新增注释）。
- **推翻条件 / 剩余**：概览（`updateDashboardDisplay` / `renderProxyCards` / `toggleProxy` / `loadStatus` / onboard）仍未抽。它读写 `proxyStatus` 且是页面首屏与轮询宿主，**倾向判定为「页面壳」而非业务视图**；若要抽，先证明轮询与首屏渲染可以整体迁移，否则就地登记为例外，不再硬抽。

### D-021 复核补丁（独立只读 peer review 后，2026-11-15）

复核按 §5.7 判据逐条过：热路径 4 文件 0 改动 ✅、无夹带并行 WIP ✅、46/46 node + coherence ✅。结论原本是**不建议推**，因为抓到一个本提交**新引入**的假数据风险。逐项处理：

- 🔴 **①（阻塞）hermes 的 `uptime` 是 epoch 秒**：`hermes-proxy/proxy.py` 的 `/health` 填的是 `time.time()`，不是进程运行秒数（实测 codex 是 `process.uptime()`=合理秒数，hermes 若是 epoch 就会被我的 `uptimeText` 渲染成「20772d」级荒谬时长）。这等于把「恒为 —」换成一个**看起来像真的假数字**，比原来更糟。修法：`uptimeText` 加 `sec >= 1e9` 判据（1e9 秒 ≈ 31.7 年，任何真实 uptime 都到不了）→ 留空，并在注释里写明这是上游 bug、本函数只负责不把它当真相展示。E2E stub 里加入 hermes 的真实形态（`rawHealth.uptime: 1763200000`），**按行**断言运行时间格必须为 `-`。注入「删掉 1e9 判据」→ 真红。
  - 🔴 **这里还踩了自己一个坑**：第一版断言写死 `not.toContainText('20772d')`，注入验证时**假绿**（换个数就是 20407d）。断言太具体 = 只测了一个样本。改成按行取最后一格后注入才真红。
- **② 读失败时统计卡写 0**（旧有行为，本片搬动后仍在）：列表写着「读取失败」，上面四张卡显示 0，读起来像「测过了，都没有」。改为读失败显示 `—`（status 失败三张、history 失败一张）。新增 `@tier0` 用例「读失败时统计卡显示 — 而不是 0」；注入「退回写 0」真红。
- **③ 两处未转义**：`config.name` 与 `hText`（`reasonText` 会回显后端原因码）进 `innerHTML` 前补 `esc`。`config.icon` 是 icons.js 提供的 SVG 标记，**不能**转义（转义会把图标变成文本），保持原样并注明。
- **④ 守卫自证可被注释满足**：登记表原先断言「coherence 文本里出现 mp-shared.js / MPShared」，一句注释就能满足。改为断言**实现行**（`shared_line=$(grep`、`vline" -lt "$shared_line`）；E2E 登记锚点改成 `waitForFunction` 的实参 `window.MPShared.proxyConfigNames().length > 0`。
- **⑤ 顺手**：删掉重复的 `waitForFunction`（同一段被写了两遍）；不可达代理不再显示探测耗时（连接失败时 `latencyMs` 也会被赋值，把「连接消耗」当「代理延迟」是另一类假数据）。
- **复核后真跑**：node **46/46**、coherence **七项**、全量 E2E **61/61**、tier0 **47/47**。新增注入两式（删 epoch 判据 / 退回写 0）均真红并 sha256 恢复。

- **⑥ CI 首跑红（本提交的第二次「本地绿 ≠ CI 绿」）**：`tests/unit/frontend/dashboard.test.js` 的「Health Page 诊断文案语义」四条原本直接 `readHtml('dashboard.html')` 并在页面里切片 `function reasonText(` → `function loadHealthPage(`。代码搬走后：切片的 end 标记落到 start 之前（`end > start` 断言失败）、调用点正则与「bash manage.sh start all」也都不在页面里了。**这不是功能坏了，是脚手架没跟**。改法：断言对象改成 `mp-shared.js`（reasonText 本体）+ `views/health.js`（调用点与「全都没跑」提示），判定语义一字未改。真跑 `dashboard.test.js` **39/39**。
  - 本地全量 jest 另有 3 个套件红（`loopback-auth` / `api` / `forward-egress-e2e`，共 10 条），全部指向并行会话未提交的 `server.js` / `lib/forward.js` / `l2/*` 改动；同一批用例在 CI 干净 checkout 上是通过的。**本地红必须逐条归因，不能一句「并发假红」带过**。

## D-022 · 第七片抽概览；搬走「状态持有者」，页面不再持第二份快照

- **状态**：已执行（2026-11-15，2.3b 第七片）
- **背景**：D-019 把「概览」的前置登记为「共享状态单一真源迁移（`proxyStatus` 20+ 处、`PROXY_CONFIGS` 13 处、`versionCache` 5 处）」，D-021 末尾又登记「概览倾向判为页面壳；若要抽，先证明轮询与首屏渲染可以整体迁移，否则就地登记为例外」。本片就是那次证明。
- **清点（决定「搬持有者」而不是「造 store」）**：前六片搬完后 `proxyStatus` 只剩 4 个读点（概览卡 / 侧栏代理勋章 / 启停判断 / 轮询写回），`versionCache` 只在 `loadVersion` / 启停 / 概览渲染之间流动，**没有第三个消费者**。⇒ 不需要 `MPState` 全局 store，需要的是把**持有者**搬走：状态跟着它唯一的消费者走。
- **决策**：
  - ① **新建 `public/views/overview.js`**（`MPViews.overview`），整块迁入：首屏统计 / 代理卡 / 侧栏代理项 / 状态翻转强调 / 版本明细卡 / `/api/status` 轮询 / `/api/version` / 端口冲突检测 / 启停按钮，以及私有 `proxyStatus` `versionCache` `prevStatusSnapshot` `pendingProxyNavEntries`。`dashboard.html` **2535 → 2256 行（−279）**。
  - ② **页面只留三个同名薄包装**（`loadStatus` / `loadVersion` / `checkProxyConflicts`）：`init()`、自动刷新、`BroadcastChannel` 跨页同步、`MPStates.registerRetry` 重试回调都还按名字调用它们。侧栏 `renderDynamicProxyNav` 改为**只经 `MPViews.overview.status(name)`** 读勋章；State 段的 `var proxyStatus` / `var versionCache` 与「Loading Bar」两个薄包装一并删除（后两者随 `loadStatus`/`loadVersion` 搬走后已是死码）。
  - ③ **`window.toggleProxy` 由模块挂载**：概览卡的 `onclick="toggleProxy('x')"` 是拼进 `innerHTML` 的动态属性，静态 HTML 里搜不到，`panel-inline-handlers` 守卫也只看静态属性 —— 生成处必须自己挂（D-017）。
  - ④ **新增 `tests/node/panel-overview-ownership.test.js`（4 条）**：页面不许再声明 `proxyStatus`/`versionCache`、不许再按下标裸读；模块必须真持有两者 + 暴露 `MPViews.overview` + 挂 `window.toggleProxy`；页面三个薄包装必须还在。并登记进守卫登记表（关键字带转义反斜杠，散文满足不了）。
  - ⑤ **新增 E2E `@tier0`「总览首屏」**：这一屏此前**零运行态断言** —— `spa-views.spec.js` 的子视图清单里没有「概览」（它是硬编码 tab），smoke 只验「页面不崩」。于是「接线丢了 / 状态为空 / 模块没挂」三种坏法全都表现成一句「暂无代理，请先安装代理程序」，读起来像「你什么都没装」（本仓最忌讳的「把没读到显示成没有」）。新用例钉：卡片按 `/api/status` 出（含「故障熔断」、`12ms`、`1h2m`）、统计 `1/2`、版本卡取 `/api/version`（管理器 + 子包两条）、**点「启动」真 POST `/api/start/claude` 且按钮翻成「停止」**（证明状态在视图里被重渲染，若页面留着第二份快照这里会停在「启动」）、侧栏徽章 `ON`、概览 tab 可达。
  - ⑥ **`panel-view-isolation` 的 `PAGE_LOCALS` 补 `showDemoBanner` / `hideDemoBanner`**：本轮自己撞上了 —— 模块里裸调 `hideDemoBanner()`（页面有同名函数），而它位于 `/api/status` 成功分支，页面照常出数据、只是演示横幅不收。名单是这类「同名不同作用域」唯一能被静态抓住的地方。
  - ⑦ **`tests/unit/frontend/dashboard.test.js` 四条断言改判 `views/overview.js`**（卡片有启停按钮 / 动作只可能是 `start`/`stop` / `fault` 有独立文案）。不是放宽判据，是断言对象跟着代码搬（D-021 复核同族：切片的 end 标记漂移会让断言悄悄失效）。
- **注入验证（四式全真红 + sha256 逐字节恢复）**：
  - A 摘掉 `views/overview.js` 接线 → coherence `rc=1` 精确点名 + 总览 E2E 红（卡片出不来）。
  - B 摘掉 `global.toggleProxy = toggle` → 归属守卫 `rc=1` + E2E 红（点按钮无请求）。
  - C 页面重新长出 `var proxyStatus = {}` → 归属守卫 `rc=1`。
  - D 页面改回裸读 `proxyStatus[name]` → 归属守卫 `rc=1`（两条：下标裸读 + 少了 `status()` 读取口）。
  - 🔴 **C 式第一版是假绿，且是守卫自己的缺陷**：第一版用整段正则剥 `/* ... */`，页面里某个不平衡的 `/*`（字符串/样式里）把后半页 JS 整段吞掉（实测 89k → 49k），于是「页面不许声明 `proxyStatus`」在**真注入之后仍然通过** —— 拿「文件变小了」当证据。改为**按行过滤**（只丢纯注释行，无跨行状态），重跑真红。这条与 D-018「注释式注入让守卫假绿」同族，方向相反：一个是被注释满足，一个是被注释吃掉。
- **后果**：真跑 node **50/50**、coherence **七项**、jest 前端 **320/320**、全量 E2E **62/62**、tier0 闸门 **48/48**；`dashboard.html` **2256 行**。
- 🔴 **本轮环境读数（不改代码，只记判据）**：全量 E2E 首跑 1 failed（`/sessions` 会话列表停在「加载中」），单跑该 spec **9/9 绿**、复跑全量 **62/62** ⇒ 四 worker 共用一个 manager 的并发抖动，与该用例零引用（`sessions.html` + `/api/sessions`）。按纪律逐条归因后才算「不是本改动引入」。
- **推翻条件 / 剩余**：剩下的都属**页面壳**本身（鉴权 / 横幅 / 自动刷新间隔 / 暗色 / 侧栏动态导航 / onboarding / 会话列表）。概览不再是「一页一文件」的例外 —— 事实是它也能抽，前提是把状态一起搬。若后续抽 onboarding / sessions，按同一判据先清点读点：**读点多且只有本视图用 ⇒ 搬持有者；读点分散 ⇒ 先落只读仓（mp-shared 那层），都不必造全局 store**。

## D-023 · 第八片抽首屏 onboarding；顺手把「接入 URL」收成一份真源

- **状态**：已执行（2026-11-15，2.3b 第八片）
- **背景**：前七片把页内视图基本搬空后，`dashboard.html` 剩下的可搬块只剩首屏 onboarding（约 180 行）与会话列表。onboarding 只读两个接口（`/api/readyz` 主信号、`/api/cost/watchtower` 次信号 best-effort）和六个固定容器 id，不读 `proxyStatus`、不写共享状态、不被别的视图调用 —— 与 registry / cost 同形的自治片。
- **决策**：
  - ① **新建 `public/views/onboarding.js`**（`MPViews.onboarding.{ load, copyUnifiedUrl, statusLine, unifiedUrl }`），整块迁入三态判定（加载 / 下一步 / 读失败→重试）、三步黄金路径、一次性关闭。`dashboard.html` **2256 → 2075 行（−181）**。
  - ② **页面只留两个同名薄包装**（`loadOnboarding` / `copyUnifiedIngressUrl`）：`init()` 的调用点、静态内联 `onclick="copyUnifiedIngressUrl()"`、`showReadError` 的重试回调都还按名字调它们。模块不重复挂 `window.*`（同名两处挂载 = 又一份「谁是活的」的歧义，D-021④ 的教训）。
  - ③ **接入 URL 收成一份字面量**（本片唯一的真问题，不是搬代码顺手美化）：原来复制目标写在页面 IIFE（`var url = 'http://127.0.0.1:18880/v1'`），而 Hero 卡的可见文本是 HTML 里手写的同一串 —— 改端口必然只改一处，用户看到 A、复制出去 B。现在真源是模块的 `UNIFIED_URL`，`load()` 把 `#unifiedIngressUrl` 的文本同步过去（幂等）；HTML 里那份降级成首屏占位并注明。
  - ④ **「3 分钟跑通」CTA 统一走 `MPKernel.copyText`**：原代码先判 `navigator.clipboard` 是否存在，没有就只提示命令、不尝试复制；而 `copyText` 自带 `execCommand` 兜底且永不 reject。两套复制口径并存的直接后果是「同样点复制，一处会兜底、一处不会」。
  - ⑤ **新增 `tests/node/panel-onboarding-ownership.test.js`（4 条）**：页面不许再声明关闭状态 / 三步判定；模块必须真持有 `DISMISS_KEY` 与两个判定函数并暴露公开面；两个薄包装必须还在且真转发；**接入 URL 字面量只许在模块里出现 1 次、页面内联脚本 0 次**。已登记进守卫登记表（关键字用判据正则里的转义形态，散文满足不了）。
  - ⑥ **新增 E2E `@tier0` 三条**（这张卡此前零运行态断言，E2E 只碰过统一入口卡上的复制按钮）：
    - 全没跑：明说「不是故障」+ 带「连接被拒」+ 处置命令；三步里第 2 步必须是 `onboard-step-active`（不是第 1/3 步）；可见 URL == `unifiedUrl` 且点复制真写进剪贴板；点「不再提示」→ 整卡隐藏 + `localStorage` 落值 + **刷新后仍隐藏**（读 `style.display`，因为卡片在非活动页时 `toBeHidden` 恒真，判断不出真关掉）。
    - 已跑通：收成一行「已跑通 12 笔」、三步整段消失、`#onboardingDismiss` 隐藏、点「查看账本」真切到成本页（走页面壳公开面 `switchPage`）。
    - 读失败：明说「读不到」+ 带后端原因 + 「读不到 ≠ 没有代理」+ 不假报「已跑通」+ 整卡不隐藏；**点重试必须再请求一次 `/api/readyz`**（防死按钮）。
  - ⑦ `panel-read-failure` 沙箱按 head 真实顺序加载 `views/onboarding.js`：三条 onboarding 用例走页面薄包装，不加载模块就只测到 `console.error` 分支（旧版会「读失败但 body 空」假绿）。
- **注入验证（五式全真红 + sha256 逐字节恢复）**：
  - A 摘掉 `views/onboarding.js` 接线 → coherence `rc=1` 精确点名 + E2E 红。
  - B `loadOnboarding` 薄包装不再转发（`if (false && …)`）→ E2E 红（卡片停在加载态）。
  - C 页面重新长出 `var ONBOARD_DISMISS` → 归属守卫红（1 条）。
  - D 模块里 `var current = total === 0 ? 0 : (running === 0 ? 1 : 2)` 改成 `var current = 2` → E2E 红（证明三步断言验的是判定，不是文案存在）。
  - E 页面回流一份 `var url = 'http://127.0.0.1:18880/v1'` → 归属守卫红（字面量计数）。
- **后果**：真跑 node **54/54**、coherence **七项**、jest 前端 **320/320**、全量 E2E **65/65**、tier0 闸门 **51/51**；`dashboard.html` **2075 行**（2.3b 起点 3121）。
- **推翻条件 / 剩余**：最后一块自治片是「会话列表 + `loadProviderHealth`」。页面壳本身（鉴权 / 横幅 / 自动刷新调度 / 暗色 / 侧栏动态导航）不是视图，抽了只多一层跳转 —— 要动先改 `switchPage` 分支表与刷新调度，属于行为改动，应单独一片并单独拍板。

## D-024 · 第九片抽概览次级卡（运行中任务 + Provider 隔离）；顺手删掉两个转发死码

- **状态**：已执行（2026-11-15，2.3b 第九片，2.3b 视图抽离到此收口）
- **背景**：D-023 末尾把「会话列表 + `loadProviderHealth`」登记为最后一块自治片。清点后确认：两张卡各只读一个接口（`/api/sessions/running`、`/api/provider-health`）、各只写一个容器（`#sessionsList`、`#phList`）、不读 `proxyStatus`、不被别的视图调用 —— 与 registry / onboarding 同形。区别在于会话卡多一个**写操作**（中止），而 Provider 隔离卡的渲染与读失败写法本来就在 `mp-shared.js`（2026-11-14 合并两处逐字重复的 HTML 后归位）。
- **决策**：
  - ① **新建 `public/views/sessions.js`**（`MPViews.sessions.{ load, abort, render }`）：取数 / 渲染 / 中止整块迁入。三条口径随实现一起搬（读失败 ≠ 没有任务、提示必须写进可见容器、中止必须有回执），页面不再留任何副本。
  - ② **新建 `public/views/provider-health.js`**（`MPViews.providerHealth.load`）：本模块只有 20 行有效代码，存在的意义是**不许绕过 mp-shared**。渲染与读失败的唯一真源仍在 mp-shared.js，模块只负责「别自己拼一份 HTML」。
  - ③ **删掉页面两个纯转发别名**（`renderProviderIsolation` / `showProviderReadError`）：它们是 `return MPShared.X(...)` 的一行壳，`loadProviderHealth` 搬走后没有任何调用者。死码的坏处不是占地方，是下一个人误以为「文案还能在这里改」——全仓现在只剩「模块 → MPShared」一条路径。
  - ④ **两个不编数的细节**（同族：uptime 把 epoch 秒渲染成 `20772d`）：
    - `createdAt` 缺失或不是日期 ⇒ 年龄渲染 `—`，不再出 `NaNs`；
    - 状态文案只认后端真有的四种（`running/done/failed/aborted`，见 `lib/session-store.js` 的 `SESSION_STATUSES`），其余**原样出状态串**，删掉旧代码给非 running 编的「待处理」（后端没这个状态；照旧写法，一个 `failed` 会被显示成「待处理」）。
  - ⑤ **`window.abortSessionFromDashboard` 由模块挂**：卡片的 `onclick="abortSessionFromDashboard('id')"` 是动态拼进 `innerHTML` 的，静态 HTML 里搜不到（`panel-inline-handlers` 只看静态属性）⇒ 生成处必须自己挂（D-017）。页面**不许**再挂第二次（同名两处挂载 = 又一份「谁是活的」，D-021④）。
  - ⑥ **页面只留两个同名薄包装**（`loadSessions` / `loadProviderHealth`）：`init()`、`applyRefreshInterval`、`BroadcastChannel` 跨页同步、中止后的刷新都还按名字调用它们。
  - ⑦ **新增 `tests/node/panel-sessions-ownership.test.js`（6 条）**：页面内联脚本不许再出现两个接口字面量（取数回流 = 两个请求点，谁后返回谁赢）；页面不许再声明 `renderSessionsList` / 两个转发别名，不许给 `window.abortSessionFromDashboard` 赋值；两个薄包装必须还在且真转发；模块必须挂 `window.abortSessionFromDashboard` 且不许出现「待处理」；provider-health 模块必须走 `MPShared` 两个函数且不许出现隔离卡的 HTML 文案。已登记进守卫登记表。
  - ⑧ **新增 E2E `@tier0` 三条**（这两张卡此前**零运行态断言**）：
    - 运行中任务：真按 `/api/sessions/running` 出数（标题 / 代理 / 运行中 / `2 步` / `⏱ \d+m\d+s` / 不出 `NaN`）→ 点「中止」必须真 `POST /api/sessions/sess-probe-1/abort`（断言只取 pathname，不写死端口）→ 成功后**重新取数**（第二次返回空 ⇒ 回到空态）。只弹 toast 不刷新就是「假成功」，这条专门钉它。
    - 会话读失败：明说「读取失败」+ 带后端原因 + 「不代表没有任务在跑」+ **不许**留「暂无运行中任务」；同时另一路（隔离卡）照常出结果，证明「一路挂 ≠ 全页空白」；点重试真再请求一次。
    - 隔离卡：两条隔离记录按 `verdict` 给「全网故障 / 单 Proxy 抖动」+ 失败次数 + 来源；`isolateEnabled` 两种取值副标题跟着变（写死 observe 会露馅）；读失败时**副标题必须被清成「—」**且卡体不许出现「所有 Provider 健康」（两条铁律一起验）。
- **注入验证（六式全真红 + sha256 逐字节恢复）**：A 摘 `views/sessions.js` 接线 → coherence 点名 + 会话读失败 E2E 红；B 摘 `views/provider-health.js` 接线 → coherence + 隔离卡 E2E 红；C 摘 `global.abortSessionFromDashboard` → 归属守卫 + 中止 E2E 红（点按钮无请求）；D 页面重新长出 `renderSessionsList` 并直接 `fetchJSON('/api/sessions/running')` → 归属守卫红（2 条）；E 页面重新长出 `/api/provider-health` 取数 → 归属守卫红；F 隔离卡模块自己拼一份 HTML（第二真源复活）→ 归属守卫红。
- 🔴 **本轮踩到自己身上的一类假绿：判定器取错退出码**。第一版注入脚本用 `cmd 2>&1 | tail` 判红绿，没有 `set -o pipefail` ⇒ 退出码永远是 `tail` 的 0，六式全部打印 `GREEN!!`，而同一行输出里明明写着 `1 failed`。这与 D-018（注释满足守卫）、D-022（注释吞掉守卫）同族但**方向不同**：前两种坏在被测物，这一种坏在**判据的执行方式**。修法是 `set -o pipefail;` + 只以被测命令自己的退出码为准。凡「跑个命令看它红不红」的验证，都得先问一句：这个退出码是谁的。
- 🔴 **另一个反方向的细节**：「不许出现 `待处理`」这条判据第一版用 `includes`，结果被**文件头部的说明文字**触发（那段话用「」提到了这个词，而模块注释的续行没有 `*` 前缀，按行剥注释剥不掉）⇒ 守卫把散文当代码。改成只认带引号的 JS 字符串形态（`/['"]待处理['"]/`）。D-018 是「散文满足判据」，这次是「散文弄红判据」，两边都得防。
- **后果**：真跑 node **59/59**、coherence **七项**、jest 前端 **320/320**、全量 E2E **68/68**、tier0 闸门 **54/54**；`dashboard.html` **2076 → 2007 行**（2.3b 起点 3121，累计 −1114），`views/` 下 10 个模块。
- **2.3b 到此收口**：页内所有「数据视图」都已是独立模块，页面只剩**壳**——鉴权 / 横幅 / 自动刷新调度 / 暗色 / 侧栏动态导航 / SPA 分支表。壳不是视图：抽它只多一层跳转，且要动 `switchPage` 分支表与刷新调度，属行为改动，须单独一片并单独拍板。

## D-025 · 自动刷新调度收成一处；「开关亮着就必须真在刷」

- **状态**：已执行（2026-11-15，2.3b 收口后第一片「壳」）
- **背景**：D-024 把 2.3b 的视图抽离收口后，页面只剩壳。评估三条路（① 刷新调度单一真源 ② `switchPage` 分支表 + 刷新策略 ③ 回到 B 组 service-provider）时，先清点了刷新这一块，发现它不是「两处各存一份间隔」这种无害重复，而是**一个会让功能静默死掉的 bug**。
- **实测到的三个坏法**（都不是读代码推的，是 E2E 真跑出来的）：
  - ① **点一次别的 tab 再回来，自动刷新永久死掉**。`switchPage` 里有 `if (pageId !== 'dashboard') clearInterval(...)`，但全仓没有任何地方在回到概览/今天时重建它。开关还画着 ON，屏幕上的数字只是停住不动 —— 正是 tick 那句注释自己最怕的「让人以为记账停了」。E2E 断言 `window.__statusInterval` 为真时直接红。
  - ② **「关掉」记不住**。两种关闭方式行为不一致：把间隔选成「关闭」会落盘（间隔 0），拨开关关掉不落盘 ⇒ 刷新页面自动刷新又自己回来，用户刚说的话被覆盖。
  - ③ **存进去的间隔不在选项里 ⇒ 自我请求风暴**。`select.value = '45'` 无匹配选项 ⇒ `value` 变空串 ⇒ `parseInt('') = NaN` ⇒ `setInterval(fn, NaN)` 的延迟被当成 0。**实测 1.5 秒打了 212 次 `/api/status`**。触发路径不需要用户手改存储：旧版本写过别的档位、或以后删掉某一档（5/10/30/60 是界面选项，会变），老用户的值就变非法。
- **决策**：
  - ① **状态**只有两个键：`autoRefreshInterval`（间隔）+ `autoRefreshEnabled`（开关），都在 localStorage；「间隔 0」与「开关关」是同一条状态的两种表示（选「关闭」档 = 关，拨开关 = 关）。
  - ② **调度**只有 `applyRefreshInterval(patch)` 一个出口：读状态 → 归一 → 拨控件 → 清旧定时器 → 按需建新定时器。调用方只传「用户改了什么」，不许自己算状态。
  - ③ **刷哪一屏**只有 `refreshTick()` 一处判断（看 `.page.active`）：集中在概览就刷状态/会话/隔离卡，在今天就刷今天，其它页**一个请求都不发**。`switchPage` 不再碰定时器 —— 它只管切页与该页首屏取数。
  - ④ **合法档位从 `select.options` 动态读**，不写死 `[5,10,30,60]`：写死会在下次改选项时悄悄过期，正是 ③ 那支风暴的入口。读不到选项时回落默认 10 秒。
  - ⑤ **控件接线与首次 apply 提前到 `init()` 开头**（`wireRefreshControls()`），不排在 `checkAuth → fetchProxyConfigs` 的 then 链里。理由不是洁癖：这两件事只依赖 DOM 与 localStorage，塞在网络之后意味着「后端慢多久，开关就失效多久」——用户在这段时间拨了关，初始化随后把控件拨回存档里的开。这条是 E2E 撞出来的（点完 tab 立刻点滑块，状态没落盘）。
  - ⑥ **删掉 `getRefreshInterval` / `saveRefreshInterval`**：两个只在「从 DOM 反读状态」那条老路上被调用的薄函数，留着就是下一个人重新接回老路的路标（D-024④ 同族：转发死码的坏处不是占地方）。
- **守卫**：
  - `tests/node/panel-refresh-schedule.test.js`（4 条，静态）：页面内联脚本里 `setInterval` 只许一处、`switchPage` 不许出现 `__statusInterval`/`clearInterval`、开关键必须既写又读、`readRefreshState` 必须把「间隔 0」归一成关闭、合法档位必须来自 `.options` 且页面里不许出现写死的档位数组。
  - `e2e/auto-refresh.spec.js`（4 条，`@tier0`）：跨 tab 存活（含切回来后**真再刷一次** `/api/today`）、关掉要记住（刷新后 6.5 秒内 `/api/status` 多一次就算失败）、非法档位回落默认且 1.5 秒内不许超过 5 次、两条关闭路径同一条状态 + 拨回来真的重新开始刷。
- **注入验证（四式全真红 + sha256 逐字节恢复）**：A `switchPage` 里重新 `clearInterval` → 静态守卫 + 跨 tab E2E 红；B 开关 change 不再传 `enabled` → 「关掉要记住」红；C `refreshIntervals` 改成写死 `[5,10,30,60]` → 静态守卫红；D 拨回开启时不补真实间隔 → 两条关闭路径 E2E 红。
- 🔴 **③ 那支风暴没有「注入版」**：它的根因是「从 DOM 反读状态」这个架构，修完以后没有一行代码能让它重现。所以它的红证据是**修复前真实量到的 212 次/1.5 秒**，比注入更硬。E2E 现在锁的是「合法档位必须来自选项、非法值必须回落」这条架构约束。
- 🔴 **本轮踩到的新一类问题：假红**。前几片防的是「假绿」（D-018 注释满足判据、D-022 注释吞掉判据、D-024 判定器取错退出码）；这次是反向：测试在**首屏自己那次取数还没回来**时就开始计数，于是把正常首屏请求算成「关掉之后偷跑」，看着像产品 bug，其实是测试没等被测物就绪。修法是判「统计卡是否还在转圈」（`waitFirstPaint`），不是加 `sleep`。同族：加压跑时 30 秒默认超时把被测物掐死再报失败，也是假红 —— 本文件显式抬到 90 秒。
- **后果**：真跑 node **63/63**、coherence **七项**、jest 前端 **320/320**、全量 E2E **72/72**（连跑两遍）、tier0 闸门 **58/58**；`dashboard.html` 2007 → 2077 行（**+70，是修 bug 的净增，不是抽离**）。
- **推翻条件 / 剩余**：`switchPage` 分支表本身没动（仍是 if-else 长链，七页）。它不是 bug，只是不好看；要改成路由表属行为改动，且收益是「可读」不是「不出错」，不与本片混做。另外 `init()` 里 `Promise.all([loadStatus(), loadVersion()])` 之后才取 `loadSessions`、`loadProviderHealth` 这些次级卡的数据，首屏取数仍是串行两段 —— 要不要并发属性能优化，应单独量过再改。

## D-026 · 壳第二片：apiKey 横幅真实现收口进 mp-shell.js；顺手清掉 demo 横幅与 initDarkMode 两处死码

- **背景 / 触发**：老板「按你的推荐，能做都做，继续」。上一轮给的三个方向里推荐的是「壳第二片：把 demo/apiKey 横幅 + 暗色模式收口进 mp-shell.js」。开工侦察后**校正了推荐里不成立的一半**（老板要的就是及时纠正 + 给正确解法，不是照单全搬）：
  - apiKey 横幅是**真机制**（`#apiKeyBanner` 在 DOM、有内联 onclick、`init()` 里 env-check 触发），值得收口；
  - demo 横幅是**纯遗迹**（`#demoBanner` 元素早不在 DOM，全仓只剩 dashboard 两处 + overview 一处对不存在的元素空打）——搬进壳等于把死码扶正，正确做法是删；
  - `initDarkMode()` 是**半死码**：它找的 `#darkModeToggle` 按钮早不在 dashboard DOM（主题入口已收口到 nav.js 三态切换 `mp-theme-switch`），click 绑定永远不跑，只剩「读旧 `darkMode` 键设 `.dark` class」半句在跑，而 CSS 已双选择器兼容 `html[data-theme=dark]`。暗色真源 = `theme.js`（head 就位设 data-theme）+ `nav.js`（切换器），页面自建的第二套应删，不是收进壳。
- **做法**：
  - ① `showApiKeyBanner`/`hideApiKeyBanner`/`isApiKeyBannerDismissed`/`dismissApiKeyBanner` 四函数真实现搬进 `mp-shell.js` 的 `MPShell`（含 `API_KEY_DISMISSED_KEY` + 24h TTL + 读写 localStorage），dashboard.html 留四个同名薄包装（`return window.MPShell.xxx()`）。
  - ② 删 dashboard.html 的 `showDemoBanner`/`hideDemoBanner`/`dismissDemoBanner` 三函数、overview.js 的 `hideDemoBanner` 局部副本与两处调用。
  - ③ 删 dashboard.html 的整个 `initDarkMode()` 函数与 `init()` 里的调用；暗色完全交给 theme.js + nav.js。
  - ④ 新增 `tests/node/panel-shell-banners.test.js`（4 条静态判据），登记进 `panel-guard-registry.test.js`；`panel-view-isolation.test.js` 的 `PAGE_LOCALS` 注释同步（名字保留防复活）。
- **守卫注释里的一个坑**：判据②最初对 dashboard.html 整页「剥字符串」，被页面里含引号的正则/字符串跨行吞掉函数定义，导致薄包装误判不存在（D-022「整段剥注释吞半页」同族）。改为**按行剥 `//` 注释**——薄包装/死码都看行首形态，行级处理既避注释误判又不跨行吞页。
- **注入验证（四式全真红 + sha256 逐字节恢复）**：A 壳里 `localStorage.getItem` 换成 `void 0` → ①红；B 页面薄包装改回真实现 → ②红；C overview.js 注入 `hideDemoBanner` → ③红；D theme.js 的 `data-theme` 改 `data-theme-X` → ④红。全量还原后 sha 一致、守卫回绿。
- **后果**：真跑 node 守卫 **67/67**、coherence **七项**、jest 前端 **320/320**、相关 E2E tier0 **20/20**；`dashboard.html` 2077 → **2030** 行（−47：删 demo 三函数 + initDarkMode + apiKey 四函数由实现变薄包装）。E2E 的「failed」状态只是 Playwright 退出时清理系统 Chrome 临时克隆目录被沙箱拒，测试本身 20 passed。
- **推翻条件 / 剩余**：`switchPage` 分支表仍未动（同 D-025 剩余项）；B 组 service-provider WIP 全程未碰、未入库；暗色的 `.dark` class 兼容路径保留在 CSS 里（未删，避免影响仍带 `#darkModeToggle` 的 login.html 等旧页）。

## D-027 · 壳第三片：鉴权三件套收口进 mp-shell.js；页面不再改写 window.fetch

- **背景 / 触发**：老板「继续」。壳第二片收口后，壳内剩余职责只剩三块：鉴权、侧栏动态导航、`switchPage` 分支表。选鉴权，因为它是三者里唯一「所有接口请求的必经之路」——侧栏导航只影响一个 DOM 容器，分支表只影响可读性。
- **为什么必须搬（三条都指向同一个病：没有单一定义）**：
  - ① 全局 `fetch` 改写在页面 IIFE 里。谁照抄 dashboard 就会漏，而漏了**不报错**：页面照常出数据，只是 401 不再自动跳登录页、受保护接口不再自动带 token。属于「看着接好了、其实没接」。
  - ② 同仓 9 个页面各写各的凭证：logs/knowledge/skills 各抄一份拦截器，settings 曾漏带 token（被 `x-auth-token` 缺失坑过一次），proxy-config/sessions 各处手拼 header。「请求怎么带上凭证」有 N 个答案，就等于没有答案。
  - ③ 页面持 `var authToken = MPKernel.getToken()` 快照——这是「页面持一份状态」的最后一个样本。今天等价（全文只读不写），但一旦有人给 token 加刷新，快照立刻变过期值。
- **做法**：
  - ① `mp-shell.js` 新增 `currentToken` / `showLoginRequired` / `checkAuth` / `installFetchAuth`，token 一律**现读** `MPKernel.getToken()`；拦截器打 `__mpAuthInstalled` 标记防重入（重复引入不叠两层）；模块加载时即安装——比原来（内联 IIFE）更早，覆盖 head 里所有取数脚本，是严格超集，不是等价替换。
  - ② 401 跳转**保留** `/api/auth/*` 豁免。这一条是硬约束：不豁免的话，登录页输错密码会被自己的拦截器当成会话过期，跳回自己。
  - ③ `dashboard.html` 的 `checkAuth` / `showLoginRequired` 变同名薄包装；删掉整段 fetch 改写与 `authToken` 快照；`init()` 里 `checkAuth()` 调用点零改动。
  - ④ 新增壳鉴权守卫（5 条静态判据），登记进 `panel-guard-registry.test.js`。该守卫在 D-028 随实现迁层而升级并更名为 `tests/node/panel-auth-layer.test.js`（8 条，含运行态）。
- **守卫的四个判据坑（都真踩了）**：
  - 🔴 **登记表 `must` 是 `src.includes(kw)` 字面量比对**，不是正则。我按前一条的写法把关键字写成「转义点 + 文件名」的形态（反斜杠加 `.js`），而登记表比的是**字面量**——文件里没有那个反斜杠，于是匹配不上、登记表红。关键字必须取「判据正则的**源码形态**」（见本条 `window` 后接转义点、点号后接 `fetch` 的那个写法），散文和普通文件名都不行。
  - 🔴 **别拿 `removeItem('auth_token')` 判「页面还在处理 401」**：页面的 `handleLogout` 本来就要清 token（主动退出 ≠ 会话过期），照这条写会误红。判据改成 `/status\s*===\s*401/`。
  - 🔴 **加载顺序判据不能拿裸 `indexOf('views/')`**：head 的注释里也会写 `views/*.js`，注释会抢到 script 标签前面，于是「顺序错」红在注释上而不是代码上。只认 `<script src="...">` 形态再取位置。
  - 🔴 **剥注释要引号感知、且只按行**：本守卫要断言字符串常量（`'/api/auth/status'`、`'x-auth-token'`）在不在，整段剥字符串会把判据一起剥掉；整段跨行剥又会像 D-022 那样被不平衡引号吞页。行级 + 引号感知两头避开。
- **注入验证（五式全真红，且红在对应判据上）**：① 壳里 `res.status === 401` → `402` ⇒ 判据①红；② 页面薄包装改回真实现 ⇒ ②红；③ 页面重新 `window.fetch = ...` ⇒ ③红；④ head 里把 mp-shell 提到 mp-kernel 之前 ⇒ ④红；⑤ settings.html 也引入 mp-shell ⇒ ⑤红。还原后 sha256 逐字节一致、守卫回绿。
- **运行态验证（静态守卫证不了的那半）**：临时 Playwright spec 种一个假 token 开 dashboard，实测两件事——带 `x-auth-token` 头的请求真的发出去了（拦截器生效），且假 token 的 401 真把浏览器踢到登录页（跳转生效）。验完即删，不入库。
- **E2E 归因（不只报数字）**：全量 tier0 本机 **56 passed / 2 failed**（`auto-refresh` 两条 + `copy-feedback` 一条），单跑时失败的那条又会换人——同配置连跑两遍，第 1 遍 4/4 绿、第 2 遍只红第 64 行。于是把 `mp-shell.js`/`dashboard.html` 退回 HEAD 版本用同一条命令跑两遍作对照：**HEAD 同样两遍都 1 failed**。⇒ 这条抖动与本次改动无关，是本机沙箱的既有噪声（Chrome 临时克隆目录被沙箱拒删也是同一类噪声）。改动件已按 sha256 逐字节还原。
- **后果**：真跑 node 守卫 **72/72**（新增 5 条）、coherence **七项**、jest 前端 **320/320**、运行态鉴权自检 **1/1**；`dashboard.html` 2030 → **1987** 行（−43：删 fetch 改写整段 + 登录墙 DOM + `authToken` 快照，两函数变薄包装）。
- **推翻条件 / 剩余**：`switchPage` 分支表与侧栏动态导航仍未搬（前者的收益是可读性、属行为改动，需单独拍板）；同仓其余 8 个页面的拦截器副本**未动**——它们各自自治、且 dashboard 之外的页面不引 mp-shell（引了就会多一份 401 跳转语义），要收口得先把 mp-shell 拆成「可复用鉴权层 + dashboard 专属壳」，属独立一片。

---

## D-028 · 鉴权从 mp-shell 再剥一层到 mp-auth.js：把「请求怎么带凭证」从 4 个答案收成 1 个

- **日期**：2026-11-15（壳第四片，老板「能做都做」）
- **背景**：D-027 把鉴权收进 `mp-shell.js`，但它只服务 dashboard 一页。实测同仓有 **4 种带凭证方式**：
  dashboard / knowledge / logs / skills 各抄一份全局 `fetch` 改写（4 个副本）；
  proxy-config 只抄了 401 跳转那半、token 靠 3 处手写 header；
  sessions / settings 只手写 header、**没有 401 跳转**（会话过期时页面一直显示「读取失败」，
  用户点「重试」点到天荒地老也不知道自己已经掉线）；floor 走不鉴权的 `/api/floor`，不需要令牌层。
- **决策**：新开 `public/mp-auth.js` 作**通用鉴权层**（`MPAuth`：`currentToken` / `showLoginRequired` /
  `checkAuth` / `installFetchAuth`），加载即安装拦截器；`mp-shell.js` 收回到 **dashboard 专属壳**
  （加载条 / 离线横幅 / apiKey 横幅），不再含任何 `/api` 语义；dashboard 的两个薄包装改为指向 `MPAuth`。
- **为什么是「再剥一层」而不是「让别的页引 mp-shell」**：引 mp-shell 等于把 dashboard 的 DOM 假设
  （`#loadingBar`、`#offlineBanner`、`#apiKeyBanner`）投影到 8 个别的页面上，且那些横幅函数在别的页
  全是空打——「看着接好了、其实没接」的老毛病。分层后依赖方向是单向的：页面 → mp-auth → mp-kernel。
- **改动面**：knowledge / logs / skills 删掉整段拦截器与 `authToken` 快照（快照全文只被拦截器用；
  删除后 grep 只剩注释里的字）；proxy-config 删掉「只跳转不注入」的半拦截器；sessions / settings 只加
  script 引入、不动业务；**全站 0 处页面再改写 `window.fetch`**（守卫扫全部 `*.html` 钉死）。
- **有意接受的行为变化**（不是顺手改，是明确取舍）：sessions / settings 从此多了「401 → 清 token →
  跳 login」这条路径。此前会话过期它们只显示「读取失败」，等于把「掉线」伪装成「没数据」。
  代价：settings 跳到登录页会丢掉当前页未提交的操作——已核实该页**没有** dirty 状态（逐项点保存即提交），
  丢的只是「正在看的位置」，因此接受。
- **没做的事**：proxy-config / sessions / settings / logs 里**手写 `x-auth-token` 的地方保留**。
  它们与全局注同值、不冲突，删掉纯属为「只剩一个答案」而扩大改动面（几处 header 是显式且按需的）；
  真正的病根是**隐式全局改写被抄了 N 份**，那部分已收口。
- **守卫**：`tests/node/panel-auth-layer.test.js`（8 条，取代 D-027 的 5 条壳守卫并更名，登记表同步）。
  静态五条：真实现唯一在 mp-auth.js / 全站不许再改写 `window.fetch` / 打 `/api/` 的页面必须引 mp-auth.js /
  加载顺序 `mp-kernel → mp-auth → 内联`、dashboard 另有 `mp-auth → mp-shell → views` /
  login·consent·legal 三个无鉴权页**不得**引它。运行态两条：把 `mp-auth.js` 原文件塞进假 window 真跑，
  验注入、非 `/api/` 不动、`/api/auth/*` 豁免、401 跳转、以及**幂等**。
- **判定器坑（这轮真踩，都是「假绿」）**：
  - 🔴 **数错观测点**：幂等判据第一版数「到达底层 `fetch` 的次数」→ 叠三层也只发一次网络请求，注入
    「删掉防重入标记」照样全绿。改数 **401 处理次数**（`sessionStorage.removeItem` 命中次数），叠层
    才暴露。D-024 是「取错退出码」，这次是「取错计数对象」，同族。
  - 🔴 **散文满足判据**：`src.includes('mp-auth.js')` 会被页面注释里那句「现由 mp-auth.js 统一安装」喂饱——
    把 `<script>` 删掉照样绿。改只认 `/<script\s+src="[^"]*mp-auth\.js"/`。判据必须落在**会执行的形态**上。
- **注入验证（七式全真红，且各自红在对应判据）**：① `res.status === 401` → `402`；② knowledge 重新
  `window.fetch = …`；③ logs 删掉 mp-auth.js 的 `<script>`；④ dashboard 把 mp-auth 提到 mp-kernel 之前；
  ⑤ login.html 误引 mp-auth.js；⑥ mp-shell 又塞回 `/api/auth/status`；⑦ 删掉 `__mpAuthInstalled` 赋值。
  还原后 sha256 逐字节一致、守卫回绿。
- **后果**：node 守卫 **75/75**、coherence 七项、jest 前端 **320/320**、E2E tier0 **58/58**；
  另用临时 spec 逐页（7 页）验「无 pageerror + `window.fetch.__mpAuthInstalled` 为真」，验完即删。
- **剩余**：`switchPage` 分支表与侧栏动态导航（后者判定不该进壳：它读 `MPViews.overview.status`，
  搬进壳会造成「壳依赖视图」的反向依赖）。`switchPage` 部分已由 **D-029** 收口。

## D-029 · `switchPage` 的 if/else 链改成页路由表：把「切过去没数据」从沉默故障变成构建期红灯

- **日期**：2026-11-15（壳第五片，老板「继续」）
- **背景**：`switchPage` 里七个 `if / else if` 承担「切到哪页要拉什么」。这条链的失败模式是沉默的：
  漏一行、或把 id 写错一个字母，症状都是**页面切过去了、数据永远不出现**——不白屏、不报错、控制台无声。
  这不是假想：链中间还夹着一条「'sessions' 不再有分支」的注释，加页的人很容易顺手插在注释下面。
- **开工时纠正了自己一处**：上一片结尾我说「七个分支的行为要逐条对齐（页面显隐、hash、历史、返回按钮）」。
  实测 `switchPage` 里**没有 hash / history / popstate 任何一行**（dashboard.html + nav.js 全文 grep 为空），
  它只做三件事：`.page` 显隐、页内 tab 高亮、该页首屏取数。所以「对齐 hash/历史/返回」是个不存在的任务，不做；
  行为对齐面就是这三件。
- **决策**：链改成 `PAGE_LOADERS` 表（today / health / alerts / registry / cost / dashboard / shadow 七行），
  `switchPage` 只做 `var load = PAGE_LOADERS[pageId]`。值一律写**裸函数名**（本页 loader 全是 function 声明、有提升），
  不写字符串——名字拼错会当场 ReferenceError，而不是静默变成 undefined。
- **顺带修的潜伏缺陷（当前路径不可达，零可见变化）**：老写法是「先把所有 `.page` 的 active 摘光，再按 id 找分支」，
  未知 id 会留下一片空白屏、控制台还一句话都没有。改成**先验 id、再动 DOM**：未知 id 一个 DOM 都不碰，
  `console.error` 后返回，当前这页留着。今天没有未知 id 的调用方，所以这是修「将来会有人踩」，不是修「现在坏了」。
- **删掉的死代码（附证据）**：`switchPage` 里那句 `document.querySelector('.nav-item[data-page="…"]')` 永远不命中——
  `nav.js` 的 nav-item 模板是 `<a class="nav-item" href="…">`（`renderNav` 产出，侧栏项全是指向独立页面的链接），
  `data-page` 只出现在 `.section-tab` 上。注释里「页内 tab 和侧栏是同一件事，必须一起更新」因此是错的，一并改掉。
- **一处既有 UI 瑕疵，本轮只记录不修**：上面那段「摘掉所有 `.nav-item` 的 active」仍在、且摘完没有任何地方补回来，
  净效果是**切一次 tab 侧栏就没高亮了**（旧代码同样如此，因为补高亮那句从没命中）。修它属可见 UI 变化，单独拍板。
- **没合并的东西**：`refreshTick` 里还有一处按 `pageId` 的两分支（dashboard / today），**故意不并进路由表**——
  它回答的是「定时器该刷哪一屏」（子集，且不带首屏取数语义），与「进页要拉什么」不是同一件事。
  合表会让「刷新」和「进页」互相绑死，改一个动两个。
- **守卫**：`tests/node/panel-route-table.test.js`（7 条），登记进 `panel-guard-registry.test.js`。
  ① 表键 ↔ `.page` 容器**双向**比对（缺/多都报）；② `SPA_VIEWS` 每个 id 都有容器+加载函数；
  ③ 手写 tab 的 `data-page` 也得是表里的键；④ 每个值必须解析到真实的 function 声明（挡「写成字符串」「拼错名字」两种静默）；
  ⑤ `switchPage` 体内不许再出现 `pageId === '…'`；⑥ 未知 id 必须先验后改、且要 `console.error`；
  ⑦ 侧栏项是链接（锁定「切页不需要更新侧栏高亮」这个判断，改了会红）。
- **判定器坑（本轮真踩，又一次假绿）**：取块工具写死找第一个 `{`，而 `SPA_VIEWS` 是**数组**，第一个 `{` 是首个条目的
  对象体 ⇒ 只解析出 `today` 一个 id，判据 ② 退化成「只验 1/6」却全绿。修法：认「第一个出现的 `{` 或 `[`」并配同种括号；
  另加一条**内部一致性**断言（解析出的 id 数 == `label:` 数），让「圈错范围」这类失败自己暴露，不必等下一轮人眼发现。
- **注入验证（十式全真红，且各自红在对应判据）**：删 health 加载行 / 多一行指向不存在的容器 / SPA_VIEWS 加一个无容器的 tab /
  手写 tab 改 `data-page` / 值写成字符串 / 值拼错函数名 / 体内长回 if-else / 把 DOM 改动提到验 id 之前 /
  页面重新出现 `.nav-item[data-page=` / nav.js 的 nav-item 改成 div。还原后 sha256 逐字节一致、守卫回绿。
- **后果**：node 守卫 **82/82**、coherence 七项、`drift-check` 无漂移、jest 前端 **320/320**、E2E tier0 **58/58**。
  `dashboard.html` 1990 → 2022 行（**+32**）：代码本体从「7 条分支」变成「表 7 行 + 一次查表」，
  变长的是把「为什么这么写」的注释补全了——净代码量是减的，这一点如实记下，不拿「行数下降」当成绩。

## D-030 · 面板凭空多出一道登录门：E2E 的测试密码被写成了用户的真密码

- **日期**：2026-11-15（老板报障：「应用的登录密码咋又给我搞出来了？删掉」）
- **现象**：本机打开 18792 面板被要求登录。数据目录里躺着 `password`（0644→0600，60 字节 bcrypt），
  于是 `needsPasswordSetup()` 为假 ⇒ 回环免鉴权失效 ⇒ `requireAuth` 对 127.0.0.1 也要 token。
- **铁证（不是推测）**：把该文件备份后用 `bcrypt.compare` 逐个比对候选常量，命中
  `tests/e2e/helpers.ts` 里的 `TEST_PASSWORD`。⇒ 这个密码不是老板设的，是测试写的。
- **根因三层，缺一层都不会发生**：
  1. **测试服没隔离数据目录**：`playwright.config.js` 的 webServer 只写 `PORT=18801 node server.js`，
     没设 `MP_DATA_DIR` ⇒ 继承真实 HOME，账本/密码/密钥全落在用户目录。
  2. **旧矩阵直指生产端口**：`tests/e2e/playwright.config.js` 的 baseURL 写死 `localhost:18792`（真实面板），
     且没有 webServer，等于对着正在服务的面板跑测试。
  3. **服务端语义自相矛盾**：`GET /api/auth/status` 对回环已如实返回 `needsSetup:false`（面板不显示设置表单），
     但 `POST /api/auth/login` 仍按 `needsPasswordSetup()` 进 **setup 分支**并 `setPassword()` 落盘。
     于是任何一次「以为在登录、实际在设密码」的提交都会把提交值固化。`login.html` 也没看
     `loopbackBypass`，回环下照样渲染登录表单 —— 用户手输一次也一样中招。
- **决策（三处一起改，少一处就还会复发）**：
  - **服务端**：`routes/auth.js` 的 setup 分支内加回环守卫——回环 + 未配置密码 ⇒ 400 + `loopback:true`，
    并明确告知出口是 `MANAGER_PASSWORD`。守卫**只在 setup 分支内**：放到函数开头会把「已有密码的用户登录」一起禁掉。
    非回环（LAN / Docker）的首次设密码引导原样保留。
  - **前端**：`login.html` 拿到 status 后，`loopbackBypass && !hasPassword` ⇒ 直接 `location.replace('/dashboard.html')`，
    不渲染任何表单。登录页对本机用户本来就没有存在意义。
  - **测试**：两份 playwright 配置的 webServer 都带 `MP_DATA_DIR`（临时目录，先 `mkdir -p`，并预置 providers sample 垫底）；
    `e2e/helpers/auth.js` 取 config 导出的同一常量，`tests/e2e/helpers.ts` 复制同一表达式；
    旧矩阵的 `login()` 改成**直接签 token 注入**，不再走登录页、不写任何密码文件；
    `01-auth-flow` 按新契约重写（5 条：直跳 / 端点 400 且不落盘 / 已设密码要登录 / 正确密码可进 / 首屏可加载）。
- 🔴 **刻意「不隔离」密钥——第一版把 `JWT_SECRET_FILE` 也指到临时目录，CI 直接全红**：
  `resolveJwtSecretFile()` 不读 `MP_DATA_DIR`，只认 `JWT_SECRET_FILE` 或 home；而 `lib/auth.js` 见到
  `JWT_SECRET` 环境变量就**不落盘**（CI 的 e2e-tier0 会预写密钥并导出 `JWT_SECRET`）。两者叠加 =
  「指定了一个服务端根本不会写的路径」⇒ helper 读空 ⇒ 全部用例起不来。**不设它才是同源**：
  测试服与 helper 都走 home 那个密钥文件。教训：判据要建在「代码真会怎么做」上，不是「我想让它怎么做」。
- **守卫**：`tests/node/panel-no-home-pollution.test.js`（5 条），已登记进 `panel-guard-registry.test.js`。
  ① **子进程真跑** `routes/auth` 路由：回环 + 无密码提交 ⇒ 必须 400、`loopback:true`、且临时目录里**没有** password 文件；
  ② login.html 必须存在「回环且无密码 → 直跳面板」的可执行分支（认 `location.replace`，注释满足不了）；
  ③ 两份 config 的 webServer 必须含 `MP_DATA_DIR`、**不得**含 `JWT_SECRET_FILE`，且去掉注释后不许出现 18792；
  ④ helper 必须把 `MP_DATA_DIR` 指向隔离目录、密钥用 `resolveJwtSecretFile()`；⑤ 回环守卫必须在 `needsPasswordSetup()` 分支**内部**。
- 🔴 **「本地绿 ≠ CI 绿」这次的真凶是环境变量**：p0 gate 的 manager job 设了
  `MANAGER_PASSWORD=ci-gate-test-password-not-a-secret`（为了让其余测试跑在「账号体系形态」下）。
  子进程若整份继承 `process.env`，`needsPasswordSetup()` 直接为假 ⇒ 走 `verifyPassword` ⇒ 401 而不是 400。
  修法：探针子进程用 `cleanEnv()` 显式删掉 `MANAGER_PASSWORD` / `MANAGER_AGENT_TOKEN` / `JWT_SECRET*`，
  并把「删掉这行就复现 CI 的那个 401」做成注入验证（本地 `MANAGER_PASSWORD=…` 跑一遍即可复现）。
- **注入验证（五式全真红，各自红在对应判据）**：① 把回环守卫改成 `false && …` ⇒ 真跑那条红在「必须 400」；
  ② login.html 直跳条件前加 `false &&` ⇒ 静态那条红在「少了分支」；③ 从根 config 删 `MP_DATA_DIR=` ⇒ 红在「必须设」；
  ④ 把旧矩阵 `PORT` 改回 18792 ⇒ 红在「不许指向生产端口」；⑤ 去掉 `cleanEnv` 里删 `MANAGER_PASSWORD` 那行，
  带 `MANAGER_PASSWORD=…` 真跑 ⇒ 精确复现 CI 的 `401 !== 400`。还原后 sha256 逐字节一致、守卫回绿。
- **现场处置**：`password` 文件已删（备份在 `/tmp/costgate-backup/`），`/api/auth/status` 现在返回
  `loopbackBypass:true, hasPassword:false`，dashboard 与受保护 API 直接 200，无需重启（密码是每次读文件判的）。
- **口径**：「本机不要密码」不等于「删掉鉴权能力」。要账号体系 = 设 `MANAGER_PASSWORD` 后重启；
  非回环部署仍受 fail-closed 约束。这条边界写进守卫注释，避免下次有人把服务端守卫当成「鉴权没用」删掉。

## D-031 · 切一次页内 tab，侧栏高亮整片消失：`.nav-item` 的 active 摘了没人补

- **日期**：2026-11-15（壳第六片，老板「能做都做」授权修 D-029 记录的那处既有 UI 瑕疵）
- **现象**：在概览里点任一页内 tab（今日/健康/告警/注册表/成本/影子），左侧导航立刻失去高亮，且回不来。
  页内内容正常切换，所以看起来像「导航栏坏了」而不是「切页逻辑坏了」。
- **机制**：`switchPage` 里对**所有** `.nav-item` 摘 `active`，而侧栏项是 `nav.js` 渲染的 `<a href>`
  （指向独立页面），它的 `active` 只在 `renderNav(current)` 那一刻按入参加上——摘掉之后没有任何代码补回来。
  旧代码那句按 `data-page` 找侧栏项的查询永远不命中（侧栏项从不带 `data-page`），所以「补高亮」从来没生效过。
- **决策**：`switchPage` **一律不碰** `.nav-item`。页内高亮归 `#viewTabs .section-tab` 循环，
  侧栏高亮归 `nav.js` 的渲染入参，两边不越界。理由不是「少写一行」，是**归属**：
  侧栏表达的是「你在哪个页面」，页内 tab 表达的是「这个页面里选了哪个视图」，两类状态不该由同一段代码擦写。
- **可见变化**：切页内 tab 时侧栏保持高亮（此前会消失）。这是修 bug，不是改设计——侧栏本来就该一直亮着当前页。
- **守卫**：`panel-route-table.test.js` 第 ⑧ 条：`switchPage` 体内不许出现 `'.nav-item'` 查询，
  且必须显式维护 `#viewTabs .section-tab`。注入「把 navItems 查询加回来」⇒ 真红在「又去查 .nav-item 了」。
- **后果**：node 守卫 **88/88**、coherence 七项、`drift-check` 无漂移。
