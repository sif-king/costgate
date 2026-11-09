#!/usr/bin/env bash
# free-llm · 自动保鲜：把 refresh-models.mjs 挂成 launchd 用户任务（每 6h + 登录即跑）
# 用法：
#   bash auto-refresh.sh          注册并触发一次（幂等，可重复跑）
#   bash auto-refresh.sh --stop   注销并删除 plist
# 说明：运行时解析 node / refresh 路径，不烤死机器路径，可进 git；
#       refresh 是 add-only + 失败即跳 + 原子写回，对 live 各 provider（含本地聚合器）安全。
set -euo pipefail
# 强制 UTF-8 locale：防止调用方 locale 非 UTF-8 时，脚本里「$VAR 紧跟全角字符」被并入变量名解析而报 unbound variable
export LC_ALL=C.UTF-8 LANG=C.UTF-8

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFRESH="$HERE/refresh-models.mjs"
NODE="$(command -v node)"
LABEL="com.multi-proxy.free-llm-refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.multi-proxy-manager"
LOG="$LOGDIR/refresh-models.log"
ERR="$LOGDIR/refresh-models.err.log"
UID_NUM="$(id -u)"

[ -f "$REFRESH" ] || { echo "✗ 找不到 $REFRESH"; exit 1; }

if [ "${1:-}" = "--stop" ]; then
  echo "· 注销 $LABEL"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ 已注销 + 删除 plist"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REFRESH</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$ERR</string>
</dict>
</plist>
EOF

# 先注销旧的（幂等）再注册
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

echo "✓ 已注册 $LABEL （每 6h + 登录即跑）node=$NODE"
echo "  日志：$LOG / $ERR"
sleep 1
launchctl list | grep -i "$LABEL" || echo "(launchctl list 暂未显示，RunAtLoad 可能仍在跑，稍后复查)"
