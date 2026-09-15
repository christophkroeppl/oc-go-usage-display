// Pure helpers shared by the plugin entry modules.
//
// IMPORTANT: these live OUTSIDE `src/index.ts` / `src/tui.tsx`. OpenCode's
// loader enumerates every export of a plugin entry module and (when the
// default is not a `{ id, server }` module) invokes each one as a plugin
// factory. An entry module must therefore export ONLY its default module;
// keeping the helper surface here makes that contract structural instead of
// accidental (a stray `export function` returning null used to crash
// `Provider.list`).
//
// Unit-tested via `dist/helpers.js` (see test/unit/server.test.js and
// test/unit/tui.test.js).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR,
  formatResetDuration,
  isRecord,
  toNonEmptyString,
} from "./shared.js";
import type { UsageSnapshot, UsageWindow } from "./shared.js";

// ---------------------------------------------------------------------------
// Server: compact one-line snapshot summary (keeps the rolling reset suffix)
// ---------------------------------------------------------------------------

function formatWindow(window: UsageWindow | null): string {
  if (!window) return "n/a";
  return `${window.percent}%`;
}

export function formatServerLine(snapshot: UsageSnapshot): string {
  if (snapshot.apiUnavailable || (!snapshot.rolling && !snapshot.weekly && !snapshot.monthly)) {
    const reason = snapshot.apiError ?? "unknown error";
    return `Go n/a (${reason})`;
  }
  const rollingReset =
    formatResetDuration(snapshot.rolling?.resetInSec ?? null) ??
    snapshot.rolling?.resetText ??
    null;
  const rollingText =
    snapshot.rolling === null
      ? "5h n/a"
      : `5h ${snapshot.rolling.percent}%${rollingReset ? ` (reset ${rollingReset})` : ""}`;
  return `Go ${rollingText} | 7d ${formatWindow(snapshot.weekly)} | 30d ${formatWindow(snapshot.monthly)}`;
}

// ---------------------------------------------------------------------------
// Server: auth cookie boundary (malformed-cookie rejection; never logged)
// ---------------------------------------------------------------------------

export type FileConfig = { workspaceId: string | null; authCookie: string | null };

const FILE_CONFIG_PATH = path.join(CONFIG_DIR, "oc-go-usage-display.json");

export function readFileConfig(): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(FILE_CONFIG_PATH, "utf8");
  } catch {
    return { workspaceId: null, authCookie: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { workspaceId: null, authCookie: null };
  }
  if (!isRecord(parsed)) return { workspaceId: null, authCookie: null };
  return {
    workspaceId: toNonEmptyString(parsed.workspaceId),
    authCookie: toNonEmptyString(parsed.authCookie),
  };
}

export function isMalformedAuthCookie(cookie: string): boolean {
  // Reject CR/LF (header injection), separators that confuse cookie jars,
  // plus tab, NUL, and double-quote (never valid in a cookie value).
  return /[\r\n;,\t\0"]/.test(cookie);
}

export function hasMalformedAuthCookie(fileConfig: FileConfig = readFileConfig()): boolean {
  const raw =
    toNonEmptyString(process.env.OPENCODE_GO_AUTH_COOKIE) ?? fileConfig.authCookie;
  if (!raw) return false;
  return isMalformedAuthCookie(raw);
}

// ---------------------------------------------------------------------------
// TUI: display-mode + snapshot shaping
// ---------------------------------------------------------------------------

export type DisplayMode = "sidebar" | "statusline" | "both";

export type SurfaceSelection = {
  sidebar: boolean;
  statusline: boolean;
};

export type UsageRow = {
  label: string;
  value: string;
};

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "sidebar" || value === "statusline" || value === "both";
}

export function surfaceSelectionFromDisplayMode(mode: DisplayMode): SurfaceSelection {
  return { sidebar: mode !== "statusline", statusline: mode !== "sidebar" };
}

export function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

export function isSnapshotEmpty(snapshot: UsageSnapshot): boolean {
  return snapshot.rolling === null && snapshot.weekly === null && snapshot.monthly === null;
}

export function formatStatusline(snapshot: UsageSnapshot): string {
  const rolling = snapshot.rolling === null ? "5h n/a" : `5h ${snapshot.rolling.percent}%`;
  const weekly = snapshot.weekly === null ? "7d n/a" : `7d ${snapshot.weekly.percent}%`;
  const monthly = snapshot.monthly === null ? "30d n/a" : `30d ${snapshot.monthly.percent}%`;
  return `Go ${rolling} | ${weekly} | ${monthly}`;
}

export function buildUsageRows(snapshot: UsageSnapshot): UsageRow[] {
  const rows: UsageRow[] = [];
  if (snapshot.rolling !== null) {
    const reset = formatResetDuration(snapshot.rolling.resetInSec) ?? snapshot.rolling.resetText;
    rows.push({ label: "5h", value: `${snapshot.rolling.percent}%${reset ? ` · resets ${reset}` : ""}` });
  }
  if (snapshot.weekly !== null) rows.push({ label: "7d", value: `${snapshot.weekly.percent}%` });
  if (snapshot.monthly !== null) rows.push({ label: "30d", value: `${snapshot.monthly.percent}%` });
  return rows;
}
