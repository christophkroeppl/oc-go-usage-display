// Pure-helper suite: runs without a build consumer (imports compiled dist)
// plus the plain-JS bin helpers. Run with `npm test` (`node --test test/`).
// `pretest` rebuilds `dist/` so `npm test` never runs against stale output.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  extractSnapshotFromApiPayload,
  extractWindow,
  unavailableSnapshot,
} from "../dist/shared.js";
import {
  ensureServerEntry,
  ensureTuiEntry,
  linkPluginFiles,
  normalizeTuiEntry,
  parseOptionalToggle,
  readTuiSelection,
  removePluginFiles,
  removeServerEntry,
  removeTuiEntry,
} from "../bin/lib.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-test-"));
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
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("both"), { sidebar: true, statusline: true });
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("sidebar"), { sidebar: true, statusline: false });
  assert.deepStrictEqual(surfaceSelectionFromDisplayMode("statusline"), { sidebar: false, statusline: true });
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

// --- extractSnapshotFromApiPayload tolerant shapes (dist/shared.js) ---

test("extractSnapshotFromApiPayload accepts root-level windows", () => {
  const snapshot = extractSnapshotFromApiPayload({
    rolling: { percent: 42 },
    weekly: { percent: 15 },
    monthly: { percent: 61 },
  });
  assert.equal(snapshot?.source, "api");
  assert.equal(snapshot?.rolling?.percent, 42);
  assert.equal(snapshot?.weekly?.percent, 15);
  assert.equal(snapshot?.monthly?.percent, 61);
});

test("extractSnapshotFromApiPayload accepts usage/data/go containers", () => {
  for (const key of ["usage", "data", "go"]) {
    const snapshot = extractSnapshotFromApiPayload({
      [key]: { rolling: { percent: 10 }, weekly: { percent: 20 }, monthly: { percent: 30 } },
    });
    assert.equal(snapshot?.rolling?.percent, 10, `container ${key} rolling`);
    assert.equal(snapshot?.weekly?.percent, 20, `container ${key} weekly`);
    assert.equal(snapshot?.monthly?.percent, 30, `container ${key} monthly`);
  }
});

test("extractSnapshotFromApiPayload accepts alternate window and percent keys", () => {
  const snapshot = extractSnapshotFromApiPayload({
    rollingUsage: { usagePercent: 11 },
    weeklyUsage: { usedPercent: 22 },
    monthlyUsage: { value: 33 },
  });
  assert.equal(snapshot?.rolling?.percent, 11);
  assert.equal(snapshot?.weekly?.percent, 22);
  assert.equal(snapshot?.monthly?.percent, 33);

  const shortKeys = extractSnapshotFromApiPayload({
    "5h": { usage: 44 },
    "7d": { percent: 55 },
    "30d": { percent: 66 },
  });
  assert.equal(shortKeys?.rolling?.percent, 44);
  assert.equal(shortKeys?.weekly?.percent, 55);
  assert.equal(shortKeys?.monthly?.percent, 66);
});

test("extractSnapshotFromApiPayload rejects shapes with no usable windows", () => {
  assert.equal(extractSnapshotFromApiPayload({}), null);
  assert.equal(extractSnapshotFromApiPayload({ usage: {} }), null);
  assert.equal(extractSnapshotFromApiPayload({ rolling: { status: "active" } }), null);
  assert.equal(extractSnapshotFromApiPayload({ rolling: { percent: "42%" } }), null);
  assert.equal(extractSnapshotFromApiPayload(null), null);
  assert.equal(extractSnapshotFromApiPayload([]), null);
});

test("extractSnapshotFromApiPayload rejects the __rejected sentinel (caller maps it to unavailable)", () => {
  // The fetch layer returns { __rejected: true } for 401/403; it carries no
  // windows so the tolerant parser must not claim it as a snapshot.
  assert.equal(extractSnapshotFromApiPayload({ __rejected: true }), null);
});

test("rejected api keys map to an unavailable snapshot with literal reason", () => {
  const payload = { __rejected: true };
  const snapshot =
    typeof payload === "object" && payload !== null && payload.__rejected === true
      ? unavailableSnapshot("API key rejected (401/403)")
      : extractSnapshotFromApiPayload(payload);
  assert.equal(snapshot?.source, "unavailable");
  assert.equal(snapshot?.apiUnavailable, true);
  assert.equal(snapshot?.apiError, "API key rejected (401/403)");
  assert.deepStrictEqual(buildUsageRows(snapshot), []);
});

test("extractWindow rejects corrupt cached windows so the cache is dropped", () => {
  assert.equal(extractWindow(null), null);
  assert.equal(extractWindow({ percent: Number.NaN }), null);
  assert.equal(extractWindow({ percent: "high" }), null);
  assert.equal(extractWindow({}), null);
  assert.deepStrictEqual(extractWindow({ percent: 12.6 }), {
    percent: 13,
    resetInSec: null,
    status: null,
    resetText: null,
  });
});

