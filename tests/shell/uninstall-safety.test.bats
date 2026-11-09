#!/usr/bin/env bats

# BATS tests for install.sh uninstall safety (A-1 / A-2 / dry-run)
# Run with: bats tests/shell/uninstall-safety.test.bats
#
# Discipline source: every bug must leave behind a guard that can catch it
# automatically (self-evolving mechanism of the "Gap Defense" methodology).
# These cases pin down four real problems fixed on 2026-10-25:
#   A-1  --reinstall ran `rm -f .env` and deleted the user's real API keys
#        (the only irreversible data loss in the backlog)
#   A-2  uninstall covered only 4/8 proxies (claude/opencode/generic/dsh had
#        no uninstall logic at all)
#   DRY  --uninstall --dry-run really stopped running services (the dry-run
#        guard checked $2, but --dry-run had already been stripped from the
#        positional params and turned into FORWARD_DRY_RUN)
#   REP  --stop executed `manage.sh stop all` four times in a row
#
# NOTE: none of these cases delete files or stop services for real.
# They rely on static assertions plus the --dry-run preview path.

INSTALL_SH=""
PROJECT_ROOT=""

setup() {
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  INSTALL_SH="$PROJECT_ROOT/install.sh"
  if [ ! -f "$INSTALL_SH" ]; then
    echo "ERROR: install.sh not found at $INSTALL_SH" >&2
    return 1
  fi
}

# ---- A-1: .env (real API keys) must never be deleted ----

@test "A-1a: install.sh contains no statement that deletes .env directly" {
  # Old implementation: `[ -f "$dir/.env" ] && rm -f "$dir/.env" && print_ok ".env removed"`
  # It deleted a 0600 file holding real API keys. Any `rm ... .env` must fail.
  # Comment lines are filtered out first: the explanatory comment above
  # preserve_env quotes the old broken form verbatim, and a guard that trips
  # over its own documentation is worse than no guard.
  local code
  code="$(grep -vE '^[[:space:]]*#' "$INSTALL_SH")"
  run grep -nE 'rm[[:space:]]+-[a-zA-Z]*f[a-zA-Z]*[[:space:]]+[^|]*\.env' <<<"$code"
  [ "$status" -ne 0 ]
}

@test "A-1b: preserve_env exists and is referenced at least 11 times" {
  # 1 definition + 8 uninstall_* callers + 2 in residues = 11
  run grep -c 'preserve_env' "$INSTALL_SH"
  [ "$status" -eq 0 ]
  [ "$output" -ge 11 ]
}

@test "A-1c: --reinstall states up front that API keys are preserved" {
  # The old output printed "files kept" only AFTER the rm, which implied the
  # keys were still there. It must now say so before anything happens.
  run grep -n 'API 密钥' "$INSTALL_SH"
  [ "$status" -eq 0 ]
}

@test "A-1d: safe_rm_rf backs up first and skips deletion when backup fails" {
  run grep -n 'safe_rm_rf' "$INSTALL_SH"
  [ "$status" -eq 0 ]
  run grep -n '已跳过删除' "$INSTALL_SH"
  [ "$status" -eq 0 ]
}

# ---- A-2: uninstall must cover 8/8 proxies ----

@test "A-2a: uninstall_* functions are defined for all 8 proxies" {
  for fn in uninstall_codex uninstall_hermes uninstall_cursor uninstall_claude \
            uninstall_opencode uninstall_generic uninstall_dsh uninstall_manager; do
    run grep -n "^${fn}()" "$INSTALL_SH"
    [ "$status" -eq 0 ]
  done
}

@test "A-2b: the --uninstall branch invokes all 8 uninstall_* functions" {
  local body
  body="$(sed -n '/^    --uninstall)/,/^    --reinstall)/p' "$INSTALL_SH")"
  for fn in uninstall_codex uninstall_hermes uninstall_cursor uninstall_claude \
            uninstall_opencode uninstall_generic uninstall_dsh uninstall_manager; do
    echo "$body" | grep -q "$fn" || {
      echo "MISSING in --uninstall branch: $fn" >&2
      return 1
    }
  done
}

@test "A-2c: --stop converges to manage.sh single source and runs exactly once" {
  # Old implementation: four `kill -9 ...; true` wrappers (always-true exit code
  # and only 4 proxies). The --stop branch must now call stop_all_services once.
  local body
  body="$(sed -n '/^    --stop)/,/^    --restart)/p' "$INSTALL_SH")"
  local n
  n="$(echo "$body" | grep -c 'stop_all_services')"
  [ "$n" -eq 1 ]
  # The always-true stop_* wrappers must be gone
  run grep -nE '^stop_(codex|hermes|cursor|manager)\(\)' "$INSTALL_SH"
  [ "$status" -ne 0 ]
}

# ---- N-5: install.sh --start must converge to manage.sh start all (9/9, no divergent nohup) ----

@test "N-5: install.sh --start converges to manage.sh start all (no duplicate 4/8 nohup)" {
  # Old implementation: `start_codex; start_hermes; start_cursor; start_manager`
  # (only 4/8 proxies, nohup bare-run, divergent from manage.sh). The --start
  # branch must now delegate to the single source `manage.sh start all`.
  local body
  body="$(sed -n '/^    --start)/,/^    --stop)/p' "$INSTALL_SH")"
  echo "$body" | grep -q 'manage.sh' || { echo "--start no longer delegates to manage.sh" >&2; return 1; }
  echo "$body" | grep -q 'start all' || { echo "--start does not call manage.sh start all" >&2; return 1; }
  if echo "$body" | grep -qE 'start_(codex|hermes|cursor|manager)'; then
    echo "--start still calls local 4/8 start_* wrappers (divergent duplicate)" >&2; return 1
  fi
}

