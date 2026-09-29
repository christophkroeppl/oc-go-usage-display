// Unit tier: `dist/helpers.js` TUI helpers — display-mode selection, flag
// parsing, sidebar rows, the compact statusline, and the plan meters.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanRows,
  buildUsageRows,
  DEFAULT_SIDEBAR_MODE,
  formatStatusline,
  isSnapshotEmpty,
  METER_WIDTH,
  parseBooleanFlag,
  parseSidebarMode,
  surfaceSelectionFromDisplayMode,
  usageMeterBar,
  usageMeterSeverity,
} from "../../dist/helpers.js";

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
