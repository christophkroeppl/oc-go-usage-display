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
  toUsageCount,
  CACHE_RATE_DECIMALS,
  CACHE_RATE_EMPTY,
  GO_MODEL_BAR_WIDTH,
  GO_MODEL_MIX_BUDGET,
  GO_MODEL_MIX_NAME_MAX_CHARS,
  GO_MODEL_MIX_SEPARATOR,
  GO_PROVIDER_ID,
  PERCENT_CELL_WIDTH,
  KILO_MODEL_NAME_MAX_CHARS,
  KILO_TOKEN_USAGE_ROWS,
  TOP_GO_MODELS_LIMIT,
} from "./shared.js";
import type { ModelUsage, UsageHost, UsageSnapshot, UsageTokens, UsageWindow } from "./shared.js";

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

// Which provider a session is actually running, for the Go-only display gate.
// Pure so the precedence is unit-testable: the TUI entry reads this on every
// render rather than latching a value at init.
export type ProviderSource = {
  config?: { model?: unknown } | undefined;
  session?: { get?: ((sessionID: string) => { model?: { providerID?: unknown } | undefined } | undefined) | undefined } | undefined;
};

export function providerIdFromModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.length === 0) return undefined;
  const provider = model.split("/")[0];
  return provider !== undefined && provider.length > 0 ? provider : undefined;
}

export function resolveProviderId(
  state: ProviderSource | undefined,
  sessionId: string,
  fallback: string | undefined,
): string | undefined {
  // The session's own model is the one in use, so it outranks the config default.
  try {
    const fromSession = state?.session?.get?.(sessionId)?.model?.providerID;
    if (typeof fromSession === "string" && fromSession.length > 0) return fromSession;
  } catch {
    // Fall through: a throwing store is not a reason to hide the panel.
  }
  try {
    const fromConfig = providerIdFromModel(state?.config?.model);
    if (fromConfig !== undefined) return fromConfig;
  } catch {
    // Fall through to the event-signal fallback.
  }
  return fallback;
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
  return meterSeverityForPercent(window.percent);
}

// The threshold ladder on its own, so a gauge that is not backed by a plan
// window (the per-model Go share) colors by the same rules.
export function meterSeverityForPercent(percent: number): UsageMeterSeverity {
  if (!Number.isFinite(percent)) return "muted";
  if (percent >= ERROR_PERCENT) return "error";
  if (percent >= WARNING_PERCENT) return "warning";
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

// `meterWidth` is the sidebar's budget, not the bar's design: 16 cells fit next
// to Kilo's model table, 10 fit opencode's ~30-cell sidebar. The glyphs and the
// saturating fill are identical, so two widths are the same bar at two sizes.
export function buildPlanRows(snapshot: UsageSnapshot, meterWidth: number = METER_WIDTH): PlanRow[] {
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
      bar: usageMeterBar(window.percent, meterWidth),
      percent: window.percent,
      severity: usageMeterSeverity(window),
      // A countdown only tells the user something once the window is capped;
      // before that the schedule is noise, and the header rows already show it.
      reset: window.limited ? formatResetDuration(window.resetInSec) ?? window.resetText : null,
    });
  }
  return rows;
}

// The soonest countdown in the plan, labelled with the window it belongs to
// (`5h resets in 2h5m`), for hosts that print it on one line under the header
// instead of under a capped row. One line, one window: a sidebar ~30 cells wide
// cannot afford a suffix on every row, and an unlabelled countdown would be
// ambiguous about which window is running out.
//
// Only `resetInSec` counts. It is the field the live `resetsAt` instant is
// derived into at the parse boundary, so a window that only carries the scrape's
// free-text `resetText` is skipped rather than compared as a string.
export function formatNextResetLine(snapshot: UsageSnapshot): string | null {
  const windows: ReadonlyArray<readonly [string, UsageWindow | null]> = [
    ["5h", snapshot.rolling],
    ["7d", snapshot.weekly],
    ["30d", snapshot.monthly],
  ];
  let label: string | null = null;
  let soonest: number | null = null;
  for (const [name, window] of windows) {
    if (window === null) continue;
    const seconds = window.resetInSec;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) continue;
    if (soonest === null || seconds < soonest) {
      soonest = seconds;
      label = name;
    }
  }
  if (label === null || soonest === null) return null;
  const duration = formatResetDuration(soonest);
  if (duration === null) return null;
  return `${label} resets in ${duration}`;
}

