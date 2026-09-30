// Unit tier: `dist/shared.js` — the pure cross-surface helpers used by both the
// server and the TUI (auth path resolution, tolerant API parsing, snapshot
// builders, formatting primitives). Requires a prior `bun run build`: this tier
// imports the compiled dist/*.js (`bun run test` builds first, `bun run test:unit`
// does not).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  authJsonPaths,
  errorMessage,
  extractSnapshotFromApiPayload,
  extractWindow,
  formatResetDuration,
  mockSnapshot,
  MOCK_PERCENTS,
  isLimitedStatus,
  parseMockLimited,
  parseMockPercents,
  parseMockResets,
  mockGoShare,
  parseMockShare,
  hostEnv,
  hostEnvName,
  KILO_SIDEBAR_ORDERS,
  KILO_SLOT_ORDER,
  KILO_INTEGRATED_SLOT_ORDER,
  KILO_TOKEN_USAGE_ROWS,
  KILO_USAGE_PANEL_PLUGIN_ID,
  resolveConfigDir,
  resolveHostRoots,
  safeJoinPath,
  unavailableSnapshot,
  usageHostFromEnv,
} from "../../dist/shared.js";
import { formatServerLine } from "../../dist/helpers.js";

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

// --- host roots: opencode vs Kilo (no fs access, injected env) ---

test("usageHostFromEnv only recognizes the explicit kilo marker", () => {
  assert.equal(usageHostFromEnv({ OC_GO_USAGE_HOST: "kilo" }), "kilo");
  assert.equal(usageHostFromEnv({ OC_GO_USAGE_HOST: "KILO" }), "opencode");
  assert.equal(usageHostFromEnv({ OC_GO_USAGE_HOST: "opencode" }), "opencode");
  assert.equal(usageHostFromEnv({}), "opencode");
  assert.equal(usageHostFromEnv(undefined), "opencode");
});

test("resolveHostRoots gives each host its own default config/data roots", () => {
  assert.deepStrictEqual(resolveHostRoots("opencode", {}, () => "/home/tester"), {
    configDir: "/home/tester/.config/opencode",
    dataDir: "/home/tester/.local/share/opencode",
  });
  assert.deepStrictEqual(resolveHostRoots("kilo", {}, () => "/home/tester"), {
    configDir: "/home/tester/.config/kilo",
    dataDir: "/home/tester/.local/share/kilo",
  });
});

