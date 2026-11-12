<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 改这张表 —— 「我想改 X，该动哪几个文件」

这份文件只干一件事：把「我想改点什么」翻译成「改哪几个文件 + 哪条守卫会变红 + 怎么一分钟自证」。

它**不描述代码库**（那是 `docs/00-codebase-map.md` 的事，而且那种描述每次提交都在变旧）。
它只回答一个动作：**动手前该打开哪个文件。**

---

## 先说三条规矩（比表格重要）

1. **改之前先说出「哪条守卫会变红」。** 说不出来，说明这件事还没想清楚该落在哪——
   先别写代码，先想清楚「怎么证明它改对了」。
2. **没有守卫的功能等于假功能。** 本仓真实踩过：面板门控条展示的开关状态和真正的判定逻辑
   是两套代码，条上说「已开启」，实际根本没生效。补上 `multi-proxy-manager/lib/gates.js` 单一真源后才有救。
3. **每条守卫必须做过注入回归。** 把实现删掉、跑一遍、确认它真的红、并指出是哪个文件。
   没做过这一步的守卫，很可能只是因为「正好没匹配上」而常年绿着（本仓踩过两次：
   BSD grep 不认 BRE 的 `\|`，导致失败分支永远不触发，自检永远打印「通过」）。

---

## 表格

