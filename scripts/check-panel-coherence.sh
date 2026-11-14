#!/bin/bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.
#
# 面板一致性守卫（重构刹车网 · 阶段 0）
#
# 为什么要有它：面板拆改期间最容易出的不是报错，是「页面还在、入口没了」和
# 「后端还挂着、前端没人调」。这两种都不报错，跑一遍也一切正常，只有用户点不到、
# 或者以为功能没做。所以判定只能靠「树里有什么」，不能靠「我跑了一下没问题」。
#
# 钉三件事，任一破了就红：
#   1. public/*.html 与下方 PAGE_REGISTRY 双向一致（新增页面必须登记，删除必须销账）
#   2. 登记为「要有导航入口」的页面，nav.js 里必须有对应 href（防孤儿页）
#   3. server.js 挂载的 /api/* 路由，若 public/ 零引用，该行必须带 BACKEND-ONLY 标注；
#      标了 BACKEND-ONLY 却又被前端引用的，属于标注过期，同样红（防半接线 + 防假标注）
#
# 退出码：0 = 全过；1 = 有违规（每条违规都打印怎么修）

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PANEL_DIR="multi-proxy-manager/public"
NAV_JS="$PANEL_DIR/nav.js"
SERVER_JS="multi-proxy-manager/server.js"
MARKER="BACKEND-ONLY"

FAILS=0
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILS=$((FAILS + 1)); }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# ── 登记表：页面名:是否必须有导航入口 ───────────────────────────────
# yes = 用户页，必须能从侧栏点到
# no  = 前置页（登录 / 同意门）或入口收口在别处的页（法务），不该出现在侧栏
PAGE_REGISTRY='dashboard:yes
floor:yes
context:yes
proxy-config:yes
sessions:yes
logs:yes
knowledge:yes
skills:yes
settings:yes
login:no
consent:no
legal:no'

echo "== 面板一致性守卫 =="

for f in "$PANEL_DIR" "$NAV_JS" "$SERVER_JS"; do
  [ -e "$f" ] || { fail "缺文件：$f"; echo "结果：$FAILS 项违规"; exit 1; }
done

# ── 1. 页面清单双向比对 ───────────────────────────────────────────
registered=""
while IFS=: read -r page need_nav; do
  [ -n "${page:-}" ] || continue
  registered="$registered $page"
  [ -f "$PANEL_DIR/$page.html" ] || \
    fail "登记表里有 $page.html，但文件不存在（页面真删了就从 PAGE_REGISTRY 销账）"
done <<EOF
$PAGE_REGISTRY
EOF

for path in "$PANEL_DIR"/*.html; do
  [ -e "$path" ] || continue
  name="$(basename "$path" .html)"
  case " $registered " in
    *" $name "*) ;;
    *) fail "新增页面 $name.html 没登记（在 PAGE_REGISTRY 补一行 $name:yes 或 $name:no）" ;;
  esac
done

# ── 2. 有导航入口的页面，nav.js 里必须真有 href ────────────────────
while IFS=: read -r page need_nav; do
  [ -n "${page:-}" ] || continue
  [ "$need_nav" = "yes" ] || continue
  grep -qE "href:[[:space:]]*'/$page'" "$NAV_JS" || \
    fail "$page.html 登记为「要有导航入口」，但 nav.js 没有 href: '/$page'（用户只能手敲 URL）"
done <<EOF
$PAGE_REGISTRY
EOF

# ── 3. 已挂载但前端零引用的 API 路由，必须带 BACKEND-ONLY 标注 ──────
# 用进程替换而不是管道：管道会开子 shell，fail 累加的 FAILS 会丢
while IFS= read -r route; do
  [ -n "$route" ] || continue
  refs=$(grep -rIlF -- "/api/$route" "$PANEL_DIR" 2>/dev/null | wc -l | tr -d ' ')
  line=$(grep -nE "^app\.use\('/api/$route'" "$SERVER_JS" | head -1)
  if [ "$refs" -eq 0 ]; then
    case "$line" in
      *"$MARKER"*) ;;
      *) fail "/api/${route} 面板零引用且没标注（该行末尾加 // ${MARKER}: 无面板入口，走 API/CLI）" ;;
    esac
  else
    case "$line" in
      *"$MARKER"*) fail "/api/${route} 标了 ${MARKER}，但面板有 ${refs} 个文件在引用（标注过期，删标注）" ;;
    esac
  fi
done < <(grep -E "^app\.use\('/api/[a-zA-Z0-9_-]+'" "$SERVER_JS" \
           | sed -E "s#^app\.use\('/api/([a-zA-Z0-9_-]+)'.*#\1#" | sort -u)

if [ "$FAILS" -eq 0 ]; then
  ok "页面清单 / 导航可达 / 孤儿后端标注 三项一致"
  echo "结果：全过"
  exit 0
fi

echo "结果：$FAILS 项违规"
exit 1
