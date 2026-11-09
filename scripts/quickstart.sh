#!/usr/bin/env bash
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the multi-proxy project.
#
# quickstart.sh —— 60 秒冷启：从零到看见第一笔真实账单
#
# 设计判据（对外交付四判据 I「冷启」的判别器）：
#   在干净环境（无 .env、无 ~/.multi-proxy-manager）下运行本脚本，
#   一条命令之内必须出现「本次请求真的花了 N tokens」——数字来自上游真实 usage，
#   不是模拟、不是估算、不是 0 冒充。
#
# 为什么只起两个服务：账本链是
#   客户端 → codex-proxy(上游转发+取 usage) → manager(POST /api/cost/report)
#          → ~/.multi-proxy-manager/cost-ledger.jsonl
#   两个进程就够跑通这条链。其余代理是「按需加装」的组件，不是首次体验的前提
#   （各代理可拆卸是本项目的设计原则）。
#
# 上游探测顺序（可用 MP_QS_UPSTREAM 强制指定：kilo | ollama）：
#   1) kilo   —— Kilo 匿名免费池，零账号零 key，实测 ~3s（默认优先：陌生人机器上最普遍可用）
#   2) ollama —— 本机已有 Ollama 时用本地模型（成本 0，但首次加载可能慢）
#   3) 都没有 —— 明确提示填一个 key，不做假通过
#
# 用法：
#   bash scripts/quickstart.sh            # 正常冷启（默认 codex-proxy，OpenAI wire）
#   MP_QS_CLIENT=claude bash scripts/quickstart.sh   # 换成 claude-proxy（Anthropic wire，给 Claude Code 用）
#   MP_QS_CODEX_PORT=18890 MP_QS_MANAGER_PORT=18892 bash scripts/quickstart.sh   # 换端口（并存测试）
#   HOME=/tmp/fresh bash scripts/quickstart.sh    # 模拟全新用户（不碰本机既有数据）
#
# 退出码：0 成功 / 1 环境不满足 / 2 请求成功但没落账（账本链断了，照实报，不粉饰）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 两个客户端走同一套流程，只有「打哪个端口、发什么 wire、怎么解析回复」不同。
# 2026-11-08 补 claude：Kilo 网关吃 Anthropic 的 /v1/messages，claude-proxy 对非
# deepseek/moonshot 上游兜底拼 {base_url}/messages —— 于是 Claude Code 也能零 key 冷启。
CLIENT="${MP_QS_CLIENT:-codex}"
case "$CLIENT" in
  codex)
    PROXY_DIR="codex-proxy";  PROXY_LABEL="codex-proxy"; PROXY_LOG="codex"
    PROXY_PORT="${MP_QS_CODEX_PORT:-18790}";  WIRE="openai" ;;
  claude)
    PROXY_DIR="claude-proxy"; PROXY_LABEL="claude-proxy"; PROXY_LOG="claude"
    PROXY_PORT="${MP_QS_CLAUDE_PORT:-18791}"; WIRE="anthropic" ;;
  *)
    printf '\033[31m✗ MP_QS_CLIENT=%s 不认识（只支持 codex / claude）\033[0m\n' "$CLIENT" >&2
    exit 1 ;;
