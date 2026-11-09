#!/usr/bin/env bash
# multi-proxy 零 key 冷启自证：每个代理真起一次、真发一条请求、真看 upstream 回来的 usage。
#
# 为什么单独一个脚本，而不是塞进 verify.sh：
#   verify.sh 承诺「不发一个出网请求」。这个脚本的整个意义就是**发真请求**，
#   所以必须分开，且由你显式运行。
#
# 用法：
#   bash scripts/verify-lanes.sh                 # 查全部（没有 node_modules 的会跳过）
#   bash scripts/verify-lanes.sh codex dsh       # 只查指定
#   MP_VERIFY_UPSTREAM_BASE=... bash scripts/verify-lanes.sh   # 换上游（默认 Kilo 匿名池）
#
# 退出码：0 全部通过（跳过不算失败）/ 1 有链路失败 / 2 一条都没能验（全跳过）
#
# 它不会碰你的真实配置：
#   · 每个 lane 用独立的临时 HOME（mktemp -d），providers.json 写在临时目录里
#   · 不读也不写 ~/.multi-proxy-manager
#   · 端口用 18900 起的高位段，避开默认端口
#   · 跑完删临时目录、杀进程

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_BASE="${MP_VERIFY_UPSTREAM_BASE:-https://api.kilo.ai/api/gateway/v1}"
UPSTREAM_MODEL="${MP_VERIFY_UPSTREAM_MODEL:-kilo-auto/free}"
UPSTREAM_LABEL="零 key 上游（${UPSTREAM_MODEL} @ ${UPSTREAM_BASE}）"

# 进程清理：只 kill 一次是不够的。
# 2026-11-08 实测：脚本被中断（Ctrl-C / 超时）后，7 个 node proxy.js 留在 189xx 端口上
# 一直占内存，后面再跑别的测试就被内存压死了——而屏幕上什么都看不出来。
# 所以把起过的 pid 记下来，退出时统一收，单个 lane 结束时也要等到「真没了」再算干净。
CLEANUP_PIDS=""
add_pid()     { CLEANUP_PIDS="$CLEANUP_PIDS $1"; }
cleanup_all() {
  local p
  for p in $CLEANUP_PIDS; do
    kill "$p" 2>/dev/null
  done
  CLEANUP_PIDS=""
}
trap cleanup_all EXIT INT TERM

# kill + 等它真退出（最多 2s），还不走就 -9。返回后该端口应已释放。
release_pid() {
  local p="$1" i
  [ -n "$p" ] || return 0
  kill "$p" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.2
  done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
  return 0
}

# lane → 目录 + 目录里的入口文件
lane_dir()  { case "$1" in
  codex) echo "codex-proxy" ;;
  claude) echo "claude-proxy" ;;
  opencode) echo "opencode-proxy" ;;
  generic) echo "generic-openai-proxy" ;;
  dsh) echo "dsh-proxy" ;;
  *) return 1 ;;
esac }

# lane → 数据面协议。claude-proxy 只有 Anthropic 的 /v1/messages（没有 chat/completions），
# 拿 OpenAI 的地址去打它必然 404 —— 那不是链路坏了，是脚本打错了门。
lane_wire() { case "$1" in
  claude) echo "anthropic" ;;
  *) echo "openai" ;;
esac }

ALL_LANES="codex claude opencode generic dsh cursor"

C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_WARN=$'\033[33m'
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$C_BAD" "$C_RESET" "$*"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }

