// Unit tier: `dist/helpers.js` TUI helpers — display-mode selection, flag
// parsing, sidebar rows, the compact statusline, the plan meters, and the
// session-usage block the integrated sidebar renders.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGoModelFooters,
  buildModelMixSummary,
  buildModelTokenRows,
  buildPlanRows,
  buildTokenUsageRows,
  cacheRatePercent,
  formatPercentCell,
  relevantReset,
  PLAN_LABEL_WIDTH,
  formatTokenCount,
  DEFAULT_SIDEBAR_MODE,
  displayModelName,
  formatStatusline,
  formatUsageCost,
  formatUsageCount,
  goSharePercent,
  groupModelsByProvider,
  isSnapshotEmpty,
  modelDisplayName,
  parseBooleanFlag,
  parseSidebarMode,
  shortModelName,
  surfaceSelectionFromDisplayMode,
  totalGoTokens,
  truncateModelName,
  GO_SHARE_LABEL_WIDTH,
  meterFillPercent,
  meterSeverityForPercent,
  usageMeterSeverity,
  usageTokenCount,
  weightGoModels,

  providerIdFromModel,
  resolveProviderId,} from "../../dist/helpers.js";
import {
  aggregateModelUsageFromMessages,
  CACHE_RATE_DECIMALS,
  CACHE_RATE_EMPTY,
  GO_MODEL_MIX_BUDGET,
  GO_PROVIDER_ID,
  INTEGRATED_GO_SHARE_LABEL,
  PERCENT_CELL_WIDTH,
  OPENCODE_MODEL_NAME_MAX_CHARS,
  KILO_COST_COLUMN_WIDTH,
  KILO_MODEL_NAME_MAX_CHARS,
  KILO_STEPS_COLUMN_WIDTH,
  KILO_TOKEN_USAGE_ROWS,
  parseSessionModelUsage,
  toUsageCount,
} from "../../dist/shared.js";
// The ladder is shared with the e2e tier so the two cannot disagree about which
// readings are covered. Pure, so it does not disturb this tier's readonly
// guarantee.
import { usageLadders } from "../helpers/ladder.js";

function tuiSnapshot(overrides = {}) {
  return {
    rolling: { percent: 42, status: "active", limited: false, resetInSec: 7543, resetText: null },
    weekly: { percent: 15, status: "active", limited: false, resetInSec: null, resetText: null },
    monthly: { percent: 61, status: "active", limited: false, resetInSec: null, resetText: null },
    source: "mock",
    fetchedAt: 0,
    ...overrides,
  };
}

// --- parseBooleanFlag ---

test("parseBooleanFlag passes booleans through", () => {
  assert.equal(parseBooleanFlag(true), true);
  assert.equal(parseBooleanFlag(false), false);
});

test("parseBooleanFlag accepts 1/0 numbers and true/false strings", () => {
  assert.equal(parseBooleanFlag(1), true);
  assert.equal(parseBooleanFlag(0), false);
  assert.equal(parseBooleanFlag("1"), true);
  assert.equal(parseBooleanFlag("0"), false);
  assert.equal(parseBooleanFlag("true"), true);
  assert.equal(parseBooleanFlag("false"), false);
  assert.equal(parseBooleanFlag(" TRUE "), true);
  assert.equal(parseBooleanFlag("False"), false);
});

test("parseBooleanFlag returns null for anything else", () => {
  assert.equal(parseBooleanFlag(null), null);
  assert.equal(parseBooleanFlag(undefined), null);
  assert.equal(parseBooleanFlag(2), null);
  assert.equal(parseBooleanFlag("yes"), null);
  assert.equal(parseBooleanFlag(""), null);
  assert.equal(parseBooleanFlag({}), null);
});
// --- formatStatusline: 3 windows plus one countdown ---

test("formatStatusline appends the soonest reset when no window is capped", () => {
  assert.equal(formatStatusline(tuiSnapshot()), "Go 5h 42% | 7d 15% | 30d 61% · resets in 2h5m");
});

test("formatStatusline keeps n/a fallbacks per window", () => {
  const partial = tuiSnapshot({ rolling: null, monthly: null });
  assert.equal(formatStatusline(partial), "Go 5h n/a | 7d 15% | 30d n/a");
  const empty = tuiSnapshot({ rolling: null, weekly: null, monthly: null });
  assert.equal(formatStatusline(empty), "Go 5h n/a | 7d n/a | 30d n/a");
});

test("formatStatusline leaves the line alone when no window carries a reset", () => {
  const noResets = tuiSnapshot({
    rolling: { percent: 42, status: "active", limited: false, resetInSec: null, resetText: null },
  });
  assert.equal(formatStatusline(noResets), "Go 5h 42% | 7d 15% | 30d 61%");
});

test("formatStatusline counts down the exhausted 30d, not the sooner 5h", () => {
  const exhaustedMonth = tuiSnapshot({
    monthly: { percent: 100, status: "exhausted", limited: true, resetInSec: 777600, resetText: null },
  });
  assert.equal(
    formatStatusline(exhaustedMonth),
    "Go 5h 42% | 7d 15% | 30d 100% · resets in 1w 2d",
  );
});

test("formatStatusline counts down the exhausted 7d over the 5h", () => {
  const exhaustedWeek = tuiSnapshot({
    weekly: { percent: 100, status: "rate-limited", limited: true, resetInSec: 262800, resetText: null },
  });
  assert.equal(
    formatStatusline(exhaustedWeek),
    "Go 5h 42% | 7d 100% | 30d 61% · resets in 3d 1h",
  );
});

test("formatStatusline counts down the exhausted 5h when it is the only cap", () => {
  const exhaustedRolling = tuiSnapshot({
    rolling: { percent: 100, status: "limited", limited: true, resetInSec: 7543, resetText: null },
  });
  assert.equal(
    formatStatusline(exhaustedRolling),
    "Go 5h 100% | 7d 15% | 30d 61% · resets in 2h5m",
  );
});

test("formatStatusline picks the longest cap when several windows are exhausted", () => {
  const bothCapped = tuiSnapshot({
    rolling: { percent: 100, status: "exhausted", limited: true, resetInSec: 7543, resetText: null },
    weekly: { percent: 100, status: "exhausted", limited: true, resetInSec: 262800, resetText: null },
    monthly: { percent: 100, status: "exhausted", limited: true, resetInSec: 777600, resetText: null },
  });
  assert.equal(
    formatStatusline(bothCapped),
    "Go 5h 100% | 7d 100% | 30d 100% · resets in 1w 2d",
  );
});

test("formatStatusline uses the host's free-text reset when the window has no instant", () => {
  const textOnly = tuiSnapshot({
    monthly: { percent: 100, status: "capped", limited: true, resetInSec: null, resetText: "Oct 2" },
  });
  assert.equal(
    formatStatusline(textOnly),
    "Go 5h 42% | 7d 15% | 30d 100% · resets in Oct 2",
  );
});

