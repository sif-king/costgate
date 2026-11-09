#!/usr/bin/env bats

# BATS tests: /v1/responses 这条路上必须真的记账
# Run with: bats tests/shell/responses-accounting.test.bats
#
# 为什么单独锁这条：2026-11-08 对照实测发现，同样条件下
#   · POST /v1/chat/completions  → 账本 +1
#   · POST /v1/responses         → 账本一行不动
# 而 Codex CLI 走的就是 /v1/responses。也就是说：**用 Codex CLI 的人，账本永远是空的**
# ——而「记一本你自己能查的花销账」是这个项目的第一句话。
#
# 根因：5 个代理是同一份代码复制出来的，responses 的成功分支里只有 captureTrace，
# 没有 reportUsage；chat 和 messages 两条分支都在 pipeUpstreamBytes 之后跟了
# reportUsage，唯独 responses 漏了。复制 5 份 = 漏 5 份，且互相不会报错。
#
# 这类「接线漏一处」用整体 grep 抓不住（文件里别处有 reportUsage 就能骗过），
# 所以要把 responses handler 那一段单独切出来看。

PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
}

# 切出 app.post('/v1/responses', ...) 整个 handler 的文本
responses_handler() {
  awk "/app\.post\('\/v1\/responses'/,/^\}\);/" "$1"
}

@test "every proxy calls reportUsage inside the /v1/responses handler" {
  local d block
  for d in codex-proxy claude-proxy opencode-proxy generic-openai-proxy dsh-proxy; do
    block="$(responses_handler "$PROJECT_ROOT/$d/proxy.js")"
    [ -n "$block" ] || { echo "$d: 找不到 /v1/responses handler" >&2; return 1; }
    printf '%s' "$block" | grep -q 'reportUsage(' \
      || { echo "$d: responses handler 里没有 reportUsage —— 这条路不记账" >&2; return 1; }
  done
}

@test "the /v1/responses handler measures latency rather than reporting 0" {
  # reportUsage 的第一个时间参数若没有起点，只能写 0 或 NaN；账本里 latencyMs 就没意义了。
  local d block
  for d in codex-proxy claude-proxy opencode-proxy generic-openai-proxy dsh-proxy; do
    block="$(responses_handler "$PROJECT_ROOT/$d/proxy.js")"
    printf '%s' "$block" | grep -qE 'const t0 = Date\.now\(\)' \
      || { echo "$d: responses handler 里没有 t0" >&2; return 1; }
    printf '%s' "$block" | grep -q 'Date.now() - t0' \
      || { echo "$d: reportUsage 没把耗时传进去" >&2; return 1; }
  done
}

@test "dsh attributes its own traffic to dsh, not to codex" {
  # dsh-proxy 是复制 codex 的，captureTrace 里 agent 一直是 'codex-proxy'。
  # 后果：追踪里 dsh 的流量记在 codex 名下，按 agent 分账的人会看错。
  local block
  block="$(awk "/app\.post\('\/v1\/responses'/,/^\}\);/" "$PROJECT_ROOT/dsh-proxy/proxy.js")"
  printf '%s' "$block" | grep -q "agent: 'dsh-proxy'" \
    || { echo "dsh-proxy 的 responses 追踪里 agent 不是 dsh-proxy" >&2; return 1; }
}

@test "chat and messages paths kept their reportUsage (do not fix one by breaking another)" {
  local d
  for d in codex-proxy claude-proxy opencode-proxy generic-openai-proxy dsh-proxy; do
    # chat 分支：pipeUpstreamBytes(..., '[chat]', ...) 之后应紧跟报账
    grep -q "pipeUpstreamBytes(res, response, '\[chat\]'" "$PROJECT_ROOT/$d/proxy.js" \
      || { echo "$d: 找不到 chat 分支" >&2; return 1; }
    # messages 分支同理
    grep -q "pipeUpstreamBytes(res, response, '\[messages\]'" "$PROJECT_ROOT/$d/proxy.js" \
      || { echo "$d: 找不到 messages 分支" >&2; return 1; }
  done
  # 三条分支各自的 reportUsage 都要还在
  for d in codex-proxy claude-proxy opencode-proxy generic-openai-proxy dsh-proxy; do
    local n
    n="$(grep -c 'reportUsage(acc, Date.now() - t0' "$PROJECT_ROOT/$d/proxy.js")"
    [ "$n" -ge 2 ] || { echo "$d: 只有 $n 处报账调用（chat 与 responses 至少各一处）" >&2; return 1; }
  done
}