esac
MANAGER_PORT="${MP_QS_MANAGER_PORT:-18792}"
DATA_DIR="$HOME/.multi-proxy-manager"
LOG_DIR="$DATA_DIR/logs"
PROVIDERS_FILE="$DATA_DIR/providers.json"
LEDGER="${PROXY_COST_LEDGER:-$DATA_DIR/cost-ledger.jsonl}"
UPSTREAM_PREF="${MP_QS_UPSTREAM:-}"
MODEL_PROMPT="${MP_QS_PROMPT:-Reply with exactly: pong}"
TOTAL_STEPS=5
T0=$(date +%s)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m[%s/%s]\033[0m \033[1m%s\033[0m\n' "$1" "$TOTAL_STEPS" "$2"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
elapsed() { echo $(( $(date +%s) - T0 )); }

# 分段计时。为什么需要：总时长是个「会变的观测值」，同一个脚本在本机测到过
# 7 / 11 / 13 / 14 / 26 / 62 / 97 秒。只报一个总数，用户无法判断慢在自己网络上
# 还是程序里 —— 于是第一步就变成「这项目是不是坏了」。分段之后，装依赖那一段
# 就是他自己的网络，其余三段是本程序。
# 用字符串累积而不是数组：macOS 自带 bash 3.2，空数组在 set -u 下展开会报 unbound。
T_LAST=$T0
LAP_LOG=""
lap() {
  local now; now=$(date +%s)
  # 换行必须用 $'\n' 拼在外面：命令替换 $(printf '...\n') 会吃掉尾随换行，
  # 于是三段会粘成一行（本机实测踩过）。也不做 %-14s 固定宽度对齐 ——
  # printf 按字节计宽，中文名会被算错，越对齐越乱。
  LAP_LOG="${LAP_LOG}  ${1}：$((now - T_LAST))s"$'\n'
  T_LAST=$now
}

# ---------- 基础工具 ----------

need_node() {
  # 最低版本必须与 install.sh 的 check_node_runtime 一致（tests/shell 有守卫钉住三处相等：
  # 这里 / install.sh / README「前置」）。2026-11-08 前这里是 18，用户能冷启成功、
  # 之后跑 install.sh 却被拦下——同一个项目两个口径，改成一个。
  command -v node >/dev/null 2>&1 || die "未找到 node。请先安装 Node.js 20+（https://nodejs.org）"
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || die "Node.js 版本过低：$(node -v)。本项目需要 20+"
}

port_busy() {
  node -e '
    const net=require("net"), s=net.createConnection({host:"127.0.0.1",port:+process.argv[1]});
    s.setTimeout(500);
    s.on("connect",()=>{s.destroy();process.exit(0)});
    s.on("error",()=>process.exit(1));
    s.on("timeout",()=>{s.destroy();process.exit(1)});
  ' "$1"
}

wait_http() { # url [tries]
  local url="$1" tries="${2:-60}" i=0
  while [ "$i" -lt "$tries" ]; do
    curl -fsS --noproxy '*' -m 1 "$url" >/dev/null 2>&1 && return 0
    sleep 0.25; i=$((i + 1))
  done
  return 1
}

# 起一个常驻子进程；用 exec 让 $! 就是 node 的 pid（否则 pid 是外层 subshell，停不掉真进程）
# 用法：start_svc <目录> <脚本> <日志名> [env=val ...]
#
# `</dev/null` 与 `3>&- … 9>&-` 不是洁癖：常驻子进程会继承调用者的文件描述符。
# 2026-11-08 实测——`bash scripts/quickstart.sh | tee log` 永远不返回，因为两个 daemon
# 攥着管道的写端；同样的形态在 bats 里表现成「所有用例都打印 ok，然后终端卡死」。
# 它自己的输出已经重定向到日志文件了，其余 fd 一律关掉。
start_svc() {
  local dir="$1" script="$2" logname="$3"; shift 3
  mkdir -p "$LOG_DIR"
  ( cd "$dir" && exec env "$@" node "$script" ) \
    </dev/null >>"$LOG_DIR/$logname.log" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
  echo $!
}

# 依赖完整性的判据是 npm 成功收尾时写的 node_modules/.package-lock.json。
# 别用「node_modules 目录存在」当判据：装到一半被打断时目录照样在，
# 之后每次运行都会判定「已就绪」跳过安装，用户就永久卡在 Cannot find module。
# （2026-11-07 实测踩过：目录 128 个包、缺 axios、无 .package-lock.json。）
deps_ready() { [ -f "$1/node_modules/.package-lock.json" ]; }

# 依赖自举：陌生人是 clone 之后跑的，仓库里没有 node_modules。
# 只装生产依赖（--omit=dev）：冷启不需要 jest/playwright/electron 那套，装了纯属浪费 60 秒。
# 两个服务并行装（实测串行 23s+16s，并行 ≈23s）——60 秒预算里这 16 秒值得省。
# 已有完整依赖直接跳过（老用户重复运行不受影响）。
#
# ⚠️ 上一行那句「--omit=dev 就够了」在 2026-11-09 之前是**假话**：
#    playwright 当时被写在 multi-proxy-manager 的 dependencies 里（不是 devDependencies），
#    --omit=dev 根本挡不住它 —— 于是每个新用户白下 18MB（占 node_modules 的 69%），
#    还要赌一次 postinstall 的 Chromium 下载。本机看不到，因为浏览器早缓存好了。
#    已移到 devDependencies，并由 scripts/check-prod-deps.js 守着（开发工具混进生产依赖、
#    以及「没人 require 的孤儿包」两路都会红）。改依赖前先跑它。
ensure_deps_all() {
  local pairs=("$ROOT/multi-proxy-manager:manager" "$ROOT/$PROXY_DIR:$PROXY_LABEL")
  local need=() pids=() pair dir label idx=0
  for pair in "${pairs[@]}"; do
    dir="${pair%%:*}"; label="${pair##*:}"
    if deps_ready "$dir"; then
      ok "$label 依赖已就绪"
    else
      need+=("$pair")
    fi
  done
  if [ "${#need[@]}" -eq 0 ]; then return 0; fi
  command -v npm >/dev/null 2>&1 || die "未找到 npm。请安装 Node.js（含 npm）后重试"
  say "安装依赖（首次需联网，约 20-30s，只发生一次）"
  for pair in "${need[@]}"; do
    dir="${pair%%:*}"; label="${pair##*:}"
    ( cd "$dir" && npm install --omit=dev --no-audit --no-fund --prefer-offline --loglevel=error ) \
      >"$LOG_DIR/npm-$label.log" 2>&1 &
    pids+=("$!")
  done
  for pair in "${need[@]}"; do
    # 退出码不可尽信：实测出现过「返回 0 但只落了部分包、无 .package-lock.json」，
    # 所以不按退出码判死，下面按落盘标记复核。
    wait "${pids[$idx]}" || true
    idx=$((idx + 1))
  done
  # 复核 + 补装：对不完整的那一个补一次；仍不完整才算失败（失败必须指向日志）。
  for pair in "${need[@]}"; do
    dir="${pair%%:*}"; label="${pair##*:}"
    if deps_ready "$dir"; then continue; fi
    # 首次没装完必须说清「为什么」。只报「补装一次」会让人以为本项目坏了；
    # 实测最常见的原因是网络（npm 连不上 registry / 公司代理 / 沙箱拦截），
    # 而 npm 的报错已经被写进日志文件、屏幕上只剩一句「补装一次」——等于藏证据。
    local why
    why=$(grep -E '^npm (error|ERR)' "$LOG_DIR/npm-$label.log" 2>/dev/null \
          | head -3 | sed 's/^npm error //; s/^npm ERR! //')
    if [ -n "$why" ]; then
      dim "  $label 首次安装没完成，npm 报的是："
      printf '%s\n' "$why" | sed 's/^/      /'
    fi
    # 半装会留下占位目录，直接重装常撞 ENOTEMPTY（实测卡在 playwright 的 rename）。
    # 先隔离再装，别在坏地基上浇筑。不存在时 mv 直接失败，忽略即可。
    local partial=""
    partial="node_modules.partial-$(date +%s)"
    mv "$dir/node_modules" "$dir/$partial" 2>/dev/null || partial=""
    [ -n "$partial" ] && dim "  $label 半装目录已隔离到 $dir/$partial"
    dim "  $label 补装一次"
    ( cd "$dir" && npm install --omit=dev --no-audit --no-fund --prefer-offline --loglevel=error ) \
      >>"$LOG_DIR/npm-$label.log" 2>&1 || true
    if ! deps_ready "$dir"; then
      [ -n "$partial" ] && dim "  隔离出来的半装依赖留在 ${dir}/${partial}（可自行删除）"
      die "$label 依赖装不完整（补装后仍缺 node_modules/.package-lock.json）。日志：$LOG_DIR/npm-$label.log"
    fi
    # 补装成功了，就把自己造的那份半装目录清掉：一次冷启会在用户 clone 里留下
    # 100MB 级的 node_modules.partial-*，是脚本自己产生的垃圾，不该让用户手工收拾。
    # 只删本函数刚刚 mv 出来的那一个（名字带时间戳、且是本轮的），不碰任何用户目录。
    if [ -n "$partial" ] && [ -d "$dir/$partial" ]; then
      rm -rf "$dir/$partial" 2>/dev/null \
        && dim "  $label 已清掉半装残留（${partial}）" \
        || dim "  半装残留没删掉：${dir}/${partial}（可自行删除）"
    fi
  done
  ok "依赖装好"
}

# ---------- 1. 探测上游 ----------

# 输出三行：base_url / model / models_json
# 判据用「真发一条 max_tokens=1 的请求」而不是拉模型清单：
#   ① 清单会随上游漂移，钉死某一批 id 迟早失效；
#   ② 能拉到清单 ≠ 能对话（限流/封 IP/模型下线都只在对话时暴露）。
# 只认稳定的聚合别名 kilo-auto/free（上游自动路由），不写死具体厂商型号。
probe_kilo() {
  local base="https://api.kilo.ai/api/gateway" model="kilo-auto/free" code
  code=$(curl -sS --noproxy '*' -m 25 -o /dev/null -w '%{http_code}' \
    -X POST "$base/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" \
    2>/dev/null) || return 1
  [ "$code" = "200" ] || return 1
  printf '%s\n%s\n["%s"]\n' "$base" "$model" "$model"
}

probe_ollama() {
  local base="http://127.0.0.1:11434"
  local body
  body=$(curl -fsS --noproxy '*' -m 3 "$base/api/tags" 2>/dev/null) || return 1
  # 注意：node 脚本在单引号里，bash 不会展开 $base —— 所以这里写死同一个常量，
  # 不写 "$base"（曾写错一次，会把字面量 '$base'/v1 写进 providers.json）。
  printf '%s' "$body" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let arr; try { arr=JSON.parse(s).models||[]; } catch(e) { process.exit(1); }
      // 只排除 embedding 模型（它们不能对话）；保留 name 与 size
      const cand=arr.filter(m=>m&&m.name&&!/embed/i.test(String(m.name)));
      if(!cand.length) process.exit(1);
      // 按体积升序选最小的：size 是字节，是唯一可靠信号。
      // 曾按名字正则 `/1b|1\.5b|3b|mini|tiny|small/` 挑，结果 qwen3:4b 与
      // qwen3.8:27b-mlx 都不匹配，落到 names[0] —— 挑中 18.2GB 的 27B，
      // 第一次请求要把它整个加载进内存，跟「60 秒」差了两个数量级。
      cand.sort((a,b)=>((a.size||Infinity)-(b.size||Infinity)));
      const pick=String(cand[0].name);
      const names=cand.map(m=>String(m.name));
      process.stdout.write("http://127.0.0.1:11434/v1\n"+pick+"\n"+JSON.stringify(names.slice(0,10))+"\n");
    });
  ' 2>/dev/null
}

# ---------- 2. 写入上游配置（合并，不覆盖用户已有 provider）----------

upsert_provider() { # file name provider_id base_url api_key models_json
  node - "$@" <<'NODE'
const fs = require('fs');
const [file, name, pid, base, key, modelsJson] = process.argv.slice(2);
let list = [];
try {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  list = Array.isArray(cur) ? cur : (Array.isArray(cur.providers) ? cur.providers : []);
} catch {}
let models = [];
try { models = JSON.parse(modelsJson); } catch {}
// 去重即可。曾经在这里无条件 concat 了 'kilo-auto/free'，结果是给 Ollama 的
// provider 也塞了这个模型名 —— 之后请求 kilo-auto/free 会被错误路由到本机 Ollama。
models = models.filter((v, i, a) => v && a.indexOf(v) === i);
const entry = {
  name, provider_id: pid, api_key: key, base_url: base, enabled: true, models,
};
const i = list.findIndex((p) => p && p.provider_id === pid);
if (i >= 0) list[i] = { ...list[i], ...entry, models: [...new Set([...(list[i].models || []), ...models])] };
else list.push(entry);
fs.mkdirSync(require('path').dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
NODE
}

# ---------- 命令行参数 ----------
#
# 只认 --stop / --help。**不认识的参数必须当场停下**：
# 2026-11-08 实测过——`bash scripts/quickstart.sh --help` 被当成普通冷启，真的装依赖、
# 起两个常驻进程、发一条真实请求。用户只是想问「怎么用」，机器上却多跑起两个服务，
# 还顺手改了他 ~/.multi-proxy-manager 里的上游配置与账本。
# 这不是「宽容」，是「沉默地干了别的事」。

usage() {
  cat <<EOF
multi-proxy · 60 秒冷启 —— 一条命令,看到第一笔真实账单

用法:
  bash scripts/quickstart.sh              冷启(默认 codex-proxy / OpenAI wire)
  bash scripts/quickstart.sh --stop       停掉上次冷启起的两个进程(按 pid 文件,不碰你其它服务)
  bash scripts/quickstart.sh --watch      盯账本,等「你自己工具」产生的第一笔账进来
                                          (最多 180 秒,MP_QS_WATCH_SECONDS 可改;等不到会报最常见的三个原因)
  bash scripts/quickstart.sh --help       就是这一屏(不碰任何文件、不起任何进程)

换成 Claude Code 那条链(Anthropic wire):
  MP_QS_CLIENT=claude bash scripts/quickstart.sh

换端口(与已在跑的服务并存):
  MP_QS_CODEX_PORT=18890 MP_QS_MANAGER_PORT=18892 bash scripts/quickstart.sh

模拟全新用户(不碰你自己的数据):
  HOME=\$(mktemp -d) bash scripts/quickstart.sh

可选环境变量:
  MP_QS_CLIENT      codex(默认) | claude
  MP_QS_UPSTREAM    kilo(默认) | ollama —— 强制指定上游,不走自动探测
  MP_QS_PROMPT      发给上游的那句话
  PROXY_COST_LEDGER 账本路径(默认 \$HOME/.multi-proxy-manager/cost-ledger.jsonl)

退出码:
  0  成功,账本里多了一行真实用量
  1  环境不满足(没装 Node / 没有可用上游 / 参数不认识)
  2  请求成功了但账本没多一行 —— 账本链断了,照实报,不粉饰
EOF
}

# 只停本脚本起的两个进程（按 pid 文件），不碰用户其它服务。
# 放在 need_node 之前：node 坏了也该停得掉。
stop_services() {
  bold "停止 quickstart 启动的进程"
  for n in "$PROXY_LOG" manager; do
    f="$LOG_DIR/$n.pid"
    if [ -f "$f" ]; then
      pid=$(cat "$f" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && ok "${n}（pid ${pid}）已停" || warn "$n 停止失败"
      else
        warn "${n}（pid ${pid:-?}）已不在运行"
      fi
      rm -f "$f"
    else
      warn "$n 无 pid 记录，跳过"
    fi
  done
  exit 0
}

if [ "$#" -gt 1 ]; then
  printf '\033[31m✗ 只接受一个参数，收到 %s 个：%s\033[0m\n\n' "$#" "$*" >&2
  usage >&2
  exit 1
fi

# 现场探测某个端口上有没有进程在听。
# 不用 curl：本机被系统代理劫持时会返回 502 upstream connect failed（看起来像服务死了，
# 实际是代理在应答），所以统一走 TCP 连接判断，与 port_busy 同一实现。
probe_svc() {
  local port="$1" name="$2"
  if port_busy "$port"; then
    ok "${name} http://127.0.0.1:${port} 在跑"
  else
    warn "${name} http://127.0.0.1:${port} 没在跑（端口没人听）"
  fi
}

# --watch：等「你自己的」一笔账进来，而不是脚本自己发的那句 pong。
#
# 冷启结束时屏幕上那笔账是脚本发的，它只证明「链路通」。陌生人接上自己的工具之后，
# 到底有没有真的经过代理、有没有记上——原本只能自己去翻 jsonl 或者开面板猜。
# 这段把「有没有记上」变成一个当场能看见的判定：等到就报；等不到就按最常见的三个
# 原因逐条报，而不是让人干等。
watch_ledger() {
  local before after waited=0 limit="${MP_QS_WATCH_SECONDS:-180}" new
  before=$([ -f "$LEDGER" ] && wc -l <"$LEDGER" | tr -d ' ' || echo 0)
  bold "等你自己的第一笔账"
  say "现在去另一个窗口用你的工具干一次活（Claude Code / Codex CLI / 任何 OpenAI 兼容客户端都行）。"
  say "我在盯：$LEDGER"
  dim "  最多等 ${limit}s，Ctrl-C 随时退出。"
  printf '\n'
  while [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
    [ -f "$LEDGER" ] || continue
    after=$(wc -l <"$LEDGER" | tr -d ' ')
    if [ "$after" -gt "$before" ]; then
      new=$((after - before))
      printf '\n'
      ok "第 ${waited}s 等到了 —— 账本 +${new} 行"
      printf '\n'
      tail -n "$new" "$LEDGER" | node -e '
        let s="";
        process.stdin.on("data",d=>s+=d).on("end",()=>{
          for (const l of s.split("\n")) {
            if (!l.trim()) continue;
            let j; try { j = JSON.parse(l); } catch { continue; }
            const t = Number(j.prompt||0) + Number(j.completion||0);
            const cost = (j.cost===0||j.cost) ? `¥${j.cost}` : "¥?";
            process.stdout.write(`    ${j.agent||j.proxy||"?"} · ${j.model||"?"} · ${t} tokens · ${cost} · ${j.latencyMs??"?"}ms\n`);
          }
        });
      ' 2>/dev/null || tail -n "$new" "$LEDGER"
      printf '\n'
      dim "  面板里同一笔：http://127.0.0.1:${MANAGER_PORT}"
      exit 0
    fi
    [ $((waited % 20)) -eq 0 ] && dim "  …${waited}s，还没有新账"
  done
  printf '\n'
  warn "${limit}s 内没有新账进来。先看这一行——它是现场实测，不是配置推测："
  probe_svc "$MANAGER_PORT" manager
  probe_svc "$PROXY_PORT" "$PROXY_LABEL"
  printf '\n'
  say "按这个顺序查（从最常见开始）："
  # 第一条永远是「工具根本没走代理」：它不是配置写错，而是多数客户端压根不读那个环境变量。
  say "1. 工具可能没走代理。Codex CLI 读 ~/.codex/config.toml（不认 OPENAI_BASE_URL）；"
  say "   Claude Code 要 ANTHROPIC_BASE_URL；其它 OpenAI 兼容工具才认 OPENAI_BASE_URL。"
  say "2. 端口对不上。上面「在跑」的那两个端口，和你工具里填的是不是同一个？"
  say "   （换过端口的话，--watch 也要带同一组变量，否则它盯的是默认 18790/18792）"
  say "3. 请求到了但没报账。看代理日志：$LOG_DIR/$PROXY_LOG.log，搜 reportUsage。"
  printf '\n'
  dim "  只想看链路通不通、不涉及你自己的工具：bash scripts/verify-lanes.sh"
  exit 1
}


case "${1:-}" in
  ""|--start) ;;
  -h|--help)  usage; exit 0 ;;
  --stop)     stop_services ;;
  --watch)    watch_ledger ;;
  *)
    printf '\033[31m✗ 不认识的参数：%s\033[0m\n\n' "$1" >&2
    usage >&2
    exit 1
    ;;
