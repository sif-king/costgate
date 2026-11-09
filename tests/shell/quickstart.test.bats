#!/usr/bin/env bats

# BATS tests for scripts/quickstart.sh（I 判据「一条命令冷启」的判别器本身）
# Run with: bats tests/shell/quickstart.test.bats
#
# 为什么锁这几条：quickstart 是「第一笔真实账单」的唯一入口，它最容易在
# 后续重构里悄悄退化成人人爱写的那种 demo —— 跑一个假请求、打印一个写死的
# 数字、然后说成功。下面每条都钉住一个「不许退化」的语义：
#   1. 语法必须过（它是被用户第一条执行的脚本，行号错就全废）
#   2. 账本必须是「真读文件」，不是硬编码字符串
#   3. 请求成功但没落账时必须 exit 2（不许把「没记上」说成成功）
#   4. 不许交互式索要 key（零 key 冷启是本判据的立身之本）
#   5. --stop 在无 pid 记录时要体面退出（不是报错刷屏）
#   6. 收尾必须印出「接上你自己的工具」那一行（否则陌生人只看到脚本自己发的 pong）
#   7. 补装成功后要清掉自己隔离出来的半装目录（别在用户 clone 里留垃圾）

QS=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  QS="$PROJECT_ROOT/scripts/quickstart.sh"
  # 每个用例一个假 HOME：这些测试里只要有一条不小心走到主流程，就会真的装依赖、
  # 起两个常驻进程、往账本里写一行。2026-11-08 就发生过一次（见下面 --help 那条），
  # 它写的是老板的真实 HOME，还改了他的 providers.json。隔离不是洁癖，是止损。
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
}

@test "quickstart.sh exists and parses" {
  [ -f "$QS" ]
  run bash -n "$QS"
  [ "$status" -eq 0 ]
}

@test "ledger is read from the jsonl file, not hardcoded" {
  # 必须从 cost-ledger.jsonl 取最后一行
  run grep -c 'cost-ledger.jsonl' "$QS"
  [ "$status" -eq 0 ]
  run grep -q 'tail -1 "\$LEDGER"' "$QS"
  [ "$status" -eq 0 ]
}

@test "request ok but ledger unchanged must exit 2, not report success" {
  run grep -q '账本没多一行' "$QS"
  [ "$status" -eq 0 ]
  # 该分支内必须出现 exit 2
  run bash -c "awk '/账本没多一行/,/^fi\$/' '$QS' | grep -q 'exit 2'"
  [ "$status" -eq 0 ]
}

@test "no interactive API key prompt (zero-key cold start)" {
  run grep -qE 'read -p|read -r -p' "$QS"
  [ "$status" -ne 0 ]
}

@test "no-upstream path prints actionable guidance instead of faking success" {
  run grep -q '未找到任何零配置上游' "$QS"
  [ "$status" -eq 0 ]
}

@test "--stop exits 0 when no pid files exist" {
  local tmp
  tmp="$(mktemp -d)"
  HOME="$tmp" run bash "$QS" --stop
  [ "$status" -eq 0 ]
  rm -rf "$tmp"
}

@test "money-adjacent vars use braces so set -u never trips on unbound variable" {
  # 曾实测两处：`$MANAGER_PORT（pid` 与 `$n（pid` 被 bash 当成变量名的一部分
  run grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~\x00]' "$QS"
  [ "$status" -ne 0 ]
}

@test "dependency readiness requires the npm lock sentinel, not the directory" {
  # 只用 -d node_modules 判就绪 → 装到一半被打断后，之后每次运行都跳过安装，
  # 用户永久卡在 Cannot find module（2026-11-07 实测：128 包、缺 axios、无锁文件）。
  run grep -qF 'deps_ready() { [ -f "$1/node_modules/.package-lock.json" ]; }' "$QS"
  [ "$status" -eq 0 ]
  run grep -qE '\[ -d "\$dir/node_modules" \]' "$QS"
  [ "$status" -ne 0 ]
}

@test "install is re-verified after wait and retried once" {
  # npm 可能返回 0 却没写全 → 不许只凭退出码判成功，必须按落盘标记复核并补装一次
  run grep -qF 'wait "${pids[$idx]}" || true' "$QS"
  [ "$status" -eq 0 ]
  run grep -qF '补装一次' "$QS"
  [ "$status" -eq 0 ]
}

