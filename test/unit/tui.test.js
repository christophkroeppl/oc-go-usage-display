// Unit tier: `dist/helpers.js` TUI helpers — display-mode selection, flag
// parsing, sidebar rows, the compact statusline, the plan meters, and the
// session-usage block the integrated sidebar renders.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModelTokenRows,
  buildPlanRows,
  buildTokenUsageRows,
  buildUsageRows,
  cacheRatePercent,
  DEFAULT_SIDEBAR_MODE,
  displayModelName,
  formatStatusline,
  formatUsageCost,
  formatUsageCount,
  goSharePercent,
  groupModelsByProvider,
  isSnapshotEmpty,
  meterSeverityForPercent,
  METER_WIDTH,
  modelDisplayName,
  parseBooleanFlag,
  parseSidebarMode,
  surfaceSelectionFromDisplayMode,
  totalGoTokens,
  truncateModelName,
  usageMeterBar,
  usageMeterSeverity,
  usageTokenCount,
} from "../../dist/helpers.js";
import {
  CACHE_RATE_DECIMALS,
  CACHE_RATE_EMPTY,
  GO_PROVIDER_ID,
  KILO_COST_COLUMN_WIDTH,
  KILO_MODEL_NAME_MAX_CHARS,
  KILO_STEPS_COLUMN_WIDTH,
  KILO_TOKEN_USAGE_ROWS,
  parseSessionModelUsage,
  toUsageCount,
} from "../../dist/shared.js";

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

// --- buildUsageRows ---

test("buildUsageRows renders all three windows with sidebar reset text", () => {
  assert.deepStrictEqual(buildUsageRows(tuiSnapshot()), [
    { label: "5h", value: "42% · resets 2h5m" },
    { label: "7d", value: "15%" },
    { label: "30d", value: "61%" },
  ]);
});

test("buildUsageRows falls back to resetText and omits missing windows", () => {
  const rows = buildUsageRows(
    tuiSnapshot({
      rolling: { percent: 10, status: "ok", limited: false, resetInSec: null, resetText: "soon" },
      weekly: null,
      monthly: null,
    }),
  );
  assert.deepStrictEqual(rows, [{ label: "5h", value: "10% · resets soon" }]);
});

test("buildUsageRows returns no rows for an empty snapshot", () => {
  const empty = tuiSnapshot({ rolling: null, weekly: null, monthly: null });
  assert.deepStrictEqual(buildUsageRows(empty), []);
});

// --- formatStatusline: 3 windows, no reset suffix ---

test("formatStatusline shows 5h, 7d and 30d without reset text", () => {
  assert.equal(formatStatusline(tuiSnapshot()), "Go 5h 42% | 7d 15% | 30d 61%");
});

test("formatStatusline keeps n/a fallbacks per window", () => {
  const partial = tuiSnapshot({ rolling: null, monthly: null });
  assert.equal(formatStatusline(partial), "Go 5h n/a | 7d 15% | 30d n/a");
  const empty = tuiSnapshot({ rolling: null, weekly: null, monthly: null });
  assert.equal(formatStatusline(empty), "Go 5h n/a | 7d n/a | 30d n/a");
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

test("usageMeterBar fills proportionally to the percent", () => {
  assert.equal(usageMeterBar(0, 16), "░░░░░░░░░░░░░░░░");
  assert.equal(usageMeterBar(100, 16), "████████████████");
  assert.equal(usageMeterBar(50, 16), "████████░░░░░░░░");
  assert.equal(usageMeterBar(42, 16), "███████░░░░░░░░░");
  assert.equal(usageMeterBar(61, 16), "██████████░░░░░░");
});

test("usageMeterBar saturates instead of overflowing the width", () => {
  // The API can report >100; `repeat` with a negative count throws, and an
  // over-wide bar would break the host's row layout.
  assert.equal(usageMeterBar(150, 16), "████████████████");
  assert.equal(usageMeterBar(-20, 16), "░░░░░░░░░░░░░░░░");
  assert.equal(usageMeterBar(50, 4), "██░░");
  assert.equal(usageMeterBar(50, 0), "");
  assert.equal(usageMeterBar(50, -3), "");
});

test("usageMeterBar degrades to an empty bar for a non-finite percent", () => {
  assert.equal(usageMeterBar(Number.NaN), "");
  assert.equal(usageMeterBar(Number.POSITIVE_INFINITY), "");
  assert.equal(usageMeterBar(50, Number.NaN), "");
});

test("usageMeterBar defaults to the shared width", () => {
  assert.equal(METER_WIDTH, 16);
  assert.equal(usageMeterBar(100).length, METER_WIDTH);
});

// --- buildPlanRows ---

test("buildPlanRows meters every window in 5h/7d/30d order", () => {
  assert.deepStrictEqual(buildPlanRows(tuiSnapshot()), [
    { label: "5h", bar: usageMeterBar(42), percent: 42, severity: "muted", reset: null },
    { label: "7d", bar: usageMeterBar(15), percent: 15, severity: "muted", reset: null },
    { label: "30d", bar: usageMeterBar(61), percent: 61, severity: "muted", reset: null },
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

test("the Kilo table budget is pinned next to the ladder it belongs to", () => {
  assert.equal(KILO_STEPS_COLUMN_WIDTH, 5);
  assert.equal(KILO_COST_COLUMN_WIDTH, 9);
  assert.equal(KILO_MODEL_NAME_MAX_CHARS, 19);
  assert.equal(usageMeterBar(100).length, METER_WIDTH);
});
