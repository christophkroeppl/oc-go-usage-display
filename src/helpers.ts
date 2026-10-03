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
  GO_MODEL_MIX_BUDGET,
  GO_MODEL_MIX_NAME_MAX_CHARS,
  GO_MODEL_MIX_SEPARATOR,
  GO_PROVIDER_ID,
  INTEGRATED_GO_SHARE_LABEL,
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

// One label/value row, the grammar the host's own panels use.
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

// One host message, reduced to the field that says which provider it ran on.
// Structural on purpose: the two hosts disagree about the field name —
// Kilo's `AssistantMessage` flattens `providerID` while its `UserMessage` nests
// it under `model.providerID` — and this layer must not depend on either SDK's
// types to read both.
export type ProviderBearingMessage = {
  providerID?: unknown;
  model?: { providerID?: unknown } | undefined;
};

// The provider a session is really running, taken from the NEWEST message that
// carries one.
//
// The message store is the PRIMARY source on every Kilo version we support, and
// the reason is what the band needs rather than what the host happens to expose:
// the models table is a fold over what ran in this session, so a provider that
// appears in the store has rows to weight and a `Go share` to hang off, while a
// provider only named by `Session.model` has neither. It is also the source that
// re-reads -- it is a live Solid store, and unlike `Session.model` it reflects
// the model a step actually ran under, including a `kilo-auto/…` model that the
// host routed to a different provider.
//
// Version history, because the choice looks arbitrary otherwise:
//   Kilo <= 7.8.1  `Session` had no `model` field and the SDK had no model-switch
//                  event, so the store was the only reactive answer available.
//   Kilo 7.8.3     `Session.model` and a `session.next.model.switched` event
//                  appeared. Both are kept as fallbacks (see `resolveProviderId`),
//                  but neither outranks the store: a model picked but not yet run
//                  would claim the band for a table with no rows in it.
//
// Walking backwards means a trailing message on the newly picked provider wins
// over older ones, which is what makes a model switch follow through once the
// user has actually used it.
//
// A store that throws or returns a non-array is not a reason to hide anything:
// the caller falls through to the configured model.
export function providerIdFromMessages(
  messages: readonly ProviderBearingMessage[] | undefined,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (message === null || typeof message !== "object") continue;
    const row = message as ProviderBearingMessage;
    const flat = toNonEmptyString(row.providerID);
    if (flat !== null) return flat;
    const nested = toNonEmptyString(row.model?.providerID);
    if (nested !== null) return nested;
  }
  return undefined;
}

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

// ---------------------------------------------------------------------------
// Which band our sidebar owns
// ---------------------------------------------------------------------------
//
// One decision, split in two, because Kilo's sidebar has a band we may take
// over: integrated mode registers in the host's own token-usage band (order
// 150) and switches that panel off, so "do we draw?" and "must the host panel
// be on?" are different questions with different answers.
//
// The two answers come from one rule: we are the only usage block in the band
// exactly while we are drawing in it. So the host panel goes away only when
// `ownsIntegratedBand`, and every way of not drawing -- no sidebar, collapsed,
// standalone mode, or a session on a non-Go model -- leaves Kilo's own widget on
// screen. Collapsing is in that list because a collapsed band still occupies the
// space it registered for; it is also the one case that would otherwise have been
// an empty band before this rule existed.
//
// The mode decides WHAT the band draws and WHOSE panel is retired, never WHETHER
// we draw: `sidebarBandRenders` does not read it. That is the README's promise
// ("the mode decides what it draws, not whether it is there") as an invariant, and
// it is why the two modes cannot drift apart in which sessions they answer to.
//
//   integrated + Go provider     -> our panel draws, Kilo's does not.
//   integrated + any other model -> Kilo's panel draws. Ours is not a lossless
//                                   fork of it (it has no `Terminal Bench 2.0`
//                                   section and no `Generation speed` row), so
//                                   the honest thing when we have no Go model to
//                                   meter is to hand the band back rather than
//                                   replace a panel we cannot fully reproduce.
//   standalone + Go provider     -> our own band above Kilo's panel, both on screen.
//   standalone + any other model -> Kilo's panel alone; the standalone block IS
//                                   the Go plan, so a non-Go session has no use
//                                   for it.
//
// `sidebarEnabled` is the `sidebar` surface toggle: are we registered in a band
// at all? `collapsed` is the user's fold toggle.
//
// Pure and exhaustive, so the whole matrix is testable without a host. The TUI
// entry reads these inside memos, never once at slot-mount: the host invokes a
// slot renderer exactly once per mount, so a condition read in the slot body is
// latched for the life of the band.
export type SidebarBandState = {
  sidebarEnabled: boolean;
  collapsed: boolean;
  mode: SidebarMode;
  providerId: string | undefined;
};

