#!/bin/bash
# Multi-Proxy Manager — 一键安装/卸载/重装/启停
# 用法:
#   ./install.sh              # 交互式安装
#   ./install.sh --all        # 静默安装全部
#   ./install.sh --uninstall  # 卸载全部
#   ./install.sh --reinstall  # 卸载后重装
#   ./install.sh --start      # 启动所有服务
#   ./install.sh --stop       # 停止所有服务
#   ./install.sh --status     # 查看状态
#   ./install.sh --autostart  # 启用开机自启
#   ./install.sh --autostop   # 禁用开机自启
#   ./install.sh --update     # 拉取上游新版 + 只增不覆盖地补齐依赖/重编译
#   ./install.sh --check-update # 只问有没有新版，不改任何东西
#
# 更新通道（2026-10-04）：版本源是仓库根 VERSION，上游版本源是 GitHub Releases。
# 检测离线/限流一律静默跳过，更新提示是增益，不掺错误刷屏。
# 关掉检测：MP_UPDATE_OFF=1 ./install.sh --check-update

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# macOS 自带 bash 3.2 的 echo/echo -e 有个坑：参数里紧挨着变量插值的字符是多字节
# （中文、全角括号）时，输出尾部会被吃掉（"检查上游版本...（当前 1.0.0）" 只打出
# "检查上游版本...（当前 "）。printf 不受影响，所以打印助手一律用 printf。
print_ok()    { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
print_err()   { printf "${RED}[✗]${NC} %s\n" "$1"; }
print_info()  { printf "${BLUE}[i]${NC} %s\n" "$1"; }
print_warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
print_step()  { printf "${CYAN}[→]${NC} %s\n" "$1"; }
print_bold()  { printf "${BOLD}%s${NC}\n" "$1"; }

# macOS 自带 bash 3.2 有个字符串展开的坑：一条双引号字符串里，如果变量插值
# 紧挨着多字节字符（中文、全角括号），展开出来的尾部会变成两个残字节
# （实测 "检查上游版本...（当前 1.0.0）" 只打出 "...（当前 "）。变量两边留空格、
# 或者变量在串尾就不触发，所以老写法能凑合，一加上「中文（变量）」就露馅。
# 凡是中文与变量紧挨着的消息，一律用 fmt 生成整串再打印：fmt 内部走 printf 的
# %s 占位，变量是独立参数，压根不在同一条字符串里展开。
fmt() { printf "$1" "${@:2}"; }

# 端口
CODEx_PORT=18790
HERMES_PORT=18793
CURSOR_PORT=18794
MANAGER_PORT=18792

# 服务名（用于 launchd）
LAUNCHD_NAME="com.multi-proxy-manager"

# ===================== OS 检测（跨平台支持，2026-10-13）=====================
# 返回: darwin | linux | windows | unknown
detect_os() {
  local u
  u="$(uname -s 2>/dev/null || echo unknown)"
  case "$u" in
    Darwin*)               echo "darwin" ;;
    Linux*)                echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*)  echo "windows" ;;
    *)                     echo "unknown" ;;
  esac
}
OS="$(detect_os)"

# ===================== Node 运行时检查（2026-10-14 增补）=====================
# manager / 各 proxy 均要求 Node.js >= 20（node:test runner 等语法）。
# 缺 node 或版本过低时给出可操作提示，避免后续 npm install 报难懂的错。
check_node_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    print_err "未找到 node。multi-proxy 需要 Node.js >= 20。"
    print_info "安装：macOS 'brew install node'；Linux/Windows 见 https://nodejs.org/"
    exit 1
  fi
  local raw major
  raw="$(node -v 2>/dev/null || echo v0.0.0)"
  major="${raw#v}"
  major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*)
      print_err "无法解析 Node 版本：$raw。请确认 'node -v' 输出正常后重试。"
      exit 1 ;;
  esac
  if [ "$major" -lt 20 ]; then
    print_err "Node 版本过低：$raw（multi-proxy 需要 >= 20）。请升级后重试。"
    exit 1
  fi
  print_ok "Node 运行时：$raw"
}
check_node_runtime

# LaunchAgents 目录：默认 $HOME/Library/LaunchAgents，允许测试注入临时目录（非全局 env 注入，仅脚本内 local 覆盖）
LAUNCHD_DIR="${LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"

# --uninstall --dry-run：只预览将卸载的 plist，不真删/不真 unload（测试与安全检查用）
LAUNCHD_DRY_RUN="${LAUNCHD_DRY_RUN:-}"

# 卸载孤儿 plist 白名单（R2 修复，2026-09-19）：
#   旧项目 codex-multi-model-proxy-deploy 遗留 per-agent plist（com.codex.* / com.xiaoxian.*），
#   当前 install.sh 只认 com.multi-proxy-manager，卸载时不清它们 → 历史残留自启旧代理。
#   修复：按 label 子串判定——含 "multi-proxy" 的属本项目家族，可安全清理；
#   "com.apple." 前缀绝不删（系统）；其余跨家族残留默认只检测报告，--purge 才真删。
#   注：cc-switch(com.cc-switch.*)、dsh 等第三方 label 不含 multi-proxy，天然不误伤。

# ===================== 工具函数 =====================

# lsof 可执行文件解析（ADR-0001 + 2026-10-13 跨平台修订）：
# launchd 启动的进程 PATH 可能不含 /usr/sbin，裸 lsof 会 ENOENT → 端口检测静默误判。
# macOS 优先绝对路径 /usr/sbin/lsof；Linux 回退 PATH 查找；都没有则回退 ss / /proc/net/tcp。
if [ -x /usr/sbin/lsof ]; then
  LSOF=/usr/sbin/lsof
elif command -v lsof >/dev/null 2>&1; then
  LSOF=lsof
else
  LSOF=""
fi

# 端口占用检测：优先 lsof（macOS / 多数 Linux），回退 ss，再回退 /proc/net/tcp（Linux 裸环境）
is_port_in_use() {
  local port=$1
  if [ -n "$LSOF" ]; then
    "$LSOF" -i :"$port" >/dev/null 2>&1 && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]${port}[[:space:]]" && return 0
  fi
  if [ -f /proc/net/tcp ] 2>/dev/null; then
    local hex
    hex="$(printf '%04X' "$port" 2>/dev/null)"
    [ -n "$hex" ] && grep -i -q ":$hex " /proc/net/tcp 2>/dev/null && return 0
  fi
  return 1
}

has_node() { command -v node &>/dev/null; }
has_python() { command -v python3 &>/dev/null; }

check_deps() {
  local missing=()
  has_node || missing+=("Node.js")
  has_python || missing+=("Python3")

  # Docker Compose 检查（Docker 模式需要）
  if [ -f "$ROOT_DIR/docker-compose.yml" ]; then
    if ! command -v docker >/dev/null 2>&1; then
      missing+=("Docker")
    elif ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
      missing+=("Docker Compose")
    fi
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    print_err "缺少依赖: ${missing[*]}"
    case "$OS" in
      darwin) print_info "请先安装: brew install node python" ;;
      linux)  print_info "请先安装: sudo apt install nodejs npm python3   # RHEL 系用 dnf/yum，Arch 用 pacman -S nodejs python" ;;
      *)      print_info "请先安装 Node.js 与 Python3" ;;
    esac
    if [ -f "$ROOT_DIR/docker-compose.yml" ]; then
      case "$OS" in
        darwin) print_info "Docker 模式需要 Docker + Docker Compose: brew install --cask docker" ;;
        linux)  print_info "Docker 模式需要 Docker + Docker Compose: 见 https://docs.docker.com/engine/install/" ;;
        *)      print_info "Docker 模式需要 Docker + Docker Compose" ;;
      esac
    fi
    return 1
  fi
  return 0
}

