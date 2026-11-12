#!/usr/bin/env bats

# BATS tests for README.md 的**结构**。
# Run with: bats tests/shell/readme-structure.test.bats
#
# 与 readme.test.bats 的分工（别合并）：
#   readme.test.bats     钉**事实**：引用的路径/脚本/参数存不存在、示例输出与脚本是否一致。
#   readme-structure.bats 钉**结构**：陌生人前 90 秒要看到的三件事在不在位。
#
# 为什么要给结构写守卫（2026-11-12）：
#   README 曾经 606 行、15 个二级标题、前 200 行零图零对比。每一句都是真的，
#   但一个没耐心的人在第 3 屏就走了——他走的时候不会告诉你「你没画图」，
#   只会觉得「这项目看不懂」。可读性不是文笔问题，是结构问题，
#   而结构问题不写守卫就会在下次改文案时悄悄退化（删图最快、加免责声明最顺手）。
#
# 判据来自 docs/12-docs/DOCS-METHODOLOGY.md（四个真实仓库抽象出来的 R1–R8）。
# 守卫与文档必须成对改：**结构真退化时改文档，不许改守卫迁就**。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  README="$ROOT/README.md"
  METHOD="$ROOT/docs/12-docs/DOCS-METHODOLOGY.md"
}

# 取某个二级标题下的正文（到下一个 ## 为止）
section_body() {
  awk -v h="## $1" '
    $0 == h { on = 1; next }
    on && /^## / { exit }
    on { print }
  ' "$README"
}

@test "methodology doc exists and README links to it" {
  [ -f "$METHOD" ] || {
    echo "缺 docs/12-docs/DOCS-METHODOLOGY.md：结构判据没有真源，守卫就成了个人偏好" >&2
    return 1
  }
  run grep -qF 'docs/12-docs/DOCS-METHODOLOGY.md' "$README"
  [ "$status" -eq 0 ] || {
    echo "README 没有指向方法论文档：写了方法论却没人被指过去，等于没写" >&2
    return 1
  }
}

@test "architecture section exists, is non-empty, and contains a mermaid diagram" {
  local body
  body="$(section_body '30 秒看懂它')"
  [ -n "$body" ] || {
    echo "缺「## 30 秒看懂它」章节：读者建立不了拓扑心智模型" >&2
    return 1
  }
  local lines
  lines="$(printf '%s\n' "$body" | grep -cE '.')"
  [ "$lines" -ge 8 ] || {
    echo "「30 秒看懂它」只有 $lines 行有效内容，像是被掏空了" >&2
    return 1
  }
  printf '%s\n' "$body" | grep -qE '^```mermaid' || {
    echo "该章节没有 mermaid 图：文字描述的拓扑要读者自己搭一次，图是共用的那一次" >&2
    return 1
  }
  # 图得有边，不是只有几个孤立方块
  local edges
  edges="$(printf '%s\n' "$body" | grep -cE '\-\->|\-\.')"
  [ "$edges" -ge 6 ] || {
    echo "mermaid 图只有 $edges 条连线，疑似退化成了一堆孤立节点" >&2
    return 1
  }
}

@test "architecture diagram appears within the first 200 lines" {
  local ln
  ln="$(grep -n '^```mermaid' "$README" | head -1 | cut -d: -f1)"
  [ -n "$ln" ] || {
    echo "README 里找不到 mermaid 图" >&2
    return 1
  }
  [ "$ln" -le 200 ] || {
    echo "第一张图在第 $ln 行：超过 200 行，急着判断的人已经走了" >&2
    return 1
  }
}

@test "comparison section exists with at least 4 competitors and a 'when not to use me' stance" {
  local body
  body="$(section_body '它和别的东西什么关系')"
  [ -n "$body" ] || {
    echo "缺「## 它和别的东西什么关系」：不写差异，读者的默认假设是「你没有差异」" >&2
    return 1
  }
  local urls n
  urls="$(printf '%s\n' "$body" | grep -oE 'https://[^) ]+' | sort -u)"
  n="$(printf '%s\n' "$urls" | grep -c . || true)"
  [ "$n" -ge 4 ] || {
    echo "对比表只链到 $n 个外部项目（要求 ≥4）：对比对象不足等于没对比" >&2
    return 1
  }
  # 必须有「什么时候该用它」这类反向边界，不能只吹自己
  printf '%s\n' "$body" | grep -qE '什么时候该用它|什么时候别用我' || {
    echo "对比表没有「什么时候该用它 / 别用我」这一列：只讲自己强，读者反而不信" >&2
    return 1
  }
  # 表格本身得在
  printf '%s\n' "$body" | grep -qE '^\|[-\| ]+\|$' || {
    echo "该章节没有表格分隔行，疑似被改成散文了" >&2
    return 1
  }
}

@test "every competitor linked in README has a source row in the methodology doc" {
  # 这条是防编造的：对比表里出现的对象，必须在方法论 §5 留过出处与抓取日期。
  # 顺序反了（先写 README 再想来源）就容易写出「听说它支持 XX」。
  local body url bad=0
  body="$(section_body '它和别的东西什么关系')"
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    case "$url" in
      https://*) ;;
      *) continue ;;
    esac
    grep -qF -- "$url" "$METHOD" || {
      echo "README 对比了 $url，但 DOCS-METHODOLOGY.md §5 没有它的出处行" >&2
      bad=1
    }
  done < <(printf '%s\n' "$body" | grep -oE 'https://[^) ]+' | sort -u)
  [ "$bad" -eq 0 ] || return 1
}

@test "top-of-file navigation points at the sections it claims" {
  run grep -qF '[30 秒看懂它](#30-秒看懂它)' "$README"
  [ "$status" -eq 0 ] || {
    echo "顶部没有「跳着看」导航：600 行的文档不给入口，等于要求读者从头读到尾" >&2
    return 1
  }
  # 导航里的锚点必须对应真实存在的标题，否则点了跳不动
  run grep -qE '^## 30 秒看懂它$' "$README"
  [ "$status" -eq 0 ] || {
    echo "导航指向 #30-秒看懂它，但没有对应的「## 30 秒看懂它」标题" >&2
    return 1
  }
  run grep -qE '^## 它和别的东西什么关系$' "$README"
  [ "$status" -eq 0 ] || {
    echo "导航里的对比章节锚点没有对应标题" >&2
    return 1
  }
}

@test "the limits section survives (it is the point, not a nice-to-have)" {
  # 为了「好读」而删掉「现在还没做的」，是把诚实换成了好看——比不画图更糟。
  local body
  body="$(section_body '现在还没做的')"
  [ -n "$body" ] || {
    echo "「## 现在还没做的」不见了：边界章节被删，说明这次改稿在挑好看的说" >&2
    return 1
  }
  local items
  items="$(printf '%s\n' "$body" | grep -cE '^[0-9]+\. ')"
  [ "$items" -ge 3 ] || {
    echo "「现在还没做的」只剩 $items 条：已知缺口被悄悄删短了" >&2
    return 1
  }
}
