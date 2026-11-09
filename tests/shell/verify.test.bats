#!/usr/bin/env bats

# BATS tests for scripts/verify.sh（II/III 判据的判别器：用户自己验真）
# Run with: bats tests/shell/verify.test.bats
#
# 为什么锁这几条：verify.sh 的立身之本是「用户不信面板，自己看文件」。
# 它最容易在后续改动里退化成一个会撒谎的体检报告：
#   · 为了让输出好看，把「读不到」报成「0 笔」——那就把故障说成正常；
#   · 为了让退出码好看，把「没装」算成「坏了」——用户以为项目有病；
#   · 顺手写个临时文件、发个会花钱的请求——那就不是只读检查了。
# 下面每条钉一个「不许退化」的语义。

VS=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  VS="$PROJECT_ROOT/scripts/verify.sh"
}

@test "verify.sh exists and parses" {
  [ -f "$VS" ]
  run bash -n "$VS"
  [ "$status" -eq 0 ]
}

@test "verify.sh is read-only: no write actions" {
  # 中文口径：脚本只读，不写任何文件（否则「自检」自己会改变被检对象）
  # 去掉注释行后检查。允许 `2>/dev/null` 与 `> /dev/null`（丢弃输出不是写盘）。
  local code
  code="$(grep -vE '^[[:space:]]*#' "$VS")"
  # 追加写
  run bash -c "printf '%s' \"\$1\" | grep -nE '>>' | grep -v '/dev/null'" _ "$code"
  [ "$status" -ne 0 ]
  # 写文件类工具
  run bash -c "printf '%s' \"\$1\" | grep -nE '\\btee\\b|\\brm -|\\bmv \\b|\\bmkdir -p'" _ "$code"
  [ "$status" -ne 0 ]
}

@test "verify.sh never calls external network (local probe only)" {
  # 只允许 127.0.0.1 / localhost 上的 curl。任何外部 URL 都等于「自检顺便联网」，
  # 既违背只读承诺，也让离线用户跑不出结果。
  run grep -nE 'curl[^|]*https?://' "$VS"
  # 若有匹配，必须全部是本地地址
  if [ "$status" -eq 0 ]; then
    echo "$output" | grep -vE '127\.0\.0\.1|localhost' && return 1
  fi
  return 0
}

@test "missing ledger reports 0 entries and exit 0" {
  # 中文口径：新装用户没有账本是正常态，不能算故障
  local fake_home="$BATS_TEST_TMPDIR/empty-home"
  mkdir -p "$fake_home"
  run env HOME="$fake_home" MP_QS_MANAGER_PORT=18898 MP_QS_CODEX_PORT=18897 bash "$VS"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "还没有任何入账"
}

@test "unreadable ledger reports unreadable and exit 1, never 0" {
  local dir_as_ledger="$BATS_TEST_TMPDIR/dir-as-ledger"
  mkdir -p "$dir_as_ledger"
  run env PROXY_COST_LEDGER="$dir_as_ledger" MP_QS_MANAGER_PORT=18898 MP_QS_CODEX_PORT=18897 bash "$VS"
  [ "$status" -eq 1 ]
  # 关键断言：必须出现「读不到」，且不能把这条报成「还没有任何入账」
  echo "$output" | grep -q "账本存在但读不到"
  run bash -c "echo \"\$1\" | grep -q '还没有任何入账'" _ "$output"
  [ "$status" -ne 0 ]
}

@test "runs to completion with all services down (no crash)" {
  local fake_home="$BATS_TEST_TMPDIR/no-svc-home"
  mkdir -p "$fake_home"
  run env HOME="$fake_home" MP_QS_MANAGER_PORT=18898 MP_QS_CODEX_PORT=18897 bash "$VS"
  [ "$status" -eq 0 ]
  # 必须给出「没在跑」的说明，而不是空白
  echo "$output" | grep -q "未在跑"
  # 门控段必须说明跳过原因，不能静默省略
  echo "$output" | grep -q "跳过"
}

@test "optional proxies down are not hard failures" {
  local fake_home="$BATS_TEST_TMPDIR/optional-home"
  mkdir -p "$fake_home"
  run env HOME="$fake_home" MP_QS_MANAGER_PORT=18898 MP_QS_CODEX_PORT=18897 bash "$VS"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "按需安装，不算故障"
}

@test "keeps the wording that zero-hits is not no-effect" {
  # 这两种误读是这一层存在的意义。文案被删掉，等于换个位置又造一个谎。
  grep -q "不等于没生效" "$VS"
  grep -q "也不代表没生效" "$VS"
}

@test "conclusion tells user the data source is self-checkable" {
  local fake_home="$BATS_TEST_TMPDIR/source-home"
  mkdir -p "$fake_home"
  run env HOME="$fake_home" MP_QS_MANAGER_PORT=18898 MP_QS_CODEX_PORT=18897 bash "$VS"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "不需要相信任何界面"
}

@test "braces used next to CJK characters" {
  # 与 quickstart 同款守卫：`$ENTRIES笔` 在 bash 里会被当成变量名 ENTRIES笔。
  run grep -nE '\$[A-Z_]+[一-龥]' "$VS"
  [ "$status" -ne 0 ]
}

# ---- 2026-11-08: 服务清单不许有第二份 ----

@test "service list is derived from manage.sh SERVICES, no second copy" {
  # 中文口径：初版在 verify.sh 里硬编码了 3 个可选代理，漏了 dsh/opencode/
  # generic/unified-ingress —— 用户会以为这个项目只有 5 个服务。
  # N-4 的病根就是「两份清单」，所以这里禁掉第二份的存在。
  run grep -E "OPTIONAL_PROXIES" "$VS"
  [ "$status" -ne 0 ]
  run grep -q 'SERVICES' "$VS"
  [ "$status" -eq 0 ]
  run grep -q 'manage\.sh' "$VS"
  [ "$status" -eq 0 ]
}

@test "every manage.sh service appears in the self-check output" {
  # 中文口径：真源里有几个服务，自检就必须列几行（不多不少）。
  MANAGE_SH="$PROJECT_ROOT/manage.sh"
  expected="$(bash -c 'source "$1" >/dev/null 2>&1; printf "%s\n" $SERVICES' _ "$MANAGE_SH" | grep -c .)"
  [ "$expected" -gt 0 ] || { echo "cannot read SERVICES from manage.sh" >&2; return 1; }
  run bash "$VS"
  got="$(echo "$output" | sed -n '/【2】服务/,/【3】/p' | grep -cE '在跑')"
  [ "$got" -eq "$expected" ] || {
    echo "manage.sh has $expected services, self-check listed $got" >&2
    return 1
  }
}