# ===================== 安装各组件 =====================

install_codex() {
  print_step "安装 Codex Proxy..."
  local dir="$ROOT_DIR/codex-proxy"

  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 检查 $dir/proxy.js + npm install + 创建 .env"
    return 0
  fi

  if [ ! -f "$dir/proxy.js" ]; then
    print_err "Codex Proxy 文件不存在: $dir/proxy.js"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Codex Proxy 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install --production)
      print_ok "Codex Proxy 依赖安装完成"
    fi
  fi

  if [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null || true
    print_info "已创建 .env 文件，请编辑 $dir/.env 配置 API Key"
  fi
}

install_hermes() {
  print_step "安装 Hermes Proxy..."
  local dir="$ROOT_DIR/hermes-proxy"

  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 检查 $dir/proxy.py + pip install (requirements.lock)"
    return 0
  fi

  # 整个目录都没有（精简克隆、只想要 codex 出口的人）就跳过，别让更新流程在这里崩掉；
  # 目录在但关键文件丢了那是真问题，照样报错返回 1。
  if [ ! -d "$dir" ]; then
    print_info "Hermes Proxy 未内置，跳过"
    return 0
  fi
  if [ ! -f "$dir/proxy.py" ]; then
    print_err "Hermes Proxy 文件不存在: $dir/proxy.py"
    return 1
  fi

  # 优先从 requirements.lock 装（钉死含传递依赖的完整闭包）；没有 lock 的旧克隆
  # 才退回 requirements.txt。直依赖只列 3 个，其余自由解析正是 LiteLLM 投毒事件
  # （2026-10-21）打进来的那个洞。
  local req="$dir/requirements.txt"
  [ -f "$dir/requirements.lock" ] && req="$dir/requirements.lock"
  if has_python && [ -f "$req" ]; then
    print_info "安装 Python 依赖（$(basename "$req")）..."
    pip3 install -r "$req" --quiet 2>&1
    print_ok "Hermes Proxy Python 依赖安装完成"
  fi
}

install_cursor() {
  print_step "安装 Cursor Multi-Model Proxy..."
  local dir="$ROOT_DIR/cursor-proxy"

  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 检查 $dir/src/index.ts + npm install + npm rebuild + npm run build"
    return 0
  fi

  if [ ! -f "$dir/src/index.ts" ]; then
    print_err "Cursor Proxy 文件不存在: $dir/src/index.ts"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Cursor Proxy 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install)
      print_ok "Cursor Proxy 依赖安装完成"
    fi

    # Rebuild native modules (better-sqlite3) for correct platform/arch
    print_info "重建原生模块以确保正确的平台和架构..."
    (cd "$dir" && npm rebuild better-sqlite3 2>&1)
    if [ $? -ne 0 ]; then
      print_warn "原生模块重建失败，尝试重新安装..."
      (cd "$dir" && rm -rf node_modules && npm install 2>&1)
      # Rebuild after full reinstall
      (cd "$dir" && npm rebuild better-sqlite3 2>&1)
      if [ $? -ne 0 ]; then
        print_err "Cursor Proxy 原生模块修复失败"
        print_warn "请检查: cd cursor-proxy && npm rebuild better-sqlite3"
        return 1
      fi
      print_ok "原生模块重新安装完成"
    else
      print_ok "原生模块重建完成"
    fi

    print_info "编译 TypeScript..."
    mkdir -p "$SCRIPT_DIR/logs"   # 更新路径不经过首次安装，logs/ 可能还不存在
    BUILD_LOG="$SCRIPT_DIR/logs/cursor-build.log"
    (cd "$dir" && npm run build > "$BUILD_LOG" 2>&1)
    BUILD_EXIT=$?
    if [ $BUILD_EXIT -ne 0 ]; then
      print_err "Cursor Proxy 编译失败，详情: $BUILD_LOG"
      print_warn "查看日志: cat $BUILD_LOG"
      return 1
    fi
    print_ok "Cursor Proxy 编译完成"
  fi

  if [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null || true
    print_info "已创建 .env 文件，请编辑 $dir/.env 配置 API Key"
  fi
}

install_manager() {
  print_step "安装 Multi-Proxy Manager..."
  local dir="$ROOT_DIR/multi-proxy-manager"

  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 检查 $dir/server.js + npm install + 创建 .env"
    return 0
  fi

  if [ ! -f "$dir/server.js" ]; then
    print_err "Multi-Proxy Manager 文件不存在: $dir/server.js"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Multi-Proxy Manager 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install)
      print_ok "Multi-Proxy Manager 依赖安装完成"
    fi
  fi

  if [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null || true
    print_info "已创建 Manager .env，请编辑 $dir/.env（可设 MANAGER_PASSWORD / MANAGER_AGENT_TOKEN）"
  fi
}

