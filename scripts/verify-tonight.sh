#!/bin/bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
#
# 一条命令验收本轮改动。顺序刻意排成「先证明能跑，再证明对，最后看产出」。
# 任何一步失败都继续跑完，末尾统一给结论；退出码 1 表示有硬失败（单测或判据）。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PASS=0
FAIL=0
SKIP=0
declare -a NOTES=()

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[2m·\033[0m %s\n' "$1"; SKIP=$((SKIP + 1)); }

say "0. 环境"
if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
else
  bad "没有 node，后面的都跑不了"
  exit 1
fi
if command -v ps >/dev/null 2>&1 && ps -axo pid= 2>/dev/null | head -1 | grep -q '[0-9]'; then
  ok "ps 可用（归因能用上 cwd 这一档）"
else
  skip "ps 拿不到进程表，归因会退到会话记录与请求时间窗（不影响记账）"
  NOTES+=("归因降级：这台机器的当前 shell 读不到进程表")
fi

say "1. 单元测试"
if [ -x "multi-proxy-manager/node_modules/.bin/jest" ]; then
  OUT=$(cd multi-proxy-manager && npx jest tests/unit/fs-observer.test.js tests/unit/criteria.test.js \
    --silent --forceExit -w 1 2>&1 | tail -6)
  if echo "$OUT" | grep -qE '^Tests:.*[0-9]+ passed'; then
    ok "$(echo "$OUT" | grep -E '^Tests:' | head -1)"
  else
    bad "单测没全过"
    echo "$OUT" | sed 's/^/      /'
  fi
else
  skip "没装依赖（跑一次 bash scripts/quickstart.sh 或 cd multi-proxy-manager && npm install）"
  NOTES+=("单测跳过：缺 node_modules")
fi

say "2. 判据（对着本仓自己跑）"
CHECK_OUT=$(node bin/costgate check . 2>&1)
echo "$CHECK_OUT" | sed 's/^/  /'
if echo "$CHECK_OUT" | grep -q '结果：3 过 / 0 不过'; then
  ok "三条判据全过"
else
  bad "判据有不过的（上面标 FAIL 的就是文档与代码对不上的地方）"
fi

say "3. 观测端到端（真写一个文件，看账本记不记得住）"
TMPDIR_OBS=$(mktemp -d 2>/dev/null || echo "/tmp/cg-verify-$$")
mkdir -p "$TMPDIR_OBS/ledger"
PROBE_FILE="$ROOT/.verify-probe-$$.txt"
node -e '
const obs = require(process.argv[1] + "/l2/fs-observer.js");
const o = obs.createObserver({ roots: [process.argv[1]], dir: process.argv[2], debounceMs: 120 });
o.start();
const fs = require("fs");
setTimeout(() => fs.writeFileSync(process.argv[3], "probe\n"), 350);
setTimeout(() => fs.rmSync(process.argv[3], { force: true }), 800);
setTimeout(() => {
  const recs = obs.readLedger({ dir: process.argv[2] });
  const hit = recs.filter((r) => r.path === process.argv[3]);
  o.stop();
  if (hit.length === 0) { console.log("NO_RECORD"); process.exit(3); }
  console.log("RECORDS " + hit.length + " " + hit.map((r) => r.event + "/" + r.confidence).join(","));
  process.exit(0);
}, 1500);
' "$ROOT" "$TMPDIR_OBS/ledger" "$PROBE_FILE" >"$TMPDIR_OBS/out.txt" 2>&1
OBS_RC=$?
OBS_OUT=$(cat "$TMPDIR_OBS/out.txt" 2>/dev/null)
rm -f "$PROBE_FILE"
rm -rf "$TMPDIR_OBS"
if [ "$OBS_RC" = "0" ] && echo "$OBS_OUT" | grep -q '^RECORDS'; then
  ok "观测到改动并落账：$(echo "$OBS_OUT" | sed 's/^RECORDS //')"
else
  bad "观测没落账（输出：$OBS_OUT）"
fi

say "4. 今天的账"
node bin/costgate 2>&1 | sed 's/^/  /'

say "5. 判据对 Portico 跑一遍（冻结前的那个仓库）"
PORTICO="$HOME/Documents/AI项目/Portico"
if [ -d "$PORTICO" ]; then
  P_OUT=$(node bin/costgate check "$PORTICO" 2>&1 | tail -8)
  echo "$P_OUT" | sed 's/^/  /'
  if echo "$P_OUT" | grep -q 'C-001.*FAIL'; then
    ok "按预期抓出「声称了但仓里没有实现」（这就是判据的用处）"
  else
    skip "Portico 的结论变了，可能文档已改过"
  fi
else
  skip "找不到 Portico 目录"
fi

say "结论"
printf '  通过 %d · 失败 %d · 跳过 %d\n' "$PASS" "$FAIL" "$SKIP"
if [ ${#NOTES[@]} -gt 0 ]; then
  printf '\n  备注：\n'
  for n in "${NOTES[@]}"; do printf '    - %s\n' "$n"; done
fi
if [ "$FAIL" -gt 0 ]; then
  printf '\n  \033[31m有硬失败，先看上面标 ✗ 的项。\033[0m\n'
  exit 1
fi
printf '\n  \033[32m可以验收。\033[0m 看账：\033[1mnode bin/costgate\033[0m · 查文件：\033[1mnode bin/costgate who <片段>\033[0m\n'
