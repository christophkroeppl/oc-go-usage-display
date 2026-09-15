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

// Path construction is best-effort. `os.homedir()` can throw when no home
// directory is resolvable, and a throwing top-level expression aborts the
// host's plugin import; degrade to a relative config path instead. `homedir`
// is injectable so the fallback is directly unit-testable.
export function resolveConfigDir(homedir: () => string = os.homedir): string {
  try {
    return path.join(homedir(), ".config", "opencode");
  } catch {
    return ".config/opencode";
  }
}

export const CONFIG_DIR = resolveConfigDir();

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

export function dataShareAuthPath(): string {
  const xdgDataHome = toNonEmptyString(process.env.XDG_DATA_HOME);
  if (xdgDataHome) return path.join(xdgDataHome, "opencode", "auth.json");
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

export function authJsonPaths(): string[] {
  return [dataShareAuthPath(), path.join(CONFIG_DIR, "auth.json")];
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

export function readAuthJsonApiKey(): string | null {
  for (const authPath of authJsonPaths()) {
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
