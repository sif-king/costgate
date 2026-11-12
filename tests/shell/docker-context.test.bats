#!/usr/bin/env bats

# BATS tests for scripts/check-docker-context.js
# Run with: bats tests/shell/docker-context.test.bats
#
# 为什么锁这几条：这个守卫抓的是「只对外部用户失败」的一类问题 ——
# 维护者机器上 cursor-proxy/dist 存在、node_modules 也装好了，本地未必看得出；
# 而干净 clone 上那条 COPY 的源**根本不存在**，docker build 直接失败。
# 这类失败没有任何本地症状，所以判据必须钉在「源在不在版本控制里」上。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  GUARD="$ROOT/scripts/check-docker-context.js"
  DF="$ROOT/Dockerfile.codex"
  BAK="$BATS_TEST_TMPDIR/Dockerfile.codex.bak"
}

teardown() {
  # 注入用例会改真实 Dockerfile；无论断言过没过都还原，别把仓库留在注入状态。
  # 🔴 必须写成 if 块：`[ -f "$BAK" ] && cp ...` 在 BAK 不存在时返回 1，
  # 而 bats 的 teardown 里任何一条命令返回非零都会把这个用例判失败 ——
  # 于是「没注入过」的用例（1/4/5）明明断言全过，却被记成 not ok（2026-11-13 实测）。
  if [ -f "$BAK" ]; then
    cp "$BAK" "$DF"
  fi
}

@test "guard exists and the current tree has no unregistered violation" {
  [ -f "$GUARD" ]
  run node "$GUARD"
  [ "$status" -eq 0 ]
}

@test "a COPY source that is not in git turns it red and names the path" {
  cp "$DF" "$BAK"
  printf '\nCOPY does-not-exist/ ./nope/\n' >> "$DF"
  run node "$GUARD"
  local st="$status" out="$output"
  cp "$BAK" "$DF"
  [ "$st" -eq 1 ]
  printf '%s' "$out" | grep -q 'does-not-exist'
}

@test "a COPY source excluded by .dockerignore is reported as excluded, not as missing" {
  # pack-build/ 故意在 .dockerignore 里？没有的话用一个真实存在但被排除的路径：
  # node_modules 一定被排除，而且几乎所有机器上都有这个目录 —— 正好模拟
  # 「磁盘上有、但进不了构建上下文」这个最容易被忽略的形态。
  cp "$DF" "$BAK"
  printf '\nCOPY multi-proxy-manager/node_modules/ ./nm/\n' >> "$DF"
  run node "$GUARD"
  local st="$status" out="$output"
  cp "$BAK" "$DF"
  [ "$st" -eq 1 ]
  printf '%s' "$out" | grep -q 'dockerignore'
}

@test "without a .git it refuses to claim success (rc=2, not 0)" {
  local d="$BATS_TEST_TMPDIR/nogit"
  mkdir -p "$d/scripts"
  cp "$GUARD" "$d/scripts/"
  run node "$d/scripts/check-docker-context.js"
  [ "$status" -eq 2 ]
}

@test "registered problems are printed every run, not silently swallowed" {
  grep -qE '^Dockerfile[^ ]*[[:space:]]{2,}' "$ROOT/scripts/docker-context-allow.txt"
  run node "$GUARD"
  printf '%s' "$output" | grep -q '已登记的问题'
}
