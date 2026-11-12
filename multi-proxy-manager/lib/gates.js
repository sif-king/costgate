// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ==================== 能力门控唯一真源（gates registry） ====================
// 起因（2026-10-24 外部审计）：用户装完包抱怨「README 承诺的功能是假的」。
// 真相是这些能力**代码都在**，但按非侵入铁律默认门控关闭（gate: closed），
// 而面板上没有任何一处告诉用户「你现在是关着的」——于是「未开启」被读成「没做」。
//
// 本文件把「有哪些门控 / 各自默认开还是关 / 怎么开」集中到一处，供
// `GET /api/gates` 与面板顶部状态条消费。设计约束：
//
//   1. 只登记、不改判定：本文件不重写各模块的门控判定逻辑，也不接管它们的 env 读取。
//      每个 gate 用 `kind` 声明它属于哪一族判定范式，reader 按范式求值，
//      并在 `source` 里标注真正的判定落点（file:line），改判定的人能顺藤摸到。
//   2. 防漂移：判定范式共四种（opt-in / opt-out / opt-out-off-only / strict-1，
//      见下方 READERS——第四种是对拍 cost-track 逼出来的，别合并）。凡导出
//      `enabled()` 的模块（cost-track、redact），单测用 `crossCheck` 拿模块自身
//      的判定与本表对拍，两处不一致即测试红——这是把「状态条说谎」变成可测故障。
//   3. 读不到就说读不到：跨进程的门控（cursor-proxy 持有）本进程读不到，
//      标 `observable: false` + `null`，不许拿默认值冒充当前值。
//   4. 开着 ≠ 跑过（2026-11-08 新增）：`evidenceKey` 声明这一项有没有**运行证据**可采
//      （真入账几笔 / 真命中几次）。本文件只登记 key，不读盘——采集在 lib/gate-evidence.js，
//      由 GET /api/gates 组合。保持本文件是纯注册表，可测、无 IO、无副作用。
//      没有采集点的项 evidenceKey 为 null，面板写「无运行证据采集点」，那不是「没跑过」。
//   5. scope 有两个用途，别混：①「这一项由哪个进程持有」（cursor-proxy 等）；
//      ② 测试校验 source 路径时的基准（有 scope ⇒ 相对仓库根，无 ⇒ 相对 multi-proxy-manager/）。
//      所以 packs/ 下的门控也要写 scope:'repo'——那不代表它不由 manager 持有。

const OPT_IN = ['1', 'true', 'on'];
const OPT_OUT_OFF = ['0', 'false', 'off'];

function readEnv(name) {
  return String(process.env[name] ?? '').trim().toLowerCase();
}

// 四种范式不是我拍的，是被 `tests/unit/gates.test.js` 的 crossCheck 逼出来的：
// 原先只归了三种，对拍 cost-track.enabled() 时发现它**只认 'off'**，而 redact
// 认 0/false/off——同属「默认开」的两兄弟判定并不一致。与其抹平这个不一致
// （那要改热路径语义），不如如实登记成两种范式，让状态条照实说。
const READERS = {
  // 默认关，显式 1/true/on 才开（绝大多数门控）
  'opt-in': (env) => OPT_IN.includes(readEnv(env)),
  // 默认开，显式 0/false/off 才关（redact：T7 拍 A 的默认开）
  'opt-out': (env) => !OPT_OUT_OFF.includes(readEnv(env)),
  // 默认开，**只有显式 'off' 才关**（cost-track：OOBE 红线，'0'/'false' 仍算开）
  'opt-out-off-only': (env) => readEnv(env) !== 'off',
  // 严格只认 '1'（历史包袱：MCP 注入门控写成 String(env||'0') === '1'）
  'strict-1': (env) => readEnv(env) === '1',
};

