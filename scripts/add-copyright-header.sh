#!/usr/bin/env bash
# add-copyright-header.sh — DRY-RUN (默认关, 不执行)
# 用途: 批量给 multi-proxy 仓内 .js/.ts/.py/.md 加版权头
# 铁律: 默认只做 dry-run, 维护者说一句 "run" 才真改; git add -- 显式列文件
# 修复(2026-10-08): ① 去掉 header 里误带的 "#!/usr/bin/env bash"(会覆盖 .js/.cjs 的 node shebang)
#                   ② 文件首行是 shebang 时, 版权头插到 shebang 之后
#                   ③ .md 用 HTML 注释包裹, 避免版权行变成 H1 标题; 带 frontmatter(首行 ---)的 .md 跳过
#                   ④ 跳过 .gitignore 忽略的内部资产(MEMORY-*.md / docs/内部 / 缓存), 不污染内部笔记与缓存
# 参考: AGENTS#5 git 操作规范 + §13.39 P0 git 污染教训

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${DRY_RUN:=true}"   # 默认 dry-run；真跑用: DRY_RUN=false bash scripts/add-copyright-header.sh
# 设 DRY_RUN=false 即真跑: DRY_RUN=false bash scripts/add-copyright-header.sh

EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  "docs/10-initiatives"
  "docs/09-review"
  ".hermes"
  "raven-mapping"
)
# 脚本自身 / 已有 header 的 demo 文件单独排除
EXCLUDE_FILES=(
  "scripts/add-copyright-header.sh"
  "scripts/demo-tour.sh"
)

# 版权头(纯注释, 不带 shebang); 按文件类型选注释语法：
#   .md            → HTML 注释（frontmatter 文件在 apply_header 跳过）
#   .js/.ts/.cjs/.mjs → // 注释（JS/TS 不支持 # 注释，# 是私有字段语法会 SyntaxError）
#   其余(.py 等)   → # 注释（Python/Shell 用 #）
build_header() {
  local f="$1"
  if [[ "$f" == *.md ]]; then
    cat <<'EOF'
<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

EOF
  elif [[ "$f" == *.js || "$f" == *.ts || "$f" == *.cjs || "$f" == *.mjs ]]; then
    cat <<'EOF'
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

EOF
  else
    cat <<'EOF'
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project.

EOF
  fi
}

# 判断文件是否已有 copyright header (前 8 行匹配)
has_header() {
  head -8 "$1" | grep -q 'Copyright.*xiaoxian'
}

# 真正加头: 保留首行 shebang(若有); 带 frontmatter 的 .md 不碰
apply_header() {
  local f="$1"
  local tmp="$f.tmp"
  # frontmatter 保护: .md 首行是 --- 则跳过(避免破坏 YAML frontmatter)
  if [[ "$f" == *.md ]]; then
    local first_md
    first_md="$(head -1 "$f")"
    if [[ "$first_md" == "---" ]]; then
      echo "  ↷ 跳过 frontmatter .md: $f"
      return 0
    fi
  fi
  local first_line
  first_line="$(head -1 "$f")"
  if [[ "$first_line" == "#!"* ]]; then
    {
      printf '%s\n' "$first_line"
      build_header "$f"
      tail -n +2 "$f"
    } > "$tmp"
  else
    {
      build_header "$f"
      cat "$f"
    } > "$tmp"
  fi
  mv "$tmp" "$f"
}

# 收集候选文件
candidates=()
while IFS= read -r -d '' f; do
  # 跳过 exclude dirs
  skip=false
  for ex in "${EXCLUDE_DIRS[@]}"; do
    [[ "$f" == *"/$ex/"* ]] && skip=true && break
  done
  $skip && continue
  # 跳过 exclude files
  for exf in "${EXCLUDE_FILES[@]}"; do
    [[ "$f" == "./$exf" ]] && skip=true && break
  done
  $skip && continue
  # 跳过已有 header 的
  has_header "$f" && continue
  # frontmatter 保护: .md 首行是 --- 则跳过（与 apply_header 一致，避免破坏 YAML frontmatter；
  # 否则 dry-run 会把 ADR/技能 SKILL.md 列为"待加"，但实际 apply 会跳过 → 数字虚高）
  if [[ "$f" == *.md ]]; then
    [[ "$(head -1 "$f")" == "---" ]] && continue
  fi
  candidates+=("$f")