# ============================================
# 通用 Node 代理安装（claude / opencode / generic / dsh）
# ============================================
# 四者结构一致（proxy.js + package.json + package-lock.json），差异只在目录名。
# 装的方式一样，就没有理由写四份 —— 这个仓库已经为「5 份 proxy.js 各 1600 行、
# codex 与 opencode 去空白只差 36 行」付过代价（见 BACKLOG「收敛复制分叉」）。
# 缺的这四段正是 README 自承「install.sh 只有 4 个 install 函数，缺 claude/
# opencode/generic/dsh」的代码层缺口，也是 I 判据「陌生人装得上」的前置。
install_node_proxy() { # 目录名 显示名
  local dir="$ROOT_DIR/$1" name="$2"

  print_step "安装 $name..."
  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 检查 $dir/proxy.js + npm install + 按需创建 .env"
    return 0
  fi
  if [ ! -f "$dir/proxy.js" ]; then
    print_err "$name 文件不存在: $dir/proxy.js"
    return 1
  fi
  if ! has_node; then
    print_err "未找到 node，无法安装 $name"
    print_info "安装命令: brew install node"
    return 1
  fi

  # 就绪判据看 npm 收尾时写的锁标记，不看「node_modules 目录存在」：
  # 装到一半被打断时目录照样在，用目录判会永久跳过安装（quickstart 里踩过同一坑，
  # 形态是 128 个包缺 axios、无 .package-lock.json，用户只看到 Cannot find module）。
  if [ -f "$dir/node_modules/.package-lock.json" ]; then
    print_ok "$name 依赖已安装"
  else
    print_info "安装 Node.js 依赖..."
    if ! ( cd "$dir" && npm install --omit=dev --no-audit --no-fund ); then
      print_err "$name 依赖安装失败（可手动重试：cd \"$dir\" && npm install）"
      return 1
    fi
    print_ok "$name 依赖安装完成"
  fi

  # 有模板才建 .env；dsh-proxy 没有 .env.example，配置走 manager 的 providers.json。
  if [ ! -f "$dir/.env" ] && [ -f "$dir/.env.example" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null \
      && print_info "已创建 .env，请编辑 $dir/.env 填写 API Key（不用的留空即可）"
  fi
  return 0
}

install_claude()   { install_node_proxy claude-proxy         "Claude Proxy"; }
install_opencode() { install_node_proxy opencode-proxy       "OpenCode Proxy"; }
install_generic()  { install_node_proxy generic-openai-proxy "Generic OpenAI Proxy"; }
install_dsh()      { install_node_proxy dsh-proxy            "DSH Proxy"; }

# ===================== 数据安全网（A-1 · 2026-10-25） =====================
# 背景：--reinstall = --uninstall + 重装。旧实现里 uninstall_codex/cursor 直接
# `rm -f .env`，而 .env 是 0600、填了真实 API Key 的文件；重装只从 .env.example
# 重建 ⇒ 用户按文档做一次「重装」= 密钥全丢。且旧输出在 rm 之后才打印
# 「文件保留」，构成反向暗示（用户以为 key 还在）。
# 纪律：卸载路径上，用户数据一律**保留**；确需清理的先备份，备份失败就不删。

UNINSTALL_BACKUP_DIR=""

# 备份目录懒初始化：同一次卸载只建一个时间戳目录
backup_dir() {
  if [ -z "$UNINSTALL_BACKUP_DIR" ]; then
    UNINSTALL_BACKUP_DIR="$HOME/multi-proxy-uninstall-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$UNINSTALL_BACKUP_DIR" 2>/dev/null || true
  fi
  printf '%s' "$UNINSTALL_BACKUP_DIR"
}

# 保留 .env 不删（内含真实 API 密钥）。这是 A-1 的核心修复点。
preserve_env() {
  local dir="$1"
  local envf="$dir/.env"
  [ -f "$envf" ] || return 0
  print_ok "$(fmt "已保留 %s（含 API 密钥，未删除）" "$envf")"
}

# 删前先备份；备份失败则跳过删除（宁可留残留，不可丢数据）
safe_rm_rf() {
  local target="$1"
  local label="$2"
  [ -e "$target" ] || return 0
  local bdir name
  bdir="$(backup_dir)"
  name="$(printf '%s' "$target" | sed "s|^$HOME/||; s|/|_|g")"
  if cp -R "$target" "$bdir/$name" 2>/dev/null; then
    print_ok "$(fmt "已备份 %s → %s/%s" "$label" "$bdir" "$name")"
  else
    print_warn "$(fmt "备份 %s 失败，已跳过删除；请手动处理 %s" "$label" "$target")"
    return 0
  fi
  rm -rf "$target"
}

# ===================== 卸载 =====================

uninstall_codex() {
  print_step "卸载 Codex Proxy..."
  local dir="$ROOT_DIR/codex-proxy"
  preserve_env "$dir"
  print_info "$(fmt "Codex Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_hermes() {
  print_step "卸载 Hermes Proxy..."
  local dir="$ROOT_DIR/hermes-proxy"
  preserve_env "$dir"
  print_info "$(fmt "Hermes Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_cursor() {
  print_step "卸载 Cursor Proxy..."
  local dir="$ROOT_DIR/cursor-proxy"
  preserve_env "$dir"
  print_info "$(fmt "Cursor Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

# ---- A-2（2026-10-25）：补齐 4 个此前无卸载逻辑的代理 ----
# claude(18791) / opencode(18798) / generic(18799) / dsh(18797) 原来连卸载函数都没有，
# 卸载后这 4 个的 .env、node_modules、plist 全留、端口仍被占 ——「卸载不干净」的主因。

uninstall_claude() {
  print_step "卸载 Claude Proxy..."
  local dir="$ROOT_DIR/claude-proxy"
  preserve_env "$dir"
  print_info "$(fmt "Claude Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_opencode() {
  print_step "卸载 OpenCode Proxy..."
  local dir="$ROOT_DIR/opencode-proxy"
  preserve_env "$dir"
  print_info "$(fmt "OpenCode Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_generic() {
  print_step "卸载 Generic OpenAI Proxy..."
  local dir="$ROOT_DIR/generic-openai-proxy"
  preserve_env "$dir"
  print_info "$(fmt "Generic OpenAI Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_dsh() {
  print_step "卸载 DSH Proxy..."
  local dir="$ROOT_DIR/dsh-proxy"
  preserve_env "$dir"
  print_info "$(fmt "DSH Proxy 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

uninstall_manager() {
  print_step "卸载 Multi-Proxy Manager..."
  local dir="$ROOT_DIR/multi-proxy-manager"
  preserve_env "$dir"
  print_info "$(fmt "Multi-Proxy Manager 文件保留（如需完全删除请手动 rm -rf %s）" "$dir")"
}

# 提取 plist 的 Label：plutil 优先（对含特殊字符注释的 plist 最稳），python3 兜底，grep 终极兜底
plist_label() {
  local f="$1" l=""
  l="$(/usr/bin/plutil -extract Label raw "$f" 2>/dev/null)"
  [ -n "$l" ] && { printf '%s' "$l"; return 0; }
  l="$(/usr/bin/python3 - "$f" <<'PY' 2>/dev/null
import sys, plistlib
try:
    print(plistlib.load(open(sys.argv[1], 'rb')).get('Label', ''))
except Exception:
    pass
PY
)"
  [ -n "$l" ] && { printf '%s' "$l"; return 0; }
  grep -A1 '<key>Label</key>' "$f" 2>/dev/null | grep -o '<string>[^<]*</string>' | head -1 | sed 's/<string>//; s|</string>||'
}

# 判定 label 是否属本项目家族（可安全自动清理）：含 "multi-proxy" 且非 com.apple.*
label_is_orphan() {
  local label="$1"
  case "$label" in
    com.apple.*) return 1 ;;            # 系统 launchd，绝不删
    *multi-proxy*) return 0 ;;          # 本项目家族（含历史 per-agent 残留）
    *) return 1 ;;                      # 跨家族：默认不自动删（需 --purge）
  esac
}

# 判定 label 是否疑似相关残留（跨家族但含代理关键词，需人工 --purge）：检测但不自动删
label_is_suspect() {
  local label="$1"
  case "$label" in
    com.apple.*) return 1 ;;
    *multi-proxy*) return 1 ;;          # 家族内已在 orphan 处理，不算 suspect
    *codex*|*hermes*|*cursor*|*xiaoxian*) return 0 ;;
    *) return 1 ;;
  esac
}