// ---------------------------------------------------------------------------
// TUI: session model usage (the integrated panel's replacement for Kilo's own
// token-usage band)
// ---------------------------------------------------------------------------
//
// The host hands over raw counts and a USD cost with no display metadata, so
// every number crosses a formatter. The formatters below guard first: a bare
// `Intl.NumberFormat` prints NaN as "NaN" and Infinity as "∞", and either one
// silently stretches a sidebar column that is width-budgeted by the host.

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsageCount(value: unknown): string {
  return COUNT_FORMAT.format(toUsageCount(value));
}

export function formatUsageCost(value: unknown): string {
  return CURRENCY_FORMAT.format(toUsageCount(value));
}

// Every bucket a token can land in. Cache is included because cached reads and
// writes are billed work too; excluding them would make the per-model totals
// disagree with the host's own `totals` row.
export function usageTokenCount(tokens: UsageTokens): number {
  return (
    toUsageCount(tokens.input) +
    toUsageCount(tokens.output) +
    toUsageCount(tokens.reasoning) +
    toUsageCount(tokens.cache.read) +
    toUsageCount(tokens.cache.write)
  );
}

// Kilo's cache rate: the read share of the three buckets a cache hit can be
// served from. Output and reasoning are excluded on purpose — neither can be
// cached, so counting them would deflate the rate towards a value that means
// nothing.
export function cacheRatePercent(tokens: UsageTokens): string {
  const denominator =
    toUsageCount(tokens.input) + toUsageCount(tokens.cache.read) + toUsageCount(tokens.cache.write);
  if (denominator === 0) return CACHE_RATE_EMPTY;
  return `${((toUsageCount(tokens.cache.read) / denominator) * 100).toFixed(CACHE_RATE_DECIMALS)}%`;
}

// A model's share of the Go tokens spent in this session tree. This is a share
// of Go tokens and nothing else: it is not a share of the plan, a quota, or a
// price, and it never carries a currency. A zero total is 0% rather than NaN so
// the row still renders before any Go tokens are attributed.
export function goSharePercent(modelTokens: unknown, totalGoTokens: unknown): number {
  const total = toUsageCount(totalGoTokens);
  if (total === 0) return 0;
  return (toUsageCount(modelTokens) / total) * 100;
}

export function totalGoTokens(models: readonly ModelUsage[]): number {
  let total = 0;
  for (const model of models) {
    if (model.providerID !== GO_PROVIDER_ID) continue;
    total += usageTokenCount(model.tokens);
  }
  return total;
}

export type ModelProviderGroup = {
  providerID: string;
  providerName: string;
  models: ModelUsage[];
};

// Group in first-seen order (the host's own `models[]` order), which keeps the
// active provider on top. A provider with no catalog entry falls back to its
// raw id rather than dropping its models.
export function groupModelsByProvider(
  models: readonly ModelUsage[],
  providerNames: ReadonlyMap<string, string> = new Map(),
): ModelProviderGroup[] {
  const groups = new Map<string, ModelProviderGroup>();
  for (const model of models) {
    const group = groups.get(model.providerID) ?? {
      providerID: model.providerID,
      providerName: providerNames.get(model.providerID) ?? model.providerID,
      models: [],
    };
    group.models.push(model);
    groups.set(model.providerID, group);
  }
  return [...groups.values()];
}

// Kilo's truncation: a single ellipsis appended to a fixed-width budget, never
// a trailing "..." that would make the budget worth two extra cells.
export function truncateModelName(value: string, max: number = KILO_MODEL_NAME_MAX_CHARS): string {
  if (value.length <= max) return value;
  const budget = Math.max(max - 1, 0);
  return `${value.slice(0, budget)}…`;
}

// Kilo's display normalization, applied before truncation: strip a `vendor:`
// prefix, a lone leading `vendor/`, and a trailing discount badge, then split a
// letter run that runs straight into digits. Without it a catalog name like
// "anthropic/claude-sonnet-4" spends the whole 19-cell budget on the vendor.
export function displayModelName(name: string): string {
  return name
    .trim()
    .replace(/^[^:]+:\s+/, "")
    .replace(/^[^/\s]+\/(?=[^/]+$)/, "")
    .replace(/\s*\([^)]*%\s*off[^)]*\)\s*$/i, "")
    .replace(/^([A-Za-z]{2,})(?=\d)/, "$1 ")
    .replace(/\s+/g, " ");
}

