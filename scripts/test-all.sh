#!/usr/bin/env bash
# test-all.sh — 一条命令跑完全部入口测试，只报一行总账（2026-11-05 加）
#
# 原理：各入口自带 runner（jest / node --test），本脚本**只做聚合**，
#       不改任何入口的 package.json、jest 配置或测试文件。
# 为什么：11 个入口 = 11 个开关，没有一条命令能回答「整个底座现在健康吗」；
#       答不上来，体感就是「不知道有没有坏」，而「不知道」会被记成「很差」。
#       方法论见 agent-infra/methodology/深度与纪律-收敛与摩擦-2026-11-05.md
#
# 用法：
#   bash scripts/test-all.sh                    # 全跑（含 jest 四条，慢）
#   bash scripts/test-all.sh --fast             # 只跑零依赖 node:test 入口（实测 49 秒）
#   bash scripts/test-all.sh l2 claude-proxy    # 只跑指定入口
#
# 为什么要有 --fast：实测 claude-proxy 单入口 jest 跑 9 分钟未结束（2026-11-05），
#   四个 jest 入口 = 40 分钟起。反馈时间太长 ⇒ 没人跑 ⇒ 「有没有坏」永远没人知道。
#   快档（实测 49 秒）保证日常改一行也能看到绿/红；全量档留给提交前。
#
# 退出码：任一入口 FAIL / 无计数且非零退出 ⇒ 非零。
#   无计数但零退出（自定义断言脚本）标为「PASS（仅退出码）」，不并入数字，也不当异常。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

ALL_ENTRIES=(
  l2
  claude-proxy
  codex-proxy
  generic-openai-proxy
  opencode-proxy
  dsh-proxy
  workbuddy-shim
  opencode-free
)

# 零依赖 node:test 入口：秒级返回，适合每次改动后跑
FAST_ENTRIES=(l2 dsh-proxy workbuddy-shim)

if [ "${1:-}" = "--fast" ]; then
  shift
  set -- "${FAST_ENTRIES[@]}" "$@"
fi

if [ "$#" -gt 0 ]; then
  ENTRIES=("$@")
else
  ENTRIES=("${ALL_ENTRIES[@]}")
fi

# 两种 runner 两种输出格式，都要认：
#   node --test (TAP) → "# pass 118" / "# fail 0"
#   jest             → "Tests:  13 passed, 13 total"
# 都匹配不上就返回空串，由调用方判为异常（不许当 0）。
parse_counts() {
  local out="$1" p f
  p=$( printf '%s\n' "$out" | awk '/^# pass /{print $3}' | tail -1 )
  f=$( printf '%s\n' "$out" | awk '/^# fail /{print $3}' | tail -1 )
  if [ -n "${p:-}" ]; then printf '%s %s\n' "$p" "${f:-0}"; return 0; fi
  p=$( printf '%s\n' "$out" | sed -n 's/.*Tests:.* \([0-9][0-9]*\) passed.*/\1/p' | tail -1 )
  f=$( printf '%s\n' "$out" | sed -n 's/.*Tests:.* \([0-9][0-9]*\) failed.*/\1/p' | tail -1 )
  if [ -n "${p:-}" ]; then printf '%s %s\n' "$p" "${f:-0}"; return 0; fi
  printf '\n'
}

TOTAL_PASS=0
TOTAL_FAIL=0
RC_ONLY=0
BAD_ENTRIES=()

for d in "${ENTRIES[@]}"; do
  if [ ! -d "$d" ]; then
    printf '%-22s %s\n' "$d" "SKIP 目录不存在"
    BAD_ENTRIES+=("$d")
    continue
  fi

  if [ -f "$d/package.json" ] && grep -q '"test"' "$d/package.json" 2>/dev/null; then
    out=$( cd "$d" && npm test --silent 2>&1 )
    rc=$?
  else
    files=$( find "$d" -maxdepth 2 \( -name '*.test.js' -o -name '*.test.mjs' \) -not -path '*/node_modules/*' 2>/dev/null )
    if [ -z "$files" ]; then
      printf '%-22s %s\n' "$d" "无测试文件"
      continue
    fi
    # shellcheck disable=SC2086
    out=$( node --test $files 2>&1 )
    rc=$?
  fi

  read -r pass fail <<< "$(parse_counts "$out")"

  if [ -z "${pass:-}" ]; then
    # 无计数不算通过也不算失败，按退出码分两路，各自标明——不许把 unknown 记成 0
    if [ "$rc" -eq 0 ]; then
      printf '%-22s %s\n' "$d" "PASS（仅退出码，无计数）"
      RC_ONLY=$((RC_ONLY + 1))
    else
      printf '%-22s %s\n' "$d" "FAIL（exit ${rc}，无计数）"
      BAD_ENTRIES+=("$d")
    fi
    continue
  fi

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  printf '%-22s %s PASS / %s FAIL\n' "$d" "$pass" "$fail"
  if [ "$fail" -ne 0 ] || [ "$rc" -ne 0 ]; then
    BAD_ENTRIES+=("$d")
  fi
done

# 元守卫（2026-11-07 加）：MCP 边界门（GATE 1）自证——跑两遍单测，
#   门开必须全绿、门关必须恰好 2 红。之所以单列而不进 ENTRIES：
#   ENTRIES 只认目录，而这条判的是「同一份测试在两种门控下答案必须不同」，
#   是成对断言不是单次跑分。顺带补上一个缺口：multi-proxy-manager 的单测
#   本来不在 ENTRIES 里，因此 mcp-server.test.js 以前没人聚合。
if [ -f scripts/meta-guard-mcp-gate.js ]; then
  if out=$( node scripts/meta-guard-mcp-gate.js 2>&1 ); then
    printf '%-22s %s\n' "meta-guard:mcp-gate" "PASS（门开绿 / 门关红，成对成立）"
  else
    printf '%-22s %s\n' "meta-guard:mcp-gate" "FAIL（自证不成立）"
    printf '%s\n' "$out" | sed 's/^/    /'
    BAD_ENTRIES+=("meta-guard:mcp-gate")
  fi
fi

echo "──────────────────────────────────────────────"
echo "合计：${TOTAL_PASS} PASS / ${TOTAL_FAIL} FAIL（入口 ${#ENTRIES[@]} 个，其中 ${RC_ONLY} 个仅按退出码通过、无计数）"
if [ "${#BAD_ENTRIES[@]}" -gt 0 ]; then
  echo "异常入口：${BAD_ENTRIES[*]}"
  exit 1
fi
exit 0
