#!/usr/bin/env bash
# Hermetic container smoke test: prove the real opencode host loads the built
# plugin and registers the `go_usage` tool.
#
#   bash scripts/container-smoke.sh
#
# Isolation: a fresh mktemp root backs HOME, every XDG_* root, TMPDIR, and
# OPENCODE_CONFIG_DIR. `opencode debug paths` must resolve entirely inside that
# root. The real host ~/.config/opencode and ~/.opencode are never referenced.
# Requires a prior `npm run build` (dist/index.js + dist/tui.js).
#
# OPENCODE_PURE / --pure is deliberately NOT set: it would skip the external
# plugin under test. The server is killed on EXIT; failures exit non-zero.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d -t oc-go-usage-display-smoke-XXXXXX)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

log() { printf '[container-smoke] %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for command in opencode curl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -f "$REPO_DIR/dist/index.js" ]] || fail "dist/index.js missing; run 'npm run build' first"

# --- hermetic env (everything inside TMP_ROOT) -------------------------------
export HOME="$TMP_ROOT/home"
export XDG_CONFIG_HOME="$TMP_ROOT/xdg-config"
export XDG_DATA_HOME="$TMP_ROOT/xdg-data"
export XDG_STATE_HOME="$TMP_ROOT/xdg-state"
export XDG_CACHE_HOME="$TMP_ROOT/xdg-cache"
export TMPDIR="$TMP_ROOT/tmp"
export OPENCODE_CONFIG_DIR="$TMP_ROOT/config"
mkdir -p \
  "$HOME" \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_CACHE_HOME" \
  "$TMPDIR" \
  "$OPENCODE_CONFIG_DIR"

export CI=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_GO_MOCK=1

# --- every resolved opencode path must stay inside TMP_ROOT ------------------
paths_output="$(opencode debug paths)"
while read -r key value; do
  [[ -n "${key:-}" && -n "${value:-}" ]] || continue
  [[ "$value" == "$TMP_ROOT"/* ]] || fail "debug path '$key' escaped the tmp root: $value"
done <<<"$paths_output"
pass "opencode debug paths stay inside $TMP_ROOT"

# --- plugin config (post-build entry modules) --------------------------------
printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["file://%s/dist/index.js"]\n}\n' \
  "$REPO_DIR" > "$OPENCODE_CONFIG_DIR/opencode.json"
printf '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": ["file://%s/dist/tui.js"],\n  "sidebar": true,\n  "statusline": true\n}\n' \
  "$REPO_DIR" > "$OPENCODE_CONFIG_DIR/tui.json"

# --- start server, wait for the sentinel (<=15s, retry) ----------------------
SERVE_LOG="$TMP_ROOT/serve.log"
: >"$SERVE_LOG"
opencode serve --port 0 --hostname 127.0.0.1 >>"$SERVE_LOG" 2>&1 &
SERVER_PID=$!

server_url=""
for _ in $(seq 1 60); do
  if grep -q "server listening on http://" "$SERVE_LOG"; then
    server_url="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$SERVE_LOG" | head -n 1)"
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || {
    cat "$SERVE_LOG" >&2
    fail "opencode serve exited before reporting a listening URL"
  }
  sleep 0.25
done
[[ -n "$server_url" ]] || {
  cat "$SERVE_LOG" >&2
  fail "timed out after 15s waiting for the server sentinel"
}
pass "server listening at $server_url"

# --- tool ids: go_usage must be registered (retry while bootstrapping) -------
tool_ids=""
for _ in $(seq 1 30); do
  if tool_ids="$(curl -sS -m 10 -H "x-opencode-directory: $REPO_DIR" \
    "$server_url/experimental/tool/ids" 2>/dev/null)"; then
    break
  fi
  tool_ids=""
  kill -0 "$SERVER_PID" 2>/dev/null || {
    cat "$SERVE_LOG" >&2
    fail "opencode serve exited while probing tool ids"
  }
  sleep 2
done
[[ -n "$tool_ids" ]] || {
  cat "$SERVE_LOG" >&2
  fail "tool ids endpoint unavailable after retries"
}
printf '%s' "$tool_ids" | grep -q '"go_usage"' \
  || fail "go_usage not registered; tool ids: $tool_ids"
pass "go_usage registered"
log "tool ids: $tool_ids"

pass "container smoke passed"