test("formatStatusline falls through to the soonest reset when a cap has no reset", () => {
  const silentCap = tuiSnapshot({
    monthly: { percent: 100, status: "capped", limited: true, resetInSec: null, resetText: null },
  });
  assert.equal(
    formatStatusline(silentCap),
    "Go 5h 42% | 7d 15% | 30d 100% · resets in 2h5m",
  );
});

test("formatStatusline prints the same countdown the sidebar shows", () => {
  const monthSpent = tuiSnapshot({
    monthly: { percent: 100, status: "exhausted", limited: true, resetInSec: 777600, resetText: null },
  });
  // One selector, two surfaces: the statusline drops the window label the
  // sidebar keeps, and the countdown itself has to be the same string.
  const sidebar = relevantReset(monthSpent);
  assert.equal(formatStatusline(monthSpent), `Go 5h 42% | 7d 15% | 30d 100% · resets in ${sidebar.text}`);
});

// --- isSnapshotEmpty / surfaceSelectionFromDisplayMode ---

test("isSnapshotEmpty is true only when every window is missing", () => {
  assert.equal(isSnapshotEmpty(tuiSnapshot({ rolling: null, weekly: null, monthly: null })), true);
  assert.equal(isSnapshotEmpty(tuiSnapshot({ rolling: null, weekly: null })), false);
  assert.equal(isSnapshotEmpty(tuiSnapshot()), false);
});

test("surfaceSelectionFromDisplayMode maps every display mode", () => {
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("both"), { sidebar: true, statusline: true });
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("sidebar"), { sidebar: true, statusline: false });
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("statusline"), { sidebar: false, statusline: true });
});

// --- parseSidebarMode ---

test("parseSidebarMode accepts both modes, trimmed and case-insensitively", () => {
  assert.equal(parseSidebarMode("integrated"), "integrated");
  assert.equal(parseSidebarMode("standalone"), "standalone");
  assert.equal(parseSidebarMode("  Integrated  "), "integrated");
  assert.equal(parseSidebarMode("STANDALONE"), "standalone");
});

test("parseSidebarMode returns null for unset or unrecognized values", () => {
  // null means "keep falling through to the next source", so a typo must never
  // resolve to a mode of its own.
  assert.equal(parseSidebarMode(undefined), null);
  assert.equal(parseSidebarMode(null), null);
  assert.equal(parseSidebarMode(""), null);
  assert.equal(parseSidebarMode("  "), null);
  assert.equal(parseSidebarMode("integrated "), "integrated");
  assert.equal(parseSidebarMode("integrate"), null);
  assert.equal(parseSidebarMode("solo"), null);
  assert.equal(parseSidebarMode(true), null);
  assert.equal(parseSidebarMode(1), null);
  assert.equal(parseSidebarMode({ mode: "integrated" }), null);
});

test("the default sidebar mode is the integrated band", () => {
  assert.equal(DEFAULT_SIDEBAR_MODE, "integrated");
  assert.equal(parseSidebarMode(DEFAULT_SIDEBAR_MODE), DEFAULT_SIDEBAR_MODE);
});

// --- usageMeterSeverity ---

function window(overrides = {}) {
  return { percent: 10, status: "ok", limited: false, resetInSec: null, resetText: null, ...overrides };
}

test("usageMeterSeverity steps at 75% and 90%", () => {
  assert.equal(usageMeterSeverity(window({ percent: 0 })), "muted");
  assert.equal(usageMeterSeverity(window({ percent: 74 })), "muted");
  assert.equal(usageMeterSeverity(window({ percent: 75 })), "warning");
  assert.equal(usageMeterSeverity(window({ percent: 89 })), "warning");
  assert.equal(usageMeterSeverity(window({ percent: 90 })), "error");
  assert.equal(usageMeterSeverity(window({ percent: 100 })), "error");
});

test("usageMeterSeverity paints a capped window error whatever the percent", () => {
  // A cap is a hard stop, not a percentage: 3% of an exhausted window is not
  // a healthy window.
  assert.equal(usageMeterSeverity(window({ percent: 3, limited: true })), "error");
  assert.equal(
    usageMeterSeverity(window({ percent: 3, status: "rate-limited", limited: true })),
    "error",
  );
});

// --- usageMeterBar ---

// --- buildPlanRows ---

test("buildPlanRows meters every window in 5h/7d/30d order", () => {
  assert.deepStrictEqual(buildPlanRows(tuiSnapshot()), [
    { label: "5h", percent: 42, severity: "muted", reset: null },
    { label: "7d", percent: 15, severity: "muted", reset: null },
    { label: "30d", percent: 61, severity: "muted", reset: null },
  ]);
});

test("buildPlanRows omits a missing window instead of zero-filling it", () => {
  const rows = buildPlanRows(tuiSnapshot({ weekly: null, monthly: null }));
  assert.deepStrictEqual(rows.map((row) => row.label), ["5h"]);
  assert.deepStrictEqual(buildPlanRows(tuiSnapshot({ rolling: null, weekly: null, monthly: null })), []);
});

test("buildPlanRows carries a reset countdown only for a capped window", () => {
  // Below the cap the countdown is noise; the `Go Usage` rows already show the
  // schedule.
  const healthy = buildPlanRows(tuiSnapshot());
  assert.equal(healthy[0].reset, null);

  const capped = buildPlanRows(
    tuiSnapshot({
      rolling: { percent: 96, status: "rate-limited", limited: true, resetInSec: 7543, resetText: null },
    }),
  );
  assert.equal(capped[0].severity, "error");
  assert.equal(capped[0].reset, "2h5m");
});

test("buildPlanRows falls back to resetText when there is no countdown", () => {
  const rows = buildPlanRows(
    tuiSnapshot({
      rolling: { percent: 100, status: "exhausted", limited: true, resetInSec: null, resetText: "soon" },
      weekly: null,
      monthly: null,
    }),
  );
  assert.equal(rows[0].reset, "soon");
});

test("buildPlanRows reports no reset for a capped window with no reset at all", () => {
  const rows = buildPlanRows(
    tuiSnapshot({
      rolling: { percent: 100, status: "capped", limited: true, resetInSec: null, resetText: null },
      weekly: null,
      monthly: null,
    }),
  );
  assert.equal(rows[0].reset, null);
  assert.equal(rows[0].severity, "error");
});

// --- session model usage: the guards every formatter sits behind ---

function tokens(overrides = {}) {
  return {
    input: 1000,
    output: 200,
    reasoning: 50,
    cache: { read: 300, write: 40 },
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    providerID: GO_PROVIDER_ID,
    modelID: "mimo-v2.6-pro",
    steps: 3,
    cost: 0.12,
    tokens: tokens(),
    ...overrides,
  };
}

