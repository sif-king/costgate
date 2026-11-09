#!/usr/bin/env bats

# BATS tests for scripts/verify-lanes.sh（零 key 冷启自证脚本）
# Run with: bats tests/shell/verify-lanes.test.bats
#
# 为什么锁这几条：这个脚本的全部价值就是「真跑一遍」。它最容易在改动里悄悄变成
# 一份会撒谎的报告：
#   · 拿 OpenAI 的地址去打只有 Anthropic 端点的 lane → 404 → 报「链路坏了」（假红）；
#   · 把临时 HOME 换成真实 HOME → 污染用户的 providers.json / 账本；
#   · 只看「进程起来了」就当通过（那不叫跑通，叫启动成功）；
#   · 中文紧跟变量没加大括号 → bash 把中文当变量名 → set -u 直接崩。
# 下面每条钉一个这类退化。

VL=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  VL="$PROJECT_ROOT/scripts/verify-lanes.sh"
}

@test "verify-lanes.sh exists and parses" {
  [ -f "$VL" ]
  run bash -n "$VL"
  [ "$status" -eq 0 ]
}

@test "claude lane uses the anthropic wire, not chat/completions" {
  # claude-proxy 只有 /v1/messages。用 OpenAI 的地址打它必然 404，
  # 脚本会把它报成「上游请求失败」——假红，且会让人去查一个不存在的 bug。
  run grep -q 'lane_wire()' "$VL"
  [ "$status" -eq 0 ]
  run grep -qE 'claude\)[[:space:]]*echo[[:space:]]+"anthropic"' "$VL"
  [ "$status" -eq 0 ]
  run grep -q '/v1/messages' "$VL"
  [ "$status" -eq 0 ]
  # Anthropic 要求这个头，缺了会 400
  run grep -q 'anthropic-version' "$VL"
  [ "$status" -eq 0 ]
}

@test "every lane gets its own temporary HOME (never the real one)" {
  # 脚本要写 providers.json。写到真实 ~/.multi-proxy-manager 就等于把用户的
  # 上游配置冲掉——而这正是「验一下环境」最不该付的代价。
  run grep -q 'mktemp -d' "$VL"
  [ "$status" -eq 0 ]
  run grep -q 'HOME="\$home"' "$VL"
  [ "$status" -eq 0 ]
  # 不许出现直接对着真实 HOME 写 providers.json 的形态
  run grep -qE '>[[:space:]]*"?\$HOME/\.multi-proxy-manager' "$VL"
  [ "$status" -ne 0 ]
}

@test "passing requires a real upstream reply with usage, not just a live process" {
  # 「进程起来了」和「链路通了」是两件事。只要健康检查通过就算过，
  # 那这个脚本就退化成端口探活，用户拿不到任何可信结论。
  run grep -q '上游回复' "$VL"
  [ "$status" -eq 0 ]
  run grep -q '真实用量' "$VL"
  [ "$status" -eq 0 ]
  # usage 缺失必须判失败，不能当「上游没给」放过
  run grep -q '响应里没有 usage' "$VL"
  [ "$status" -eq 0 ]
}

@test "no unbraced variable directly followed by a CJK character" {
  # 2026-11-08 实测踩到三次：`$lane（端口 $port）` 这种写法，bash 会把「（端口」
  # 当变量名的一部分，set -u 下直接 "unbound variable" 退出——脚本还没开始就死，
  # 报错还指在一个看起来完全正常的行上。
  local hits
  hits="$(node -e '
    const fs=require("fs");
    const src=fs.readFileSync(process.argv[1],"utf8").split("\n");
    let n=0;
    src.forEach((line)=>{
      const re=/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;
      while(re.exec(line)!==null) n++;
    });
    process.stdout.write(String(n));
  ' "$VL")"
  [ "$hits" = "0" ] || { echo "有 $hits 处未加大括号的中文相邻变量" >&2; return 1; }
}

