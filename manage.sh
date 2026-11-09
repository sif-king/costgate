#!/bin/bash
set -e

# Multi-Proxy Manager - 一键管理脚本（新版扁平目录结构）
# 用法: ./manage.sh [start|stop|restart|bootout|status|logs]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 日志目录
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
if [ $? -ne 0 ]; then
  print_error "无法创建日志目录: $LOG_DIR"
  exit 1
fi

# 各代理目录（扁平结构，平级关系）
CODEx_PROXY_DIR="$SCRIPT_DIR/codex-proxy"
HERMES_PROXY_DIR="$SCRIPT_DIR/hermes-proxy"
CURSOR_PROXY_DIR="$SCRIPT_DIR/cursor-proxy"
DSH_PROXY_DIR="$SCRIPT_DIR/dsh-proxy"
CLAUDE_PROXY_DIR="$SCRIPT_DIR/claude-proxy"
OPENCODE_PROXY_DIR="$SCRIPT_DIR/opencode-proxy"
GENERIC_OPENAI_PROXY_DIR="$SCRIPT_DIR/generic-openai-proxy"
MANAGER_DIR="$SCRIPT_DIR/multi-proxy-manager"

# 端口
CODEx_PORT=18790
HERMES_PORT=18793
CURSOR_PORT=18794
DSH_PORT=18797
CLAUDE_PORT=18791
OPENCODE_PORT=18798
GENERIC_PORT=18799
MANAGER_PORT=18792
UNIFIED_PORT=18880
UNIFIED_DIR="$SCRIPT_DIR/unified-ingress"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 用 printf 不用 echo -e：macOS 自带 bash 3.2 的 echo 在多字节场景下会吃字符，
# 而且 printf 不会把消息里的反斜杠再解释一遍。
print_status() { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
print_error()  { printf "${RED}[✗]${NC} %s\n" "$1"; }
print_warning() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }

# lsof 可执行文件解析（ADR-0001 + 2026-10-13 跨平台修订）：
# launchd 启动的进程 PATH 可能不含 /usr/sbin，裸 lsof 会 ENOENT → isProcessRunning
# 静默误判「未运行」（历史事故，见 docs/03-adr/0001）。跨平台移植后裁决更新为：
# macOS 仍优先绝对路径 /usr/sbin/lsof；Linux 等平台 lsof 在 PATH 中（/usr/bin/lsof），
# 回退 command -v 查找；找不到则 LSOF 为空，端口检测回退 ss / /proc/net/tcp。
if [ -x /usr/sbin/lsof ]; then
  LSOF=/usr/sbin/lsof
elif command -v lsof >/dev/null 2>&1; then
  LSOF=lsof
else
  LSOF=""
fi

# 检查端口是否被占用（跨平台：优先 lsof，回退 ss，再回退 /proc/net/tcp）
is_port_in_use() {
  local port=$1
  if [ -n "$LSOF" ]; then
    # 🔴 必须限定 -sTCP:LISTEN（2026-11-08 实测踩到）：
    # `lsof -i :PORT` 会把**本机客户端连出去的短连接**也算进来。实测 49999 上只有
    # Chrome → 本地代理的 ESTABLISHED（客户端侧临时端口），没有任何人 LISTEN，
    # 旧写法照样返回「占用」。而临时端口就在 49152–65535 之间——一台开着浏览器的
    # 机器上，这意味着随机撞上「端口被占用」，代理起不来且日志里看不出原因。
    "$LSOF" -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]${port}[[:space:]]" && return 0
  fi
  if [ -f /proc/net/tcp ] 2>/dev/null; then
    local hex
    hex="$(printf '%04X' "$port" 2>/dev/null)"
    # 第 4 列是 TCP 状态，0A = LISTEN。只看 LISTEN，否则同上面那个坑：
    # 本机连出去的连接（01 ESTABLISHED 等）也会被当成「有人在这个端口上」。
    [ -n "$hex" ] && awk -v h=":$hex" '$2 ~ h"$" && $4 == "0A"' /proc/net/tcp 2>/dev/null | grep -q . && return 0
  fi
  return 1
}

# 取占用端口的 PID（跨平台）
pid_on_port() {
  local port=$1
  if [ -n "$LSOF" ]; then
    # 同上：必须 -sTCP:LISTEN。不限定的话，这里会返回「连到这个端口的那个客户端」
    # 的 pid —— 拿它去 kill 就是杀错进程。
    "$LSOF" -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then
    # 🔴 旧写法先 `grep -oE ":$port[[:space:]]"` 再 grep 'pid=' —— 第一个 grep 的 -o
    # 已把 pid= 信息丢掉，第二个 grep 永远空。必须整行匹配后再提取 pid。
    ss -ltnp 2>/dev/null | grep -E ":${port}[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
  fi
}

# 等待端口绑定（轮询 lsof，最长 WAIT_FOR_PORT_TIMEOUT 毫秒，默认 10 秒）
WAIT_FOR_PORT_TIMEOUT=${WAIT_FOR_PORT_TIMEOUT:-10000}
wait_for_port() {
  local port=$1
  local waited=0
  local step=200
  while [ $waited -lt $WAIT_FOR_PORT_TIMEOUT ]; do
    if is_port_in_use "$port"; then
      return 0
    fi
    sleep 0.2
    waited=$((waited + step))
  done
  return 1
}

