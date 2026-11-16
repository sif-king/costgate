#!/usr/bin/env bats

# BATS tests for scripts/check-docker-runtime-closure.js
# Run with: bats tests/shell/docker-runtime-closure.test.bats
#
# 为什么锁这几条：这个守卫抓的是「镜像能构建、容器起来立刻 MODULE_NOT_FOUND」。
# 2026-11-17 同一天被咬了三次（manager 漏 l2/packs + 目录名落成 /app/manager、
# codex 漏 l2 之后又漏 tools/packs），本地全都看不出——只有真起容器才崩。
#
# 下面每条都用 --root 指向临时造的小树，不碰仓库里的 Dockerfile：
# 判据绑「行为」（缺 COPY 会红、路径错位会红），不绑「仓库现在长什么样」。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  GUARD="$ROOT/scripts/check-docker-runtime-closure.js"
}

# 造一棵最小可判的树：app/main.js require('../lib/util.js')，/app 是 WORKDIR
make_tree() {
  local d="$1"
  mkdir -p "$d/app" "$d/lib"
  printf 'module.exports = 1;\n' > "$d/lib/util.js"
  printf "const u = require('../lib/util.js');\nconsole.log(u);\n" > "$d/app/main.js"
  cat > "$d/Dockerfile.demo" <<'EOF'
FROM node:20-alpine
WORKDIR /app
COPY app/ ./
CMD ["node", "main.js"]
EOF
}

@test "guard exists and the current tree passes" {
  [ -f "$GUARD" ]
  run node "$GUARD"
  [ "$status" -eq 0 ]
}

@test "missing COPY of a cross-directory dependency turns it red" {
  local d="$BATS_TEST_TMPDIR/miss"
  make_tree "$d"
  run node "$GUARD" --root "$d"
  [ "$status" -eq 1 ]
  printf '%s' "$output" | grep -q '没有被任何 COPY 覆盖'
  printf '%s' "$output" | grep -q 'lib/util.js'
}

@test "copying the dependency to the WRONG destination turns it red" {
  # 这条对应 2026-11-16 的第二个 bug：多阶段目录落成 /app/manager 而不是
  # /app/multi-proxy-manager —— 文件都在，只是不在 Node 会去找的那个路径上。
  local d="$BATS_TEST_TMPDIR/wrongdest"
  make_tree "$d"
  printf 'COPY lib/ ./somewhere-else/\n' >> "$d/Dockerfile.demo"
  run node "$GUARD" --root "$d"
  [ "$status" -eq 1 ]
  printf '%s' "$output" | grep -q '按相对路径它要找'
}

@test "copying the dependency to the RIGHT destination goes green" {
  local d="$BATS_TEST_TMPDIR/rightdest"
  make_tree "$d"
  # main.js 在 /app，../lib 就要落到 /lib
  printf 'COPY lib/ /lib/\n' >> "$d/Dockerfile.demo"
  run node "$GUARD" --root "$d"
  [ "$status" -eq 0 ]
  printf '%s' "$output" | grep -q '相对依赖边全部对得上'
}

@test "python services are skipped with a reason, not silently passed" {
  local d="$BATS_TEST_TMPDIR/py"
  mkdir -p "$d/svc"
  printf 'print(1)\n' > "$d/svc/proxy.py"
  cat > "$d/Dockerfile.py" <<'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY svc/ ./
CMD ["python3", "proxy.py"]
EOF
  run node "$GUARD" --root "$d"
  [ "$status" -eq 0 ]
  printf '%s' "$output" | grep -q '跳过'
}