const GATES = [
  {
    id: 'orchestration',
    env: 'PROXY_ORCHESTRATION',
    label: 'L2 编排引擎',
    group: '编排',
    kind: 'opt-in',
    source: 'routes/orchestration.js:143',
    impact: '关闭时编排路由一律 403；开启后 L2 才真实接管流量（默认仍 shadow，只记账不动路由）。',
    // 影子门控：开启 ≠ 已生效——只记账不动路由。状态条照实标「影子·只记录」(琥珀)，
    // 避免「绿=已生效」的误读(正是 N-04 要消除的那类落差·影子主色=琥珀，决策②)。
    shadow: true,
  },
  {
    id: 'route-override',
    env: 'PROXY_ROUTE_OVERRIDE',
    label: '路由接管（真人路由）',
    group: '编排',
    kind: 'opt-in',
    scope: 'cursor-proxy',
    observable: false,
    source: 'cursor-proxy/src/server/handlers/chatHandler.ts:39',
    impact: '引擎路由建议是否接管真实路由。默认 0 = 只建议不动流量（非侵入铁律）。',
  },
  {
    // 2026-11-13 补登记：这个门控从 10-12 P6 起就在 codex-proxy 主路径上判，
    // 但一直没进本表 ⇒ 面板门控条看不见它，用户只能靠读源码才知道「模型级白名单」存在。
    // 与 sandbox-egress 漏登记同一条教训：状态条漏一层，和它说谎等价。
    id: 'routing-policy',
    env: 'PROXY_ROUTING_POLICY',
    label: '模型级路由策略',
    group: '编排',
    kind: 'opt-in',
    scope: 'codex-proxy',
    observable: false,
    source: 'codex-proxy/proxy.js:251',
    impact: '关闭时恒走网关路由（proxy，即今天的行为）。开启后按 routing-policy.json 逐 model 决定 proxy / direct / deny 三种动作。',
  },
  {
    id: 'llm-decompose',
    env: 'PROXY_LLM_DECOMPOSE',
    label: 'LLM 任务拆解',
    group: '编排',
    kind: 'opt-in',
    source: 'routes/orchestration.js:152',
    impact: '关闭时走内置模板拆解（零外部依赖、可复现）；开启才调 LLM，失败会自动降级回模板。',
  },
  {
    id: 'l2-mcp',
    env: 'PROXY_L2_MCP',
    label: 'L2 插件适配注入',
    group: 'L2 能力',
    kind: 'strict-1',
    source: 'routes/mcp.js:47',
    impact: '关闭时 pluginRuntime 为空集；开启才把 3 个 L2 adapter 注册进插件运行时。',
  },
  {
    id: 'l2-skill',
    env: 'PROXY_L2_SKILL',
    label: 'Skill 服务',
    group: 'L2 能力',
    kind: 'opt-in',
    source: 'routes/skill-service.js:41',
    impact: '关闭时 skill-service 路由拒服务。',
  },
  {
    id: 'l2-skillhosts',
    env: 'PROXY_L2_SKILLHOSTS',
    label: 'Skill Hosts',
    group: 'L2 能力',
    kind: 'opt-in',
    source: 'routes/skill-hosts.js:25',
    impact: '关闭时 skill-hosts 路由拒服务。',
  },
  {
    id: 'l2-memory',
    env: 'PROXY_L2_MEMORY',
    label: '记忆合并',
    group: 'L2 能力',
    kind: 'opt-in',
    source: 'routes/memory-merge.js:28',
    impact: '关闭时 memory-merge 路由拒服务。',
  },
  {
    id: 'knowledge-base',
    env: 'PROXY_KNOWLEDGE_BASE',
    label: '知识库',
    group: 'L2 能力',
    kind: 'opt-in',
    source: 'routes/knowledge-base.js:33',
    impact: '关闭时 knowledge-base 路由拒服务；另需 PROXY_KNOWLEDGE_BASE_DIR 才落盘。',
  },
  {
    id: 'fs-observe',
    env: 'PROXY_FS_OBSERVE',
    label: '文件层观测',
    group: '账本主权',
    kind: 'opt-out',
    source: 'server.js:395',
    impact: '默认开（只读，不拦请求）。记「哪个 agent 改了哪些文件」到 fs-ledger.jsonl；关掉后 costgate today 的文件部分为空，请求账本不受影响。',
  },
  {
    id: 'cost-track',
    env: 'PROXY_COST_TRACK',
    label: '成本记账',
    group: '账本主权',
    kind: 'opt-out-off-only',
    crossCheck: 'lib/cost-track.js',
    source: 'lib/cost-track.js:67',
    evidenceKey: 'cost-ledger',
    impact: '默认开（OOBE 红线）。关闭后热路径不提取 usage，成本页自然为空表——不是功能没做。',
  },
  {
    id: 'cost-schedule',
    env: 'PROXY_COST_SCHEDULE',
    label: '成本定时调度',
    group: '账本主权',
    kind: 'opt-in',
    source: 'routes/alert.js:52',
    impact: '关闭时不起 timer（零副作用）；开启才按 PROXY_COST_SCHEDULE_INTERVAL_MS 周期采集。',
  },
  {
    id: 'health-alert',
    env: 'PROXY_HEALTH_ALERT',
    label: '健康告警',
    group: '稳定性',
    kind: 'opt-in',
    source: 'routes/alert.js:46',
    impact: '关闭时告警只走 observe（记录不动作）。',
  },
  {
    id: 'health-isolate',
    env: 'PROXY_HEALTH_ISOLATE',
    label: '故障隔离执行',
    group: '稳定性',
    kind: 'opt-in',
    source: 'lib/provider-health.js:91',
    impact: '关闭时只判定不隔离（observe）；开启才真把故障 provider 摘出路由。',
  },
  {
    // 2026-11-13 补登记：README 曾写「没有熔断」——不实。熔断在 codex-proxy / claude-proxy
    // 的主路径上是真的（per-provider 计数，5xx/429/408 才喂，4xx 不喂），只是默认关 + 默认
    // observe。默认关不等于不存在，漏登记会让读者得到和漏一层门控同样的错结论。
    id: 'circuit-breaker',
    env: 'PROXY_CIRCUIT_BREAKER',
    label: '上游熔断',
    group: '稳定性',
    kind: 'opt-in',
    scope: 'codex-proxy',
    observable: false,
    source: 'codex-proxy/proxy.js:424',
    impact: '关闭时每次转发都真打上游。开启后按 provider 记连续失败；PROXY_CIRCUIT_MODE=block 才返回 503 CIRCUIT_OPEN，默认 observe 只记账不拦。',
  },
  {
    id: 'sandbox-egress',
    env: 'PROXY_PACK_SANDBOX_EGRESS',
    label: '出网沙箱巡检',
    group: '安全',
    kind: 'opt-out',
    // packs/ 在仓库根，不在 multi-proxy-manager/ 下 ⇒ 需要 scope 当路径基准。
    scope: 'repo',
    source: 'packs/sandbox-egress/index.js:45',
    evidenceKey: 'egress-any',
    impact: '默认开（observe，只记账不落刀）。它是 redact 的外层门：关掉后出网脱敏与响应内高危 tool_use 巡检一起早退——只关 redact 关不掉这一层，所以两层都必须在册。',
  },
  {
    id: 'redact',
    env: 'PROXY_REDACT',
    label: '出网脱敏',
    group: '安全',
    kind: 'opt-out',
    crossCheck: 'lib/redact.js',
    source: 'lib/redact.js:44',
    evidenceKey: 'egress-outbound',
    impact: '默认开（T7 拍 A）。关闭后出网不再做敏感串替换（但外层 sandbox-egress 仍会巡检响应体）。',
  },
  {
    id: 'im-inbound',
    env: 'PROXY_IM_INBOUND',
    label: 'IM 入站',
    group: '集成',
    kind: 'opt-in',
    source: 'routes/im-inbound.js:31',
    impact: '关闭时 IM 入站路由拒服务。',
  },
  {
    id: 'executor-bind',
    env: 'PROXY_EXECUTOR_BIND',
    label: '执行器真绑定',
    group: '集成',
    kind: 'opt-in',
    source: 'routes/im-inbound.js:38',
    impact: '关闭时不触下游（不写 agent 文件、不真执行）。',
  },
];