test("resolveHostRoots honors XDG roots for both hosts", () => {
  const env = { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" };
  assert.deepStrictEqual(resolveHostRoots("opencode", env, () => "/home/tester"), {
    configDir: "/xdg/config/opencode",
    dataDir: "/xdg/data/opencode",
  });
  assert.deepStrictEqual(resolveHostRoots("kilo", env, () => "/home/tester"), {
    configDir: "/xdg/config/kilo",
    dataDir: "/xdg/data/kilo",
  });
});

test("resolveHostRoots honors KILO_CONFIG_DIR for the Kilo config root only", () => {
  assert.deepStrictEqual(resolveHostRoots("kilo", { KILO_CONFIG_DIR: "/custom/kilo" }, () => "/home/tester"), {
    configDir: "/custom/kilo",
    dataDir: "/home/tester/.local/share/kilo",
  });
  // The opencode host never reads Kilo's override.
  assert.deepStrictEqual(resolveHostRoots("opencode", { KILO_CONFIG_DIR: "/custom/kilo" }, () => "/home/tester"), {
    configDir: "/home/tester/.config/opencode",
    dataDir: "/home/tester/.local/share/opencode",
  });
});

test("authJsonPaths reads the selected host's data store before its config dir", () => {
  assert.deepStrictEqual(authJsonPaths("kilo", {}, () => "/home/tester"), [
    "/home/tester/.local/share/kilo/auth.json",
    "/home/tester/.config/kilo/auth.json",
  ]);
  assert.deepStrictEqual(authJsonPaths("opencode", {}, () => "/home/tester"), [
    "/home/tester/.local/share/opencode/auth.json",
    "/home/tester/.config/opencode/auth.json",
  ]);
});

test("resolveHostRoots never throws when home resolution fails", () => {
  const roots = resolveHostRoots(
    "kilo",
    {},
    () => {
      throw new Error("no home directory");
    },
  );
  assert.deepStrictEqual(roots, { configDir: ".config/kilo", dataDir: ".local/share/kilo" });
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

// A 30-day window resets ~720h out. "resets in 720h00m" is unreadable at a
// glance, and the countdown's whole job is to say how long you can ignore it --
// so past a day the units are weeks, days and hours.
test("formatResetDuration resolves every unit down to the hour, and only the ones with something to say", () => {
  const day = 86400;
  const hour = 3600;
  // 214h45m is 8d 22h 45m. "1w 1d" says a week; "1w 1d 22h" says a week and most
  // of a day, which is the difference the hour makes.
  assert.equal(formatResetDuration(214 * hour + 45 * 60), "1w 1d 22h", "214h45m from a real sidebar");
  assert.equal(formatResetDuration(6 * day + 22 * hour), "6d 22h", "just under a week stays in days");
  assert.equal(formatResetDuration(2 * day + 6 * hour), "2d 6h");
  // Past a week the hour is often zero -- a 30-day window resets ~4w 2d with no
  // hour to add -- so the extra resolution buys something on the rolling window
  // and between a day and a week, and costs nothing elsewhere.
  assert.equal(formatResetDuration(30 * day), "4w 2d");
  assert.equal(formatResetDuration(365 * day), "52w 1d");

  // "1w 0d" says no more than "1w" and reads as though a day were still to come.
  // A unit earns its place by having something to say, and dropping the empty one
  // is also what lets the countdown keep a fixed granularity without lying near a
  // boundary -- "1w" is not a rounding error, it is what is actually left.
  assert.equal(formatResetDuration(7 * day), "1w", "1w 0d is 1w");
  assert.equal(formatResetDuration(14 * day), "2w");
  assert.equal(formatResetDuration(day), "1d", "1d 0h is 1d");
  assert.equal(formatResetDuration(8 * day), "1w 1d");
  assert.equal(formatResetDuration(7 * day + 3 * hour), "1w 3h", "1w 0d 3h drops the zero day");
  // And not in the middle of a pair either, where it is even easier to misread as
  // progress.
  assert.equal(formatResetDuration(hour), "1h", "1h0m is 1h");

  // Below a day the minutes and seconds are the finest useful precision, so they
  // are what is shown -- and the 5h window still reads the way it always has.
  assert.equal(formatResetDuration(86399), "23h59m");
  assert.equal(formatResetDuration(7543), "2h5m");
  assert.equal(formatResetDuration(300), "5m");
  assert.equal(formatResetDuration(45), "45s");
  // Zero seconds is still the honest answer rather than nothing at all.
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
});

// --- extractWindow ---

test("extractWindow rejects corrupt cached windows so the cache is dropped", () => {
  assert.equal(extractWindow(null), null);
  assert.equal(extractWindow({ percent: Number.NaN }), null);
  assert.equal(extractWindow({ percent: "high" }), null);
  assert.equal(extractWindow({}), null);
  assert.deepStrictEqual(extractWindow({ percent: 12.6 }), {
    percent: 13,
    status: null,
    limited: false,
    resetInSec: null,
    resetText: null,
  });
});

// --- resetsAt: the live API's absolute reset instants ---

// Redacted live payload (the real shape; every value is a non-secret number or
// enum). The API reports the reset as an absolute ISO 8601 instant, which the
// code used to ignore entirely, so no reset time ever rendered in live use.
const LIVE_USAGE_PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-29T10:34:00.358Z" },
    weekly: { status: "ok", percent: 0, resetsAt: "2026-10-05T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-08T17:25:34.000Z" },
  },
};
// 2h5m before the rolling reset; far enough from every instant that rounding
// cannot change the expected second counts.
const LIVE_NOW = Date.parse("2026-09-29T08:29:00.000Z");

test("extractWindow derives resetInSec (seconds until reset) from resetsAt", () => {
  const rolling = extractWindow(LIVE_USAGE_PAYLOAD.usage.rolling, LIVE_NOW);
  assert.deepStrictEqual(rolling, {
    percent: 0,
    status: "ok",
    limited: false,
    resetInSec: 7500,
    resetText: null,
  });
  assert.equal(extractWindow(LIVE_USAGE_PAYLOAD.usage.weekly, LIVE_NOW)?.resetInSec, 487860);
  assert.equal(extractWindow(LIVE_USAGE_PAYLOAD.usage.monthly, LIVE_NOW)?.resetInSec, 809794);
  // The derived value is a SECONDS countdown, not milliseconds.
  assert.equal(formatResetDuration(rolling?.resetInSec ?? null), "2h5m");
});

test("extractSnapshotFromApiPayload maps the live payload's status to limited", () => {
  // The clock is injected: a fixture with literal instants goes stale in
  // wall-clock time, and the countdowns would silently become `null`.
  const snapshot = extractSnapshotFromApiPayload(LIVE_USAGE_PAYLOAD, LIVE_NOW);
  assert.equal(snapshot?.source, "api");
  assert.equal(snapshot?.rolling?.status, "ok");
  assert.equal(snapshot?.rolling?.limited, false);
  assert.equal(snapshot?.weekly?.status, "ok");
  assert.equal(snapshot?.weekly?.limited, false);
  assert.equal(snapshot?.monthly?.status, "rate-limited");
  assert.equal(snapshot?.monthly?.limited, true);
  // One clock reading per snapshot: `fetchedAt` and the countdowns agree.
  assert.ok(Number.isFinite(snapshot?.fetchedAt));
  for (const key of ["rolling", "weekly", "monthly"]) {
    assert.ok(snapshot?.[key]?.resetInSec !== null, `${key}.resetInSec parsed from resetsAt`);
  }
});

test("a live-shaped payload renders a reset suffix in the server line and sidebar rows", () => {
  // The live API carries no relative countdown, so these two renderers were
  // the regression surface for the unparsed `resetsAt` field.
  const now = Date.now();
  const snapshot = extractSnapshotFromApiPayload({
    usage: {
      rolling: {
        status: "ok",
        percent: 0,
        resetsAt: new Date(now + 2 * 3600_000 + 5 * 60_000 + 30_000).toISOString(),
      },
      weekly: { status: "ok", percent: 0, resetsAt: new Date(now + 487_860_000).toISOString() },
      monthly: {
        status: "rate-limited",
        percent: 100,
        resetsAt: new Date(now + 809_794_000).toISOString(),
      },
    },
  });
  assert.ok(snapshot !== null);
  assert.equal(formatServerLine(snapshot), "Go 5h 0% (reset 2h5m) | 7d 0% | 30d 100%");
});

test("the relative reset spellings are still accepted and win over resetsAt", () => {
  for (const key of ["resetInSec", "resetInSeconds"]) {
    const window = extractWindow({ percent: 5, [key]: 900 }, LIVE_NOW);
    assert.equal(window?.resetInSec, 900, key);
  }
  // An already-relative countdown needs no clock conversion, so it takes
  // precedence over the absolute instant when a payload carries both.
  const both = extractWindow(
    { percent: 5, resetInSec: 900, resetsAt: "2026-10-08T17:25:34.000Z" },
    LIVE_NOW,
  );
  assert.equal(both?.resetInSec, 900);
  for (const key of ["resetText", "reset"]) {
    const window = extractWindow({ percent: 5, [key]: "soon" }, LIVE_NOW);
    assert.equal(window?.resetText, "soon", key);
  }
});

test("an elapsed resetsAt degrades to null instead of a negative countdown", () => {
  const past = extractWindow(
    { percent: 42, status: "ok", resetsAt: "2026-09-29T08:00:00.000Z" },
    LIVE_NOW,
  );
  assert.equal(past?.resetInSec, null);
  assert.equal(formatResetDuration(past?.resetInSec ?? null), null);
  // An elapsed reset falls back to the relative spelling instead of being lost.
  const both = extractWindow(
    { percent: 42, resetInSec: 900, resetsAt: "2026-09-29T08:00:00.000Z" },
    LIVE_NOW,
  );
  assert.equal(both?.resetInSec, 900);
  // An invalid `now` (clock skew outside the representable range) fails the
  // same guard rather than leaking a non-finite countdown.
  assert.equal(
    extractWindow({ percent: 42, resetsAt: "2026-10-08T17:25:34.000Z" }, Number.NaN)?.resetInSec,
    null,
  );
});

test("a negative or non-finite relative countdown degrades to null", () => {
  // The boundary hands out "a usable countdown or nothing", so no consumer has
  // to re-check the sign before rendering.
  for (const resetInSec of [-1, -3600, Number.NaN, Number.POSITIVE_INFINITY, "900", null, {}]) {
    const window = extractWindow({ percent: 7, resetInSec }, LIVE_NOW);
    assert.equal(window?.resetInSec, null, `resetInSec ${String(resetInSec)}`);
  }
  assert.equal(extractWindow({ percent: 7, resetInSec: 0 }, LIVE_NOW)?.resetInSec, 0);
});

test("an unparseable or non-string resetsAt degrades to null", () => {
  const rejected = [
    "not-a-date",
    "2026-13-45T99:99:99Z",
    "",
    "   ",
    1_772_000_000,
    null,
    undefined,
    true,
    {},
    [],
    new Date(Number.NaN),
  ];
  for (const resetsAt of rejected) {
    const window = extractWindow({ percent: 7, resetsAt }, LIVE_NOW);
    assert.ok(window !== null, `window for ${String(resetsAt)}`);
    assert.equal(window.resetInSec, null, `resetsAt ${String(resetsAt)} must yield null`);
  }
});

test("no NaN, Infinity or negative resetInSec can escape the parser", () => {
  const junk = [
    ...[undefined, null, 0, 42].flatMap((percent) =>
      [undefined, null, "", "nope", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1e18].map(
        (resetsAt) => ({ percent, resetsAt }),
      ),
    ),
    ...[undefined, null, "", "nope", Number.NaN, Number.POSITIVE_INFINITY, -1, 1e18].map(
      (resetInSec) => ({ percent: 1, resetInSec }),
    ),
  ];
  for (const candidate of junk) {
    const window = extractWindow(candidate, LIVE_NOW);
    if (window === null) continue;
    const { resetInSec } = window;
    if (resetInSec === null) continue;
    assert.ok(Number.isFinite(resetInSec), `finite resetInSec for ${JSON.stringify(candidate)}`);
    assert.ok(resetInSec >= 0, `non-negative resetInSec for ${JSON.stringify(candidate)}`);
  }
  // No unreadable date text can reach a renderer either.
  for (const resetsAt of ["not-a-date", "2026-13-45T99:99:99Z"]) {
    const window = extractWindow({ percent: 7, resetsAt }, LIVE_NOW);
    assert.equal(formatResetDuration(window?.resetInSec ?? null), null);
    assert.equal(JSON.stringify(window), '{"percent":7,"status":null,"limited":false,"resetInSec":null,"resetText":null}');
  }
});

// --- status -> limited ---

test("only recognized limit statuses map to limited", () => {
  const cases = [
    // The live API value.
    ["rate-limited", true],
    // Same token, other spellings/casing a payload could use.
    ["Rate-Limited", true],
    ["rate_limited", true],
    ["  RATE LIMITED  ", true],
    ["limited", true],
    ["LIMITED", true],
    ["exhausted", true],
    ["capped", true],
    // The live healthy value and the scrape/mock status.
    ["ok", false],
    ["active", false],
    // Never limited: "unlimited" contains "limited".
    ["unlimited", false],
    ["not-rate-limited", false],
    // Unknown and absent values default to false instead of throwing.
    ["some-new-upstream-state", false],
    ["", false],
    [null, false],
  ];
  for (const [status, expected] of cases) {
    const window = extractWindow({ percent: 0, status }, LIVE_NOW);
    assert.equal(window?.limited, expected, `status ${String(status)}`);
    // The raw status survives (trimmed) next to the derived flag.
    const expectedRaw = typeof status === "string" && status.trim().length > 0 ? status.trim() : null;
    assert.equal(window?.status, expectedRaw, `raw status ${String(status)} preserved`);
  }
});

test("mockSnapshot agrees with the parser about the 'active' status", () => {
  // The mock is what every TUI/e2e test renders, so a divergence between it and
  // the parser would hide a mapping change behind a plausible-looking mock.
  const mock = mockSnapshot();
  assert.equal(mock.source, "mock");
  for (const key of ["rolling", "weekly", "monthly"]) {
    const expected = extractWindow({ percent: mock[key].percent, status: "active" });
    assert.equal(mock[key].limited, expected?.limited, `${key}.limited`);
    assert.equal(mock[key].status, "active", `${key}.status`);
  }
  assert.equal(mock.rolling.resetInSec, 7543);
  assert.equal(formatResetDuration(mock.rolling.resetInSec), "2h5m");
});

test("hostEnvName scopes every variable to the host that reads it", () => {
  assert.equal(hostEnvName("opencode", "SIDEBAR"), "OPENCODE_OC_GO_SIDEBAR");
  assert.equal(hostEnvName("kilo", "SIDEBAR"), "KILO_OC_GO_SIDEBAR");
  assert.equal(hostEnvName("kilo", "API_KEY"), "KILO_OC_GO_API_KEY");
});

test("hostEnv reads the host-scoped name and never the other host's", () => {
  // A Kilo entry must not be steerable by an opencode-prefixed name, and vice
  // versa: the two hosts keep separate auth stores and config dirs.
  const env = { OPENCODE_OC_GO_SIDEBAR: "0", KILO_OC_GO_SIDEBAR: "1" };
  assert.equal(hostEnv("opencode", "SIDEBAR", env), "0");
  assert.equal(hostEnv("kilo", "SIDEBAR", env), "1");
  assert.equal(hostEnv("opencode", "STATUSLINE", env), undefined);
});

test("hostEnv ignores the pre-2.0 unscoped name", () => {
  // The 2.0 break removed the fallback deliberately: a migration shim would let
  // a stale OPENCODE_GO_* keep steering one host long after the split.
  assert.equal(hostEnv("opencode", "API_KEY", { OPENCODE_GO_API_KEY: "legacy" }), undefined);
  assert.equal(hostEnv("kilo", "API_KEY", { OPENCODE_GO_API_KEY: "legacy" }), undefined);
});

test("hostEnv tolerates a missing environment", () => {
  assert.equal(hostEnv("opencode", "SIDEBAR", undefined), undefined);
  assert.equal(hostEnv("kilo", "SIDEBAR", {}), undefined);
});

// The Kilo sidebar ladder is host-owned data we cannot query at runtime, so it is
// asserted here rather than left in a comment: a Kilo release that adds a panel
// inside our chosen band must fail the build, not silently collide.
test("the kilo slot order stays a free band between context and token usage", () => {
  const colliding = Object.entries(KILO_SIDEBAR_ORDERS).find(
    ([, order]) => order === KILO_SLOT_ORDER,
  );
  assert.equal(colliding, undefined, `KILO_SLOT_ORDER ${KILO_SLOT_ORDER} collides with ${colliding?.[0]}`);

  assert.ok(
    KILO_SIDEBAR_ORDERS["internal:sidebar-context"] < KILO_SLOT_ORDER,
    "KILO_SLOT_ORDER must stay below the context panel",
  );
  assert.ok(
    KILO_SLOT_ORDER < KILO_SIDEBAR_ORDERS["internal:kilo-sidebar-usage"],
    "KILO_SLOT_ORDER must stay above the token-usage panel",
  );
});

test("the mirrored kilo token-usage rows are the ones we render", () => {
  // Order matters: the integrated panel lays these out in the host's order.
  assert.deepStrictEqual(KILO_TOKEN_USAGE_ROWS, [
    "Input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
    "Cache rate",
    "Cost",
  ]);
  assert.equal(new Set(KILO_TOKEN_USAGE_ROWS).size, KILO_TOKEN_USAGE_ROWS.length, "no duplicate rows");
});

// Integrated mode deliberately ties with the host panel it retires, so the tie
// is the contract: if the panel ever moves off this order the plugin silently
// falls back into a free band, which is why both facts are asserted together
// rather than letting the collision look like a bug.
test("the integrated slot order is exactly the kilo usage panel it replaces", () => {
  assert.equal(KILO_SIDEBAR_ORDERS[KILO_USAGE_PANEL_PLUGIN_ID], KILO_INTEGRATED_SLOT_ORDER);
  assert.equal(
    Object.entries(KILO_SIDEBAR_ORDERS).filter(([, order]) => order === KILO_INTEGRATED_SLOT_ORDER).length,
    1,
    "the integrated band must be claimed by the panel we retire, and by nothing else",
  );
  assert.ok(
    KILO_SIDEBAR_ORDERS["internal:sidebar-context"] < KILO_INTEGRATED_SLOT_ORDER,
    "the integrated band must stay below the context panel",
  );
});

test("the retired panel id is the one the ladder records", () => {
  // A typo here would leave Kilo's panel rendering next to ours forever, with
  // no error anywhere to explain the duplicate.
  assert.ok(KILO_USAGE_PANEL_PLUGIN_ID in KILO_SIDEBAR_ORDERS, "unknown kilo panel id");
});

test("the mock takes a ladder of plan percents, whole or not at all", () => {
  // The display tests drive the meters over a ladder of readings. A ladder that
  // only half-applied would render a block matching no rung the test asked for,
  // so anything malformed falls back to the defaults entirely.
  assert.equal(mockSnapshot().rolling.percent, MOCK_PERCENTS[0], "the default ladder is unchanged");
  assert.deepEqual(
    [mockSnapshot().rolling.percent, mockSnapshot().weekly.percent, mockSnapshot().monthly.percent],
    [...MOCK_PERCENTS],
  );

  assert.deepEqual(parseMockPercents("0,50,90"), [0, 50, 90]);
  assert.deepEqual(parseMockPercents(" 0 , 50 , 90 "), [0, 50, 90], "whitespace around a rung is fine");
  assert.deepEqual(parseMockPercents("100,0,42.5"), [100, 0, 42.5], "a fractional rung parses");
  assert.deepEqual(parseMockPercents("-5,0,100"), [-5, 0, 100], "out of range parses: the meter clamps");

  for (const bad of [undefined, "", "  ", "50", "0,50", "0,50,90,100", "a,b,c", "0,50,NaN", "0,50,Infinity"]) {
    assert.equal(parseMockPercents(bad), null, `${JSON.stringify(bad)} must not parse`);
  }

  // Applied: the overrides reach the snapshot, and only the percents change --
  // the reset countdown stays literal so the display tests' statusline suffix is
  // deterministic whatever the ladder is.
  const ladder = mockSnapshot({ percents: [0, 50, 90] });
  assert.deepEqual([ladder.rolling.percent, ladder.weekly.percent, ladder.monthly.percent], [0, 50, 90]);
  assert.equal(ladder.source, "mock");
  assert.equal(ladder.rolling.resetInSec, 7543, "the 5h reset stays literal across the ladder");
  assert.equal(ladder.weekly.resetInSec, null);
  for (const key of ["rolling", "weekly", "monthly"]) {
    const expected = extractWindow({ percent: ladder[key].percent, status: "active" });
    assert.equal(ladder[key].limited, expected?.limited, `${key}.limited still matches the parser`);
  }
});

test("the mock Go share is gated on the mock flag, not on the override", () => {
  // The override exists so a display test can put a share in the row without a
  // provider call per rung. If it applied outside mock mode it would silently
  // replace the real fold over the host's message store, so the gate is on the
  // MOCK flag: an override alone changes nothing.
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK_SHARE: "100" }), null, "the override alone must not apply");
  assert.equal(mockGoShare("opencode", { OPENCODE_OC_GO_MOCK_SHARE: "100" }), null);
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK: "0", KILO_OC_GO_MOCK_SHARE: "100" }), null);
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK: "1", KILO_OC_GO_MOCK_SHARE: "100" }), 100);
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK: "1", KILO_OC_GO_MOCK_SHARE: "nonsense" }), null);
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK: "1" }), null, "no override means the real share");
  // Each host reads only its own prefix.
  assert.equal(mockGoShare("opencode", { OPENCODE_OC_GO_MOCK: "1", KILO_OC_GO_MOCK_SHARE: "50" }), null);
  assert.equal(mockGoShare("kilo", { KILO_OC_GO_MOCK: "1", OPENCODE_OC_GO_MOCK_SHARE: "50" }), null);
});

