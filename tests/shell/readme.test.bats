#!/usr/bin/env bats

# BATS tests for README.md —— 它是产品的前门。
# Run with: bats tests/shell/readme.test.bats
#
# 为什么锁这几条：README 里写下的每一条命令、每一个路径，用户都会照着敲。
# 敲不出来比没有写更糟——第一次就撞墙的人不会回来。
# 2026-11-08 实测踩过：`codex-proxy/lib/usage-probe.js` 早就搬到 manager 侧了，
# README 还写着旧路径，读者按它去找会扑空。所以这里的判据不是「文字好看」，
# 而是「引用的东西真的存在」。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  README="$ROOT/README.md"
}

@test "README exists and is not empty" {
  [ -s "$README" ]
}

@test "every repo-relative path quoted in README exists on disk" {
  local p bad=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ ! -e "$ROOT/$p" ]; then
      echo "README 引用了不存在的路径：$p" >&2
      bad=1
    fi
  done < <(grep -oE '`(codex-proxy|multi-proxy-manager|unified-ingress|claude-proxy|cursor-proxy|dsh-proxy|opencode-proxy|generic-openai-proxy|l2|packs|tools|scripts|tests|docs)/[A-Za-z0-9_./-]+`' "$README" | tr -d '`' | sort -u)
  [ "$bad" -eq 0 ]
}

@test "every scripts/*.sh mentioned in README exists and parses" {
  local p bad=0 n=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    n=$((n + 1))
    if [ ! -f "$ROOT/$p" ]; then
      echo "README 提到的脚本不存在：$p" >&2
      bad=1
      continue
    fi
    bash -n "$ROOT/$p" || { echo "脚本语法不过：$p" >&2; bad=1; }
  done < <(grep -oE 'scripts/[A-Za-z0-9_.-]+\.sh' "$README" | sort -u)
  [ "$n" -ge 2 ] || { echo "只抽到 $n 个脚本，正则可能失效了" >&2; return 1; }
  [ "$bad" -eq 0 ]
}

@test "every install.sh flag shown in README is actually handled by install.sh" {
  local f bad=0 n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    if ! grep -qE -- "--${f}\)" "$ROOT/install.sh" && ! grep -qE -- "--${f}\|" "$ROOT/install.sh"; then
      echo "README 写了 install.sh --${f}，但 install.sh 没有这个分支" >&2
      bad=1
    fi
  done < <(grep -oE 'bash install\.sh --[a-z-]+' "$README" | sed 's/.*--//' | sort -u)
  [ "$n" -ge 3 ] || { echo "只抽到 $n 个参数，正则可能失效了" >&2; return 1; }
  [ "$bad" -eq 0 ]
}

@test "README does not point at line numbers (they rot; symbols do not)" {
  # 中文口径：正文里出现 `file.js:123` 这种锚点一律算退化——行号每改一次代码就会漂，
  # 而假的坐标比没有坐标更糟。实现细节表已改成给函数名/字段名。
  run grep -nE '`[A-Za-z0-9_./-]+\.(js|sh|py|json):[0-9]+`' "$README"
  [ "$status" -ne 0 ] || { echo "README 又写死行号了：$output" >&2; return 1; }
}

@test "providers.json example is a bare array, not a {providers:[...]} wrapper" {
  # 中文口径：2026-11-08 实测——各代理的 loadProviders() 都是
  # `Array.isArray(data) ? data : []`，顶层写成对象会被**静默**丢成空数组：
  # 用户改了配置、重启了、还是 404，而且没有任何报错。README 之前正是写错的示范。
  #
  # 注意别写成「全文禁止出现 {"providers"」——正文里为了提醒用户「别这么写」
  # 必须提到那个形状。判据只该落在**示例代码块**上，所以解析 fenced json 再判。
  run node -e '
    const fs = require("fs");
    const md = fs.readFileSync(process.argv[1], "utf8");
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const withPid = blocks.filter((b) => b.includes("provider_id"));
    if (!withPid.length) { console.log("NO_EXAMPLE"); process.exit(2); }
    for (const b of withPid) {
      const t = b.trim();
      if (!t.startsWith("[")) { console.log("WRAPPED: " + t.slice(0, 30)); process.exit(1); }
    }
    console.log("ok " + withPid.length + " example(s)");
  ' "$README"
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
}

@test "README does not tell users to point a base_url at hermes (it has no chat endpoint)" {
  # 中文口径（2026-11-08 实测）：hermes-proxy 只有 /v1/models，
  # POST /v1/chat/completions 返回 404。它做的是改写 ~/.hermes/config.yaml 的当前模型，
  # 请求由 Hermes 自己打上游 —— 所以它既不该出现在「把 base_url 指向这」的表格里，
  # 也不产生账本记录。README 曾把它写成 `| Hermes | http://127.0.0.1:18793 |`，
  # 用户照着接，/v1/models 还 200，看起来完全正常，一发请求才 404。
  run grep -qE '^\|[[:space:]]*Hermes[[:space:]]*\|[[:space:]]*`?http' "$README"
  [ "$status" -ne 0 ] || { echo "README 又把 hermes 写成可填 base_url 的代理了" >&2; return 1; }
  # 说明本身必须在，别为了过检查把整段删了
  run grep -q '不转发请求' "$README"
  [ "$status" -eq 0 ]
  run grep -q '/v1/chat/completions` 是 \*\*404\*\*' "$README"
  [ "$status" -eq 0 ]
  run grep -q 'Hermes 的用量不进账本' "$README"
  [ "$status" -eq 0 ]
}

