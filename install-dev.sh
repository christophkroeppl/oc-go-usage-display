#!/usr/bin/env bash
# Install oc-go-usage-display from the latest successful develop dev-build.
# Downloads the stable `dev-tgz` artifact, sanity-checks the tarball, installs
# it via npm, and registers the plugin (existing toggles are preserved).
#
# Usage:
#   ./install-dev.sh [--branch develop] [--workflow FILE] [--run-id ID]
#                    [--dir ./tmp-dev] [--force|--clean] [--dry-run]
#                    [--sidebar=0/1 --statusline=0/1]
#
# --dry-run stops after download + tarball sanity (no install/register).
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

# Mirror bin/lib.js assertDurableRepoDir: refuse ephemeral /tmp sources.
assertDurableRepoDir() {
  local resolved="$1"
  local candidates=("/tmp")
  if [[ -n "${TMPDIR:-}" ]]; then
    candidates+=("$TMPDIR")
  fi
  for candidate in "${candidates[@]}"; do
    local base
    base="$(resolve_abs "$candidate")"
    if [[ "$resolved" == "$base" || "$resolved" == "$base"/* ]]; then
      echo "error: refusing ephemeral dir under $base: $1" >&2
      exit 1
    fi
  done
}

RESOLVED_DIR="$(resolve_abs "$DIR")"
assertDurableRepoDir "$RESOLVED_DIR"

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
trap 'rm -f "$TAR_LIST"' EXIT
tar -tzf "$TARBALL" | sort > "$TAR_LIST"
for entry in "package/dist/index.js" "package/bin/oc-go-usage-display-init.js"; do
  grep -Fxq "$entry" "$TAR_LIST" || {
    echo "error: tarball missing $entry" >&2
    exit 1
  }
done
echo "tarball contents OK"
trap - EXIT
rm -f "$TAR_LIST"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run: stopping after download (run $RUN_ID -> $TARBALL)"
  exit 0
fi

TARBALL_ABS="$(resolve_abs "$TARBALL")"
(
  cd "$SCRIPT_DIR"
  npm install --no-save "file:$TARBALL_ABS"
  npx --no-install oc-go-usage-display-init --copy "${INIT_ARGS[@]}"
  npx --no-install oc-go-usage-display-show --json
  npx --no-install oc-go-usage-display-status
)

echo "restart opencode to pick up plugin changes"
