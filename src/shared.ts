// Shared pure helpers for the server (`src/index.ts`) and TUI (`src/tui.tsx`)
// targets: auth.json resolution, tolerant API-payload parsing, snapshot
// builders, and small parsing/formatting primitives.
//
// Single source of truth for the duplicated logic so both surfaces parse the
// usage API identically. Secrets are never logged here. Behavior must stay
// identical for both consumers (import via `./shared.js` under NodeNext).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Resolve the user home directory honoring a runtime HOME override.
// Bun's `os.homedir()` caches the home directory at process startup and does
// NOT respect runtime `process.env.HOME` changes, which breaks hermetic test
// overrides that set HOME before dynamic imports. Reading `process.env.HOME`
// directly (with `os.homedir()` fallback for when HOME is unset) makes path
// resolution hermetic under both `node --test` and `bun test`.
function resolveHomedir(): string {
  const envHome = process.env.HOME;
  if (envHome && envHome.length > 0) return envHome;
  return os.homedir();
}

// Path construction is best-effort. `resolveHomedir()` can throw when no home
// directory is resolvable, and a throwing top-level expression aborts the
// host's plugin import; degrade to a relative config path instead. `homedir`
// is injectable so the fallback is directly unit-testable.
export function resolveConfigDir(homedir: () => string = resolveHomedir): string {
  try {
    return path.join(homedir(), ".config", "opencode");
  } catch {
    return ".config/opencode";
  }
}

// ---------------------------------------------------------------------------
// Host roots (opencode vs its Kilo fork): each host keeps its own config and
// data stores, and each entry module must read the credentials of the host it
// runs under. opencode: `$XDG_DATA_HOME/opencode/auth.json` (or
// `~/.local/share/opencode/auth.json`), then its config dir. Kilo:
// `$XDG_DATA_HOME/kilo/auth.json` (or `~/.local/share/kilo/auth.json`), then
// `$KILO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kilo` (or `~/.config/kilo`).
// ---------------------------------------------------------------------------

export type UsageHost = "opencode" | "kilo";

export type HostRoots = { configDir: string; dataDir: string };

// Pure host selection: only the explicit "kilo" marker selects the Kilo
// stores; every other value (including unset) means opencode.
export function usageHostFromEnv(env: NodeJS.ProcessEnv | undefined): UsageHost {
  return env?.OC_GO_USAGE_HOST === "kilo" ? "kilo" : "opencode";
}

// Runtime host for the entry module. The Kilo server bundle is built with
// `process.env.OC_GO_USAGE_HOST` replaced by the literal "kilo"
// (scripts/build-plugins.mjs), so dist/index.js stays opencode while
// dist/plugins/oc-go-usage-display.kilo.ts is deterministic. The kilocode TUI
// entry passes its host explicitly instead.
export function resolveUsageHost(): UsageHost {
  return process.env.OC_GO_USAGE_HOST === "kilo" ? "kilo" : "opencode";
}

// `resolveHomedir` can throw when no home directory is resolvable; plugin
// entry modules build these paths at import time, so degrade to an empty
// segment instead of throwing.
function homedirOrEmpty(homedir: () => string): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

// Host config/data roots. Both hosts are XDG-based: `$XDG_CONFIG_HOME` /
// `$XDG_DATA_HOME` win with `~/.config` / `~/.local/share` as fallbacks, and
// Kilo additionally honors `KILO_CONFIG_DIR` (its documented config override).
// Never throws.
export function resolveHostRoots(
  host: UsageHost,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = resolveHomedir,
): HostRoots {
  const home = homedirOrEmpty(homedir);
  const configRoot = toNonEmptyString(env.XDG_CONFIG_HOME) ?? safeJoinPath(home, ".config");
  const dataRoot = toNonEmptyString(env.XDG_DATA_HOME) ?? safeJoinPath(home, ".local", "share");
  if (host === "kilo") {
    return {
      configDir: toNonEmptyString(env.KILO_CONFIG_DIR) ?? safeJoinPath(configRoot, "kilo"),
      dataDir: safeJoinPath(dataRoot, "kilo"),
    };
  }
  return {
    configDir: safeJoinPath(configRoot, "opencode"),
    dataDir: safeJoinPath(dataRoot, "opencode"),
  };
}

// Legacy opencode config dir (no XDG): kept as an exported constant because
// the hermeticity tests assert every runtime path stays inside their tmp root.
export const CONFIG_DIR = resolveHostRoots("opencode").configDir;

// Coerce any runtime value into a path segment deterministically: strings pass
// through, every other value uses its string form, and only an object with a
// throwing `toString` degrades to "" (an empty segment, which `path.join`
// ignores). Never throws.
function toPathSegment(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}

