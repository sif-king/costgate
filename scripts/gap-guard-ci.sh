#!/usr/bin/env bash
# gap-guard-ci.sh — 质量落差静态层 CI 预检（接入 agent-infra gap-guard，不重复造）
#
# 作用：把 agent-infra 的 gap-guard 静态层（G1-G4+G7）作为 multi-proxy 的 CI 预检接入,
#   扫每个有 gap-guard.json 的子模块，输出 P0/P1 计数与明细，按 gate 决定退出码。
#   运行时层（G5 鉴权假通过 / G6 布局塌陷）需真浏览器，不进本静态 CI,
#   走 agent-infra gap-guard/templates/ 模板接进各项目 e2e/。
#
# 定位 run.js（按序，命中即用）：
#   1. $GAP_GUARD_RUN             —— 显式绝对路径（CI 用，指向 checkout 出的 agent-infra）
#   2. 同级 ../agent-infra/gap-guard/run.js —— 本地开发（两仓同级 ~/Documents/AI项目）
#   3. $GAP_GUARD_HOME/gap-guard/run.js     —— 其它部署
#   找不到 -> 打印 skip + exit 0（非阻断，待 provision 后自动接管）
#
# 用法：
#   bash scripts/gap-guard-ci.sh                 默认 P0 阻断、P1 仅告警
#   bash scripts/gap-guard-ci.sh --gate p1        P1 也阻断
#   GAP_GUARD_RUN=/path/run.js bash scripts/gap-guard-ci.sh
#
# 退出码：0=干净或仅 P1（默认）；1=有 P0 / 或 P1 且 --gate p1;非 1 的 0 也可能是 skip。
# 不用 set -e：bash 3.2 下「末项为真的 && 列表」会误触 set -e 退出,每个危险点已单独 || true 兜底。
set -uo pipefail

# 仓库根 = 本脚本所在目录的上一级
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GATE="p0"
if [ "${1:-}" = "--gate" ]; then
  GATE="${2:-p0}"
fi

# —— 定位 agent-infra/gap-guard/run.js ——
RUN=""
if [ -n "${GAP_GUARD_RUN:-}" ] && [ -f "${GAP_GUARD_RUN}" ]; then
  RUN="${GAP_GUARD_RUN}"
elif [ -f "${REPO_ROOT}/../agent-infra/gap-guard/run.js" ]; then
  RUN="${REPO_ROOT}/../agent-infra/gap-guard/run.js"
elif [ -n "${GAP_GUARD_HOME:-}" ] && [ -f "${GAP_GUARD_HOME}/gap-guard/run.js" ]; then
  RUN="${GAP_GUARD_HOME}/gap-guard/run.js"
fi

if [ -z "$RUN" ]; then
  echo "[gap-guard-ci] 未找到 agent-infra gap-guard run.js（已试 GAP_GUARD_RUN / 同级 ../agent-infra / GAP_GUARD_HOME）"
  echo "   非阻断：待 provision 后（设 GAP_GUARD_RUN 或把 agent-infra 放同级）自动接管。"
  exit 0
fi

echo "[gap-guard-ci] 使用 $RUN"

# —— 自动发现所有带 gap-guard.json 的子模块 ——
ROOTS=()
while IFS= read -r rg; do
  ROOTS+=("$rg")
done < <(find "$REPO_ROOT" -maxdepth 2 -name gap-guard.json -not -path "*/node_modules/*" 2>/dev/null | sort)

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo "[gap-guard-ci] 未发现任何 gap-guard.json（静态层无从扫）"
  exit 0
fi

