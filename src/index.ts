// OpenCode Go usage plugin for OpenCode (global, native).
//
// Shows OpenCode Go subscription usage as an additive overlay:
//   - `go_usage` tool -> JSON snapshot + a human-readable line, e.g.
//     `Go 5h 42% (reset 3h12m) | 7d 15% | 30d 61%`
//
// There is no automatic display: usage surfaces live in `src/tui.tsx`
// (sidebar + statusline).
//
// Coexistence with worktrunk.ts: this plugin NEVER touches
// session.status / session.deleted markers. It registers an additive hook
// only (one tool). No transcript injection, no TUI
// footer slot (unstable API).
//
// Auth (first match wins, secrets are never logged):
//   1. OPENCODE_GO_MOCK=1         -> deterministic mock snapshot (for testing)
//   2. OPENCODE_GO_API_KEY        -> GET https://opencode.ai/zen/go/v1/usage
//                                    (Authorization: Bearer <key>)
//   3. Provider auth.json key     -> same Bearer path as (2), no paste needed:
//                                    $XDG_DATA_HOME/opencode/auth.json (or
//                                    ~/.local/share/opencode/auth.json), fallback
//                                    ~/.config/opencode/auth.json (legacy).
//                                    Uses `opencode-go` key, else `opencode` key.
//   4. OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE (env), or
//      ~/.config/opencode/oc-go-usage-display.json
//      ({ "workspaceId": "...", "authCookie": "..." })
//                                   -> GET https://opencode.ai/workspace/{id}/go
//                                    (scraped rolling/weekly/monthly)
//   5. none                       -> unavailable snapshot (literal-only error)
// Snapshots are cached 60s in memory + on disk.

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR,
  extractSnapshotFromApiPayload,
  extractWindow,
  formatResetDuration,
  isRecord,
  mockSnapshot,
  readAuthJsonApiKey,
  toFiniteNumber,
  toNonEmptyString,
  unavailableSnapshot,
} from "./shared.js";
import type { UsageSnapshot, UsageWindow } from "./shared.js";

// Re-exported so `dist/index.js` keeps the helper surface used by tests.
export { formatResetDuration };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const FILE_CONFIG_PATH = path.join(CONFIG_DIR, "oc-go-usage-display.json");
const DISK_CACHE_PATH = path.join(CONFIG_DIR, "oc-go-usage-display-cache.json");

// ---------------------------------------------------------------------------
// Trusted types (parsed at the boundary, trusted internally)
// ---------------------------------------------------------------------------

type Credentials =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "cookie"; workspaceId: string; authCookie: string }
  | { kind: "mock" }
  | { kind: "none" };

function formatWindow(window: UsageWindow | null): string {
  if (!window) return "n/a";
  return `${window.percent}%`;
}

