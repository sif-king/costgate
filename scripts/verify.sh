#!/usr/bin/env bash
# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.
#
# verify.sh —— 用户侧自检：不信面板，自己验一遍
#
# 为什么要它（对外交付四判据 II/III 的判别器）：
#   判据 II「一眼可见」要求每个能力可自证；判据 III「外部人独立验得过」要求
#   一个陌生人**不必相信我们的界面**就能确认「这台机器上到底在发生什么」。
#   面板是我们自己画的，用户凭什么信？所以必须有第三条路：直接读他机器上的文件。
#
# 设计判据：**服务全停也能跑出有意义的结果**。账本、命中记录都在磁盘上，
#   是比任何界面都硬的事实。manager 挂了只影响「门控当前值」一段，其它照报。
#
# 三条纪律（与本项目门控状态条同源）：
#   ① 只读：不写任何文件、不改任何服务状态、不发起会花钱的请求。
#   ② 「读不到」≠「零笔」。文件不存在报 0 笔（新装正常态）；读失败报「读不到」。
#   ③ 「没装」≠「坏了」。按需安装的代理未运行只打 `-`，不计失败。
#
# 用法：
#   bash scripts/verify.sh
#   MP_QS_CODEX_PORT=18890 MP_QS_MANAGER_PORT=18892 bash scripts/verify.sh   # 非默认端口
#
# 退出码：0 无硬问题 / 1 有硬问题（服务该在不在、账本读不到、门控读不到）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_PORT="${MP_QS_CODEX_PORT:-18790}"
MANAGER_PORT="${MP_QS_MANAGER_PORT:-18792}"
DATA_DIR="$HOME/.multi-proxy-manager"
LEDGER="${PROXY_COST_LEDGER:-$DATA_DIR/cost-ledger.jsonl}"
HITS="${PROXY_SANDBOX_EGRESS_HITS:-$DATA_DIR/sandbox-egress-hits.jsonl}"

# 服务清单与端口一律从 manage.sh 取（单一真源：SERVICES + svc_port）。
# 这里**不写第二份清单**：N-4 的病根就是 start/stop 各自硬编码一份、少一个没人发现。
# verify.sh 初版硬编码了 3 个可选代理，结果漏了 dsh / opencode / generic / unified-ingress
# 四个——用户会以为这个项目只有 5 个服务。现在从真源读，加服务自动跟上。
MANAGE_SH="$ROOT/manage.sh"
svc_port_of() {
  # 子进程里 source：不污染本脚本的变量，也不把 manage.sh 的 set -e 带进来
  bash -c 'source "$1" >/dev/null 2>&1; set +e; svc_port "$2"' _ "$MANAGE_SH" "$1" 2>/dev/null
}

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
nota() { printf '  \033[2m-\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
sec()  { printf '\n\033[1m【%s】%s\033[0m\n' "$1" "$2"; }

HARD_FAILS=0
hard_fail() { HARD_FAILS=$((HARD_FAILS + 1)); bad "$*"; }

# 端口探活（与 quickstart 同款；只 connect 不发请求，零副作用）
port_busy() {
  node -e '
    const net=require("net"), s=net.createConnection({host:"127.0.0.1",port:+process.argv[1]});
    s.setTimeout(400);
    s.on("connect",()=>{s.destroy();process.exit(0)});
    s.on("error",()=>process.exit(1));
    s.on("timeout",()=>{s.destroy();process.exit(1)});
  ' "$1" 2>/dev/null
}

# 家目录缩写，输出里不甩长路径
# 注意：替换串里写 `~` 本身即可，写成 `\~` 会把反斜杠留在输出里（踩过）。
tilde() { printf '%s' "${1/#$HOME/~}"; }

printf '\033[1mmulti-proxy 自检\033[0m · %s\n' "$(date '+%Y-%m-%d %H:%M')"
dim "只读检查：不写文件、不改状态、不发会花钱的请求。数字来自你本机的文件与本地接口。"

# ────────────────────────── 1 环境 ──────────────────────────
sec 1 "环境"
if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
else
  hard_fail "未找到 node —— 这个项目跑不起来（需 Node.js 18+）"
fi

if [ -d "$DATA_DIR" ]; then
  ok "数据目录 $(tilde "$DATA_DIR")"
else
  nota "数据目录不存在（$(tilde "$DATA_DIR")）—— 还没跑过任何请求，属正常"
fi

# ────────────────────────── 2 服务 ──────────────────────────
sec 2 "服务"
if port_busy "$MANAGER_PORT"; then
  ok "manager      $MANAGER_PORT  在跑"
  MANAGER_UP=1
else
  warn "manager      $MANAGER_PORT  未在跑 —— 面板打不开；账本不受影响，下面照报"
  MANAGER_UP=0
fi

if port_busy "$CODEX_PORT"; then
  ok "codex-proxy  $CODEX_PORT  在跑（出网转发与取 usage 的那一跳）"
  CODEX_UP=1
else
  # 这是账本链的上游，没它就不会有新账 —— 但用户可能只是没启动，不算"坏"
  warn "codex-proxy  $CODEX_PORT  未在跑 —— 不会有新的账落下来"
  CODEX_UP=0
fi

ALL_SVC="$(bash -c 'source "$1" >/dev/null 2>&1; set +e; printf "%s\n" $SERVICES' _ "$MANAGE_SH" 2>/dev/null)"
if [ -z "$ALL_SVC" ]; then
  # 读不到就说读不到：不列出 ≠ 没有别的服务
  warn "读不到 $MANAGE_SH 里的服务清单 —— 下面只列了 manager 与 codex-proxy"
fi
for entry in $ALL_SVC; do
  case "$entry" in manager|codex) continue ;; esac   # 上面两条已单列
  port="$(svc_port_of "$entry")"
  [ -n "$port" ] || continue
  # 显示名：manage.sh 用短名（hermes/claude），这里补成 -proxy 便于对上面板
  case "$entry" in
    unified-ingress) label="unified-ingress" ;;
    *)               label="$entry-proxy" ;;
  esac
  if port_busy "$port"; then
    ok "$(printf '%-16s %s  在跑' "$label" "$port")"
  elif [ "$entry" = "unified-ingress" ]; then
    nota "$(printf '%-16s %s  未在跑（可选：多代理共用同一出口时才需要）' "$label" "$port")"
  else
    nota "$(printf '%-16s %s  未在跑（按需安装，不算故障）' "$label" "$port")"
  fi