// --- bin/lib.js flag parsing and tui entry normalization ---

test("parseOptionalToggle parses flags and rejects invalid values", () => {
  assert.equal(parseOptionalToggle(["--sidebar", "1"], "--sidebar"), true);
  assert.equal(parseOptionalToggle(["--sidebar=false"], "--sidebar"), false);
  assert.equal(parseOptionalToggle([], "--sidebar"), null);
  assert.throws(() => parseOptionalToggle(["--sidebar", "yes"], "--sidebar"), /invalid value for --sidebar/);
});

test("normalizeTuiEntry handles string, tuple, and invalid entries", () => {
  assert.deepStrictEqual(normalizeTuiEntry("./plugins/oc-go-usage-display.tsx"), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
  assert.deepStrictEqual(
    normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", { sidebar: true, statusline: false }]),
    { spec: "./plugins/oc-go-usage-display.tsx", sidebar: true, statusline: false },
  );
  assert.equal(normalizeTuiEntry(42), null);
  assert.deepStrictEqual(normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", "nope"]), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
});

test("ensureTuiEntry round-trips through readTuiSelection in a temp dir", () => {
  const dir = mkTempDir();
  try {
    const written = ensureTuiEntry(dir, { sidebar: true, statusline: false });
    assert.equal(written.changed, true);
    assert.deepStrictEqual(readTuiSelection(dir), {
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

// --- bin/lib.js remove* round-trips (mkdtemp config dirs) ---

test("removePluginFiles removes a symlink install and reruns idempotently", () => {
  const dir = mkTempDir();
  try {
    linkPluginFiles(REPO_DIR, dir, "symlink");
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.ts")).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.tsx")).isSymbolicLink(), true);
    const first = removePluginFiles(dir);
    assert.deepStrictEqual([...first.removed].sort(), [
      "oc-go-usage-display.ts",
      "oc-go-usage-display.tsx",
    ]);
    assert.deepStrictEqual(first.kept, []);
    const second = removePluginFiles(dir);
    assert.deepStrictEqual(second.removed, []);
    assert.deepStrictEqual(second.kept, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removePluginFiles removes a copy (file) install and reruns idempotently", () => {
  const dir = mkTempDir();
  try {
    linkPluginFiles(REPO_DIR, dir, "copy");
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.ts")).isFile(), true);
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.tsx")).isFile(), true);
    const first = removePluginFiles(dir);
    assert.deepStrictEqual([...first.removed].sort(), [
      "oc-go-usage-display.ts",
      "oc-go-usage-display.tsx",
    ]);
    const second = removePluginFiles(dir);
    assert.deepStrictEqual(second.removed, []);
    assert.deepStrictEqual(second.kept, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removePluginFiles keeps directories and removes only files", () => {
  const dir = mkTempDir();
  try {
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "oc-go-usage-display.ts"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "oc-go-usage-display.tsx"), "copy\n", "utf8");
    const result = removePluginFiles(dir);
    assert.deepStrictEqual(result.removed, ["oc-go-usage-display.tsx"]);
    assert.deepStrictEqual(result.kept, ["oc-go-usage-display.ts"]);
    assert.equal(fs.statSync(path.join(pluginsDir, "oc-go-usage-display.ts")).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeServerEntry removes the entry and preserves comments on no-op rerun", () => {
  const dir = mkTempDir();
  try {
    const ensured = ensureServerEntry(dir);
    assert.equal(ensured.changed, true);
    const first = removeServerEntry(dir);
    assert.equal(first.changed, true);
    assert.equal(first.present, false);
    // No-op rerun must skip the write: seed comments and confirm untouched.
    const filePath = path.join(dir, "opencode.jsonc");
    const withComments = `{\n  // keep me\n  "plugin": []\n}\n`;
    fs.writeFileSync(filePath, withComments, "utf8");
    const second = removeServerEntry(dir);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), withComments);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeTuiEntry removes the entry and preserves comments on no-op rerun", () => {
  const dir = mkTempDir();
  try {
    const ensured = ensureTuiEntry(dir, { sidebar: true, statusline: true });
    assert.equal(ensured.changed, true);
    const first = removeTuiEntry(dir);
    assert.equal(first.changed, true);
    assert.equal(first.present, false);
    const filePath = path.join(dir, "tui.json");
    const withComments = `{\n  // keep me\n  "plugin": []\n}\n`;
    fs.writeFileSync(filePath, withComments, "utf8");
    const second = removeTuiEntry(dir);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), withComments);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
