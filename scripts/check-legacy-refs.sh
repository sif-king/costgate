#!/usr/bin/env bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.

# check-legacy-refs.sh — 防「11-09 重写前的旧历史被误推回公开仓」
#
# 背景：2026-11-09 按方案 B 把 git 历史重写成单提交 58a1097 后转 PUBLIC。重写前的
# 对象里有 UI-AUDIT / AGENTS.md / MEMORY.md.bak 等内部资产，只允许留在本机 bundle
# 与 backup 分支。一次 `git push --tags` / `git push --all` 就能把它们送回公开仓，
# 且不可逆 —— 所以光「删过一次 tag」不够，得有机器每次都判。
#
# 判据（只读、不联网、可在干净 checkout 跑）：
#   A. 任何本地 tag 的目标必须是当前 HEAD 的祖先（正常发版 tag 指向 main，天然通过）
#   B. origin 的跟踪分支里不得出现本地专用备份前缀
# 退出码：0 干净 / 1 有风险 ref / 2 环境错误

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "不在 git 仓库里"; exit 2; }

head_sha=$(git rev-parse HEAD)
fail=0

echo "[legacy-refs] A. 本地 tag 是否指向当前 main 历史..."
while read -r ref sha; do
  [ -n "$ref" ] || continue
  if ! git merge-base --is-ancestor "$sha" "$head_sha" 2>/dev/null; then
    printf '  [FAIL] tag %s -> %s（不在 main 历史内，疑似 11-09 重写前旧历史）\n' "$ref" "${sha:0:12}"
    fail=1
  fi
done < <(git for-each-ref --format='%(refname:short) %(objectname)' refs/tags/)

echo "[legacy-refs] B. origin 上是否出现本地专用备份分支..."
legacy_re='^(backup|backup/|local/no-push|memory-records|e2e-stability)'
while read -r ref sha; do
  [ -n "$ref" ] || continue
  short=${ref#origin/}
  [ "$short" = "HEAD" ] && continue
  if [[ "$short" =~ $legacy_re ]]; then
    printf '  [FAIL] origin 分支 %s 是本地专用备份，不该出现在公开仓\n' "$ref"
    fail=1
  fi
done < <(git for-each-ref --format='%(refname:short) %(objectname)' refs/remotes/origin/)

if [ "$fail" -eq 1 ]; then
  echo "[legacy-refs] 有风险 ref：旧历史只应留在本机 bundle / backup 分支，禁止推送。"
  exit 1
fi
echo "[legacy-refs] OK（tag 均在 main 历史内；origin 无 legacy 分支）"
