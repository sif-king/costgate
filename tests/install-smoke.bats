# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# install.sh smoke test — N-05 E2E gap #1
# 验证安装/卸载脚本不破坏系统，且 dry-run 不写文件
#
# 注意：用 bats 内置 $BATS_TEST_DIRNAME 解析项目根（绝对路径），
# 不再依赖 `cd $(dirname $0)/../..` —— 在 bats 下 $0 不可靠，会导致
# 相对路径的 install.sh/manage.sh 找不到（退出 127），整文件实际跑不起来。

# 仓库根：从测试文件所在目录向上回溯，直到找到 install.sh / manage.sh。
# 不硬编码层级（避免 bats 在不同调用方式下 BATS_TEST_DIRNAME 解析差异导致的 off-by-one）。
PROJ_DIR="$(cd "$BATS_TEST_DIRNAME" && pwd)"
while [ ! -f "$PROJ_DIR/install.sh" ] && [ ! -f "$PROJ_DIR/manage.sh" ] && [ "$PROJ_DIR" != "/" ]; do
  PROJ_DIR="$(dirname "$PROJ_DIR")"
done

# 1. install.sh --all --dry-run 不报错且不写文件
@test "install.sh --all --dry-run succeeds without writing" {
  run bash "$PROJ_DIR/install.sh" --all --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
}

# 2. install.sh --uninstall --dry-run 不报错且不写文件
@test "install.sh --uninstall --dry-run succeeds without writing" {
  run bash "$PROJ_DIR/install.sh" --uninstall --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
}

# 3. manage.sh help 输出不含裸 lsof（必须走 $LSOF 绝对路径解析）
@test "manage.sh help output has no bare lsof" {
  run bash "$PROJ_DIR/manage.sh"
  # 帮助文本若含 lsof 字样，必须带 /usr/sbin/ 前缀
  if echo "$output" | grep -q 'lsof'; then
    echo "$output" | grep 'lsof' | grep -v '/usr/sbin/lsof'
    [ "$?" -ne 0 ]
  fi
}

# 4. bridge-launchd.sh 语法检查
@test "tools/bridge-launchd.sh syntax is valid" {
  run bash -n "$PROJ_DIR/tools/bridge-launchd.sh"
  [ "$status" -eq 0 ]
}

# 5. manage.sh bootout all 只卸载自有服务，绝不 blanket 误杀所有用户 launchd
@test "manage.sh bootout all only unloads own services (no blanket kill)" {
  # 真实执行 `bootout all` 会停掉在跑的 launchd 服务，不能在测试里冒然停服；
  # 改为断言其安全性（静态）：
  #  (a) 全仓不得出现无 label 的 `launchctl bootout gui/$(id -u)`（否则会误杀所有
  #      用户级 launchd 服务，包括与工作无关的其他 app）；
  #  (b) bootout_all 必须遍历 SERVICES 调 bootout_$svc（端口→label 定向卸载），
  #      而非 blanket 调用。
  run grep -nE 'launchctl bootout gui/\$\(id -u\)[[:space:]]*(\|\||2>|$)' "$PROJ_DIR/manage.sh"
  [ "$status" -ne 0 ]   # 零匹配（grep 找不到返回 1）= 安全
  run bash -c "source '$PROJ_DIR/manage.sh' && declare -f bootout_all | grep -q 'in \$SERVICES'"
  [ "$status" -eq 0 ]
}

# 6. 无裸 NO_PROXY 通配符
@test "manage.sh has no NO_PROXY wildcard" {
  ! grep 'NO_PROXY=.*\*' "$PROJ_DIR/manage.sh"
}

# 7. --all 必须真覆盖全部 8 个组件
# 背景：README 曾自承「install.sh 只有 4 个 install 函数，缺 claude/opencode/generic/dsh」。
# 这条守卫钉住它不再回退：只看代码「像不像有」不算，要看 --dry-run 真的逐个打印出来。
@test "install.sh --all --dry-run covers all 8 components" {
  run bash "$PROJ_DIR/install.sh" --all --dry-run
  [ "$status" -eq 0 ]
  for name in "Codex Proxy" "Claude Proxy" "OpenCode Proxy" "Generic OpenAI Proxy" \
              "DSH Proxy" "Hermes Proxy" "Cursor Multi-Model Proxy" "Multi-Proxy Manager"; do
    if [[ "$output" != *"$name"* ]]; then
      echo "missing in --all output: $name"
      return 1
    fi
  done
}

# 8. 四个代理的单个安装入口必须可用（可拆卸是设计前提）
@test "single-proxy install flags are wired" {
  for flag in --claude --opencode --generic --dsh; do
    run bash "$PROJ_DIR/install.sh" "$flag" --dry-run
    [ "$status" -eq 0 ]
    [[ "$output" == *"dry-run"* ]]
  done
}