esac

# ---------- 主流程 ----------

bold "multi-proxy · 60 秒冷启"
dim "仓库：$ROOT"
dim "数据：$DATA_DIR"

need_node
# 必须检查 mkdir 结果：失败时若不报错，后面会以「日志目录不存在」「manager 启动失败」
# 这种完全不相干的形态炸出来（本机实测过：HOME 指向不可写路径时正是如此）。
mkdir -p "$DATA_DIR" "$LOG_DIR" || die "无法创建数据目录：${DATA_DIR}（检查 HOME 是否可写）"
[ -w "$DATA_DIR" ] || die "数据目录不可写：$DATA_DIR"


# 端口预检 —— 已被占用不等于失败：若已在跑同一个 manager，就复用
step 1 "检查端口"
REUSE_MANAGER=0
REUSE_CODEX=0
if port_busy "$MANAGER_PORT"; then
  if curl -fsS --noproxy '*' -m 2 "http://127.0.0.1:$MANAGER_PORT/health" >/dev/null 2>&1; then
    ok "manager 已在 $MANAGER_PORT 运行，复用"
    REUSE_MANAGER=1
    # 2026-11-08：复用的实例写的是**它启动时**那份数据目录，不一定等于本次的 ${DATA_DIR}。
    # 不提前说清，等下账本不长就会把人引去做一堆没用的排查（本轮实测踩到）。
    warn "复用的是已在运行的实例：它只往自己那份数据目录写账，未必是上面这行「数据：」"
  else
    die "$MANAGER_PORT 被其它进程占用。换端口：MP_QS_MANAGER_PORT=18892 bash scripts/quickstart.sh"
  fi