@test "Codex CLI is wired through config.toml, not a made-up env var" {
  # 中文口径（2026-11-08 查本机实跑中的 codex 配置确认）：Codex CLI 读
  # ~/.codex/config.toml 的 model_provider + [model_providers.<name>]，不认
  # OPENAI_BASE_URL。README 曾把「Codex CLI」和 `export OPENAI_BASE_URL=...`
  # 放在同一个标题下——最主力的客户端照做，请求根本不会经过代理，而屏幕上
  # 看不出任何异常。断言三件事：① 有 toml 片段 ② 声明了 wire_api
  # ③ 环境变量那行不再挂在 Codex CLI 名下。
  run grep -q 'model_provider = "multi-proxy"' "$README"
  [ "$status" -eq 0 ] || { echo "README 缺 Codex CLI 的 config.toml 片段" >&2; return 1; }
  run grep -qF 'wire_api = "responses"' "$README"
  [ "$status" -eq 0 ] || { echo "README 没写 wire_api（Codex 默认走 /v1/responses）" >&2; return 1; }
  # 「Codex CLI / OpenAI SDK」这种合写标题就是把环境变量按到 Codex 头上
  run grep -qE 'Codex CLI[^）]{0,10}/ *OpenAI SDK' "$README"
  [ "$status" -ne 0 ] || { echo "又把 Codex CLI 和认环境变量的工具合写成一个标题了" >&2; return 1; }
  # 明确说清它不认环境变量（否则下一个人还会「顺手统一一下」）
  # 注意必须 -E：BSD grep 的 BRE 不认 `\|`，写成 grep 'a\|b' 恒不匹配，
  # 这条断言会永远假红（2026-11-08 踩到）。
  run grep -qE '不认环境变量|不认这个变量' "$README"
  [ "$status" -eq 0 ] || { echo "README 没点明 Codex CLI 不认环境变量" >&2; return 1; }
}

@test "the banner in README's sample output matches what quickstart actually prints" {
  # 中文口径（2026-11-09）：README 那段示例输出自称「一字未改」，但横幅写的是
  # 「60 秒冷启」,而脚本正文同一屏的末尾会报「用时 97s」——横幅打脸正文，而且
  # 60 秒这个数字本身对空缓存/慢网永远不成立。改法不是换个数字（过几个月又漂），
  # 是把秒数从横幅里彻底拿掉，只由脚本末尾报本次真实耗时。
  # 这条守卫抓的是「示例输出与脚本真源不一致」——示例输出是最容易腐烂的副本。
  local banner
  banner="$(grep -m1 '^bold "costgate · ' "$ROOT/scripts/quickstart.sh" | sed 's/^bold "//; s/"$//')"
  [ -n "$banner" ] || { echo "在 quickstart.sh 里找不到 bold \"costgate · ...\" 横幅" >&2; return 1; }
  run grep -qxF -- "$banner" "$README"
  [ "$status" -eq 0 ] || {
    echo "README 示例输出的横幅与脚本不一致（示例应逐字相同）：" >&2
    echo "  脚本打印：$banner" >&2
    return 1
  }
  # 顺手禁掉按固定秒数承诺：这类数字随 npm 缓存与网络漂移，写进对外文案必被现实打脸。
  run grep -nE '60 ?秒冷启|一分钟左右看到效果' "$README" "$QS"
  [ "$status" -ne 0 ] || { echo "又按固定秒数承诺冷启时长了：$output" >&2; return 1; }
}

@test "docs do not promise a first-run consent page while that gate is off" {
  # 中文口径：quickstart 原来写「面板（首启会展示协议页）」，README 写「首次访问
  # 引导设密码」——两处都与现实不符。2026-11-08 实测（全新 HOME、回环访问）：
  #   GET /                → 200，直接是总览页（title「costgate - 总览」）
  #   GET /api/auth/status → {"needsSetup":false,"hasPassword":false,"loopbackBypass":true}
  # 原因是 server.js 里那行同意门重定向被注释掉了（2026-10-22 拍板：「都拦」会把人
  # 锁在门外，取「都不拦」）。文档承诺一个永远不会出现的页面，陌生人会以为装坏了。
  local S="$ROOT/multi-proxy-manager/server.js"
  local QS="$ROOT/scripts/quickstart.sh"
  run grep -qE "^[[:space:]]*//[[:space:]]*if \(req\.path !== '/login' && !consentBypass" "$S"
  [ "$status" -eq 0 ] || skip "同意门已启用：此时文档应当写协议页，请同步改这条守卫"
  # 只禁「承诺会看到」的说法，不禁「说明它不存在」的句子（后者正是本次修法）。
  run grep -nE '首启会展示协议页|首次访问引导设密码|会弹出?协议页|会看到协议页' "$README" "$QS"
  [ "$status" -ne 0 ] || {
    echo "同意门是关着的，文档却在承诺会有协议页："
    echo "$output"
    return 1
  }
}
