#!/usr/bin/env bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.
#
# preflight.sh —— 提交前跑一遍「CI 会跑的东西」，别让 CI 替你发现
#
# 为什么要它（2026-11-09）：
#   P0 Security Gate 在 main 上**连续红了四天没人看**（最近 4 次 run 全 failure）。
#   四个 job 各有真原因：shell 那条是 check.sh 把注释当代码（误报）、
#   verify-delivery 是文档引用了已删除的路径、license-header 缺 4 个头、
#   dep-audit 是 follow-redirects 有 high 漏洞。
#   共同点：**每一条都能在本地几十秒内复现**，而没人跑——因为本地没有入口。
#
# 与另外三个脚本的分工（别合并，受众不同）：
#   install/quickstart = 给新用户装上
#   verify.sh          = 给用户自证「我这台机器上发生了什么」
#   doctor.sh          = 给我排障「环境为什么让它跑不起来」
#   preflight.sh       = 给我提交前自查「CI 会不会红」
#
# 纪律：
#   ① 只读：不改文件、不起服务、不发会花钱的请求。
#   ② 跑不了的项必须**明说是没跑**，不能算通过（本地缺 pip-audit 时 dep-audit 就属于这种）。
#   ③ 不重复实现 CI 的逻辑：直接调 CI 调的同一批脚本，避免「本地一套、CI 一套」漂移。
#
# 用法：
#   bash scripts/preflight.sh              # 默认：跳过版权头全树扫描（那一步要几分钟）
#   bash scripts/preflight.sh --full       # 连版权头也扫（提交大改前跑一次）
#   bash scripts/preflight.sh --quick      # 跳过 bats（干净 checkout 仍跑，它只要 2 秒）
#   bash scripts/preflight.sh --no-clean   # 不建干净 checkout（CI 走离线镜像/无 git 时）
#
# 退出码：0 全过 / 1 有失败

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0
FULL=0
NO_CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --full)  FULL=1 ;;
    --no-clean) NO_CLEAN=1 ;;
    *) printf '未知参数：%s（可用：--quick / --full / --no-clean）\n' "$arg" >&2; exit 2 ;;
  esac
done

FAILS=0
SKIPPED=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
skip() { printf '  \033[33m-\033[0m %s（未跑，不算通过）\n' "$*"; }

# run_step <显示名> <命令...>
run_step() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    ok "$name"
    return 0
  fi
  bad "$name"
  # 只打最后 12 行：CI 日志里最贵的也是这段，前面全是噪声
  printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  FAILS=$((FAILS + 1))
  return 1
}

bold "multi-proxy 提交前自查（只读）"
dim "跑的全是 CI 跑的同一批脚本；跑不了的会明说「未跑」。"
printf '\n'

# ── 0. 干净 checkout 复现（等价 CI 的 checkout：只有入库文件）──
# 为什么要这一步（2026-11-09）：
#   drift-check 本地连绿、CI 连红四天。根因不是脚本有 bug，是 DEFAULT_WATCH 里列了
#   3 个 .gitignore 掉的本地私有件 —— 本地磁盘上有 → 绿；CI 干净 checkout 上没有 → 红。
#   同一道门禁在两边给出相反结论，而没有任何一侧能看见另一侧，于是没人能推出真相。
#   教训：**本地跑的那份树，和 CI 跑的那份树，可能不是同一份。**
#   凡是「答案取决于树里有什么」的检查，都得在干净 checkout 里再跑一遍。
CLEAN_DIR=""
cleanup_clean() {
  [ -n "$CLEAN_DIR" ] || return 0
  git worktree remove "$CLEAN_DIR" --force >/dev/null 2>&1 || rm -rf "$CLEAN_DIR" 2>/dev/null
  CLEAN_DIR=""
}
trap cleanup_clean EXIT

# run_step_in <目录> <显示名> <命令...>：在指定目录里跑，失败时点明「本地绿、clean 红」
run_step_in() {
  local d="$1"; shift
  local name="$1"; shift
  local out
  if out="$( cd "$d" && "$@" 2>&1 )"; then
    ok "$name"
    return 0
  fi
  bad "$name"
  printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  dim "      ↑ 本地工作区是绿的、只有干净 checkout 会红 —— 这就是 CI 上看到的样子"
  FAILS=$((FAILS + 1))
  return 1
}

if [ "$NO_CLEAN" = "1" ]; then
  skip "干净 checkout 复现（--no-clean 跳过）"
  SKIPPED=$((SKIPPED + 1))
elif ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
  skip "干净 checkout 复现（这里不是 git 工作区）"
  SKIPPED=$((SKIPPED + 1))
