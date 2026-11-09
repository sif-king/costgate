#!/usr/bin/env bats

# BATS tests for manage.sh shell functions
# Run with: bats tests/shell/manage.sh.test.bats
#
# If bats is not installed, run: brew install bats-core
# Alternatively, run tests/shell/check.sh for basic bash syntax validation.

# ---- Setup: locate manage.sh ----

MANAGE_SH=""
PROJECT_ROOT=""

setup() {
  # Navigate up from this script to find manage.sh.
  # Per-test `setup` (not `setup_file`): Bats runs each @test in its own subshell,
  # and setup_file does NOT propagate MANAGE_SH into those subshells — that left
  # $MANAGE_SH empty inside tests and made grep fail with "No such file or directory".
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MANAGE_SH="$PROJECT_ROOT/manage.sh"

  if [ ! -f "$MANAGE_SH" ]; then
    echo "ERROR: manage.sh not found at $MANAGE_SH" >&2
    return 1
  fi

  # Source the script (but suppress output) so the helpers
  # (is_port_in_use / show_status / show_logs) are defined in each test.
  source "$MANAGE_SH" >/dev/null 2>&1
}

# ==== is_port_in_use ====

@test "is_port_in_use returns 0 for a port in use (well-known port 53 DNS)" {
  # Port 53 (DNS) is typically in use on macOS
  # Even if not, the function should return non-zero for free ports without erroring
  run is_port_in_use 53
  # Either 0 (in use) or 1 (free) is acceptable — just verify no crash
   # (127 = "command not found" = real crash; exclude it)
  [ "$status" -ne 127 ]
}

@test "is_port_in_use returns non-zero for a random high port" {
  # Port 49999 is very unlikely to be in use
  run is_port_in_use 49999
  # 必须真的非零。旧断言 `[ -ne 0 ] || [ -eq 0 ]` 恒真 —— 端口真被占了也测不出来。
  [ "$status" -ne 0 ]
}

@test "is_port_in_use handles invalid input" {
  run is_port_in_use "not_a_number"
   # Should not crash — invalid port makes lsof error → non-zero exit (fine).
   # 127 = "command not found" (a real crash); any other code is acceptable.
  [ "$status" -ne 127 ]
}

@test "is_port_in_use uses absolute lsof path" {
  # The script should use /usr/sbin/lsof not just lsof
  grep -q 'lsof' "$MANAGE_SH"
  local lsof_line
  lsof_line=$(grep -E '^\s+/usr/sbin/lsof|\\\$\{LSOF\}|lsof -i' "$MANAGE_SH" | head -1)
  # The key constraint from CLAUDE.md: lsof MUST use absolute path /usr/sbin/lsof
  echo "Verifying lsof usage in is_port_in_use..."
  true            # Just verify the function exists and references lsof
}

# ==== show_status ====

@test "show_status produces output with expected service names" {
  # Captures stdout and verifies format
  run bash -c "source '$MANAGE_SH' && show_status 2>/dev/null"

  # Should contain service name markers
  # Even if services aren't running, the heading should be present
  [[ "$output" == *"Proxy"* ]] || [[ "$output" == *"Manager"* ]] || [[ "$output" == *"Multi-Proxy"* ]] || { echo '断言不成立: [[ "$output" == *"Proxy"* ]] || [[ "$output" == *"Manager"* ]] || [[ "$output" == *"Multi-Proxy"* ]]' >&2; return 1; }
}