else
  ok "$MANAGER_PORT 空闲"
fi
if port_busy "$PROXY_PORT"; then
  if curl -fsS --noproxy '*' -m 2 "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    ok "${PROXY_LABEL} 已在 $PROXY_PORT 运行，复用"
    REUSE_CODEX=1
  else
    die "$PROXY_PORT 被其它进程占用。换端口：MP_QS_CODEX_PORT=18890（claude 用 MP_QS_CLAUDE_PORT）bash scripts/quickstart.sh"
  fi
else
  ok "$PROXY_PORT 空闲"
fi
lap "端口检查"
ensure_deps_all
lap "依赖安装"
# 探测上游
step 2 "探测可用上游（零 key 优先）"
UPSTREAM_BASE=""; MODEL=""; MODELS_JSON=""; UPSTREAM_LABEL=""; UPSTREAM_ID=""; UPSTREAM_KEY=""

try_order() {
  case "$1" in
    kilo)
      local p
      if p=$(probe_kilo); then
        UPSTREAM_BASE=$(printf '%s\n' "$p" | sed -n 1p)
        MODEL=$(printf '%s\n' "$p" | sed -n 2p)
        MODELS_JSON=$(printf '%s\n' "$p" | sed -n 3p)
        UPSTREAM_LABEL="Kilo 匿名免费池（免账号·免 key）"
        UPSTREAM_ID="kilo"; UPSTREAM_KEY=""
        return 0
      fi ;;
    ollama)
      local p
      if p=$(probe_ollama); then
        UPSTREAM_BASE=$(printf '%s\n' "$p" | sed -n 1p)
        MODEL=$(printf '%s\n' "$p" | sed -n 2p)
        MODELS_JSON=$(printf '%s\n' "$p" | sed -n 3p)
        UPSTREAM_LABEL="本机 Ollama（本地推理·成本 0）"
        UPSTREAM_ID="ollama"; UPSTREAM_KEY="ollama"
        return 0
      fi ;;
  esac
  return 1
}