uninstall_launchd() {
  # 默认只清家族内 multi-proxy 残留 + 检测跨家族；不自动删跨家族（需人工确认）
  print_step "卸载 launchd 开机自启..."
  local dir="$LAUNCHD_DIR"
  [ -d "$dir" ] || { print_info "LaunchAgents 目录不存在，跳过"; return 0; }

  local cleared=0 detected=0 skipped=0
  local label plist
  for plist in "$dir"/*.plist; do
     [ -f "$plist" ] || continue
     # || label=""：set -e 下 plist_label 遇坏 plist 返回非零，必须兜底为空（跳过），否则中断整个卸载
    label="$(plist_label "$plist")" || label=""
    if [ -z "$label" ]; then print_warn "无法解析 $plist 的 Label，跳过"; skipped=$((skipped+1)); continue; fi

    if label_is_orphan "$label"; then
      if [ -n "$LAUNCHD_DRY_RUN" ]; then
        echo "   [dry-run] 将卸载: $label"
      else
        launchctl unload "$plist" 2>/dev/null || true
        rm -f "$plist"
      fi
      print_ok "$(fmt "已清理 %s（或 dry-run 预览）" "$label")"
      cleared=$((cleared+1))
    elif label_is_suspect "$label"; then
      print_warn "$(fmt "检测到疑似相关残留 plist: %s（跨家族，未自动删除；请人工确认后处理）" "$label")"
      detected=$((detected+1))
    fi
  done

  if [ "$cleared" -eq 0 ] && [ "$detected" -eq 0 ]; then
    print_info "未发现本机 launchd 开机自启 plist"
  fi
  print_info "清理 $cleared 个 / 检测 $detected 个疑似 / 跳过 $skipped 个"
}

# 只读残留检查清单（2026-10-27）：卸载前一次性打印「逐项打勾」视图。
# 不停止服务、不 unload、不删除任何东西——FORWARD_CHECK 时仅打印后退出；
# 常态卸载也先打印一遍，让用户动手前看清将触碰的对象。
uninstall_checklist() {
  print_step "卸载残留检查清单（只读预览）"
  local dir="${LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
  local n_present=0 n_absent=0 mark
  # --- A. launchd plist（家族内 multi-proxy*）---
  echo "  [launchd plist]"
  local labels=(
    "com.multi-proxy-manager"
    "com.multi-proxy.codex"
    "com.multi-proxy.claude"
    "com.multi-proxy.opencode"
    "com.multi-proxy.generic"
    "com.multi-proxy.hermes"
    "com.multi-proxy.cursor"
    "com.multi-proxy.dsh"
    "com.multi-proxy.unified-ingress"
  )
  for lb in "${labels[@]}"; do
    if [ -f "$dir/$lb.plist" ]; then mark="[x]"; n_present=$((n_present+1)); else mark="[ ]"; n_absent=$((n_absent+1)); fi
    printf "    %s %s.plist\n" "$mark" "$lb"
  done
  # --- B. 孤儿（家族内）/ 可疑（跨家族）plist ---
  echo "  [孤儿/可疑 plist]"
  local found_orphan=0
  if ls "$dir"/*.plist >/dev/null 2>&1; then
    local p base
    for p in "$dir"/*.plist; do
      base=$(basename "$p" .plist)
      if label_is_orphan "$base"; then
        printf "    [x] 家族内孤儿: %s\n" "$base"; found_orphan=$((found_orphan+1))
      elif label_is_suspect "$base"; then
        printf "    [!] 疑似相关(跨家族,需人工 --purge): %s\n" "$base"
      fi
    done
  fi
  [ "$found_orphan" -eq 0 ] && echo "    [ ] 无家族内孤儿"
  # --- C. 残留目录/文件 ---
  echo "  [残留目录/文件]"
  local residues=(
    "$ROOT_DIR/codex-proxy/logs"
    "$ROOT_DIR/codex-proxy/trace"
    "$HOME/.local/bin/dsh-curator"
    "$HOME/.multi-proxy-manager"
  )
  for r in "${residues[@]}"; do
    if [ -e "$r" ]; then mark="[x]"; n_present=$((n_present+1)); else mark="[ ]"; n_absent=$((n_absent+1)); fi
    printf "    %s %s\n" "$mark" "$r"
  done
  # --- D. 保留项（明确不删）---
  echo "  [保留·不删]"
  echo "    [?] 各模块 .env（含 API 密钥，永不删）"
  echo "    [?] 项目源码目录 $ROOT_DIR（需手动删除）"
  [ -e "$HOME/.dsh" ] && echo "    [!] ~/.dsh（第三方主目录，仅警告不删）"
  echo ""
  print_info "$(fmt "清单统计：当前存在 %d 项将被触碰 / %d 项不存在（仅预览，未做任何改动）" "$n_present" "$n_absent")"
}

# 清理跨目录/用户级残留（修复 §十六 #2 卸载不完整）
# 安全：不删第三方工具主目录 ~/.dsh（只删本项目建的 shim 并警告手动清）；所有删除走 --dry-run 预览
uninstall_residues() {
  print_step "清理残留文件..."
  # A-1：.env（真实密钥）不在此列 —— 一律保留，见 preserve_env。
  # A-1：~/.multi-proxy-manager 内含 cost-ledger.jsonl（计费账单，删了不可逆），
  #       改走 safe_rm_rf（先备份再删，备份失败则不删）。
  local residues=(
    "$ROOT_DIR/codex-proxy/logs"
    "$ROOT_DIR/codex-proxy/trace"
    "$HOME/.local/bin/dsh-curator"
  )
  local removed=0
  for r in "${residues[@]}"; do
    if [ -e "$r" ]; then
      if [ -n "$LAUNCHD_DRY_RUN" ]; then
        echo "   [dry-run] 将清理: $r"
      else
        safe_rm_rf "$r" "残留 $r"
      fi
      removed=$((removed+1))
    fi
  done

  # 用户数据：密钥保留、账单备份后清
  preserve_env "$ROOT_DIR/hermes-proxy"
  preserve_env "$ROOT_DIR/multi-proxy-manager"
  if [ -d "$HOME/.multi-proxy-manager" ]; then
    if [ -n "$LAUNCHD_DRY_RUN" ]; then
      echo "   [dry-run] 将清理: $HOME/.multi-proxy-manager（含计费账单，删前会先备份）"
    else
      safe_rm_rf "$HOME/.multi-proxy-manager" "Manager 数据目录（含 cost-ledger.jsonl 计费账单）"
    fi
  fi
  [ -n "$UNINSTALL_BACKUP_DIR" ] && print_info "$(fmt "本次卸载的用户数据备份在 %s" "$UNINSTALL_BACKUP_DIR")"
  # 第三方工具主目录：只警告，不自动删（避免误伤 dsh 自身数据）
  if [ -e "$HOME/.dsh" ]; then
    print_warn "检测到 ~/.dsh（dsh 为第三方工具主目录，未自动删除；如需清理其中的 multi-proxy 集成，请手动处理）"
  fi
  [ "$removed" -eq 0 ] && print_info "未发现额外残留"
}

# ===================== 启动/停止 =====================

# N-5（2026-10-25）：本地重复的 start_codex/hermes/cursor/manager + pid_on_port 已删除，
# 启动逻辑统一收敛到 manage.sh start all（单一真源，9 服务含 unified-ingress，与 stop 共用
# 同一份 SERVICES 清单）。避免「install.sh 只跑 4/8 且 nohup 裸跑」与 manage.sh 语义漂移。

# A-2/A-3（2026-10-25）：install.sh 原来自带 4 个 `kill -9 ...; true` 的 stop_*，
# ① 只覆盖 4/8 个代理；② `; true` 让返回码恒为 0 —— 端口还占着也报「已停止」，
#    与 manage.sh 的 A-3 同源。现收敛到单一真源：manage.sh stop all
#    （8 个全覆盖 + launchd bootout + 真返回码）。
# 🔴 只保留这一个入口：4 个 stop_* 包装若都指向它，`$0 --stop` 会把
#    manage.sh stop all 重复执行 4 遍（2026-10-25 实测踩到）。
stop_all_services() {
  bash "$SCRIPT_DIR/manage.sh" stop all
}

show_status() {
  print_bold "=== Multi-Proxy Manager 状态 ==="
  echo ""

  if is_port_in_use $CODEx_PORT; then
    print_ok "Codex Proxy    - 运行中 (端口 $CODEx_PORT)"
  else
    print_err "Codex Proxy    - 未运行"
  fi

  if is_port_in_use $HERMES_PORT; then
    print_ok "Hermes Proxy   - 运行中 (端口 $HERMES_PORT)"
  else
    print_err "Hermes Proxy   - 未运行"
  fi

  if is_port_in_use $CURSOR_PORT; then
    print_ok "Cursor Proxy   - 运行中 (端口 $CURSOR_PORT)"
  else
    print_err "Cursor Proxy   - 未运行"
  fi

  if is_port_in_use $MANAGER_PORT; then
    print_ok "Manager Shell  - 运行中 (端口 $MANAGER_PORT)"
    print_info "  访问: ${CYAN}http://localhost:$MANAGER_PORT${NC}"
  else
    print_err "Manager Shell  - 未运行"
  fi

  # 检查开机自启（按系统判定）
  case "$OS" in
    darwin)
      if [ -f "$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist" ]; then
        print_ok "开机自启 - 已启用 (launchd)"
      else
        print_info "开机自启 - 未启用 (运行 ./install.sh --autostart 启用)"
      fi ;;
    linux)
      if systemctl --user is-enabled multi-proxy-manager.service >/dev/null 2>&1; then
        print_ok "开机自启 - 已启用 (systemd)"
      else
        print_info "开机自启 - 未启用 (运行 ./install.sh --autostart 启用)"
      fi ;;
    *)
      print_info "开机自启 - 当前系统不支持" ;;
  esac
  echo ""
}

# ===================== 开机自启 =====================

setup_autostart() {
  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_info "[dry-run] 将: 注册 $PLATFORM 自启 (launchd/systemd)"
    return 0
  fi
  case "$OS" in
    darwin)  setup_autostart_launchd ;;
    linux)   setup_autostart_systemd ;;
    windows) print_warn "Windows 请运行 install.ps1 配置开机自启（见仓库 README 的 Windows 段落）"; return 0 ;;
    *)       print_warn "未知系统，跳过开机自启配置"; return 0 ;;
  esac
}

setup_autostart_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"

  print_step "配置开机自启 (launchd)..."

  mkdir -p "$HOME/Library/LaunchAgents"

  # Detect nvm and pyenv for PATH expansion
  local nvm_path=""
  local pyenv_path=""
  if [ -d "$HOME/.nvm" ]; then
    nvm_bin=$(ls -d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -1)
    if [ -n "$nvm_bin" ]; then
      nvm_path="$nvm_bin"
    fi
  fi
  if [ -d "$HOME/.pyenv" ]; then
    pyenv_shims=$(ls -d "$HOME/.pyenv/shims" 2>/dev/null | head -1)
    pyenv_bins=$(ls -d "$HOME/.pyenv/bin" 2>/dev/null | head -1)
    pyenv_path=""
    [ -n "$pyenv_shims" ] && pyenv_path="$pyenv_shims"
    [ -n "$pyenv_bins" ] && pyenv_path="${pyenv_path:+$pyenv_path:}$pyenv_bins"
  fi

  # Build PATH with detected toolchains
  local base_path="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
  local full_path="$base_path"
  [ -n "$nvm_path" ] && full_path="$full_path:$nvm_path"
  [ -n "$pyenv_path" ] && full_path="$full_path:$pyenv_path"

  cat > "$plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCHD_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>bash</string>
        <string>$ROOT_DIR/manage.sh</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$HOME/.multi-proxy-manager/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.multi-proxy-manager/logs/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$full_path</string>
    </dict>
</dict>
</plist>
PLIST_EOF

  # P0-7: 日志轮转 —— 防止 launchd 的 stdout/stderr 日志无限增长
  rotate_launchd_log() {
    local f="$1"
    [ -f "$f" ] || return 0
    if [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt 10485760 ]; then
      mv "$f" "$f.old"
      print_info "已轮转 $f (>10MB)"
    fi
  }
  rotate_launchd_log "$HOME/.multi-proxy-manager/logs/stdout.log"
  rotate_launchd_log "$HOME/.multi-proxy-manager/logs/stderr.log"

  launchctl load "$plist" 2>/dev/null || true
  print_ok "开机自启已配置"
  print_info "登录时自动启动所有服务"
}

remove_autostart() {
  case "$OS" in
    darwin)  remove_autostart_launchd ;;
    linux)   remove_autostart_systemd ;;
    windows) print_warn "Windows 请运行 install.ps1 管理开机自启"; return 0 ;;
    *)       print_warn "未知系统，跳过"; return 0 ;;
  esac
}

remove_autostart_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    print_ok "开机自启已禁用"
  else
    print_info "开机自启未启用"
  fi
}

# ===================== Linux systemd 用户服务 =====================
setup_autostart_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/multi-proxy-manager.service"
  print_step "配置开机自启 (systemd --user)..."
  mkdir -p "$unit_dir"

  # 探测 nvm / pyenv 以补全 PATH
  local nvm_path="" pyenv_path=""
  [ -d "$HOME/.nvm" ] && nvm_path="$(ls -d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -1)"
  [ -d "$HOME/.pyenv" ] && pyenv_path="$HOME/.pyenv/shims:$HOME/.pyenv/bin"
  local base_path="/usr/local/bin:/usr/bin:/bin"
  local full_path="$base_path"
  [ -n "$nvm_path" ] && full_path="$full_path:$nvm_path"
  [ -n "$pyenv_path" ] && full_path="$full_path:$pyenv_path"

  cat > "$unit" << UNIT_EOF
[Unit]
Description=Multi-Proxy Manager (user)
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT_DIR
ExecStart=$ROOT_DIR/manage.sh start
ExecStop=$ROOT_DIR/manage.sh stop
Environment=PATH=$full_path

[Install]
WantedBy=default.target
UNIT_EOF

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable multi-proxy-manager.service 2>/dev/null || true
  systemctl --user start multi-proxy-manager.service 2>/dev/null || true
  print_ok "systemd 用户服务已启用（登录时自启）"
  print_info "状态查看: systemctl --user status multi-proxy-manager"
  print_info "若希望无登录也常驻: loginctl enable-linger \"\$USER\""
}

remove_autostart_systemd() {
  local unit="$HOME/.config/systemd/user/multi-proxy-manager.service"
  if [ -f "$unit" ]; then
    systemctl --user stop multi-proxy-manager.service 2>/dev/null || true
    systemctl --user disable multi-proxy-manager.service 2>/dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    print_ok "systemd 开机自启已禁用"
  else
    print_info "systemd 开机自启未启用"
  fi
}

# 卸载时清理 systemd（仅 Linux）
uninstall_systemd() {
  [ "$OS" = "linux" ] || return 0
  remove_autostart_systemd
}

# ===================== 交互安装 =====================

interactive_install() {
  echo ""
  print_bold "============================================"
  print_bold "  Multi-Proxy Manager — 一键安装"
  print_bold "============================================"
  echo ""

  # 检测环境
  if ! check_deps; then
    print_err "请安装 Node.js 和 Python3 后重试"
    print_info "安装命令: brew install node python"
    exit 1
  fi

  # 选择安装组件
  print_info "请选择要安装的组件（想用哪个装哪个，互不依赖）："
  echo ""
  echo "  ${CYAN}[1]${NC} Codex Proxy"
  echo "  ${CYAN}[2]${NC} Claude Proxy"
  echo "  ${CYAN}[3]${NC} OpenCode Proxy"
  echo "  ${CYAN}[4]${NC} Generic OpenAI Proxy"
  echo "  ${CYAN}[5]${NC} DSH Proxy"
  echo "  ${CYAN}[6]${NC} Hermes Proxy"
  echo "  ${CYAN}[7]${NC} Cursor Multi-Model Proxy"
  echo "  ${CYAN}[8]${NC} Multi-Proxy Manager（共享管理后台，强制）"
  echo ""
  read -p "请输入选项 (空格分隔, 默认全部 1-8): " choice

  choice="${choice:-1 2 3 4 5 6 7 8}"

  # 强制安装管理后台。按词匹配，不用 grep -q "8"：子串匹配在选项变多后会误判
  # （选 18 会被 8 命中），这类 bug 只在选项多起来之后才暴露。
  case " $choice " in
    *" 8 "*) ;;
    *) choice="$choice 8" ;;
  esac

  echo ""
  print_step "开始安装..."
  echo ""

  for n in $choice; do
    case "$n" in
      1) install_codex ;;
      2) install_claude ;;
      3) install_opencode ;;
      4) install_generic ;;
      5) install_dsh ;;
      6) install_hermes ;;
      7) install_cursor ;;
      8) install_manager ;;
    esac
  done

  echo ""
  print_bold "============================================"
  print_ok "  安装完成！"
  print_bold "============================================"
  echo ""
  print_info "接下来："
  echo ""
  echo "  1. 编辑各代理的 .env 文件配置 API Key"
  echo "     例如: nano codex-proxy/.env"
  echo ""
  echo "  2. 启动服务（三种方式任选其一）："
  echo "     方式 A: 运行 ./install.sh --start"
  echo "     方式 B: 运行 ./manage.sh start"
  echo "     方式 C: 启用开机自启: ./install.sh --autostart"
  echo ""
  echo "  3. 打开管理后台："
  echo "     ${CYAN}http://localhost:$MANAGER_PORT${NC}"
  echo ""
  echo "  4. 如果需要卸载："
  echo "     ./install.sh --uninstall"
  echo ""
  print_update_hint
}

# ===================== 更新通道 =====================

# 装完顺带报一句版本 + 有没有新版。离线/限流一律静默，别把增益变成噪音。
print_update_hint() {
  local v; v=$(read_version)
  [ -n "$v" ] || return 0
  print_info "$(fmt "当前版本 %s（检查更新: ./install.sh --check-update）" "$v")"
  local rc=0
  check_update_silent || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "${uc_latest:-}" ]; then
    print_info "$(fmt "上游有新版 %s，更新: ./install.sh --update" "${uc_latest:-}")"
  fi
}

#
# 「只增不覆盖用户数据」不是一句口号，落在这三条硬约束上：
#   1. 动手 pull 之前先把本地改动打成 patch 存进 ~/.multi-proxy-manager/backup/，
#      就算 pull 把文件盖了，字节也还在。
#   2. pull 只用 --ff-only：绝不 rebase、绝不 merge，本地自己攒的 commit 不会被改写。
#   3. 下游只跑「缺什么装什么」的增量动作（依赖缺失才装、.env 只在不存在时创建），
#      从头到尾没有一处 cp -f / 覆盖写用户已经改过的文件。
# 用户数据住在两个地方：仓库里的 .env（gitignore 掉，pull 碰不到）与
# ~/.multi-proxy-manager/（全在仓库外）。真正会被 pull 盖到的是「改过的 tracked 源文件」，
# 那正是第 1、2 条要兜住的东西。

read_version() {
  [ -f "$ROOT_DIR/VERSION" ] || { echo ""; return 0; }
  head -1 "$ROOT_DIR/VERSION" | tr -d ' \t\r\n'
}

# 把 update-check.js --json 的结果摊成 shell 变量：uc_checked / uc_current /
# uc_latest / uc_up_to_date / uc_published_at / uc_reason
update_json_vars() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const line = s.split("\n").filter(Boolean).pop() || "";
      let o = {};
      try { o = JSON.parse(line); } catch (e) { o = {}; }
      const kv = {
        uc_checked: o.checked ? "1" : "0",
        uc_reason: o.reason || "",
        uc_current: o.current || "",
        uc_latest: o.latest || "",
        uc_up_to_date: o.upToDate ? "1" : "0",
        uc_published_at: o.publishedAt || "",
      };
      for (const k of Object.keys(kv)) {
        process.stdout.write(k + "=\"" + String(kv[k]).replace(/\\/g, "").replace(/"/g, "") + "\"\n");
      }
    });
  ' <<< "$1"
}

# 有新版就返回 0；离线/限流/没连上返回 2（调用方别当失败处理）；已是最新返回 1
check_update_silent() {
  local out
  out=$(node "$ROOT_DIR/tools/update-check.js" --json 2>/dev/null | tail -1)
  [ -n "$out" ] || return 2
  eval "$(update_json_vars "$out")"
  [ "${uc_checked:-0}" = "1" ] || return 2
  [ "${uc_up_to_date:-1}" = "1" ] && return 1
  return 0
}

# 本地未提交的改动：已跟踪的改动态（会被 pull 盖掉的那个）+ 未跟踪的新文件（pull 不碰）
local_changes_summary() {
  git -C "$ROOT_DIR" status --porcelain 2>/dev/null
}

backup_local_changes() {
  local backup_dir="$HOME/.multi-proxy-manager/backup"
  mkdir -p "$backup_dir" 2>/dev/null || return 0
  local stamp patch untracked
  stamp=$(date +%Y%m%d-%H%M%S)
  patch="$backup_dir/update-$stamp.patch"
  untracked="$backup_dir/update-$stamp.untracked.txt"

  git -C "$ROOT_DIR" diff > "$patch" 2>/dev/null
  if [ ! -s "$patch" ]; then rm -f "$patch"; patch=""; fi
  git -C "$ROOT_DIR" ls-files --others --exclude-standard > "$untracked" 2>/dev/null
  if [ ! -s "$untracked" ]; then rm -f "$untracked"; untracked=""; fi

  if [ -n "$patch" ] || [ -n "$untracked" ]; then
    print_warn "先备份本地改动（更新只增不覆盖）："
    [ -n "$patch" ] && echo "    $(basename "$patch")  (已跟踪文件的本地改动的 diff)"
    [ -n "$untracked" ] && echo "    $(basename "$untracked")  (本地新增但未入库的文件清单)"
    echo "    目录: $backup_dir"
  else
    rmdir "$backup_dir" 2>/dev/null || true
  fi
}

do_check_update() {
  print_step "检查上游版本..."
  local out latest cur
  out=$(node "$ROOT_DIR/tools/update-check.js" --json 2>/dev/null | tail -1)
  if [ -z "$out" ]; then
    print_info "更新检测未连通（离线或 GitHub 限流），按本地版本继续"
    return 0
  fi
  eval "$(update_json_vars "$out")"
  cur="${uc_current:-$(read_version)}"
  if [ "${uc_checked:-0}" != "1" ]; then
    # 别把所有没结果都叫「未连通」：没发过 release 和断网是两码事，
    # 一个等着用户去发版，一个等着用户挂代理。
    case "${uc_reason:-unreachable}" in
      no-release-yet) print_info "上游还没发过 release，按本地版本继续" ;;
      disabled)       print_info "更新检测已关闭（MP_UPDATE_OFF），按本地版本继续" ;;
      *)              print_info "$(fmt "更新检测没连上（%s），按本地版本继续" "${uc_reason:-unreachable}")" ;;
    esac
    return 0
  fi
  if [ "${uc_up_to_date:-1}" = "1" ]; then
    print_ok "$(fmt "已是最新（%s）" "$cur")"
    return 0
  fi
  print_info "$(fmt "上游有新版：%s%s  本地：%s" "${uc_latest}" "${uc_published_at:+（${uc_published_at:0:10}）}" "$cur")"
  print_info "更新：./install.sh --update"
  return 0
}

do_update() {
  echo ""
  print_bold "============================================"
  print_bold "  Multi-Proxy Manager — 更新"
  print_bold "============================================"
  echo ""

  local cur; cur=$(read_version)
  [ -n "$cur" ] || cur="未知"

  print_step "$(fmt "检查上游版本...（当前 %s）" "$cur")"
  local rc=0
  check_update_silent || rc=$?
  case $rc in
    0) print_ok "$(fmt "上游有新版：%s%s，开始更新" "${uc_latest}" "${uc_published_at:+（${uc_published_at:0:10}）}")" ;;
    1) print_ok "$(fmt "已是最新（%s）" "$cur")"
       print_info "想强制拉一次本地改动：git pull --ff-only && ./install.sh"
       return 0
       ;;
    *) print_info "更新检测未连通，按本地版本继续更新" ;;
  esac
  echo ""

  if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_err "$ROOT_DIR 不是 git 仓库，没法 pull。"
    print_info "手动拿新版：把项目目录替换成新版后重跑 ./install.sh"
    return 1
  fi

  # 摆在本地的未提交改动先报一遍，再备份，最后才 pull
  local dirty n
  dirty=$(local_changes_summary)
  n=$(printf '%s\n' "$dirty" | grep -c . || true)
  if [ -n "$dirty" ]; then
    print_warn "$(fmt "本地有未提交的改动（%s 项），更新只增不覆盖，pull 前会先备份：" "$n")"
    printf '%s\n' "$dirty" | head -20 | sed 's/^/    /'
    [ "$n" -gt 20 ] && echo "    ...（完整清单在备份目录里）"
    echo ""
  fi
  backup_local_changes
  echo ""

  if ! git -C "$ROOT_DIR" pull --ff-only; then
    print_err "git pull 没做成（本地改动与上游冲突，或本地有未推送的 commit）。"
    print_warn "什么都没被覆盖——本地改动在 ~/.multi-proxy-manager/backup/ 里。"
    print_info "处理方式：git diff 看一下备份的 patch，然后 git pull --rebase 或手动合并"
    return 1
  fi
  print_ok "代码已更新"

  # 版本同步 + 增量补齐（缺依赖才装、.env 只在不存在时建，不覆盖已有配置）
  print_step "同步版本号..."
  if [ -f "$ROOT_DIR/tools/sync-version.js" ]; then
    node "$ROOT_DIR/tools/sync-version.js" >/dev/null 2>&1 || print_warn "版本同步失败，可手动 node tools/sync-version.js"
  fi

  if ! check_deps; then
    print_err "依赖检查没过，代码已更新，请补齐依赖后重跑 ./install.sh"
    return 1
  fi

  echo ""
  install_codex
  install_hermes
  install_cursor
  install_manager
  echo ""

  if [ "$UPDATE_NO_RESTART" = "1" ]; then
    print_step "已跳过自动重启（--no-restart）"
  else
    print_step "重启服务..."
    bash "$0" --restart
  fi

  echo ""
  print_bold "============================================"
  print_ok "$(fmt "  更新完成（%s → %s）" "$cur" "$(read_version)")"
  print_bold "============================================"
  echo ""
  print_info "用户数据（.env / ~/.multi-proxy-manager/*）全程没动。"
  echo ""
}

# ===================== 主入口 =====================

usage() {
  print_bold "Multi-Proxy Manager — 一键管理工具"
  echo ""
  echo "用法: $0 [命令]"
  echo ""
  echo "命令:"
  echo "  (无参数)          交互式安装向导"
  echo "  --all             安装全部 8 个组件（codex/claude/opencode/generic/dsh/hermes/cursor/manager）"
  echo "  --claude|--opencode|--generic|--dsh|--cursor|--codex|--hermes|--manager"
  echo "                    只装其中一个组件（互不影响，可单独卸载）"
  echo "  --start           启动所有服务"
  echo "  --stop            停止所有服务"
  echo "  --restart         重启所有服务"
  echo "  --status          查看服务状态"
  echo "  --uninstall       卸载（移除依赖和编译产物）"
  echo "  --reinstall       卸载后重新安装"
  echo "  --autostart       启用开机自启"
  echo "  --autostop        禁用开机自启"
  echo "  --update          拉取上游新版并增量补齐（只增不覆盖用户数据）"
  echo "  --check-update    只问有没有新版，不改任何东西"
  echo "  --help            显示帮助"
  echo ""
  echo "示例:"
  echo "  $0                  # 交互式安装"
  echo "  $0 --all            # 静默安装全部"
  echo "  $0 --start          # 启动所有服务"
  echo "  $0 --autostart      # 开机自启"
  echo "  $0 --status         # 查看状态"
  echo "  $0 --update         # 更新到上游最新版（本地改动先备份）"
  echo "  $0 --check-update   # 只查有没有新版"
  echo "  $0 --all --dry-run  # 预览安装将做什么（不写入）"
  echo "  $0 --uninstall --dry-run  # 预览卸载将删什么（不删除）"
  echo "  $0 --uninstall --check   # 只读打印卸载残留清单（不停止/不删除）"
  echo ""
  print_info "注意: 安装后请先编辑各代理的 .env 文件配置 API Key"
  print_info "跨平台: macOS 用 launchd；Linux 用 systemd --user；Windows 请运行 install.ps1"
  print_info "更新只增不覆盖：pull 前先备份本地改动到 ~/.multi-proxy-manager/backup/"
  echo ""
}

main() {
  # 先摘掉不带值的开关（剩下的第一个才是命令）。
  # 注意别把 --dry-run 摘走：--uninstall 的第二参数判定要靠它。
  UPDATE_NO_RESTART=""
  FORWARD_DRY_RUN=""
  FORWARD_CHECK=""
  local args=() a
  for a in "$@"; do
    if [ "$a" = "--no-restart" ]; then UPDATE_NO_RESTART="1"
    elif [ "$a" = "--dry-run" ]; then FORWARD_DRY_RUN="1"
    elif [ "$a" = "--check" ]; then FORWARD_CHECK="1"
    else args+=("$a"); fi
  done
  set -- ${args[@]+"${args[@]}"}

  if [ -n "$FORWARD_DRY_RUN" ]; then
    print_warn "DRY-RUN 模式：仅预览将写入的文件，不真正安装/启动"
  fi

  case "${1:-}" in
    --all)
      # 静默安装全部组件
      echo ""
      print_bold "============================================"
      print_bold "  Multi-Proxy Manager — 一键安装全部"
      print_bold "============================================"
      echo ""

      if ! check_deps; then
        print_err "请安装 Node.js 和 Python3 后重试"
        print_info "安装命令: brew install node python"
        exit 1
      fi

      install_codex
      install_claude
      install_opencode
      install_generic
      install_dsh
      install_hermes
      install_cursor
      install_manager

      echo ""
      # ===== .env API Key 完整性检查 =====
      ENV_WARNING=0
      MISSING_KEYS=""

      for proxy_dir in codex-proxy hermes-proxy; do
        local env_file="$ROOT_DIR/$proxy_dir/.env"
        if [ -f "$env_file" ]; then
          for key in DEEPSEEK_API_KEY MOONSHOT_API_KEY AGNES_API_KEY; do
            local val
            val=$(grep "^${key}=" "$env_file" 2>/dev/null | cut -d'=' -f2-)
            if [ -z "$val" ]; then
              ENV_WARNING=1
              MISSING_KEYS="${MISSING_KEYS}    - $proxy_dir: $key\n"
            fi
          done
        fi
      done

      if [ $ENV_WARNING -eq 1 ]; then
        print_warn "API Key 未配置检查："
        printf '%b\n' " $MISSING_KEYS"
        print_info "请编辑各模块的 .env 文件配置必要的 API Key"
      fi

      echo ""
      print_bold "============================================"
      print_ok "  安装完成！"
      print_bold "============================================"
      echo ""
      print_info "接下来："
      echo ""
      echo "  1. 编辑各代理的 .env 文件配置 API Key"
      echo "     例如: nano codex-proxy/.env"
      echo ""
      echo "  2. 启动服务："
      echo "     bash manage.sh start"
      echo ""
      echo "  3. 打开管理面板："
      echo "     http://localhost:$MANAGER_PORT"
      echo ""
      print_update_hint
      ;;
    --start)
      # N-5（2026-10-25）：收敛到单一真源 manage.sh start all（9 服务全量，
      # 含 unified-ingress，与 stop 共用同一份 SERVICES 清单），不再用本地 4/8 nohup 裸跑。
      # 2026-11-08：按真实返回码说话。旧版无条件 print_ok「所有服务已启动」——
      # 而屏幕上可能刚滚过 9 行「未安装」，这句话是典型的假成功。
      if bash "$SCRIPT_DIR/manage.sh" start all; then
        print_ok "所有服务已启动"
      else
        print_warn "有服务没能启动——上面每条已说明原因（多半是还没装，不是坏了）"
        print_info "按需装：bash install.sh    看谁没起来：bash manage.sh status"
        exit 1
      fi
      ;;
    --stop)
      stop_all_services
      print_ok "所有服务已停止"
      ;;
    --restart)
      bash "$0" --stop
      sleep 1
      bash "$0" --start
      ;;
    --status)
      show_status
      ;;
    --claude|--opencode|--generic|--dsh|--cursor|--codex|--hermes|--manager)
      # 可拆卸：单独装一个代理，不碰其它组件（各代理独立装/卸是设计前提）。
      # 2026-11-08 补齐：此前只接了 4 个，codex / cursor / hermes / manager 只能
      # 靠 --all 或交互式向导装——而 README 与 verify-lanes 都在教人单装 cursor。
      case "${1#--}" in
        claude)   install_claude ;;
        opencode) install_opencode ;;
        generic)  install_generic ;;
        dsh)      install_dsh ;;
        cursor)   install_cursor ;;
        codex)    install_codex ;;
        hermes)   install_hermes ;;
        manager)  install_manager ;;
      esac
      ;;
    --uninstall)
      echo ""
      print_bold "============================================"
      print_bold "  卸载 Multi-Proxy Manager"
      print_bold "============================================"
      echo ""

      # 2026-10-27：卸载前先打印「逐项打勾」残留清单（只读）。
      # --check 模式：仅预览，不停止服务、不卸载、不删除任何东西（安全，可随时跑）。
      if [ -n "$FORWARD_CHECK" ]; then
        LAUNCHD_DRY_RUN=1
        uninstall_checklist
        echo ""
        print_info "仅预览模式（--check）：未停止任何服务，未删除任何文件。要真正卸载请去掉 --check。"
        exit 0
      fi
      uninstall_checklist

      # 第二参数 --dry-run：只预览将卸载的 plist，不真删（测试/安全检查）
      # 🔴 必须查 FORWARD_DRY_RUN 而非 $2：参数解析循环（约 1168 行）已把
      # `--dry-run` 从位置参数里摘走并转成 FORWARD_DRY_RUN，此处查 $2 永远为假
      # —— 旧实现的 dry-run 保护因此完全失效（2026-10-25 实测：预览卸载把在跑的
      # 服务全停了）。这是「变量被改写后旧判据静默失效」的典型。
      if [ -n "$FORWARD_DRY_RUN" ]; then
        LAUNCHD_DRY_RUN=1
        print_warn "DRY-RUN 模式：仅预览，不删除任何 plist"
      fi

      # 先停止服务。
      # 🔴 dry-run 必须真的不动作：旧实现在 dry-run 下也无条件 `$0 --stop`，
      # 「预览卸载」会把在跑的服务全停掉 —— dry-run 保护有洞。
      if [ -n "$LAUNCHD_DRY_RUN" ]; then
        print_info "[dry-run] 跳过停止服务（预览模式不触碰运行中的服务）"
      else
        print_step "停止所有服务..."
        $0 --stop 2>/dev/null || true
      fi

      # 卸载各组件（A-2：8 个代理全覆盖）
      uninstall_codex
      uninstall_hermes
      uninstall_cursor
      uninstall_claude
      uninstall_opencode
      uninstall_generic
      uninstall_dsh
      uninstall_manager
      uninstall_launchd
      uninstall_systemd
      uninstall_residues

      echo ""
      print_bold "============================================"
      # 预览模式不许印「完成」：实测 --uninstall --dry-run 的结尾是
      # 「✓ 卸载完成！」，而它一个文件都没删。预览报成功比不报更糟——
      # 用户会以为已经清理干净了（本仓对「假成功」零容忍，同 --start 那次）。
      if [ -n "$LAUNCHD_DRY_RUN" ] || [ -n "$FORWARD_DRY_RUN" ]; then
        print_warn "  以上是预览：什么都没有删除"
      else
        print_ok "  卸载完成！"
      fi
      print_bold "============================================"
      echo ""
      if [ -n "$LAUNCHD_DRY_RUN" ] || [ -n "$FORWARD_DRY_RUN" ]; then
        print_info "确认要真删就去掉 --dry-run 再跑一次。"
      else
        print_info "所有代理文件保留在目录中，如需完全删除请手动删除整个项目目录。"
      fi
      echo ""
       ;;
    --reinstall)
      # A-1：卸载不再删 .env（真实密钥保留），重装时 .env 已存在 ⇒ 不会被
      # .env.example 覆盖。这里把话说清楚，别让用户猜 key 还在不在。
      print_info "重装流程：先卸载（保留所有 .env 与 API 密钥）→ 再安装（不覆盖已有配置）"
      print_step "正在卸载..."
      $0 --uninstall
      echo ""
      print_step "正在重新安装..."
      echo ""
      interactive_install
      ;;
    --autostart)
      setup_autostart
      ;;
    --autostop)
      remove_autostart
      ;;
    --update|--upgrade)
      do_update
      ;;
    --check-update|--update-check)
      do_check_update
      ;;
    --help|-h|"")
      usage
      ;;
    *)
      print_err "未知命令: $1"
      echo ""
      usage
      exit 1
      ;;
  esac
}

# 执行守卫：仅在直接执行时跑 main；被测试 source 时只定义函数，不执行
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