test("toUsageCount clamps at 0 and folds every unusable value to 0", () => {
  assert.equal(toUsageCount(42), 42);
  assert.equal(toUsageCount(0), 0);
  assert.equal(toUsageCount(-0), 0);
  assert.ok(!Object.is(toUsageCount(-0), -0), "-0 must never survive into a formatter");
  assert.equal(toUsageCount(-17), 0, "a negative quantity renders as 0, not as a negative count");
  assert.equal(toUsageCount(Number.NaN), 0);
  assert.equal(toUsageCount(Number.POSITIVE_INFINITY), 0);
  assert.equal(toUsageCount(Number.NEGATIVE_INFINITY), 0);
  assert.equal(toUsageCount(null), 0);
  assert.equal(toUsageCount(undefined), 0);
  assert.equal(toUsageCount("1200"), 0, "a numeric string is not a number here");
  assert.equal(toUsageCount({}), 0);
});

test("formatUsageCount and formatUsageCost never print NaN, Infinity or -0", () => {
  assert.equal(formatUsageCount(1234567), "1,234,567");
  assert.equal(formatUsageCount(0), "0");
  assert.equal(formatUsageCount(-5), "0");
  assert.equal(formatUsageCount(Number.NaN), "0");
  assert.equal(formatUsageCount(Number.POSITIVE_INFINITY), "0");
  assert.equal(formatUsageCost(0), "$0.00");
  assert.equal(formatUsageCost(1.5), "$1.50");
  assert.equal(formatUsageCost(1234.5), "$1,234.50");
  assert.equal(formatUsageCost(-3), "$0.00");
  assert.equal(formatUsageCost(Number.NaN), "$0.00");
  assert.equal(formatUsageCost(Number.POSITIVE_INFINITY), "$0.00");
  for (const rendered of [formatUsageCount(-0), formatUsageCost(-0)]) {
    assert.ok(!rendered.includes("-"), `"${rendered}" must not carry a minus sign`);
  }
});

// --- usageTokenCount ---

test("usageTokenCount sums every bucket a token can land in", () => {
  assert.equal(usageTokenCount(tokens()), 1000 + 200 + 50 + 300 + 40);
});

test("usageTokenCount survives missing, negative and non-finite buckets", () => {
  assert.equal(usageTokenCount(tokens({ input: Number.NaN, output: undefined })), 50 + 300 + 40);
  assert.equal(
    usageTokenCount(tokens({ input: -100, output: Number.POSITIVE_INFINITY, reasoning: Number.NEGATIVE_INFINITY })),
    340,
  );
  assert.equal(usageTokenCount(tokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })), 0);
});

// --- cacheRatePercent ---

test("cacheRatePercent is the read share of the three cacheable buckets", () => {
  // 300 / (1000 + 300 + 40) = 22.388…%, to one decimal.
  assert.equal(CACHE_RATE_DECIMALS, 1);
  assert.equal(cacheRatePercent(tokens()), "22.4%");
});

test("cacheRatePercent excludes output and reasoning from the denominator", () => {
  const withExtras = cacheRatePercent(tokens({ output: 1_000_000, reasoning: 1_000_000 }));
  assert.equal(withExtras, cacheRatePercent(tokens()), "output and reasoning must not dilute the rate");
});

test("cacheRatePercent is a dash when nothing could be cached", () => {
  assert.equal(CACHE_RATE_EMPTY, "-");
  assert.equal(cacheRatePercent(tokens({ input: 0, cache: { read: 0, write: 0 } })), "-");
  assert.equal(
    cacheRatePercent(tokens({ input: Number.NaN, output: 5, reasoning: 5, cache: { read: -1, write: Number.NaN } })),
    "-",
    "a non-finite bucket cannot make the denominator non-zero",
  );
});

test("cacheRatePercent reaches 100.0% when every cacheable token was a read", () => {
  assert.equal(cacheRatePercent(tokens({ input: 0, cache: { read: 25, write: 0 } })), "100.0%");
});

// --- goSharePercent / totalGoTokens ---

test("goSharePercent divides a model's tokens by the session's Go tokens", () => {
  assert.equal(goSharePercent(250, 1000), 25);
  assert.equal(goSharePercent(1000, 1000), 100);
  assert.equal(goSharePercent(1, 3), (1 / 3) * 100);
});

test("goSharePercent is 0 rather than NaN for an empty or zero total", () => {
  assert.equal(goSharePercent(0, 0), 0);
  assert.equal(goSharePercent(500, 0), 0);
  assert.equal(goSharePercent(0, 1000), 0);
  assert.equal(goSharePercent(Number.NaN, 1000), 0);
  assert.equal(goSharePercent(500, Number.NaN), 0);
  assert.equal(goSharePercent(500, -1), 0);
  assert.ok(Number.isFinite(goSharePercent(Number.POSITIVE_INFINITY, 0)));
});

test("totalGoTokens only counts opencode-go models and skips the rest", () => {
  const go = model();
  const other = model({ providerID: "anthropic", modelID: "claude", tokens: tokens({ input: 999_999 }) });
  assert.equal(totalGoTokens([go, other]), usageTokenCount(go.tokens));
});

test("totalGoTokens is 0 for an empty list or a session with no Go models", () => {
  assert.equal(totalGoTokens([]), 0);
  assert.equal(totalGoTokens([model({ providerID: "anthropic" })]), 0);
  assert.equal(totalGoTokens([model({ tokens: tokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) })]), 0);
  assert.equal(totalGoTokens([model({ tokens: tokens({ input: Number.NaN }) })]), usageTokenCount(model().tokens) - 1000);
});

// --- groupModelsByProvider ---

test("groupModelsByProvider groups in first-seen order under the display name", () => {
  const groups = groupModelsByProvider(
    [
      model({ providerID: "anthropic", modelID: "claude" }),
      model({ modelID: "mimo-v2.6-pro" }),
      model({ providerID: "anthropic", modelID: "claude-2" }),
    ],
    new Map([
      ["anthropic", "Anthropic"],
      [GO_PROVIDER_ID, "OpenCode Go"],
    ]),
  );
  assert.deepStrictEqual(
    groups.map((group) => group.providerName),
    ["Anthropic", "OpenCode Go"],
  );
  assert.deepStrictEqual(
    groups.map((group) => group.models.map((entry) => entry.modelID)),
    [["claude", "claude-2"], ["mimo-v2.6-pro"]],
  );
  assert.deepStrictEqual(
    groups.map((group) => group.providerID),
    ["anthropic", GO_PROVIDER_ID],
  );
});