# 启动 Codex Proxy
start_codex() {
  if [ ! -f "$CODEx_PROXY_DIR/proxy.js" ]; then
    print_warning "Codex Proxy 未安装: $CODEx_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$CODEx_PROXY_DIR/node_modules" ]; then
    print_warning "Codex Proxy 依赖未安装，正在安装..."
    (cd "$CODEx_PROXY_DIR" && npm install --production) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Codex Proxy 依赖安装失败"
      return 1
    fi
    print_status "Codex Proxy 依赖安装完成"
  fi

  if is_port_in_use $CODEx_PORT; then
    print_warning "Codex Proxy 已在运行 (端口 $CODEx_PORT)"
    return 0
  fi

  cd "$CODEx_PROXY_DIR" || exit 1
  print_status "启动 Codex Proxy..."
  nohup node proxy.js > "$LOG_DIR/codex-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CODEx_PORT; then
    print_status "Codex Proxy 启动成功 (PID: $pid, 端口: $CODEx_PORT)"
    return 0
  else
    print_error "Codex Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs codex"
    return 1
  fi
}

# 启动 DSH Proxy（DSH 桌面端专属 lane，2026-10-13 建）
# 背景：DSH 原先借用 codex lane（18790），与 Codex 混日志/混成本/混模型列表，
# 且 codex lane 会读 ~/.codex/config.toml 当 provider 源（agent 耦合）。
# 本 lane 与 codex-proxy 同引擎（proxy.js 拷贝），端口独立、配置独立（.env PORT=18797）。
start_dsh() {
  if [ ! -f "$DSH_PROXY_DIR/proxy.js" ]; then
    print_warning "DSH Proxy 未安装: $DSH_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$DSH_PROXY_DIR/node_modules" ]; then
    print_warning "DSH Proxy 依赖未安装，正在安装..."
    (cd "$DSH_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "DSH Proxy 依赖安装失败"
      return 1
    fi
    print_status "DSH Proxy 依赖安装完成"
  fi

  if is_port_in_use $DSH_PORT; then
    print_warning "DSH Proxy 已在运行 (端口 $DSH_PORT)"
    return 0
  fi

  cd "$DSH_PROXY_DIR" || exit 1
  print_status "启动 DSH Proxy..."
  nohup node proxy.js > "$LOG_DIR/dsh-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $DSH_PORT; then
    print_status "DSH Proxy 启动成功 (PID: $pid, 端口: $DSH_PORT)"
    return 0
  else
    print_error "DSH Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs dsh"
    return 1
  fi
}

# 启动 Hermes Proxy
start_hermes() {
  if [ ! -f "$HERMES_PROXY_DIR/proxy.py" ]; then
    print_warning "Hermes Proxy 未安装: $HERMES_PROXY_DIR/proxy.py 不存在"
    return 1
  fi

  if is_port_in_use $HERMES_PORT; then
    print_warning "Hermes Proxy 已在运行 (端口 $HERMES_PORT)"
    return 0
  fi

  cd "$HERMES_PROXY_DIR" || exit 1
  print_status "启动 Hermes Proxy..."
  nohup python3 proxy.py > "$LOG_DIR/hermes-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $HERMES_PORT; then
    print_status "Hermes Proxy 启动成功 (PID: $pid, 端口: $HERMES_PORT)"
    return 0
  else
    print_error "Hermes Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs hermes"
    return 1
  fi
}

# 启动 Cursor Proxy
start_cursor() {
  # Check and compile TypeScript if dist missing
  if [ ! -d "$CURSOR_PROXY_DIR/dist" ]; then
    print_warning "Cursor Proxy 未编译，正在编译..."
    BUILD_LOG="$LOG_DIR/cursor-build.log"
    (cd "$CURSOR_PROXY_DIR" && npm run build 2>&1) > "$BUILD_LOG"
    BUILD_EXIT=$?
    if [ $BUILD_EXIT -ne 0 ]; then
      print_error "Cursor Proxy 编译失败，详情: $BUILD_LOG"
      print_warning "查看日志: cat $BUILD_LOG"
      return 1
    fi
    print_status "Cursor Proxy 编译完成"
  fi

  if [ ! -f "$CURSOR_PROXY_DIR/dist/server/start.js" ]; then
    print_warning "Cursor Proxy 未编译: $CURSOR_PROXY_DIR/dist/server/start.js 不存在"
    print_warning "请先运行: cd cursor-proxy && npm run build"
    return 1
  fi

  # Rebuild native modules (better-sqlite3) to ensure correct platform/arch
  if [ -f "$CURSOR_PROXY_DIR/node_modules/better-sqlite3/package.json" ]; then
    print_status "重建 Cursor Proxy 原生模块..."
    (cd "$CURSOR_PROXY_DIR" && npm rebuild better-sqlite3 2>&1)
    if [ $? -ne 0 ]; then
      print_warning "原生模块重建失败，尝试重新安装..."
      (cd "$CURSOR_PROXY_DIR" && rm -rf node_modules && npm install 2>&1)
      # Rebuild after full reinstall
      (cd "$CURSOR_PROXY_DIR" && npm rebuild better-sqlite3 2>&1)
      if [ $? -ne 0 ]; then
        print_error "Cursor Proxy 原生模块修复失败"
        print_warning "请检查: cd cursor-proxy && npm rebuild better-sqlite3"
        return 1
      fi
      print_status "原生模块重新安装完成"
    else
      print_status "原生模块重建完成"
    fi
  fi

  if is_port_in_use $CURSOR_PORT; then
    print_warning "Cursor Proxy 已在运行 (端口 $CURSOR_PORT)"
    return 0
  fi

  cd "$CURSOR_PROXY_DIR" || exit 1
  print_status "启动 Cursor Proxy..."

  # M6 固化 (2026-09-30): coding 任务路由 override 开关
  # 非侵入铁律 (ADR-0003): 默认 NOT 注入 PROXY_ROUTE_OVERRIDE →
  #   生产 18794 行为逐字节不变 (shadow 稳态), 绝不全局 launchctl setenv。
  #   开 override: CURSOR_ROUTE_OVERRIDE=1 ./manage.sh start cursor
  #     → 子进程 env 注入 PROXY_ROUTE_OVERRIDE=1 (子进程局部, §3 允许)
  #     → coding 任务路由到 deepseek-v4-pro (B 验证 18801 隔离 200)
  #     → 审计落 cursor-proxy/data/override-audit.jsonl
  #   回退: 不设 CURSOR_ROUTE_OVERRIDE 重启即回 shadow 稳态。
  local CURSOR_OVERENV=()
  if [ "${CURSOR_ROUTE_OVERRIDE:-}" = "1" ]; then
    CURSOR_OVERENV=(PROXY_ROUTE_OVERRIDE=1)
    print_warning "M6 override 已开: coding 任务路由到 deepseek-v4-pro (审计: cursor-proxy/data/override-audit.jsonl)"
  fi

  nohup env "${CURSOR_OVERENV[@]}" node dist/server/start.js > "$LOG_DIR/cursor-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CURSOR_PORT; then
    print_status "Cursor Proxy 启动成功 (PID: $pid, 端口: $CURSOR_PORT)"
    return 0
  else
    print_error "Cursor Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs cursor"
    return 1
  fi
}

