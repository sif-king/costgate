<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# N-04 全局状态条 · 四角色评估记录（2026-10-24）

> 触发：DeepSeek 审计指出 UI-03「功能假」——门控默认关但 UI 无标识。
> 本文件汇总 4 路子代理评估。产出模型：qwen3.8:27b-mlx（本地）。
> 状态：用户视角 + UI 设计师 **完整**；产品经理 + 交互设计师 **部分**（429 速率限制中断，附其已产出内容）。
> 注：现有 `multi-proxy-manager/public/dashboard.html:456` 已实现 `#gateBar`（15 gate chips + stock pill，前会话产出），与本文件 UI 设计师给的 `mp-status-strip` 是**两套并行的设计**，续跑需决定取舍/合并。

---

## 1. 产品经理（⚠️ 部分，429 中断前产出）

- **结论**：需要全局状态栏。shadow 是安全默认但前台零标识，正是「功能假」根因；加一条常驻状态带可消除认知阻断，纯前台展示 + 读现有状态接口，零热路径改动、不改变影子默认行为。
- **位置**：dashboard 顶部导航（nav）之下、内容区之上的吸顶状态带（sticky sub-header），跨 #page-shadow / #page-cost / #page-registry 等所有页常驻；视觉对齐 states.js 既有 .empty-state 族与 warn 色（#d97706），不引入新样式体系。
- **展示哪些 gate**：
  1. `PROXY_ROUTE_OVERRIDE` 生效态（0=影子/未生效, 1=实生效）——最关键的「功能假」信号
  2. shadow 全局开关状态（影子/关闭）
  3. 各 L2 能力门控 gate 的 closed/open 列表（路由决策/override/成本优化等）
  4. 代理运行三态（未知/运行/停止）汇总，沿用 states.js 体系
  5. lsof 路径健康 + NO_PROXY 是否出现非法裸通配 `*`（对应 ADR 铁律）自检告警
- **影响**：消除「功能假」认知；纯前台展示层改动，不动 forward.js / codex-proxy/proxy.js 热路径；状态数据复用现有接口。
- **优先级**：P1。认知阻断性高但不阻断真实功能，可纯前端独立交付；建议先出影子态单门控最小版，再迭代全量门控列表。
- **交互**：warn 色标识非默认/非预期态；点击 gate 项可展开就地详情或跳转对应门控页/成本页；失败沿用 states.js 注册式 retry；role=status/aria-live 保证可访问性。

## 2. 用户视角（✅ 完整）

**用户困惑点（实机抓）**：
1. 打开总览满屏是卡片按钮，没有一行告诉「系统现在处于什么状态」——路由生效还是只记录，无从判断。
2. 点进「路由预演」才发现有 shadow，但主页无任何「影子模式」标识；侧栏还把「影子模式」改名「路由预演」（去黑话），反而更懵。
3. 不确定成本追踪开着还是没配——总览「账本主权」只显示「正在加载…」和数字，成本页空态写「未配置预算·零行为变更」，分不清「没开」还是「没数据」。
4. 不知道编排引擎（L2）有没有配好——「运行中任务」空了只写「暂无运行中任务」，读成「没活干」，其实可能引擎没启用。
5. 术语轰炸：账本主权、L2 编排引擎、observe 模式、shadow 姿态、三路信号源、门控关闭……用户只想问「它现在正常吗、安全吗、要不要开个开关」。
6. 默认全关（门控关、shadow 开）本应是安全设计，但界面没说这是「安全观察态」，只看到一片灰、什么都没发生，直接觉得「功能假的」。
7. 告警页「门控关闭」徽标写死静态文案，进子页才刷新；总览看不到，也不知道「门控」指什么。

**状态条规格（用户语言）**：
- **位置**：#mainContent 最顶上一条常驻横条（sticky，横跨全部 7 视图、移动端折叠成胶囊），紧贴 mobile-menu 行下方、各 hig-card 之上。
- **3 个用户语言 chip**：①「路由：影子模式·只记录未生效」②「成本追踪：开 / 未配置」③「编排引擎：已配置·观察中 / 未启用」，最左加系统圆点。
- **颜色规则**：绿 #16a34a = 已生效/已开；**琥珀 #f5c518（底 #fff7e6、字 #b45309）= 影子/只记录（最关键，务必与「正常」拉开距离）**；灰 #94a3b8 = 关闭/未配置（正常默认，不是错误，别用红）；红 #ef4444 = manager 不可达时整条接管为「系统离线」。
- 每个 chip hover/点击展开一句解释；影子态示例：「影子模式：路由规则只记录、不执行；切到生效才会真正改流量。」
- 数据源复用已有端点 `/api/l2/shadow-map`、`/api/budget`、`/api/orchestration`、`/api/alert/config`，不新造字段。

