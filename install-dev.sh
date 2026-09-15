#!/usr/bin/env bash
# Install oc-go-usage-display from the latest successful develop dev-build.
# Downloads the stable `dev-tgz` artifact, sanity-checks the tarball, snapshots
# the 6 OpenCode config files, installs it via npm, and registers the plugin
# (existing toggles are preserved).
#
# There is no auto-restore: the snapshot path and the restore command are
# printed at the end, and on install failure before exiting non-zero.
#
# Usage:
#   ./install-dev.sh [--branch develop] [--workflow FILE] [--run-id ID]
#                    [--dir ./tmp-dev] [--force|--clean] [--dry-run]
#                    [--config-dir PATH] [--backup-dir PATH]
#                    [--sidebar=0/1 --statusline=0/1]
#
# Restore after testing:
#   scripts/dev-config-snapshot.sh restore --backup-dir <snapshot path>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT_SCRIPT="$SCRIPT_DIR/scripts/dev-config-snapshot.sh"
BRANCH="develop"
WORKFLOW=""
RUN_ID=""
DIR="./tmp-dev"
ART="dev-tgz"
FORCE=0
CLEAN=0
DRY_RUN=0
BACKUP_DIR=""
CONFIG_DIR_ARG=""
INIT_ARGS=()

usage() {
  cat <<'EOF'
Usage: install-dev.sh [options]

  --branch <name>        workflow branch to query (default: develop)
  --workflow <file>      limit run lookup to a workflow file (e.g. dev-build.yml)
  --run-id <id>          use a specific run id (skips run lookup)
  --dir <path>           download dir (default: ./tmp-dev)
  --force, --clean       allow/replace a non-empty download dir
  --dry-run              stop after download + tarball sanity check
  --sidebar=0/1          passthrough to oc-go-usage-display-init
  --statusline=0/1       passthrough to oc-go-usage-display-init
  --config-dir <path>    opencode config dir (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
  --backup-dir <path>    snapshot root (default: tmp oc-go-usage-display-backup)
  -h, --help             show this help

Restore after testing:
  scripts/dev-config-snapshot.sh restore --backup-dir <snapshot path>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift 2 ;;
    --workflow=*) WORKFLOW="${1#*=}"; shift ;;
    --workflow) WORKFLOW="${2:?--workflow requires a value}"; shift 2 ;;
    --run-id=*) RUN_ID="${1#*=}"; shift ;;
    --run-id) RUN_ID="${2:?--run-id requires a value}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --dir) DIR="${2:?--dir requires a value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --backup-dir=*) BACKUP_DIR="${1#*=}"; shift ;;
    --backup-dir)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "error: --backup-dir requires a value" >&2
        exit 1
      fi
      BACKUP_DIR="$2"
      shift 2
      ;;
    --config-dir=*) CONFIG_DIR_ARG="${1#*=}"; shift ;;
    --config-dir)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "error: --config-dir requires a value" >&2
        exit 1
      fi
      CONFIG_DIR_ARG="$2"
      shift 2
      ;;
    --sidebar=*|--statusline=*) INIT_ARGS+=("$1"); shift ;;
    --sidebar|--statusline)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "error: $1 requires a value (0/1)" >&2
        exit 1
      fi
      INIT_ARGS+=("$1=$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown flag $1 (see --help)" >&2; exit 1 ;;
  esac
done

for cmd in gh node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd is required" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || {
  echo "error: gh is not authenticated (run gh auth login)" >&2
  exit 1
}
[[ -x "$SNAPSHOT_SCRIPT" ]] || {
  echo "error: missing snapshot script: $SNAPSHOT_SCRIPT" >&2
  exit 1
}

resolve_abs() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$1"
  else
    node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1"
  fi
}

# Last line of defense for --clean/--force: never `rm -rf` a shared or
# system root. Complements the argument guards below.
assert_safe_clean_target() {
  local resolved="$1"
  local refused=("" "/" "//" "/tmp" "$(resolve_abs "${TMPDIR:-${TMP:-/tmp}}")")
  if [[ -n "${HOME:-}" ]]; then
    refused+=("$(resolve_abs "$HOME")")
  fi
  refused+=("$(resolve_abs ".")")
  for target in "${refused[@]}"; do
    if [[ "$resolved" == "$target" ]]; then
      echo "error: refusing to remove unsafe directory '$resolved' (choose a dedicated subdir like ./tmp-dev)" >&2
      exit 1
    fi
  done
}

RESOLVED_DIR="$(resolve_abs "$DIR")"

# Refuse destructive targets for --force/--clean (rm -rf safety).
if [[ -z "$RESOLVED_DIR" || "$RESOLVED_DIR" == "/" || "$RESOLVED_DIR" == "//" ]]; then
  echo "error: refusing unsafe --dir '$DIR'" >&2
  exit 1
fi
if [[ -n "${HOME:-}" && "$RESOLVED_DIR" == "$HOME" ]]; then
  echo "error: refusing --dir that is HOME ($HOME)" >&2
  exit 1
