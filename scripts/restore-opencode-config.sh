#!/usr/bin/env bash
# Restore opencode config files from a backup-opencode-config.sh backup root.
#
# Reads <backup-dir>/manifest.json [{rel,existed,kind,symlinkTarget,sha256,mode}]:
#   existed=false + target missing -> noop
#   existed=false + target exists  -> rm -f (+ rmdir plugins if empty)
#   kind=file    -> rm + cp -p --preserve + chmod --reference + sha256 verify
#   kind=symlink -> rm + cp -P (or ln -s from manifest target) + readlink verify
#   kind=other / missing backup file -> warn, keep going
# Never rm -rf's the config dir. JSONC parse smoke test runs at the end.
set -euo pipefail

BACKUP_DIR=""
CONFIG_DIR_ARG=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: restore-opencode-config.sh [options]

  --backup-dir <path>   backup root containing manifest.json (required)
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

if [[ -z "$BACKUP_DIR" ]]; then
  echo "error: --backup-dir is required" >&2
  exit 1
fi

resolve_abs() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$1"
  else
    node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1"
  fi
}

if [[ -n "$CONFIG_DIR_ARG" ]]; then
  CONFIG_DIR="$CONFIG_DIR_ARG"
elif [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
  CONFIG_DIR="$OPENCODE_CONFIG_DIR"
else
  CONFIG_DIR="$HOME/.config/opencode"
fi

CONFIG_ABS="$(resolve_abs "$CONFIG_DIR")"
BACKUP_ABS="$(resolve_abs "$BACKUP_DIR")"

# Never rm -rf the config dir: refuse empty/root-shaped targets.
if [[ -z "$CONFIG_ABS" || "$CONFIG_ABS" == "/" || "$CONFIG_ABS" == "//" ]]; then
  echo "error: refusing unsafe --config-dir '$CONFIG_DIR'" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_ABS/manifest.json" ]]; then
  echo "error: manifest not found: $BACKUP_ABS/manifest.json" >&2
  exit 1
fi

for cmd in sha256sum readlink cp chmod mkdir; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: missing required command: $cmd" >&2; exit 1; }
done

log() { printf '[restore] %s\n' "$*"; }
warn() { printf '[restore] WARN: %s\n' "$*" >&2; }

# Emit manifest as USV-delimited rows: rel \x1f existed \x1f kind \x1f symlinkB64 \x1f sha \x1f mode
# (0x1f is non-whitespace so bash read preserves empty fields; base64
# shields spaces/quotes in symlink targets).
manifest_tsv() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("node:fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!Array.isArray(m)) { console.error("manifest is not an array"); process.exit(1); }
      for (const e of m) {
        const b64 = Buffer.from(e.symlinkTarget ?? "", "utf8").toString("base64");
        console.log([e.rel ?? "", String(e.existed), e.kind ?? "", b64, e.sha256 ?? "", e.mode ?? ""].join("\x1f"));
      }
    ' "$BACKUP_ABS/manifest.json"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import base64, json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
assert isinstance(m, list), "manifest is not an array"
for e in m:
    b64 = base64.b64encode((e.get("symlinkTarget") or "").encode("utf-8")).decode()
    print("\x1f".join([e.get("rel") or "", str(e.get("existed")), e.get("kind") or "", b64, e.get("sha256") or "", e.get("mode") or ""]))
' "$BACKUP_ABS/manifest.json"
    return
  fi
  echo "error: node or python3 is required to read manifest.json" >&2
  exit 1
}

b64dec() {
  [[ -z "${1:-}" ]] && return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import base64,sys; print(base64.b64decode(sys.argv[1]).decode("utf-8"), end="")' "$1"
  else
    echo "$1" | base64 -d
  fi
}

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: backup-dir $BACKUP_ABS"
  log "dry-run: config-dir $CONFIG_ABS"
fi

while IFS=$'\x1f' read -r rel existed kind link_b64 sha mode; do
  [[ -n "$rel" ]] || continue
  target="$CONFIG_ABS/$rel"
  backup_path="$BACKUP_ABS/$rel"
  link_target=""
  if [[ -n "$link_b64" ]]; then
    link_target="$(b64dec "$link_b64")"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: would restore existed=$existed kind=$kind $rel"
    continue
  fi

  # Fresh-missing case: file did not exist at backup time.
  if [[ "$existed" == "false" ]]; then
    if [[ ! -e "$target" && ! -L "$target" ]]; then
      log "noop (still missing): $rel"
    elif [[ -L "$target" || -f "$target" ]]; then
      rm -f "$target"
      log "removed created file: $rel"
      if [[ "$rel" == plugins/* ]]; then
        rmdir -- "$CONFIG_ABS/plugins" 2>/dev/null || true
      fi
    else
      warn "not a file/symlink, keeping: $target"
    fi
    continue
  fi

  if [[ "$kind" == "file" ]]; then
    if [[ ! -f "$backup_path" ]]; then
      warn "missing backup file, keeping target: $rel"
      continue
    fi
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ ! -L "$target" && ! -f "$target" ]]; then
        warn "not a file/symlink, keeping: $target"
        continue
      fi
      rm -f "$target"
    fi
    mkdir -p "$(dirname "$target")"
    cp -p --preserve=all "$backup_path" "$target"
    chmod --reference="$backup_path" "$target"
    if [[ -n "$sha" ]]; then
      got="$(sha256sum "$target" | awk '{print $1}')"
      if [[ "$got" != "$sha" ]]; then
        echo "error: sha256 mismatch after restore: $rel (got $got, want $sha)" >&2
        exit 1
      fi
    fi
    log "restored file $rel"
  elif [[ "$kind" == "symlink" ]]; then
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ ! -L "$target" && ! -f "$target" ]]; then
        warn "not a file/symlink, keeping: $target"
        continue
      fi
      rm -f "$target"
    fi
    mkdir -p "$(dirname "$target")"
    if [[ -L "$backup_path" ]]; then
      rm -f "$target"
      cp -P "$backup_path" "$target"
    elif [[ -n "$link_target" ]]; then
      ln -s "$link_target" "$target"
    else
      warn "missing backup symlink and no manifest target: $rel"
      continue
    fi
    got_link="$(readlink "$target")"
    if [[ "$got_link" != "$link_target" ]]; then
      echo "error: readlink mismatch after restore: $rel (got $got_link, want $link_target)" >&2
      exit 1
    fi
    log "restored symlink $rel -> $got_link"
  else
    warn "unsupported kind ($kind), keeping target: $rel"
  fi
done < <(manifest_tsv)

# JSONC parse smoke: restored configs must still parse.
if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: skipping JSONC smoke test"
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("node:fs");
    function strip(text) {
      let out = "", inStr = false, esc = false, line = false, block = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i], nx = text[i + 1];
        if (line) { if (ch === "\n") { line = false; out += ch; } continue; }
        if (block) { if (ch === "*" && nx === "/") { block = false; i++; } continue; }
        if (inStr) { out += ch; if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
        if (ch === "\"") { inStr = true; out += ch; continue; }
        if (ch === "/" && nx === "/") { line = true; i++; continue; }
        if (ch === "/" && nx === "*") { block = true; i++; continue; }
        out += ch;
      }
      return out;
    }
    for (const rel of ["opencode.jsonc", "tui.json"]) {
      const p = require("node:path").join(process.argv[1], rel);
      let raw;
      try { raw = fs.readFileSync(p, "utf8"); }
      catch { console.log("[restore] smoke: missing (ok): " + rel); continue; }
      try { JSON.parse(strip(raw)); }
      catch (e) { console.error("error: JSONC parse failed after restore: " + p); process.exit(1); }
      console.log("[restore] smoke: parse OK: " + rel);
    }
  ' "$CONFIG_ABS"
else
  warn "node unavailable, skipping JSONC smoke test"
fi

log "restore complete from $BACKUP_ABS"
