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

// ---------------------------------------------------------------------------
// Host-scoped environment variables
// ---------------------------------------------------------------------------
//
// Settings and credentials are namespaced per coding agent, so one shell can
// drive the two hosts differently:
//
//   OPENCODE_OC_GO_SIDEBAR=0 opencode
//   KILO_OC_GO_SIDEBAR=1 kilo
//
// The prefix comes from the host baked into the running bundle, so a Kilo entry
// only ever reads `KILO_OC_GO_*` and can never be steered by an opencode-prefixed
// name. Reading a variable the host does not own is a bug, not a feature: the
// two hosts keep separate auth stores and separate config dirs for exactly this
// reason.
//
const ENV_PREFIX: Record<UsageHost, string> = {
  opencode: "OPENCODE_OC_GO_",
  kilo: "KILO_OC_GO_",
};

export function hostEnvName(host: UsageHost, suffix: string): string {
  return `${ENV_PREFIX[host]}${suffix}`;
}

export function hostEnv(
  host: UsageHost,
  suffix: string,
  env: NodeJS.ProcessEnv | undefined = process.env,
): string | undefined {
  return env?.[hostEnvName(host, suffix)];
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
  status: string | null;
  limited: boolean;
  resetInSec: number | null;
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

// A host-reported count or cost, coerced into something a formatter can print.
// Clamping at 0 also folds `-0` into `0`, so no renderer can emit "-0" for a
// quantity that is zero.
export function toUsageCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(value, 0);
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

// ---------------------------------------------------------------------------
// Kilo sidebar ladder (host-owned; asserted by the e2e contract test)
// ---------------------------------------------------------------------------
//
// The `sidebar_content` orders Kilo registers internally, read from the shipped
// binary. The plugin cannot query them at runtime, so they live here as data: a
// comment would be unenforceable, and the point of the contract test is to fail
// when a Kilo release adds a panel inside the band we chose.
export const KILO_SIDEBAR_ORDERS: Readonly<Record<string, number>> = {
  "internal:kilo-sidebar-pr": 50,
  "internal:sidebar-context": 100,
  "internal:kilo-sidebar-usage": 150,
  "internal:sidebar-mcp": 200,
  "internal:kilo-sidebar-indexing": 225,
  "internal:kilo-sidebar-background-processes": 250,
  "internal:sidebar-lsp": 300,
  "internal:sidebar-todo": 400,
  "internal:sidebar-files": 500,
  "internal:kilo-sidebar-memory": 1000,
};

// Free band between the context panel and the token-usage panel, so the Go block
// renders directly between them and never ties with a host panel.
export const KILO_SLOT_ORDER = 125;

// Integrated mode takes over the token-usage panel's own band, so the Go block
// lands where Kilo already draws usage. It ties with
// `internal:kilo-sidebar-usage` by construction — which is why that panel is
// retired rather than extended (see KILO_USAGE_PANEL_PLUGIN_ID): a Kilo
// release that moves it off 150 leaves us in a free band again, harmlessly.
export const KILO_INTEGRATED_SLOT_ORDER = 150;

// The host panel integrated mode replaces. `api.slots` is a per-plugin facade
// that exposes only `register`, so this panel cannot be extended or
// monkey-patched: the only supported way to take its band is to switch it off
// through the plugin lifecycle (`plugin_enabled` in tui.json at config time,
// `api.plugins.deactivate` at runtime).
export const KILO_USAGE_PANEL_PLUGIN_ID = "internal:kilo-sidebar-usage";

// Rows the integrated mode mirrors from Kilo's own `Token Usage` panel, in the
// order it renders them. Kept here so a reword upstream is a test failure rather
// than a silent divergence between our panel and the host's.
export const KILO_TOKEN_USAGE_ROWS: readonly string[] = [
  "Input",
  "Output",
  "Reasoning",
  "Cache read",
  "Cache write",
  "Cache rate",
  "Cost",
];

// The provider whose plan this plugin exists for, and whose per-model group
// carries the Go meters.
export const GO_PROVIDER_ID = "opencode-go";

// Layout constants of the Models table Kilo renders, in the same block as the
// ladder above: a Kilo release that re-lays the table changes these, and a
// constant is the only thing a drift check can assert against.
export const KILO_MODEL_NAME_MAX_CHARS = 19;
export const KILO_STEPS_COLUMN_WIDTH = 5;
export const KILO_COST_COLUMN_WIDTH = 9;

// The sidebar's disclosure glyphs: the section caret and the per-model fold
// marker. Both hosts draw their own sections with these (Kilo's `Token Usage`
// and `Models` panels, opencode's `MCP` panel), so the plugin uses the hosts'
// shapes rather than inventing a third: a caret that does not match the ones
// around it reads as a different control than the one it is.
export const SIDEBAR_COLLAPSED_GLYPH = "▶";
export const SIDEBAR_EXPANDED_GLYPH = "▾";

// Cache rate is a share of the three buckets a cache hit can be served from, so
// it is meaningless when all of them are zero — and a zero denominator is the
// normal state of a session that never hit a cache. A dash, not "0.0%".
export const CACHE_RATE_DECIMALS = 1;
export const CACHE_RATE_EMPTY = "-";

// A model name in opencode's narrower sidebar: 12 cells, where Kilo's table
// gives 19.
export const OPENCODE_MODEL_NAME_MAX_CHARS = 12;
// A percent in its own fixed-width cell, so "0%", "42%" and "100%" end on the
// same column. A text node's `width` reserves cells but does NOT right-align the
// text inside them, so the padding has to be in the string.
export const PERCENT_CELL_WIDTH = 5;

// The collapsed mix line: how many models it lists, and how many cells it may
// spend. The budget is why the mix line is built cell by cell (see
// `buildModelMixSummary`) instead of joined from a fixed list.
export const TOP_GO_MODELS_LIMIT = 3;
export const GO_MODEL_MIX_NAME_MAX_CHARS = 6;
export const GO_MODEL_MIX_BUDGET = 28;
// No spaces around the separator: the same three entries cost 29 cells with
// them and 25 without, and 25 is what fits beside the section's indent in a
// ~30-cell sidebar. A cut-off third entry is a worse summary than tight dots.
export const GO_MODEL_MIX_SEPARATOR = "·";

// The section title says "Go models" on purpose: the weight of a model is its
// share of the Go tokens, so a model from another provider has no weight to
// show and is not counted here.
export const TOP_GO_MODELS_LABEL = "Top Go models";

// Section titles of the integrated panel. The token section is deliberately NOT
// "Token Usage": integrated mode retires the host panel of that name, and
// re-printing the title would be indistinguishable from the panel that was
// supposed to go.
export const INTEGRATED_TOKENS_SECTION_LABEL = "Session Tokens";
export const INTEGRATED_MODELS_SECTION_LABEL = "Models";
export const GO_PLAN_HEADING = "Go Plan";
export const INTEGRATED_GO_SHARE_LABEL = "Go share";

// Wording for a model section with nothing to show. Both hosts use it (opencode's
// mix folds its own message store, Kilo's integrated panel the host endpoint),
// and Kilo's own load/failure wording is borrowed too, so the section reads the
// same on either host whether the host panel or ours is on screen.
export const MODELS_EMPTY_LABEL = "No model usage yet";
export const INTEGRATED_LOADING_LABEL = "Loading usage...";
export const INTEGRATED_UNAVAILABLE_LABEL = "Usage unavailable";

// Two most significant units, always: `4h57m` under an hour, `2d 6h` under a
// week, `1w 1d` above it. A 30-day window resets ~720h out, and "resets in
// 720h00m" is a number nobody can read at a glance -- the countdown exists to
// say "you do not have to think about this yet", and a week count says that in
// five characters. Below an hour the minutes (and then seconds) still matter, so
// they are what is shown.
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

export function formatResetDuration(totalSec: number | null): string | null {
  if (totalSec === null || !Number.isFinite(totalSec) || totalSec < 0) return null;
  const sec = Math.floor(totalSec);
  if (sec >= SECONDS_PER_WEEK) {
    const weeks = Math.floor(sec / SECONDS_PER_WEEK);
    const days = Math.floor((sec % SECONDS_PER_WEEK) / SECONDS_PER_DAY);
    return `${weeks}w ${days}d`;
  }
  if (sec >= SECONDS_PER_DAY) {
    const days = Math.floor(sec / SECONDS_PER_DAY);
    const hours = Math.floor((sec % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(sec / SECONDS_PER_HOUR);
  const minutes = Math.floor((sec % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
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

// A countdown is only usable when it is a finite, non-negative number of
// seconds. One guard covers every failure mode, so no consumer re-checks before
// rendering and no `NaN`, `Invalid Date` or negative span can reach a
// statusline — an elapsed reset (stale payload, clock skew, a reset that fired
// mid-flight) is as unusable as an unreadable one and degrades the same way.
function usableCountdown(seconds: unknown): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

// The live usage API reports the reset as an absolute ISO 8601 instant
// (`resetsAt`), while every consumer wants the RELATIVE count of seconds left
// (`resetInSec`). Convert here, at the parse boundary, so the instant is read
// once against a single clock reading.
function secondsUntilReset(resetsAt: unknown, now: number): number | null {
  const instant = toNonEmptyString(resetsAt);
  if (instant === null) return null;
  return usableCountdown(Math.round((Date.parse(instant) - now) / 1000));
}

// Statuses that mean "this window is capped". Matching is on whole normalized
// tokens, never substrings: "unlimited" contains "limited" and would flip a
// healthy window. Every unrecognized value (including the scrape path's
// historical "active" and the API's "ok") stays false, so a status this build
// has never seen can never paint a window as limited.
const LIMITED_STATUSES = new Set(["rate-limited", "limited", "exhausted", "capped"]);

// Exported for the cookie-scrape parsers in `src/index.ts`, which build windows
// from scraped markup instead of the JSON API and must apply the same mapping.
export function isLimitedStatus(status: string | null): boolean {
  if (status === null) return false;
  const normalized = status.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return LIMITED_STATUSES.has(normalized);
}

// `now` is injectable so the absolute-to-relative conversion is unit-testable
// without sleeping; callers always pass the snapshot's single clock reading.
export function extractWindow(candidate: unknown, now: number = Date.now()): UsageWindow | null {
  if (!isRecord(candidate)) return null;
  const percent = toFiniteNumber(
    candidate.percent ??
      candidate.usagePercent ??
      candidate.usedPercent ??
      candidate.value ??
      candidate.usage,
  );
  if (percent === null) return null;
  const status = toNonEmptyString(candidate.status);
  // The relative spellings win when present because they are already a
  // countdown; `resetsAt` is the live field and is derived from the instant.
  const resetInSec =
    usableCountdown(candidate.resetInSec ?? candidate.resetInSeconds) ??
    secondsUntilReset(candidate.resetsAt, now);
  const resetText = toNonEmptyString(candidate.resetText ?? candidate.reset ?? null);
  return { percent: Math.round(percent), status, limited: isLimitedStatus(status), resetInSec, resetText };
}

export function extractSnapshotFromApiPayload(
  payload: unknown,
  now: number = Date.now(),
): UsageSnapshot | null {
  if (!isRecord(payload)) return null;
  const containers: unknown[] = [payload];
  for (const key of ["usage", "data", "go"]) {
    if (isRecord(payload[key])) containers.push(payload[key]);
  }
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const rolling = extractWindow(container.rolling ?? container.rollingUsage ?? container["5h"], now);
    const weekly = extractWindow(container.weekly ?? container.weeklyUsage ?? container["7d"], now);
    const monthly = extractWindow(container.monthly ?? container.monthlyUsage ?? container["30d"], now);
    if (rolling !== null || weekly !== null || monthly !== null) {
      return {
        rolling,
        weekly,
        monthly,
        source: "api",
        fetchedAt: now,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

// The mock's plan percents, in the order the windows are read: rolling, weekly,
// monthly. Lifted out as named values because the display tests drive a ladder
// over them (`MOCK_PERCENTS`) and a literal in the middle of the snapshot
// builder is the one number nobody can find when a meter assertion fails.
export const MOCK_PERCENTS: readonly [number, number, number] = [42, 15, 61];

// `MOCK_PERCENTS` override: `rolling,weekly,monthly`, one rung per window, e.g.
// `"0,50,90"`. Parsed here rather than at the read sites so the shape is pinned
// once -- a partially parsed ladder (a missing field, a non-numeric cell, `NaN`)
// falls back to the defaults whole, because a half-applied ladder would render a
// block whose numbers match no rung the test asked for, which is the worst
// possible failure mode for a display assertion.
//
// Out-of-range values are NOT clamped here: the parser that stands in for the API
// accepts whatever the wire says, and the meter/percent pair is responsible for
// rendering a value outside 0-100 without breaking its column.
export function parseMockPercents(raw: string | undefined): [number, number, number] | null {
  const text = toNonEmptyString(raw);
  if (text === null) return null;
  const parts = text.split(",");
  if (parts.length !== MOCK_PERCENTS.length) return null;
  const values = parts.map((part) => Number(part.trim()));
  const rolling = values[0];
  const weekly = values[1];
  const monthly = values[2];
  if (rolling === undefined || weekly === undefined || monthly === undefined) return null;
  if (!Number.isFinite(rolling) || !Number.isFinite(weekly) || !Number.isFinite(monthly)) return null;
  return [rolling, weekly, monthly];
}

export type MockSnapshotOverrides = {
  percents?: [number, number, number];
};

// The Go share override, and the one seam that is NOT a plan number: the share is
// a fold over the host's own message store, so a display test can only pin its
// row's layout without a session that holds real assistant messages -- which
// means a provider call per rung. Same mock-only rule as `MOCK_PERCENTS`, and the
// real arithmetic stays covered where it belongs: `goSharePercent` in the unit
// tier and the collapsed model-mix e2e against a local fake provider.
export function parseMockShare(raw: string | undefined): number | null {
  const text = toNonEmptyString(raw);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

// The Go share a display test asked for, or `null` for the real fold over the
// host's message store. Gated on the mock FLAG rather than on the override being
// set, so a stray `*_OC_GO_MOCK_SHARE` in a developer's shell cannot change what a
// real session renders.
export function mockGoShare(host: UsageHost, env: NodeJS.ProcessEnv = process.env): number | null {
  if (hostEnv(host, "MOCK", env) !== "1") return null;
  return parseMockShare(hostEnv(host, "MOCK_SHARE", env));
}

// `"active"` is the status this mock (and the cookie scrape) has always
// reported, and it must map to `limited: false` exactly like the parser does —
// the unit tier pins that agreement so the mock cannot drift from live shape.
// `resetInSec` stays a literal (not derived from `resetsAt`) so the mock reset
// suffix is deterministic for the TUI display tests.
export function mockSnapshot(overrides: MockSnapshotOverrides = {}): UsageSnapshot {
  const percents = overrides.percents ?? MOCK_PERCENTS;
  const window = (percent: number, resetInSec: number | null): UsageWindow => ({
    percent,
    status: "active",
    limited: false,
    resetInSec,
    resetText: null,
  });
  return {
    rolling: window(percents[0], 7543),
    weekly: window(percents[1], null),
    monthly: window(percents[2], null),
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

// ---------------------------------------------------------------------------
// Session model usage boundary (Kilo's per-session token/cost split)
// ---------------------------------------------------------------------------
//
// `GET /session/{sessionID}/model-usage` on the host API, which reports the
// whole top-level session tree. `sessionCost` also exists in 7.8.x and is absent
// in 7.7.5, so it is deliberately not part of the trusted shape: nothing here may
// depend on it. The path is a PATH param and is pinned against the real host by
// test/e2e/kilo-contract.test.js — the generated SDK types are the only place a
// route typo could otherwise hide.

export type UsageTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type UsageTotals = {
  steps: number;
  cost: number;
  tokens: UsageTokens;
};

export type ModelUsage = UsageTotals & {
  providerID: string;
  modelID: string;
};

export type SessionModelUsage = {
  sessionIDs: string[];
  totals: UsageTotals;
  models: ModelUsage[];
};

const EMPTY_TOKENS: UsageTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// Tolerant because the payload is host-owned and can be renamed without breaking
// our build: a missing bucket becomes 0 rather than `undefined`, and a missing
// envelope is a null so the caller can show the unavailable state instead of
// rendering a column of zeros it cannot vouch for.
function parseUsageTokens(candidate: unknown): UsageTokens {
  if (!isRecord(candidate)) return { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } };
  const cache = isRecord(candidate.cache) ? candidate.cache : {};
  return {
    input: toUsageCount(candidate.input),
    output: toUsageCount(candidate.output),
    reasoning: toUsageCount(candidate.reasoning),
    cache: { read: toUsageCount(cache.read), write: toUsageCount(cache.write) },
  };
}

function parseUsageTotals(candidate: unknown): UsageTotals {
  if (!isRecord(candidate)) return { steps: 0, cost: 0, tokens: { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } } };
  return {
    steps: toUsageCount(candidate.steps),
    cost: toUsageCount(candidate.cost),
    tokens: parseUsageTokens(candidate.tokens),
  };
}

export function parseSessionModelUsage(payload: unknown): SessionModelUsage | null {
  if (!isRecord(payload)) return null;
  const models: ModelUsage[] = [];
  if (Array.isArray(payload.models)) {
    for (const entry of payload.models) {
      if (!isRecord(entry)) continue;
      const providerID = toNonEmptyString(entry.providerID);
      const modelID = toNonEmptyString(entry.modelID);
      // A row without both keys cannot be grouped or labelled, so it is dropped
      // rather than rendered as an unlabelled model.
      if (providerID === null || modelID === null) continue;
      models.push({ providerID, modelID, ...parseUsageTotals(entry) });
    }
  }
  return {
    sessionIDs: Array.isArray(payload.sessionIDs) ? payload.sessionIDs.filter((id): id is string => typeof id === "string") : [],
    totals: parseUsageTotals(payload.totals),
    models,
  };
}

// ---------------------------------------------------------------------------
// The same split, derived from opencode's own message store
// ---------------------------------------------------------------------------
//
// opencode has no `model-usage` endpoint to call, and it does not need one: every
// assistant message already carries the provider, the model, the cost and the
// five token buckets, so the per-model table is a fold over
// `api.state.session.messages(sessionID)` instead of a request. The result is
// the SAME `SessionModelUsage` shape Kilo's endpoint returns, which is what lets
// both hosts share one renderer.
//
// SCOPE: the rendered session only, not the session tree. That is the scope
// opencode's own Context panel reports (`Session.tokens` / `Session.cost`), so
// the mix is measured exactly like the number the user already sees next to it,
// and this plugin measures nothing the host does not. Kilo differs here only
// because its endpoint sums the tree and a client cannot ask for less.
//
// Tolerant for the same reason `parseSessionModelUsage` is: a message without a
// provider or a model cannot be weighted, so it is skipped rather than folded
// into an unnamed bucket that would silently take share from real models.

function addUsageTokens(left: UsageTokens, right: UsageTokens): UsageTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: { read: left.cache.read + right.cache.read, write: left.cache.write + right.cache.write },
  };
}

export function aggregateModelUsageFromMessages(messages: readonly unknown[]): SessionModelUsage {
  const byModel = new Map<string, ModelUsage>();
  const sessionIDs: string[] = [];
  for (const entry of messages) {
    if (!isRecord(entry) || entry.role !== "assistant") continue;
    const providerID = toNonEmptyString(entry.providerID);
    const modelID = toNonEmptyString(entry.modelID);
    if (providerID === null || modelID === null) continue;
    const parsed = parseUsageTotals(entry);
    const key = `${providerID}/${modelID}`;
    const existing = byModel.get(key);
    if (existing === undefined) {
      byModel.set(key, {
        providerID,
        modelID,
        steps: 1,
        cost: parsed.cost,
        tokens: { ...parsed.tokens, cache: { ...parsed.tokens.cache } },
      });
    } else {
      // In place: the map owns the row, and a fresh object per message would
      // make a long session allocate one row per step.
      existing.steps += 1;
      existing.cost += parsed.cost;
      existing.tokens = addUsageTokens(existing.tokens, parsed.tokens);
    }
    const sessionID = toNonEmptyString(entry.sessionID);
    if (sessionID !== null && !sessionIDs.includes(sessionID)) sessionIDs.push(sessionID);
  }

  const models = [...byModel.values()];
  const totals = models.reduce<UsageTotals>(
    (sum, model) => ({
      steps: sum.steps + model.steps,
      cost: sum.cost + model.cost,
      tokens: addUsageTokens(sum.tokens, model.tokens),
    }),
    { steps: 0, cost: 0, tokens: { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } } },
  );
  return { sessionIDs, totals, models };
}