port_free() { ! /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pick_port() {
  local p
  for _ in $(seq 1 40); do
    p=$((18900 + RANDOM % 90))
    port_free "$p" && { echo "$p"; return 0; }
  done
  return 1
}

wait_health() {
  local url="$1" i
  for i in $(seq 1 80); do
    curl -fsS --noproxy '*' -m 1 "$url/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# 解析响应：输出 "TEXT<TAB>prompt<TAB>completion<TAB>total"
# 三种 wire 都要认：
#   OpenAI Chat → choices[0].message.{content|reasoning_content|reasoning}，usage.prompt_tokens
#   OpenAI Responses → output[] 里 type==="message" 的 content[].text（Codex CLI 走这条）
#   Anthropic  → content[] 里 type==="text" 的分块，usage.input_tokens / output_tokens（没有 total，自己加）
PARSE_JS='
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j=JSON.parse(s); } catch(e) { process.stdout.write("ERR\t非 JSON："+s.slice(0,160)); return; }
  if (j.error) { const m=(typeof j.error==="string")?j.error:(j.error.message||JSON.stringify(j.error)); process.stdout.write("ERR\t"+String(m).slice(0,160)); return; }
  let text="", u=j.usage||{}, p="?", q="?", t="?";
  if (Array.isArray(j.output)) {
    text=(j.output.filter(o=>o&&o.type==="message")
      .flatMap(o=>Array.isArray(o.content)?o.content:[])
      .filter(c=>c&&typeof c.text==="string").map(c=>c.text).join(" ")||"").trim();
    p=(u.input_tokens??u.prompt_tokens??"?");
    q=(u.output_tokens??u.completion_tokens??"?");
    t=(p!=="?"&&q!=="?") ? String(Number(p)+Number(q)) : "?";
  } else if (Array.isArray(j.content)) {
    text=(j.content.filter(b=>b&&b.type==="text").map(b=>b.text).join(" ")||"").trim();
    p=(u.input_tokens??"?");
    q=(u.output_tokens??"?");
    t=(p!=="?"&&q!=="?") ? String(Number(p)+Number(q)) : "?";
  } else {
    const c=(j.choices&&j.choices[0])||{}, m=c.message||{};
    text=String(m.content||m.reasoning_content||m.reasoning||"").trim();
    p=(u.prompt_tokens??u.input_tokens??"?");
    q=(u.completion_tokens??u.output_tokens??"?");
    t=(u.total_tokens??"?");
  }
  process.stdout.write((text?text.slice(0,60):"")+"\t"+p+"\t"+q+"\t"+t);
});
'

run_lane() {
  local lane="$1" dir port home pid passed=0
  dir="$ROOT/$(lane_dir "$lane")" || { bad "$lane: 未知 lane"; return 1; }
  [ -f "$dir/proxy.js" ] || { warn "$lane: 未安装（$dir/proxy.js 不存在），跳过"; return 2; }
  [ -d "$dir/node_modules" ] || { warn "$lane: node_modules 缺失，跳过（先 bash install.sh --${lane}）"; return 2; }
  port="$(pick_port)" || { bad "$lane: 找不到空闲端口"; return 1; }
  home="$(mktemp -d "${TMPDIR:-/tmp}/mp-lane-$lane.XXXXXX")"
  mkdir -p "$home/.multi-proxy-manager"
  cat >"$home/.multi-proxy-manager/providers.json" <<JSON
[
  { "name": "verify-zero-key", "provider_id": "verify-zero-key", "api_key": "",
    "base_url": "$UPSTREAM_BASE", "enabled": true, "models": ["$UPSTREAM_MODEL"] }
]
JSON

  printf '\n%s\n' "── ${lane}（端口 ${port}）"
  # exec 是必须的：`( cd X && node Y ) &` 里 $! 拿到的是那个后台子 shell 的 pid，
  # 杀它只会留下孤儿 node，端口和内存都被占着（2026-11-08 实测留了 7 个）。
  # 加 exec 让子 shell 直接变成 node 本身，pid 才对得上。
  (
    cd "$dir" || exit 1
    exec env HOME="$home" PORT="$port" MANAGER_URL="http://127.0.0.1:1" node proxy.js
  ) >"$home/$lane.log" 2>&1 &
  pid=$!
  add_pid "$pid"

  if ! wait_health "http://127.0.0.1:$port"; then
    bad "$lane: 15s 内 /health 没起来"
    dim "日志：$home/$lane.log"
    sed -n '1,6p' "$home/$lane.log" 2>/dev/null | sed 's/^/    /'
    release_pid "$pid"
    echo "$home" >/tmp/mp-last-failed-home
    return 1
  fi
  ok "健康检查通过"

  local payload parsed status text p q t wire url
  wire="$(lane_wire "$lane")"
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":512}' "$UPSTREAM_MODEL")
  if [ "$wire" = "anthropic" ]; then
    url="http://127.0.0.1:$port/v1/messages"
    dim "wire: anthropic → $url"
    parsed=$(curl -sS --noproxy '*' -m 120 -X POST "$url" \
      -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d "$payload" 2>&1 | node -e "$PARSE_JS" 2>/dev/null)
  else
    url="http://127.0.0.1:$port/v1/chat/completions"
    dim "wire: openai → $url"
    parsed=$(curl -sS --noproxy '*' -m 120 -X POST "$url" \
      -H 'Content-Type: application/json' \
      -d "$payload" 2>&1 | node -e "$PARSE_JS" 2>/dev/null)
  fi
  status=$(printf '%s' "$parsed" | cut -f1)

  if [ "$status" = "ERR" ]; then
    bad "$lane: 上游请求失败 —— $(printf '%s' "$parsed" | cut -f2-)"
    dim "日志：$home/$lane.log"
    release_pid "$pid"
    echo "$home" >/tmp/mp-last-failed-home
    return 1
  fi

  text=$(printf '%s' "$parsed" | cut -f1)
  p=$(printf '%s' "$parsed" | cut -f2)
  q=$(printf '%s' "$parsed" | cut -f3)
  t=$(printf '%s' "$parsed" | cut -f4)

  [ -n "$text" ] && ok "上游回复：「${text}」" || { bad "$lane: 200 但文本为空"; passed=1; }
  if [ "$p" != "?" ]; then
    ok "真实用量：输入 $p · 输出 $q · 合计 $t tokens"
  else
    bad "$lane: 响应里没有 usage —— 这条链不会记账"; passed=1
  fi

  # Codex CLI 真实走的是 /v1/responses，不是 chat/completions。
  # 只验 chat/completions 等于验了一扇用户不走的门：responses 那条路上的
  # 请求改写、鉴权、用量回传是另外几段代码（改一处漏一处不会互相报错）。
  if [ "$lane" = "codex" ]; then
    local rpayload rparsed rtext rp rq
    rpayload=$(printf '{"model":"%s","input":"Reply with exactly: pong","stream":false}' "$UPSTREAM_MODEL")
    dim "wire: openai-responses → http://127.0.0.1:${port}/v1/responses"
    rparsed=$(curl -sS --noproxy '*' -m 120 -X POST "http://127.0.0.1:${port}/v1/responses" \
      -H 'Content-Type: application/json' -d "$rpayload" 2>&1 | node -e "$PARSE_JS" 2>/dev/null)
    rtext=$(printf '%s' "$rparsed" | cut -f1)
    rp=$(printf '%s' "$rparsed" | cut -f2)
    rq=$(printf '%s' "$rparsed" | cut -f3)
    if [ "$rtext" = "ERR" ]; then
      bad "codex: /v1/responses 失败 —— Codex CLI 走的就是这条路：$(printf '%s' "$rparsed" | cut -f2-)"
      passed=1
    elif [ -z "$rtext" ]; then
      bad "codex: /v1/responses 回了 200 但文本为空"
      passed=1
    elif [ "$rp" != "?" ]; then
      ok "Codex CLI 那条路（/v1/responses）也通：输入 $rp · 输出 $rq"
    else
      bad "codex: /v1/responses 没有 usage —— 这条路不会记账"
      passed=1
    fi
  fi

  release_pid "$pid"
  if [ "$passed" = "0" ]; then
    rm -rf "$home"
    return 0
  fi
  dim "保留现场：$home"
  return 1
}

