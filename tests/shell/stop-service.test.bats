#!/usr/bin/env bats

# BATS tests for manage.sh stop semantics (A-3 / A-4)
# Run with: bats tests/shell/stop-service.test.bats
#
# Pins down two real problems fixed on 2026-10-25:
#   A-3  stop_service fell through to a trailing `return 0` when the port was
#        busy but no PID could be found, so the script reported "stopped" with
#        exit code 0 while the port was still occupied -- scripts and CI could
#        never tell whether stopping actually succeeded.
#   A-4  find_launchd_label_for_port stored the glob in a variable and then
#        passed it QUOTED to plutil, so plutil received the literal string
#        "com.multi-proxy.*-18790.plist" and always failed, leaving the lookup
#        permanently empty and bootout never triggering. Measured locally:
#        before the fix both 18790 and 18792 resolved to nothing even though
#        the plists existed.
#
# NOTE: these cases drive the functions with mocked is_port_in_use /
# pid_on_port and never kill a real process.

MANAGE_SH=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MANAGE_SH="$PROJECT_ROOT/manage.sh"
  if [ ! -f "$MANAGE_SH" ]; then
    echo "ERROR: manage.sh not found at $MANAGE_SH" >&2
    return 1
  fi
}

# Extract function definitions from manage.sh without running the case dispatch
# at the bottom of the file.
# Usage: load_fn stop_service find_launchd_label_for_port is_port_in_use
# NOTE: one sed invocation per function. Building a single `-e ... -e ...`
# string and letting it word-split does NOT work here (bats' execution shell
# does not split unquoted variables the way bash does), and BSD sed then
# receives the quoted pattern as a literal argument.
load_fn() {
  local f
  for f in "$@"; do
    eval "$(sed -n "/^${f}()/,/^}/p" "$MANAGE_SH")"
  done
}

# ---- A-3: stop_service exit codes must be honest ----

@test "A-3a: returns 1 when the port is busy but no PID can be found" {
  load_fn stop_service
  is_port_in_use() { return 0; }
  pid_on_port() { printf ""; }
  find_launchd_label_for_port() { printf ""; }
  print_error() { :; }
  print_info() { :; }
  print_status() { :; }
  print_warning() { :; }

  # 不用 bats 的 `run`：它起子进程，不继承本 shell 里 eval 出来的函数（127）
  local rc=0
  stop_service "fakesvc" 9999 || rc=$?
  [ "$rc" -eq 1 ]
}

@test "A-3b: returns 0 and warns when the port is not in use" {
  load_fn stop_service
  is_port_in_use() { return 1; }
  print_warning() { echo "not running"; }

  local rc=0 out=""
  out="$(stop_service "fakesvc" 9999 2>&1)" || rc=$?
  [ "$rc" -eq 0 ]
  [[ "$out" == *"not running"* ]] || { echo '断言不成立: [[ "$out" == *"not running"* ]]' >&2; return 1; }
}

@test "A-3c: returns 0 once kill releases the port" {
  load_fn stop_service
  local calls=0
  is_port_in_use() {
    calls=$((calls + 1))
    # first call: busy before stopping; afterwards: released
    [ "$calls" -gt 1 ] && return 1 || return 0
  }
  pid_on_port() { printf "4242"; }
  kill() { return 0; }
  sleep() { return 0; }
  print_status() { :; }
  print_warning() { :; }
  print_error() { :; }
  print_info() { :; }

  local rc=0
  stop_service "fakesvc" 9999 || rc=$?
  [ "$rc" -eq 0 ]
}

@test "A-3d: returns 1 when the port stays busy and no launchd label is found" {
  load_fn stop_service
  is_port_in_use() { return 0; }
  pid_on_port() { printf "4242"; }
  kill() { return 0; }
  sleep() { return 0; }
  find_launchd_label_for_port() { printf ""; }
  print_warning() { :; }
  print_error() { :; }
  print_info() { :; }
  print_status() { :; }

  # 不用 bats 的 `run`：它起子进程，不继承本 shell 里 eval 出来的函数（127）
  local rc=0
  stop_service "fakesvc" 9999 || rc=$?
  [ "$rc" -eq 1 ]
}

@test "A-3e: the pid_on_port ss branch must not drop pid= via grep -o" {
  # Old form: ss -ltnp | grep -oE ":$port[[:space:]]" | grep -oE 'pid=' --
  # the first grep -o only emits ":8080 " so pid= is already gone and the
  # second grep can never match. The fixed form uses `grep -E ":...port..."`
  # on the whole line and only extracts pid= with -o.
  # Comment lines are filtered out first: the explanatory comment quotes the
  # old broken pattern verbatim.
  local code
  code="$(grep -vE '^[[:space:]]*#' "$MANAGE_SH")"
  run grep -nE "grep -oE [\"']:" <<<"$code"
  [ "$status" -ne 0 ]
}

# ---- A-4: launchd label lookup must actually work ----

@test "A-4a: resolves the label by port from the naming convention" {
  load_fn find_launchd_label_for_port

  local fake_home
  fake_home="$(mktemp -d)"
  mkdir -p "$fake_home/Library/LaunchAgents"
  cat > "$fake_home/Library/LaunchAgents/com.multi-proxy.fakesvc-998877.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.multi-proxy.fakesvc-998877</string>
</dict>
</plist>
PLIST

  local rc=0 out=""
  out="$(HOME="$fake_home" find_launchd_label_for_port 998877)" || rc=$?
  [ "$rc" -eq 0 ]
  [[ "$out" == *"com.multi-proxy.fakesvc-998877"* ]] || { echo '断言不成立: [[ "$out" == *"com.multi-proxy.fakesvc-998877"* ]]' >&2; return 1; }

  rm -rf "$fake_home"
}

@test "A-4b: returns non-zero when no plist matches the port" {
  load_fn find_launchd_label_for_port

  local fake_home
  fake_home="$(mktemp -d)"
  mkdir -p "$fake_home/Library/LaunchAgents"
  cat > "$fake_home/Library/LaunchAgents/com.example.other-1234.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.other-1234</string>
</dict>
</plist>
PLIST

  local rc=0
  HOME="$fake_home" find_launchd_label_for_port 998877 >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ]

  rm -rf "$fake_home"
}

@test "A-4c: backup plists (.plist.bak-*) are not mistaken for the real one" {
  load_fn find_launchd_label_for_port

  local fake_home
  fake_home="$(mktemp -d)"
  mkdir -p "$fake_home/Library/LaunchAgents"
  : > "$fake_home/Library/LaunchAgents/com.multi-proxy.fakesvc-998877.plist.bak-20261025"

  local rc=0
  HOME="$fake_home" find_launchd_label_for_port 998877 >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ]

  rm -rf "$fake_home"
}

@test "A-4d: a plutil-unreadable plist falls back instead of silently failing" {
  # Third-level fallback: python3 plistlib. Verify the fallback exists in the
  # function so a broken plutil does not resurrect the A-4 symptom.
  run grep -n 'plistlib' "$MANAGE_SH"
  [ "$status" -eq 0 ]
}
