#!/usr/bin/env bats

# BATS tests for the guard files themselves —— 断言到底会不会变红
# Run with: bats tests/shell/assertion-enforcement.test.bats
#
# 为什么需要这一组：
#   2026-11-08 实测发现，本机 bats 1.14 + bash 下，测试体中间写成裸 `[[ ... ]]`
#   的断言为假时会被**静默吞掉**（`[ ]` 和管道不会）。当时新写的一条「必须现场
#   探测端口」的断言就是这样：注入故障后测试依旧绿，直到把断言改成必然失败才看出来。
#   断言写着却不生效，比没有断言更糟——它给出「有守卫」的错觉。
#
#   所以这里守两件事：
#     1. tests/shell 下不许再出现裸 `[[ ]]` 断言行（必须 `|| { echo …; return 1; }`）
#     2. 这套写法本身真的会红（造一个必然失败的用例，跑一遍 bats 来证明）
#
# 另：管理断言写法的规矩一旦放宽，第一个先崩的就是「注入回归」这套流程——
# 因为注入后不变红会被误判成「守卫测的是别的东西」。

PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
}

@test "no bare [[ ]] assertion lines (they are silently swallowed mid-test)" {
  # 判据：一行以 [[ 开头、以 ]] 结尾、且行内没有 || —— 就是裸断言。
  # 允许出现在 if/while 条件里（那不是断言），所以只匹配行首是 [[ 的行。
  # 跳过本文件：它要故意写一条裸断言当反例（在 heredoc 里造临时用例，不参与执行）。
  local hits=""
  hits="$(grep -nE '^[[:space:]]*\[\[.*\]\][[:space:]]*$' "$PROJECT_ROOT"/tests/shell/*.bats 2>/dev/null \
    | grep -v '/assertion-enforcement\.test\.bats:' || true)"
  [ -z "$hits" ] || {
    echo "这些断言是裸 [[ ]]，中途失败会被静默吞掉，等于没写："
    echo "$hits"
    echo "改成： [[ 条件 ]] || { echo '断言不成立: …' >&2; return 1; }"
    return 1
  }
}

@test "the enforcement pattern really turns a test red (proves the guard works)" {
  # 造两个文件：一个用裸写法（预期被吞 → bats 报 ok），一个用本项目写法（预期报 not ok）。
  # 第二个是我们要的；第一个是这条规矩之所以存在的原因，一起钉住，
  # 这样将来 bats/bash 行为若变了（裸写法开始报错），这里也会红，提醒更新规矩。
  local dir="$BATS_TEST_TMPDIR/probe"
  mkdir -p "$dir"
  cat >"$dir/enforced.bats" <<'EOS'
@test "enforced" {
  [[ 1 -eq 2 ]] || { echo '断言不成立: [[ 1 -eq 2 ]]' >&2; return 1; }
  true
}
EOS
  cat >"$dir/bare.bats" <<'EOS'
@test "bare" {
  [[ 1 -eq 2 ]]
  true
}
EOS

  run bats "$dir/enforced.bats"
  [ "$status" -ne 0 ] || {
    echo "本项目写法没有变红——那它就没有守住任何东西" >&2
    return 1
  }

  run bats "$dir/bare.bats"
  # 裸写法在本机是被吞的（status 0）。若哪天变成非 0，说明 bats 行为变了，
  # 这条测试会红——提醒把上面那条「不许裸写」的规矩连同注释一起更新。
  [ "$status" -eq 0 ] || {
    echo "bats 行为变了：裸 [[ ]] 现在会报错了。可以放宽规矩，但要先改注释说明原因。" >&2
    return 1
  }
}

@test "every guard file starts with a Chinese rationale, not just a title" {
  # 一条守卫如果只有标题，半年后没人知道它为什么存在、什么情况该改它。
  # 判据：@test 之前必须有 ≥3 行以 # 开头的说明（不含 shebang）。
  local f n bad=""
  for f in "$PROJECT_ROOT"/tests/shell/*.bats; do
    n="$(awk '/^@test /{exit} /^#/{c++} END{print c+0}' "$f")"
    [ "$n" -ge 3 ] || bad="$bad $(basename "$f")($n)"
  done
  [ -z "$bad" ] || {
    echo "这些守卫缺中文口径说明（@test 之前至少 3 行注释）：$bad" >&2
    return 1
  }
}