export function modelDisplayName(catalogName: string | null, modelID: string, max: number = KILO_MODEL_NAME_MAX_CHARS): string {
  const raw = toNonEmptyString(catalogName) ?? toNonEmptyString(modelID) ?? "";
  return truncateModelName(displayModelName(raw), max);
}

// The first segment of a model name, for a mix line that has to fit several of
// them in one line: `mimo-v2.6-pro` -> `mimo`, `qwen3-max` -> `qwen3`, `gpt-5.1`
// -> `gpt`. A name with no separator is already short and is only truncated.
// Lowercased: the rest of the sidebar is lowercase, and the mix line is a
// ranking of three labels rather than three model names to copy out of.
export function shortModelName(value: string, max: number = GO_MODEL_MIX_NAME_MAX_CHARS): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  const head = trimmed.split(/[-._/]/)[0] ?? trimmed;
  return truncateModelName(head, max);
}

// The plan window label cell ("5h", "30d"): wide enough for the longest label
// the plan has, so every meter starts on the same column.
export const PLAN_LABEL_WIDTH = 4;

// A percent padded into a fixed-width cell, right-aligned by construction. A
// non-finite percent renders as 0 rather than "NaN%", which would break the
// column it sits in.
export function formatPercentCell(percent: number, width: number = PERCENT_CELL_WIDTH): string {
  const cells = Math.max(Math.floor(width), 1);
  const rounded = Number.isFinite(percent) ? Math.round(percent) : 0;
  return `${`${rounded}%`}`.padStart(cells, " ");
}