@test "retry isolates the half-installed node_modules before rebuilding" {
  # 半装残留会让重装撞 ENOTEMPTY（实测卡在 playwright 的 rename），
  # 所以补装前必须先 mv 隔离，否则「补装」是一句空话
  run grep -qF 'node_modules.partial-' "$QS"
  [ "$status" -eq 0 ]
}

# ---- 2026-11-08: Ollama 分支实测发现的两个坑 ----

@test "token budget is big enough for thinking models (>=256)" {
  # 中文口径：qwen3 这类思考模型会先花 30-40 token 在内部推理上。
  # 预算 32 时 content 是空串（实测 completion_tokens=32 全在 reasoning），
  # 512 时正常返回 "pong"。所以这里禁用 <=32 的小预算。
  run grep -oE 'max_tokens: *[0-9]+' "$QS"
  [ "$status" -eq 0 ]
  n="$(echo "$output" | grep -oE '[0-9]+' | head -1)"
  [ -n "$n" ] || { echo "cannot find max_tokens" >&2; return 1; }
  [ "$n" -ge 256 ] || { echo "max_tokens=$n is too small for thinking models" >&2; return 1; }
}

@test "response parser recognizes Ollama's 'reasoning' field" {
  # 中文口径：Ollama 的 OpenAI 兼容层把思考内容放在 message.reasoning，
  # 不是 DeepSeek 的 reasoning_content。少认一个字段就会显示空回复。
  # 注意用 -F 匹配完整回退链：`m.reasoning` 是 `m.reasoning_content` 的子串，
  # 只 grep 后者会让「删掉 reasoning 回退」这种回归静默通过（踩过）。
  run grep -F 'm.reasoning_content||m.reasoning' "$QS"
  [ "$status" -eq 0 ]
}

@test "never prints an empty 'upstream replied' quote" {
  # 中文口径：content 为空时不许打印「上游回复：「」」——那看着像坏了，
  # 实际是思考模型把预算花在推理上。必须按 content/reasoning/empty 三种说话。
  run grep -q 'KIND' "$QS"
  [ "$status" -eq 0 ]
  run grep -qE 'case "\$KIND" in' "$QS"
  [ "$status" -eq 0 ]
  # kind 必须有三种取值：只留 content 一种的话，空回复又被打印成「回复：「」」
  run grep -qE 'kind=.*"reasoning".*"empty"' "$QS"
  [ "$status" -eq 0 ]
  # 允许的形态：ok 那行在 case 分支内（不在 case 外无条件出现）
  run grep -cE '上游回复：「\$\{REPLY\}」' "$QS"
  [ "$output" = "1" ] || { echo "unexpected number of reply printfs: $output" >&2; return 1; }
}

@test "Node minimum version is the same in install.sh, quickstart.sh and README" {
  # 中文口径：同一个项目不许有两个最低版本口径。2026-11-08 前 quickstart 写 18、
  # install.sh 写 20 —— 用户能冷启成功，接着跑 install.sh 却被拦下，看起来像安装器坏了。
  # 三处必须相等；改哪一处漏了另外两处，这条就变红。
  local q i r
  q="$(grep -oE '\[ "\$major" -ge [0-9]+ \]' "$QS" | grep -oE '[0-9]+' | head -1)"
  i="$(grep -oE '\[ "\$major" -lt [0-9]+ \]' "$PROJECT_ROOT/install.sh" | grep -oE '[0-9]+' | head -1)"
  r="$(grep -oE 'Node\.js [0-9]+\+' "$PROJECT_ROOT/README.md" | grep -oE '[0-9]+' | head -1)"
  for v in "$q" "$i" "$r"; do
    [ -n "$v" ] || { echo "cannot parse a minimum version (q=$q i=$i r=$r)" >&2; return 1; }
  done
  [ "$q" = "$i" ] || { echo "quickstart=$q install=$i —— 两处最低 Node 版本不一致" >&2; return 1; }
  [ "$q" = "$r" ] || { echo "quickstart=$q README=$r —— README 与脚本口径不一致" >&2; return 1; }
}

