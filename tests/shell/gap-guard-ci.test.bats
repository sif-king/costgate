#!/usr/bin/env bats

# BATS tests for scripts/gap-guard-ci.sh
# Run with: bats tests/shell/gap-guard-ci.test.bats
#
# 为什么锁这几条（2026-11-09）：
#   G8/G9 是**项目级**规则（runtime-probes.json / outward-mutations.json 只在仓库根），
#   但 CI 会走进每个带 gap-guard.json 的子模块。给子模块也跑 G8 的结果是
#   报「未配置 runtime-probes.json」这种假落差，而它唯一的修法——往子模块复制
#   一份声明——恰好是 G3 真源副本要抓的事。所以必须分层，且这条不能被改回去。

GCI=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  GCI="$PROJECT_ROOT/scripts/gap-guard-ci.sh"
}

@test "gap-guard-ci.sh exists and parses" {
  [ -f "$GCI" ]
  run bash -n "$GCI"
  [ "$status" -eq 0 ]
}

@test "gap-guard-ci.sh scopes project-level rules to the repo root only" {
  # 中文口径：子模块必须带 --only 且不含 G8/G9；根目录不带 --only（全跑）。
  # 用源码断言而非真跑：CI 里可能没有 agent-infra，真跑会走 skip 分支，
  # 那样断言等于什么都没测。
  grep -qE 'ONLY_ARGS="--only G1,G2,G3,G4,G7"' "$GCI" \
    || { echo "子模块未限制为代码层规则（G8/G9 会误报）" >&2; return 1; }
  grep -qE 'if \[ "\$root" = "\$REPO_ROOT" \]' "$GCI" \
    || { echo "未按「根 vs 子模块」分层" >&2; return 1; }
  grep -qE 'ONLY_ARGS=""' "$GCI" \
    || { echo "根目录未保持全跑" >&2; return 1; }
}

@test "gap-guard-ci.sh fails closed when a rule could not scan" {
  # 中文口径：run.js 约定 0=干净 / 1=有 finding / 2=有规则未扫描（路径配了但不存在）。
  # CI 以前用 `|| true` 吞掉一切、再从「合计 N 条」读结论，于是「什么都没扫到」
  # 被读成「0 条 = 干净」。现在必须接住退出码并对 2 单独阻断。
  #
  # 顺带记一个 run.js 侧的坑（已修）：它原来先判 `total > 0 → exit 1`，
  # 导致「既发现问题、又有规则没扫」时永远返回 1，退出码 2 形同虚设，
  # 于是 fail-closed 从来没真正生效过。
  grep -qE 'rc=\$\?' "$GCI" || { echo "未接住 run.js 退出码" >&2; return 1; }
  grep -qE '"\$rc" -eq 2' "$GCI" || { echo "未对退出码 2（未扫描）单独处理" >&2; return 1; }
  grep -q 'UNSCANNED' "$GCI" || { echo "未记录未扫描模块" >&2; return 1; }
  grep -q 'exit 1' "$GCI" || { echo "未阻断" >&2; return 1; }
}

@test "gap-guard-ci.sh stays non-blocking when agent-infra is absent" {
  # 中文口径：拿不到 run.js 时必须 skip 而不是阻断——否则任何没有
  # 跨仓 token 的环境（含开源仓的 fork）都会红，那会让人直接把这个 job 关掉，
  # 防线就彻底失效了。fail-open 是有意设计，不是疏漏。
  run env GAP_GUARD_RUN="" GAP_GUARD_HOME="" bash -c "PATH=/usr/bin:/bin bash '$GCI'"
  # 找不到就是一个 skip 的 0；能找到就正常跑完，也应是 0 或 1（有 P0 才 1）。
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}
