#!/usr/bin/env bash
# Install oc-go-usage-display from this repo (local, no network required).
# Symlinks dist/plugins/* (bundled, self-contained) into
# ~/.config/opencode/plugins/* and registers the
# opencode.jsonc + tui.json entries (existing toggles are preserved).
#
# Usage:
#   ./install.sh            # symlink (default; edits in this repo apply after restart)
#   ./install.sh --copy     # copy files instead of symlinking
#   ./install.sh --sidebar=0 --statusline=1
#
# Secrets are never touched. Restart opencode afterwards.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi

node "$REPO_DIR/bin/oc-go-usage-display-init.js" --repo "$REPO_DIR" "$@"

echo "restart opencode to pick up plugin changes"