@test "show_status contains status indicators" {
  run bash -c "source '$MANAGE_SH' && show_status 2>/dev/null"

  # Should have ✓/✗ or similar status markers
  # At minimum, should have text output
  [ ${#output} -gt 0 ]
}

@test "show_status returns the count of services that are down" {
  # 中文口径：`manage.sh status` 以前无论挂几个都返回 0，于是
  # `manage.sh status && deploy` 永远放行——「全部未运行」被读成「一切正常」。
  # 这是「查失败 ≠ 没发现问题」那一类缺陷，必须钉住。
  # 🔴 取返回码必须写成 `rc=0; show_status || rc=$?`：manage.sh 第二行是 set -e，
  #    直接 `show_status; echo $?` 会让脚本在 show_status 返回非 0 时当场退出，
  #    echo 根本执行不到——测试本身也会变成「测了个空」。
  local n
  n="$(bash -c "source '$MANAGE_SH' >/dev/null 2>&1; set -- \$SERVICES; echo \$#" 2>/dev/null)"
  [ -n "$n" ] && [ "$n" -gt 0 ] || { echo "拿不到服务数" >&2; return 1; }

  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; is_port_in_use(){ return 1; }; rc=0; show_status >/dev/null 2>&1 || rc=\$?; echo \$rc"
  [ "$status" -eq 0 ]
  [ "$output" = "$n" ] || { echo "期望返回 $n，实际返回 $output" >&2; return 1; }
}

@test "show_status returns 0 when every service is up" {
  # 全部在跑时必须是 0，否则 shell 惯例被破坏（0 = 正常），
  # 会让 `manage.sh status` 在健康时反而报错。
  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; svc_port(){ echo 19999; }; is_port_in_use(){ return 0; }; pid_on_port(){ echo 1; }; rc=0; show_status >/dev/null 2>&1 || rc=\$?; echo \$rc"
  [ "$status" -eq 0 ]
  [ "$output" = "0" ] || { echo "期望返回 0，实际返回 $output" >&2; return 1; }
}

@test "every show_status call in the case block is set -e safe" {
  # 中文口径：manage.sh 开了 set -e。show_status 现在会返回非 0，
  # 除了 status 分支（要的就是这个退出码，必须显式捕获），其余调用点
  # 一律得带 `|| true`，否则 stop/start/restart/bootout 会在打完状态表前
  # 当场退出，`exit "$_rc"` 执行不到——退出码变成「未运行服务数」，
  # 那是错的（stop 之后服务本来就该是停的）。
  local bad
  bad="$(grep -nE '^[[:space:]]*show_status[[:space:]]*$' "$MANAGE_SH" || true)"
  [ -z "$bad" ] || { echo "发现裸 show_status 调用（set -e 下不安全）：$bad" >&2; return 1; }

  # status 分支必须显式捕获，不能靠 `exit $?`
  grep -qE 'show_status \|\| _rc=\$\?' "$MANAGE_SH" || { echo "status 分支未显式捕获退出码" >&2; return 1; }
  grep -qE '^[[:space:]]*exit[[:space:]]+"?\$_rc"?[[:space:]]*$' "$MANAGE_SH" || { echo "case 分支未用 \$_rc 退出" >&2; return 1; }
}

# ==== show_logs ====

@test "show_logs accepts valid proxy name arguments" {
  # The function should handle codex, hermes, cursor, manager, all
  for arg in codex hermes cursor manager all; do
    run bash -c "source '$MANAGE_SH' && show_logs $arg 2>&1"
    # 旧断言 `[ -eq 0 ] || [ -eq 1 ]` 对 0/1 全放行，等于没断言。
    # 收紧：退出码必须 < 2（1 表示"无日志"，2 以上才是用法/语法错误），
    # 且不能出现 bash 语法错误特征。
    [ "$status" -lt 2 ]
    [[ "$output" != *"syntax error"* ]] || { echo '断言不成立: [[ "$output" != *"syntax error"* ]]' >&2; return 1; }
    [[ "$output" != *"command not found"* ]] || { echo '断言不成立: [[ "$output" != *"command not found"* ]]' >&2; return 1; }
  done
}

@test "show_logs handles invalid argument gracefully" {
  run bash -c "source '$MANAGE_SH' && show_logs invalid_arg 2>&1"
  # 旧断言 `[ ${#output} -ge 0 ]` 恒真（字符串长度永远 >= 0）。
  # 收紧：非法参数必须被拒绝（非零退出）或给出可读的错误提示，
  # 且绝不能静默成功（那等于 invalid_arg 被当成合法代理名）。
  [ "$status" -ne 0 ] || [[ "$output" == *"invalid"* ]] || [[ "$output" == *"未知"* ]] || [[ "$output" == *"Usage"* ]] || [[ "$output" == *"用法"* ]]
}

# ==== General manage.sh structure ====

@test "manage.sh has expected functions defined" {
  # Verify key functions exist in the script
  grep -q 'is_port_in_use' "$MANAGE_SH"
  grep -q 'show_status' "$MANAGE_SH"
  grep -q 'show_logs' "$MANAGE_SH"
}

@test "manage.sh defines all four proxy ports" {
  # Codex: 18790, Hermes: 18793, Cursor: 18794, Manager: 18792
  grep -q '18790' "$MANAGE_SH"
  grep -q '18793' "$MANAGE_SH"
  grep -q '18794' "$MANAGE_SH"
  grep -q '18792' "$MANAGE_SH"
}

@test "manage.sh resolves lsof via absolute path first (ADR-0001 amended)" {
  # ADR-0001 (amended 2026-10-13 for cross-platform): launchd PATH may lack
  # /usr/sbin, so the macOS absolute path must be resolved FIRST; bare lsof is
  # allowed only inside the resolution block (command -v fallback for Linux);
  # every invocation goes through $LSOF.
  #
  # 2026-11-08：判据加一步「先去掉注释行」。守卫要管的是**会被执行**的调用，
  # 而注释里为了解释 -sTCP:LISTEN 这个坑必然会写出 `lsof -i` 的样子 ——
  # 第一版没剥注释，直接把说明文字判红了（假红）。
  grep -q '/usr/sbin/lsof' "$MANAGE_SH"
  local bare_invocations
  bare_invocations=$(grep -vE '^[[:space:]]*#' "$MANAGE_SH" \
    | grep -nE '(^|[^A-Za-z0-9_$/."-])lsof[[:space:]]+-' \
    | grep -v '\$LSOF' || true)
  # No bare (not via $LSOF) lsof invocations should exist
  [[ -z "$bare_invocations" ]] || { echo '断言不成立: [[ -z "$bare_invocations" ]]' >&2; return 1; }
}

# ==== N-4: unified-ingress must be a first-class member of the single SERVICES source (stop/start symmetry) ====

@test "N-4: SERVICES registry includes unified-ingress (single source for start/stop)" {
  # Source manage.sh (it returns before main) and read the SERVICES list.
  run bash -c "source '$MANAGE_SH' && printf '%s' \"\$SERVICES\""
  [[ "$output" == *"unified-ingress"* ]] || { echo '断言不成立: [[ "$output" == *"unified-ingress"* ]]' >&2; return 1; }
}

@test "N-4: start/stop/restart/bootout have unified-ingress handlers" {
  for fn in start_unified_ingress stop_unified_ingress restart_unified_ingress bootout_unified_ingress; do
    run grep -n "^${fn}()" "$MANAGE_SH"
    [ "$status" -eq 0 ]
  done
}

@test "N-4: run_target 'all' delegates to *_all helpers (single SERVICES source)" {
  run bash -c "source '$MANAGE_SH' && declare -f run_target"
  [[ "$output" == *"start_all"* ]] || { echo '断言不成立: [[ "$output" == *"start_all"* ]]' >&2; return 1; }
  [[ "$output" == *"stop_all"* ]] || { echo '断言不成立: [[ "$output" == *"stop_all"* ]]' >&2; return 1; }
  [[ "$output" == *"restart_all"* ]] || { echo '断言不成立: [[ "$output" == *"restart_all"* ]]' >&2; return 1; }
  [[ "$output" == *"bootout_all"* ]] || { echo '断言不成立: [[ "$output" == *"bootout_all"* ]]' >&2; return 1; }
}

@test "N-4: every *_all helper iterates the same SERVICES list (no asymmetry)" {
  run bash -c "source '$MANAGE_SH' && declare -f start_all restart_all stop_all bootout_all | grep -c 'in \$SERVICES'"
  [ "$status" -eq 0 ]
  [ "${output}" -ge 4 ]
}

@test "N-4: run_target 'all' no longer hardcodes the old 8-item list (asymmetry guard)" {
  run bash -c "source '$MANAGE_SH' && declare -f run_target"
  # The old all-branch enumerated each proxy explicitly (e.g. `start_codex || true`),
  # covering only part of the set and omitting unified-ingress. That exact pattern
  # must be gone; the all-branch now iterates SERVICES via the *_all helpers
  # (covered by the test above). Per-service dispatch (e.g. `manager)`) still calls
  # start_manager directly, so we only forbid the distinctive all-branch form.
  [[ "$output" != *"start_codex || true"* ]] || { echo '断言不成立: [[ "$output" != *"start_codex || true"* ]]' >&2; return 1; }
}

@test "N-4: show_logs all aggregates every SERVICES entry (dsh no longer omitted)" {
  # Regression guard for the original drift bug: the hand-written `all` log block
  # listed only 8 of 9 services and silently dropped DSH Proxy. Now `all` must loop
  # over SERVICES, so every member appears as a log-section header.
  run bash -c "source '$MANAGE_SH' && show_logs all"
  [ "$status" -eq 0 ]
  [[ "$output" == *"DSH Proxy 日志"* ]] || { echo '断言不成立: [[ "$output" == *"DSH Proxy 日志"* ]]' >&2; return 1; }
  [[ "$output" == *"Unified Ingress 日志"* ]] || { echo '断言不成立: [[ "$output" == *"Unified Ingress 日志"* ]]' >&2; return 1; }
  [[ "$output" == *"Codex Proxy 日志"* ]] || { echo '断言不成立: [[ "$output" == *"Codex Proxy 日志"* ]]' >&2; return 1; }
  [[ "$output" == *"Manager Shell 日志"* ]] || { echo '断言不成立: [[ "$output" == *"Manager Shell 日志"* ]]' >&2; return 1; }
}

@test "N-4: svc_logfile/svc_port/svc_title cover exactly the SERVICES set (no silent gap)" {
  # Every SERVICES member must have a logfile / port / title mapping. A future
  # service added to SERVICES without a matching helper branch returns empty and
  # trips this guard — preventing the next status/logs drift before it ships.
  run bash -c "source '$MANAGE_SH'; for s in \$SERVICES; do lf=\$(svc_logfile \"\$s\"); [ -n \"\$lf\" ] || { echo \"MISSING logfile: \$s\"; exit 1; }; p=\$(svc_port \"\$s\"); [ -n \"\$p\" ] || { echo \"MISSING port: \$s\"; exit 1; }; t=\$(svc_title \"\$s\"); [ -n \"\$t\" ] || { echo \"MISSING title: \$s\"; exit 1; }; done; echo COVERED"
  [ "$status" -eq 0 ]
  [[ "$output" == *"COVERED"* ]] || { echo '断言不成立: [[ "$output" == *"COVERED"* ]]' >&2; return 1; }
}

# ---- 2026-11-08: start all / --start 不许把失败说成成功 ----
# 旧实现 start_all 里是 `start_$s || true`，一个都起不来也返回 0；
# install.sh --start 据此无条件打印「所有服务已启动」，而屏幕上刚滚过的
# 全是「未安装」。这是最容易被当成「装好了」的假成功，必须钉住。

@test "start_all: all-fail reports the count and returns non-zero" {
  # 中文口径：全部起不来时必须数出来 + 返回非 0。用假服务名，不碰真服务。
  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; set +e; SERVICES='__nope_a__ __nope_b__'; start_all 2>/dev/null; echo rc=\$?"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2/2"* ]] || { echo '断言不成立: [[ "$output" == *"2/2"* ]]' >&2; return 1; }
  [[ "$output" == *"rc=1"* ]] || { echo '断言不成立: [[ "$output" == *"rc=1"* ]]' >&2; return 1; }
}

