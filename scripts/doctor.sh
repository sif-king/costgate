#!/usr/bin/env bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.
#
# doctor.sh —— 环境诊断：你以为装好的东西，现在到底能不能用
#
# 与 verify.sh 的分工（不要合并，受众不同）：
#   verify.sh  = 这个项目现在工作得怎么样（面向交付四判据 II/III，只读出证据）
#   doctor.sh  = 我的环境为什么让它跑不起来（面向排障，回答「为什么」和「怎么修」）
#
# 为什么必须单独有它（2026-11-09，老板折腾一整天）：
#   `codex --version` 返回 137，零输出。quickstart 第 4 步照文档做完就是不工作，
#   而所有既有检查（verify.sh / config.toml 内容 / 端口探活）全绿。
#   根因：npm 装的 0.130.0 签名证书已被 Apple 吊销 → AMFI 直接 SIGKILL。
#   同一台机器上 app 内置的版本签名有效、跑得动。
#   ⇒ 「文件在 / 配置对 / 端口通」三件事全对，命令仍然是死的。
#     现有检查查的全是「声明」，没有一条查「事实」。
#
# 三条纪律：
#   ① 只读：不改任何文件、不启停任何服务、不发起会花钱的请求。
#   ② 每一条都给「为什么」和「怎么修」，只报 ✗ 不给修法的检查等于没做。
#   ③ 端口一律从 manage.sh 的 SERVICES 读，不写第二份清单。
#
# 用法：
#   bash scripts/doctor.sh
#   bash scripts/doctor.sh --quiet     # 只输出有问题的项（给 CI / 脚本用）
#
# 退出码：0 没有硬问题 / 1 有硬问题

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGE_SH="$ROOT/manage.sh"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { [ "$QUIET" = 1 ] || printf '\033[2m%s\033[0m\n' "$*"; }
ok()   { [ "$QUIET" = 1 ] || printf '  \033[32m✓\033[0m %s\n' "$*"; }
nota() { [ "$QUIET" = 1 ] || printf '  \033[2m-\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
fix()  { printf '      \033[2m修法：%s\033[0m\n' "$*"; }
sec()  { [ "$QUIET" = 1 ] || printf '\n\033[1m【%s】%s\033[0m\n' "$1" "$2"; }

HARD=0
hard() { HARD=$((HARD + 1)); bad "$*"; }

svc_port_of() {
  bash -c 'source "$1" >/dev/null 2>&1; set +e; svc_port "$2"' _ "$MANAGE_SH" "$1" 2>/dev/null
}

port_busy() {
  node -e '
    const net=require("net"), s=net.createConnection({host:"127.0.0.1",port:+process.argv[1]});
    s.setTimeout(400);
    s.on("connect",()=>{s.destroy();process.exit(0)});
    s.on("error",()=>process.exit(1));
    s.on("timeout",()=>{s.destroy();process.exit(1)});
  ' "$1" 2>/dev/null
}

[ "$QUIET" = 1 ] || { bold "multi-proxy 环境诊断"; dim "只读：不改文件、不启停服务、不发会花钱的请求。"; }

# ────────────────────── 1 会被杀掉的二进制 ──────────────────────
sec 1 "外部命令能跑吗 —— 「装了」和「能用」是两件事"

# 这是本脚本存在的唯一理由：有些二进制文件在、权限对、配置也对，
# 但执行时被内核 SIGKILL（rc=137），stdout/stderr 全空。
# 用户看到的是「打不开 / 闪退 / 弹窗」，拿不到任何线索。
probe_bin() {
  local name="$1" hint="$2"
  local path out err rc
  path="$(command -v "$name" 2>/dev/null)"
  if [ -z "$path" ]; then
    nota "$name 未安装 —— 需要时再装（$hint）"
    return 0
  fi
  # 解析软链到真实文件，报出来才能回答「我到底跑的是哪一份」
  local real
  real="$(node -e 'const fs=require("fs");try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch{process.stdout.write(process.argv[1])}' "$path" 2>/dev/null)"
  # stdout 与 stderr 分开收：有些工具 --version 正常但会往 stderr 扔无害告警，
  # 混在一起会让「可用（WARNING: ...）」这种输出读起来像故障。
  out="$("$name" --version 2>/dev/null)"; rc=$?
  err="$("$name" --version 2>&1 >/dev/null | head -2)"

  if [ "$rc" -eq 137 ]; then
    hard "$name 被执行即 SIGKILL（rc=137），零输出"
    printf '      路径：%s\n' "$real"
    printf '      这不是「没装好」，是被内核杀掉了。三种原因按顺序排查：\n'
    printf '        ① 二进制签名证书已被 Apple 吊销 —— 最常见的那个\n'
    printf '           核对：spctl -a -vvv "%s"  看到 CSSMERR_TP_CERT_REVOKED 就是它\n' "$real"
    printf '        ② 被系统 OOM 杀（内存不够）\n'
    printf '        ③ 沙箱 / 安全策略拒绝执行\n'
    fix "$hint"
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    hard "$name --version 退出码 $rc$(printf '%s' "$out" | head -2 | sed 's/^/：/')"
    printf '      路径：%s\n' "$real"
    fix "$hint"
    return 1
  fi
  ok "$name 可用（$(printf '%s' "$out" | head -1 | cut -c1-60)）"
  dim "    $real"
  return 0
}

probe_bin codex "重装成签名有效的版本，或让 codex 指向 /Applications/ChatGPT.app/Contents/Resources/codex（app 内置的那份）"
probe_bin node  "装 Node.js 18+"
[ "$QUIET" = 1 ] || {
  for c in claude cursor-agent opencode; do
    command -v "$c" >/dev/null 2>&1 && probe_bin "$c" "按对应项目文档重装" >/dev/null
  done
}

# ────────────────────── 2 桌面 app 的完整性 ──────────────────────
sec 2 "桌面 app 完整性 —— 改过别人的 app 就会这样"

# 2026-10-11 为让 GUI 注入 CODEX_HOME，往 /Applications/ChatGPT.app 里塞了 shim
# 并改了 Info.plist → 签名失效 → macOS 拒绝启动 → 双击弹窗报错，一个月后才发现。
# 这条检查就是那个坑的「谁会喊」。
APP="/Applications/ChatGPT.app"
if [ -d "$APP" ]; then
  if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    ok "ChatGPT.app 签名自洽"
  else
    hard "ChatGPT.app 签名校验失败 —— 双击会弹「已损坏 / 无法验证开发者」"
    printf '      核对：spctl -a -vvv "%s"\n' "$APP"
    printf '      常见原因：改过 Info.plist（CFBundleExecutable）、往 Contents/ 里加过文件、\n'
    printf '                或者跑过 codesign --force -s - 把官方签名换成了 ad-hoc。\n'
    fix "codesign --force --deep -s - '$APP' 先让它能开；要恢复官方签名需重装或被 app 自动更新覆盖"
  fi
  # 顺带说明「名字和身份对不上」这件事，省得下次再困惑
  local_bid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null)"
  [ "$QUIET" = 1 ] || dim "    显示名 ChatGPT，内部标识 ${local_bid:-读不到} —— 这是同一个 app 的两张脸，不是两个产品"