export function ownsIntegratedBand(state: SidebarBandState): boolean {
  return (
    state.sidebarEnabled &&
    !state.collapsed &&
    state.mode === "integrated" &&
    state.providerId === GO_PROVIDER_ID
  );
}

// The host's panel is on unless we are filling the space it would have used.
// This is the single writer of that switch, which is what keeps the empty band
// from coming back: no sidebar, standalone mode, a collapsed band or a non-Go
// session all mean Kilo's own widget is on screen.
export function hostUsagePanelEnabled(state: SidebarBandState): boolean {
  return !ownsIntegratedBand(state);
}

// The band draws for a Go session and not otherwise, in either mode. Note what is
// NOT here: `mode`. The standalone block is the Go plan, and the integrated panel
// stands in for Kilo's own token usage, but both are only about Go usage -- so
// they answer the same question about which sessions they serve, and a session
// that gets neither is one where Kilo's own widget is on screen instead.
export function sidebarBandRenders(state: SidebarBandState): boolean {
  return state.sidebarEnabled && !state.collapsed && state.providerId === GO_PROVIDER_ID;
}

// The statusline is the plan on one line, so it stays Go-only in both modes --
// unlike the sidebar, it replaces nothing and hands nothing back. It is here so
// the two surfaces cannot disagree about which sessions are Go.
//
// `collapsed` is the fold flag OF THE STATUSLINE, and that is the whole reason the
// two surfaces stay independent: each caller hands this function its OWN surface's
// flag, so folding the sidebar cannot hide the statusline and folding the
// statusline cannot unmake the sidebar. Two persisted keys, two axes.
//
// It used to be dropped here, which is why the statusline could not be turned off:
// the Kilo entry passed `isStatuslineCollapsed()` in and this ignored it, so the
// flag was persisted (`collapsed_statusline`) and had no effect on anything. The
// sidebar toggle is still not allowed to steer the statusline -- that independence
// lives in WHICH flag the caller passes, not in ignoring the one it was given.
export function statuslineRenders(state: Pick<SidebarBandState, "collapsed" | "providerId">): boolean {
  return !state.collapsed && state.providerId === GO_PROVIDER_ID;
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

// The countdown the plan is currently waiting on, as the label of the window it
// belongs to plus the text to print. `null` when the plan has no usable reset
// at all, and every surface then prints nothing rather than a placeholder.
export type ResetCountdown = { label: string; text: string };

// Which window's countdown the plan is waiting on. One decision, read by the
// sidebar's reset line, by the per-row suffixes under a capped meter and by the
// statusline, so no two of them can name different windows.
//
// A capped window outranks a nearer one, and the longest cap outranks the
// shorter ones: an exhausted `30d` is what actually stops work, so a `5h` that
// rolls over in two hours is not the fact worth the cells. With nothing capped
// the soonest reset is the answer, because that is the first moment the
// percentages printed beside it will move.
//
// The capped case is read back out of `buildPlanRows` instead of re-deriving
// what "capped" means, so the statusline cannot drift from the sidebar. Only
// `resetInSec` is ever compared; a window that carries nothing but the host's
// free text can be printed once it has been chosen, never compared as a string.
export function relevantReset(snapshot: UsageSnapshot): ResetCountdown | null {
  const rows = buildPlanRows(snapshot);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.reset != null) return { label: row.label, text: row.reset };
  }
  return soonestReset(snapshot);
}

// The soonest reset across the windows, capped or not. A stale payload, clock
// skew or a reset that fired mid-flight can all send a negative span, and an
// elapsed countdown is as unusable as an unreadable one.
function soonestReset(snapshot: UsageSnapshot): ResetCountdown | null {
  const windows: ReadonlyArray<readonly [string, UsageWindow | null]> = [
    ["5h", snapshot.rolling],
    ["7d", snapshot.weekly],
    ["30d", snapshot.monthly],
  ];
  let soonest: { label: string; seconds: number } | null = null;
  for (const [name, window] of windows) {
    if (window === null) continue;
    const seconds = window.resetInSec;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) continue;
    if (soonest !== null && seconds >= soonest.seconds) continue;
    soonest = { label: name, seconds };
  }
  if (soonest === null) return null;
  const text = formatResetDuration(soonest.seconds);
  return text === null ? null : { label: soonest.label, text };
}