// A token count as a weight, not an invoice: short enough to sit next to a bar
// in a 30-cell sidebar, precise enough to rank models. `610K` rather than
// `0.61M` — below a million the integer form is both shorter and the one people
// say out loud.
export function formatTokenCount(value: unknown): string {
  const count = toUsageCount(value);
  if (count >= 1_000_000_000) return `${trimTrailingZeros((count / 1_000_000_000).toFixed(2))}B`;
  if (count >= 1_000_000) return `${trimTrailingZeros((count / 1_000_000).toFixed(2))}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return COUNT_FORMAT.format(count);
}

// `1.20M` claims a precision the API never had, and spends a cell on it. Only
// `toFixed` output goes through this, which always carries a decimal point -- so
// the trailing zeros it strips are always fractional ones, never `100`.
function trimTrailingZeros(value: string): string {
  return value.replace(/\.?0+$/, "");
}

// ---------------------------------------------------------------------------
// TUI: per-model weights (the opencode sidebar's model mix)
// ---------------------------------------------------------------------------
//
// A model's WEIGHT is its share of the Go tokens spent in this session. It is
// not a share of the plan, a quota, or a price, and it never carries a currency:
// the plan's absolute limits are not client-visible, so a number that looked
// like one would be a guess dressed as a measurement. The bars reuse the plan's
// glyphs and the same threshold coloring, which is why a heavily used model
// paints like a hot plan window.

export type GoModelWeight = {
  providerID: string;
  modelID: string;
  tokens: number;
  share: number;
  bar: string;
  steps: number;
  cost: number;
};

export type GoModelWeights = {
  // The heaviest Go models, already ranked and sliced to `limit`.
  models: GoModelWeight[];
  // How many Go models the session used in total, so a section titled
  // `Top Go models (7)` above three rows is explained by the rows themselves.
  goModels: number;
  goTokens: number;
  listedTokens: number;
  listedShare: number;
  otherCount: number;
  // Session totals over EVERY Go model, not just the listed ones: the footer is
  // about the session, the rows are about the ranking.
  steps: number;
  cost: number;
};

// The heaviest Go models by token count. Ties break on steps and then on the
// model id, so the same session always ranks the same way — a list that reshuffles
// between renders would make the weights unreadable. `otherCount` counts the
// models the limit dropped, and `goTokens`/`steps`/`cost` cover all of them.
export function weightGoModels(
  models: readonly ModelUsage[],
  limit: number = TOP_GO_MODELS_LIMIT,
  barWidth: number = GO_MODEL_BAR_WIDTH,
): GoModelWeights {
  const goModels = models.filter((model) => model.providerID === GO_PROVIDER_ID);
  const goTokens = goModels.reduce((sum, model) => sum + usageTokenCount(model.tokens), 0);
  const ranked = [...goModels].sort(
    (left, right) =>
      usageTokenCount(right.tokens) - usageTokenCount(left.tokens) ||
      toUsageCount(right.steps) - toUsageCount(left.steps) ||
      left.modelID.localeCompare(right.modelID),
  );
  const top = ranked.slice(0, Math.max(Math.floor(limit), 0));
  const listedTokens = top.reduce((sum, model) => sum + usageTokenCount(model.tokens), 0);
  return {
    models: top.map((model) => {
      const tokens = usageTokenCount(model.tokens);
      const share = goSharePercent(tokens, goTokens);
      return {
        providerID: model.providerID,
        modelID: model.modelID,
        tokens,
        share,
        bar: usageMeterBar(share, barWidth),
        steps: toUsageCount(model.steps),
        cost: toUsageCount(model.cost),
      };
    }),
    goModels: goModels.length,
    goTokens,
    listedTokens,
    listedShare: goSharePercent(listedTokens, goTokens),
    otherCount: Math.max(goModels.length - top.length, 0),
    steps: goModels.reduce((sum, model) => sum + toUsageCount(model.steps), 0),
    cost: goModels.reduce((sum, model) => sum + toUsageCount(model.cost), 0),
  };
}

// The collapsed mix line: `mimo 59%·qwen 25%·gpt 12%`, as many entries as fit
// `budget` cells. Built cell by cell rather than joined from a fixed list because
// a narrow sidebar truncates mid-entry, and a half-written `qwen 2…` reads as a
// different number than `qwen 25%`.
//
// The leader is always included even when it alone overruns the budget: a mix
// line without the heaviest model is not a summary of anything, and the entry
// cannot actually be that wide because the names are capped (see
// `shortModelName`), so the budget only ever decides the second entry onwards.
export function buildModelMixSummary(
  entries: ReadonlyArray<{ name: string; share: number }>,
  budget: number = GO_MODEL_MIX_BUDGET,
): string {
  const first = entries[0];
  if (first === undefined) return "";
  const parts: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const part = `${entry.name} ${Math.round(entry.share)}%`;
    const width = part.length + (parts.length === 0 ? 0 : GO_MODEL_MIX_SEPARATOR.length);
    if (parts.length > 0 && used + width > budget) break;
    parts.push(part);
    used += width;
  }
  return parts.join(GO_MODEL_MIX_SEPARATOR);
}

// Two muted lines under the rows: what the listed models account for, and the
// session's own Go totals. Both are counts of this session's tokens and cost —
// never of the plan.
export function buildGoModelFooters(weights: GoModelWeights): string[] {
  if (weights.models.length === 0) return [];
  return [
    `${formatTokenCount(weights.listedTokens)} of ${formatTokenCount(weights.goTokens)} Go tokens`,
    `${formatUsageCount(weights.steps)} steps · ${formatUsageCost(weights.cost)}`,
  ];
}

// One row per entry of KILO_TOKEN_USAGE_ROWS, in that order. A label with no
// value is dropped rather than rendered blank, so the row list and the constant
// can only disagree in a way the unit tier fails on.
export function buildTokenUsageRows(totals: { cost: number; tokens: UsageTokens }): UsageRow[] {
  const values: Readonly<Record<string, string>> = {
    Input: formatUsageCount(totals.tokens.input),
    Output: formatUsageCount(totals.tokens.output),
    Reasoning: formatUsageCount(totals.tokens.reasoning),
    "Cache read": formatUsageCount(totals.tokens.cache.read),
    "Cache write": formatUsageCount(totals.tokens.cache.write),
    "Cache rate": cacheRatePercent(totals.tokens),
    Cost: formatUsageCost(totals.cost),
  };
  return KILO_TOKEN_USAGE_ROWS.flatMap((label) => {
    const value = values[label];
    return value === undefined ? [] : [{ label, value }];
  });
}

// The per-model token breakdown shown when a model row is expanded: the same
// labels and order as the totals block, minus `Cost`, which the model row
// already carries in its own cost column.
export function buildModelTokenRows(tokens: UsageTokens): UsageRow[] {
  return buildTokenUsageRows({ cost: 0, tokens }).filter((row) => row.label !== "Cost");
}
