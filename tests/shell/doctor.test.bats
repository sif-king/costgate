#!/usr/bin/env bats

# BATS tests for scripts/doctor.sh + runtime-probes.json + outward-mutations.json
# Run with: bats tests/shell/doctor.test.bats
#
# 为什么锁这几条（2026-11-09 的坑）：
#   `codex --version` 返回 137 零输出，而所有既有检查全绿——因为没有一条检查
#   真的执行过那个命令。这几条测试保证：
#     · doctor.sh 真的会执行命令（不是查文件存在）
#     · rc=137 会被单独点名（而不是笼统「失败」）
#     · 台账里的回滚必须演练过（留空即 P0），否则「有脚本」被当成「有退路」
#     · doctor.sh 自己保持只读（否则「诊断」会改变被诊断的对象）

DOC=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  DOC="$PROJECT_ROOT/scripts/doctor.sh"
}

@test "doctor.sh exists and parses" {
  [ -f "$DOC" ]
  run bash -n "$DOC"
  [ "$status" -eq 0 ]
}

@test "doctor.sh is read-only: no mutating commands" {
  # 中文口径：诊断脚本不许改被诊断的对象——不写文件、不启停服务、不签不改权限。
  # 去掉注释行再查，避免注释里提到的命令被误判。
  # 注意：这里用管道不用 `run ... <<<`——bats 的 run 对 herestring 的 stdin 传递不可靠，
  # 会让断言变成在空输入上跑，从而恒真（比不写这条还坏）。
  local code hit
  # 先剔除「输出语句」——修法文本里出现 codesign --force 是在教用户怎么做，
  # 不是脚本自己在做。「提到」和「执行」必须分开判（G9 同一个道理）。
  code="$(grep -vE '^[[:space:]]*#' "$DOC" \
        | grep -vE '^[[:space:]]*(printf|fix|say|dim|warn|bad|ok|nota|bold|sec)[[:space:]]')"
  hit="$(printf '%s\n' "$code" | grep -E '(^|[^a-zA-Z])(rm|mv|cp|ln|chmod|chown)[[:space:]]+[^>]' || true)"
  [ -z "$hit" ] || { echo "发现写操作：$hit" >&2; return 1; }
  hit="$(printf '%s\n' "$code" | grep -E 'codesign[[:space:]]+--force' || true)"
  [ -z "$hit" ] || { echo "发现重签：$hit" >&2; return 1; }
  hit="$(printf '%s\n' "$code" | grep -E 'launchctl[[:space:]]+(bootstrap|load|kickstart|bootout)' || true)"
  [ -z "$hit" ] || { echo "发现启停服务：$hit" >&2; return 1; }
}

@test "doctor.sh actually executes the declared command (not just checks existence)" {
  # 中文口径：这条是本次踩坑的直接回归——文档承诺 codex 可用，就必须真跑它。
  # 判据：脚本里必须出现对命令的**执行**（--version 或类似的探活调用），
  # 而不是只有 command -v / test -x 这类存在性检查。
  run grep -qE '"\$name"[[:space:]]+--version|_bin[[:space:]]+--version' "$DOC"
  [ "$status" -eq 0 ]
}

@test "doctor.sh names rc=137 explicitly" {
  # 中文口径：137 是本次那个坑的指纹。只报「失败」等于把最有信息量的线索扔掉，
  # 所以脚本必须显式判 137 并给出「签名可能被吊销」这条最可能的原因。
  # 注意：grep 的「或」必须用 -E；BSD grep 的 BRE 不认 \|，写了恒不成立（踩过）。
  grep -q '137' "$DOC" || { echo "未显式判 137" >&2; return 1; }
  grep -qE 'CSSMERR|吊销' "$DOC" || { echo "未给出签名吊销这条原因" >&2; return 1; }
}

@test "doctor.sh catches a SIGKILLed binary (injection regression)" {
  # 中文口径：守卫自己要有守卫。造一个必然 rc=137 的假 codex 塞进 PATH，
  # doctor 必须以非 0 退出并在输出里点名 137——否则它只是个恒绿的摆设。
  local badbin="$BATS_TEST_TMPDIR/badbin"
  mkdir -p "$badbin"
  printf '#!/bin/sh\nexit 137\n' > "$badbin/codex"
  chmod +x "$badbin/codex"

  run env PATH="$badbin:$PATH" bash "$DOC" --quiet
  [ "$status" -eq 1 ]
  run grep -q '137' <<< "$output"
  [ "$status" -eq 0 ]
}