# cursor 单独一条路：它的上游不在 providers.json，而在 SQLite（data/proxy.db）里，
# 而且是加密存的。所以不能像别的那样写一份 JSON 就算配好，得走它的 admin-api
# 建一条上游。为了仍然做到「不碰你的真实配置」，这里把 dist 复制到临时目录再启动
# —— 数据库路径是相对模块位置的，复制过去后它就落在临时目录里，跑完删掉。
run_cursor_lane() {
  local dir="$ROOT/cursor-proxy" port home pid passed=0
  if [ ! -f "$dir/dist/server/start.js" ]; then
    warn "cursor: 未构建（dist/server/start.js 不存在），跳过（先 bash install.sh --cursor）"
    return 2
  fi
  [ -d "$dir/node_modules" ] || { warn "cursor: node_modules 缺失，跳过（先 bash install.sh --cursor）"; return 2; }
  port="$(pick_port)" || { bad "cursor: 找不到空闲端口"; return 1; }
  home="$(mktemp -d "${TMPDIR:-/tmp}/mp-lane-cursor.XXXXXX")"
  mkdir -p "$home/cursor-proxy"
  cp -R "$dir/dist" "$home/cursor-proxy/dist"
  ln -s "$dir/node_modules" "$home/cursor-proxy/node_modules"

  printf '\n%s\n' "── cursor（端口 ${port}）"
  # ENCRYPTION_KEY 走环境变量（crypto.ts 里优先级高于 .encryption-key 文件），
  # 这样临时库用一把一次性密钥，不会动你项目根目录下那把真的。
  # exec 同理：不 exec 的话 $! 是子 shell，杀掉留孤儿。
  (
    cd "$home/cursor-proxy" || exit 1
    exec env PORT="$port" ENCRYPTION_KEY="verify-lanes-ephemeral-key-32b" node dist/server/start.js
  ) >"$home/cursor.log" 2>&1 &
  pid=$!
  add_pid "$pid"

  if ! wait_health "http://127.0.0.1:${port}"; then
    bad "cursor: 15s 内 /health 没起来"
    dim "日志：$home/cursor.log"
    sed -n '1,6p' "$home/cursor.log" 2>/dev/null | sed 's/^/    /'
    release_pid "$pid"
    echo "$home" >/tmp/mp-last-failed-home
    return 1
  fi
  ok "健康检查通过"

  # api_key 留空：Kilo 匿名池不需要 key。2026-11-08 之前这里填占位串会被上游
  # 判 401 INVALID_TOKEN（cursor 无条件发 Bearer），现已在 bearerAuth 里修掉。
  local created
  created=$(curl -sS --noproxy '*' -m 10 -X POST "http://127.0.0.1:${port}/admin-api/providers" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"verify-zero-key\",\"provider_id\":\"openai\",\"api_key\":\"\",\"base_url\":\"${UPSTREAM_BASE}\",\"enabled\":true}" 2>&1)
  case "$created" in
    *'"success":true'*) ok "上游已写入临时库（SQLite，未碰你的 data/proxy.db）" ;;
    *)
      bad "cursor: 建上游失败 —— $(printf '%s' "$created" | head -c 200)"
      dim "日志：$home/cursor.log"
      release_pid "$pid"
      echo "$home" >/tmp/mp-last-failed-home
      return 1
      ;;
  esac

  local url payload parsed text p q t
  url="http://127.0.0.1:${port}/v1/chat/completions"
  dim "wire: openai → $url"
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":512}' "$UPSTREAM_MODEL")
  parsed=$(curl -sS --noproxy '*' -m 120 -X POST "$url" \
    -H 'Content-Type: application/json' -d "$payload" 2>&1 | node -e "$PARSE_JS" 2>/dev/null)

  if [ "$(printf '%s' "$parsed" | cut -f1)" = "ERR" ]; then
    bad "cursor: 上游请求失败 —— $(printf '%s' "$parsed" | cut -f2-)"
    dim "日志：$home/cursor.log"
    release_pid "$pid"
    echo "$home" >/tmp/mp-last-failed-home
    return 1
  fi

  text=$(printf '%s' "$parsed" | cut -f1)
  p=$(printf '%s' "$parsed" | cut -f2)
  q=$(printf '%s' "$parsed" | cut -f3)
  t=$(printf '%s' "$parsed" | cut -f4)

  [ -n "$text" ] && ok "上游回复：「${text}」" || { bad "cursor: 200 但文本为空"; passed=1; }
  if [ "$p" != "?" ]; then
    ok "真实用量：输入 $p · 输出 $q · 合计 $t tokens"
  else
    bad "cursor: 响应里没有 usage —— 这条链不会记账"; passed=1
  fi

  release_pid "$pid"
  if [ "$passed" = "0" ]; then
    rm -rf "$home"
    return 0
  fi
  dim "保留现场：$home"
  return 1
}

