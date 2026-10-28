// OpenCode Go usage plugin for opencode v2 (server-only).
//
// v2 API: Plugin.define({ id, setup }) with ctx.tool.transform().
// The TUI slot surface is architecturally blocked for third-party plugins
// (the host provides only `effect` and `@opencode/plugin` as runtime modules;
// any external Solid copy produces incompatible slot elements). See
// PLAN-opencode-v2.md §9 for the full measurement log.
//
// This entry registers the same `go_usage` tool as the v1 entry, reusing the
// shared snapshot/format logic from ../shared.js and ../server-helpers.js.

import { Plugin } from "@opencode/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatServerLine,
  hasMalformedAuthCookie,
  isMalformedAuthCookie,
  readFileConfig,
  resolveAllowedRedirect,
} from "../server-helpers.js";
import type { FileConfig } from "../server-helpers.js";
import {
  apiKeyRejectionReason,
  extractSnapshotFromApiPayload,
  extractWindow,
  hostEnv,
  hostEnvName,
  isLimitedStatus,
  isRecord,
  mockSnapshot,
  readAuthJsonApiKey,
  resolveHostRoots,
  resolveUsageHost,
  safeJoinPath,
  toFiniteNumber,
  toNonEmptyString,
  unavailableSnapshot,
  usageApiErrorCode,
} from "../shared.js";
import type { UsageHost, UsageSnapshot, UsageWindow } from "../shared.js";

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

type WindowKey = "rolling" | "weekly" | "monthly";
const WINDOW_KEYS: readonly WindowKey[] = ["rolling", "weekly", "monthly"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const HOST: UsageHost = resolveUsageHost();
const DISK_CACHE_PATH = safeJoinPath(
  resolveHostRoots(HOST).configDir,
  "oc-go-usage-display-cache.json",
);

type Credentials =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "cookie"; workspaceId: string; authCookie: string }
  | { kind: "mock" }
  | { kind: "none" };

function resolveCredentials(hostKey: string | null, fileConfig: FileConfig = readFileConfig(HOST)): Credentials {
  if (hostEnv(HOST, "MOCK") === "1") return { kind: "mock" };
  const apiKey = toNonEmptyString(hostEnv(HOST, "API_KEY")) ?? hostKey;
  if (apiKey) return { kind: "apiKey", apiKey };
  const authJsonKey = readAuthJsonApiKey(HOST);
  if (authJsonKey) return { kind: "apiKey", apiKey: authJsonKey };
  const workspaceId = toNonEmptyString(hostEnv(HOST, "WORKSPACE_ID")) ?? fileConfig.workspaceId;
  const authCookie = toNonEmptyString(hostEnv(HOST, "AUTH_COOKIE")) ?? fileConfig.authCookie;
  if (workspaceId && authCookie) {
    if (isMalformedAuthCookie(authCookie)) return { kind: "none" };
    return { kind: "cookie", workspaceId, authCookie };
  }
  return { kind: "none" };
}

// v2 keeps credentials in the host database rather than auth.json, and exposes
// the resolved value to server plugins through the integration domain.
async function readHostApiKey(ctx: any): Promise<string | null> {
  try {
    const connection = await ctx.integration?.connection?.active?.("opencode-go");
    if (!connection) return null;
    const value = await ctx.integration.connection.resolve(connection);
    if (isRecord(value) && value.type === "key") return toNonEmptyString(value.key);
  } catch {
    // Fall through to auth.json / env; a host without the domain still works.
  }
  return null;
}

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
  const windows: Record<WindowKey, UsageWindow | null> = { rolling: null, weekly: null, monthly: null };
  for (const key of WINDOW_KEYS) {
    const cachedWindow = snapshot[key];
    if (cachedWindow === null) continue;
    const window = extractWindow(cachedWindow);
    if (window === null) return null;
    windows[key] = window;
  }
  return { ...snapshot, ...windows } as UsageSnapshot;
}

function writeDiskCache(snapshot: UsageSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(DISK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify({ at: Date.now(), snapshot }), "utf8");
  } catch {
    // best-effort
  }
}

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

async function fetchViaApiKey(apiKey: string): Promise<UsageSnapshot> {
  try {
    return await fetchWithTimeout(
      API_USAGE_URL,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
      async (response, signal) => {
        if (response.status === 401 || response.status === 403) {
          let body: unknown = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          return unavailableSnapshot(apiKeyRejectionReason(usageApiErrorCode(body)));
        }
        if (!response.ok) return unavailableSnapshot(`upstream returned HTTP ${response.status}`);
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return unavailableSnapshot(signal.aborted ? "request failed" : "unexpected API response shape");
        }
        return extractSnapshotFromApiPayload(payload) ?? unavailableSnapshot("unexpected API response shape");
      },
    );
  } catch {
    return unavailableSnapshot("request failed");
  }
}

