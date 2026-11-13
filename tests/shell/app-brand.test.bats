#!/usr/bin/env bats

# BATS tests for 桌面壳的应用身份（名字 / bundle id / 图标）。
# Run with: bats tests/shell/app-brand.test.bats
#
# 为什么要有这个文件（2026-11-13）：
#   老板打开电脑看到两个东西：/Applications/Proxy Manager.app（10 月那版 Electron 壳，
#   图标还是 electron.icns）和 ~/Applications/MultiProxy.app（改名前的原生壳）。
#   功能早就重写过两轮，但对外身份一直没跟着改，于是「产品叫什么」取决于哪个壳先被双击。
#   这类问题不会让测试变红，只会让用户没法确认自己跑的是哪一版。
#
# 这里钉的是可机器判的部分：名字、标识、图标在不在、旧名有没有残留。
# 「图标好不好看」机器判不了，人看（client/tools/make-icon.swift 出图）。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  PLIST="$ROOT/client/src/Info.plist"
  BUILD="$ROOT/client/build.sh"
  ICONGEN="$ROOT/client/tools/make-icon.swift"
}

@test "app bundle identity is costgate, not the old names" {
  run /usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST"
  [ "$output" = "costgate" ] || {
    echo "CFBundleName 是「$output」：Dock 与 Finder 会显示这个名字" >&2
    return 1
  }
  run /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST"
  [ "$output" = "costgate" ] || {
    echo "CFBundleExecutable 是「$output」：和 build.sh 里的二进制名必须一致" >&2
    return 1
  }
  run /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST"
  case "$output" in
    com.sifking.costgate.*) ;;
    *)
      echo "CFBundleIdentifier 是「$output」：旧的 com.multi-proxy.* 会让系统认成另一个应用" >&2
      return 1
      ;;
  esac
}

@test "app declares an icon and build.sh actually produces it" {
  run /usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$PLIST"
  [ "$output" = "costgate" ] || {
    echo "CFBundleIconFile 缺失或不是 costgate：系统会退回到默认图标（上次就是这个问题）" >&2
    return 1
  }
  grep -qF 'make-icon.swift' "$BUILD" || {
    echo "build.sh 没有调用 client/tools/make-icon.swift：图标会缺" >&2
    return 1
  }
  grep -qF 'iconutil' "$BUILD" || {
    echo "build.sh 没有 iconutil 步骤：只有 PNG 没有 .icns，App 图标不生效" >&2
    return 1
  }
  [ -f "$ICONGEN" ] || {
    echo "缺 client/tools/make-icon.swift：图标没有可复现的来源" >&2
    return 1
  }
}

@test "build.sh names the bundle costgate.app and reads version at runtime" {
  grep -qF 'costgate.app' "$BUILD" || {
    echo "build.sh 产出的不是 costgate.app" >&2
    return 1
  }
  # 版本号不许写死在脚本里（写死过两天就和仓库对不上，用户看到的是假的）
  grep -qF 'VERSION' "$BUILD" || {
    echo "build.sh 没有读 VERSION 文件：版本号会写死" >&2
    return 1
  }
  grep -qE 'rev-parse --short HEAD' "$BUILD" || {
    echo "build.sh 没有取 git 短 SHA：关于面板无法确认「这是哪一版」" >&2
    return 1
  }
}

@test "icon generator produces a full iconset" {
  local out="$BATS_TMPDIR/cg-iconset-$$"
  rm -rf "$out"
  run swift "$ICONGEN" "$out"
  [ "$status" -eq 0 ] || {
    echo "图标生成脚本跑失败：$output" >&2
    return 1
  }
  local n
  n="$(ls "$out"/*.png 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" -ge 10 ] || {
    echo "iconset 只有 $n 个尺寸（需要 10 个：16/32/128/256/512 各含 @2x）" >&2
    rm -rf "$out"
    return 1
  }
  # 1024 是 @2x 的 512，macOS 会用它做 Dock 大图标
  [ -f "$out/icon_512x512@2x.png" ] || {
    echo "缺 1024px 图：Retina Dock 会糊" >&2
    rm -rf "$out"
    return 1
  }
  rm -rf "$out"
}

@test "no stale product names left in the desktop shell source" {
  # 旧名残留会让「我到底开的哪个 App」变成猜谜。允许的例外只有：
  # ① 兼容旧目录（multi-proxy 的候选路径与状态目录）；② 代码注释里的历史说明。
  local bad
  bad="$(grep -nE 'MultiProxy|Proxy Manager' "$ROOT/client/src/main.swift" | grep -v '^[0-9]*: *//' || true)"
  [ -z "$bad" ] || {
    echo "main.swift 里还有用户可见的旧名字：" >&2
    echo "$bad" >&2
    return 1
  }
}

@test "web favicon and in-page logo share the costgate mark" {
  local fav="$ROOT/multi-proxy-manager/public/favicon.svg"
  local nav="$ROOT/multi-proxy-manager/public/nav.js"
  local pub="$ROOT/multi-proxy-manager/public"
  [ -f "$fav" ] || {
    echo "缺 favicon.svg" >&2
    return 1
  }
  grep -qF 'aria-label="costgate"' "$fav" || {
    echo "favicon 的无障碍名不是 costgate" >&2
    return 1
  }

  # 2026-11-13 固定侧栏改造后，品牌 SVG 由 nav.js 的 CG_BADGE / buildBrand() 单一真源
  # 运行时注入，各页 HTML 只留空骨架。守卫因此钉「真源在不在 + 覆盖面全不全」，
  # 不再逐页 grep HTML —— 那样会把刻意收敛成的单一真源误判成「漏了 9 个页面」。
  grep -qF 'class="cg-glyph"' "$nav" || {
    echo "nav.js 的 CG_BADGE 里没有 cg-glyph 标记：侧栏 logo 会和 favicon 不一样" >&2
    return 1
  }
  grep -qF 'buildBrand()' "$nav" || {
    echo "nav.js 没有把品牌徽标渲染进侧栏（真源存在但没接上）" >&2
    return 1
  }

  local pages bad
  pages="$(grep -l 'class="sidebar"' "$pub"/*.html | wc -l | tr -d ' ')"
  [ "$pages" -ge 8 ] || {
    echo "只有 $pages 个页面带侧栏骨架（固定侧栏改造前是 9 页）" >&2
    return 1
  }
  bad="$(for f in $(grep -l 'class="sidebar"' "$pub"/*.html); do
           grep -qF 'nav.js' "$f" || echo "$f"
         done)"
  [ -z "$bad" ] || {
    echo "以下页面有侧栏却没有引 nav.js，运行时不会注入品牌标记：" >&2
    echo "$bad" >&2
    return 1
  }

  # 登录页没有侧栏，标记仍须自带，否则「标签页 / 登录页 / 面板」三处会读成三个产品
  grep -qF 'class="cg-glyph"' "$pub/login.html" || {
    echo "login.html 没有 cg-glyph 标记（它没有侧栏，拿不到 nav.js 注入）" >&2
    return 1
  }
}