# 启动 Manager Shell
start_manager() {
  if [ ! -f "$MANAGER_DIR/server.js" ]; then
    print_error "Multi-Proxy Manager 未安装: $MANAGER_DIR/server.js 不存在"
    return 1
  fi

  if is_port_in_use $MANAGER_PORT; then
    print_warning "Manager Shell 已在运行 (端口 $MANAGER_PORT)"
    return 0
  fi

  cd "$MANAGER_DIR" || exit 1
  print_status "启动 Multi-Proxy Manager Shell..."
  nohup node server.js > "$LOG_DIR/manager.log" 2>&1 &
  local pid=$!

  if wait_for_port $MANAGER_PORT; then
    print_status "Manager Shell 启动成功 (PID: $pid, 端口: $MANAGER_PORT)"
    print_status "访问地址: http://localhost:$MANAGER_PORT"
    return 0
  else
    print_error "Manager Shell 启动失败"
    print_warning "查看日志: ./manage.sh logs manager"
    return 1
  fi
}

# 启动 Unified Ingress（18880 单端点接入层，可选前门）
start_unified_ingress() {
  if [ ! -f "$UNIFIED_DIR/server.js" ]; then
    print_warning "Unified Ingress 未安装: $UNIFIED_DIR/server.js 不存在"
    return 1
  fi

  if is_port_in_use $UNIFIED_PORT; then
    print_warning "Unified Ingress 已在运行 (端口 $UNIFIED_PORT)"
    return 0
  fi

  cd "$UNIFIED_DIR" || exit 1
  print_status "启动 Unified Ingress..."
  nohup node server.js > "$LOG_DIR/unified-ingress.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $UNIFIED_PORT; then
    print_status "Unified Ingress 启动成功 (PID: $pid, 端口: $UNIFIED_PORT)"
    return 0
  else
    print_error "Unified Ingress 启动失败"
    print_warning "查看日志: ./manage.sh logs unified-ingress"
    return 1
  fi
}

stop_unified_ingress()  { stop_service "Unified Ingress" $UNIFIED_PORT; }
restart_unified_ingress() { stop_unified_ingress; sleep 1; start_unified_ingress; }
bootout_unified_ingress() { bootout_service "Unified Ingress" $UNIFIED_PORT; }

# 停止服务（N-01 修复：检测 launchd 托管 → 自动 bootout → 失败 return 1）
stop_service() {
  local name=$1
  local port=$2

  if ! is_port_in_use $port; then
    print_warning "$name 未在运行"
    return 0
  fi

  local pid=$(pid_on_port $port)
  if [ -n "$pid" ]; then
    print_status "停止 $name (PID: $pid)..."
    kill $pid 2>/dev/null || true
    sleep 1

    if is_port_in_use $port; then
      print_warning "$name 未能正常停止，尝试强制终止..."
      kill -9 $pid 2>/dev/null || true
      sleep 1
      if is_port_in_use $port; then
        # 端口仍被占用：大概率 launchd KeepAlive 托管（杀了立刻被拉活）。
        # 自动尝试 bootout（N-01），失败则 return 1 不再骗用户。
        local label=$(find_launchd_label_for_port $port)
        if [ -n "$label" ]; then
          print_status "检测到 launchd 托管 ($label)，执行 bootout..."
          launchctl bootout gui/$(id -u) "$label" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null || true
          sleep 1
          if ! is_port_in_use $port; then
            print_status "$name 已通过 bootout 停止 (label: $label)"
            return 0
          fi
          print_error "$name bootout 后端口 $port 仍被占用，停止失败"
          return 1
        else
          print_warning "$name 端口 $port 仍被占用（非 launchd 托管的第三方进程？）停止失败"
          return 1
        fi
      fi
    fi
    if ! is_port_in_use $port; then
      print_status "$name 已停止"
    fi
    return 0
  fi

  # 🔴 A-3（2026-10-25）：端口被占但拿不到 PID（权限不足 / 非本用户进程 / lsof 缺失）。
  # 旧实现这里直接落到函数末尾 `return 0`，端口还占着却报「已停止」+ 退出 0，
  # 脚本与 CI 因此无法判定停止是否真的成功 —— 用户反馈「停止不干净」的返回码根因。
  print_error "$name 端口 $port 仍被占用，但无法获取进程 PID，停止失败"
  local hint
  hint="$(find_launchd_label_for_port $port)" || hint=""
  if [ -n "$hint" ]; then
    print_info "$name 疑为 launchd 托管 ($hint)，可执行: $0 bootout $name"
  else
    print_info "可能是其他用户的进程或权限不足；请用系统工具查看该端口的占用进程后手动结束"
  fi
  return 1
}