const USAGE_KEYS: Record<WindowKey, string> = {
  rolling: "rollingUsage",
  weekly: "weeklyUsage",
  monthly: "monthlyUsage",
};
const DOM_ORDER: WindowKey[] = ["rolling", "weekly", "monthly"];
const LOGIN_TITLE_MARKER = "<title>OpenAuth</title>";

function isLoginPage(finalUrl: string, html: string): boolean {
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(finalUrl);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    // fall through
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

function parseInlineUsage(html: string): Partial<Record<WindowKey, UsageWindow>> {
  const result: Partial<Record<WindowKey, UsageWindow>> = {};
  for (const [name, key] of Object.entries(USAGE_KEYS)) {
    const window = name as WindowKey;
    const block = extractUsageBlock(html, key);
    if (!block) continue;
    const percent = parseIntField(block, "usagePercent");
    if (percent === null) continue;
    const status = parseStrField(block, "status");
    result[window] = {
      percent,
      status,
      limited: isLimitedStatus(status),
      resetInSec: parseIntField(block, "resetInSec"),
      resetText: null,
    };
  }
  return result;
}

function cleanResetText(raw: string): string | null {
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function parseDomUsage(html: string): Partial<Record<WindowKey, UsageWindow>> {
  const result: Partial<Record<WindowKey, UsageWindow>> = {};
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
      status: null,
      limited: false,
      resetInSec: null,
      resetText: resetText !== undefined ? cleanResetText(resetText) : null,
    };
  }
  return result;
}

function parseScrapedUsage(html: string): Partial<Record<WindowKey, UsageWindow>> {
  const inline = parseInlineUsage(html);
  if (Object.keys(inline).length === 3) return inline;
  return { ...parseDomUsage(html), ...inline };
}

async function fetchViaCookie(workspaceId: string, authCookie: string): Promise<UsageSnapshot> {
  const workspaceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  let currentUrl = workspaceUrl;
  let hopsFollowed = 0;

  for (;;) {
    let hop: { kind: "redirect"; location: string | null } | { kind: "body"; status: number; html: string };
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
    if (isLoginPage(currentUrl, html)) return unavailableSnapshot("login expired (refresh auth cookie)");
    if (status !== 200) return unavailableSnapshot(`upstream returned HTTP ${status}`);
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

async function getUsageSnapshot(readHostKey: () => Promise<string | null>): Promise<UsageSnapshot> {
  const now = Date.now();
  if (hostEnv(HOST, "MOCK") === "1") return mockSnapshot();
  if (memoryCache && isFresh(memoryCache.at, now)) return memoryCache.snapshot;
  const diskCached = readDiskCache(now);
  if (diskCached) {
    memoryCache = { at: now, snapshot: diskCached };
    return diskCached;
  }
  const fileConfig = readFileConfig(HOST);
  const credentials = resolveCredentials(await readHostKey(), fileConfig);
  if (credentials.kind === "mock") return mockSnapshot();
  if (credentials.kind === "none") {
    const workspaceId = toNonEmptyString(hostEnv(HOST, "WORKSPACE_ID")) ?? fileConfig.workspaceId;
    if (workspaceId && hasMalformedAuthCookie(fileConfig)) {
      return unavailableSnapshot("not configured (malformed auth cookie)");
    }
    return unavailableSnapshot(`not configured (set ${hostEnvName(HOST, "API_KEY")})`);
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

export default Plugin.define({
  id: "oc-go-usage-display",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "go_usage",
        description:
          "Show OpenCode Go subscription usage: rolling 5h, weekly, and monthly windows. Takes no arguments.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          try {
            const snapshot = await getUsageSnapshot(() => readHostApiKey(ctx)).catch(() =>
              unavailableSnapshot("request failed"),
            );
            const line = formatServerLine(snapshot);
            return { content: `${line}\n${JSON.stringify(snapshot, null, 2)}` };
          } catch {
            const snapshot = unavailableSnapshot("request failed");
            return { content: `${formatServerLine(snapshot)}\n${JSON.stringify(snapshot, null, 2)}` };
          }
        },
      });
    });
    return () => {};
  },
});