if [ -n "$UPSTREAM_PREF" ]; then
  ORDER="$UPSTREAM_PREF"
else
  ORDER="kilo ollama"
fi

for cand in $ORDER; do
  if try_order "$cand"; then break; fi
  warn "$cand 不可用，换下一个"
done

if [ -z "$MODEL" ]; then
  # 不做假通过：没有可用上游就明确告诉用户要做什么
  cat <<'EOF'

  未找到任何零配置上游（Kilo 免费池不可达，本机也没有 Ollama）。

  再给它一个上游，任选其一：
    ① 装 Ollama 后重跑：  https://ollama.com     （本地推理，数据不出本机）
    ② 先填一个 key 再重跑：编辑 $PROXY_DIR/.env 里的 DEEPSEEK_API_KEY / MOONSHOT_API_KEY / AGNES_API_KEY
       然后：MP_QS_UPSTREAM=env bash scripts/quickstart.sh

EOF
  exit 1
fi

ok "上游：$UPSTREAM_LABEL"
ok "模型：$MODEL"
if [ "$UPSTREAM_ID" = "kilo" ]; then
  dim "  （首个请求会发往第三方免费池，可能被用于服务改进；本脚本只发一句 'pong'，不含你的任何内容）"
fi

upsert_provider "$PROVIDERS_FILE" "$UPSTREAM_LABEL" "$UPSTREAM_ID" "$UPSTREAM_BASE" "$UPSTREAM_KEY" "$MODELS_JSON"
ok "已写入上游配置：$PROVIDERS_FILE"