done

# ────────────────────────── 3 账本 ──────────────────────────
sec 3 "账本 —— 最硬的证据"
LEDGER_STATE=$(node -e '
  const fs=require("fs");
  const f=process.argv[1];
  let out={exists:false,entries:0,lastAt:null,error:null};
  try{
    const st=fs.statSync(f);
    out.exists=true;
    const text=fs.readFileSync(f,"utf8");
    let n=0,last="";
    for(const line of text.split("\n")){const s=line.trim();if(s){n++;last=s;}}
    out.entries=n;
    try{const r=JSON.parse(last);if(r&&typeof r.ts==="string")out.lastAt=r.ts;}catch{}
  }catch(e){
    if(e.code!=="ENOENT")out.error=e.message||"读取失败";
  }
  process.stdout.write(JSON.stringify(out));
' "$LEDGER" 2>/dev/null)

if [ -z "$LEDGER_STATE" ]; then
  hard_fail "账本状态读不出来（node 执行失败）"
elif printf '%s' "$LEDGER_STATE" | grep -q '"error":"'; then
  # 读失败与「零笔」必须分开报，否则 IO 故障会被当成「还没用」
  hard_fail "账本存在但读不到：$(printf '%s' "$LEDGER_STATE" | sed -E 's/.*"error":"([^"]*)".*/\1/')"
else
  ENTRIES=$(printf '%s' "$LEDGER_STATE" | sed -E 's/.*"entries":([0-9]+).*/\1/')
  LAST_AT=$(printf '%s' "$LEDGER_STATE" | sed -E 's/.*"lastAt":(null|"[^"]*").*/\1/')
  if [ "$ENTRIES" -gt 0 ]; then
    if [ "$LAST_AT" = "null" ]; then
      ok "已入账 $ENTRIES 笔（最近一笔的时间读不出——最后一行可能正在写）"
    else
      HUMAN=$(printf '%s' "$LAST_AT" | tr -d '"' | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const t=Date.parse(s.trim());
          if(!t){process.stdout.write("时间未知");return;}
          const d=new Date(t),p=n=>String(n).padStart(2,"0");
          process.stdout.write(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
        });')
      ok "已入账 $ENTRIES 笔，最近一笔 $HUMAN"
    fi
    dim "    $(tilde "$LEDGER")"
    printf '    想自己核对：\033[2mtail -3 %s\033[0m\n' "$(tilde "$LEDGER")"
  else
    nota "还没有任何入账（$(tilde "$LEDGER") 为空或不存在）"
    dim "    跑一笔就会有：bash scripts/quickstart.sh"
  fi
fi

# ────────────────────────── 4 门控 ──────────────────────────
sec 4 "门控（能力开关 + 真跑过没有）"
GATES_JSON=""
if [ "$MANAGER_UP" = "1" ]; then
  GATES_JSON=$(curl -fsS --noproxy '*' -m 3 "http://127.0.0.1:$MANAGER_PORT/api/gates" 2>/dev/null || true)
fi

if [ -z "$GATES_JSON" ]; then
  if [ "$MANAGER_UP" = "1" ]; then
    hard_fail "manager 在跑但 /api/gates 没响应 —— 面板状态条此刻也是读不到的"
  else
    nota "manager 没在跑，这一段跳过（这不代表门控有问题，只是问不到）"
  fi
else
  printf '%s' "$GATES_JSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try{ j=JSON.parse(s); }catch(e){ console.log("  ✗ 门控数据解析失败"); process.exit(0); }
      const rows=j.gates||[], sum=j.summary||{};
      const on=rows.filter(r=>r.on===true).length;
      const off=rows.filter(r=>r.on===false).length;
      const unk=rows.filter(r=>r.on===null).length;
      const stock=sum.stock?"（开箱默认态：opt-in 能力全关，是设计不是缺漏）":"";
      console.log(`  ${rows.length} 项：开 ${on} · 关 ${off} · 读不到 ${unk}${stock}`);
      // 中文占 2 列：按显示宽度补空格，否则 padEnd 用字符数会把表格撑得歪到没法看
      const w=s=>[...s].reduce((n,c)=>n+(c.codePointAt(0)>255?2:1),0);
      const pad=(s,n)=>s+" ".repeat(Math.max(0,n-w(s)));
      // 只列「有运行痕迹采集点」的项——这几项能给出可核对的数字，是这份自检的重点
      const withEv=rows.filter(r=>r.evidence&&r.evidence.available);
      if(!withEv.length){
        console.log("  · 没有任何一项带运行痕迹（manager 版本较旧，重启后可见）");
      } else {
        console.log("");
        for(const r of withEv){
          const e=r.evidence;
          const mark = e.unknown ? "!" : (e.hits>0 ? "✓" : "·");
          const num  = e.unknown ? "读不到" : (e.hits>0 ? `${e.hits} ${e.unit||"次"}` : "0 次");
          console.log(`  ${mark} ${pad(r.label,22)} ${pad(num,10)} ${e.detail}`);
        }
        console.log("");
        console.log("  「0 次」= 采到了但还没有数据（刚启用/没人用），不等于没生效。");
        console.log("  「无采集点」= 这一项没有落盘痕迹可查，也不代表没生效。");
      }
    });'
fi

# ────────────────────────── 5 脱敏与巡检 ──────────────────────────
sec 5 "脱敏与巡检记录"
HITS_STATE=$(node -e '
  const fs=require("fs");
  const f=process.argv[1];
  let out={exists:false,total:0,byKind:{},lastAt:null,error:null};
  try{
    fs.statSync(f);
    out.exists=true;
    const text=fs.readFileSync(f,"utf8");
    let n=0,last=0;
    for(const line of text.split("\n")){
      const s=line.trim(); if(!s)continue; n++;
      try{const r=JSON.parse(s);
        if(r&&typeof r.kind==="string")out.byKind[r.kind]=(out.byKind[r.kind]||0)+1;
        if(r&&typeof r.ts==="number"&&r.ts>last)last=r.ts;
      }catch{}
    }
    out.total=n;
    if(last)out.lastAt=new Date(last).toISOString();
  }catch(e){
    if(e.code!=="ENOENT")out.error=e.message||"读取失败";
  }
  process.stdout.write(JSON.stringify(out));
' "$HITS" 2>/dev/null)

if [ -z "$HITS_STATE" ]; then
  warn "脱敏记录状态读不出来（node 执行失败）"
elif printf '%s' "$HITS_STATE" | grep -q '"error":"'; then
  warn "脱敏记录存在但读不到（不影响出网，只是这条证据缺失）"
else
  HITS_TOTAL=$(printf '%s' "$HITS_STATE" | sed -E 's/.*"total":([0-9]+).*/\1/')
  if [ "$HITS_TOTAL" -gt 0 ]; then
    ok "已记录 $HITS_TOTAL 条"
    printf '%s' "$HITS_STATE" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const j=JSON.parse(s);
        for(const k of Object.keys(j.byKind).sort())
          console.log(`    ${k}: ${j.byKind[k]} 条`);
      });'
    dim "    $(tilde "$HITS")"
  else
    nota "尚无命中记录 —— 门控开着，但还没有请求命中敏感模式"
    dim "    「没命中」是常态（大部分请求不含手机号/密钥），不代表脱敏没生效。"
  fi
fi

# ────────────────────────── 结论 ──────────────────────────
printf '\n'
if [ "$HARD_FAILS" -eq 0 ]; then
  bold "结论：没有硬问题。"
  dim "上面每一条都能自己核对（文件路径 / 本地接口），不需要相信任何界面。"
  if [ "${ENTRIES:-0}" -gt 0 ] 2>/dev/null; then
    dim "账本里有 ${ENTRIES} 笔真账 —— 这就是「它真的在工作」的证据。"
  fi
  exit 0
else
  bold "结论：$HARD_FAILS 处硬问题（见 ✗ 项）。"
  dim "「未在跑」和「按需安装」的 - 项不算故障；✗ 才是需要处理的。"
  exit 1
fi