else
  nota "未安装 ChatGPT.app（不需要它也能用，跳过）"
fi

# ────────────────────── 3 配置指向 ──────────────────────
sec 3 "Codex CLI 的配置指向"

CFG="$HOME/.codex/config.toml"
CODEX_PORT="$(svc_port_of codex)"
[ -n "$CODEX_PORT" ] || CODEX_PORT=18790

if [ ! -f "$CFG" ]; then
  nota "没有 $CFG —— Codex CLI 还没被配置过（跑 quickstart 会写）"
else
  BASE_URL="$(grep -E '^[[:space:]]*base_url' "$CFG" 2>/dev/null | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]*)"?.*/\1/')"
  if [ -z "$BASE_URL" ]; then
    warn "$CFG 里没有 base_url —— 请求不会经过本项目的代理"
    fix "跑 bash scripts/quickstart.sh 会自动写"
  # 🔴 `grep "a\|b"` 在 BSD grep 的 BRE 里恒不成立（\(\|\) 不是 ERE 的 or）。
  #    必须 -E，"或"写成 |。这条踩过不止一次。
  elif printf '%s' "$BASE_URL" | grep -qE "127\.0\.0\.1:${CODEX_PORT}|localhost:${CODEX_PORT}"; then
    ok "base_url 指向本机 ${CODEX_PORT}（正确）"
  else
    # 🔴 变量名后面紧跟中文必须写 ${VAR}：bash 会把多字节字符的首字节吃进变量名，
    #    在 set -u 下直接 unbound variable。`$BASE_URL，` 就是这么炸的。
    hard "base_url 指向 ${BASE_URL}，不是本机的 ${CODEX_PORT}"
    fix "改成 http://127.0.0.1:${CODEX_PORT}/v1，或重跑 quickstart"
  fi
  WIRE="$(grep -E '^[[:space:]]*wire_api' "$CFG" 2>/dev/null | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]*)"?.*/\1/')"
  if [ -n "$WIRE" ] && [ "$WIRE" != "responses" ]; then
    warn "wire_api = $WIRE —— Codex CLI 通过本项目转发时需要 responses"
  fi

  # 沙箱模式：缺省是 read-only，模型连 hello.txt 都建不了。
  # 这一步必须查——因为「默认值」不会在文件里留痕迹，看不出来才最容易反复踩。
  SANDBOX="$(grep -E '^[[:space:]]*sandbox_mode' "$CFG" 2>/dev/null | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]*)"?.*/\1/')"
  if [ -z "$SANDBOX" ]; then
    nota "没写 sandbox_mode —— 按默认 read-only 处理：codex 只能读、不能写文件"
    fix "想要能改代码，在 ${CFG} 顶层加 sandbox_mode = \"workspace-write\""
  elif [ "$SANDBOX" = "read-only" ]; then
    nota "sandbox_mode = read-only —— 刻意的只读，codex 写不了文件（不是故障）"
  else
    ok "sandbox_mode = ${SANDBOX}（可写工作区）"
    # workspace-write 会连网络一起掐掉，那样连不上本机代理，症状是「模型不回话」。
    if [ "$SANDBOX" = "workspace-write" ]; then
      NETOK="$(grep -E '^[[:space:]]*network_access' "$CFG" 2>/dev/null | head -1 | grep -cE 'true')"
      if [ "${NETOK:-0}" -eq 0 ]; then
        warn "workspace-write 下没开 network_access —— 沙箱会掐掉网络，连不上本机 ${CODEX_PORT}"
        fix "加一段 [sandbox_workspace_write] 并写 network_access = true"
      fi
    fi
  fi
