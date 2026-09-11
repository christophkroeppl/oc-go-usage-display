#!/usr/bin/env bash
# Regression test: install from an npm tarball via `npm exec` (npx-style).
#
# Covers the "npx from NPM" path that symlinked local installs do not:
#   - `npm run build` + `npm pack` produces a tarball containing the
#     runtime bundles, bins, and sources.
#   - `npm exec --yes --package <tarball> -- oc-go-usage-display-init`
#     WITHOUT --repo installs from the ephemeral _npx extract (primary case).
#   - The same flow WITH explicit --repo also works (second case).
#
# Isolation: all state lives under a mktemp dir (trap cleanup). HOME,
# XDG_DATA_HOME, npm_config_cache, and OPENCODE_CONFIG_DIR point at tmpdirs
# so the real ~/.config/opencode is never touched. --yes avoids hangs.
#
# NOTE: only the installs run via `npm exec` (one per case, each with its own
# fresh npm cache). The show/status assertions run via `node` with an explicit
# --repo pointing at the same repo the install used (discovered through the
# installed symlink for the ephemeral case). This is equivalent validation
# (same symlinks/entries checked) and avoids nesting several `npm exec`
# calls inside `npm run`, which fails silently in snap-confined environments.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d -t oc-go-usage-display-npx-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

log() { printf '[test:npx] %s\n' "$*"; }
fail() { printf '[test:npx] FAIL: %s\n' "$*" >&2; exit 1; }

for cmd in node npm tar find; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
done

# --- build + pack -----------------------------------------------------------
log "building ($REPO_DIR)"
(cd "$REPO_DIR" && npm run build >/dev/null)