@test "start_all: empty list is success, not failure" {
  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; set +e; SERVICES=''; start_all; echo rc=\$?"
  [[ "$output" == *"rc=0"* ]] || { echo '断言不成立: [[ "$output" == *"rc=0"* ]]' >&2; return 1; }
}

@test "start_all: no '|| true' swallow (must count failures)" {
  # 中文口径：`|| true` 会让失败彻底消失，跑 grep 应该找不到它。
  run grep -F 'start_$s || true' "$MANAGE_SH"
  [ "$status" -ne 0 ]
}

@test "restart_all: no '|| true' swallow" {
  run grep -F 'restart_$s || true' "$MANAGE_SH"
  [ "$status" -ne 0 ]
}

@test "manage.sh start/restart propagate the real exit code (set -e safe)" {
  # 中文口径：set -e 下必须用 `|| _rc=$?` 捕获，且最后 exit "$_rc"。
  # 少了这一步，start_all 返回 1 会当场退出、连状态表都不给用户看。
  run bash -c "sed -n '/^  start)/,/^     ;;$/p' '$MANAGE_SH'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'_rc=0'* ]] || { echo "断言不成立：找不到 _rc=0 的写法" >&2; return 1; }
  [[ "$output" == *'|| _rc=$?'* ]] || { echo "断言不成立：找不到 || _rc=$? 的写法" >&2; return 1; }
  [[ "$output" == *'exit "$_rc"'* ]] || { echo "断言不成立：找不到 exit \"$_rc\" 的写法" >&2; return 1; }
}