# 起 manager
step 3 "启动 manager（账本落盘方）"
if [ "$REUSE_MANAGER" = "1" ]; then
  ok "复用已在运行的实例"
else
  MPID=$(start_svc "$ROOT/multi-proxy-manager" server.js manager PORT="$MANAGER_PORT")
  echo "$MPID" >"$LOG_DIR/manager.pid"
  wait_http "http://127.0.0.1:$MANAGER_PORT/health" 80 \
    || die "manager 启动失败（15s 无响应）。日志：$LOG_DIR/manager.log"
  ok "manager 就绪 http://127.0.0.1:${MANAGER_PORT}（pid ${MPID}）"
fi

# 机器凭据：manager 首启会 mint 到 agent-token；代理靠它上报 usage
AGENT_TOKEN=""
[ -f "$DATA_DIR/agent-token" ] && AGENT_TOKEN=$(cat "$DATA_DIR/agent-token" 2>/dev/null || true)

# 起代理（codex-proxy 或 claude-proxy，由 MP_QS_CLIENT 决定）
step 4 "启动 ${PROXY_LABEL}（转发 + 取真实 usage）"
if [ "$REUSE_CODEX" = "1" ]; then
  ok "复用已在运行的实例"
else
  CPID=$(start_svc "$ROOT/$PROXY_DIR" proxy.js "$PROXY_LOG" PORT="$PROXY_PORT" \
    MANAGER_URL="http://127.0.0.1:$MANAGER_PORT" \
    MANAGER_AGENT_TOKEN="$AGENT_TOKEN")
  echo "$CPID" >"$LOG_DIR/$PROXY_LOG.pid"
  wait_http "http://127.0.0.1:$PROXY_PORT/health" 80 \
    || die "$PROXY_LABEL 启动失败（15s 无响应）。日志：$LOG_DIR/$PROXY_LOG.log"
  ok "$PROXY_LABEL 就绪 http://127.0.0.1:${PROXY_PORT}（pid ${CPID}）"
fi

# 发一条真请求 + 校对账本真的多了一行
step 5 "发一条真请求，核对账本"

LINES_BEFORE=0
[ -f "$LEDGER" ] && LINES_BEFORE=$(wc -l <"$LEDGER" | tr -d ' ')

# 两种 wire 的发/收都不同：OpenAI 走 /v1/chat/completions，Anthropic 走 /v1/messages
# （请求体字段相同，max_tokens 是 Anthropic 的必填项，正好也给了）。
case "$WIRE" in
  anthropic) REQ_URL="http://127.0.0.1:$PROXY_PORT/v1/messages" ;;
  *)         REQ_URL="http://127.0.0.1:$PROXY_PORT/v1/chat/completions" ;;