mkdir -p "$TMP_ROOT/tarball"
log "packing tarball"
(cd "$REPO_DIR" && npm pack --pack-destination "$TMP_ROOT/tarball" >/dev/null)
TARBALL=""
for candidate in "$TMP_ROOT"/tarball/*.tgz; do
  TARBALL="$candidate"
  break
done
[[ -n "$TARBALL" && -f "$TARBALL" ]] || fail "no tarball produced in $TMP_ROOT/tarball"
log "tarball: $TARBALL"

# --- tarball contents --------------------------------------------------------
# NOTE: list once to a file first — `tar -tzf | grep -q` under
# `set -o pipefail` would report SIGPIPE (141) as failure because grep -q
# closes the pipe early even on match.
tar -tzf "$TARBALL" | sort >"$TMP_ROOT/tarlist.txt"
for entry in \
  "package/dist/shared.js" \
  "package/dist/index.js" \
  "package/dist/tui.js" \
  "package/bin/oc-go-usage-display-init.js" \
  "package/src/shared.ts"; do
  grep -Fxq "$entry" "$TMP_ROOT/tarlist.txt" \
    || fail "tarball missing $entry (saw: $(tr '\n' ' ' <"$TMP_ROOT/tarlist.txt"))"
done
log "tarball contents OK"

# --- tarball dist is importable ----------------------------------------------
mkdir -p "$TMP_ROOT/extract"
tar -xzf "$TARBALL" -C "$TMP_ROOT/extract"
# Bare extract has no node_modules (peer @opencode-ai/plugin is external), so
# syntax-check it here; the full runtime import is proven below against the
# ephemeral _npx extract and the local build (both have dependencies).
node --check "$TMP_ROOT/extract/package/dist/index.js"
log "tarball dist/index.js syntax OK"
node --input-type=module -e "await import(process.argv[1])" "$REPO_DIR/dist/index.js"
log "local dist/index.js imports OK"

# --- isolated env (never touch the real home/config) -------------------------
mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/xdg" \
  "$TMP_ROOT/npm-cache-a" "$TMP_ROOT/npm-cache-b" \
  "$TMP_ROOT/config-a" "$TMP_ROOT/config-b"
export HOME="$TMP_ROOT/home"
export XDG_DATA_HOME="$TMP_ROOT/xdg"
export OPENCODE_GO_MOCK=1
[[ "$HOME" == "$TMP_ROOT"* ]] || fail "HOME not isolated ($HOME)"
[[ "$XDG_DATA_HOME" == "$TMP_ROOT"* ]] || fail "XDG_DATA_HOME not isolated ($XDG_DATA_HOME)"

CONFIG_A="$TMP_ROOT/config-a"
CONFIG_B="$TMP_ROOT/config-b"

ephemeral_repo_of() {
  # Resolve the repo root that backs an installed config dir by following the
  # server plugin symlink (dist/plugins/<file> -> <repo>/dist/plugins/<file>).
  local config_dir="$1"
  local link_target
  link_target="$(readlink -f "$config_dir/plugins/oc-go-usage-display.ts")"
  [[ -f "$link_target" ]] || fail "symlink target missing: $link_target"
  dirname "$(dirname "$(dirname "$link_target")")"
}

assert_bundled() {
  local config_dir="$1"
  local plugins_dir="$config_dir/plugins"
  [[ -d "$plugins_dir" ]] || fail "missing plugins dir: $plugins_dir"
  if grep -R -F 'from "./shared' "$plugins_dir" 2>/dev/null; then
    fail "deployed plugins still import from \"./shared\" (not bundled)"
  fi
  if grep -R -F "from './shared" "$plugins_dir" 2>/dev/null; then
    fail "deployed plugins still import from './shared' (not bundled)"
  fi
  if grep -R -F 'from "./' "$plugins_dir" 2>/dev/null; then
    fail "deployed plugins contain relative imports (not bundled)"
  fi
  if grep -R -F "from './" "$plugins_dir" 2>/dev/null; then
    fail "deployed plugins contain relative imports (not bundled)"
  fi
  grep -q "go_usage" "$plugins_dir/oc-go-usage-display.ts" \
    || fail "server bundle missing go_usage marker"
  grep -q "sidebar_content" "$plugins_dir/oc-go-usage-display.tsx" \
    || fail "tui bundle missing sidebar_content marker"
  log "bundled OK ($config_dir)"
}

assert_no_dangling() {
  local config_dir="$1"
  local dangling
  dangling="$(find "$config_dir" -xtype l -print 2>/dev/null || true)"
  [[ -z "$dangling" ]] || fail "dangling symlinks in $config_dir: $dangling"
  log "no dangling symlinks ($config_dir)"
}

assert_import_ok() {
  local repo_dir="$1"
  local config_dir="$2"
  node --input-type=module -e "await import(process.argv[1])" "$repo_dir/dist/index.js"
  log "dist/index.js imports OK ($config_dir via $repo_dir)"
}

assert_show_entries() {
  # args: repo_dir config_dir — runs the tarball-equivalent show bin via node
  # with an explicit --repo (same repo the install used).
  local repo_dir="$1"
  local config_dir="$2"
  local show_json="$TMP_ROOT/show-$(basename "$config_dir").json"
  # NOTE: capture via command substitution (pipe) then let bash write the
  # file. Direct `node ... >file` produces an empty file when this script
  # runs nested under `npm run` with a snap-confined node (/snap/bin/node):
  # the snap child cannot write the redirected host-/tmp fd, yet exits 0.
  # Pipes work, so capture + bash-write is robust in both snap and normal
  # environments.
  local show_output
  show_output="$(node "$repo_dir/bin/oc-go-usage-display-show.js" \
    --repo "$repo_dir" --config-dir "$config_dir" --json)"
  printf '%s\n' "$show_output" >"$show_json"
  cat "$show_json"
  node -e "
    const fs = require('node:fs');
    const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const assert = require('node:assert/strict');
    assert.equal(report.server.entry, true, 'server entry must be true, got ' + JSON.stringify(report.server));
    assert.equal(report.tui.entry, true, 'tui entry must be true, got ' + JSON.stringify(report.tui));
    console.log('[test:npx] show --json entries OK (' + process.argv[2] + ')');
  " "$show_json" "$config_dir"
}

assert_status_ok() {
  # args: repo_dir config_dir
  local repo_dir="$1"
  local config_dir="$2"
  node "$repo_dir/bin/oc-go-usage-display-status.js" \
    --repo "$repo_dir" --config-dir "$config_dir" 2>&1 | tail -n 5
  log "status exit 0 ($config_dir via $repo_dir)"
}

# --- case A: ephemeral install WITHOUT --repo (primary) -----------------------
log "case A: npm exec install WITHOUT --repo (ephemeral _npx extract)"
export npm_config_cache="$TMP_ROOT/npm-cache-a"
export OPENCODE_CONFIG_DIR="$CONFIG_A"
npm exec --yes --package "$TARBALL" -- \
  oc-go-usage-display-init --config-dir "$CONFIG_A"
assert_bundled "$CONFIG_A"
assert_no_dangling "$CONFIG_A"
EPH_A="$(ephemeral_repo_of "$CONFIG_A")"
log "ephemeral repo: $EPH_A"
assert_import_ok "$EPH_A" "$CONFIG_A"
assert_show_entries "$EPH_A" "$CONFIG_A"
assert_status_ok "$EPH_A" "$CONFIG_A"
log "case A PASS"

# --- case B: explicit --repo --------------------------------------------------
log "case B: npm exec install WITH explicit --repo"
export npm_config_cache="$TMP_ROOT/npm-cache-b"
export OPENCODE_CONFIG_DIR="$CONFIG_B"
npm exec --yes --package "$TARBALL" -- \
  oc-go-usage-display-init --repo "$REPO_DIR" --config-dir "$CONFIG_B"
assert_bundled "$CONFIG_B"
assert_no_dangling "$CONFIG_B"
assert_import_ok "$REPO_DIR" "$CONFIG_B"
assert_show_entries "$REPO_DIR" "$CONFIG_B"
assert_status_ok "$REPO_DIR" "$CONFIG_B"
log "case B PASS"

log "ALL NPX INSTALL TESTS PASS"
