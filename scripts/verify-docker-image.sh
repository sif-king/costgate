#!/usr/bin/env bash
# Copyright (c) 2026 sif-king / costgate contributors
# SPDX-License-Identifier: AGPL-3.0
#
# 镜像启动冒烟：构建绿 ≠ 跑得起来。
#
# 为什么要有它：2026-11-16 实测 Dockerfile.manager 能构建成功，但容器起来立刻
# MODULE_NOT_FOUND 退出（漏 COPY l2/、packs/，且 manager 目录名与 packs 里的相对
# require 对不上）。构建日志全绿，只有真起一个容器才看得见。lite-mvp 当时是对的、
# manager 漂了 —— 所以判据不能靠「我照着抄了」，只能靠真跑。
#
# 用法：
#   bash scripts/verify-docker-image.sh                      # 用已有镜像 costgate-manager:verify
#   BUILD=1 bash scripts/verify-docker-image.sh              # 先构建再冒烟
#   IMG=xxx PORT=18899 bash scripts/verify-docker-image.sh
#
# 端口与镜像名都可用环境变量覆盖；默认值只是「本次观测」，不是接口约定。

set -uo pipefail

IMG="${IMG:-costgate-manager:verify}"
PORT="${PORT:-18899}"
NAME="${NAME:-costgate-image-smoke}"
DATA_DIR="${DATA_DIR:-$(mktemp -d)/data}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${BUILD:-0}" = "1" ]; then
  echo "→ 构建 $IMG"
  docker build -f "$ROOT/Dockerfile.manager" -t "$IMG" "$ROOT"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "✗ 构建失败 rc=$rc"
    exit 1
  fi
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
}
trap cleanup EXIT

cleanup
echo "→ 启动容器 ${NAME}（宿主端口 ${PORT}）"
# 按 docker-compose 的真实形态起：容器内绑 0.0.0.0，且必须有 MANAGER_PASSWORD（否则 fail-closed 拒启）。
# 不用 MP_BIND_AUTH_BYPASS 绕过——冒烟要验的是用户实际会走的那条路。
docker run -d --name "$NAME" -p "${PORT}:18792" \
  -e BIND_HOST=0.0.0.0 \
  -e MANAGER_PASSWORD=smoke-test-only \
  -e "MP_DATA_DIR=${DATA_DIR}" "$IMG" >/dev/null
if [ "$?" -ne 0 ]; then
  echo "✗ docker run 失败"
  exit 1
fi

# 最多等 20 秒就绪；判据是 HTTP 200，不是「容器还在跑」——崩退的容器也会短暂 Up。
http=""
for _ in $(seq 1 20); do
  http=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)
  [ "$http" = "200" ] && break
  sleep 1
done

if [ "$http" = "200" ]; then
  echo "✓ /api/health 200，镜像可启动"
  exit 0
fi

echo "✗ /api/health 未返回 200（最后拿到 ${http:-000}）"
echo "--- 容器状态 ---"
docker ps -a --filter "name=${NAME}" --format '{{.Status}}'
echo "--- 容器日志（尾 30 行）---"
docker logs "$NAME" 2>&1 | tail -30
exit 1
