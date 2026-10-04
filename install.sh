#!/usr/bin/env bash
# Install oc-go-usage-display from this repo (local, no network required).
# Copies dist/plugins/* (bundled, self-contained) into
# ~/.config/opencode/plugins/* and registers the
# opencode.jsonc + tui.json entries (existing toggles are preserved).
# When dist/plugins/* is missing, the bundles are built automatically if the
# repo looks buildable (`bun run build`); otherwise the script fails with a
# hint instead of a raw "repo bundle missing" error.
#
# Usage:
#   ./install.sh                  # copy (default, self-contained; preferred for prod)
#   ./install.sh --symlink        # symlink (dev-only; run `bun run build` after
#                                 # source edits so dist/plugins/* stays current)
#   ./install.sh --sidebar=0 --statusline=1
#   ./install.sh --target kilo    # skip the host question below
#
# Without --target/--config-dir an interactive terminal is asked which host(s)
# to install into (a host with no binary on PATH is struck through and left out
# of the default); piped or CI runs install both hosts without prompting. Any
# other argument is rejected by the CLI rather than forwarded.
#
# Secrets are never touched. Restart opencode afterwards.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi

SERVER_BUNDLE="$REPO_DIR/dist/plugins/oc-go-usage-display.ts"
TUI_BUNDLE="$REPO_DIR/dist/plugins/oc-go-usage-display.tsx"
if [[ ! -f "$SERVER_BUNDLE" || ! -f "$TUI_BUNDLE" ]]; then
  if [[ -f "$REPO_DIR/package.json" && -f "$REPO_DIR/tsconfig.json" && -f "$REPO_DIR/src/index.ts" ]]; then
    if ! command -v bun >/dev/null 2>&1; then
      echo "error: bun is required to build the bundles (https://bun.sh)" >&2
      exit 1
    fi
    echo "dist/plugins/* missing; building local bundles (bun run build)" >&2
    if ! (cd "$REPO_DIR" && bun run build); then
      echo "error: bun run build failed; run 'bun install' in $REPO_DIR and retry" >&2
      exit 1
    fi
  else
    echo "error: dist/plugins/* missing and $REPO_DIR does not look like the source repo" >&2
    echo "hint: run 'bun run build' in the source repo first, or install the published package" >&2
    exit 1
  fi
fi

node "$REPO_DIR/bin/oc-go-usage-display-init.js" --repo "$REPO_DIR" "$@"

echo "restart opencode to pick up plugin changes"