@test "skips are not failures (not installed must not look broken)" {
  # 用户可能只装了两个代理。没装的 lane 要「跳过」而不是「失败」，
  # 否则脚本永远红，用户学会忽略它。
  run grep -q '跳过' "$VL"
  [ "$status" -eq 0 ]
  # 退出码三态：0 全过 / 1 有失败 / 2 一条都没验
  run grep -q 'return 2' "$VL"
  [ "$status" -eq 0 ]
}

@test "cursor lane runs from a copied dist so the real proxy.db is never touched" {
  # cursor 的上游在 SQLite（data/proxy.db）里，路径是相对模块位置算的。
  # 如果直接起仓库里那份，就必然读写用户真实的库——「验一下」不该改你的数据。
  run grep -q 'run_cursor_lane()' "$VL"
  [ "$status" -eq 0 ]
  # 复制 dist 到临时目录 + 软链 node_modules，让 data/ 跟着落到临时目录
  run grep -q 'cp -R "\$dir/dist"' "$VL"
  [ "$status" -eq 0 ]
  run grep -q 'ln -s "\$dir/node_modules"' "$VL"
  [ "$status" -eq 0 ]
  # 临时库用一次性密钥，不动项目根下那把真的 .encryption-key
  run grep -q 'ENCRYPTION_KEY=' "$VL"
  [ "$status" -eq 0 ]
  # 不许出现对真实 cursor 库的直接引用
  run grep -qE 'cursor-proxy/data/proxy\.db' "$VL"
  [ "$status" -ne 0 ]
}

@test "cursor lane sends an empty api_key, not a placeholder" {
  # 2026-11-08 实测：给免鉴权上游填占位串，cursor 会发
  # `Authorization: Bearer placeholder...`，Kilo 回 401 INVALID_TOKEN。
  # 脚本会把它报成「上游请求失败」，把真正的修复方向（不该发这个头）藏起来。
  run grep -qF 'api_key\":\"\"' "$VL"
  [ "$status" -eq 0 ]
  # 兜底：不许再出现占位串写法
  run grep -q 'api_key":"placeholder' "$VL"
  [ "$status" -ne 0 ]
}

@test "codex lane also exercises /v1/responses (that is what Codex CLI actually calls)" {
  # codex-proxy 有两条上游路径：chat/completions（curl 手打、其它工具）和
  # /v1/responses（Codex CLI 自己走这条）。两段的请求改写、鉴权、用量回传是
  # 不同的代码，改一处漏一处不会互相报错——只验前者等于验扇用户不走的门。
  run grep -q '/v1/responses' "$VL"
  [ "$status" -eq 0 ]
  run grep -q 'openai-responses' "$VL"
  [ "$status" -eq 0 ]
  # 解析器要认 Responses 的 output[] 形态，否则「通了」也读不出用量
  run grep -q 'Array.isArray(j.output)' "$VL"
  [ "$status" -eq 0 ]
}

@test "leaves no orphan processes (waits for exit, and a trap cleans up on interrupt)" {
  # 2026-11-08 实测：脚本被中断后，7 个 `node proxy.js` 留在 189xx 端口上一直占内存，
  # 后来跑别的测试直接被压成 exit 137——而屏幕上什么都看不出来。
  # 裸 kill 不够：要等它真退出，Ctrl-C / 超时退出时也要收。
  run grep -q 'trap cleanup_all' "$VL"
  [ "$status" -eq 0 ]
  run grep -q 'release_pid()' "$VL"
  [ "$status" -eq 0 ]

  local added released
  added=$(grep -c 'add_pid "\$pid"' "$VL")
  released=$(grep -c 'release_pid "\$pid"' "$VL")
  # 两条 lane 实现（普通 / cursor）各至少登记一次
  [ "$added" -ge 2 ]
  # 每个登记过的都要有对应释放，别只登记不释放
  [ "$released" -ge "$added" ]

  # 不许再有裸 kill（绕开「等它真退出」这一步）
  run grep -qE '^[[:space:]]*\[ -n "\$pid" \] && kill' "$VL"
  [ "$status" -ne 0 ]
}
