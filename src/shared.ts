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

export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");

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

export function unavailableSnapshot(
  error: string,
  source: UsageSnapshot["source"] = "unavailable",
): UsageSnapshot {
  return {
    rolling: null,
    weekly: null,
    monthly: null,
    source,
    fetchedAt: Date.now(),
    apiUnavailable: true,
    apiError: error,
  };
}