| 我想改… | 改这几个文件 | 哪条守卫会红 | 一分钟自证 |
|---|---|---|---|
| README / 对外文档的**结构**（架构图、对比表、导航、边界章节） | `README.md` + `docs/12-docs/DOCS-METHODOLOGY.md`（规则真源，改稿前先读）。**细节超载时拆到** `docs/08-user/connect-tools.md`（各工具接线）/ `docs/08-user/self-verify.md`（自查怎么验）/ `docs/04-tech/implementation-notes.md`（内部机制），README 只留一句摘要 + 链接 | `tests/shell/readme-structure.test.bats`（结构：图在不在前 200 行、对比对象有没有出处、边界章节有没有被删、**README 是否 ≤450 行**、拆分文件是否还在且仍被 README 链接）+ `tests/shell/readme.test.bats`（事实：引用的路径/脚本/参数存不存在、示例输出与脚本是否一致；**后者的断言同时覆盖上述三个拆分文件**，否则拆完就变成「检查空集」，绿着但什么都不保护） | `bats tests/shell/readme-structure.test.bats tests/shell/readme.test.bats`；**必须做过注入回归**（2026-11-12 四条全实测变红）：① mermaid 改普通代码块 ② 删对比对象出处行 ③ 把 README 撑过 450 行 ④ 删掉 `connect-tools.md` 里的 Codex `config.toml` 片段 |
| 某个开关（`PROXY_*` 门控）的语义/默认态 | `multi-proxy-manager/lib/gates.js`（唯一真源）+ 该门控 `source` 字段指向的实现文件 + `multi-proxy-manager/routes/meta.js` | `multi-proxy-manager/tests/unit/gates.test.js` | `curl -s localhost:18792/api/gates \| grep -A3 <名字>`，条上写什么必须和源码判定一致 |
| 面板某页的数据、三态、加载顺序 | `multi-proxy-manager/public/<页>.html` + `multi-proxy-manager/public/states.js` + `multi-proxy-manager/public/gatebar.js` + `multi-proxy-manager/public/nav.js` | `multi-proxy-manager/e2e/smoke.spec.js`、`multi-proxy-manager/e2e/gatebar.spec.js`、`multi-proxy-manager/e2e/page-data.spec.js`、`multi-proxy-manager/e2e/spa-views.spec.js` | `cd multi-proxy-manager && npx playwright test e2e/smoke.spec.js --headed`（**必须先 `seedAuth(page)`**，否则测的是登录页） |
| 侧栏**导航结构**（哪些是页面、哪些是页内 tab、代理列表折没折叠） | `multi-proxy-manager/public/nav.js`（`GROUPS` / `SPA_VIEWS`，全站单一真源）+ `multi-proxy-manager/public/dashboard.html`（页内 tab 容器 `#viewTabs` 与委托监听） | `multi-proxy-manager/tests/unit/frontend/nav-ia.test.js`（静态判：子视图不许回侧栏、代理默认折叠、tab 在首个页面之前、点击走委托）+ `multi-proxy-manager/e2e/spa-views.spec.js`（真浏览器点一遍） | `cd multi-proxy-manager && npx jest tests/unit/frontend/nav-ia.test.js`；**注入回归**：把 `health` 加回 `GROUPS` → 必须红；去掉 `proxyCollapsed: true` → 必须红 |
| 代理怎么转发、怎么记账 | `<代理>/proxy.js`（注意：chat / messages / responses **三条分支各自**要 `reportUsage`）+ `<代理>/routing-policy.js` | `tests/shell/responses-accounting.test.bats`、`multi-proxy-manager/tests/unit/codex-proxy-responses.test.js` | `bash scripts/verify-lanes.sh <代理>`，看到真 `usage` 才算通 |
| 端口 | `manage.sh`（`SERVICES` + `<服务>_PORT` 是关键真源）、`<代理>/.env.example`、代理源码里的默认值 | `multi-proxy-manager/tests/unit/proxy-default-ports.test.js` | 三方对拍：manage.sh 的 `*_PORT` = 源码默认值 = `.env.example`，且两两不重复 |
| 冷启（一条命令看到第一笔账单）/ 等你自己那笔账 | `scripts/quickstart.sh`（`--watch` 也在里面：它只盯账本，绝不起服务） | `tests/shell/quickstart.test.bats` | `HOME=$(mktemp -d) bash scripts/quickstart.sh`，看它自己报的分段耗时与账本最后一行；接上工具后再跑 `bash scripts/quickstart.sh --watch`，应当场等到你那一笔 |
| 断言写法本身（什么样的断言不算守卫） | `tests/shell/` 下全部 `.bats` | `tests/shell/assertion-enforcement.test.bats` | 写一条不带 `\|\| { …; return 1; }` 的 `[[ ]]` 断言，这条守卫必须红（裸 `[[ ]]` 在本机 bats 里中途失败会被静默吞掉） |
| 安装 / 卸载 / 单装某个代理 | `install.sh`（卸载是它的 `--uninstall`，不是独立脚本）、`manage.sh` | `tests/shell/install-flags.test.bats`、`tests/shell/uninstall-safety.test.bats`、`tests/shell/manage.sh.test.bats`、`tests/shell/stop-service.test.bats` | `bash install.sh --help` 里出现的每个 `--xxx` 都必须有对应分支（守卫钉的就是这条）；卸载先跑 `--uninstall --dry-run` |
| 给某个服务加/删依赖（或「别人装不上、我这好好的」） | `multi-proxy-manager/package.json` + `multi-proxy-manager/package-lock.json`（**两份必须同步**，否则 CI 的 `npm ci` 在装依赖那一步就红，而本地因为 node_modules 已存在完全看不出来）+ 各代理目录下同名的两份 | `scripts/check-prod-deps.js`（开发工具混进 dependencies / 没人 require 的孤儿包）+ `tests/shell/prod-deps.test.bats` | `node scripts/check-prod-deps.js`；改完 package.json 必须跑 `npm install --package-lock-only` 同步 lock。2026-11-09 实测踩过：playwright 长期躺在 manager 的 dependencies 里，唯一引用者是入库的一次性目检脚本，于是每个新用户 `npm install --omit=dev` 多下 18MB（26MB 的 69%）还要赌一次浏览器下载 |
| 镜像的构建上下文（COPY 的源到底在不在） | `Dockerfile.*` + `.dockerignore` | `tests/shell/docker-context.test.bats`（CI shell job 里另有一 step 直接跑） | `node scripts/check-docker-context.js`：应报「没有新问题」；已知债登记在 `scripts/docker-context-allow.txt`，每次都会打印，不是开关。**这类失败只对外部用户出现**：`cursor-proxy/dist` 是 tsc 产物、既不入库又被 `.dockerignore` 的 `dist` 排除，从干净 clone `docker build` 必失败，而维护者本机永远看不出 |
| 不出网的自检（不给网络也能验） | `scripts/verify.sh` | `tests/shell/verify.test.bats` | `bash scripts/verify.sh` —— 它和 `verify-lanes.sh` 刻意分开：这个不出网，那个必须联网 |
| 「装好的命令到底能不能跑」 | `scripts/doctor.sh` + `runtime-probes.json`（声明外部命令，`optional: true` = 没装不算红、装了跑不动必红） | `tests/shell/doctor.test.bats`、gap-guard 的 G8（项目外，见 agent-infra 库） | `bash scripts/doctor.sh` —— 它会真跑每条命令并检查退出码；**rc=137 单独点名**（签名证书被吊销 / OOM / 沙箱拒绝） |
| 「推上去 CI 会不会红」 | `scripts/preflight.sh`（本地跑 CI 调的同一批脚本：drift-check / verify-delivery / check.sh / 版权头 / bats / dep-audit；外加**干净 checkout 复现**） | `tests/shell/preflight.test.bats` | `bash scripts/preflight.sh`（默认跳过版权头全树扫描，`--full` 才跑）—— 2026-11-09 P0 Security Gate 连红四天没人发现，就是因为本地没有这个入口。**第二层坑**：drift-check 本地连绿、CI 连红，因为本地磁盘上有不入库的私有件 ⇒ 0 号步骤改用 `git worktree` 建干净 checkout（HEAD + 工作区改动）再跑一遍，凡「答案取决于树里有什么」的检查必须在两边同形 |
| 「本地绿、CI 红」这类只在一边出现的红灯 | `scripts/preflight.sh` 的干净 checkout 步骤 | `tests/shell/preflight.test.bats`（注入「跳过 0 号步骤」→ 2 条同时红） | `bash scripts/preflight.sh --quick`；看不到「干净 checkout：<sha>」那行就说明没真跑 |
| 改过项目以外的东西（第三方 app / 系统目录） | `outward-mutations.json`（台账）+ 对应的回滚脚本 | `tests/shell/doctor.test.bats`、gap-guard 的 G9（项目外，见 agent-infra 库） | `bash scripts/rollback-chatgpt-shim.sh --dry-run` 先看它会做什么；台账 `rehearsed` 留空即 P0 |
| CI 里的质量落差扫描（按模块分层） | `scripts/gap-guard-ci.sh` + 各子模块的 `gap-guard.json` | `tests/shell/gap-guard-ci.test.bats` | `bash scripts/gap-guard-ci.sh` —— 根跑全部规则（含项目级的 G8/G9），子模块只跑 G1-G4+G7。`gap-guard.json` 里写 `"panelDir": null` 表示本项目**没有**面板（显示「不适用」），与「配错路径导致未扫描」是两件事 |
| 链路自证脚本 | `scripts/verify-lanes.sh` | `tests/shell/verify-lanes.test.bats` | `bash scripts/verify-lanes.sh` 应全绿；跑完 `lsof -nP -iTCP:18900-18999 -sTCP:LISTEN` 必须为空（不许留孤儿） |
| README 对外的说法 | `README.md` | `tests/shell/readme.test.bats` | 说了「支持 X」就必须能指出实测证据；说不了的写进「还差什么」 |
| 对外文档**读起来像不像 AI 写的**（句子层 D1–D10：破折号、反问、元话语、套话、直角引号、判断式开头、绝对化词、计数套话、超长段） | `README.md` + 对外文档全集 + `docs/12-docs/DOCS-METHODOLOGY.md` §7（判据、阈值、118 篇成稿的基线都在这里；词表在脚本里，文档不抄） | `scripts/check-doc-tone.js`（接在 `scripts/preflight.sh` 6d；白名单 `scripts/doc-tone-allow.txt` 需写理由；逐条引用坏句子用 `<!-- doc-tone:off -->` 包起来）+ `tests/shell/doc-tone.test.bats`（注入 D1/D8/D9 必须变红；D7 是趋势项不许改成硬性；FAQ 段落不算判断式开头） | `node scripts/check-doc-tone.js`；改哪条判据就跑 `node scripts/check-doc-tone.js <文件> --explain D6` 看逐条命中 |
| 桌面壳的**应用身份**（名字 / bundle id / 图标 / 版本号来源） | `client/src/Info.plist`、`client/build.sh`、`client/src/main.swift`、`client/tools/make-icon.swift`（图标可复现，不是贴一张 png） | `tests/shell/app-brand.test.bats` | `bash client/build.sh` 后 `/usr/libexec/PlistBuddy -c "Print :CFBundleName" client/build/costgate.app/Contents/Info.plist` 必须是 `costgate`；产物里的 `costgate.icns` 必须存在（缺了就退回默认图标） |
| cursor 的上游、密钥、模型 | `cursor-proxy/src/server/handlers/chatHandler.ts`、`cursor-proxy/src/server/routes/adminRoutes.ts`、`cursor-proxy/src/db/database.ts`、`cursor-proxy/src/utils/crypto.ts`、`cursor-proxy/src/providers/base.ts` | `cursor-proxy/tests/unit/upstream-auth-header.test.ts`、`cursor-proxy/tests/unit/admin-provider-delete.test.ts`、`cursor-proxy/tests/unit/key-decrypt-failure.test.ts` | `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest -w 1 --forceExit`（不加这个 NODE_OPTIONS 会起不来） |
| 账本落盘格式与读法 | `multi-proxy-manager/routes/cost-report.js`、`multi-proxy-manager/lib/cost-track.js` | `multi-proxy-manager/tests/unit/cost.test.js`、`multi-proxy-manager/tests/unit/cost-track.test.js` | 打一条真请求，看 `~/.multi-proxy-manager/cost-ledger.jsonl` 是不是**多了一行**（不是「文件存在」） |
| 后台常驻 / 开机自启 | `tools/` 下的 plist、`manage.sh` | `tests/shell/manage.sh.test.bats` | 改 `tools/*.plist` 对在跑的服务无效——先看部署副本 `~/Library/LaunchAgents/` |

---

## 加完东西之后（收口自检）

改完任何一格，跑这三条：

```bash
# 1. 只跑你动过的那一格对应的守卫（别一上来跑全量，全量要 10 分钟）
bats tests/shell/<那条>.test.bats

# 2. 注入回归：把实现删掉，确认它真的会红
#    （不红 = 这条守卫没在看这件事，等于没有）

# 3. 收口：确认没把内部资产带进公开树
git ls-files | grep -E "UI-AUDIT|MEMORY\.md\.bak|外部对照"   # 必须为空
```

---

## 这张表自己也会过期 —— 所以它自带守卫

`tests/shell/change-map.test.bats` 钉三件事：

1. 表里提到的每个文件路径**必须存在**。删了文件却没改这张表 → 红。
2. 表里提到的每条守卫**必须存在**。
3. `tests/shell/` 下每一条 `.bats` **都必须在这张表里出现**。
   新增守卫却不登记 → 红（否则半年后又变成「一堆测试但没人知道它们守的是什么」）。

这就是这份文件和 `docs/00-codebase-map.md` 的区别：那份是拍照，这张是接线图——
线断了会亮灯。