else
  _TRY="$(mktemp -d "${TMPDIR:-/tmp}/mp-preflight-clean-XXXXXX" 2>/dev/null || true)"
  _WT_ERR=""
  if [ -z "$_TRY" ]; then
    skip "干净 checkout 复现（mktemp 建不出临时目录：TMPDIR 不可写？）"
    SKIPPED=$((SKIPPED + 1))
  elif ! _WT_ERR="$(git worktree add --detach "$_TRY" HEAD 2>&1)"; then
    # 别把原因猜成「磁盘满 / 权限」—— 按 git 的原话归类，再给一条能看的完整日志。
    # （2026-11-09 实测：整段原话里带着含中文的绝对路径，终端会把那一行吞掉，
    #   所以这里不直接贴原话，只贴归类结论 + 落盘位置。）
    _WT_LOG="${TMPDIR:-/tmp}"; _WT_LOG="${_WT_LOG%/}/mp-preflight-worktree.err"
    printf '%s\n' "$_WT_ERR" > "$_WT_LOG" 2>/dev/null || _WT_LOG="（没写成功）"
    _WT_WHY="未识别的失败"
    case "$_WT_ERR" in
      *"update_ref failed"*|*"couldn't set 'HEAD'"*) _WT_WHY="写不进 .git/worktrees（HEAD.lock 被锁/被拦）" ;;
      *"No space left"*|*"disk full"*)               _WT_WHY="磁盘满" ;;
      *"not a git repository"*)                      _WT_WHY="这里不是 git 工作区" ;;
      *"already registered"*|*"already exists"*)      _WT_WHY="同一路径已注册成 worktree（git worktree prune）" ;;
    esac
    # 失败时 git 可能已经建了半个目录，先尽力清掉，别把垃圾留在 TMPDIR 里
    if [ -n "$_TRY" ]; then rm -rf "$_TRY" 2>/dev/null || true; fi
    skip "干净 checkout 复现（git worktree add 失败：${_WT_WHY}）"
    dim "      git 完整报错：${_WT_LOG}"
    SKIPPED=$((SKIPPED + 1))
  else
    CLEAN_DIR="$_TRY"
    # 未提交的改动也要打进去，否则查的是「上次提交」而不是「你即将提交的东西」
    _PATCH_OK=1
    _P="$(git diff HEAD --binary 2>/dev/null || true)"
    if [ -n "$_P" ]; then
      printf '%s\n' "$_P" | git -C "$CLEAN_DIR" apply --whitespace=nowarn - >/dev/null 2>&1 || _PATCH_OK=0
    fi
    # 未跟踪的新文件（排除 ignore 的）也拷进去
    _N=0
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      mkdir -p "$CLEAN_DIR/$(dirname "$_f")" 2>/dev/null || true
      cp "$_f" "$CLEAN_DIR/$_f" 2>/dev/null && _N=$((_N + 1)) || true
    done <<< "$(git ls-files --others --exclude-standard 2>/dev/null || true)"

    if [ "$_PATCH_OK" != "1" ]; then
      # 打不上补丁 = 这份副本不代表你要提交的东西，说清楚，别冒充绿灯
      skip "干净 checkout 复现（工作区改动打不进副本：可能有二进制/权限变更）"
      SKIPPED=$((SKIPPED + 1))
      cleanup_clean
    else
      dim "干净 checkout：$(printf '%s' "$(git rev-parse --short HEAD)") + 工作区改动${_N:+（含 $_N 个未跟踪新文件）}"
      run_step_in "$CLEAN_DIR" "干净 checkout：文档引用的路径都还在" node scripts/drift-check.js
      run_step_in "$CLEAN_DIR" "干净 checkout：交付体系 live 校验" node scripts/verify-delivery.js
      cleanup_clean
    fi
  fi
fi

# ── 1. 文档↔代码漂移（CI: verify-delivery job 第一步）──
run_step "文档引用的路径都还在（scripts/drift-check.js）" node scripts/drift-check.js

# ── 2. 交付体系 6 项 live 校验（CI: verify-delivery job 第二步）──
run_step "交付体系 live 校验（scripts/verify-delivery.js）" node scripts/verify-delivery.js

# ── 3. shell 脚本门禁（CI: shell job）──
run_step "shell 脚本门禁（tests/shell/check.sh）" bash tests/shell/check.sh

# ── 3b. 面板一致性（防「页面还在、入口没了」/「后端挂着、前端没调」）──
# 这两类都不报错，跑一遍也一切正常，只有用户点不到。所以必须机器判。
run_step "面板清单/导航可达/孤儿后端标注（scripts/check-panel-coherence.sh）" bash scripts/check-panel-coherence.sh

# ── 3c. 面板行为（CI: manager job「panel behavior tests」）──
# 四条纯 node 断言：内联脚本语法 / 读失败不许假绿 / 写失败不许乐观更新 / toast 结构契约。
# 它们长期没进任何闸门 —— 结果页面重构后脚手架脱节，红了也没人知道
# （实测 5 + 6 条假红：MPStates 未 stub、只取到外链 <script src>、缺 addEventListener）。
# 不并入 jest：它们不需要 npm ci，跑一次不到 2 秒，放在最前面最快暴露。
run_step "面板行为测试（tests/node 四条）" bash -c '
  cd multi-proxy-manager &&
  node tests/node/panel-syntax-guard.test.js &&
  node tests/node/panel-read-failure.test.js &&
  node tests/node/proxy-config-write-safety.test.js &&
  node tests/node/mp-kernel-toast.test.js