export function formatStatusline(snapshot: UsageSnapshot): string {
  const rolling = snapshot.rolling === null ? "5h n/a" : `5h ${snapshot.rolling.percent}%`;
  const weekly = snapshot.weekly === null ? "7d n/a" : `7d ${snapshot.weekly.percent}%`;
  const monthly = snapshot.monthly === null ? "30d n/a" : `30d ${snapshot.monthly.percent}%`;
  const windows = `Go ${rolling} | ${weekly} | ${monthly}`;
  // The same countdown the sidebar shows, without its window label: the
  // percentages are right there in the same order, so naming the window again
  // would spend cells restating what the line already says.
  const reset = relevantReset(snapshot);
  return reset === null ? windows : `${windows} · resets in ${reset.text}`;
}


// ---------------------------------------------------------------------------
// TUI: plan meters (gauge fill + threshold severity)
// ---------------------------------------------------------------------------
//
// Severity is a name, not a color: this module is inlined into the server
// bundle too, and only the TUI entry can resolve it against a theme.

export type UsageMeterSeverity = "muted" | "warning" | "error";

const WARNING_PERCENT = 75;
const ERROR_PERCENT = 90;

// A capped window is a hard stop rather than a percentage: `limited` wins over
// whatever the gauge says, so a window that is capped at 3% still reads as error
// instead of reassuring the eye.
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

// The meter's filled fraction, clamped to 0-100: the API can report a percent
// outside the range and a NaN would be a layout error rather than a drawing one.
//
// The meter itself is TWO BOXES -- a filled one at this percentage and a track
// for the rest -- not a string of block glyphs. A glyph string has a fixed cell
// count, and a plugin cannot measure the sidebar it is rendering into (opentui
// resolves a text node's `width` as a wrapping bound, and no layout callback
// reaches a plugin), so a glyph meter is either too short for a wide sidebar or
// clipped by a narrow one. Boxes fill whatever the row gives them, which is why
// the meter now reaches the sidebar's right edge on any host and any width.
export function meterFillPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(Math.max(percent, 0), 100);
}

export type PlanRow = {
  label: string;
  percent: number;
  severity: UsageMeterSeverity;
  reset: string | null;
};

// `meterWidth` is the sidebar's budget, not the bar's design: 16 cells fit next
// to Kilo's model table, 10 fit opencode's ~30-cell sidebar. The glyphs and the
// saturating fill are identical, so two widths are the same bar at two sizes.
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
      percent: window.percent,
      severity: usageMeterSeverity(window),
      // A countdown only tells the user something once the window is capped;
      // before that the schedule is noise, and the header rows already show it.
      reset: window.limited ? formatResetDuration(window.resetInSec) ?? window.resetText : null,
    });
  }
  return rows;
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

// The plan window label cell ("5h", "7d", "30d"): exactly the longest label the
// plan has, so every meter starts on the same column and none of the width goes
// to padding.
export const PLAN_LABEL_WIDTH = 3;

// The Go share's label cell, the same idea for a longer label: exactly the label
// itself, so the share meter starts on the same column on every render.
//
// This is what the share row used to get wrong. Its label was `flexGrow`, so the
// label and the meter BOTH claimed the slack and the split between them moved
// with the reading -- the share bar was 18 cells wide at 50% and 20 at 100%, and
// its percent slid a column with it. Only the meter may grow.
export const GO_SHARE_LABEL_WIDTH = INTEGRATED_GO_SHARE_LABEL.length;

// A percent padded into a fixed-width cell, right-aligned by construction.
//
// The value is CLAMPED to the same 0-100 the meter draws, because the cell's whole
// job is to hold one column: `padStart` never truncates, so a percent the API
// reported as 1234 (or -1234) would print five digits plus a sign, push its own
// row one cell wider than every other row and undo the alignment the cell exists
// to provide. Clamping also keeps the number and the bar telling the same story --
// a bar clamped to full beside a cell reading "1234%" would be a second, quieter
// version of the same bug.
export function formatPercentCell(percent: number, width: number = PERCENT_CELL_WIDTH): string {
  const cells = Math.max(Math.floor(width), 1);
  const rounded = Number.isFinite(percent) ? Math.round(meterFillPercent(percent)) : 0;
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