# 🔴 必须 prune node_modules 与 .git：本仓 node_modules 合计 2 万+ 文件，全走一遍
#    会对每个文件调 head+grep+git check-ignore（数千个子进程），本地跑要几分钟甚至被 OOM 干掉，
#    而它们的候选结果一定是「被 .gitignore 忽略 → 跳过」。
#    2026-11-09 加：CI 的 license-header job 是能过的，但本地跑不动 ⇒ 本地没法自查，
#    于是它红了四天没人发现。剪掉这两个目录后本地几十秒可跑完。
done < <(find . \( -name node_modules -o -name .git \) -prune -o \
  \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.ts' -o -name '*.py' -o -name '*.md' \) \
  -type f -print0 2>/dev/null)

# ④ 过滤被 .gitignore 忽略的内部资产（MEMORY-*.md / docs/内部 / .pytest_cache 等）：
#    这些文件在盘上但永不进公开仓，不该被版权头脚本改动，避免污染内部笔记与缓存。
#    用 git check-ignore -z（NUL 分隔、不包裹引号）避免中文路径被加引号后比较失配。
if [ ${#candidates[@]} -gt 0 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # 一次 stdin 调用批量问，而不是每个文件 fork 一次 `git check-ignore`：
  # 候选有几百个时，逐文件调用是几百个子进程（同样的结果，慢一个数量级）。
  _ign_tmp="$(mktemp)"
  # core.quotepath=false：否则中文路径会被 git 加引号（"\345\256..."），
  # 与候选列表的裸路径对不上 → 内部资产被误当成「未忽略」。
  printf '%s\n' "${candidates[@]}" | git -c core.quotepath=false check-ignore --stdin >"$_ign_tmp" 2>/dev/null || true
  # ⚠️ 忽略清单为空时**不能**过 awk：`NR==FNR` 在第一个文件为空时对第二个文件恒真，
  #    会把所有候选当「已忽略」吞掉 → 候选数 0 → 假绿（2026-11-09 在本机亲手踩到）。
  if [ -s "$_ign_tmp" ]; then
    filtered=()
    while IFS= read -r f; do
      filtered+=("$f")
    done < <(awk 'NR==FNR{ig[$0]=1;next} !($0 in ig)' "$_ign_tmp" <(printf '%s\n' "${candidates[@]}"))
    candidates=("${filtered[@]+"${filtered[@]}"}")
  fi
  rm -f "$_ign_tmp"
fi

total=${#candidates[@]}
if [ "$total" -eq 0 ]; then
  echo "=== Copyright Header Dry-Run (DRY_RUN=$DRY_RUN) ==="
  echo "候选文件数: 0"
  echo "无文件需要加头"
  exit 0
fi
echo "=== Copyright Header Dry-Run (DRY_RUN=$DRY_RUN) ==="
echo "候选文件数: $total"

if $DRY_RUN; then
  echo "DRY-RUN 模式: 只列出文件, 不修改"
  echo "--- 全部候选 ---"
  printf '%s\n' "${candidates[@]}"
  echo ""
  echo "执行真正修改请设 DRY_RUN=false 并跑:"
  echo "  DRY_RUN=false bash scripts/add-copyright-header.sh"
else
  echo "RUN 模式: 开始加头..."
  added=0
  for f in "${candidates[@]}"; do
    apply_header "$f"
    added=$((added + 1))
  done
  echo "完成: $added 个文件已加头"
  echo ""
  echo "下一步(必须显式 git add --):"
  echo "  git status --short | head -30"
  echo "  git add -- <explicit-files>   # 不要 git add -A"
  echo "  git commit -m 'chore(license): 批量加版权头 (\$added 文件)'"
fi
