// Unit tier: `dist/helpers.js` TUI helpers — display-mode selection, flag
// parsing, sidebar rows, and the compact statusline.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUsageRows,
  formatStatusline,
  isSnapshotEmpty,
  parseBooleanFlag,
  surfaceSelectionFromDisplayMode,
} from "../../dist/helpers.js";

function tuiSnapshot(overrides = {}) {
  return {
    rolling: { percent: 42, resetInSec: 7543, resetText: null },
    weekly: { percent: 15, resetInSec: null, resetText: null },
    monthly: { percent: 61, resetInSec: null, resetText: null },
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
      rolling: { percent: 10, resetInSec: null, resetText: "soon" },
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
