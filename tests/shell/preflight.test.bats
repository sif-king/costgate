#!/usr/bin/env bats

# BATS tests for scripts/preflight.sh
# Run with: bats tests/shell/preflight.test.bats
#
# 为什么锁这几条（2026-11-09 的坑）：
#   P0 Security Gate 在 main 上连红四天，因为**本地没有入口**——四个 job 各有真原因，
#   每一条都能在本地几十秒内复现，但没人跑。preflight.sh 就是补这个入口。
#   随后又发现第二层：drift-check 本地连绿、CI 连红，因为 watch-list 列了本地私有件
#   ⇒「本地跑的那份树」和「CI 跑的那份树」不是同一份。所以 preflight 加了
#   干净 checkout 复现（git worktree）。这几条测试保证：
#     · 干净 checkout 那一步**真的执行**，不是写个标题就完事
#     · 关掉它时明说「未跑，不算通过」，绝不冒充绿灯
#     · 参数写错不会被静默忽略（否则 --ful 会被当成「全跑了」）
#
# 断言一律写成 `[[ 条件 ]] || { echo …; return 1; }`：
# 裸 [[ ]] 失败后若还有后续命令，返回码会被后面那行覆盖 —— 等于没断言。

PRE="" PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  PRE="$PROJECT_ROOT/scripts/preflight.sh"
}

@test "preflight.sh exists and parses" {
  [ -f "$PRE" ]
  run bash -n "$PRE"
  [ "$status" -eq 0 ]
}

@test "unknown flag exits 2 and lists valid flags (no silent ignore)" {
  # 中文口径：写错参数必须当场拒绝并给出正确写法。静默忽略会让 --ful 被当成「全跑了」。
  run bash "$PRE" --ful
  [ "$status" -eq 2 ]
  [[ "$output" == *"--full"* ]] || { echo "断言不成立: 提示里没列出 --full，实际输出=$output" >&2; return 1; }
}

@test "default mode actually runs the clean-checkout step" {
  # 关键断言：输出里必须出现「干净 checkout：<sha>」这一行。
  # 只出现标题「干净 checkout 复现」不算——那可能是被 skip 的分支。
  # 注入验证：把整个 0 号步骤跳过 → 本测试与第 5 条同时红（已实测）。
  run bash "$PRE" --quick
  [[ "$output" == *"干净 checkout："* ]] || { echo "断言不成立: 干净 checkout 步骤没执行，实际输出=$output" >&2; return 1; }
}

@test "--no-clean says not-run instead of pretending green" {
  # 中文口径：跳过 ≠ 通过。「未跑，不算通过」是这套脚本的核心纪律。
  run bash "$PRE" --no-clean --quick
  [[ "$output" == *"--no-clean 跳过"* ]] || { echo "断言不成立: 没有明说 --no-clean 跳过，实际输出=$output" >&2; return 1; }
  [[ "$output" == *"未跑，不算通过"* ]] || { echo "断言不成立: 跳过项被当成了通过，实际输出=$output" >&2; return 1; }
}

@test "--quick skips bats but keeps clean checkout (fast != fewer key checks)" {
  run bash "$PRE" --quick
  [[ "$output" == *"bats 全量（--quick）"* ]] || { echo "断言不成立: --quick 没跳过 bats，实际输出=$output" >&2; return 1; }
  [[ "$output" == *"干净 checkout："* ]] || { echo "断言不成立: --quick 把 clean checkout 也跳掉了，实际输出=$output" >&2; return 1; }
}

@test "clean checkout uses HEAD + working-tree diff, not HEAD alone" {
  # 只查 HEAD 会漏掉「你即将提交但还没提交」的东西 —— 那正是最该查的。
  run grep -c 'git diff HEAD --binary' "$PRE"
  [ "$output" -ge 1 ]
}

@test "clean checkout cleans up its worktree" {
  # 成功路径走完必须 cleanup（trap + 显式调用都要在），否则垃圾 worktree 越堆越多。
  run grep -c 'worktree remove' "$PRE"
  [ "$output" -ge 1 ]
}
