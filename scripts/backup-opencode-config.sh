#!/usr/bin/env bash
# Backup opencode config files before test installs.
#
# Backs up 6 files from CONFIG_DIR to BACKUP_ROOT + manifest.json:
#   opencode.jsonc, tui.json,
#   plugins/oc-go-usage-display.ts, plugins/oc-go-usage-display.tsx,
#   oc-go-usage-display.json, oc-go-usage-display-cache.json
#
# Config resolution: --config-dir > $OPENCODE_CONFIG_DIR > ~/.config/opencode
# Backup default: ${TMPDIR:-${TMP:-/tmp}}/oc-go-usage-display-backup-<timestamp-pid>
#
# Manifest entries: [{rel,existed,kind,symlinkTarget,sha256,mode}]
#   existed=false for fresh missing files (skipped, not copied).
#   kind is file|symlink|other|missing (lstat semantics: -L checked first,
#   never stat-through-symlink).
# Secrets: file mode preserved via chmod --reference (never forced to 0664).
set -euo pipefail

RELS=(
  "opencode.jsonc"
  "tui.json"
  "plugins/oc-go-usage-display.ts"
  "plugins/oc-go-usage-display.tsx"
  "oc-go-usage-display.json"
  "oc-go-usage-display-cache.json"
)

BACKUP_DIR=""
CONFIG_DIR_ARG=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: backup-opencode-config.sh [options]

  --backup-dir <path>   backup root (default: ${TMPDIR:-${TMP:-/tmp}}/oc-go-usage-display-backup-<timestamp-pid>)
  --config-dir <path>   config dir (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
  --dry-run             print actions without writing
  -h, --help            show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir=*) BACKUP_DIR="${1#*=}"; shift ;;
    --backup-dir)
      [[ $# -ge 2 && "$2" != --* ]] || { echo "error: --backup-dir requires a value" >&2; exit 1; }
      BACKUP_DIR="$2"; shift 2 ;;
    --config-dir=*) CONFIG_DIR_ARG="${1#*=}"; shift ;;
    --config-dir)
      [[ $# -ge 2 && "$2" != --* ]] || { echo "error: --config-dir requires a value" >&2; exit 1; }
      CONFIG_DIR_ARG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown flag $1 (see --help)" >&2; exit 1 ;;
  esac
done

resolve_abs() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$1"
  else
    node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1"
  fi
}

# --- resolve config dir (--config-dir > $OPENCODE_CONFIG_DIR > ~/.config/opencode)
if [[ -n "$CONFIG_DIR_ARG" ]]; then
  CONFIG_DIR="$CONFIG_DIR_ARG"
elif [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
  CONFIG_DIR="$OPENCODE_CONFIG_DIR"
else
  CONFIG_DIR="$HOME/.config/opencode"
fi

# --- resolve backup root default in system/user tmp
if [[ -z "$BACKUP_DIR" ]]; then
  TMP_BASE="${TMPDIR:-${TMP:-/tmp}}"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$TMP_BASE/oc-go-usage-display-backup-$STAMP-$$"
fi

CONFIG_ABS="$(resolve_abs "$CONFIG_DIR")"
BACKUP_ABS="$(resolve_abs "$BACKUP_DIR")"
HOME_ABS=""
if [[ -n "${HOME:-}" ]]; then
  HOME_ABS="$(resolve_abs "$HOME")"
fi

# --- refuse BACKUP_ROOT == CONFIG_DIR / HOME / / / //
if [[ -z "$BACKUP_ABS" || "$BACKUP_ABS" == "/" || "$BACKUP_ABS" == "//" ]]; then
  echo "error: refusing unsafe --backup-dir '$BACKUP_DIR'" >&2
  exit 1
fi
if [[ "$BACKUP_ABS" == "$CONFIG_ABS" ]]; then
  echo "error: refusing --backup-dir equal to config dir ($CONFIG_ABS)" >&2
  exit 1
fi
if [[ -n "$HOME_ABS" && "$BACKUP_ABS" == "$HOME_ABS" ]]; then
  echo "error: refusing --backup-dir equal to HOME ($HOME_ABS)" >&2
  exit 1
fi

for cmd in sha256sum readlink stat cp chmod mkdir; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: missing required command: $cmd" >&2; exit 1; }
done

# JSON string quoting: node > python3 > naive fallback.
json_quote() {
  local raw="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log(JSON.stringify(process.argv[1] ?? ""))' "$raw"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$raw"
    return
  fi
  local esc="$raw"
  esc="${esc//\\/\\\\}"
  esc="${esc//\"/\\\"}"
  esc="${esc//$'\n'/\\n}"
  esc="${esc//$'\r'/\\r}"
  esc="${esc//$'\t'/\\t}"
  printf '"%s"' "$esc"
}

log() { printf '[backup] %s\n' "$*"; }

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: config-dir $CONFIG_ABS"
  log "dry-run: backup-dir $BACKUP_ABS"
fi

ENTRIES_TMP="$(mktemp)"
trap 'rm -f "$ENTRIES_TMP"' EXIT
: > "$ENTRIES_TMP"
COUNT=0

for rel in "${RELS[@]}"; do
  src="$CONFIG_ABS/$rel"
  dst="$BACKUP_ABS/$rel"

  # lstat semantics: test -L first (never stat through a symlink).
  existed="false"
  kind="missing"
  symlink_target=""
  symlink_json="null"
  sha_json="null"
  mode_json="null"

  if [[ -L "$src" ]]; then
    existed="true"
    kind="symlink"
    symlink_target="$(readlink "$src")"
    symlink_json="$(json_quote "$symlink_target")"
  elif [[ -e "$src" ]]; then
    existed="true"
    if [[ -f "$src" ]]; then
      kind="file"
      sha_val="$(sha256sum "$src" | awk '{print $1}')"
      mode_val="$(stat -c %a "$src")"
      sha_json="$(json_quote "$sha_val")"
      mode_json="$(json_quote "$mode_val")"
    else
      kind="other"
      if mode_tmp="$(stat -c %a "$src" 2>/dev/null)"; then
        mode_json="$(json_quote "$mode_tmp")"
      fi
    fi
  else
    existed="false"
    kind="missing"
  fi

  rel_json="$(json_quote "$rel")"
  printf '{"rel":%s,"existed":%s,"kind":"%s","symlinkTarget":%s,"sha256":%s,"mode":%s}' \
    "$rel_json" "$existed" "$kind" "$symlink_json" "$sha_json" "$mode_json" >> "$ENTRIES_TMP"
  printf '\n' >> "$ENTRIES_TMP"
  COUNT=$((COUNT + 1))

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$existed" == "false" ]]; then
      log "dry-run: skip missing $rel (existed=false)"
    else
      log "dry-run: would copy $kind $rel -> $dst"
    fi
    continue
  fi

  if [[ "$existed" == "false" ]]; then
    log "skip missing $rel (existed=false)"
    continue
  fi

  if [[ "$kind" == "file" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -p --preserve=all "$src" "$dst"
    # Preserve secret file mode exactly (never force 0664).
    chmod --reference="$src" "$dst"
    src_sha="$(sha256sum "$src" | awk '{print $1}')"
    dst_sha="$(sha256sum "$dst" | awk '{print $1}')"
    if [[ "$src_sha" != "$dst_sha" ]]; then
      echo "error: sha256 mismatch after copy: $rel ($src_sha != $dst_sha)" >&2
      exit 1
    fi
    log "backed up file $rel"
  elif [[ "$kind" == "symlink" ]]; then
    mkdir -p "$(dirname "$dst")"
    rm -f "$dst"
    cp -P "$src" "$dst"
    src_link="$(readlink "$src")"
    dst_link="$(readlink "$dst")"
    if [[ "$src_link" != "$dst_link" ]]; then
      echo "error: readlink mismatch after copy: $rel ($src_link != $dst_link)" >&2
      exit 1
    fi
    log "backed up symlink $rel -> $src_link"
  else
    log "warn: skipping other file type ($kind): $rel"
  fi
done

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: would write manifest.json with $COUNT entries"
  trap - EXIT
  rm -f "$ENTRIES_TMP"
  exit 0
fi

mkdir -p "$BACKUP_ABS"
{
  printf '[\n'
  first=1
  while IFS= read -r line; do
    if [[ "$first" == "1" ]]; then
      first=0
      printf '  %s' "$line"
    else
      printf ',\n  %s' "$line"
    fi
  done < "$ENTRIES_TMP"
  printf '\n]\n'
} > "$BACKUP_ABS/manifest.json"

trap - EXIT
rm -f "$ENTRIES_TMP"

log "manifest: $BACKUP_ABS/manifest.json ($COUNT entries)"
log "backup-dir: $BACKUP_ABS"