fi

# ────────────────────── 4 端口 ──────────────────────
sec 4 "服务端口"

for entry in codex manager; do
  port="$(svc_port_of "$entry")"
  [ -n "$port" ] || continue
  if port_busy "$port"; then
    ok "$(printf '%-12s %s 在跑' "$entry" "$port")"
  else
    # 没起服务不是环境故障，只是不会被诊断成「坏」
    nota "$(printf '%-12s %s 未在跑' "$entry" "$port")"
  fi
done

# 端口开着但上游已死时，curl 会返回 502（那是代理在应答，不是服务活着）。
# 所以这里必须真的发一次请求并看状态码，不能只 connect。
if port_busy "$CODEX_PORT"; then
  HTTP="$(curl -s --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CODEX_PORT/v1/models" 2>/dev/null)"
  case "$HTTP" in
    200) ok "codex-proxy /v1/models 真能应答（200）" ;;
    502) hard "codex-proxy 端口开着但返回 502 —— 前面那层代理在应答，后面的上游已经死了"
         fix "重启 codex-proxy：launchctl kickstart -k gui/\$(id -u)/<label>" ;;
    000) hard "codex-proxy 端口探活成功但 HTTP 请求连不上 —— 服务半死"
         fix "重启 codex-proxy" ;;
    *)   warn "codex-proxy /v1/models 返回 $HTTP（不一定是故障，看它是否要求鉴权）" ;;
  esac
fi

# ────────────────────── 结论 ──────────────────────
printf '\n'
if [ "$HARD" -eq 0 ]; then
  bold "结论：环境没有硬问题。"
  [ "$QUIET" = 1 ] || dim "「未安装 / 未在跑」是 - 不是 ✗ —— 按需的东西没装不算坏。"
  exit 0
else
  bold "结论：$HARD 处硬问题（见 ✗）。"
  dim "每条都给了原因和修法；改完再跑一次这条命令，✗ 消失才算真修好。"
  exit 1
fi
