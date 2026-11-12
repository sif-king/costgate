#!/bin/bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
#
# 编译 costgate 原生客户端（AppKit + WKWebView，无 Electron、无第三方依赖）
# 输出：client/build/costgate.app
#
# 版本号与构建号一律运行时读（VERSION 首行 + git HEAD），不在这里写死：
# 写死的版本过两天就和仓库对不上，用户看到的是假的。
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/.." && pwd)"
OUT="$SRC/build"
APP="$OUT/costgate.app"
BIN="$APP/Contents/MacOS/costgate"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "== 编译 =="
swiftc -O -target "${TARGET:-arm64-apple-macosx12.0}" -o "$BIN" "$SRC/src/main.swift" 2>&1 | tail -20
[ -x "$BIN" ] || { echo "编译失败"; exit 1; }

echo "== 图标 =="
ICONSET="$(mktemp -d)/costgate.iconset"
if swift "$SRC/tools/make-icon.swift" "$ICONSET" >/dev/null 2>&1 &&
   iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/costgate.icns" 2>/dev/null; then
  echo "图标：costgate.icns"
else
  echo "⚠️ 图标生成失败（不影响运行，但会显示系统默认图标）"
fi

cp "$SRC/src/Info.plist" "$APP/Contents/Info.plist"
chmod +x "$BIN"

# 版本：VERSION 首行 + git 短 SHA（无 git 时写 dev，绝不假装有版本号）
VER="$(head -1 "$ROOT/VERSION" 2>/dev/null | tr -d '[:space:]')"
[ -n "${VER:-}" ] || VER="0.0.0"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VER" "$APP/Contents/Info.plist" 2>/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${SHA}" "$APP/Contents/Info.plist" 2>/dev/null
/usr/libexec/PlistBuddy -c "Set :CGCommit ${SHA}" "$APP/Contents/Info.plist" 2>/dev/null
echo "版本：$VER ($SHA)"

echo "== adhoc 签名（本机无 Developer ID）=="
codesign --force --deep --options runtime -s - "$APP" 2>&1 | tail -3

echo "== 落地 =="
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
echo "产物：$APP"
