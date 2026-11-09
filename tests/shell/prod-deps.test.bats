#!/usr/bin/env bats

# BATS tests for scripts/check-prod-deps.js
# Run with: bats tests/shell/prod-deps.test.bats
#
# 为什么锁这几条：生产依赖里多一个包，本机不会有任何感觉 —— 它早就装好了。
# 代价全部落在**别人**身上：多下载、多一次可能失败的 postinstall、多一份供应链面积。
# 2026-11-09 实测：multi-proxy-manager 的 dependencies 里躺着 playwright，
# 全仓唯一的引用者是一个注释写着 "one-off: eyeball the real rendered #gateBar"
# 的一次性目检脚本（gb-render-check.cjs，它入库）。于是每个新用户 clone 后跑
# quickstart 的 `npm install --omit=dev`，都要为一次早已完成的目检付 18MB
# （node_modules 26MB 里占 69%），外加 playwright postinstall 的浏览器下载。
#
# 这里钉住的是两条互补判据，缺一条就有盲区：
#   ① 黑名单：开发工具（playwright/jest/electron/...）不许出现在 dependencies
#   ② 孤儿：dependencies 里每个包，必须被版本控制内的非测试源文件 require 到
# 本案恰好是 ① 抓得住、② 抓不住（因为那个 one-off 脚本入库了）——
# 所以两条都要测，而且各测一次注入。

GUARD=""
ROOT=""
PKG=""
BAK=""

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  GUARD="$ROOT/scripts/check-prod-deps.js"
  PKG="$ROOT/multi-proxy-manager/package.json"
  BAK="$BATS_TEST_TMPDIR/package.json.bak"
  cp "$PKG" "$BAK"
}

teardown() {
  # 注入用例会改真实 package.json；无论断言过没过，都还原回来。
  # 末尾的 true 是必要的：BAK 不存在时 [ -f ] 返回 1，bats 会把它当成用例失败。
  if [ -f "$BAK" ]; then cp "$BAK" "$PKG"; fi
  true
}

# 往 dependencies 里塞一个包（保留原格式缩进）
inject_dep() {
  local name="$1" ver="${2:-^0.0.1}"
  node -e '
    const fs = require("fs");
    const [p, name, ver] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.dependencies[name] = ver;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$PKG" "$name" "$ver"
}

@test "guard script exists and parses" {
  [ -f "$GUARD" ]
  run node --check "$GUARD"
  [ "$status" -eq 0 ]
}

@test "current tree passes: every production dependency has a real user" {
  run node "$GUARD"
  [ "$status" -eq 0 ]
  [[ "$output" == *"没有开发工具混入"* ]] || { echo "输出里没有通过标记：$output" >&2; return 1; }
}

@test "a dev-only tool placed in dependencies is caught" {
  # 本案原样复现：playwright 回到 dependencies
  inject_dep playwright "^1.61.1"
  run node "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"playwright"* ]] || { echo "没点名 playwright：$output" >&2; return 1; }
  [[ "$output" == *"开发工具被放进了 dependencies"* ]] || { echo "没说明原因：$output" >&2; return 1; }
}

@test "an unused package (not on the blacklist) is caught as orphan" {
  # 黑名单之外的新孤儿也必须被抓 —— 否则下一个人换个名字就能绕过
  inject_dep "zzz-nobody-requires-this" "^1.0.0"
  run node "$GUARD"
  [ "$status" -eq 1 ]
  [[ "$output" == *"zzz-nobody-requires-this"* ]] || { echo "没点名孤儿包：$output" >&2; return 1; }
}

@test "test files do not count as evidence that a dependency is used" {
  # 若把 tests/ 里的 require 也算「有人用」，那么把 devDependencies 里的东西
  # 误挪进 dependencies 就永远不会被发现 —— 本判据的锐度全在这一条上。
  run grep -qF 'isTestFile(f)' "$GUARD"
  [ "$status" -eq 0 ]
  # 必须同时排除 tests/ 目录与 *.test.js / *.spec.ts 这类文件
  run grep -qF '(^|\/)tests?/' "$GUARD"
  [ "$status" -eq 0 ]
  run grep -qF '(test|spec)' "$GUARD"
  [ "$status" -eq 0 ]
}

@test "guard refuses to pass in a tree without git (no fake green)" {
  # 没有 .git 时无法判定「哪些文件随仓库发布」，只能说「没检查」——
  # 退出码必须是 2，不能是 0。这与 drift-check 的约定一致：未知不是通过。
  run grep -qF "return 2" "$GUARD"
  [ "$status" -eq 0 ]
  run grep -qF "本次不算通过" "$GUARD"
  [ "$status" -eq 0 ]
}

@test "lockfile root deps match package.json (npm ci precondition)" {
  # CI 跑 npm ci，它会严格比对 package.json 与 lock 的根包依赖；
  # 改了 package.json 忘了同步 lock，CI 会在装依赖那一步就红，
  # 而本地因为 node_modules 已存在完全看不出来。
  run node -e '
    const pj = require(process.argv[1]);
    const lock = require(process.argv[2]);
    const root = lock.packages[""];
    const keys = (o) => Object.keys(o || {}).sort().join(",");
    const bad = [];
    if (keys(pj.dependencies) !== keys(root.dependencies)) bad.push("dependencies");
    if (keys(pj.devDependencies) !== keys(root.devDependencies)) bad.push("devDependencies");
    if (bad.length) { console.error("不同步：" + bad.join(" / ")); process.exit(1); }
  ' "$PKG" "${PKG%.json}-lock.json"
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
}

@test "playwright stays a devDependency (UI-AUDIT and e2e still need it locally)" {
  # 修法不是删依赖，是搬到 devDependencies：本地 `npm install` 全装仍有它，
  # UI-AUDIT/shoot.js 与 playwright.config.js 照常可用；只有 --omit=dev 的生产安装跳过。
  run node -e '
    const pj = require(process.argv[1]);
    const inDev = "playwright" in (pj.devDependencies || {});
    const inProd = "playwright" in (pj.dependencies || {});
    if (!inDev || inProd) {
      console.error(`playwright: devDependencies=${inDev} dependencies=${inProd}`);
      process.exit(1);
    }
  ' "$PKG"
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
}