fi
if [[ "$RESOLVED_DIR" == "$(resolve_abs ".")" ]]; then
  echo "error: refusing --dir that is the current directory (use a subdir like ./tmp-dev)" >&2
  exit 1
fi

if [[ -d "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null || true)" ]]; then
  if [[ "$CLEAN" == "1" || "$FORCE" == "1" ]]; then
    assert_safe_clean_target "$RESOLVED_DIR"
    echo "cleaning existing dir $DIR"
    rm -rf "$DIR"
  else
    echo "error: $DIR is not empty (use --force or --clean)" >&2
    exit 1
  fi
fi
mkdir -p "$DIR"

if [[ -z "$RUN_ID" ]]; then
  LIST_ARGS=(run list --branch "$BRANCH" --status success --limit 1 --json databaseId,headSha)
  if [[ -n "$WORKFLOW" ]]; then
    LIST_ARGS+=(--workflow "$WORKFLOW")
  fi
  RUN_JSON="$(gh "${LIST_ARGS[@]}")"
  PARSED="$(printf '%s' "$RUN_JSON" | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try {
        const runs = JSON.parse(data);
        if (!Array.isArray(runs) || runs.length === 0) {
          console.error("error: no successful runs found");
          process.exit(1);
        }
        console.log(`${runs[0].databaseId} ${runs[0].headSha ?? ""}`);
      } catch {
        console.error("error: cannot parse run list JSON");
        process.exit(1);
      }
    });
  ')"
  RUN_ID="${PARSED%% *}"
  HEAD_SHA="${PARSED#* }"
  if [[ -z "$RUN_ID" ]]; then
    echo "error: could not resolve run id" >&2
    exit 1
  fi
  echo "using run $RUN_ID (branch $BRANCH, sha ${HEAD_SHA:-unknown})"
fi

gh run download "$RUN_ID" -n "$ART" -D "$DIR"

shopt -s nullglob
TARBALLS=("$DIR"/*.tgz)
shopt -u nullglob
if [[ "${#TARBALLS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one *.tgz in $DIR, found ${#TARBALLS[@]}" >&2
  exit 1
fi
TARBALL="${TARBALLS[0]}"
echo "tarball: $TARBALL"

TARBALL_LIST="$(tar -tzf "$TARBALL")"
for entry in "package/dist/index.js" "package/bin/oc-go-usage-display-init.js"; do
  grep -Fxq "$entry" <<<"$TARBALL_LIST" || {
    echo "error: tarball missing $entry" >&2
    exit 1
  }
done
echo "tarball contents OK"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run: stopping after download (run $RUN_ID -> $TARBALL)"
  exit 0
fi

CONFIG_FORWARD=()
if [[ -n "$CONFIG_DIR_ARG" ]]; then
  CONFIG_FORWARD=(--config-dir "$CONFIG_DIR_ARG")
fi
BACKUP_FORWARD=()
if [[ -n "$BACKUP_DIR" ]]; then
  BACKUP_FORWARD=(--backup-dir "$BACKUP_DIR")
fi

# Fail closed: abort before any mutation if the snapshot cannot be taken.
SNAPSHOT_DIR=""
if ! SNAPSHOT_DIR="$("$SNAPSHOT_SCRIPT" save ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"} ${BACKUP_FORWARD[@]+"${BACKUP_FORWARD[@]}"})"; then
  echo "error: config snapshot failed, refusing to install (nothing was changed)" >&2
  exit 1
fi
echo "config snapshot: $SNAPSHOT_DIR"

print_reminder() {
  local restore_cmd="scripts/dev-config-snapshot.sh restore --backup-dir $SNAPSHOT_DIR"
  if [[ -n "$CONFIG_DIR_ARG" ]]; then
    restore_cmd+=" --config-dir $CONFIG_DIR_ARG"
  fi
  printf '\n%s\n' "----------------------------------------------------------------"
  echo "To restore your previous OpenCode config:"
  echo "  $restore_cmd"
  echo "To return to the published version instead:"
  echo "  npx -y -p oc-go-usage-display@latest oc-go-usage-display-init --copy"
  printf '%s\n\n' "----------------------------------------------------------------"
}

install_dev() {
  (
    cd "$SCRIPT_DIR" || exit 1
    npm install --no-save "file:$(resolve_abs "$TARBALL")" || exit 1
    npx --no-install oc-go-usage-display-init --copy ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"} || exit 1
    npx --no-install oc-go-usage-display-show --json ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"} \
      || echo "warning: show --json failed (best-effort)"
    npx --no-install oc-go-usage-display-status ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"} \
      || echo "warning: status failed (best-effort)"
  )
}

install_rc=0
install_dev || install_rc=$?
if [[ "$install_rc" -ne 0 ]]; then
  echo "error: dev install failed after the config snapshot was taken" >&2
  print_reminder >&2
  exit 1
fi

print_reminder
echo "restart opencode to pick up plugin changes"
