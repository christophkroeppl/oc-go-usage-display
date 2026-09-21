// Unit tier (readonly): live usage API shape check.
//
// Runs on the host and in CI as long as OPENCODE_GO_API_KEY is present; skips
// neutrally otherwise. Strictly readonly: a single GET request, no filesystem,
// no tmp, no child processes, no env mutation. The raw response is never
// printed (it may contain account identifiers).
//
// The check fails on transport/HTTP errors, malformed JSON, or a present window
// with a non-numeric percent. It skips when the account has no Go subscription
// (no usable windows) — mirroring the old format-check job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSnapshotFromApiPayload } from "../../dist/shared.js";

const API_URL = "https://opencode.ai/zen/go/v1/usage";
const API_KEY = (process.env.OPENCODE_GO_API_KEY ?? "").trim();
const SKIP =
  API_KEY.length === 0 ? "OPENCODE_GO_API_KEY not set (live usage check skipped)" : false;

// Present windows must be well-formed even when the overall payload has no
// usable window (no Go subscription). Mirrors the CI shape check this replaced.
function validatePresentWindows(payload) {
  const candidates = [payload];
  for (const key of ["usage", "data", "go"]) {
    if (payload && typeof payload[key] === "object" && payload[key] !== null) {
      candidates.push(payload[key]);
    }
  }
  const aliases = {
    rolling: ["rolling", "rollingUsage", "5h"],
    weekly: ["weekly", "weeklyUsage", "7d"],
    monthly: ["monthly", "monthlyUsage", "30d"],
  };
  for (const container of candidates) {
    if (typeof container !== "object" || container === null || Array.isArray(container)) continue;
    for (const [name, keys] of Object.entries(aliases)) {
      const window = keys.map((key) => container[key]).find((value) => value !== undefined && value !== null);
      if (window === undefined) continue;
      if (typeof window !== "object" || Array.isArray(window)) return `${name} is not an object`;
      const percent = window.percent ?? window.usagePercent ?? window.usedPercent ?? window.value ?? window.usage;
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return `${name}.percent missing or non-numeric`;
      }
      if (window.status !== undefined && window.status !== null && typeof window.status !== "string") {
        return `${name}.status is not a string`;
      }
    }
  }
  return null;
}

// Neutral skip that works under both `node --test` and `bun test` (the Bun
// node:test shim may not implement `t.skip`).
function skipWithNotice(t, message) {
  if (typeof t.skip === "function") {
    t.skip(message);
    return;
  }
  console.log(`skipped: ${message}`);
}

test("live usage API returns a parseable snapshot", { skip: SKIP, timeout: 30000 }, async (t) => {
  const response = await fetch(API_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(response.ok, `usage endpoint returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    assert.fail("usage endpoint did not return valid JSON");
  }

  const shapeError = validatePresentWindows(payload);
  assert.equal(shapeError, null, `usage shape invalid: ${shapeError ?? ""}`);

  const snapshot = extractSnapshotFromApiPayload(payload);
  if (snapshot === null) {
    skipWithNotice(t, "usage API returned no usable windows (no Go subscription)");
    return;
  }

  const present = ["rolling", "weekly", "monthly"].filter((key) => snapshot[key] !== null);
  assert.ok(present.length > 0, "snapshot must carry at least one window");
  for (const key of present) {
    assert.equal(typeof snapshot[key].percent, "number", `${key}.percent must be numeric`);
  }
  console.log(`live usage API shape OK (${present.length}/3 windows parsed)`);
});