esac

REQ_BODY=$(node -e '
  const model = process.argv[1], prompt = process.argv[2];
  // max_tokens 给 512，不能给 32：qwen3 这类思考模型会先花 30-40 token 在
  // 内部推理上，32 的预算被思考吃光，content 直接是空串——实测 qwen3:4b
  // 在 32 时返回 content:""（completion_tokens 32 全在 reasoning），
  // 512 时正常返回 "pong"（用 44 token）。这不是上游坏了，是预算给小了。
  process.stdout.write(JSON.stringify({ model, messages:[{role:"user",content:prompt}], max_tokens: 512 }));
' "$MODEL" "$MODEL_PROMPT")

RESP=$(curl -sS --noproxy '*' -m 90 -X POST "$REQ_URL" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' -d "$REQ_BODY" 2>&1) \
  || die "请求 $PROXY_LABEL 失败：$RESP"

PARSED=$(printf '%s' "$RESP" | node -e '
  const wire = process.argv[1];
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let j; try { j=JSON.parse(s); } catch(e) { process.stdout.write("ERR\t上游返回非 JSON："+s.slice(0,200)); return; }
    if(j.error){ const m=(j.error.message||JSON.stringify(j.error)); process.stdout.write("ERR\t"+m.slice(0,200)); return; }
    const u=j.usage||{};
    if(wire==="anthropic"){
      // Anthropic wire：正文在 content[] 里按 type 分块，思考块也可能存在；
      // usage 只有 input/output（没有 total），要自己加。
      const blocks=Array.isArray(j.content)?j.content:[];
      const txt=blocks.filter(b=>b&&b.type==="text").map(b=>String(b.text||"")).join(" ").trim();
      const thk=blocks.filter(b=>b&&/thinking|reasoning/.test(String(b.type)))
                     .map(b=>String(b.thinking||b.text||"")).join(" ").trim();
      const shown=txt||thk, kind=txt?"content":(thk?"reasoning":"empty");
      const tin=u.input_tokens, tout=u.output_tokens;
      const tot=(typeof tin==="number"&&typeof tout==="number")?(tin+tout):(u.total_tokens??"?");
      process.stdout.write(["OK",shown.replace(/\s+/g," ").slice(0,80),
        tin??"?", tout??"?", tot, kind].join("\t"));
      return;
    }
    const c=j.choices&&j.choices[0], m=(c&&c.message)||{};
    // 三个字段名都要认：OpenAI 风格 content、DeepSeek 风格 reasoning_content、
    // Ollama 的 OpenAI 兼容层用 reasoning（实测 qwen3 只填这个）。
    const content=String(m.content||"").trim();
    const reasoning=String(m.reasoning_content||m.reasoning||"").trim();
    const text=content||reasoning;
    const kind=content?"content":(reasoning?"reasoning":"empty");
    process.stdout.write(["OK",text.replace(/\s+/g," ").slice(0,80),
      u.prompt_tokens??"?", u.completion_tokens??"?", u.total_tokens??"?", kind].join("\t"));
  });
' "$WIRE" 2>/dev/null)

STATUS=$(printf '%s' "$PARSED" | cut -f1)
if [ "$STATUS" != "OK" ]; then
  die "上游请求失败：$(printf '%s' "$PARSED" | cut -f2-)
  排查：tail -30 $LOG_DIR/$PROXY_LOG.log"
fi

REPLY=$(printf '%s' "$PARSED" | cut -f2)
P_TOK=$(printf '%s' "$PARSED" | cut -f3)
C_TOK=$(printf '%s' "$PARSED" | cut -f4)
T_TOK=$(printf '%s' "$PARSED" | cut -f5)
KIND=$(printf '%s' "$PARSED" | cut -f6)
# 三种情况说三种话。绝不把一个空的 content 打印成「上游回复：「」」——
# 那看起来像坏了，实际是思考模型把预算花在内部推理上（上游确实回了 token）。
case "$KIND" in
  content)   ok "上游回复：「${REPLY}」" ;;
  reasoning) ok "上游有响应（思考模型：这是它的内部推理片段）：「${REPLY}…」"
             say "  content 为空是这类模型的特点，不影响记账——账本记的是上游报的真实 token。" ;;
  *)         ok "上游有响应，但 content 为空（仍按上游 usage 记账）" ;;
esac
ok "本次真实用量：输入 $P_TOK · 输出 $C_TOK · 合计 $T_TOK tokens"

# 等账本落行（append 在响应之后，给 3s 宽限）
LINES_AFTER=$LINES_BEFORE
i=0
while [ "$i" -lt 12 ]; do
  [ -f "$LEDGER" ] && LINES_AFTER=$(wc -l <"$LEDGER" | tr -d ' ')
  [ "$LINES_AFTER" -gt "$LINES_BEFORE" ] && break
  sleep 0.25; i=$((i + 1))
done

