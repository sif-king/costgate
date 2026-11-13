#!/usr/bin/env bats

# BATS tests for scripts/check-doc-tone.js（对外文档句子层门禁）。
# Run with: bats tests/shell/doc-tone.test.bats
#
# 为什么要有这个文件（2026-11-13）：
#   老板两次说文档「AI 味儿重」。第一次我只清标点（破折号、直角引号），
#   第二次才补上句子形状（判断式开头、绝对化词、计数套话）。
#   这两轮都靠人工盯，没有守卫——等于下次改文案还会退回去。
#
# 这里钉的不是「文档写得好不好」（那要靠人读），而是：
#   ① 守卫在真实文档上确实通过；
#   ② 注入一个违规句子，守卫确实变红（防「绿但检查空集」）；
#   ③ 趋势项（D7）确实不判红——这是有意的设计，不是漏掉。
#
# 判据真源：docs/12-docs/DOCS-METHODOLOGY.md §7。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  GUARD="$ROOT/scripts/check-doc-tone.js"
  TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMP"
}

@test "guard exists and passes on the real docs" {
  [ -f "$GUARD" ] || {
    echo "缺 scripts/check-doc-tone.js：语气门禁没有真源" >&2
    return 1
  }
  run node "$GUARD"
  [ "$status" -eq 0 ] || {
    echo "对外文档有句子层超标，先修文档（别调阈值）" >&2
    echo "$output" | grep '✗' >&2
    return 1
  }
}

@test "injecting dashes turns D1 red" {
  # 注入必须让「功能真不跑」，不能只是打印一行字。
  printf '# 注入测试\n\n这是正常的一句话。\n\n甲——乙。丙——丁。戊——己。庚——辛。\n' > "$TMP/d1.md"
  run node "$GUARD" "$TMP/d1.md"
  [ "$status" -eq 1 ] || {
    echo "塞了 4 个破折号仍然通过：D1 是空检查" >&2
    return 1
  }
  echo "$output" | grep -q '✗ D1'
}

@test "injecting counting boilerplate turns D9 red" {
  printf '# 注入测试\n\n先说结论，再展开。\n\n这件事要先算三笔账，最值钱的判断在后面。\n' > "$TMP/d9.md"
  run node "$GUARD" "$TMP/d9.md"
  [ "$status" -eq 1 ] || {
    echo "写了「算三笔账 / 最值钱的判断」仍然通过：D9 词表没生效" >&2
    return 1
  }
  echo "$output" | grep -q '✗ D9'
}

@test "injecting absolute wording turns D8 red" {
  printf '# 注入测试\n\n这是一段用来凑长度的正常正文，讲的是磁盘上的账本文件怎么读。这段正文继续写下去，目的是让汉字分母够大。\n\n这是唯一的方案，必然不会失败，无一例外。\n' > "$TMP/d8.md"
  run node "$GUARD" "$TMP/d8.md"
  [ "$status" -eq 1 ] || {
    echo "写了「唯一 / 必然 / 无一例外」仍然通过：D8 没生效" >&2
    return 1
  }
  echo "$output" | grep -q '✗ D8'
}

@test "D7 is a trend line, not a hard gate" {
  # 有意为之：机器分不清「源码运行，不是安装包」（事实区分）和「不是降级开关，是认知」（修辞）。
  # 这条测试把「软」钉住，免得以后有人手滑改成 hard，逼作者删掉有用的句子。
  {
    printf '# 注入测试\n\n'
    for i in 1 2 3 4 5 6 7 8 9 10; do
      printf '第 %s 段：这是源码运行，不是安装包。这句话是事实区分，删掉会让人误解交付形态。\n\n' "$i"
    done
  } > "$TMP/d7.md"
  run node "$GUARD" "$TMP/d7.md"
  echo "$output" | grep -q 'D7'
  echo "$output" | grep -q '✗ D7' && {
    echo "D7 被改成硬性了：事实性区分也被判红，作者只能删掉它们" >&2
    return 1
  }
  return 0
}

@test "FAQ paragraphs are not counted as judgement-opening prose" {
  # 问答体的正常形状就是「短答句 + 解释」，不该按论述段判 D6。
  {
    printf '# FAQ\n\n'
    for i in 1 2 3 4 5 6; do
      printf '**第 %s 个问题怎么处理？**不会。这条链路只验到能通、能记账，别的没验。\n\n' "$i"
    done
  } > "$TMP/faq.md"
  run node "$GUARD" "$TMP/faq.md"
  echo "$output" | grep -q '✗ D6' && {
    echo "FAQ 段落被算进了判断式开头：口径错，短答句是问答体的正常形状" >&2
    return 1
  }
  return 0
}

@test "--explain prints every hit, not just three samples" {
  {
    printf '# 注入测试\n\n这是一段正常正文，用来把分母撑起来。\n\n'
    for i in 1 2 3 4 5 6; do printf '第 %s 句：甲——乙。\n\n' "$i"; done
  } > "$TMP/many.md"
  run node "$GUARD" "$TMP/many.md" --explain D1
  local n
  n="$(echo "$output" | grep -c '甲——乙' || true)"
  [ "$n" -ge 6 ] || {
    echo "--explain 只打出 $n 处（期望 ≥6）：改稿时会漏看" >&2
    return 1
  }
}

# 2026-11-14：老板点名「别用像辩论赛一样的表达」，且落地页此前不在覆盖清单里。
# 下面三条把「新规则 + 新覆盖面」都做成可注入验证，不是只写进文档。

@test "injecting debate cliche into HTML turns D11 red" {
  printf '%s\n' '<html><body><p>既然是本地工具，就能自己验。真正该看的是它跑没跑过。</p></body></html>' > "$TMP/d11.html"
  run node "$GUARD" "$TMP/d11.html"
  [ "$status" -eq 1 ] || {
    echo "HTML 里写了辩论赛腔仍然通过：D11 是空检查" >&2
    return 1
  }
  echo "$output" | grep -q '✗ D11'
}

@test "HTML style text is stripped but visible prose is still checked" {
  # 样式里的坏句子不该算进正文；同一句挪到 <p> 里就必须算。
  printf '%s\n' '<html><head><style>/* 真正该看的是样式 */</style></head><body><p>账本写在你硬盘上，是一个纯文本文件。服务停了它也还在。</p></body></html>' > "$TMP/strip.html"
  run node "$GUARD" "$TMP/strip.html"
  [ "$status" -eq 0 ] || {
    echo "样式里的坏句子被算进正文：HTML 剥离没生效" >&2
    return 1
  }
  printf '%s\n' '<html><head><style>/* 正常 */</style></head><body><p>真正该看的是它跑没跑过。</p></body></html>' > "$TMP/strip2.html"
  run node "$GUARD" "$TMP/strip2.html"
  [ "$status" -eq 1 ] || {
    echo "正文里的辩论赛腔没被抓到：HTML 正文被一起剥掉了" >&2
    return 1
  }
}

@test "site/index.html is registered in the guard target list" {
  grep -qF "'site/index.html'" "$GUARD" || {
    echo "落地页没登记进 TARGETS：这层文案会重新脱离门禁" >&2
    return 1
  }
}
