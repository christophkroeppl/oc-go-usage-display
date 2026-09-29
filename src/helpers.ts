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
import {
  resolveHostRoots,
  formatResetDuration,
  hostEnv,
  isRecord,
  resolveUsageHost,
  safeJoinPath,
  toNonEmptyString,
} from "./shared.js";
import type { UsageHost, UsageSnapshot, UsageWindow } from "./shared.js";

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

export function fileConfigPath(host: UsageHost = "opencode"): string {
  return safeJoinPath(resolveHostRoots(host).configDir, "oc-go-usage-display.json");
}

export function readFileConfig(host: UsageHost = "opencode"): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(fileConfigPath(host), "utf8");
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

export function hasMalformedAuthCookie(
  fileConfig: FileConfig = readFileConfig(),
  host: UsageHost = resolveUsageHost(),
): boolean {
  const raw = toNonEmptyString(hostEnv(host, "AUTH_COOKIE")) ?? fileConfig.authCookie;
  if (!raw) return false;
  return isMalformedAuthCookie(raw);
}

// ---------------------------------------------------------------------------
// Server: cookie-fetch redirect policy
// ---------------------------------------------------------------------------
//
// The workspace scrape carries the user's `auth` cookie. Automatic redirect
// following may re-send caller headers (including the cookie) to a cross-origin
// Location, and runtime header stripping cannot be relied on to prevent that.
// The cookie path therefore requests `redirect: "manual"` and re-sends only
// after these helpers approve a Location on the allowlisted canonical HTTPS
// hosts. `fetchViaApiKey` is untouched (anonymous API path).

const ALLOWED_REDIRECT_HOSTS = new Set(["opencode.ai", "auth.opencode.ai"]);

// Follow at most this many redirects before giving up (a redirect loop or an
// endless login bounce becomes a clear unavailable snapshot instead of a hang).
export const MAX_REDIRECT_HOPS = 3;

export type RedirectDecision =
  | { follow: true; url: string }
  | { follow: false; reason: string };

// Only the canonical HTTPS origins may receive the auth cookie: no explicit
// ports, no userinfo, and an exact allowlisted hostname (so `opencode.ai.evil`
// never matches).
function isAllowedHttpsUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    ALLOWED_REDIRECT_HOSTS.has(url.hostname)
  );
}

// Resolve `location` against `fromUrl`; null unless BOTH the current URL and
// the resolved target are allowed HTTPS origins.
function resolveRedirectUrl(fromUrl: string, location: string): URL | null {
  let base: URL;
  try {
    base = new URL(fromUrl);
  } catch {
    return null;
  }
  if (!isAllowedHttpsUrl(base)) return null;
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    return null;
  }
  return isAllowedHttpsUrl(next) ? next : null;
}

function redirectTargetHost(fromUrl: string, location: string): string | null {
  try {
    const host = new URL(location, fromUrl).host;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

// True when `location` resolves to an allowed canonical HTTPS host relative to
// an allowed `fromUrl`. Relative locations inherit the current host.
export function isAllowedRedirect(fromUrl: string, location: string): boolean {
  return resolveRedirectUrl(fromUrl, location) !== null;
}

// Pure redirect decision: follow (with the resolved absolute URL) or stop with
// a user-facing reason. Never throws.
export function resolveAllowedRedirect(
  fromUrl: string,
  location: string | null,
  hopsFollowed: number,
): RedirectDecision {
  if (hopsFollowed >= MAX_REDIRECT_HOPS) {
    return { follow: false, reason: `too many redirects (limit ${MAX_REDIRECT_HOPS})` };
  }
  if (location === null || location.trim().length === 0) {
    return { follow: false, reason: "redirect without a Location header" };
  }
  const next = resolveRedirectUrl(fromUrl, location);
  if (next === null) {
    const host = redirectTargetHost(fromUrl, location);
    return {
      follow: false,
      reason: `redirect blocked (target not allowed${host ? `: ${host}` : ""})`,
    };
  }
  return { follow: true, url: next.toString() };
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

// Where the Go block sits in Kilo's sidebar ladder:
//   - `integrated`  — takes over the host's own token-usage band and retires
//     its panel, so both usage readouts are one block instead of two.
//   - `standalone` — a free band of our own, host panel untouched.
export type SidebarMode = "integrated" | "standalone";

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "integrated";

// Tolerant like `parseBooleanFlag`, because the same value reaches us from a
// hand-written env var and from typed JSON: null means "unset or unrecognized",
// and the caller keeps falling through to the next source.
export function parseSidebarMode(value: unknown): SidebarMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "integrated" || normalized === "standalone" ? normalized : null;
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

// ---------------------------------------------------------------------------
// TUI: plan meters (gauge fill + threshold severity)
// ---------------------------------------------------------------------------
//
// Severity is a name, not a color: this module is inlined into the server
// bundle too, and only the TUI entry can resolve it against a theme.

export type UsageMeterSeverity = "muted" | "warning" | "error";

export const METER_WIDTH = 16;

const METER_FILLED = "█";
const METER_EMPTY = "░";

const WARNING_PERCENT = 75;
const ERROR_PERCENT = 90;

// A capped window is a hard stop rather than a percentage: `limited` wins over
// whatever the gauge says, so a window that is capped at 3% still reads as
// error instead of reassuring the eye.
export function usageMeterSeverity(window: UsageWindow): UsageMeterSeverity {
  if (window.limited) return "error";
  if (window.percent >= ERROR_PERCENT) return "error";
  if (window.percent >= WARNING_PERCENT) return "warning";
  return "muted";
}

// Saturating fill: the API can report a percent outside 0-100, and a repeat
// count outside 0-width throws, so both ends are clamped here instead of at
// the render site.
export function usageMeterBar(percent: number, width: number = METER_WIDTH): string {
  const cells = Number.isFinite(width) ? Math.max(Math.floor(width), 0) : 0;
  if (cells === 0 || !Number.isFinite(percent)) return "";
  const clamped = Math.min(Math.max(percent, 0), 100);
  const filled = Math.min(Math.max(Math.round((clamped / 100) * cells), 0), cells);
  return METER_FILLED.repeat(filled) + METER_EMPTY.repeat(cells - filled);
}

export type PlanRow = {
  label: string;
  bar: string;
  percent: number;
  severity: UsageMeterSeverity;
  reset: string | null;
};

export function buildPlanRows(snapshot: UsageSnapshot): PlanRow[] {
  const windows: ReadonlyArray<readonly [string, UsageWindow | null]> = [
    ["5h", snapshot.rolling],
    ["7d", snapshot.weekly],
    ["30d", snapshot.monthly],
  ];
  const rows: PlanRow[] = [];
  for (const [label, window] of windows) {
    if (window === null) continue;
    rows.push({
      label,
      bar: usageMeterBar(window.percent),
      percent: window.percent,
      severity: usageMeterSeverity(window),
      // A countdown only tells the user something once the window is capped;
      // before that the schedule is noise, and the header rows already show it.
      reset: window.limited ? formatResetDuration(window.resetInSec) ?? window.resetText : null,
    });
  }
  return rows;
}
