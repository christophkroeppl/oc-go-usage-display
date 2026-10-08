// TUI-only helpers: display formatting, plan rows, model weights, token usage
// rows, and per-model display logic.
//
// This module is imported ONLY by TUI entries (tui.tsx, tui.kilo.tsx) and
// tui-shared.tsx. It is NOT imported by the server entry (index.ts).

import {
  formatResetDuration,
  toNonEmptyString,
  toUsageCount,
  CACHE_RATE_DECIMALS,
  CACHE_RATE_EMPTY,
  GO_MODEL_MIX_BUDGET,
  GO_MODEL_MIX_NAME_MAX_CHARS,
  GO_MODEL_MIX_SEPARATOR,
  GO_PROVIDER_ID,
  INTEGRATED_GO_SHARE_LABEL,
  KILO_MODEL_NAME_MAX_CHARS,
  KILO_TOKEN_USAGE_ROWS,
  PERCENT_CELL_WIDTH,
  TOP_GO_MODELS_LIMIT,
} from "./shared.js";
import type { ModelUsage, UsageSnapshot, UsageTokens, UsageWindow } from "./shared.js";
import { relevantReset, type UsageRow } from "./helpers.js";

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
// TUI: session model usage (what the integrated panel draws instead of Kilo's
// own token-usage panel)
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

// ---------------------------------------------------------------------------
// Additional TUI functions needed by tui-shared and entries
// ---------------------------------------------------------------------------

// The compact statusline: one muted line next to the host's context readout.
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

// Provider gate
export function isGoUsageProvider(providerId: string | undefined): boolean {
  return providerId === GO_PROVIDER_ID;
}

// ---------------------------------------------------------------------------
// Shared predicates re-exported for TUI consumers
// ---------------------------------------------------------------------------
// These are pure predicates that both server and TUI use, kept in helpers.ts

export {
  ownsIntegratedBand,
  hostUsagePanelEnabled,
  sidebarBandRenders,
  statuslineRenders,
  surfaceSelectionFromDisplayMode,
  parseBooleanFlag,
  isSnapshotEmpty,
  providerIdFromMessages,
  providerIdFromModel,
  resolveProviderId,
  shouldRenderModelsHeader,
  parseSidebarMode,
  DEFAULT_SIDEBAR_MODE,
  relevantReset,
  isDisplayMode,
} from "./helpers.js";

// Re-export shared types from helpers.ts
export type {
  DisplayMode,
  SurfaceSelection,
  SidebarMode,
  SidebarBandState,
  ProviderSource,
  ProviderBearingMessage,
  UsageRow,
  ResetCountdown,
} from "./helpers.js";