test("the mock Go share parses one number, or nothing", () => {
  assert.equal(parseMockShare("100"), 100);
  assert.equal(parseMockShare(" 0 "), 0);
  assert.equal(parseMockShare("42.5"), 42.5);
  for (const bad of [undefined, "", "  ", "all", "NaN", "Infinity"]) {
    assert.equal(parseMockShare(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("the mock takes a countdown and a cap per window", () => {
  // `MOCK_RESETS` is seconds, not a rendered string: the formatter is the thing
  // under test, and handing it a pre-rendered value would test nothing.
  assert.deepEqual(parseMockResets("45,300,7543"), [45, 300, 7543]);
  assert.deepEqual(parseMockResets(" 45 , 300 , 7543 "), [45, 300, 7543], "whitespace around a slot is fine");
  assert.deepEqual(parseMockResets("0,604800,2592000"), [0, 604800, 2592000], "an elapsed countdown is a valid value");
  assert.deepEqual(parseMockResets("-,300,-"), [null, 300, null], "a window with no countdown at all");
  assert.deepEqual(parseMockResets("45,,7543"), [45, null, 7543], "an empty slot is the same as a dash");
  // A negative countdown is what clock skew and a reset that fired mid-flight
  // look like, and the real parser drops those -- so the mock must not be able to
  // manufacture one the wire could never carry.
  assert.equal(parseMockResets("-1,300,7543"), null);
  assert.equal(parseMockResets("45,NaN,7543"), null);
  for (const bad of [undefined, "", "  ", "45", "45,300", "45,300,7543,1", "a,b,c"]) {
    assert.equal(parseMockResets(bad), null, `${JSON.stringify(bad)} must not parse`);
  }

  // The cap is independent of the countdown on the wire, and `buildPlanRows` only
  // prints a window's countdown when that window is capped.
  assert.deepEqual(parseMockLimited("1,0,1"), [true, false, true]);
  assert.deepEqual(parseMockLimited("true,no,on"), [true, false, true]);
  assert.deepEqual(parseMockLimited("0,0,0"), [false, false, false]);
  assert.deepEqual(parseMockLimited("1,1,1"), [true, true, true]);
  // Anything that is not recognisably true is false, so a typo caps nothing
  // rather than capping everything.
  assert.deepEqual(parseMockLimited("1,banana,yes"), [true, false, true]);
  assert.deepEqual(parseMockLimited("-,0,-"), [false, false, false]);
  for (const bad of [undefined, "", "  ", "1,0", "1,0,1,1"]) {
    assert.equal(parseMockLimited(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("a capped mock window says so, and an uncapped one does not", () => {
  // The status and the `limited` flag have to agree, because that is what the
  // parser produces and what the unit tier pins elsewhere; and a capped window is
  // the only one whose countdown reaches the plan rows.
  const capped = mockSnapshot({
    resets: parseMockResets("604800,86400,2592000"),
    limited: parseMockLimited("1,1,1"),
  });
  for (const key of ["rolling", "weekly", "monthly"]) {
    assert.equal(capped[key].limited, true, `${key}.limited`);
    assert.equal(capped[key].status, "rate-limited", `${key}.status`);
    assert.equal(capped[key].limited, isLimitedStatus(capped[key].status), `${key} agrees with the parser`);
  }
  assert.deepEqual([capped.rolling.resetInSec, capped.weekly.resetInSec, capped.monthly.resetInSec], [
    604800, 86400, 2592000,
  ]);
  const open = mockSnapshot({ resets: parseMockResets("45,-,-"), limited: parseMockLimited("0,0,0") });
  for (const key of ["rolling", "weekly", "monthly"]) {
    assert.equal(open[key].limited, false, `${key}.limited`);
    assert.equal(open[key].status, "active", `${key}.status`);
    assert.equal(open[key].limited, isLimitedStatus(open[key].status), `${key} agrees with the parser`);
  }
  assert.deepEqual([open.rolling.resetInSec, open.weekly.resetInSec, open.monthly.resetInSec], [45, null, null]);

  // The defaults are unchanged, so every existing display test still renders what
  // it was written against: one countdown on the rolling window, nothing capped.
  const plain = mockSnapshot();
  assert.equal(plain.rolling.resetInSec, 7543);
  assert.equal(plain.weekly.resetInSec, null);
  assert.equal(plain.monthly.resetInSec, null);
  for (const key of ["rolling", "weekly", "monthly"]) {
    assert.equal(plain[key].limited, false, `${key}.limited`);
    assert.equal(plain[key].status, "active", `${key}.status`);
  }
});
