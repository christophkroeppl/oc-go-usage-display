#!/usr/bin/env bash
# Install oc-go-usage-display from the latest successful develop dev-build.
# Downloads the stable `dev-tgz` artifact, sanity-checks the tarball, installs
# it via npm, and registers the plugin (existing toggles are preserved).
#
# Usage:
#   ./install-dev.sh [--branch develop] [--workflow FILE] [--run-id ID]
#                    [--dir ./tmp-dev] [--force|--clean] [--dry-run]
#                    [--sidebar=0/1 --statusline=0/1]
#                    [--config-dir PATH] [--backup-dir PATH]
#                    [--no-restore] [--backup-only] [--restore-only]
#
# --dry-run stops after download + tarball sanity (no install/register).
# Config safety: the 6 opencode config files are backed up before any
# mutation (default backup root under ${TMPDIR:-${TMP:-/tmp}}) and restored
# on EXIT/INT/TERM unless --no-restore. --backup-only/--restore-only run
# only that step. A failed backup aborts before any mutation (fail closed).
# Secrets are never touched. Restart opencode afterwards.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
NO_RESTORE=0
BACKUP_ONLY=0
RESTORE_ONLY=0
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
  --backup-dir <path>    backup root (default: tmp oc-go-usage-display-backup-<timestamp-pid>)
  --no-restore           keep installed files, skip auto-restore on exit
  --backup-only          only back up config files, then exit
  --restore-only         only restore config files from --backup-dir, then exit
  -h, --help             show this help
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
    --no-restore) NO_RESTORE=1; shift ;;
    --backup-only) BACKUP_ONLY=1; shift ;;
    --restore-only) RESTORE_ONLY=1; shift ;;
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

if [[ "$BACKUP_ONLY" == "1" && "$RESTORE_ONLY" == "1" ]]; then
  echo "error: --backup-only and --restore-only are mutually exclusive" >&2
  exit 1
fi

# --- config backup/restore (test-install safety) -----------------------------
TMP_BASE="${TMPDIR:-${TMP:-/tmp}}"
if [[ -z "$BACKUP_DIR" ]]; then
  BACKUP_DIR="$TMP_BASE/oc-go-usage-display-backup-$(date +%Y%m%d-%H%M%S)-$$"
fi
BACKUP_SCRIPT="$SCRIPT_DIR/scripts/backup-opencode-config.sh"
RESTORE_SCRIPT="$SCRIPT_DIR/scripts/restore-opencode-config.sh"
CONFIG_FORWARD=()
if [[ -n "$CONFIG_DIR_ARG" ]]; then
  CONFIG_FORWARD=(--config-dir "$CONFIG_DIR_ARG")
fi
BACKUP_DONE=0
TAR_LIST=""
# Unified exit/signal trap: auto-restores the backup (unless opted out) and
# always removes the tarball list temp file. Chains the old TAR_LIST trap.
trap 'rc=$?; if [[ "$BACKUP_DONE" == "1" && "$NO_RESTORE" == "0" && "$BACKUP_ONLY" == "0" && "$RESTORE_ONLY" == "0" ]]; then "$RESTORE_SCRIPT" --backup-dir "$BACKUP_DIR" ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"} 2>&1 || echo "warning: restore failed (backup kept at $BACKUP_DIR)" >&2; fi; if [[ -n "${TAR_LIST:-}" ]]; then rm -f "$TAR_LIST"; fi; exit $rc' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$RESTORE_ONLY" == "1" ]]; then
  "$RESTORE_SCRIPT" --backup-dir "$BACKUP_DIR" ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"}
  exit $?
fi

# Fail closed: abort before any mutation if the backup cannot be taken.
if ! "$BACKUP_SCRIPT" --backup-dir "$BACKUP_DIR" ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"}; then
  echo "error: config backup failed, refusing to continue (nothing was changed)" >&2
  exit 1
fi
BACKUP_DONE=1

if [[ "$BACKUP_ONLY" == "1" ]]; then
  echo "backup-only: backup at $BACKUP_DIR, exiting without install"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh is required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required" >&2
  exit 1
fi
gh auth status >/dev/null 2>&1 || {
  echo "error: gh is not authenticated (run gh auth login)" >&2
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

TAR_LIST="$(mktemp)"
tar -tzf "$TARBALL" | sort > "$TAR_LIST"
for entry in "package/dist/index.js" "package/bin/oc-go-usage-display-init.js"; do
  grep -Fxq "$entry" "$TAR_LIST" || {
    echo "error: tarball missing $entry" >&2
    exit 1
  }
done
echo "tarball contents OK"
rm -f "$TAR_LIST"
TAR_LIST=""

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run: stopping after download (run $RUN_ID -> $TARBALL)"
  exit 0
fi

TARBALL_ABS="$(resolve_abs "$TARBALL")"
(
  cd "$SCRIPT_DIR"
  npm install --no-save "file:$TARBALL_ABS"
  npx --no-install oc-go-usage-display-init --copy "${INIT_ARGS[@]}" ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"}
  npx --no-install oc-go-usage-display-show --json ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"}
  npx --no-install oc-go-usage-display-status ${CONFIG_FORWARD[@]+"${CONFIG_FORWARD[@]}"}
)

echo "restart opencode to pick up plugin changes"
