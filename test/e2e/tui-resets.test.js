// E2E tier: what `resets in` actually prints, for every shape a countdown takes.
//
// The countdown is the one piece of the block whose TEXT is chosen by a formatter
// rather than printed from the payload, so it is the one piece a single mock
// reading says nothing about: `1w 0d` and `1w` differ only in the formatter, and
// so do `1w 1d` and `1w 1d 22h`. The meter ladder (tui-meters.test.js) drives the
// bars; this one drives this.
//
// Each rung sets all three windows at once, so three renderings are covered per
// boot, and each rung carries the text it expects so a failure names the
// formatting rule rather than a pair of numbers.
//
// Kilo integrated on purpose: it is the view where the per-row countdown and the
// statusline are both on screen, so one boot covers both places the text is
// rendered. The two are asserted separately, because both contain "resets in" and
// a plain substring match could not tell them apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findKiloBinary } from "../helpers/kilo.js";
import { resetLadders } from "../helpers/ladder.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  runTuiDisplay,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const PLAN_LABELS = ["5h", "7d", "30d"];

// A rendered countdown, as a run of `12h`-shaped units. Matching the shape rather
// than "everything to the end of the line" matters on the statusline, where Kilo
// prints the working directory after it: `· resets in 1w 1d 22h   develop:develop`.
// The units are space-separated except that hours and minutes run together, so
// `\s*` rather than a literal space is what covers `2h5m` and `1w 1d 22h` at once.
const COUNTDOWN = String.raw`\d+[wdhms](?:\s*\d+[wdhms])*`;

// A plan row's own countdown sits on its own line with no window label, which is
// what tells it apart from the statusline's.
const rowCountdowns = (screen) =>
  screen
    .split("\n")
    .map((line) => new RegExp(String.raw`^\s*resets in\s+(${COUNTDOWN})\s*$`).exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);

const statuslineCountdown = (screen) => {
  const line = screen.split("\n").find((candidate) => /Go 5h \d+%/.test(candidate));
  if (line === undefined) return null;
  return new RegExp(String.raw`·\s*resets in\s+(${COUNTDOWN})`).exec(line)?.[1] ?? null;
};

test(
  "kilo renders every shape of the resets-in countdown",
  { skip: SKIP_NO_HOST, timeout: 3600000 },
  async () => {
    const tmp = makeConfigDir();
    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";

      for (const rung of resetLadders()) {
        const env = { ...base, KILO_OC_GO_MOCK_RESETS: rung.resets, KILO_OC_GO_MOCK_LIMITED: rung.limited };
        const { screen } = await runTuiDisplay({
          host: "kilo",
          binary: BINARY,
          repoDir: REPO_DIR,
          env,
          expect: { statusline: /Go 5h \d+%/, sidebar: /Go Plan|Go Usage/ },
        });

        // The per-row countdowns, in plan order. A window with nothing capped
        // prints none, so the count of these lines is itself under test.
        const rows = rowCountdowns(screen);
        const expectedRows = PLAN_LABELS.map((label) => rung.rows[label]).filter((text) => text !== null);
        assert.deepEqual(
          rows,
          expectedRows,
          `rung ${rung.name} (${rung.why}) must print its per-row countdowns in 5h/7d/30d order`,
        );
        assert.equal(
          screen.includes("resets in"),
          expectedRows.length > 0 || rung.statusline !== null,
          `rung ${rung.name}: the screen must carry "resets in" exactly when something is counting down`,
        );
        assert.equal(
          statuslineCountdown(screen),
          rung.statusline,
          `rung ${rung.name} (${rung.why}): the statusline countdown`,
        );
        // No rendered countdown may carry a zero unit. Checked on the strings
        // themselves rather than the whole line, because the plan labels contain
        // zeroes of their own ("30d") that are not what this is about.
        for (const text of [...rows, rung.statusline].filter((value) => value !== null)) {
          assert.doesNotMatch(
            text,
            /(^|\s)0[wdhms]/,
            `rung ${rung.name}: "${text}" prints a countdown unit that is zero`,
          );
        }
        console.log(
          `[e2e] ${rung.name}: rows=${JSON.stringify(rows)} statusline=${JSON.stringify(rung.statusline)}`,
        );
      }
    } finally {
      tmp.cleanup();
    }
  },
);