main() {
  printf 'multi-proxy 零 key 冷启自证 · %s\n' "$(date '+%Y-%m-%d %H:%M')"
  printf '%s\n' "上游：$UPSTREAM_LABEL"
  printf '%s\n' "每个 lane 用独立临时目录（cursor 连数据库也复制一份过去），不碰你的配置；端口取 18900 高位段。"

  local lanes="$*"
  [ -z "$lanes" ] && lanes="$ALL_LANES"

  local pass=0 fail=0 skip=0 l rc
  for l in $lanes; do
    if [ "$l" = "cursor" ]; then
      run_cursor_lane; rc=$?
    else
      run_lane "$l"; rc=$?
    fi
    case "$rc" in
      0) pass=$((pass+1)) ;;
      2) skip=$((skip+1)) ;;
      *) fail=$((fail+1)) ;;
    esac
  done

  printf '\n%s\n' "──────────── 小结 ────────────"
  printf '通过 %d · 失败 %d · 跳过 %d\n' "$pass" "$fail" "$skip"
  if [ "$fail" -gt 0 ]; then
    printf '\n%s\n' "有链路没通过。上面每条的日志路径都印出来了，先看日志再说。"
    return 1
  fi
  if [ "$pass" -eq 0 ]; then
    printf '\n%s\n' "一条都没能验（全跳过）。先 bash install.sh --all，或把缺的 node_modules 装上。"
    return 2
  fi
  printf '\n%s\n' "通过的都是「真发了一条请求 + 拿到上游真 usage」——不是「进程起来了」。"
  return 0
}

main "$@"