**最小必要（4 个 token）**：路由姿态（影子/生效，排第一）· 成本追踪（开/关/未配置）· 编排引擎（已配置观察中/未配置）· manager 可达性（绿/红点，复用 offlineBanner）。其余不进条。

**过度设计（该删）**：落地页 4 张 stat 卡（与状态条+代理卡重复）·「账本主权·上周节省」大数字 hero（是报表，挪成本页）·「统一接入·单端点」hero（内部话术）·「三路信号源/L2 能力/observe 模式」标签·代理 meta 行塞延迟+uptime+降级原因·再塞第 4/5 chip。

**优先级**：P0 = 路由姿态做第一 chip（「功能假」根因）+ shadow 视图标题下补一行「你当前正处于影子态」；P1 = 成本 chip + manager 可达点；P2 = 编排引擎 chip；P3 = 收敛 4 stat + 2 hero 卡，删「三路信号源」标签。

## 3. UI 设计师（✅ 完整，含 HTML/CSS 片段）

- **位置**：页面内顶部（`<main class='main'>` 顶部、offline-banner 之上）sticky，跨 7 页常驻；侧栏附 10px 圆点副显作窄屏兜底。
- **颜色（走 tokens.css 语义 token，明暗自动）**：未配置/未知 = `--idle` 灰；影子（ROUTE_OVERRIDE=0）= `--warn` 黄 + `--warn-soft-bg` 底；生效（live）= `--ok` 绿 + `--ok-soft-bg`；门控 on=绿点 / off=灰点。单一蓝色 accent 不被污染。
- **信息密度**：单行 5 项：[主引擎态药丸：未知/影子/生效] · [编排点][路由点][成本点] 三门控 · 右侧 [代理 N/M 运行中 + 逐代理小圆点]。文字 2 字内，12px/weight500。
- **响应式**：≥1024px 完整单行；≤1024px 门控 chip 隐文字只留色点+title；≤640px 换行（引擎药丸左+运行计数右，门控换行到底部 justify-between）；prefers-reduced-motion 关脉冲。
- **states.js 配合**：引擎态四值 {未知(灰,脉冲)/影子(黄)/生效(绿)/未配置(灰)}；每代理三态 {未知/运行/停止}；get数走 `MPStates.registerRetry('mp-status-strip', refresh)`，失败降级「未知」灰，不阻塞。
- **HTML/CSS 片段**（完整设计，可直接落地到 dashboard.html `<main>` 顶部）：定义了 `.mp-status-strip` / `.mp-engine{--idle,--unknown,--shadow,--live}` / `.mp-gate` / `.mp-running` + `MPStatusStrip.refresh()` JS（取 `/api/status` + `/api/orchestration/shadow`，注册 retry）。
  （完整片段见子代理 transcript：`~/.hermes/cache/delegation/live/deleg_7f279272/task-2.log`）

## 4. 交互设计师（⚠️ 部分，429 中断前无产出，待补）

交互维度（点击跳转目标 / 未配置引导 / 影子↔生效切换 / 刷新频率 / 与 alerts tab 关系 / 键盘可访问性）本次未产出，续跑需补。
建议（综合前 3 路）：点击门控 chip → 跳转对应门控页/成本页（而非弹窗改 .env，符合「低风险可回滚、改 .env 需重启」现状）；影子↔生效切换 = 引导去改 `.env` + 重启（非一键，因涉及热路径行为变更）；刷新跟 auto-refresh 同频；与 alerts tab 解耦（状态条=当前态，alerts=事件流）。

---

## 续跑决定点（待老板拍）

1. **两套设计取舍**：现有 `#gateBar`（15 gate chips + stock pill，前会话）vs UI 设计师新给的 `mp-status-strip`（3 gate + 引擎药丸 + 运行计数，更轻更用户语言）。**建议**：以 UI 设计师的用户语言版为主骨架（4 token 最小集），把现有 15 gate chips 折叠进「展开明细」入口，二者合流为一套，避免双状态条并存。
2. **影子色**：用户视角 + UI 设计师都指向**琥珀/黄**为影子主色（与「正常绿」拉开），但产品经理沿用 states.js 的 #d97706——需确认 tokens.css 里 `--warn` 是否 #d97706，统一。
3. **影子↔生效切换交互**：维持「改 .env + 重启」还是做安全的一键切换？建议维持引导（低风险）。
