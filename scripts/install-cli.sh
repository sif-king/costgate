#!/bin/bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
#
# 把 `costgate` 命令挂到 PATH 上，让你在任何目录都能敲。
# 不动 shell 配置文件、不 sudo、不改 PATH：只在 PATH 里已存在的目录里放软链，
# 实在没有就告诉你该加哪一行。重复跑安全。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/costgate"

if [ ! -f "$BIN" ]; then
  echo "找不到 $BIN" >&2
  exit 1
fi
chmod +x "$BIN" 2>/dev/null

LINKED=()
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  [ -d "$d" ] || continue
  if ln -sf "$BIN" "$d/costgate" 2>/dev/null; then
    LINKED+=("$d/costgate")
  fi
done

if [ ${#LINKED[@]} -gt 0 ]; then
  echo "已挂上："
  for l in "${LINKED[@]}"; do echo "  $l"; done
  echo
  echo "试一下：costgate"
  exit 0
fi

# PATH 里没有可写目录：给一句能直接粘的话，不代改任何配置文件
cat <<EOF
没能在 PATH 目录里挂上软链。二选一：

1) 临时用（当前终端）：
   alias costgate='$BIN'

2) 永久用（自己粘进 ~/.zshrc，我不替你改）：
   echo "alias costgate='$BIN'" >> ~/.zshrc

不挂也能用：直接 $BIN
EOF
