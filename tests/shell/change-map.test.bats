#!/usr/bin/env bats

# BATS tests for docs/CHANGE-MAP.md —— 「我想改 X 该动哪几个文件」那张表本身
# Run with: bats tests/shell/change-map.test.bats
#
# 为什么给一张文档写守卫：
#   这仓已经有一份 docs/00-codebase-map.md，201 行，写得很认真，但它是「拍照」——
#   每提交一次就旧一点，作者只能不断加「本轮未复核」的免责声明。老板的原话是
#   「想改都不知道应该让 ai 改什么」，缺的就是这张接线图。
#   接线图不能是拍照：路径会变、守卫会加。所以它必须自带失效检测——
#   文件没了、守卫没登记，都要当场变红，而不是等半年后有人踩空。

MAP=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MAP="$PROJECT_ROOT/docs/CHANGE-MAP.md"
}

@test "change map exists" {
  [ -f "$MAP" ]
}

@test "every path named in the map still exists" {
  # 从反引号片段里挑出「像相对路径」的 token：含 / 且不含空格/占位符/URI/波浪号。
  # 占位符（<代理>、<页>）跳过——它们本来就故意不存在。
  local tok missing=""
  while IFS= read -r tok; do
    case "$tok" in
      ""|*"<"*|*">"*|*" "*|*"~"*|*":"*|*"*"*|*"http"*) continue ;;
    esac
    case "$tok" in
      */*) ;;
      *) continue ;;
    esac
    [ -e "$PROJECT_ROOT/$tok" ] || missing="$missing $tok"
  done < <(grep -oE '`[^`]+`' "$MAP" | tr -d '`' | sort -u)

  [ -z "$missing" ] || {
    echo "地图里这些路径已经不存在了（文件被删/改名，地图没跟上）：$missing" >&2
    return 1
  }
}

@test "every shell guard under tests/shell is registered in the map" {
  # 反向检查：新增一条守卫却不写进地图 → 红。
  # 否则半年后又是「一堆测试，但没人知道它们各自守的是什么」。
  local f b missing=""
  for f in "$PROJECT_ROOT"/tests/shell/*.bats; do
    b="$(basename "$f")"
    grep -qF "$b" "$MAP" || missing="$missing $b"
  done
  [ -z "$missing" ] || {
    echo "这些守卫没登记到 docs/CHANGE-MAP.md：$missing" >&2
    return 1
  }
}

@test "every port table entry in the map points at manage.sh as the source" {
  # 端口只有一个真源（manage.sh 的 SERVICES + *_PORT）。地图里若把端口写成
  # 「改某某代理源码就行」，下一个人就会漏掉另外两处对拍。
  run grep -qF 'manage.sh' "$MAP"
  [ "$status" -eq 0 ]
  run grep -qE '\| 端口 \|' "$MAP"
  [ "$status" -eq 0 ]
}

@test "CONTRIBUTING.md points at the change map (otherwise nobody finds it)" {
  # 一张没人找到的地图等于没有。入口必须是**入库的**文件：
  # AGENTS.md 与 docs/INDEX.md 都在 .gitignore 里（维护者本机才有），
  # 拿它们当入口 = 干净 clone 上这断言直接红。
  local c="$PROJECT_ROOT/CONTRIBUTING.md"
  [ -f "$c" ]
  run grep -qF 'docs/CHANGE-MAP.md' "$c"
  [ "$status" -eq 0 ]
  run git -C "$PROJECT_ROOT" ls-files --error-unmatch CONTRIBUTING.md
  [ "$status" -eq 0 ]
}