@test "ledger-stall error names the reused-manager cause first" {
  # 中文口径：2026-11-08 实测踩到——复用了一个用别的 HOME 起的 manager，
  # 账落在它自己的目录里，脚本却报「账本链断在代理→manager」，把人引去查 reportUsage。
  # 所以：① 复用当场就说清「它写它自己的数据目录」；② 账本不涨时把这条排在第一条。
  run grep -q '复用的是已在运行的实例' "$QS"
  [ "$status" -eq 0 ]
  run grep -q '复用了已在运行的 manager' "$QS"
  [ "$status" -eq 0 ]
  local reuse_line log_line
  reuse_line="$(grep -n '复用了已在运行的 manager' "$QS" | cut -d: -f1 | head -1)"
  # 锚点用 '# reportUsage' 而不是具体日志名：日志名现在随 MP_QS_CLIENT 变（codex/claude）
  log_line="$(grep -n '# reportUsage' "$QS" | cut -d: -f1 | head -1)"
  [ -n "$reuse_line" ] && [ -n "$log_line" ] || { echo "锚点找不到" >&2; return 1; }
  [ "$reuse_line" -lt "$log_line" ] || { echo "复用这条没排在排查第一条（$reuse_line vs $log_line）" >&2; return 1; }
}

@test "claude client mode exists and is wired end to end (not just a label)" {
  # 中文口径：Claude Code 用户是最大的一拨，但 2026-11-08 前 quickstart 只会起
  # codex-proxy —— 他们要么自己拼 providers.json，要么放弃。加 MP_QS_CLIENT=claude
  # 之后，下面每一处都必须真的跟着变，否则就是「改了标签仍然走 codex」的假功能：
  #   ① 端口/目录/日志名来自 CLIENT 分支
  #   ② Anthropic wire 要打 /v1/messages（不是 chat/completions）
  #   ③ 解析器要认 content[] 分块与 input/output_tokens
  run grep -q 'MP_QS_CLIENT:-codex' "$QS"; [ "$status" -eq 0 ]
  run grep -q 'PROXY_DIR="claude-proxy"' "$QS"; [ "$status" -eq 0 ]
  run grep -q 'PROXY_DIR="codex-proxy"' "$QS"; [ "$status" -eq 0 ]
  # 目录必须参数化：写死 codex-proxy 会让 claude 模式装错依赖/起错进程
  run grep -q 'start_svc "$ROOT/$PROXY_DIR"' "$QS"; [ "$status" -eq 0 ]
  run grep -q '"$ROOT/$PROXY_DIR:$PROXY_LABEL"' "$QS"; [ "$status" -eq 0 ]
  # 两种 wire 的地址
  run grep -q 'REQ_URL="http://127.0.0.1:$PROXY_PORT/v1/messages"' "$QS"; [ "$status" -eq 0 ]
  run grep -q 'REQ_URL="http://127.0.0.1:$PROXY_PORT/v1/chat/completions"' "$QS"; [ "$status" -eq 0 ]
  # 解析器认 Anthropic 的字段
  run grep -q 'u.input_tokens' "$QS"; [ "$status" -eq 0 ]
  run grep -q 'b.type==="text"' "$QS"; [ "$status" -eq 0 ]
}

@test "unknown MP_QS_CLIENT fails loudly instead of silently falling back to codex" {
  # 拼错成 MP_QS_CLIENT=cladue 时静默走 codex，用户会以为自己在测 claude 链路。
  run grep -q '不认识（只支持 codex / claude）' "$QS"
  [ "$status" -eq 0 ]
  run env MP_QS_CLIENT=cladue bash "$QS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"不认识"* ]] || { echo '断言不成立: [[ "$output" == *"不认识"* ]]' >&2; return 1; }
}

# ---- 2026-11-08: 这条测试自己闯的祸，也是它自己该防的 ----

@test "--help prints usage and touches nothing (no install, no processes, no ledger)" {
  # 中文口径：之前这条测试写的是 `run bash "$QS" --help`，而脚本只认 --stop ——
  # 于是 --help 被当成普通冷启：装依赖、起两组常驻进程、发一条真实请求、改
  # providers.json、往账本写一行。用的还是真实 HOME。
  # 后果不是「慢」：后台 daemon 继承了 bats 的 fd 3，所有用例都打印 ok 之后终端死等
  # （2026-11-08 老板终端实测卡死在第 28 条之后）。
  # 现在：--help 必须 1 秒内返回 0，且不产出任何数据文件。
  run bash "$QS" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"用法"* ]] || { echo '断言不成立: [[ "$output" == *"用法"* ]]' >&2; return 1; }
  [ ! -e "$HOME/.multi-proxy-manager" ]
}

@test "unknown flag exits 1 with usage instead of silently starting a cold start" {
  # 宽容地忽略未知参数 = 沉默地干了别的事。--hlep 这种拼错必须当场停。
  run bash "$QS" --hlep
  [ "$status" -eq 1 ]
  [[ "$output" == *"不认识的参数"* ]] || { echo '断言不成立: [[ "$output" == *"不认识的参数"* ]]' >&2; return 1; }
  run bash "$QS" --stop extra
  [ "$status" -eq 1 ]
  [[ "$output" == *"只接受一个参数"* ]] || { echo '断言不成立: [[ "$output" == *"只接受一个参数"* ]]' >&2; return 1; }
  [ ! -e "$HOME/.multi-proxy-manager" ]
}