@test "install.sh --start branches on real rc, never unconditional success" {
  # 中文口径：print_ok「所有服务已启动」必须在 if 的成功分支里，
  # 失败分支必须 exit 1。否则它就是在替一个没起来的系统报平安。
  INSTALL_SH="$PROJECT_ROOT/install.sh"
  body="$(sed -n '/^    --start)/,/^    --stop)/p' "$INSTALL_SH")"
  echo "$body" | grep -q 'if bash' || { echo "missing 'if bash manage.sh'" >&2; return 1; }
  echo "$body" | grep -q 'print_ok "所有服务已启动"' || { echo "missing success message" >&2; return 1; }
  echo "$body" | grep -q 'exit 1' || { echo "missing failure exit" >&2; return 1; }
  # print_ok 必须出现在 else 之前（真正在成功分支内）
  echo "$body" | awk '/print_ok "所有服务已启动"/{p=NR} /else/{e=NR} END{exit (p>0 && e>0 && p<e) ? 0 : 1}' \
    || { echo "print_ok is not inside the success branch" >&2; return 1; }
}

@test "port checks only count LISTEN (a client-side ESTABLISHED must not look busy)" {
  # 中文口径（2026-11-08 实测踩到）：`lsof -i :PORT` 会匹配**任何**涉及该端口的
  # socket，包括本机客户端连出去的短连接。实测 49999 上只有 Chrome→本地代理的
  # ESTABLISHED、没有任何 LISTEN，旧写法照样报「端口占用」。临时端口就在
  # 49152–65535，开着浏览器的机器上这不是小概率 —— 代理会起不来且看不出原因。
  #
  # 行为测试（`is_port_in_use 49999`）依赖环境：那个连接一断就变绿，靠不住。
  # 所以这里直接钉实现：lsof 必须带 -sTCP:LISTEN，/proc 必须只看状态 0A。
  run grep -q -- '-iTCP:"$port" -sTCP:LISTEN' "$MANAGE_SH"
  [ "$status" -eq 0 ] || { echo "is_port_in_use 的 lsof 没限定 LISTEN" >&2; return 1; }
  # pid_on_port 同病且更危险：不限定会返回「连过来的客户端」的 pid，kill 就是杀错。
  run grep -q -- '-tiTCP:"$port" -sTCP:LISTEN' "$MANAGE_SH"
  [ "$status" -eq 0 ] || { echo "pid_on_port 的 lsof 没限定 LISTEN" >&2; return 1; }
  # /proc/net/tcp 回退路径：第 4 列状态必须判 0A(LISTEN)，不能只 grep 端口
  run grep -q '\$4 == "0A"' "$MANAGE_SH"
  [ "$status" -eq 0 ] || { echo "/proc/net/tcp 回退没判 LISTEN 状态" >&2; return 1; }
}
@test "stop_all: all-fail reports the count and returns non-zero" {
  # 中文口径：与 start_all 同一口径。旧写法 `stop_$s` 不计失败，9 个服务里
  # 最后一个成功、前 8 个「停止失败」，照样 exit 0 —— 调用方就会印「全部已停止」。
  # 用假服务名，不碰真服务。
  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; set +e; SERVICES='__nope_a__ __nope_b__'; stop_all 2>/dev/null; echo rc=\$?"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2/2"* ]] || { echo '断言不成立：没数出失败个数' >&2; return 1; }
  [[ "$output" == *"rc=1"* ]] || { echo '断言不成立：全部停不掉却返回 0' >&2; return 1; }
}

@test "stop_all: nothing-to-do still returns 0 (idle system is not a failure)" {
  # 反向：所有服务都没在跑时 stop_service 返回 0（「未在运行」不是失败），
  # 不许因为「没东西可停」就报错 —— 那会让干净的机器上 stop all 永远红。
  run bash -c "source '$MANAGE_SH' >/dev/null 2>&1; set +e; SERVICES='__noop_ok__'; stop___noop_ok__() { return 0; }; stop_all 2>/dev/null; echo rc=\$?"
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]] || { echo '断言不成立：没有失败却返回非 0' >&2; return 1; }
}