test("groupModelsByProvider falls back to the raw provider id", () => {
  const groups = groupModelsByProvider([model({ providerID: "some-new-provider" })]);
  assert.equal(groups[0].providerName, "some-new-provider");
  assert.deepStrictEqual(groupModelsByProvider([]), []);
});

// --- model labels ---

test("truncateModelName spends a fixed budget with a single ellipsis", () => {
  assert.equal(KILO_MODEL_NAME_MAX_CHARS, 19);
  const long = "openai/gpt-5-codex-preview-2026";
  const truncated = truncateModelName(long);
  assert.equal(truncated.length, KILO_MODEL_NAME_MAX_CHARS);
  assert.equal(truncated, `${long.slice(0, KILO_MODEL_NAME_MAX_CHARS - 1)}…`);
  assert.ok(!truncated.includes("..."), "an ellipsis must not cost three cells");
  assert.equal(truncateModelName("short"), "short");
  assert.equal(truncateModelName("exactly-19-chars-xx"), "exactly-19-chars-xx");
  assert.equal(truncateModelName("abcdefghijklmnopqrs", 5), "abcd…");
});

test("displayModelName strips a vendor prefix and a discount badge", () => {
  assert.equal(displayModelName("anthropic/claude-sonnet-4"), "claude-sonnet-4");
  assert.equal(displayModelName("OpenAI: gpt-5"), "gpt-5");
  assert.equal(displayModelName("gpt-5 (20% off)"), "gpt-5");
  assert.equal(displayModelName("MiMo   V2.6   Pro"), "MiMo V2.6 Pro");
  assert.equal(displayModelName("  claude-sonnet-4  "), "claude-sonnet-4");
});

test("modelDisplayName prefers the catalog name and truncates both alike", () => {
  assert.equal(modelDisplayName("MiMo-V2.6-Pro", "vendor/mimo-v2.6-pro-long-name"), "MiMo-V2.6-Pro");
  assert.equal(modelDisplayName(null, "vendor/mimo-v2.6-pro"), "mimo-v2.6-pro");
  assert.equal(modelDisplayName("  ", "vendor/mimo-v2.6-pro"), "mimo-v2.6-pro");
  assert.equal(modelDisplayName(null, ""), "");
});

// --- buildTokenUsageRows / buildModelTokenRows ---

test("buildTokenUsageRows mirrors Kilo's row labels in order", () => {
  const rows = buildTokenUsageRows({ cost: 1.5, tokens: tokens() });
  assert.deepStrictEqual(
    rows.map((row) => row.label),
    [...KILO_TOKEN_USAGE_ROWS],
  );
  assert.deepStrictEqual(rows, [
    { label: "Input", value: "1,000" },
    { label: "Output", value: "200" },
    { label: "Reasoning", value: "50" },
    { label: "Cache read", value: "300" },
    { label: "Cache write", value: "40" },
    { label: "Cache rate", value: "22.4%" },
    { label: "Cost", value: "$1.50" },
  ]);
});

test("buildTokenUsageRows renders zeros for a session that has done nothing", () => {
  const rows = buildTokenUsageRows({ cost: 0, tokens: tokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) });
  assert.deepStrictEqual(rows, [
    { label: "Input", value: "0" },
    { label: "Output", value: "0" },
    { label: "Reasoning", value: "0" },
    { label: "Cache read", value: "0" },
    { label: "Cache write", value: "0" },
    { label: "Cache rate", value: "-" },
    { label: "Cost", value: "$0.00" },
  ]);
});

test("buildModelTokenRows is the same list without Cost, which has its own column", () => {
  const rows = buildModelTokenRows(tokens());
  assert.deepStrictEqual(
    rows.map((row) => row.label),
    KILO_TOKEN_USAGE_ROWS.filter((label) => label !== "Cost"),
  );
});

// --- meterSeverityForPercent ---

test("meterSeverityForPercent shares the plan ladder thresholds", () => {
  assert.equal(meterSeverityForPercent(0), "muted");
  assert.equal(meterSeverityForPercent(74.9), "muted");
  assert.equal(meterSeverityForPercent(75), "warning");
  assert.equal(meterSeverityForPercent(89.9), "warning");
  assert.equal(meterSeverityForPercent(90), "error");
  assert.equal(meterSeverityForPercent(140), "error");
  assert.equal(meterSeverityForPercent(-5), "muted");
  assert.equal(meterSeverityForPercent(Number.NaN), "muted");
  assert.equal(meterSeverityForPercent(Number.POSITIVE_INFINITY), "muted");
  assert.equal(usageMeterSeverity(window({ percent: 90 })), meterSeverityForPercent(90));
});

// --- parseSessionModelUsage ---

const HOST_PAYLOAD = {
  sessionIDs: ["ses_1", "ses_2"],
  sessionCost: 3.25,
  totals: { steps: 7, cost: 1.5, tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 40 } } },
  models: [
    { providerID: "opencode-go", modelID: "mimo-v2.6-pro", steps: 4, cost: 1.2, tokens: { input: 800, output: 100, reasoning: 20, cache: { read: 200, write: 10 } } },
    { providerID: "anthropic", modelID: "claude", steps: 3, cost: 0.3, tokens: { input: 200, output: 100, reasoning: 30, cache: { read: 100, write: 30 } } },
  ],
};

test("parseSessionModelUsage trusts the live endpoint shape", () => {
  const usage = parseSessionModelUsage(HOST_PAYLOAD);
  assert.ok(usage !== null);
  assert.deepStrictEqual(usage.sessionIDs, ["ses_1", "ses_2"]);
  assert.equal(usage.totals.steps, 7);
  assert.equal(usage.totals.cost, 1.5);
  assert.deepStrictEqual(usage.totals.tokens, { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 40 } });
  assert.equal(usage.models.length, 2);
  assert.equal(usage.models[0].providerID, "opencode-go");
  assert.equal(usage.models[0].steps, 4);
  // `sessionCost` exists in 7.8.x and is absent in 7.7.5, so it must not leak
  // into the trusted shape anything depends on.
  assert.equal("sessionCost" in usage, false);
});

