#!/usr/bin/env bash
# Snapshot/restore the 6 OpenCode config paths mutated by a dev install.
# save writes <backup-dir>/<timestamp>/{manifest,files/<rel>...} and prints
# the absolute snapshot dir (only stdout line); restore replays present (copy
# back with original type/mode) / absent (delete if created since).
# Default backup root: ${TMPDIR:-/tmp}/oc-go-usage-display-backup.
set -euo pipefail
RELS=("opencode.jsonc" "tui.json" "plugins/oc-go-usage-display.ts" "plugins/oc-go-usage-display.tsx" "oc-go-usage-display.json" "oc-go-usage-display-cache.json")
MODE="${1:-}"; shift || true
BACKUP_DIR=""; CONFIG_DIR_ARG=""
usage() {
  cat <<'EOF'
Usage:
  dev-config-snapshot.sh save    --config-dir <dir> [--backup-dir <dir>]
  dev-config-snapshot.sh restore --backup-dir <dir> [--config-dir <dir>]
  (--snapshot <dir> aliases --backup-dir in both modes)

  --config-dir <dir>  default: $OPENCODE_CONFIG_DIR or ~/.config/opencode
  --backup-dir <dir>  save: snapshot root (default ${TMPDIR:-/tmp}/oc-go-usage-display-backup)
                      restore: the snapshot dir printed by save
EOF
}
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '[snapshot] %s\n' "$*" >&2; }

abspath() {
  if command -v realpath >/dev/null 2>&1; then realpath -m "$1"
  else case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac
  fi
}
take_arg() { [[ $# -ge 2 && "$2" != -* ]] || die "$1 requires a value"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir=*|--snapshot=*) BACKUP_DIR="${1#*=}"; shift ;;
    --backup-dir|--snapshot) take_arg "$1" "${2:-}"; BACKUP_DIR="$2"; shift 2 ;;
    --config-dir=*) CONFIG_DIR_ARG="${1#*=}"; shift ;;
    --config-dir) take_arg "$1" "${2:-}"; CONFIG_DIR_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag '$1' (see --help)" ;;
  esac
done
[[ "$MODE" == "save" || "$MODE" == "restore" ]] || case "$MODE" in
  -h|--help) usage; exit 0 ;;
  *) die "expected mode 'save' or 'restore', got '${MODE:-none}' (see --help)" ;;
esac

if [[ -n "$CONFIG_DIR_ARG" ]]; then CONFIG_DIR="$CONFIG_DIR_ARG"
elif [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then CONFIG_DIR="$OPENCODE_CONFIG_DIR"
else CONFIG_DIR="${HOME:-}/.config/opencode"; fi
CONFIG_ABS="$(abspath "$CONFIG_DIR")"
case "$CONFIG_ABS" in ""|/|//) die "refusing unsafe config dir '$CONFIG_DIR'" ;; esac

if [[ "$MODE" == "save" ]]; then
  [[ -n "$BACKUP_DIR" ]] || BACKUP_DIR="${TMPDIR:-/tmp}/oc-go-usage-display-backup"
  BACKUP_ABS="$(abspath "$BACKUP_DIR")"
  case "$BACKUP_ABS" in ""|/|//) die "refusing unsafe backup dir '$BACKUP_DIR'" ;; esac
  [[ "$BACKUP_ABS" != "$CONFIG_ABS" ]] || die "backup dir must differ from config dir"
  SNAPSHOT="$BACKUP_ABS/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$SNAPSHOT/files"
  : > "$SNAPSHOT/manifest"
  present=0; absent=0
  for rel in "${RELS[@]}"; do
    src="$CONFIG_ABS/$rel"
    if [[ -L "$src" ]]; then kind=link
    elif [[ -f "$src" ]]; then kind=file
    else kind=missing; fi
    if [[ "$kind" == "missing" ]]; then
      printf 'absent\t%s\n' "$rel" >> "$SNAPSHOT/manifest"
      absent=$((absent + 1))
      continue
    fi
    mkdir -p "$SNAPSHOT/files/$(dirname "$rel")"
    if [[ "$kind" == "link" ]]; then cp -P "$src" "$SNAPSHOT/files/$rel"
    else cp -p "$src" "$SNAPSHOT/files/$rel"; fi
    printf 'present\t%s\n' "$rel" >> "$SNAPSHOT/manifest"
    present=$((present + 1))
  done
  log "config dir: $CONFIG_ABS"
  log "snapshot complete: $present present, $absent absent -> $SNAPSHOT"
  printf '%s\n' "$SNAPSHOT"
  exit 0
fi
[[ -n "$BACKUP_DIR" ]] || die "restore requires --backup-dir <snapshot dir>"
SNAPSHOT="$(abspath "$BACKUP_DIR")"
[[ -f "$SNAPSHOT/manifest" ]] || die "manifest not found: $SNAPSHOT/manifest"
replace_target() {
  if [[ -L "$1" || -f "$1" ]]; then rm -f "$1"
  elif [[ -e "$1" ]]; then die "refusing to replace non-file: $1"; fi
  mkdir -p "$(dirname "$1")"
}
restored=0; removed=0; noop=0
while IFS=$'\t' read -r state rel; do
  [[ -n "$rel" ]] || continue
  case "$rel" in /*|*..*) die "unsafe path in manifest: $rel" ;; esac
  target="$CONFIG_ABS/$rel"
  if [[ "$state" == "present" ]]; then
    payload="$SNAPSHOT/files/$rel"
    [[ -L "$payload" || -f "$payload" ]] || die "missing snapshot payload for $rel"
    replace_target "$target"
    if [[ -L "$payload" ]]; then
      cp -P "$payload" "$target"; log "restored symlink $rel -> $(readlink "$target")"
    else
      cp -p "$payload" "$target"; log "restored file $rel"
    fi
    restored=$((restored + 1))
  elif [[ "$state" == "absent" ]]; then
    if [[ -L "$target" || -f "$target" ]]; then
      rm -f "$target"
      [[ "$rel" == plugins/* ]] && rmdir -- "$CONFIG_ABS/plugins" 2>/dev/null || true
      log "removed created path $rel"
      removed=$((removed + 1))
    else
      noop=$((noop + 1))
    fi
  else
    die "unknown manifest state '$state' for $rel"
  fi
done < "$SNAPSHOT/manifest"
log "config dir: $CONFIG_ABS"
log "restore complete: $restored restored, $removed removed, $noop untouched"