P0_TOTAL=0
P1_TOTAL=0
FAILED=""
UNSCANNED=""
for rg in "${ROOTS[@]}"; do
  root="$(dirname "$rg")"
  echo "=================================================================="
  echo "=== gap-guard 静态层：$root ==="
  echo "=================================================================="
  # run.js 退出非 0 不致命；我们读它的「合计 N 条（P0 M 条）」自己判 P0/P1
  #
  # 🔴 G8/G9 是**项目级**规则，不是每个子模块各跑一遍：
  #    runtime-probes.json / outward-mutations.json 只存在于仓库根，
  #    对子模块跑只会报「未配置 runtime-probes.json」这类假落差，
  #    而它的修法（往子模块复制一份声明）恰恰是 G3 真源副本要抓的事。
  #    所以根目录跑全部，子模块只跑代码层的 G1-G4+G7。
  if [ "$root" = "$REPO_ROOT" ]; then
    ONLY_ARGS=""
  else
    ONLY_ARGS="--only G1,G2,G3,G4,G7"
  fi
  # shellcheck disable=SC2086  # 需要按空格拆成两个参数；Bash 3.2 下用数组也行，但保持简单
  #
  # 🔴 退出码必须接住，不能 `|| true` 一吞了事：
  #    run.js 约定 0=干净 / 1=有 finding / 2=有规则未扫描（fail-closed）。
  #    以前这里吞掉一切、再从「合计 N 条」读结论，于是「什么都没扫到」被读成
  #    「0 条 = 干净」——守卫自己犯了 unknown→绿，比不扫更坏。
  #    本脚本没有 set -e（见头部说明），所以可以直接接 $?。
  out="$(node "$RUN" --root "$root" $ONLY_ARGS 2>&1)"
  rc=$?
  if [ "$rc" -eq 2 ]; then
    # 未扫描 = 配了路径但路径不存在 = 等于没检查。记下来最后阻断。
    UNSCANNED="$UNSCANNED $root"
  fi
  printf '%s\n' "$out" | grep -E 'G[0-9]|合计' || true

  # 抽 P0 数 / 合计数（run.js --root 输出「合计 N 条（P0 M 条）」，P1 = 合计 - P0）
  # 用 tr -dc '0-9' 兜底清掉任何换行/空白，避免「0<newline>0」进算术表达式出错
  p0="$(printf '%s\n' "$out" | grep -oE 'P0 [0-9]+ 条' | grep -oE '[0-9]+' | head -1 | tr -dc '0-9')"
  total="$(printf '%s\n' "$out" | grep -oE '合计 [0-9]+ 条' | grep -oE '[0-9]+' | head -1 | tr -dc '0-9')"
  p0="${p0:-0}"
  total="${total:-0}"
  p1calc=$((total - p0))
  if [ "$p1calc" -lt 0 ]; then
    p1calc=0
  fi
  if [ "$p0" -gt 0 ] || [ "$p1calc" -gt 0 ]; then
    echo "   -> 该模块有落差：P0=$p0 P1=$p1calc"
  fi
  P0_TOTAL=$((P0_TOTAL + p0))
  P1_TOTAL=$((P1_TOTAL + p1calc))
  if [ "$p0" -gt 0 ]; then
    FAILED="$FAILED $root($p0 P0)"
  fi
done

echo "=================================================================="

# 🔴 未扫描先于一切判定：有模块「什么都没扫到」时，P0=0 是假象，不能报「干净」。
if [ -n "$UNSCANNED" ]; then
  echo "X 有模块存在「未扫描」的规则（路径配了但不存在 ⇒ 等于没检查）：${UNSCANNED}"
  echo "  修法：把该模块 gap-guard.json 的路径改对；本项目确实没有这类目录时写 null（= 不适用）。"
  echo "  注意「不适用」与「未扫描」不是一回事：null 是声明没有，配错是漏检查。"
  exit 1
fi

if [ "$P0_TOTAL" -eq 0 ] && [ "$P1_TOTAL" -eq 0 ]; then
  echo "[gap-guard-ci] 干净：0 P0 / 0 P1（${#ROOTS[@]} 模块）"
  exit 0
fi

echo "[gap-guard-ci] P0 合计 $P0_TOTAL, P1 合计 $P1_TOTAL"
if [ "$GATE" = "p1" ]; then
  if [ "$P1_TOTAL" -gt 0 ] || [ "$P0_TOTAL" -gt 0 ]; then
    echo "X gate=p1：存在 P0/P1${FAILED}，阻断"
    exit 1
  fi
elif [ "$P0_TOTAL" -gt 0 ]; then
  echo "X gate=p0：存在 P0${FAILED}，阻断"
  exit 1
fi
echo "（gate=p0：仅 $P1_TOTAL 条 P1，登记告警，不阻断）"
exit 0