test("parseSessionModelUsage fills a missing models list instead of failing", () => {
  const usage = parseSessionModelUsage({ sessionIDs: ["ses_1"], totals: { steps: 0, cost: 0, tokens: {} } });
  assert.ok(usage !== null);
  assert.deepStrictEqual(usage.models, []);
  assert.deepStrictEqual(usage.totals.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.equal(totalGoTokens(usage.models), 0);
});

test("parseSessionModelUsage coerces hostile numbers and drops unlabelled rows", () => {
  const usage = parseSessionModelUsage({
    sessionIDs: "not-an-array",
    totals: { steps: Number.NaN, cost: -5, tokens: { input: Number.POSITIVE_INFINITY, cache: { read: -1 } } },
    models: [
      { providerID: "opencode-go", modelID: "a", steps: Number.NaN, cost: -1, tokens: { input: Number.NaN } },
      { providerID: "opencode-go", steps: 1 },
      { modelID: "b", steps: 1 },
      "garbage",
      null,
    ],
  });
  assert.ok(usage !== null);
  assert.deepStrictEqual(usage.sessionIDs, []);
  assert.equal(usage.totals.steps, 0);
  assert.equal(usage.totals.cost, 0);
  assert.equal(usage.totals.tokens.input, 0);
  assert.equal(usage.totals.tokens.cache.read, 0);
  assert.equal(usage.models.length, 1, "a row without providerID and modelID cannot be grouped or labelled");
  assert.equal(usage.models[0].modelID, "a");
  assert.equal(usageTokenCount(usage.models[0].tokens), 0);
});

test("parseSessionModelUsage rejects anything that is not an object", () => {
  assert.equal(parseSessionModelUsage(null), null);
  assert.equal(parseSessionModelUsage(undefined), null);
  assert.equal(parseSessionModelUsage("nope"), null);
  assert.equal(parseSessionModelUsage([]), null);
  assert.equal(parseSessionModelUsage(7), null);
});

// --- the Kilo layout constants the integrated panel is budgeted against ---

// The Go-only display gate used to be latched from `config.model` at init, so it
// stayed closed for anyone without a config model and never re-armed when the
// model changed -- the plugin looked installed and rendered nothing. It now
// reads the live session model on every render.
test("resolveProviderId prefers the session model over the config default", () => {
  const state = {
    config: { model: "opencode-go/mimo-v2.6-pro" },
    session: { get: () => ({ model: { providerID: "kilo" } }) },
  };
  assert.equal(resolveProviderId(state, "ses_1", undefined), "kilo");
});

test("resolveProviderId arms from the session model with no config model", () => {
  const state = { config: {}, session: { get: () => ({ model: { providerID: "opencode-go" } }) } };
  assert.equal(resolveProviderId(state, "ses_1", undefined), "opencode-go");
});

test("resolveProviderId falls back to the config default when the session has no model", () => {
  const state = { config: { model: "opencode-go/x" }, session: { get: () => undefined } };
  assert.equal(resolveProviderId(state, "ses_1", undefined), "opencode-go");
  const empty = { config: { model: "opencode-go/x" }, session: { get: () => ({}) } };
  assert.equal(resolveProviderId(empty, "ses_1", undefined), "opencode-go");
});

test("resolveProviderId falls back to the event signal last", () => {
  const state = { config: {}, session: { get: () => undefined } };
  assert.equal(resolveProviderId(state, "ses_1", "opencode-go"), "opencode-go");
  assert.equal(resolveProviderId(undefined, "ses_1", "opencode-go"), "opencode-go");
});

test("resolveProviderId survives a throwing store rather than hiding the panel", () => {
  const hostile = {
    config: { model: "opencode-go/x" },
    session: {
      get() {
        throw new Error("store unavailable");
      },
    },
  };
  assert.equal(resolveProviderId(hostile, "ses_1", undefined), "opencode-go");
});

test("resolveProviderId reports nothing usable rather than guessing", () => {
  const empty = { config: {}, session: { get: () => undefined } };
  assert.equal(resolveProviderId(empty, "ses_1", undefined), undefined);
  assert.equal(resolveProviderId(undefined, "ses_1", undefined), undefined);
});

test("providerIdFromModel takes the provider segment and rejects junk", () => {
  assert.equal(providerIdFromModel("opencode-go/mimo-v2.6-pro"), "opencode-go");
  assert.equal(providerIdFromModel("kilo/xiaomi/mimo-v2-pro:free"), "kilo");
  assert.equal(providerIdFromModel("opencode-go"), "opencode-go");
  assert.equal(providerIdFromModel(""), undefined);
  assert.equal(providerIdFromModel("   "), "   ");
  assert.equal(providerIdFromModel("/leading-slash"), undefined);
  assert.equal(providerIdFromModel(undefined), undefined);
  assert.equal(providerIdFromModel(42), undefined);
});

// --- aggregateModelUsageFromMessages (the opencode side of the model mix) ---
//
// opencode has no model-usage endpoint: every assistant message in the host's
// store already carries the provider, the model, the cost and the five token
// buckets, so the per-model split is a fold over the session's own messages.
// The point of the assertions below is that the fold produces exactly the shape
// Kilo's endpoint returns, and that an unusable message cannot take share from
// a model that is real.

function assistantMessage(overrides = {}) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    providerID: "opencode-go",
    modelID: "mimo-v2.6-pro",
    cost: 0.5,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
    ...overrides,
  };
}

test("aggregateModelUsageFromMessages folds a session's assistant messages per model", () => {
  const usage = aggregateModelUsageFromMessages([
    { id: "m0", sessionID: "ses_1", role: "user" },
    assistantMessage(),
    assistantMessage({ id: "m2", cost: 0.25, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 100, write: 5 } } }),
    assistantMessage({ id: "m3", modelID: "qwen3-max", cost: 0.1, tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]);

  assert.deepStrictEqual(usage.sessionIDs, ["ses_1"]);
  assert.equal(usage.models.length, 2);
  const [mimo, qwen] = usage.models;
  assert.equal(mimo.modelID, "mimo-v2.6-pro");
  assert.equal(mimo.steps, 2, "one step per assistant message, not per model");
  assert.equal(mimo.cost, 0.75);
  assert.deepStrictEqual(mimo.tokens, { input: 150, output: 25, reasoning: 5, cache: { read: 300, write: 15 } });
  assert.equal(qwen.steps, 1);

  // The totals row is the sum of the models, exactly like the host endpoint's.
  assert.equal(usage.totals.steps, 3);
  assert.equal(usage.totals.cost, 0.85);
  assert.deepStrictEqual(usage.totals.tokens, {
    input: 160,
    output: 26,
    reasoning: 5,
    cache: { read: 300, write: 15 },
  });
});

test("aggregateModelUsageFromMessages produces the same shape as the host endpoint", () => {
  const fromMessages = aggregateModelUsageFromMessages([assistantMessage()]);
  const fromEndpoint = parseSessionModelUsage({
    sessionIDs: ["ses_1"],
    totals: { steps: 1, cost: 0.5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } } },
    models: [{ providerID: "opencode-go", modelID: "mimo-v2.6-pro", steps: 1, cost: 0.5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } } }],
  });
  // Same renderer, same numbers: the two hosts' model sections are interchangeable.
  assert.deepStrictEqual(fromMessages, fromEndpoint);
});