// Tolerant `path.join` for module-level path construction. `path.join` throws
// on a non-string segment; plugin entry modules build cache/config paths at
// import time, so a throw there would crash startup. Non-string segments are
// coerced (never silently dropped or thrown away) and the resulting string
// join cannot throw.
export function safeJoinPath(base: string, ...segments: unknown[]): string {
  return path.join(toPathSegment(base), ...segments.map(toPathSegment));
}

export function dataShareAuthPath(
  host: UsageHost = "opencode",
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = resolveHomedir,
): string {
  return safeJoinPath(resolveHostRoots(host, env, homedir).dataDir, "auth.json");
}

export function authJsonPaths(
  host: UsageHost = "opencode",
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = resolveHomedir,
): string[] {
  const roots = resolveHostRoots(host, env, homedir);
  return [safeJoinPath(roots.dataDir, "auth.json"), safeJoinPath(roots.configDir, "auth.json")];
}

// ---------------------------------------------------------------------------
// Trusted types (parsed at the boundary, trusted internally)
// ---------------------------------------------------------------------------

export type UsageWindow = {
  percent: number;
  resetInSec: number | null;
  status: string | null;
  resetText: string | null;
};

export type UsageSnapshot = {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
  source: "api" | "scrape" | "mock" | "unavailable";
  fetchedAt: number;
  apiUnavailable?: boolean;
  apiError?: string;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Stable, human-readable message for any thrown value. Never throws itself, so
// callers can include it in best-effort logs without a second failure mode.
export function errorMessage(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  if (error instanceof Error) {
    return toNonEmptyString(error.message) ?? toNonEmptyString(error.name) ?? "unknown error";
  }
  try {
    return toNonEmptyString(String(error)) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export function formatResetDuration(totalSec: number | null): string | null {
  if (totalSec === null || !Number.isFinite(totalSec) || totalSec < 0) return null;
  const sec = Math.floor(totalSec);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// Credentials boundary (auth.json; secrets never logged)
// ---------------------------------------------------------------------------

export function readAuthJsonApiKey(
  host: UsageHost = "opencode",
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = resolveHomedir,
): string | null {
  for (const authPath of authJsonPaths(host, env, homedir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(authPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const goEntry = parsed["opencode-go"];
    const fallbackEntry = parsed["opencode"];
    const goKey = isRecord(goEntry) ? toNonEmptyString(goEntry.key) : null;
    if (goKey) return goKey;
    const fallbackKey = isRecord(fallbackEntry) ? toNonEmptyString(fallbackEntry.key) : null;
    if (fallbackKey) return fallbackKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// API payload boundary (tolerant JSON parsing; shape may evolve)
// ---------------------------------------------------------------------------

export function extractWindow(candidate: unknown): UsageWindow | null {
  if (!isRecord(candidate)) return null;
  const percent = toFiniteNumber(
    candidate.percent ??
      candidate.usagePercent ??
      candidate.usedPercent ??
      candidate.value ??
      candidate.usage,
  );
  if (percent === null) return null;
  const resetInSec = toFiniteNumber(candidate.resetInSec ?? candidate.resetInSeconds ?? null);
  const status = toNonEmptyString(candidate.status);
  const resetText = toNonEmptyString(candidate.resetText ?? candidate.reset ?? null);
  return { percent: Math.round(percent), resetInSec, status, resetText };
}

export function extractSnapshotFromApiPayload(payload: unknown): UsageSnapshot | null {
  if (!isRecord(payload)) return null;
  const containers: unknown[] = [payload];
  for (const key of ["usage", "data", "go"]) {
    if (isRecord(payload[key])) containers.push(payload[key]);
  }
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const rolling = extractWindow(container.rolling ?? container.rollingUsage ?? container["5h"]);
    const weekly = extractWindow(container.weekly ?? container.weeklyUsage ?? container["7d"]);
    const monthly = extractWindow(container.monthly ?? container.monthlyUsage ?? container["30d"]);
    if (rolling !== null || weekly !== null || monthly !== null) {
      return {
        rolling,
        weekly,
        monthly,
        source: "api",
        fetchedAt: Date.now(),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

export function mockSnapshot(): UsageSnapshot {
  return {
    rolling: { percent: 42, resetInSec: 7543, status: "active", resetText: null },
    weekly: { percent: 15, resetInSec: null, status: "active", resetText: null },
    monthly: { percent: 61, resetInSec: null, status: "active", resetText: null },
    source: "mock",
    fetchedAt: Date.now(),
  };
}

export function unavailableSnapshot(error: string): UsageSnapshot {
  return {
    rolling: null,
    weekly: null,
    monthly: null,
    source: "unavailable",
    fetchedAt: Date.now(),
    apiUnavailable: true,
    apiError: error,
  };
}
