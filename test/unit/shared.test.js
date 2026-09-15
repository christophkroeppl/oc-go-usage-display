// Unit tier: `dist/shared.js` — the pure cross-surface helpers used by both the
// server and the TUI (auth path resolution, tolerant API parsing, snapshot
// builders, formatting primitives). Requires a prior `npm run build`: this tier
// imports the compiled dist/*.js (`npm test` builds first, `npm run test:unit`
// does not).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { buildUsageRows } from "../../dist/helpers.js";
import {
  errorMessage,
  extractSnapshotFromApiPayload,
  extractWindow,
  formatResetDuration,
  resolveConfigDir,
  safeJoinPath,
  unavailableSnapshot,
} from "../../dist/shared.js";

// --- safeJoinPath / resolveConfigDir (module-level path construction) ---

test("safeJoinPath joins normal segments like path.join", () => {
  assert.equal(safeJoinPath("/base", "a", "b"), "/base/a/b");
  assert.equal(safeJoinPath("/base"), "/base");
  assert.equal(safeJoinPath("/base", "nested", "file.json"), path.join("/base", "nested", "file.json"));
});

test("safeJoinPath coerces non-string segments deterministically", () => {
  assert.equal(safeJoinPath("/base", 5, null, undefined, true), "/base/5/null/undefined/true");
  assert.equal(safeJoinPath("/base", { toString: () => "obj" }), "/base/obj");
  // Unstringifiable values degrade to an empty segment instead of dropping the
  // whole join or throwing.
  assert.equal(safeJoinPath("/base", Object.create(null)), "/base");
});

test("resolveConfigDir joins home with .config/opencode", () => {
  assert.equal(resolveConfigDir(() => "/home/tester"), "/home/tester/.config/opencode");
});

test("resolveConfigDir falls back to a relative path when home resolution throws", () => {
  assert.equal(
    resolveConfigDir(() => {
      throw new Error("no home directory");
    }),
    ".config/opencode",
  );
});

// --- errorMessage ---

test("errorMessage extracts a usable message from arbitrary thrown values", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage(new Error("")), "Error");
  assert.equal(errorMessage("plain failure"), "plain failure");
  assert.equal(errorMessage(undefined), "unknown error");
  assert.equal(errorMessage(Object.create(null)), "unknown error");
});

// --- formatResetDuration ---

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

// --- extractSnapshotFromApiPayload tolerant shapes ---

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

// --- extractWindow ---

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