@test "daemons do not inherit the caller's stdout (piping the script must return)" {
  # 中文口径：常驻子进程攥着调用者的管道写端时，`bash scripts/quickstart.sh | tee x`
  # 永远不返回。所以 start_svc 必须 </dev/null 并关掉 3-9 号 fd。
  run grep -qF '</dev/null >>"$LOG_DIR/$logname.log" 2>&1 3>&-' "$QS"
  [ "$status" -eq 0 ]
}

# ---- 2026-11-08 干净 clone 冷启实测发现的三处 ----

@test "cold start ends by printing the line that connects your own tool" {
  # 中文口径：冷启的终点不该是「你看到了一笔脚本自己发的 pong」——陌生人真正要的是
  # 「我自己的工具开始记账」。所以收尾必须印出可粘贴的一行，而且端口取本次运行的
  # 变量（可能用 MP_QS_* 换过），印成写死的默认端口会把人指到别处。
  run grep -qF 'OPENAI_BASE_URL=http://127.0.0.1:%s/v1' "$QS"; [ "$status" -eq 0 ]
  run grep -qF 'ANTHROPIC_BASE_URL=http://127.0.0.1:%s' "$QS"; [ "$status" -eq 0 ]
  run grep -qF 'ANTHROPIC_MODEL=%s' "$QS"; [ "$status" -eq 0 ]
  # 不许写死默认端口（18790/18791 那套）
  run grep -qE 'BASE_URL=http://127\.0\.0\.1:1879[0-9]' "$QS"
  [ "$status" -ne 0 ]
  # Codex CLI 不认 OPENAI_BASE_URL，收尾必须点明去哪改，否则主力客户端用户白跑一趟
  run grep -q 'Codex CLI 不认它' "$QS"
  [ "$status" -eq 0 ]
}

@test "retry cleans up the half-install it isolated" {
  # 中文口径：实测首次 npm 失败后补装成功，但隔离出来的 node_modules.partial-*
  # 留在用户 clone 里（manager + 代理两份，百兆级）。那是脚本自己造的垃圾，
  # 不该让用户手工收拾；同时只许删它自己 mv 出来的那一个（带时间戳，非通配符）。
  run grep -qF 'rm -rf "$dir/$partial"' "$QS"; [ "$status" -eq 0 ]
  local ok_line rm_line
  ok_line="$(grep -nF 'if ! deps_ready "$dir"; then' "$QS" | cut -d: -f1 | head -1)"
  rm_line="$(grep -nF 'rm -rf "$dir/$partial"' "$QS" | cut -d: -f1 | head -1)"
  [ -n "$ok_line" ] && [ -n "$rm_line" ] || { echo "锚点找不到：ok=$ok_line rm=$rm_line" >&2; return 1; }
  # 清理必须在「补装后复核通过」之后；写在前头等于删了再装，自废
  [ "$rm_line" -gt "$ok_line" ] || { echo "清理写在补装复核之前（$rm_line vs $ok_line）" >&2; return 1; }
  # 不许直接对 node_modules 本体下手
  run grep -qF 'rm -rf "$dir/node_modules"' "$QS"
  [ "$status" -ne 0 ]
}

@test "first install failure shows npm's own error instead of hiding it in a log" {
  # 中文口径：干净 clone 实测，首次安装失败时屏幕只打「补装一次」，真正的
  # `ECONNREFUSED` 只写进日志文件。用户看到的是「这项目坏了」，其实是他的网络/代理。
  # 补装成功了也一样要把原因说出来——否则下一次没人知道为什么慢了一倍。
  run grep -q '首次安装没完成，npm 报的是' "$QS"; [ "$status" -eq 0 ]
  run grep -qF "grep -E '^npm (error|ERR)'" "$QS"; [ "$status" -eq 0 ]
}