# ---- DRY: dry-run must genuinely do nothing ----

@test "DRYa: the dry-run check uses FORWARD_DRY_RUN, not the positional 2" {
  # Root cause: the argument loop strips --dry-run from the positional
  # parameters and turns it into FORWARD_DRY_RUN, so `[ "$2" = "--dry-run" ]`
  # was always false and the dry-run guard never fired.
  local body
  body="$(sed -n '/^    --uninstall)/,/^    --reinstall)/p' "$INSTALL_SH")"
  echo "$body" | grep -q 'FORWARD_DRY_RUN' || {
    echo "--uninstall branch no longer checks FORWARD_DRY_RUN" >&2
    return 1
  }
  if echo "$body" | grep -qE '\[[[:space:]]*"\$2"[[:space:]]*='; then
    echo "--uninstall branch still branches on the positional 2" >&2
    return 1
  fi
}

@test "DRYb: --uninstall --dry-run leaves running services alone" {
  # Probe a port that should be listening. If nothing is up, skip instead of
  # reporting a false failure.
  local probe=18792
  if ! lsof -nP -iTCP:$probe -sTCP:LISTEN >/dev/null 2>&1; then
    skip "port $probe is not listening, cannot verify"
  fi

  # DESTRUCTIVE BY DESIGN: this is the only way to prove the dry-run guard
  # actually holds. If the guard regresses, this case really stops 18792 and
  # then reports red -- which is exactly what happened when the A-4/DRY bugs
  # were re-injected on 2026-10-25. Self-heal afterwards so a red run does not
  # leave the machine broken.
  run bash "$INSTALL_SH" --uninstall --dry-run
  [ "$status" -eq 0 ]
  if ! lsof -nP -iTCP:$probe -sTCP:LISTEN >/dev/null 2>&1; then
    echo "dry-run stopped $probe -- the dry-run guard is broken" >&2
    bash "$PROJECT_ROOT/manage.sh" start manager >/dev/null 2>&1 || true
    return 1
  fi
}

@test "DRYc: --uninstall --dry-run reports all 8 proxies and no .env removal" {
  run bash "$INSTALL_SH" --uninstall --dry-run
  [ "$status" -eq 0 ]
  for name in "Codex Proxy" "Hermes Proxy" "Cursor Proxy" "Claude Proxy" \
              "OpenCode Proxy" "Generic OpenAI Proxy" "DSH Proxy" "Multi-Proxy Manager"; do
    echo "$output" | grep -q "$name" || {
      echo "dry-run output is missing: $name" >&2
      return 1
    }
  done
  # The old implementation printed ".env removed"; none of that may remain
  if echo "$output" | grep -q 'removed'; then
    echo "dry-run output still claims .env was removed" >&2
    return 1
  fi
}

# ---- A-4: dry-run must never look like a real uninstall ----

@test "A-4a: the finish banner branches on dry-run (preview never claims success)" {
  # 实测 2026-11-08：`--uninstall --dry-run` 的结尾是「✓ 卸载完成！」，
  # 而它一个文件都没删。预览报「完成」比不报更糟——用户会以为已经清理干净，
  # 再也不回来跑真删。所以「卸载完成」必须落在非预览分支里。
  local body guard_line ok_line
  body="$(sed -n '/^    --uninstall)/,/^    --reinstall)/p' "$INSTALL_SH")"
  [ -n "$body" ] || { echo "找不到 --uninstall 分支" >&2; return 1; }
  guard_line="$(printf '%s' "$body" | grep -n 'LAUNCHD_DRY_RUN' | head -1 | cut -d: -f1)"
  ok_line="$(printf '%s' "$body" | grep -n '卸载完成' | head -1 | cut -d: -f1)"
  [ -n "$guard_line" ] && [ -n "$ok_line" ] || {
    echo "锚点找不到：dry-run 判据=$guard_line 完成横幅=$ok_line" >&2
    return 1
  }
  [ "$guard_line" -lt "$ok_line" ] || {
    echo "「卸载完成」写在 dry-run 判据之前（$ok_line vs $guard_line）——预览会报成功" >&2
    return 1
  }
  # 预览分支必须明确说「什么都没删」，不能只说「预览模式」
  printf '%s' "$body" | grep -q '什么都没有删除' || {
    echo "预览分支没说清「什么都没删」，用户会以为已经清理" >&2
    return 1
  }
}

@test "A-4b: running --uninstall --dry-run really prints \"nothing was deleted\"" {
  # A-4a 是静态判断（可能被改写成等价形式骗过），这条真跑一次预览。
  # preview 路径设计上只读；跑完断言「说了没删」且「没自称完成」。
  run bash -c "cd '$PROJECT_ROOT' && timeout 90 bash ./install.sh --uninstall --dry-run"
  [ "$status" -eq 0 ] || { echo "预览退出码 $status（应为 0）" >&2; return 1; }
  [[ "$output" == *"什么都没有删除"* ]] || {
    echo "预览没说「什么都没有删除」" >&2
    return 1
  }
  [[ "$output" != *"卸载完成"* ]] || {
    echo "预览仍然自称「卸载完成」——假成功" >&2
    return 1
  }
}