# 根据端口号反查 launchd label
# 命名约定：com.multi-proxy.<service>-<port>
# 🔴 A-4（2026-10-25 实测修复）：旧写法把 glob 字符串存进变量后**加引号**传给 plutil：
#      plutil -extract Label raw "$plist"  ⇒ plutil 收到字面量
#      "com.multi-proxy.*-18790.plist" 必然失败 ⇒ 反查恒为空 ⇒ bootout 永不触发。
#      本机实测：修复前 18790/18792 均返回空，而 plist 明明存在。
#      正确做法：glob 必须先**展开**（未加引号的 ls / 或用 for 循环）拿到真实路径，再传工具。
find_launchd_label_for_port() {
  local port=$1
  local dir="$HOME/Library/LaunchAgents"
  [ -d "$dir" ] || return 1
  local found lbl
  # 优先查命名约定：com.multi-proxy.*-<port>.plist（glob 在此处展开）
  found="$(ls "$dir"/com.multi-proxy.*-"${port}".plist 2>/dev/null | head -1)" || found=""
  if [ -n "$found" ] && [ -f "$found" ]; then
    lbl="$("/usr/bin/plutil" -extract Label raw "$found" 2>/dev/null)" || lbl=""
    if [ -n "$lbl" ]; then printf '%s' "$lbl"; return 0; fi
    # plutil 失败的兜底：python3（对含特殊字符/注释的 plist 更稳）
    lbl="$(/usr/bin/python3 - "$found" <<'PY' 2>/dev/null
import sys, plistlib
try:
    print(plistlib.load(open(sys.argv[1], 'rb')).get('Label', ''))
except Exception:
    pass
PY
)" || lbl=""
    if [ -n "$lbl" ]; then printf '%s' "$lbl"; return 0; fi
  fi
  # 兜底：遍历所有 plist 取 Label（兼容 com.multi-proxy-manager 等不含端口的旧命名）
  local p
  for p in "$dir"/*.plist; do
    [ -f "$p" ] || continue
    lbl="$("/usr/bin/plutil" -extract Label raw "$p" 2>/dev/null)" || lbl=""
    case "$lbl" in *"$port"*) printf '%s' "$lbl"; return 0 ;; esac
  done
  return 1
}

# 彻底卸载 launchd 托管服务（N-06）：bootout → 删 plist → 验证端口释放
bootout_service() {
  local name=$1
  local port=$2
  local label
  label=$(find_launchd_label_for_port $port)
  if [ -z "$label" ]; then
    print_warning "$name 无对应 launchd 托管（非 launchd 启动），用 stop 即可"
    stop_service "$name" $port
    return $?
  fi
  print_status "卸载 $name 的 launchd 托管 ($label)..."
  launchctl bootout gui/$(id -u) "$label" 2>/dev/null \
    || launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null \
    || true
  # 删 plist
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$plist" ] && rm -f "$plist" && print_status "plist 已删除: $plist"
  sleep 1
  if is_port_in_use $port; then
    print_error "$name 卸载后端口 $port 仍被占用（可能有外部进程占用）"
    return 1
  fi
  print_status "$name launchd 托管已卸载"
  return 0
}

stop_codex() { stop_service "Codex Proxy" $CODEx_PORT; }
stop_hermes() { stop_service "Hermes Proxy" $HERMES_PORT; }
stop_cursor() { stop_service "Cursor Proxy" $CURSOR_PORT; }
bootout_codex() { bootout_service "Codex Proxy" $CODEx_PORT; }
bootout_hermes() { bootout_service "Hermes Proxy" $HERMES_PORT; }
bootout_cursor() { bootout_service "Cursor Proxy" $CURSOR_PORT; }
bootout_dsh() { bootout_service "DSH Proxy" $DSH_PORT; }
bootout_claude() { bootout_service "Claude Proxy" $CLAUDE_PORT; }
bootout_opencode() { bootout_service "OpenCode Proxy" $OPENCODE_PORT; }
bootout_generic_openai() { bootout_service "Generic OpenAI Proxy" $GENERIC_PORT; }
bootout_manager() { bootout_service "Manager Shell" $MANAGER_PORT; }
start_claude() {
  if [ ! -f "$CLAUDE_PROXY_DIR/proxy.js" ]; then
    print_warning "Claude Proxy 未安装: $CLAUDE_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$CLAUDE_PROXY_DIR/node_modules" ]; then
    print_warning "Claude Proxy 依赖未安装，正在安装..."
    (cd "$CLAUDE_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Claude Proxy 依赖安装失败"
      return 1
    fi
    print_status "Claude Proxy 依赖安装完成"
  fi

  if is_port_in_use $CLAUDE_PORT; then
    print_warning "Claude Proxy 已在运行 (端口 $CLAUDE_PORT)"
    return 0
  fi

  cd "$CLAUDE_PROXY_DIR" || exit 1
  print_status "启动 Claude Proxy..."
  nohup node proxy.js > "$LOG_DIR/claude-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CLAUDE_PORT; then
    print_status "Claude Proxy 启动成功 (PID: $pid, 端口: $CLAUDE_PORT)"
    return 0
  else
    print_error "Claude Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs claude"
    return 1
  fi
}

stop_claude() { stop_service "Claude Proxy" $CLAUDE_PORT; }

start_opencode() {
  if [ ! -f "$OPENCODE_PROXY_DIR/proxy.js" ]; then
    print_warning "OpenCode Proxy 未安装: $OPENCODE_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$OPENCODE_PROXY_DIR/node_modules" ]; then
    print_warning "OpenCode Proxy 依赖未安装，正在安装..."
    (cd "$OPENCODE_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "OpenCode Proxy 依赖安装失败"
      return 1
    fi
    print_status "OpenCode Proxy 依赖安装完成"
  fi

  if is_port_in_use $OPENCODE_PORT; then
    print_warning "OpenCode Proxy 已在运行 (端口 $OPENCODE_PORT)"
    return 0
  fi

  cd "$OPENCODE_PROXY_DIR" || exit 1
  print_status "启动 OpenCode Proxy..."
  nohup node proxy.js > "$LOG_DIR/opencode-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $OPENCODE_PORT; then
    print_status "OpenCode Proxy 启动成功 (PID: $pid, 端口: $OPENCODE_PORT)"
    return 0
  else
    print_error "OpenCode Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs opencode"
    return 1
  fi
}

start_generic_openai() {
  if [ ! -f "$GENERIC_OPENAI_PROXY_DIR/proxy.js" ]; then
    print_warning "Generic OpenAI Proxy 未安装: $GENERIC_OPENAI_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$GENERIC_OPENAI_PROXY_DIR/node_modules" ]; then
    print_warning "Generic OpenAI Proxy 依赖未安装，正在安装..."
    (cd "$GENERIC_OPENAI_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Generic OpenAI Proxy 依赖安装失败"
      return 1
    fi
    print_status "Generic OpenAI Proxy 依赖安装完成"
  fi

  if is_port_in_use $GENERIC_PORT; then
    print_warning "Generic OpenAI Proxy 已在运行 (端口 $GENERIC_PORT)"
    return 0
  fi

  cd "$GENERIC_OPENAI_PROXY_DIR" || exit 1
  print_status "启动 Generic OpenAI Proxy..."
  nohup node proxy.js > "$LOG_DIR/generic-openai-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $GENERIC_PORT; then
    print_status "Generic OpenAI Proxy 启动成功 (PID: $pid, 端口: $GENERIC_PORT)"
    return 0
  else
    print_error "Generic OpenAI Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs generic"
    return 1
  fi
}

stop_opencode() { stop_service "OpenCode Proxy" $OPENCODE_PORT; }
stop_generic_openai() { stop_service "Generic OpenAI Proxy" $GENERIC_PORT; }

stop_dsh() { stop_service "DSH Proxy" $DSH_PORT; }
stop_manager() { stop_service "Manager Shell" $MANAGER_PORT; }

# 重启服务
restart_codex() { stop_codex; sleep 1; start_codex; }
restart_hermes() { stop_hermes; sleep 1; start_hermes; }
restart_cursor() { stop_cursor; sleep 1; start_cursor; }
restart_dsh() { stop_dsh; sleep 1; start_dsh; }
restart_claude() { stop_claude; sleep 1; start_claude; }
restart_opencode() { stop_opencode; sleep 1; start_opencode; }
restart_generic_openai() { stop_generic_openai; sleep 1; start_generic_openai; }
restart_manager() { stop_manager; sleep 1; start_manager; }

# 查看状态
# 服务名 → 端口（N-4 同源：与 SERVICES / svc_title 一一对应；新增服务须补分支）
svc_port() {
  case "$1" in
    codex)            echo $CODEx_PORT ;;
    hermes)           echo $HERMES_PORT ;;
    cursor)           echo $CURSOR_PORT ;;
    dsh)              echo $DSH_PORT ;;
    claude)           echo $CLAUDE_PORT ;;
    opencode)         echo $OPENCODE_PORT ;;
    generic)          echo $GENERIC_PORT ;;
    manager)          echo $MANAGER_PORT ;;
    unified-ingress)  echo $UNIFIED_PORT ;;
    *)                return 1 ;;
  esac
}

# 查看状态（N-4：改为遍历 SERVICES，根除此前手写 9 块硬编码的状态清单漂移）
show_status() {
  echo "=========================================="
  echo "  Multi-Proxy Manager 状态"
  echo "=========================================="
  echo ""

  local s port pid down=0
  for s in $SERVICES; do
    port=$(svc_port "$s") || { print_error "未配置端口映射: $s"; down=$((down + 1)); continue; }
    if is_port_in_use "$port"; then
      pid=$(pid_on_port "$port")
      echo -e "${GREEN}✓ $(svc_title "$s")${NC} - 运行中 (PID: $pid, 端口: $port)"
      if [ "$s" = "manager" ]; then
        echo -e "  访问地址: ${YELLOW}http://localhost:$port${NC}"
      fi
    else
      echo -e "${RED}✗ $(svc_title "$s")${NC} - 未运行"
      down=$((down + 1))
    fi
  done

  echo ""
  echo "=========================================="
  # 返回值 = 未运行的服务数。
  # 为什么必须给：`manage.sh status` 以前无论挂几个都返回 0，于是
  # `manage.sh status && deploy` 这种写法永远放行——「全部未运行」被读成「一切正常」。
  # 这是本仓反复清剿的那一类缺陷：查失败 ≠ 没发现问题。
  return "$down"
}

# 服务名 → 展示名（show_logs 标题用；与 SERVICES 一一对应，新增服务须补分支）
svc_title() {
  case "$1" in
    codex)            echo "Codex Proxy" ;;
    hermes)           echo "Hermes Proxy" ;;
    cursor)           echo "Cursor Proxy" ;;
    dsh)              echo "DSH Proxy" ;;
    claude)           echo "Claude Proxy" ;;
    opencode)         echo "OpenCode Proxy" ;;
    generic)          echo "Generic OpenAI Proxy" ;;
    manager)          echo "Manager Shell" ;;
    unified-ingress)  echo "Unified Ingress" ;;
    *)                echo "$1" ;;
  esac
}

# 服务名 → 日志文件（N-4 同源：与 SERVICES / svc_title 一一对应；
# 新增服务须在此补分支，否则 svc_logfile 返回非零，由 guards 拦截）
svc_logfile() {
  case "$1" in
    codex)            echo "$LOG_DIR/codex-proxy.log" ;;
    hermes)           echo "$LOG_DIR/hermes-proxy.log" ;;
    cursor)           echo "$LOG_DIR/cursor-proxy.log" ;;
    dsh)              echo "$LOG_DIR/dsh-proxy.log" ;;
    claude)           echo "$LOG_DIR/claude-proxy.log" ;;
    opencode)         echo "$LOG_DIR/opencode-proxy.log" ;;
    generic)          echo "$LOG_DIR/generic-openai-proxy.log" ;;
    manager)          echo "$LOG_DIR/manager.log" ;;
    unified-ingress)  echo "$LOG_DIR/unified-ingress.log" ;;
    *)                return 1 ;;
  esac
}

# 查看日志（N-4：logs all 改为遍历 SERVICES，根除此前手写 8 项聚合漏掉 dsh 的漂移）
show_logs() {
  local service=$1

  case $service in
    codex|hermes|cursor|dsh|claude|opencode|generic|manager|unified-ingress)
      local lf
      lf=$(svc_logfile "$service") || { print_error "未配置日志映射: $service"; return 1; }
      echo "=== $(svc_title "$service") 日志 ==="
      tail -50 "$lf" 2>/dev/null || echo "日志文件不存在"
      ;;
    all)
      local s lf
      for s in $SERVICES; do
        lf=$(svc_logfile "$s") || { print_error "未配置日志映射: $s"; continue; }
        echo "=== $(svc_title "$s") 日志 ==="
        tail -20 "$lf" 2>/dev/null || echo "日志文件不存在"
        echo ""
      done
      ;;
    *)
      # A-5（2026-10-25）：原先没有默认分支，打错代理名会静默通过（rc=0、零输出），
      # 而对应的 bats 断言是恒真的 `[ ${#output} -ge 0 ]`，于是这个缺陷一直被绿灯盖住。
      print_error "未知服务名: $service"
      print_info "用法: $0 logs <codex|hermes|cursor|dsh|claude|opencode|generic|manager|unified-ingress|all>"
      return 1
      ;;
  esac
}

# 单服务路由（带目标参数）：$2 ∈ {codex,hermes,cursor,manager,all}，缺省 all。
# 镜像已有日志路由风格（logs 读 $2）。裸 start/stop/restart（无 $2）= all，行为不变。

# 🔴 N-4（2026-10-25）：start / stop / restart / bootout 的「全量」清单单一真源。
# 旧实现 start all 与 stop all 各自硬编码 8 个调用，unified-ingress 只在 stop 一侧
# （bootout 路径）被覆盖，start 一侧漏掉 ⇒ 停/起不对称。现四个动词统一遍历本列表，
# 新增/调整服务只改这一行即可，从结构上杜绝不对称。
SERVICES="codex hermes cursor dsh claude opencode generic manager unified-ingress"

# 2026-11-08：不再 `|| true` 一律吞掉失败。这些 start_* 会因为「没装 / 依赖装不上 /
# 端口被别的东西占着起不来」返回 1，旧写法让「一个都没起来」也返回 0，于是
# install.sh --start 照样打出「所有服务已启动」——而屏幕上刚滚过的全是「未安装」。
# 现在按真实结果计数并返回非 0，调用方才有依据说人话。
start_all() {
  local s failed=0 total=0
  for s in $SERVICES; do
    total=$((total + 1))
    start_$s || failed=$((failed + 1))
  done
  if [ "$failed" -gt 0 ]; then
    print_warning "$failed/$total 个服务未能启动（未安装或启动失败，逐条见上）"
    return 1
  fi
  return 0
}

stop_all() {
  local s failed=0 total=0
  for s in $SERVICES; do
    total=$((total + 1))
    stop_$s || failed=$((failed + 1))
  done
  # 与 start_all 同一口径：一个都没停掉也返回 0 的话，调用方会印「全部已停止」，
  # 而屏幕上刚滚过的全是「仍被占用 / 停止失败」。9 个服务里最后一个成功、
  # 前 8 个失败，旧写法照样 exit 0。
  if [ "$failed" -gt 0 ]; then
    print_warning "$failed/$total 个服务未能停止（逐条见上）"
    return 1
  fi
  return 0
}

restart_all() {
  local s failed=0 total=0
  for s in $SERVICES; do
    total=$((total + 1))
    restart_$s || failed=$((failed + 1))
  done
  if [ "$failed" -gt 0 ]; then
    print_warning "$failed/$total 个服务未能重启（未安装或重启失败，逐条见上）"
    return 1
  fi
  return 0
}

bootout_all() {
  local s
  for s in $SERVICES; do
    bootout_$s || true
  done
}

run_target() {
  local verb=$1       # start | stop | restart | bootout
  local target=${2:-all}
  case "$target" in
    codex)
      case $verb in
        start) start_codex ;;
        stop) stop_codex ;;
        restart) restart_codex ;;
        bootout) bootout_codex ;;
       esac ;;
    hermes)
      case $verb in
        start) start_hermes ;;
        stop) stop_hermes ;;
        restart) restart_hermes ;;
        bootout) bootout_hermes ;;
       esac ;;
    cursor)
      case $verb in
        start) start_cursor ;;
        stop) stop_cursor ;;
        restart) restart_cursor ;;
        bootout) bootout_cursor ;;
       esac ;;
    dsh)
      case $verb in
        start) start_dsh ;;
        stop) stop_dsh ;;
        restart) restart_dsh ;;
        bootout) bootout_dsh ;;
       esac ;;
    claude)
      case $verb in
        start) start_claude ;;
        stop) stop_claude ;;
        restart) restart_claude ;;
        bootout) bootout_claude ;;
       esac ;;
    opencode)
      case $verb in
        start) start_opencode ;;
        stop) stop_opencode ;;
        restart) restart_opencode ;;
        bootout) bootout_opencode ;;
       esac ;;
    generic)
      case $verb in
        start) start_generic_openai ;;
        stop) stop_generic_openai ;;
        restart) restart_generic_openai ;;
        bootout) bootout_generic_openai ;;
       esac ;;
    manager)
      case $verb in
        start) start_manager ;;
        stop) stop_manager ;;
        restart) restart_manager ;;
        bootout) bootout_manager ;;
       esac ;;
    unified-ingress)
      case $verb in
        start) start_unified_ingress ;;
        stop) stop_unified_ingress ;;
        restart) restart_unified_ingress ;;
        bootout) bootout_unified_ingress ;;
       esac ;;
    all|"")
      # 🔴 N-4：四个动词统一遍历单一真源 SERVICES（见 run_target 上方定义），
      # 从结构上保证 start/stop/restart/bootout 覆盖的服务集合完全一致。
      case $verb in
        start)   start_all ;;
        stop)    stop_all ;;
        restart) restart_all ;;
        bootout) bootout_all ;;
       esac ;;
    *)
      print_error "未知目标: $target"
      echo "用法: $0 {start|stop|restart|bootout} [codex|claude|hermes|cursor|dsh|opencode|generic|manager|unified-ingress|all]"
      return 1 ;;
  esac
}

# 主函数
# Source 保护：被 source（测试/调用 helper）时 BASH_SOURCE[0]≠$0，函数已定义完，直接返回、不跑 main；
# 直接执行（./manage.sh / bash manage.sh）时 BASH_SOURCE 缺失回退 $0，照旧跑 case。
# 这样 bats 等可 source 本脚本调用 is_port_in_use / show_* 等，而 main 只在直接执行时运行。
if [ "${BASH_SOURCE[0]:-$0}" != "$0" ]; then
  return 0 2>/dev/null || exit 0
fi
case "${1:-status}" in
  start)
    print_status "启动服务${2:+ ($2)}..."
    # set -e 下必须用 `|| _rc=$?` 兜住：否则 start_all 返回 1 会当场退出，
    # 用户看不到下面那张状态表（而「谁起来了谁没起」正是他要的信息）。
    _rc=0
    run_target start "$2" || _rc=$?
    echo ""
    # 🔴 set -e 下这一行必须带 `|| true`：show_status 现在返回「未运行数」，
    #    直接调用会在服务没全起来时当场终止脚本，exit "$_rc" 根本执行不到。
    show_status || true
    exit "$_rc"
     ;;
  stop)
    print_status "停止服务${2:+ ($2)}..."
    # 同样兜住 rc：stop_all 返回「停不掉的个数」，不能被 show_status 的返回值盖掉。
    # stop 之后服务本来就该是停的，所以这里绝不能把 show_status 的结果当命令结果。
    _rc=0
    run_target stop "$2" || _rc=$?
    echo ""
    show_status || true
    exit "$_rc"
     ;;
  restart)
    print_status "重启服务${2:+ ($2)}..."
    _rc=0
    run_target restart "$2" || _rc=$?
    echo ""
    show_status || true
    exit "$_rc"
     ;;
  bootout)
    print_status "卸载 launchd 托管服务${2:+ ($2)}..."
    _rc=0
    run_target bootout "$2" || _rc=$?
    echo ""
    show_status || true
    exit "$_rc"
     ;;
  status)
    # 退出码 = 未运行的服务数。这样 `manage.sh status && ...` 才有意义；
    # 全部在跑时是 0，符合 shell 惯例（0 = 正常）。
    # set -e 下必须显式捕获：`show_status; exit $?` 的 exit 永远执行不到。
    _rc=0
    show_status || _rc=$?
    exit "$_rc"
    ;;
  logs)
    show_logs "${2:-all}"
    ;;
  codex)
    case "${2:-status}" in
      start) start_codex ;;
      stop) stop_codex ;;
      restart) restart_codex ;;
      bootout) bootout_codex ;;
      status)
        if is_port_in_use $CODEx_PORT; then
          echo -e "${GREEN}✓ Codex Proxy${NC} - 运行中"
        else
          echo -e "${RED}✗ Codex Proxy${NC} - 未运行"
        fi
        ;;
      logs) show_logs codex ;;
      *) print_error "未知命令: $2"; echo "用法: $0 codex [start|stop|restart|bootout|status|logs]" ;;
    esac
    ;;
  hermes)
    case "${2:-status}" in
      start) start_hermes ;;
      stop) stop_hermes ;;
      restart) restart_hermes ;;
      bootout) bootout_hermes ;;
      status)
        if is_port_in_use $HERMES_PORT; then
          echo -e "${GREEN}✓ Hermes Proxy${NC} - 运行中"
        else
          echo -e "${RED}✗ Hermes Proxy${NC} - 未运行"
        fi
        ;;
      logs) show_logs hermes ;;
      *) print_error "未知命令: $2"; echo "用法: $0 hermes [start|stop|restart|bootout|status|logs]" ;;
    esac
    ;;
    cursor)
      case "${2:-status}" in
        start) start_cursor ;;
        stop) stop_cursor ;;
        restart) restart_cursor ;;
        bootout) bootout_cursor ;;
        status)
          if is_port_in_use $CURSOR_PORT; then
            echo -e "${GREEN}✓ Cursor Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ Cursor Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs cursor ;;
        *) print_error "未知命令: $2"; echo "用法: $0 cursor [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
    dsh)
      case "${2:-status}" in
        start) start_dsh ;;
        stop) stop_dsh ;;
        restart) restart_dsh ;;
        bootout) bootout_dsh ;;
        status)
          if is_port_in_use $DSH_PORT; then
            echo -e "${GREEN}✓ DSH Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ DSH Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs dsh ;;
        *) print_error "未知命令: $2"; echo "用法: $0 dsh [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
    claude)
      case "${2:-status}" in
        start) start_claude ;;
        stop) stop_claude ;;
        restart) restart_claude ;;
        bootout) bootout_claude ;;
        status)
          if is_port_in_use $CLAUDE_PORT; then
            echo -e "${GREEN}✓ Claude Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ Claude Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs claude ;;
        *) print_error "未知命令: $2"; echo "用法: $0 claude [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
    opencode)
      case "${2:-status}" in
        start) start_opencode ;;
        stop) stop_opencode ;;
        restart) restart_opencode ;;
        bootout) bootout_opencode ;;
        status)
          if is_port_in_use $OPENCODE_PORT; then
            echo -e "${GREEN}✓ OpenCode Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ OpenCode Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs opencode ;;
        *) print_error "未知命令: $2"; echo "用法: $0 opencode [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
    generic)
      case "${2:-status}" in
        start) start_generic_openai ;;
        stop) stop_generic_openai ;;
        restart) restart_generic_openai ;;
        bootout) bootout_generic_openai ;;
        status)
          if is_port_in_use $GENERIC_PORT; then
            echo -e "${GREEN}✓ Generic OpenAI Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ Generic OpenAI Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs generic ;;
        *) print_error "未知命令: $2"; echo "用法: $0 generic [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
  manager)
    case "${2:-status}" in
      start) start_manager ;;
      stop) stop_manager ;;
      restart) restart_manager ;;
      bootout) bootout_manager ;;
      status)
        if is_port_in_use $MANAGER_PORT; then
          echo -e "${GREEN}✓ Manager Shell${NC} - 运行中"
        else
          echo -e "${RED}✗ Manager Shell${NC} - 未运行"
        fi
        ;;
        logs) show_logs manager ;;
        *) print_error "未知命令: $2"; echo "用法: $0 manager [start|stop|restart|bootout|status|logs]" ;;
    esac
     ;;
    unified-ingress)
      case "${2:-status}" in
        start) start_unified_ingress ;;
        stop) stop_unified_ingress ;;
        restart) restart_unified_ingress ;;
        bootout) bootout_unified_ingress ;;
        status)
          if is_port_in_use $UNIFIED_PORT; then
            echo -e "${GREEN}✓ Unified Ingress${NC} - 运行中"
          else
            echo -e "${RED}✗ Unified Ingress${NC} - 未运行"
          fi
          ;;
        logs) show_logs unified-ingress ;;
        *) print_error "未知命令: $2"; echo "用法: $0 unified-ingress [start|stop|restart|bootout|status|logs]" ;;
      esac
      ;;
  # 桌面壳：打开 Electron 壳（自包含：复用/启动后端 + 装载 UI + 开壳前占检测）
 gui)
    cd "$MANAGER_DIR" || exit 1
    if [ ! -d "node_modules/electron" ]; then
      print_warning "electron 未安装，正在安装（走 .npmrc mirror）..."
      npm install electron --save-dev --no-audit --no-fund 2>/dev/null
    fi
    print_status "启动桌面壳 Manager Desktop (端口 $MANAGER_PORT)..."
    # exec 替换：壳退出即脚本退出。后端由壳自管（见 main.js ensureBackend）。
    exec npx electron main.js
     ;;
  *)
    echo "Multi-Proxy Manager 管理脚本"
    echo ""
    echo "用法: $0 [command]"
    echo ""
    echo "命令:"
    echo "  start       启动所有服务"
    echo "  stop        停止所有服务"
    echo "  restart     重启所有服务"
    echo "  bootout     卸载 launchd 托管服务（bootout + 删 plist）"
    echo "  status      查看服务状态"
    echo "  logs [all|codex|hermes|cursor|manager]  查看日志"
    echo ""
    echo "单个服务管理:"
    echo "  $0 codex [start|stop|restart|bootout|status|logs]"
    echo "  $0 hermes [start|stop|restart|bootout|status|logs]"
    echo "  $0 cursor [start|stop|restart|bootout|status|logs]"
    echo "  $0 dsh [start|stop|restart|bootout|status|logs]"
    echo "  $0 claude [start|stop|restart|bootout|status|logs]"
    echo "  $0 opencode [start|stop|restart|bootout|status|logs]"
    echo "  $0 generic [start|stop|restart|bootout|status|logs]"
    echo "  $0 manager [start|stop|restart|bootout|status|logs]"
    echo "  $0 unified-ingress [start|stop|restart|bootout|status|logs]"
    exit 1
    ;;
esac