@test "doctor.sh checks codex sandbox_mode (injection regression)" {
  # 中文口径：sandbox_mode 的「坏值」是**缺省**——文件里根本没有这一行。
  # 缺省不会留痕迹，所以最容易反复踩：模型说「我建不了文件」，看起来像权限故障，
  # 其实是配置没写过。三份假配置各验一次：
  #   ① 没写 → 必须提示按 read-only 处理并给修法
  #   ② 写了 workspace-write 但没开 network_access → 必须警告（沙箱会掐网络）
  #   ③ 显式 read-only → 必须认作「刻意的」，不许报成故障（否则会误导人乱改）
  local fh
  fh="$BATS_TEST_TMPDIR/fh"

  _run_with_cfg() {
    mkdir -p "$fh/.codex"
    printf '%s\n' "$1" > "$fh/.codex/config.toml"
    run env HOME="$fh" bash "$DOC"
  }

  _run_with_cfg '[model_providers.custom]
wire_api = "responses"
base_url = "http://127.0.0.1:18790/v1"'
  echo "$output" | grep -q '没写 sandbox_mode' || { echo "① 未提示缺省 read-only" >&2; return 1; }

  _run_with_cfg 'sandbox_mode = "workspace-write"
[model_providers.custom]
wire_api = "responses"
base_url = "http://127.0.0.1:18790/v1"'
  echo "$output" | grep -q 'network_access' || { echo "② 未警告网络被掐" >&2; return 1; }

  _run_with_cfg 'sandbox_mode = "read-only"
[model_providers.custom]
wire_api = "responses"
base_url = "http://127.0.0.1:18790/v1"'
  echo "$output" | grep -q '刻意的只读' || { echo "③ 未区分刻意只读" >&2; return 1; }
}

@test "runtime-probes.json is valid JSON and declares codex" {
  # 中文口径：声明文件是 G8 的输入。它不是备注，是「要真跑的东西」，
  # 所以必须能解析、且必须真的声明了本次踩坑的那个命令。
  local f="$PROJECT_ROOT/runtime-probes.json"
  [ -f "$f" ]
  run node -e '
    const p=require(process.argv[1]);
    if(!Array.isArray(p)||!p.length) process.exit(1);
    for(const e of p){ if(!e.name&&!e.cmd) process.exit(2); }
    if(!p.some(e=>(e.cmd||e.name)==="codex")) process.exit(3);
  ' "$f"
  [ "$status" -eq 0 ]
}

@test "outward-mutations.json entries all carry detector/rollback/rehearsed" {
  # 中文口径：越界改动必须能回答「失效时谁会喊 / 怎么退回去 / 演练过没有」。
  # rehearsed 留空即视为没演练——那正是 2026-10-11 那个雷的形态。
  local f="$PROJECT_ROOT/outward-mutations.json"
  [ -f "$f" ]
  run node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const rows=Array.isArray(j)?j:(j.entries||[]);
    if(!rows.length) process.exit(1);
    for(const [i,e] of rows.entries()){
      for(const k of ["date","target","what","why","detector","rollback","rehearsed"]){
        if(e[k]===undefined||e[k]===null||e[k]===""){ console.error(`第 ${i+1} 条缺 ${k}`); process.exit(2); }
      }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(String(e.rehearsed))){ console.error(`第 ${i+1} 条 rehearsed 不是日期`); process.exit(3); }
    }
  ' "$f"
  [ "$status" -eq 0 ]
}

@test "rollback script dry-run does not touch the app" {
  # 中文口径：回滚脚本必须先能「只看不动」。--dry-run 之后 app 的签名状态
  # 必须和之前一致——否则预览本身就是一次改动。
  local RB="$PROJECT_ROOT/scripts/rollback-chatgpt-shim.sh"
  [ -f "$RB" ]
  run bash -n "$RB"
  [ "$status" -eq 0 ]

  local before after
  before="$(codesign --verify --deep --strict /Applications/ChatGPT.app 2>&1; echo "rc=$?")"
  run bash "$RB" --dry-run
  after="$(codesign --verify --deep --strict /Applications/ChatGPT.app 2>&1; echo "rc=$?")"
  [ "$before" = "$after" ]
}
