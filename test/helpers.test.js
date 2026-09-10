// Pure-helper suite: runs without a build consumer (imports compiled dist)
// plus the plain-JS bin helpers. Run with `npm test` (`node --test test/`).
// Requires `npm run build` first so `dist/` exists (dist is gitignored).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildUsageRows,
  formatCompactLine as formatTuiLine,
  formatResetDuration,
  isSnapshotEmpty,
  parseBooleanFlag,
  surfaceSelectionFromDisplayMode,
} from "../dist/tui.js";
import { formatCompactLine as formatServerLine } from "../dist/index.js";
import {
  ensureTuiEntry,
  normalizeTuiEntry,
  parseOptionalToggle,
  readTuiSelection,
} from "../bin/lib.js";

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

// --- parseBooleanFlag (dist/tui.js) ---

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

// --- formatResetDuration (dist/tui.js) ---

test("formatResetDuration formats hours/minutes/seconds", () => {
  assert.equal(formatResetDuration(7543), "2h5m");
  assert.equal(formatResetDuration(3600), "1h0m");
  assert.equal(formatResetDuration(300), "5m");
  assert.equal(formatResetDuration(45), "45s");
  assert.equal(formatResetDuration(0), "0s");
});

test("formatResetDuration returns null for null/negative/non-finite", () => {
  assert.equal(formatResetDuration(null), null);
  assert.equal(formatResetDuration(-1), null);
  assert.equal(formatResetDuration(Number.NaN), null);
  assert.equal(formatResetDuration(Number.POSITIVE_INFINITY), null);
});

// --- buildUsageRows (dist/tui.js) ---

test("buildUsageRows renders all three windows with sidebar reset text", () => {
  assert.deepEqual(buildUsageRows(tuiSnapshot()), [
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
  assert.deepEqual(rows, [{ label: "5h", value: "10% · resets soon" }]);
});

test("buildUsageRows returns no rows for an empty snapshot", () => {
  const empty = tuiSnapshot({ rolling: null, weekly: null, monthly: null });
  assert.deepEqual(buildUsageRows(empty), []);
});

// --- formatCompactLine statusline (dist/tui.js): 3 windows, no reset suffix ---

test("tui formatCompactLine shows 5h, 7d and 30d without reset text", () => {
  assert.equal(formatTuiLine(tuiSnapshot()), "Go 5h 42% | 7d 15% | 30d 61%");
});

test("tui formatCompactLine keeps n/a fallbacks per window", () => {
  const partial = tuiSnapshot({ rolling: null, monthly: null });
  assert.equal(formatTuiLine(partial), "Go 5h n/a | 7d 15% | 30d n/a");
  const empty = tuiSnapshot({ rolling: null, weekly: null, monthly: null });
  assert.equal(formatTuiLine(empty), "Go 5h n/a | 7d n/a | 30d n/a");
});

// --- isSnapshotEmpty / surfaceSelectionFromDisplayMode (dist/tui.js) ---

test("isSnapshotEmpty is true only when every window is missing", () => {
  assert.equal(isSnapshotEmpty(tuiSnapshot({ rolling: null, weekly: null, monthly: null })), true);
  assert.equal(isSnapshotEmpty(tuiSnapshot({ rolling: null, weekly: null })), false);
  assert.equal(isSnapshotEmpty(tuiSnapshot()), false);
});

test("surfaceSelectionFromDisplayMode maps every display mode", () => {
  assert.deepEqual(surfaceSelectionFromDisplayMode("both"), { sidebar: true, statusline: true });
  assert.deepEqual(surfaceSelectionFromDisplayMode("sidebar"), { sidebar: true, statusline: false });
  assert.deepEqual(surfaceSelectionFromDisplayMode("statusline"), { sidebar: false, statusline: true });
});

// --- formatCompactLine server copy (dist/index.js) keeps its reset suffix ---

test("server formatCompactLine keeps the rolling reset suffix", () => {
  const snapshot = {
    ...tuiSnapshot(),
    rolling: { percent: 42, resetInSec: 7543, status: "active", resetText: null },
    weekly: { percent: 15, resetInSec: null, status: "active", resetText: null },
    monthly: { percent: 61, resetInSec: null, status: "active", resetText: null },
  };
  assert.equal(formatServerLine(snapshot), "Go 5h 42% (reset 2h5m) | 7d 15% | 30d 61%");
});

test("server formatCompactLine reports unavailable snapshots with reason", () => {
  const snapshot = {
    rolling: null,
    weekly: null,
    monthly: null,
    source: "unavailable",
    fetchedAt: 0,
    apiUnavailable: true,
    apiError: "not configured",
  };
  assert.equal(formatServerLine(snapshot), "Go n/a (not configured)");
});

// --- bin/lib.js flag parsing and tui entry normalization ---

test("parseOptionalToggle parses flags and rejects invalid values", () => {
  assert.equal(parseOptionalToggle(["--sidebar", "1"], "--sidebar"), true);
  assert.equal(parseOptionalToggle(["--sidebar=false"], "--sidebar"), false);
  assert.equal(parseOptionalToggle([], "--sidebar"), null);
  assert.throws(() => parseOptionalToggle(["--sidebar", "yes"], "--sidebar"), /invalid value for --sidebar/);
});

test("normalizeTuiEntry handles string, tuple, and invalid entries", () => {
  assert.deepEqual(normalizeTuiEntry("./plugins/oc-go-usage-display.tsx"), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
  assert.deepEqual(
    normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", { sidebar: true, statusline: false }]),
    { spec: "./plugins/oc-go-usage-display.tsx", sidebar: true, statusline: false },
  );
  assert.equal(normalizeTuiEntry(42), null);
  assert.deepEqual(normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", "nope"]), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
});

test("ensureTuiEntry round-trips through readTuiSelection in a temp dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-test-"));
  try {
    const written = ensureTuiEntry(dir, { sidebar: true, statusline: false });
    assert.equal(written.changed, true);
    assert.deepEqual(readTuiSelection(dir), {
      found: true,
      entry: true,
      sidebar: true,
      statusline: false,
    });
    const repeated = ensureTuiEntry(dir, { sidebar: true, statusline: false });
    assert.equal(repeated.changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