export function formatCompactLine(snapshot: UsageSnapshot): string {
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
// Credentials (boundary: env + optional JSON file; never logged)
// ---------------------------------------------------------------------------

function readFileConfig(): { workspaceId: string | null; authCookie: string | null } {
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

function resolveCredentials(): Credentials {
  if (process.env.OPENCODE_GO_MOCK === "1") return { kind: "mock" };

  const apiKey = toNonEmptyString(process.env.OPENCODE_GO_API_KEY);
  if (apiKey) return { kind: "apiKey", apiKey };

  const authJsonKey = readAuthJsonApiKey();
  if (authJsonKey) return { kind: "apiKey", apiKey: authJsonKey };

  const fileConfig = readFileConfig();
  const workspaceId = toNonEmptyString(process.env.OPENCODE_GO_WORKSPACE_ID) ?? fileConfig.workspaceId;
  const authCookie = toNonEmptyString(process.env.OPENCODE_GO_AUTH_COOKIE) ?? fileConfig.authCookie;
  if (workspaceId && authCookie) {
    // Reject header-injection / cookie-jar confusion payloads. The cookie
    // value is never logged; malformed values fall through to "none".
    if (isMalformedAuthCookie(authCookie)) return { kind: "none" };
    return { kind: "cookie", workspaceId, authCookie };
  }

  return { kind: "none" };
}

function isMalformedAuthCookie(cookie: string): boolean {
  return /[\r\n;,]/.test(cookie);
}

export function hasMalformedAuthCookie(): boolean {
  const raw =
    toNonEmptyString(process.env.OPENCODE_GO_AUTH_COOKIE) ?? readFileConfig().authCookie;
  if (!raw) return false;
  return isMalformedAuthCookie(raw);
}

// ---------------------------------------------------------------------------
// Cache (memory + disk, 60s TTL)
// ---------------------------------------------------------------------------

let memoryCache: { at: number; snapshot: UsageSnapshot } | null = null;

function isFresh(at: number, now: number): boolean {
  return at <= now && now - at < CACHE_TTL_MS;
}

function readDiskCache(now: number): UsageSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(DISK_CACHE_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const at = toFiniteNumber(parsed.at);
  if (at === null || !isFresh(at, now)) return null;
  if (!isRecord(parsed.snapshot)) return null;
  const snapshot = parsed.snapshot;
  if (!("rolling" in snapshot && "weekly" in snapshot && "monthly" in snapshot)) return null;
  // Validate cached windows instead of blindly trusting the shape; a corrupt
  // entry is dropped so the next fetch repopulates the cache.
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const cachedWindow = snapshot[key];
    if (cachedWindow === null) continue;
    if (extractWindow(cachedWindow) === null) return null;
  }
  return snapshot as UsageSnapshot;
}

function writeDiskCache(snapshot: UsageSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(DISK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      DISK_CACHE_PATH,
      JSON.stringify({ at: Date.now(), snapshot }),
      "utf8",
    );
  } catch {
    // Cache is best-effort; usage display must never break the host.
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- API-key path: tolerant JSON parsing lives in `./shared.js` (shape may
// evolve); scrape helpers below stay server-local. ---

async function fetchViaApiKey(apiKey: string): Promise<UsageSnapshot> {
  let response: Response;
  try {
    response = await fetchWithTimeout(API_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return unavailableSnapshot("request failed");
  }
  if (response.status === 401 || response.status === 403) {
    return unavailableSnapshot("API key rejected (401/403)");
  }
  if (!response.ok) {
    return unavailableSnapshot(`upstream returned HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailableSnapshot("unexpected API response shape");
  }
  return extractSnapshotFromApiPayload(payload) ?? unavailableSnapshot("unexpected API response shape");
}

// --- Cookie path: workspace page scrape (ported from opencode-go-hud) ---

const USAGE_KEYS: Record<"rolling" | "weekly" | "monthly", string> = {
  rolling: "rollingUsage",
  weekly: "weeklyUsage",
  monthly: "monthlyUsage",
};
const DOM_ORDER: Array<"rolling" | "weekly" | "monthly"> = ["rolling", "weekly", "monthly"];
const LOGIN_TITLE_MARKER = "<title>OpenAuth</title>";

function isLoginPage(finalUrl: string, html: string): boolean {
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(finalUrl);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    // Malformed URL: fall through to marker check.
  }
  if (host === "auth.opencode.ai") return true;
  if (host === "opencode.ai" && pathname.startsWith("/auth")) return true;
  return html.includes(LOGIN_TITLE_MARKER);
}

function isNoSubscription(html: string): boolean {
  if (!html.includes('data-slot="subscribe-button"')) return false;
  return /lite\s*:\s*null/.test(html) && /liteSubscriptionID\s*:\s*null/.test(html);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractUsageBlock(html: string, key: string): string | null {
  const pattern = new RegExp(`${escapeRegex(key)}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{`);
  const match = pattern.exec(html);
  if (!match || match.index === undefined) return null;
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(braceStart, i + 1);
    }
  }
  return null;
}

function parseIntField(block: string, field: string): number | null {
  const match = new RegExp(`${escapeRegex(field)}\\s*:\\s*(-?\\d+)`).exec(block);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseStrField(block: string, field: string): string | null {
  const match = new RegExp(`${escapeRegex(field)}\\s*:\\s*"([^"]*)"`).exec(block);
  return match ? match[1] : null;
}

function parseInlineUsage(html: string): Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> {
  const result: Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> = {};
  for (const [name, key] of Object.entries(USAGE_KEYS)) {
    const window = name as "rolling" | "weekly" | "monthly";
    const block = extractUsageBlock(html, key);
    if (!block) continue;
    const percent = parseIntField(block, "usagePercent");
    if (percent === null) continue;
    result[window] = {
      percent,
      resetInSec: parseIntField(block, "resetInSec"),
      status: parseStrField(block, "status"),
      resetText: null,
    };
  }
  return result;
}

function cleanResetText(raw: string): string | null {
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function parseDomUsage(html: string): Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> {
  const result: Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> = {};
  const itemStarts: number[] = [];
  for (const match of html.matchAll(/data-slot="usage-item"/g)) {
    if (match.index !== undefined) itemStarts.push(match.index);
  }
  for (let idx = 0; idx < DOM_ORDER.length; idx++) {
    if (idx >= itemStarts.length) break;
    const segment = html.slice(itemStarts[idx], idx + 1 < itemStarts.length ? itemStarts[idx + 1] : itemStarts[idx] + 800);
    const valueMatch =
      /data-slot="usage-value">\s*(?:<!--[\s\S]*?-->)?\s*(\d+)/s.exec(segment) ??
      /width:\s*(\d+)%/.exec(segment);
    if (!valueMatch) continue;
    const resetMatch = /data-slot="reset-time">\s*([\s\S]*?)<\/span>/.exec(segment);
    result[DOM_ORDER[idx]] = {
      percent: Number.parseInt(valueMatch[1], 10),
      resetInSec: null,
      status: null,
      resetText: resetMatch ? cleanResetText(resetMatch[1]) : null,
    };
  }
  return result;
}

function parseScrapedUsage(html: string): Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> {
  const inline = parseInlineUsage(html);
  if (Object.keys(inline).length === 3) return inline;
  return { ...parseDomUsage(html), ...inline };
}

async function fetchViaCookie(workspaceId: string, authCookie: string): Promise<UsageSnapshot> {
  const workspaceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  let response: Response;
  try {
    response = await fetchWithTimeout(workspaceUrl, {
      redirect: "follow",
      headers: {
        Cookie: `auth=${authCookie}`,
        "User-Agent": "oc-go-usage-display-plugin",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return unavailableSnapshot("request failed");
  }
  let html = "";
  try {
    html = await response.text();
  } catch {
    return unavailableSnapshot("request failed");
  }
  if (isLoginPage(response.url, html)) {
    return unavailableSnapshot("login expired (refresh auth cookie)");
  }
  if (response.status !== 200) {
    return unavailableSnapshot(`upstream returned HTTP ${response.status}`);
  }
  const usages = parseScrapedUsage(html);
  if (Object.keys(usages).length === 0) {
    if (isNoSubscription(html)) return unavailableSnapshot("no OpenCode Go subscription");
    return unavailableSnapshot("usage markup not recognized");
  }
  return {
    rolling: usages.rolling ?? null,
    weekly: usages.weekly ?? null,
    monthly: usages.monthly ?? null,
    source: "scrape",
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Snapshot entry point (cached, never throws, never logs secrets)
// ---------------------------------------------------------------------------

async function getUsageSnapshot(): Promise<UsageSnapshot> {
  const now = Date.now();
  // Mock bypasses cache for determinism: a stale disk/memory entry must
  // never shadow the deterministic mock snapshot during tests. The mock
  // never reads or writes the cache.
  if (process.env.OPENCODE_GO_MOCK === "1") {
    return mockSnapshot();
  }
  if (memoryCache && isFresh(memoryCache.at, now)) return memoryCache.snapshot;
  const diskCached = readDiskCache(now);
  if (diskCached) {
    memoryCache = { at: now, snapshot: diskCached };
    return diskCached;
  }

  const credentials = resolveCredentials();
  if (credentials.kind === "mock") {
    return mockSnapshot();
  }
  if (credentials.kind === "none") {
    if (hasMalformedAuthCookie()) {
      return unavailableSnapshot("not configured (malformed auth cookie)");
    }
    return unavailableSnapshot("not configured (set OPENCODE_GO_API_KEY)");
  }

  const snapshot =
    credentials.kind === "apiKey"
      ? await fetchViaApiKey(credentials.apiKey)
      : await fetchViaCookie(credentials.workspaceId, credentials.authCookie);

  if (!snapshot.apiUnavailable) {
    memoryCache = { at: now, snapshot };
    writeDiskCache(snapshot);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default (async () => {
  return {
    tool: {
      go_usage: tool({
        description:
          "Show OpenCode Go subscription usage: rolling 5h, weekly, and monthly windows. Takes no arguments.",
        args: {},
        execute: async () => {
          const snapshot = await getUsageSnapshot().catch(() =>
            unavailableSnapshot("request failed"),
          );
          const line = formatCompactLine(snapshot);
          return `${line}\n${JSON.stringify(snapshot, null, 2)}`;
        },
      }),
    },
  };
}) satisfies Plugin;