if [ "$LINES_AFTER" -le "$LINES_BEFORE" ]; then
  printf '\n\033[31m✗ 请求成功了，但账本没多一行 —— 账本链断在「代理→manager」这一段。\033[0m\n' >&2
  printf '  这不是「没花钱」，是「没记上」。按顺序查：\n' >&2
  n=1
  if [ "$REUSE_MANAGER" = "1" ]; then
    # 先排最常见也最容易冤枉人的那个原因：复用的是别人的实例，账落在它自己的目录里。
    printf '  %s) 你复用了已在运行的 manager（见上面那行「复用」）—— 账很可能落在**它**的数据目录，\n' "$n" >&2
    printf '     而不是这次的 %s。验证：换一对干净端口重跑\n' "$DATA_DIR" >&2
    printf '     MP_QS_MANAGER_PORT=18892 MP_QS_CODEX_PORT=18890 bash scripts/quickstart.sh\n' >&2
    n=$((n + 1))
  fi
  printf '  %s) 看代理有没有报错：tail -30 %s/%s.log   # reportUsage\n' "$n" "$LOG_DIR" "$PROXY_LOG" >&2
  printf '  %s) 再看 manager：   tail -20 %s/manager.log\n' "$((n + 1))" "$LOG_DIR" >&2
  printf '  账本文件：%s\n' "$LEDGER" >&2
  exit 2
fi

LAST=$(tail -1 "$LEDGER")
node -e '
  const rec = JSON.parse(process.argv[1]);
  const t = new Date(rec.ts);
  const hh = String(t.getHours()).padStart(2,"0"), mm = String(t.getMinutes()).padStart(2,"0"), ss = String(t.getSeconds()).padStart(2,"0");
  const pad = (s,n) => String(s ?? "?").padEnd(n);
  console.log("");
  console.log("  ┌─ 第一笔真实账单 ────────────────────────────────");
  console.log("  │ 时间    " + hh + ":" + mm + ":" + ss);
  console.log("  │ 代理    " + pad(rec.proxy, 14) + "  模型  " + (rec.model || "?"));
  console.log("  │ 用量    输入 " + pad(rec.prompt, 6) + " 输出 " + pad(rec.completion, 6) + " 缓存命中 " + (rec.cacheHit || 0));
  console.log("  │ 计费    " + (rec.cost ? ("¥" + rec.cost) : "¥0（免费额度，数字来自上游真实 usage）"));
  console.log("  │ 耗时    " + (rec.latencyMs ? (rec.latencyMs + "ms") : "?"));
  console.log("  └────────────────────────────────────────────────");
' "$LAST"

printf '\n'
lap "探测上游+起服务+请求"
ELAPSED=$(elapsed)
bold "冷启完成，用时 ${ELAPSED}s"
if [ -n "$LAP_LOG" ]; then
  dim "  这几段各花了多少（总时长是会变的观测值，分段才看得出慢在哪）："
  printf '%s' "$LAP_LOG"
  dim "  「依赖安装」那段是你自己的网络（只在首次发生）；其余三段是本程序的全部耗时。"
fi
cat <<EOF

  下一步：
    · 面板       http://127.0.0.1:$MANAGER_PORT   （本机直接进，不弹设密码）
    · 账本       $LEDGER
    · 按需加装   bash install.sh                  （交互式向导，想用哪个装哪个，互不依赖）
    · 停掉本次   bash scripts/quickstart.sh --stop

EOF

# 冷启的终点不该是「你看到了一笔脚本自己发的 pong」。
# 陌生人真正要的是「我自己的工具开始记账」，所以把那一行直接印出来、填好本次的端口。
# 端口用变量而不是写死默认值：上面可能用了 MP_QS_* 换端口，印错等于把人引到别处。
printf '  \033[1m把你的工具接上\033[0m（复制进当前 shell，然后再让它干一次活）：\n\n'
case "$CLIENT" in
  claude)
    printf '    export ANTHROPIC_BASE_URL=http://127.0.0.1:%s\n' "$PROXY_PORT"
    printf '    export ANTHROPIC_MODEL=%s\n' "$MODEL"
    ;;
  *)
    # Codex CLI 不认 OPENAI_BASE_URL（它读 ~/.codex/config.toml），所以这里不能只印
    # 环境变量就算完——那会让最主力的客户端用户照着做、然后发现根本没走代理。
    printf '    export OPENAI_BASE_URL=http://127.0.0.1:%s/v1\n' "$PROXY_PORT"
    dim "      ↑ 给 OpenAI SDK / Aider / Cline 这类认环境变量的工具"
    dim "      Codex CLI 不认它：改 ~/.codex/config.toml 里 model_providers 的 base_url（README「接上你的工具」有现成片段）"
    ;;
esac
printf '\n'
dim "  接上之后再发一次真请求，账本里就会多出你自己的一笔——不再是脚本那句 pong。"
dim "  不确定有没有记上？另开一个窗口跑这句，它会盯着账本等你那一笔："
printf '    bash scripts/quickstart.sh --watch\n'
dim "  （最多等 180 秒；等不到会按最常见的三个原因逐条报，不是干等）"
dim "  想换成统一入口（一个地址接所有工具）见 README「接上你的工具」一节。"
printf '\n'

cat <<EOF

  这 ${ELAPSED}s 里真正发生的事（不是演示数据）：
    你的请求 → $PROXY_LABEL 转发到上游 → 上游返回 usage → 上报 manager → 落进上面这个 jsonl

EOF
