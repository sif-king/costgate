#!/usr/bin/env bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.
#
# rollback-chatgpt-shim.sh —— 撤销 2026-10-11 对 /Applications/ChatGPT.app 的越界改动
#
# 背景（写在脚本里，因为将来不会有人去翻那天的日志）：
#   为了让桌面端双击启动时注入 CODEX_HOME，曾往 app 内塞了一个 ChatGPTMP shim，
#   并把 Info.plist 的 CFBundleExecutable 改成它。
#   改 Info.plist 就会让整包签名校验失效（spctl: invalid resource directory），
#   macOS 于是拒绝启动 —— 表现是双击弹窗报错，且没有任何日志说明原因。
#   这个雷躺了一个月，2026-11-09 才发现。
#
# 本脚本 = 2026-11-09 实际手工走过一遍、并验证过 app 能启动的步骤。
# 顺序不能改：先还原 plist 和删 shim，最后才重签；否则签出来的是坏状态的快照。
#
# ⚠️ 代价必须说清：官方公证签名在这一步之后**找不回来**，
#    只能等 app 自动更新（会整包替换）或手动重装。
#    本脚本恢复的是「能启动 + 原 CFBundleExecutable」，不是「官方签名」。
#
# 用法：bash scripts/rollback-chatgpt-shim.sh [--dry-run]
# 退出码：0 回滚完成且验签通过 / 1 失败

set -uo pipefail

APP="/Applications/ChatGPT.app"
BACKUP="$HOME/multi-proxy-gui-b-backup-20261011"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi
}

[ -d "$APP" ] || { say "没有 $APP，无需回滚"; exit 0; }

say "回滚 $APP"
say "  备份目录：$BACKUP"

# ① 还原 Info.plist（必须用原始那份，不是「把 CFBundleExecutable 改回去」——
#    只改一个键仍会留下格式差异，签名 seal 一样对不上）
if [ -f "$BACKUP/Info.plist.orig" ]; then
  run "cp -p '$APP/Contents/Info.plist' /tmp/Info.plist.before-rollback.\$(date +%s)"
  run "cp -p '$BACKUP/Info.plist.orig' '$APP/Contents/Info.plist'"
  say "  ① Info.plist 已还原"
else
  say "  ! 找不到 $BACKUP/Info.plist.orig，跳过①（无法保证签名自洽）"
fi

# ② 删掉 shim
if [ -f "$APP/Contents/MacOS/ChatGPTMP" ]; then
  run "rm -f '$APP/Contents/MacOS/ChatGPTMP'"
  say "  ② shim 已删除"
else
  say "  ② shim 不存在（已删过）"
fi

# ③ 清掉上次重签留下的 cstemp —— 不清会在重签时被算进资源清单，
#    签完立刻变成 "a sealed resource is missing or invalid"。这一步是踩过的坑。
run "find '$APP' -name '*.cstemp' -delete 2>/dev/null || true"
say "  ③ cstemp 残留已清"

# ④ 从内到外重签（子组件先签，不然外层签完子组件仍对不上）
run "xattr -dr com.apple.quarantine '$APP' 2>/dev/null || true"
for sub in "$APP/Contents/PlugIns/CodexDockTilePlugin.docktileplugin" "$APP/Contents/Frameworks"/*; do
  [ -e "$sub" ] && run "codesign --force -s - '$sub' >/dev/null 2>&1"
done
run "codesign --force -s - '$APP' >/dev/null 2>&1"
say "  ④ 已用 ad-hoc 重签（官方公证签名需 app 更新/重装才能回来）"

# ⑤ 验签：这是「做完了」和「以为做完了」的分界
if [ "$DRY" = 1 ]; then
  say "  [dry-run] 跳过验签"
  exit 0
fi
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  say "  ✓ 验签通过，app 可以正常启动"
  exit 0
else
  say "  ✗ 验签仍不通过 —— 跑 bash scripts/doctor.sh 看具体哪一项"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | head -8 | sed 's/^/    /'
  exit 1
fi