'

# ── 4. 版权头（CI: license-header job）──
# CI 判据是「候选文件数 == 0」，调的是同一个脚本。
# ⚠️ 这一步在本机要 6 分钟左右（要扫 dist/ 那几千个构建产物），所以**默认不跑**，
#    加 --full 才跑。默认跳过时必须说清「没跑」，不能让它看起来像过了。
if [ "$FULL" != "1" ]; then
  skip "版权头检查（默认跳过，约 6 分钟；加 --full 才跑）"
  SKIPPED=$((SKIPPED + 1))
elif HDR_OUT="$(bash scripts/add-copyright-header.sh 2>&1)"; then
  HDR_N="$(printf '%s' "$HDR_OUT" | grep '候选文件数:' | sed -E 's/.*: *//')"
  if [ "${HDR_N:-1}" = "0" ]; then
    ok "版权头齐全（候选 0）"
  else
    bad "有 ${HDR_N:-?} 个文件缺版权头"
    printf '%s\n' "$HDR_OUT" | grep -E '^\s+\S' | head -8 | sed 's/^/      /'
    dim "      修：DRY_RUN=false bash scripts/add-copyright-header.sh"
    FAILS=$((FAILS + 1))
  fi
else
  # 脚本自己挂了（不是「文件缺头」）——这也是失败，不能算跳过。
  bad "版权头检查脚本执行失败"
  printf '%s\n' "$HDR_OUT" | tail -5 | sed 's/^/      /'
  FAILS=$((FAILS + 1))
fi

# ── 5. shell 测试全量（本地 139 条，CI 只跑 manage.sh 那一个文件）──
if [ "$QUICK" = "1" ]; then
  skip "bats 全量（--quick）"
  SKIPPED=$((SKIPPED + 1))
elif ! command -v bats >/dev/null 2>&1; then
  skip "bats 全量（本机未装 bats，brew install bats-core）"
  SKIPPED=$((SKIPPED + 1))
else
  if BATS_OUT="$(bats tests/shell/*.bats 2>&1)"; then
    ok "bats 全量（$(printf '%s' "$BATS_OUT" | grep -cE '^ok ') 条）"
  else
    bad "bats 有失败"
    printf '%s\n' "$BATS_OUT" | grep -E '^not ok' | head -10 | sed 's/^/      /'
    FAILS=$((FAILS + 1))
  fi
fi

# ── 6. 生产依赖卫生（CI 无对应 job —— 它抓的是「别人装不上、我这好好的」）──
run_step "生产依赖有没有主（scripts/check-prod-deps.js）" node scripts/check-prod-deps.js

# ── 6b. 镜像构建上下文（同样只对外部用户失败：dist 在本地、不在干净 clone）──
run_step "镜像 COPY 源在不在构建上下文里（scripts/check-docker-context.js）" node scripts/check-docker-context.js

# ── 6c. 旧历史 ref 卫生（防 git push --tags / --all 把内部资产送回公开仓）──
run_step "旧历史 ref 有没有混进发布通道（scripts/check-legacy-refs.sh）" bash scripts/check-legacy-refs.sh

# ── 6d. 对外文档的句子层（结构守卫抓不到的那一半：破折号/反问/元话语/套话）──
# 判据与阈值真源：docs/12-docs/DOCS-METHODOLOGY.md §7；词表在脚本里，不抄进文档。
run_step "对外文档读起来像不像 AI 写的（scripts/check-doc-tone.js）" node scripts/check-doc-tone.js

# ── 7. 依赖审计（CI: dep-audit job）──
if [ -n "${CI:-}" ] || python3 -c 'import pip_audit' 2>/dev/null || command -v pip-audit >/dev/null 2>&1; then
  run_step "依赖审计（scripts/dep-audit.py）" python3 scripts/dep-audit.py
else
  skip "依赖审计（本机无 pip-audit：pip install pip-audit==2.10.1）"
  SKIPPED=$((SKIPPED + 1))
fi

# ── 结论 ──
printf '\n'
if [ "$FAILS" -eq 0 ]; then
  bold "结论：本地跑的这些全过。"
  [ "$SKIPPED" -eq 0 ] || dim "另有 $SKIPPED 项没跑（见上面 - 行），它们在 CI 里仍会跑。"
  exit 0
else
  bold "结论：$FAILS 项不过（见 ✗）。"
  dim "这些就是 CI 会红的地方。修完再跑一次，✗ 消失才算真过。"
  exit 1
fi
