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

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatServerLine,
  hasMalformedAuthCookie,
  isMalformedAuthCookie,
  readFileConfig,
  resolveAllowedRedirect,
} from "./helpers.js";
import type { FileConfig } from "./helpers.js";
import {
  CONFIG_DIR,
  errorMessage,
  extractSnapshotFromApiPayload,
  extractWindow,
  isRecord,
  mockSnapshot,
  readAuthJsonApiKey,
  safeJoinPath,
  toFiniteNumber,
  toNonEmptyString,
  unavailableSnapshot,
} from "./shared.js";
import type { UsageSnapshot, UsageWindow } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// Fetch redirect statuses (the cookie path handles them manually).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DISK_CACHE_PATH = safeJoinPath(CONFIG_DIR, "oc-go-usage-display-cache.json");

// ---------------------------------------------------------------------------
// Trusted types (parsed at the boundary, trusted internally)
// ---------------------------------------------------------------------------

type Credentials =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "cookie"; workspaceId: string; authCookie: string }
  | { kind: "mock" }
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Credentials (boundary: env + optional JSON file; never logged)
// ---------------------------------------------------------------------------

function resolveCredentials(fileConfig: FileConfig = readFileConfig()): Credentials {
  if (process.env.OPENCODE_GO_MOCK === "1") return { kind: "mock" };

  const apiKey = toNonEmptyString(process.env.OPENCODE_GO_API_KEY);
  if (apiKey) return { kind: "apiKey", apiKey };

  const authJsonKey = readAuthJsonApiKey();
  if (authJsonKey) return { kind: "apiKey", apiKey: authJsonKey };

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

// Run the whole exchange (headers and body) under one abort timer: clearing
// it as soon as the response headers arrive would leave a server that stalls
// mid-body hanging past FETCH_TIMEOUT_MS. `read` consumes the body while the
// timer is armed; the signal lets callers tell an aborted read from a payload
// problem. The timer is cleared on every path (body read, redirect handling,
// fetch failure, abort).
async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// --- API-key path: tolerant JSON parsing lives in `./shared.js` (shape may
// evolve); scrape helpers below stay server-local. ---

async function fetchViaApiKey(apiKey: string): Promise<UsageSnapshot> {
  try {
    return await fetchWithTimeout(
      API_USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      async (response, signal) => {
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
          // A body read cut off by the timeout is a request failure; anything
          // else is a payload the API-shape parser cannot use.
          return unavailableSnapshot(
            signal.aborted ? "request failed" : "unexpected API response shape",
          );
        }
        return extractSnapshotFromApiPayload(payload) ?? unavailableSnapshot("unexpected API response shape");
      },
    );
  } catch {
    return unavailableSnapshot("request failed");
  }
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
  const digits = match?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

function parseStrField(block: string, field: string): string | null {
  const match = new RegExp(`${escapeRegex(field)}\\s*:\\s*"([^"]*)"`).exec(block);
  return match?.[1] ?? null;
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
    const window = DOM_ORDER[idx];
    const start = itemStarts[idx];
    if (window === undefined || start === undefined) break;
    const nextStart = itemStarts[idx + 1];
    const segment = html.slice(start, nextStart !== undefined ? nextStart : start + 800);
    const valueMatch =
      /data-slot="usage-value">\s*(?:<!--[\s\S]*?-->)?\s*(\d+)/s.exec(segment) ??
      /width:\s*(\d+)%/.exec(segment);
    const percent = valueMatch?.[1];
    if (percent === undefined) continue;
    const resetMatch = /data-slot="reset-time">\s*([\s\S]*?)<\/span>/.exec(segment);
    const resetText = resetMatch?.[1];
    result[window] = {
      percent: Number.parseInt(percent, 10),
      resetInSec: null,
      status: null,
      resetText: resetText !== undefined ? cleanResetText(resetText) : null,
    };
  }
  return result;
}

function parseScrapedUsage(html: string): Partial<Record<"rolling" | "weekly" | "monthly", UsageWindow>> {
  const inline = parseInlineUsage(html);
  if (Object.keys(inline).length === 3) return inline;
  return { ...parseDomUsage(html), ...inline };
}

// One redirect-following step of the workspace scrape: a redirect hop carries
// only the Location decision, an ordinary response carries its status + body.
type CookieHop =
  | { kind: "redirect"; location: string | null }
  | { kind: "body"; status: number; html: string };

