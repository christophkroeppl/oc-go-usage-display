// E2E tier: the meters must look the SAME at every reading.
//
// A meter that is rebuilt from the percent on each render is a different layout
// at every value, and the failure does not show up at the value anyone happens to
// be looking at. So this drives the whole ladder (test/helpers/ladder.js) through
// the real Kilo TUI and asserts the properties that must not depend on the
// reading at all:
//
//   - the meter's own extent is the same width on every rung, and on every meter,
//   - the percent's right edge is the same column on every rung,
//   - the number of accent-colored cells is proportional to the percent,
//   - everything else inside the meter is surface, so 100% leaves no track and 0%
//     leaves no fill,
//   - and the accent color actually changes across the threshold ladder.
//
// The colors are read out of the pane, never hardcoded: the host owns the theme,
// so the test pins WHICH color each severity resolves to and that the rungs
// differ, rather than asserting an RGB triple that only one theme has.
//
// Integrated mode on purpose: it is the only view where all four meters -- the
// three plan windows and the Go share -- are on one screen at once, which is what
// makes the cross-rung and cross-meter comparisons possible.
//
// One fake-provider session is built and then booted once per rung. The plan and
// the share come from the mock (so the numbers are the rung under test) while the
// session's only job is to make the Models table render one Go row, which is what
// the share row hangs off. Nothing leaves the machine and no Go subscription is
// touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fakeProvider from "../helpers/fake-provider.js";
import { findKiloBinary } from "../helpers/kilo.js";
import { percentEnvValue, usageLadders } from "../helpers/ladder.js";
import { decodePane, meterRows, splitMeter } from "../helpers/pane.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  TuiSession,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const MODEL = "opencode-go/meter-probe";
const PLAN_LABELS = ["5h", "7d", "30d"];
const SHARE_LABEL = "Go share";
// The severity ladder the plugin applies, imported from the built bundle rather
// than restated, so "80% is the warning color" here means the same thing it means
// in src/helpers.ts.
const { meterSeverityForPercent } = await import("../../dist/helpers.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// All four meters, in the order the sidebar draws them.
const METERS_UP = new RegExp(`\\b5h\\b[\\s\\S]*\\b30d\\b[\\s\\S]*${SHARE_LABEL}\\b`);

// Booting a host takes tens of seconds, so ten rungs is a long test, and a slow
// first boot must cost time rather than a flaky red.
const BOOT_TIMEOUT_MS = 90000;
// The panel's session-usage fetch has no timer: it runs once at init and then on
// host events, so a single transient failure leaves `Loading usage...` on screen
// for the life of the boot and the Models table empty. That is a host-timing
// condition, not a rendering one, so a rung whose share row never appears is
// re-booted rather than reported.
const BOOT_ATTEMPTS = 3;
// Consecutive settled polls before a capture is trusted.
const SETTLED_POLLS = 3;

/**
 * Boot the host once and capture the pane with its colors intact.
 *
 * @returns {Promise<string|null>} null when the meters never rendered, so the
 *   caller can re-boot.
 */
async function bootPane({ env, sessionId }) {
  const tui = new TuiSession({
    binary: BINARY,
    args: ["--session", sessionId],
    env,
    cwd: REPO_DIR,
    label: `meters-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  });
  try {
    tui.start();
    // Wait for the share row, not just for the sidebar: it is the last thing to
    // render (the Models table needs the session's usage to have been folded in),
    // and a rung captured before it appears would assert on three meters and pass
    // while the fourth was never drawn.
    //
    // STABLE, not merely present: the host paints the sidebar, then goes back to
    // `Loading usage...` while it finishes starting up, so a single matching poll
    // can be a frame that is about to be replaced. Consecutive polls, and none of
    // the host's own "still working" markers, are what make the capture final.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let screen = "";
    let stable = 0;
    while (Date.now() < deadline) {
      screen = tui.capture();
      const settling = /Finishing startup|Loading usage\.\.\.|No model usage yet/.test(screen);
      stable = METERS_UP.test(screen) && !settling ? stable + 1 : 0;
      if (stable >= SETTLED_POLLS) return tui.captureAnsi();
      await sleep(500);
    }
    return null;
  } finally {
    tui.stop();
  }
}

// One boot per rung, retried until the share row is on screen.
async function bootRung({ env, sessionId, name }) {
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    const ansi = await bootPane({ env, sessionId });
    if (ansi !== null) return ansi;
    console.log(`[e2e] ${name}: meters did not render on boot ${attempt}/${BOOT_ATTEMPTS}, retrying`);
  }
  throw new Error(`${name}: the meters never rendered after ${BOOT_ATTEMPTS} boots`);
}

// Read one rung off the pane: the four meters, by label.
function readRung(ansi, rung) {
  const rows = decodePane(ansi);
  const meters = meterRows(rows);
  const wanted = [...PLAN_LABELS, SHARE_LABEL];
  const found = new Map(meters.filter((m) => wanted.includes(m.label)).map((m) => [m.label, m]));
  const missing = wanted.filter((label) => !found.has(label));
  assert.equal(
    missing.length,
    0,
    `rung ${rung.name} must render ${wanted.join(", ")} (missing ${missing.join(", ")})\n` +
      `--- pane ---\n${rows.map((row) => row.map((c) => c.ch).join("").replace(/\s+$/, "")).join("\n")}`,
  );
  assert.equal(
    found.get(SHARE_LABEL) === undefined ? 0 : meters.filter((m) => m.label === SHARE_LABEL).length,
    1,
    `rung ${rung.name} must render exactly one share row`,
  );
  const plan = PLAN_LABELS.map((label) => found.get(label));
  const share = found.get(SHARE_LABEL);
  const expectedPercents = [...rung.plan, rung.share];
  for (const [index, meter] of [...plan, share].entries()) {
    assert.equal(
      meter.percent,
      expectedPercents[index],
      `rung ${rung.name}: ${meter.label} must read ${expectedPercents[index]}%`,
    );
  }
  return { plan, share, all: [...plan, share] };
}

test(
  "kilo meters keep one geometry and one percent column across the whole usage ladder",
  { skip: SKIP_NO_HOST, timeout: 3600000 },
  async () => {
    const tmp = makeConfigDir();
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: { "meter-probe": { prompt_tokens: 1_000_000, completion_tokens: 24_000, total_tokens: 1_024_000 } },
    });
    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";
      // The provider has to resolve for the headless turn, which means the host's
      // default plugins and its model fetch have to be back on.
      const promptEnv = { ...base };
      delete promptEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      delete promptEnv.OPENCODE_DISABLE_MODELS_FETCH;
      writeTuiHostConfig({
        host: "kilo",
        repoDir: REPO_DIR,
        env: base,
        model: MODEL,
        provider: fake.configFor("opencode-go"),
      });
      const turn = await fakeProvider.runHeadlessPrompt({
        binary: BINARY,
        env: promptEnv,
        cwd: REPO_DIR,
        message: "usage display probe",
        model: MODEL,
      });
      assert.ok(
        fake.requests.some((request) => request.model === "meter-probe"),
        `the host must have called the fake provider (requests: ${JSON.stringify(fake.requests)})\n` +
          `--- kilo run output ---\n${turn.output.slice(-1200)}`,
      );
      await sleep(750);

      const readings = [];
      for (const rung of usageLadders()) {
        const env = { ...base, KILO_OC_GO_MOCK_PERCENTS: percentEnvValue(rung.plan) };
        if (rung.share !== null) env.KILO_OC_GO_MOCK_SHARE = String(rung.share);
        readings.push({
          rung,
          ...readRung(await bootRung({ env, sessionId: turn.sessionId, name: rung.name }), rung),
        });
        console.log(`[e2e] meters rendered for ${rung.name} (${percentEnvValue(rung.plan)}, share ${rung.share})`);
      }

      // 1. One column for every percent, on every rung. The defect this pins is a
      //    meter whose width is a function of the reading, which pushes the percent
      //    one column left or right depending on the number -- the block visibly
      //    shifts as the numbers change.
      const edges = new Map();
      for (const { rung, all } of readings) {
        for (const meter of all) {
          const key = `${rung.name}/${meter.label}`;
          edges.set(key, meter.percentEndCol);
        }
      }
      const distinctEdges = [...new Set(edges.values())];
      assert.equal(
        distinctEdges.length,
        1,
        `every percent must end on one column across the whole ladder (got ${distinctEdges.join(", ")}: ` +
          `${[...edges].map(([k, v]) => `${k}=${v}`).join(" ")})`,
      );

      // 2. One extent for the plan meters, on every rung. The plan rows are
      //    siblings in one column, so their meters must be the same width: this is
      //    the "space to the right of the block" changing shape as values change.
      const planWidths = new Map();
      for (const { rung, plan } of readings) {
        for (const meter of plan) planWidths.set(`${rung.name}/${meter.label}`, meter.width);
      }
      const distinctPlanWidths = [...new Set(planWidths.values())];
      assert.equal(
        distinctPlanWidths.length,
        1,
        `the plan meters must be one width across the whole ladder (got ${distinctPlanWidths.join(", ")}: ` +
          `${[...planWidths].map(([k, v]) => `${k}=${v}`).join(" ")})`,
      );

      // 2b. The meter's own two edges are fixed, not just its width: a meter that
      //     lost a cell to rounding while the percent cell stayed put would move
      //     the bar's right edge without moving the number's, which reads as the
      //     block sliding around inside its own column.
      const meterEdges = new Map();
      for (const { rung, plan } of readings) {
        for (const meter of plan) {
          meterEdges.set(`${rung.name}/${meter.label}`, `${meter.startCol}..${meter.endCol}`);
        }
      }
      const distinctMeterEdges = [...new Set(meterEdges.values())];
      assert.equal(
        distinctMeterEdges.length,
        1,
        `the plan meters must occupy the same columns across the whole ladder (got ${distinctMeterEdges.join(", ")}: ` +
          `${[...meterEdges].map(([k, v]) => `${k}=${v}`).join(" ")})`,
      );

      // 3. The share row is nested under a model, so its meter is allowed to be
      //    shorter -- but only because its label is longer. Its percent must still
      //    land on the same column, and its right edge must still be flush with the
      //    plan rows' meters above it.
      for (const { rung, plan, share } of readings) {
        assert.equal(
          share.percentEndCol,
          plan[0].percentEndCol,
          `rung ${rung.name}: the share percent must share the plan's right edge`,
        );
      }

      // 3b. The share meter's own columns, across the ladder. It is nested and
      //     narrower than the plan meters, but it must not move: it used to, because
      //     its label and its meter both claimed the slack, so the bar was two cells
      //     wider at 100% than at 50% and its percent slid with it.
      const shareEdges = new Map();
      for (const { rung, share } of readings) shareEdges.set(rung.name, `${share.startCol}..${share.endCol}`);
      const distinctShareEdges = [...new Set(shareEdges.values())];
      assert.equal(
        distinctShareEdges.length,
        1,
        `the share meter must occupy the same columns across the whole ladder (got ${distinctShareEdges.join(", ")}: ` +
          `${[...shareEdges].map(([k, v]) => `${k}=${v}`).join(" ")})`,
      );

      // 4. The track tone is read out of the empty rung: at 0% there is no fill, so
      //    whatever color that meter is made of IS the surface. Everything else that
      //    ever appears inside a meter is an accent. This is what lets the test pin
      //    the color ladder without hardcoding an RGB triple only one theme has.
      const empty = readings.find(({ rung }) => rung.name === "all-empty");
      assert.ok(empty !== undefined, "the ladder must include the empty rung");
      const trackTones = new Set(empty.plan.flatMap((meter) => meter.runs.map((run) => run.bg)));
      assert.equal(
        trackTones.size,
        1,
        `at 0% a meter must be one flat tone, so the track is unambiguous (got ${[...trackTones].join(", ")})`,
      );
      const trackTone = [...trackTones][0];

      // The accent a meter used, or null when it has no accent cells at all.
      const accentOf = (meter) => {
        const accents = [...new Set(meter.runs.map((run) => run.bg))].filter((bg) => bg !== trackTone);
        if (accents.length === 0) return null;
        assert.equal(
          accents.length,
          1,
          `a meter must not mix two accents in one span (${meter.label}: ${accents.join(", ")})`,
        );
        return accents[0];
      };

      // 5. Three severities, three colors. This is the ladder itself: muted,
      //    warning and danger must not collapse into one another, or a window at
      //    95% would look exactly like one at 40%.
      const accentBySeverity = new Map();
      for (const { all } of readings) {
        for (const meter of all) {
          const accent = accentOf(meter);
          if (accent === null) continue;
          const severity = meterSeverityForPercent(meter.percent);
          const seen = accentBySeverity.get(severity);
          if (seen === undefined) {
            accentBySeverity.set(severity, accent);
            continue;
          }
          assert.equal(
            seen,
            accent,
            `every ${severity} meter must use one accent color (${meter.label} at ${meter.percent}%)`,
          );
        }
      }
      for (const severity of ["muted", "warning", "error"]) {
        assert.ok(
          accentBySeverity.has(severity),
          `the ladder must exercise the ${severity} color (got ${[...accentBySeverity.keys()].join(", ")})`,
        );
      }
      assert.equal(
        new Set(accentBySeverity.values()).size,
        accentBySeverity.size,
        `the severity colors must be distinguishable (${JSON.stringify(Object.fromEntries(accentBySeverity))})`,
      );

      // 6. The bar tells the truth, and its extremes are honest. At 100% the meter
      //    must be all accent -- a cell of track left beside a full bar is the notch
      //    that reads as "space to the right of the block". At 0% it must be all
      //    track. In between the split is proportional to the number.
      for (const { rung, all } of readings) {
        for (const meter of all) {
          const accent = accentOf(meter);
          const { fill, track } =
            accent === null
              ? { fill: 0, track: meter.width }
              : splitMeter(meter, accent);
          const where = `rung ${rung.name} ${meter.label} at ${meter.percent}%`;
          if (meter.percent === 100) {
            assert.equal(track, 0, `${where}: a full meter must leave no track cell beside it`);
            assert.equal(fill, meter.width, `${where}: a full meter must be all accent`);
            // The tip of the bar, cell by cell. This is the "light grey cell at the
            // end of it, it should've been red too" case: the track's basis would
            // claim one cell past the fill, land on the percent's leading pad, and
            // read as more empty bar touching the number. So the last cell of a full
            // bar must be the bar's own colour -- asserted on the cell, not on the
            // counts above, because a sliver is a positional defect.
            assert.equal(
              meter.row[meter.endCol - 1]?.bg,
              accent,
              `${where}: the last cell of a full bar must be the bar's own colour, not the track`,
            );
          } else if (meter.percent === 0) {
            assert.equal(fill, 0, `${where}: an empty meter must leave no accent cell in it`);
          } else {
            // The host resolves a percentage width to whole cells, so one cell of
            // rounding is expected in either direction. Anything more means the
            // fill is not tracking the number.
            const expected = Math.round((meter.percent / 100) * meter.width);
            assert.ok(
              Math.abs(fill - expected) <= 1,
              `${where}: ${fill} accent cells for ${meter.percent}% of ${meter.width} is not proportional (expected ~${expected})`,
            );
          }
          assert.equal(
            fill + track,
            meter.width,
            `${where}: every cell inside the meter must be accent or track`,
          );
        }
      }
    } finally {
      await fake.stop();
      tmp.cleanup();
    }
  },
);