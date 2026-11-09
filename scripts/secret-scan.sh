#!/usr/bin/env bash
# secret-scan.sh — 推送前密钥模式扫描（第二道闸，接在内部资产闸门之后）
#
# 目的：拦住「把真实密钥提交进即将推送的 commit / diff」这一环。
#   - 钩子场景（pre-push）：只扫「本次要推的 diff」（local ^remote），不扫全量历史，
#     避免历史旧债阻断新推送，也避免误伤已公开的测试夹具。
#   - CI 场景（scripts/secret-scan.sh HEAD）：扫当前 tree 的匹配内容。
#
# 误报防护（关键，见 PROJECT-STATE/PUBLISH_CLEANUP_PLAYBOOK §3.2 的警示）：
#   - 高置信模式：sk- / AIza / AKIA / ghp_ / glpat_ / BEGIN PRIVATE KEY / Bearer+token
#   - 排除测试/夹具/示例路径：*.test.* *.spec.* /tests/ /__tests__/ fixtures/ mock(s)/ secrets?
#     （这些目录里的伪密钥是预期内的，不应阻断）
#
# 命中即 exit 1（硬阻断）；无命中 exit 0。
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAT='(sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|Bearer [a-zA-Z0-9._-]{20,})'
# 排除：测试/夹具/示例目录（伪密钥预期内，不阻断）。
# 目录类锚定 (^|/)；文件名类（.test./.spec./secrets.）在路径任意位置匹配。
EXCLUDE_RX='(^|/)(fixtures?/|__tests?__/|mock(s)?/)|(\.test\.|\.spec\.|secrets?\.)'

scan_tree() {
  local commit="$1"
  local files
  files=$(git ls-tree -r --name-only "$commit" | grep -vE "$EXCLUDE_RX" || true)
  [ -z "$files" ] && return 0
  git grep -nE "$PAT" "$commit" -- $files 2>/dev/null || true
}

scan_range() {
  local base="$1" head="$2"
  local files
  files=$(git diff --name-only --diff-filter=d "$base" "$head" | grep -vE "$EXCLUDE_RX" || true)
  [ -z "$files" ] && return 0
  git diff -U0 "$base" "$head" -- $files 2>/dev/null | grep '^+' | sed 's/^+//' | grep -E "$PAT" || true
}

if [ "$#" -ge 2 ]; then
  LOCAL="$1"; REMOTE="$2"
  if [ "$REMOTE" = "0000000000000000000000000000000000000000" ]; then
    BASE="$LOCAL^"
  else
    BASE="$REMOTE"
  fi
  HITS=$(scan_range "$BASE" "$LOCAL")
elif [ "$#" -eq 1 ]; then
  HITS=$(scan_tree "$1")
else
  HITS=$(scan_tree HEAD)
fi

if [ -z "$HITS" ]; then
  echo "secret-scan: OK (no high-confidence secret patterns in scanned diff)"
  exit 0
fi

echo "secret-scan: 命中疑似密钥，推送被拦截："
printf '%s\n' "$HITS" | head -30
echo ""
echo "若为测试夹具，请移到排除路径（tests/、*.test.*、fixtures/ 等）；若为真实凭据，先移除再推送。"
exit 1