test("aggregateModelUsageFromMessages drops messages it cannot weigh", () => {
  const usage = aggregateModelUsageFromMessages([
    assistantMessage(),
    { role: "assistant" },
    { role: "assistant", modelID: "b" },
    { role: "assistant", providerID: "opencode-go" },
    { role: "assistant", providerID: "  ", modelID: "b" },
    assistantMessage({ id: "m9", cost: Number.NaN, tokens: { input: Number.POSITIVE_INFINITY, cache: { read: -1 } } }),
    "garbage",
    null,
  ]);
  // Only the two weighted messages survive; the unlabelled ones would otherwise
  // fold into a bucket no row can show, silently stealing share.
  assert.equal(usage.models.length, 1);
  assert.equal(usage.models[0].steps, 2);
  assert.equal(usage.models[0].cost, 0.5, "a NaN cost must not poison the total");
  assert.equal(usage.models[0].tokens.input, 100);
  assert.equal(usage.models[0].tokens.cache.read, 200, "a negative bucket clamps to 0");
});

test("aggregateModelUsageFromMessages returns an empty shape for a session with no usage", () => {
  for (const input of [[], [{ role: "user" }], [null], undefined]) {
    const usage = aggregateModelUsageFromMessages(input ?? []);
    assert.deepStrictEqual(usage, {
      sessionIDs: [],
      totals: { steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      models: [],
    });
  }
});

// --- weightGoModels (the sidebar's model mix) ---

function goModel(modelID, tokens, overrides = {}) {
  return {
    providerID: "opencode-go",
    modelID,
    steps: 1,
    cost: 0.1,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

const MIX_MODELS = [
  goModel("mimo-v2.6-pro", 1_420_000, { steps: 96, cost: 0.91 }),
  goModel("qwen3-max", 610_000, { steps: 41, cost: 0.38 }),
  goModel("gpt-5.1", 280_000, { steps: 18, cost: 0.19 }),
  goModel("haiku-4.5", 60_000, { steps: 4, cost: 0.02 }),
  goModel("longcat-2.5", 30_000, { steps: 2, cost: 0.01 }),
];

test("weightGoModels ranks the heaviest Go models and weights them against the Go total", () => {
  const weights = weightGoModels(MIX_MODELS);
  assert.deepStrictEqual(
    weights.models.map((model) => model.modelID),
    ["mimo-v2.6-pro", "qwen3-max", "gpt-5.1"],
    "the list is capped at the top three, heaviest first",
  );
  assert.equal(weights.goModels, 5, "the header counts every Go model, not the rows");
  assert.equal(weights.otherCount, 2);
  assert.equal(weights.goTokens, 2_400_000);
  assert.equal(weights.listedTokens, 2_310_000);
  assert.equal(Math.round(weights.listedShare), 96);
  assert.equal(Math.round(weights.models[0].share), 59);
  assert.equal(Math.round(weights.models[2].share), 12);
  // Session totals cover every Go model, not only the listed three.
  assert.equal(weights.steps, 161);
  assert.equal(weights.cost, 1.51);
  // No bar string: the meter is drawn as boxes at `share` percent, so the row
  // carries the number and nothing pre-rendered.
});

test("weightGoModels ignores models from another provider", () => {
  // A model from another provider has no weight here: the section is the Go
  // plan's mix, and folding a foreign provider in would silently shrink every
  // share the user is shown.
  const weights = weightGoModels([
    ...MIX_MODELS,
    { ...goModel("claude-sonnet-4", 9_000_000), providerID: "anthropic" },
  ]);
  assert.equal(weights.goTokens, 2_400_000);
  assert.equal(weights.goModels, 5);
  assert.equal(weights.models[0].modelID, "mimo-v2.6-pro");
});

test("weightGoModels breaks ties so the ranking does not reshuffle between renders", () => {
  const weights = weightGoModels([
    goModel("b-model", 100, { steps: 1 }),
    goModel("a-model", 100, { steps: 1 }),
    goModel("c-model", 100, { steps: 5 }),
  ]);
  assert.deepStrictEqual(
    weights.models.map((model) => model.modelID),
    ["c-model", "a-model", "b-model"],
    "more steps first, then the model id",
  );
});

test("weightGoModels reports 0% rather than NaN when no Go token is attributed", () => {
  const weights = weightGoModels([goModel("mimo-v2.6-pro", 0)]);
  assert.equal(weights.models.length, 1);
  assert.equal(weights.models[0].share, 0);
  assert.equal(weights.models[0].share, 0);
  assert.equal(weightGoModels([]).models.length, 0);
  assert.equal(weightGoModels([]).goTokens, 0);
  assert.equal(weightGoModels([], 3, 0).models[0]?.bar, undefined);
});

test("weightGoModels honors an explicit limit", () => {
  const weights = weightGoModels(MIX_MODELS, 1);
  assert.equal(weights.models.length, 1);
  assert.equal(weights.otherCount, 4);
  assert.equal(Math.round(weights.listedShare), 59);
});

// --- buildModelMixSummary (the collapsed line) ---

test("buildModelMixSummary joins the mix and stops before it overflows the sidebar", () => {
  const entries = [
    { name: "mimo", share: 59.2 },
    { name: "qwen", share: 25.4 },
    { name: "gpt", share: 11.8 },
  ];
  assert.equal(buildModelMixSummary(entries), "mimo 59%\u00b7qwen 25%\u00b7gpt 12%");
  assert.ok(buildModelMixSummary(entries).length <= GO_MODEL_MIX_BUDGET);
  // A narrower sidebar drops whole entries: a truncated `qwen 2…` would read as a
  // different number than `qwen 25%`.
  const narrow = buildModelMixSummary(entries, 18);
  assert.equal(narrow, "mimo 59%\u00b7qwen 25%");
  assert.ok(!narrow.includes("…"), "an entry is never half-printed");
});

test("buildModelMixSummary always keeps the leader", () => {
  // The names the caller passes are capped, so the leader fits; the budget only
  // ever decides the second entry onwards.
  assert.equal(buildModelMixSummary([{ name: "abcdef", share: 100 }], 4), "abcdef 100%");
  assert.equal(
    buildModelMixSummary([{ name: "mimo", share: 59 }, { name: "qwen", share: 25 }], 4),
    "mimo 59%",
    "a mix line without the leader says nothing",
  );
  assert.equal(buildModelMixSummary([], GO_MODEL_MIX_BUDGET), "");
});

// --- buildGoModelFooters ---

test("buildGoModelFooters reports what the rows cover and what the session spent", () => {
  const weights = weightGoModels(MIX_MODELS);
  assert.deepStrictEqual(buildGoModelFooters(weights), ["2.31M of 2.4M Go tokens", "161 steps · $1.51"]);
  assert.ok(buildGoModelFooters(weights).every((line) => line.length <= 30), "both footers fit the sidebar");
  // Nothing to cover means no footers: an empty section must not print zeroes.
  assert.deepStrictEqual(buildGoModelFooters(weightGoModels([])), []);
});

// --- the short names and counts the mix line is built from ---

test("shortModelName takes the leading segment of a model name", () => {
  assert.equal(shortModelName("MiMo-V2.6-Pro"), "mimo");
  assert.equal(shortModelName("Qwen3 Max"), "qwen3…", "capped to the mix line's name budget");
  assert.equal(shortModelName("GPT-5.1"), "gpt");
  assert.equal(shortModelName("sonnet"), "sonnet");
  assert.equal(shortModelName("claude/sonnet-4"), "claude");
  assert.equal(shortModelName("  spaced-name  "), "spaced");
  assert.equal(shortModelName(""), "");
  assert.equal(shortModelName("   "), "");
  // A first segment longer than the budget is truncated, not cut in half.
  assert.equal(shortModelName("anthropic/claude-sonnet-4"), "anthr…");
});

test("formatTokenCount stays inside a sidebar cell budget", () => {
  assert.equal(formatTokenCount(1_420_000), "1.42M");
  assert.equal(formatTokenCount(610_000), "610K", "below a million the integer form is shorter");
  assert.equal(formatTokenCount(1_200_000), "1.2M", "trailing zeros claim precision the API never had");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(1_500_000_000), "1.5B");
  assert.equal(formatTokenCount(-5), "0");
  assert.equal(formatTokenCount(Number.NaN), "0");
  assert.equal(formatTokenCount(undefined), "0");
  for (const value of [1_420_000, 610_000, 12, 4_200_000_000]) {
    assert.ok(formatTokenCount(value).length <= 6, `${value} must fit next to a bar`);
  }
});

test("modelDisplayName takes the sidebar's own width budget", () => {
  assert.equal(modelDisplayName("MiMo-V2.6-Pro", "mimo-v2.6-pro", OPENCODE_MODEL_NAME_MAX_CHARS), "MiMo-V2.6-P…");
  assert.equal(modelDisplayName(null, "mimo-v2.6-pro", 12), "mimo-v2.6-p…");
  assert.equal(modelDisplayName("MiMo-V2.6-Pro", "mimo-v2.6-pro"), "MiMo-V2.6-Pro", "Kilo's default width is unchanged");
});

// --- the opencode layout budget, and the meters it is spent on ---

test("relevantReset names the window the countdown belongs to", () => {
  assert.deepEqual(relevantReset(tuiSnapshot()), { label: "5h", text: "2h5m" });
  // The soonest window wins, and the label travels with it.
  const weeklyFirst = tuiSnapshot({
    rolling: { percent: 10, status: "active", limited: false, resetInSec: 90000, resetText: null },
    weekly: { percent: 15, status: "active", limited: false, resetInSec: 120, resetText: null },
  });
  assert.deepEqual(relevantReset(weeklyFirst), { label: "7d", text: "2m" });
});

test("relevantReset prefers the exhausted 30d over the sooner 5h", () => {
  // The whole reason this selector exists: a spent month is what stops work, so
  // the countdown it prints is the month's, not the 5h's comfort.
  const monthSpent = tuiSnapshot({
    rolling: { percent: 0, status: "active", limited: false, resetInSec: 7080, resetText: null },
    monthly: { percent: 100, status: "exhausted", limited: true, resetInSec: 777600, resetText: null },
  });
  assert.deepEqual(relevantReset(monthSpent), { label: "30d", text: "1w 2d" });
});

test("relevantReset takes the longest cap when several windows are capped", () => {
  const allSpent = tuiSnapshot({
    rolling: { percent: 100, status: "exhausted", limited: true, resetInSec: 7080, resetText: null },
    weekly: { percent: 100, status: "exhausted", limited: true, resetInSec: 262800, resetText: null },
    monthly: { percent: 100, status: "exhausted", limited: true, resetInSec: 777600, resetText: null },
  });
  assert.deepEqual(relevantReset(allSpent), { label: "30d", text: "1w 2d" });
});

test("relevantReset prints a cap's free-text reset when it has no instant", () => {
  const textOnly = tuiSnapshot({
    monthly: { percent: 100, status: "capped", limited: true, resetInSec: null, resetText: "Oct 2" },
  });
  assert.deepEqual(relevantReset(textOnly), { label: "30d", text: "Oct 2" });
});

test("relevantReset falls through to the soonest reset when a cap has none", () => {
  const silentCap = tuiSnapshot({
    rolling: { percent: 10, status: "active", limited: false, resetInSec: 7080, resetText: null },
    monthly: { percent: 100, status: "capped", limited: true, resetInSec: null, resetText: null },
  });
  assert.deepEqual(relevantReset(silentCap), { label: "5h", text: "1h58m" });
});

test("relevantReset stays silent when there is no usable countdown", () => {
  const none = tuiSnapshot({
    rolling: { percent: 10, status: "active", limited: false, resetInSec: null, resetText: null },
    weekly: { percent: 15, status: "active", limited: false, resetInSec: null, resetText: null },
    monthly: { percent: 15, status: "active", limited: false, resetInSec: null, resetText: null },
  });
  assert.equal(relevantReset(none), null);
  // A stale payload, clock skew or a reset that fired mid-flight can all send a
  // negative span; an elapsed countdown is as unusable as an unreadable one.
  assert.equal(
    relevantReset(
      tuiSnapshot({ rolling: { percent: 10, status: "active", limited: false, resetInSec: -30, resetText: null } }),
    ),
    null,
  );
  assert.equal(
    relevantReset(
      tuiSnapshot({
        rolling: { percent: 10, status: "active", limited: false, resetInSec: Number.NaN, resetText: "soon" },
      }),
    ),
    null,
    "only resetInSec is compared: the scrape's free text is not a countdown",
  );
});

// --- the stacked meter columns ---
//
// The plan meters used to be a label plus a `space-between` meter group, so the
// bar started wherever the label ended and the three rows only looked stacked
// when the labels happened to match. The rows are now fixed-width columns, and
// the percent is padded in the STRING: a text node's `width` reserves cells but
// does not right-align what is inside them, so "42%" and "100%" would still end
// on different columns.

test("the percent cell's right edge is what aligns, not its left", () => {
  // `  0%` and `100%` start two cells apart and must still end together: the
  // sidebar grid is checked on END columns, because that is what right-alignment
  // means. (The e2e used to assert starts and only passed because the mock's
  // percents are all two digits.)
  const ends = new Set([0, 7, 42, 100].map((p) => formatPercentCell(p).length));
  assert.equal(ends.size, 1, "every percent cell is the same width, so the ends align");
  assert.equal(formatPercentCell(0).length, formatPercentCell(100).length);
});

test("formatPercentCell right-aligns every percent in one column", () => {
  assert.equal(formatPercentCell(0), "   0%");
  assert.equal(formatPercentCell(9), "   9%");
  assert.equal(formatPercentCell(42), "  42%");
  assert.equal(formatPercentCell(100), " 100%");
  // Every value in the column is the same width, so nothing shifts.
  const widths = new Set([0, 1, 9, 10, 42, 99, 100].map((p) => formatPercentCell(p).length));
  assert.equal(widths.size, 1, "percent cells must all be the same width");
  assert.equal(formatPercentCell(100).length, PERCENT_CELL_WIDTH);
});

test("formatPercentCell keeps a broken percent out of the column", () => {
  // NaN or Infinity would print "NaN%"/"∞%" and stretch the row it sits in.
  assert.equal(formatPercentCell(Number.NaN), "   0%");
  assert.equal(formatPercentCell(Number.POSITIVE_INFINITY), "   0%");
  assert.equal(formatPercentCell(42.6), "  43%", "the same rounding the bars use");
  assert.equal(formatPercentCell(42, 3), "42%", "an explicit width still pads");
  // Out of range is CLAMPED, not printed: `padStart` never truncates, so five
  // digits would push the row one cell wider than every other row and undo the
  // alignment the cell exists for. Clamped to the same 0-100 the meter draws, so
  // the number and the bar cannot disagree.
  assert.equal(formatPercentCell(-7), "   0%", "a negative percent reads as empty, like the bar");
  assert.equal(formatPercentCell(1234), " 100%", "an over-full percent reads as full, like the bar");
  for (const broken of [-7, -1234, 1234, 1e9, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      formatPercentCell(broken).length,
      PERCENT_CELL_WIDTH,
      `an out-of-range percent (${broken}) must not stretch its column`,
    );
  }
});


// ---------------------------------------------------------------------------
// The usage ladder, arithmetically
// ---------------------------------------------------------------------------
//
// The same rungs test/e2e/tui-meters.test.js drives through a real host, checked
// here against the arithmetic instead of the pixels. This tier runs on every push
// and PR in seconds, where the e2e tier needs a container and minutes; together
// they mean a regression in how a meter is divided shows up immediately, and a
// regression in how it is laid out shows up before anything ships.

test("the meter and its percent cell tell the same story at every ladder rung", () => {
  // A meter's two parts are percentages that sum to 100, so the split is a
  // function of the reading alone. Anything that made the track a fixed size, or
  // the fill a minimum, would show up here as a total other than 100.
  for (const { name, plan } of usageLadders()) {
    for (const percent of plan) {
      const fill = meterFillPercent(percent);
      const track = 100 - fill;
      assert.equal(
        fill + track,
        100,
        `${name}: the fill (${fill}%) and the track (${track}%) must partition the meter`,
      );
      assert.ok(fill >= 0 && fill <= 100, `${name}: the fill must stay inside the meter (${fill}%)`);
      // And the cell must be exactly as wide at the ends of the range as in the
      // middle, which is the column the whole block is built on.
      assert.equal(
        formatPercentCell(percent).length,
        PERCENT_CELL_WIDTH,
        `${name}: ${percent}% must not move its column`,
      );
    }
  }
});

test("the meter has no track cell left beside a full bar, and none at the ends", () => {
  // The defect the ladder was written for: with a flexible track the pair
  // overflowed the meter at 100%, painting a cell of the wrong color into the
  // padding beside the percent and making the meter a cell wider than at any
  // other reading. A split by percentage cannot overflow, so these are the
  // invariants that hold it in place.
  assert.equal(meterFillPercent(100), 100, "a full meter is entirely fill");
  assert.equal(100 - meterFillPercent(100), 0, "a full meter has no track left to draw");
  assert.equal(meterFillPercent(0), 0, "an empty meter has no fill to draw");
  assert.equal(100 - meterFillPercent(0), 100, "an empty meter is entirely track");
  // Every rung in between is a strict split, and the extremes are the only ones
  // where either part vanishes.
  for (const percent of [1, 42, 50, 75, 80, 90, 95, 99]) {
    assert.ok(meterFillPercent(percent) > 0, `${percent}% must draw a fill`);
    assert.ok(100 - meterFillPercent(percent) > 0, `${percent}% must leave a track`);
  }
});

test("the ladder covers every rung the meters can be asked for", () => {
  // The e2e drives this list against a real host, so the list itself has to mean
  // something: both extremes, the midpoint, one rung past each color threshold,
  // and a mixed distribution rotated so every value lands in every column.
  const ladders = usageLadders();
  const names = ladders.map((rung) => rung.name);
  for (const required of ["all-full", "all-empty", "all-half", "all-warning", "all-danger"]) {
    assert.ok(names.includes(required), `the ladder must include ${required} (got ${names.join(", ")})`);
  }
  assert.equal(
    ladders.filter((rung) => rung.name.startsWith("mixed-rotation-")).length,
    4,
    "the mixed distribution must be rotated four times",
  );
  // Each rotation is a different arrangement, so a layout bug that only shows up
  // for one value in one column cannot hide behind a single mixed rung.
  const arrangements = ladders
    .filter((rung) => rung.name.startsWith("mixed-rotation-"))
    .map((rung) => [...rung.plan, rung.share].join(","));
  assert.equal(new Set(arrangements).size, 4, `the rotations must differ (got ${arrangements.join(" | ")})`);
  // Every rung's declared severity must be the one the real ladder gives it, so a
  // uniform rung cannot quietly stop testing the color it claims to test.
  for (const { name, plan, share, severity } of ladders) {
    if (severity === "mixed") continue;
    for (const percent of [...plan, share]) {
      assert.equal(
        meterSeverityForPercent(percent),
        severity,
        `${name}: ${percent}% must color as ${severity}`,
      );
    }
  }
});

test("the Go share label gets a fixed cell, so only its meter can grow", () => {
  // The share row's label used to be `flexGrow`, so the label and the meter both
  // claimed the slack and the split moved with the reading. The label cell is now
  // exactly the label, which is what pins the meter's start column.
  assert.equal(
    GO_SHARE_LABEL_WIDTH,
    INTEGRATED_GO_SHARE_LABEL.length,
    "the share label cell must be exactly the label, or the meter moves when it is renamed",
  );
  // Long enough not to truncate the label it holds.
  assert.ok(
    GO_SHARE_LABEL_WIDTH >= INTEGRATED_GO_SHARE_LABEL.length,
    "the share label cell must fit its own label",
  );
  // And it is its own column: the plan labels are three cells wide, and sharing
  // that width with an eight-cell label would be what pushed the meter sideways.
  assert.notEqual(
    GO_SHARE_LABEL_WIDTH,
    PLAN_LABEL_WIDTH,
    "the share label is longer than a plan label and needs its own cell",
  );
});