async function fetchViaCookie(workspaceId: string, authCookie: string): Promise<UsageSnapshot> {
  const workspaceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  let currentUrl = workspaceUrl;
  let hopsFollowed = 0;

  // `redirect: "manual"`: automatic redirect following may re-send caller
  // headers (including the auth cookie) to a cross-origin Location, and runtime
  // header stripping cannot be relied on. Each hop is re-requested only after
  // `resolveAllowedRedirect` approves the Location (allowlisted canonical HTTPS
  // hosts, at most MAX_REDIRECT_HOPS hops).
  for (;;) {
    let hop: CookieHop;
    try {
      hop = await fetchWithTimeout(
        currentUrl,
        {
          redirect: "manual",
          headers: {
            Cookie: `auth=${authCookie}`,
            "User-Agent": "oc-go-usage-display-plugin",
            Accept: "text/html,application/xhtml+xml",
          },
        },
        async (response) => {
          if (REDIRECT_STATUSES.has(response.status)) {
            // The redirect body is never read: Location alone decides the next
            // hop, so this resolves (and clears the abort timer) immediately.
            return { kind: "redirect", location: response.headers.get("location") };
          }
          return { kind: "body", status: response.status, html: await response.text() };
        },
      );
    } catch {
      return unavailableSnapshot("request failed");
    }

    if (hop.kind === "redirect") {
      const decision = resolveAllowedRedirect(currentUrl, hop.location, hopsFollowed);
      if (!decision.follow) return unavailableSnapshot(decision.reason);
      currentUrl = decision.url;
      hopsFollowed += 1;
      continue;
    }

    const { status, html } = hop;
    if (isLoginPage(currentUrl, html)) {
      return unavailableSnapshot("login expired (refresh auth cookie)");
    }
    if (status !== 200) {
      return unavailableSnapshot(`upstream returned HTTP ${status}`);
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

  const fileConfig = readFileConfig();
  const credentials = resolveCredentials(fileConfig);
  if (credentials.kind === "mock") {
    return mockSnapshot();
  }
  if (credentials.kind === "none") {
    // A malformed-cookie reason is only meaningful when a workspaceId is
    // present (the user actually attempted cookie auth); a fully
    // unconfigured setup reports the generic reason.
    const workspaceId =
      toNonEmptyString(process.env.OPENCODE_GO_WORKSPACE_ID) ?? fileConfig.workspaceId;
    if (workspaceId && hasMalformedAuthCookie(fileConfig)) {
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

// The ONLY export must be the default module: OpenCode's loader enumerates
// every export and invokes each as a plugin factory when the default is not a
// `{ id, server }` module. Helpers live in `./helpers.js` for exactly that
// reason. `server` returns the existing `{ tool: { go_usage } }` hook surface.

// A Hooks value is always a plain object. Drop nullish hook entries (and
// nullish tool definitions) so the loader can never dereference
// `hook.config` / `hook.provider` on a null value.
function sanitizeHooks(hooks: unknown): Hooks {
  if (!isRecord(hooks)) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (value === null || value === undefined) continue;
    if (key === "tool" && isRecord(value)) {
      const tools: Record<string, unknown> = {};
      for (const [name, definition] of Object.entries(value)) {
        if (definition === null || definition === undefined) continue;
        tools[name] = definition;
      }
      clean[key] = tools;
      continue;
    }
    clean[key] = value;
  }
  return clean as Hooks;
}

type LogClient = {
  app?: { log?: (input: { service: string; level: string; message: string }) => unknown };
};

// Best-effort error log. The client (or its `log` method) may be absent or
// throw on a malformed input, and logging must never rethrow into a caller or
// delay plugin resolution: callers use `void logServerError(...)`.
async function logServerError(input: unknown, message: string): Promise<void> {
  try {
    const client = (input as { client?: LogClient } | null | undefined)?.client;
    await client?.app?.log?.({
      service: "oc-go-usage-display",
      level: "error",
      message,
    });
  } catch {
    // Logging is best-effort; callers must never fail because of it.
  }
}

// Fail-safe contract: OpenCode always starts, even if this plugin cannot. The
// factory resolves to a valid Hooks object (never undefined/null) for any
// input; on initialization failure it logs best-effort and resolves to `{}`.
const server: Plugin = async (input, _options) => {
  try {
    return sanitizeHooks({
      tool: {
        go_usage: tool({
          description:
            "Show OpenCode Go subscription usage: rolling 5h, weekly, and monthly windows. Takes no arguments.",
          args: {},
          execute: async () => {
            try {
              const snapshot = await getUsageSnapshot().catch(() =>
                unavailableSnapshot("request failed"),
              );
              const line = formatServerLine(snapshot);
              return `${line}\n${JSON.stringify(snapshot, null, 2)}`;
            } catch (error) {
              // Same output shape as the success path (line + JSON tail); the
              // failure is logged best-effort and the invocation still
              // resolves so it can never reject into the host.
              const snapshot = unavailableSnapshot("request failed");
              void logServerError(
                input,
                `go_usage tool execution failed: ${errorMessage(error)}`,
              );
              return `${formatServerLine(snapshot)}\n${JSON.stringify(snapshot, null, 2)}`;
            }
          },
        }),
      },
    });
  } catch (error) {
    void logServerError(
      input,
      `Go usage plugin failed to initialize: ${errorMessage(error)}; continuing without hooks`,
    );
    return {};
  }
};

export default { id: "oc-go-usage-display", server } satisfies PluginModule;
