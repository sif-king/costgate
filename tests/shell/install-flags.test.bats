#!/usr/bin/env bats

# BATS tests for install.sh 的「单装一个组件」入口
# Run with: bats tests/shell/install-flags.test.bats
#
# 为什么锁这条：install.sh 里每个 install_xxx() 函数都存在，但**存在不等于用户能调到**。
# 2026-11-08 实测踩到：install_cursor 早就在，`bash install.sh --cursor` 却不存在——
# 只能 `--all`（装 8 个）或走交互式向导，而 README 与 verify-lanes.sh 都在教人单装 cursor。
# 这是「组件可拆卸」只在代码里成立、对用户不成立的典型形态，且不会有任何报错提示。
#
# 判据：每个 install_<name> 函数，命令行必须有一个同名 flag 能直达它，且 help 里列出。

INSTALL=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  INSTALL="$PROJECT_ROOT/install.sh"
}

@test "install.sh exists and parses" {
  [ -f "$INSTALL" ]
  run bash -n "$INSTALL"
  [ "$status" -eq 0 ]
}

@test "every install_<component> function is reachable from a CLI flag" {
  local -a comps=(codex claude opencode generic dsh hermes cursor manager)
  local c
  for c in "${comps[@]}"; do
    # 函数必须存在
    run grep -qE "^install_${c}\(\)" "$INSTALL"
    [ "$status" -eq 0 ] || { echo "install.sh 里没有 install_${c}()" >&2; return 1; }
    # 且命令行分支里能直达它
    run grep -qE "^[[:space:]]*${c}\)[[:space:]]+install_${c}" "$INSTALL"
    [ "$status" -eq 0 ] || { echo "install.sh 里没有 --${c} 分支（函数在，用户调不到）" >&2; return 1; }
  done
}

@test "--all installs exactly the components that have a CLI flag" {
  # --all 与单装分支必须覆盖同一组组件，否则会出现「全装能装到、单装装不到」的错位。
  local -a from_all from_cli
  from_all=($(sed -n '/^[[:space:]]*--all)/,/;;/p' "$INSTALL" | grep -oE 'install_[a-z]+' | sort -u))
  from_cli=($(sed -n '/--claude|--opencode/,/;;/p' "$INSTALL" | grep -oE 'install_[a-z]+' | sort -u))
  [ "${#from_cli[@]}" -ge 8 ]
  run diff <(printf '%s\n' "${from_all[@]}") <(printf '%s\n' "${from_cli[@]}")
  [ "$status" -eq 0 ]
}

@test "help text lists the single-component flags" {
  run bash "$INSTALL" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--cursor"* ]] || { echo '断言不成立: [[ "$output" == *"--cursor"* ]]' >&2; return 1; }
  [[ "$output" == *"--codex"* ]] || { echo '断言不成立: [[ "$output" == *"--codex"* ]]' >&2; return 1; }
  [[ "$output" == *"--manager"* ]] || { echo '断言不成立: [[ "$output" == *"--manager"* ]]' >&2; return 1; }
}

@test "--cursor --dry-run reaches install_cursor without installing anything" {
  run bash "$INSTALL" --cursor --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]] || { echo '断言不成立: [[ "$output" == *"dry-run"* ]]' >&2; return 1; }
  [[ "$output" == *"cursor-proxy"* ]] || { echo '断言不成立: [[ "$output" == *"cursor-proxy"* ]]' >&2; return 1; }
}
