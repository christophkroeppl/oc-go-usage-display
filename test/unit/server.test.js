// Unit tier: `dist/helpers.js` server helper — the compact one-line summary
// keeps the rolling reset suffix and reports unavailable snapshots verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatServerLine } from "../../dist/helpers.js";

function serverSnapshot(overrides = {}) {
  return {
    rolling: { percent: 42, resetInSec: 7543, resetText: null },
    weekly: { percent: 15, resetInSec: null, resetText: null },
    monthly: { percent: 61, resetInSec: null, resetText: null },
    source: "mock",
    fetchedAt: 0,
    ...overrides,
  };
}

test("server formatServerLine keeps the rolling reset suffix", () => {
  const snapshot = serverSnapshot({
    rolling: { percent: 42, resetInSec: 7543, status: "active", resetText: null },
    weekly: { percent: 15, resetInSec: null, status: "active", resetText: null },
    monthly: { percent: 61, resetInSec: null, status: "active", resetText: null },
  });
  assert.equal(formatServerLine(snapshot), "Go 5h 42% (reset 2h5m) | 7d 15% | 30d 61%");
});

test("server formatServerLine reports unavailable snapshots with reason", () => {
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
