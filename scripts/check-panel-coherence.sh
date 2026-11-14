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

# ── 4. dashboard.html 里的 .page 容器必须有入口 ─────────────────────
# 2026-11-14 新增。触发案例：page-sessions 容器存在、有内容、被 loadSessions() 持续渲染，
# 但 SPA_VIEWS 里没有它、侧栏 /sessions 走的是独立 sessions.html、也没有任何
# switchPage('sessions') 调用 —— 也就是说用户永远看不到它，而读失败提示还写进它里面，
# 可见的卡只剩「暂无运行中任务」。这类死容器不报错、不崩，只能靠树里比对抓。
# 入口算三类：页内 tab（SPA_VIEWS）/ 硬编码 tab（data-page）/ 代码跳转（switchPage）。
DASH="$PANEL_DIR/dashboard.html"
if [ -f "$DASH" ]; then
  spa_ids=$(awk '/var SPA_VIEWS = \[/,/^  \];/' "$NAV_JS" \
            | grep -oE "id: '[a-z-]+'" | sed -E "s/id: '//; s/'//" | sort -u)
  while IFS= read -r cid; do
    [ -n "$cid" ] || continue
    short="${cid#page-}"
    reachable=0
    printf '%s\n' "$spa_ids" | grep -qxF -- "$short" && reachable=1
    grep -qF -- "data-page=\"${short}\"" "$DASH" && reachable=1
    grep -qF -- "switchPage('${short}')" "$DASH" && reachable=1
    grep -qE "class=\"page active\" id=\"${cid}\"" "$DASH" && reachable=1
    if [ "$reachable" -eq 0 ]; then
      fail "dashboard.html 的 #${cid} 没有任何入口（不在 SPA_VIEWS / 无 data-page / 无 switchPage 跳转 / 不是默认页）—— 死容器，删掉或补入口"
    fi
  done < <(grep -oE 'class="page( active)?" id="page-[a-z-]+"' "$DASH" \
           | sed -E 's/.*id="(page-[a-z-]+)".*/\1/' | sort -u)
fi

# ── 5. 引了 mp-kernel.js 的页面，script 标签必须早于页面自己的内联脚本 ──
# 2026-11-14 新增。触发案例：8 个页面改成 `var esc = MPKernel.esc` 别名后，
# 7 个页面的 <script src="./mp-kernel.js"> 被插在文档末尾，而页面 IIFE 在前
# ——执行到别名赋值时 MPKernel 还没定义，整页脚本抛 ReferenceError 全死。
# 这种坏法**不会让页面变空白**（静态 HTML 照旧渲染），所以「body 有文字」类
# E2E 全绿也照样是坏的；只能比对行号抓。
for f in "$PANEL_DIR"/*.html; do
  [ -e "$f" ] || continue
  grep -qF 'mp-kernel.js' "$f" || continue
  # 只算真的 script 标签，注释里提到文件名不算
  kline=$(grep -nE '<script[^>]*src="\./mp-kernel\.js"' "$f" | head -1 | cut -d: -f1)
  if [ -z "$kline" ]; then
    fail "$(basename "$f") 提到 mp-kernel.js 却没有对应的 <script src> 标签（别名会 ReferenceError）"
    continue
  fi
  # 内联脚本起始行（排除外链 script）
  iline=$(grep -nE '<script>|<script [^>]*>[^<]' "$f" | grep -vE 'src=' | head -1 | cut -d: -f1)
  if [ -n "$iline" ] && [ "$kline" -gt "$iline" ]; then
    fail "$(basename "$f") 的 mp-kernel.js 标签在第 ${kline} 行，晚于内联脚本第 ${iline} 行 —— 页面执行到 MPKernel.* 时它还没加载（移进 <head>）"
  fi
done

# ── 6. 版本号不许写死在 HTML / nav.js ──────────────────────────────
# 2026-11-14 新增（老板拍板「版本信息统一到 /api/version」）。
# 触发案例：nav.js 的 buildFooter() 写死 'v1.0.0'，九个页面的侧栏常年显示同一个
# 假版本；设置页「关于」卡另写死「1.0（v1.0 收尾）」。版本号是判断「要不要升级」
# 的依据，写死等于永远告诉用户「已是最新」——这跟喂假成本数字是同一个毛病。
# 判据：这两个 id 的元素里只允许出现占位符 '—'，出现数字或 v 开头即红。
# 版本号的唯一真源是仓库根 VERSION（经 /api/version 下发）。
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  fail "版本号写死：$hit（改为占位 '—' + 从 /api/version 填）"
done < <(grep -HnE 'id="(sidebarVersion|aboutVersion)">[0-9vV]' "$PANEL_DIR"/*.html 2>/dev/null)
if grep -qE 'id="sidebarVersion">[0-9vV]' "$NAV_JS"; then
  fail "nav.js 的 buildFooter() 里写死了版本号（改成 '—'，由 fillSidebarVersion() 从 /api/version 填）"
fi

if [ "$FAILS" -eq 0 ]; then
  ok "页面清单 / 导航可达 / 孤儿后端标注 / 容器入口 / kernel 加载顺序 / 版本号单一来源 六项一致"
  echo "结果：全过"
  exit 0
fi

echo "结果：$FAILS 项违规"
exit 1