@test "--watch actually catches a row someone else wrote" {
  # 中文口径：冷启结束时账本里那一笔是脚本自己发的 pong，只证明链路通。
  # 「我接上工具之后到底记没记上」原本只能自己翻 jsonl 或开面板猜。
  # --watch 把这件事变成当场判定——所以它必须真的能「等到」，而不是只打印一行提示。
  export MP_QS_WATCH_SECONDS=15
  local L="$HOME/.multi-proxy-manager/cost-ledger.jsonl"
  mkdir -p "$HOME/.multi-proxy-manager"; : >"$L"
  run bash -c "( sleep 2; printf '%s\n' '{\"agent\":\"claude-code\",\"model\":\"m\",\"prompt\":10,\"completion\":5,\"cost\":0,\"latencyMs\":42}' >>'$L' ) & bash '$QS' --watch"
  [ "$status" -eq 0 ]
  [[ "$output" == *"等到了"* ]] || { echo '断言不成立: [[ "$output" == *"等到了"* ]]' >&2; return 1; }
  # 必须把那一笔的归属和用量打出来，否则用户还是不知道是谁的账
  [[ "$output" == *"claude-code"* ]] || { echo '断言不成立: [[ "$output" == *"claude-code"* ]]' >&2; return 1; }
  [[ "$output" == *"15 tokens"* ]] || { echo '断言不成立: [[ "$output" == *"15 tokens"* ]]' >&2; return 1; }
}

@test "--watch reports the real port state, not the configured one" {
  # 中文口径：超时诊断曾写「本次代理是 127.0.0.1:18790」——那是**配置值**，
  # 不是现场。代理早被 Ctrl-C 掉时它会指着 18790 说「端口对不上吗」，
  # 而真正的问题是根本没进程在听。改成现场探测后，报的是实测结果。
  export MP_QS_WATCH_SECONDS=3 MP_QS_MANAGER_PORT=18998 MP_QS_CODEX_PORT=18999
  run bash "$QS" --watch
  [ "$status" -eq 1 ]
  [[ "$output" == *"18999"* ]] || { echo '断言不成立: [[ "$output" == *"18999"* ]]' >&2; return 1; }
  [[ "$output" == *"没在跑"* ]] || { echo '断言不成立: [[ "$output" == *"没在跑"* ]]' >&2; return 1; }
  # 超时不能只报「没等到」，必须给出下一步查什么
  [[ "$output" == *"config.toml"* ]] || { echo '断言不成立: [[ "$output" == *"config.toml"* ]]' >&2; return 1; }
}

@test "--watch never starts services or installs anything" {
  # 中文口径：--watch 是「盯账本」，不是「再冷启一次」。若它走到主流程，
  # 用户开两个窗口就会抢端口、重装依赖——这正是这类脚本最常见的自伤。
  local fn
  fn="$(awk '/^watch_ledger\(\) \{/,/^\}/' "$QS")"
  [ -n "$fn" ] || { echo "watch_ledger 函数不见了" >&2; return 1; }
  printf '%s' "$fn" | grep -qE 'start_svc|npm install|mkdir -p "\$DATA_DIR"' \
    && { echo "watch_ledger 里出现了起服务/装依赖的动作" >&2; return 1; } || true
  # 函数在 ⇒ 命令行必须能到（同 install-flags 那条纪律）
  # BSD grep 的 ERE 不支持 \s（会静默匹配不到，误判成「没接线」），用字符类
  run grep -qE '^[[:space:]]+--watch\)[[:space:]]+watch_ledger ;;' "$QS"
  [ "$status" -eq 0 ]
  run grep -q -- '--watch' "$QS"
  [ "$status" -eq 0 ]
}

# ---- 2026-11-09: 总时长是个会变的观测值，必须分段 ----

@test "cold start reports per-phase timing instead of one opaque total" {
  # 中文口径：这个脚本在本机测到过 7 / 11 / 13 / 14 / 26 / 62 / 97 秒。只报一个总数时，
  # 陌生人看到「97 秒」无法判断是自己的网络还是程序 —— 第一反应是「这项目坏了」。
  # 分段之后，「依赖安装」那段归他的网络（只在首次），其余三段归程序。
  run grep -qF 'LAP_LOG' "$QS"
  [ "$status" -eq 0 ]
  # 三段必须真的被记录，而不是只定义了个没人调的函数
  run grep -cF 'lap "' "$QS"
  [ "$output" -ge 3 ] || { echo "lap 只被调用 $output 次，分段没接上" >&2; return 1; }
  # 依赖安装这段必须单独成段：它正是随网络大幅波动的那一段
  run grep -qF 'lap "依赖安装"' "$QS"
  [ "$status" -eq 0 ]
  # 换行必须用 $'\n' 拼在外面：命令替换 $(printf '...\n') 会吃掉尾随换行，三段会粘成一行
  run grep -qF "\$'\\n'" "$QS"
  [ "$status" -eq 0 ]
}