// 求值一个门控。跨进程的（observable:false）返回 null——本进程读不到就说读不到。
function evaluate(gate) {
  if (gate.observable === false) {
    return { on: null, unknown: true, reason: `${gate.env} 由 ${gate.scope} 进程持有，manager 读不到` };
  }
  const reader = READERS[gate.kind];
  if (!reader) {
    return { on: null, unknown: true, reason: `未登记的判定范式: ${gate.kind}` };
  }
  return { on: reader(gate.env), unknown: false, reason: null };
}

function list() {
  return GATES.map((g) => {
    const e = evaluate(g);
    return {
      id: g.id,
      env: g.env,
      label: g.label,
      group: g.group,
      scope: g.scope || 'manager',
      defaultOn: String(g.kind).startsWith('opt-out'),
      observable: g.observable !== false,
      on: e.on,
      unknown: e.unknown,
      reason: e.reason,
      impact: g.impact,
      source: g.source,
      // 「怎么**改变**当前状态」——不是「怎么开启」。默认开的项若写成 =1 是句废话
      // （它本来就是开的），用户照着做不会有任何变化，还以为自己开成功了。
      // 所以按范式给出真正能翻转的那一条，并说明它是开还是关。
      toggleCmd: `${g.env}=${String(g.kind).startsWith('opt-out') ? '0' : '1'}`,
      toggleHint: String(g.kind).startsWith('opt-out')
        ? '（默认开启，这条是关闭方式）'
        : '（默认关闭，这条是开启方式）',
      // 影子门控（默认只记账不动路由）：true 时状态条标「影子·只记录」(琥珀)，
      // 避免绿色「已开启」被读成「已生效」(N-04 决策②·影子主色=琥珀)。非影子门控为 false。
      shadow: g.shadow === true,
      // 运行证据的采集键（null = 这项没有落点可采，面板写「无运行证据采集点」）。
      // 只声明不采集：采集由 lib/gate-evidence.js 做，本文件保持无 IO。
      evidenceKey: g.evidenceKey || null,
    };
  });
}

function summary() {
  const rows = list();
  const known = rows.filter((r) => r.observable);
  const on = known.filter((r) => r.on === true).length;
  // 「开箱默认」= 一个 opt-in 都没开。此时面板只做转发与观测，
  // README 里那些能力确实都在代码里，但都没对用户生效——必须直说，不能装作已交付。
  const optIns = GATES.filter((g) => !String(g.kind).startsWith('opt-out') && g.observable !== false);
  const optInsOn = optIns.filter((g) => READERS[g.kind](g.env)).length;
  return {
    total: rows.length,
    observable: known.length,
    on,
    off: known.length - on,
    unknown: rows.length - known.length,
    optInTotal: optIns.length,
    optInOn: optInsOn,
    // stock = 开箱默认态：所有 opt-in 全关。这是新用户装完包看到的真实状态。
    stock: optInsOn === 0,
  };
}

module.exports = { GATES, READERS, list, summary, evaluate };
