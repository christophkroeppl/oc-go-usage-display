// E2E tier: the REAL Kilo Code TUI must display Go usage.
//
// Same flow and assertions as tui-display.opencode.test.js (mocked usage, no
// key), but against the
// Kilo host: `$XDG_CONFIG_HOME/kilo/{opencode.json,tui.json}` and the
// `dist/plugins/oc-go-usage-display.kilo.tsx` bundle. Kilo's tui.json schema
// rejects `sidebar`/`statusline` keys (which would invalidate the whole file
// and skip the plugin), so the config omits them and relies on the plugin's
// both-surfaces default. Requires the kilo binary and tmux (the container
// image has both); skips cleanly on a host without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findKiloBinary } from "../helpers/kilo.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  assertSidebarOrder,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  runTuiDisplay,
} from "../helpers/tui.js";
import { KILO_TOKEN_USAGE_ROWS } from "../../dist/shared.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

// The statusline also carries one countdown. The mock caps nothing and only
// the 5h window has an instant, so the line must end in the 5h reset --
// the rendering of a capped window is a pure-selection case the unit tier
// pins, while this is here to prove the host slot really prints the suffix.
const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61% · resets in 2h5m/;
const MOCK_SIDEBAR = /Go Usage/;

// Both sidebar modes are driven explicitly rather than inherited from the
// default. The mode decides whether Kilo's own `Token Usage` panel is on screen
// at all -- integrated mode retires it -- so the ordering anchors differ per
// mode and an unpinned test would assert one of them against the other.
// The meters are boxes now, not block glyphs: a plain-text capture cannot see
// them, so what it CAN check is the grid they sit in -- three plan rows, labels
// on one column, percents on one column, and the percent column reaching the
// same right edge as the host's own rows. That last one is the property a
// screenshot complaint about "space on the right" is really about.
// Every line in the host's sidebar ends with its own edge glyph -- a right
// border, a scrollbar thumb -- which is NOT part of our content and is not there
// on every host or in every panel state. Match against the line with that
// trailing glyph removed, or a grid assertion silently finds nothing on a screen
// that is showing exactly what it asked for (it did: three plan rows, zero
// matches).
const stripEdge = (line) => line.replace(/[\u2500-\u259f\u25a0-\u25ff]+\s*$/, "").replace(/\s+$/, "");
const PLAN_ROW = /^\s*(?:5h|7d|30d)\s+\d+%\s*$/;
const planRows = (screen) => screen.split("\n").map(stripEdge).filter((line) => PLAN_ROW.test(line));

// The end column of the last match of `pattern` on any line. Measured on the
// host's OWN sidebar rows (the ones with a known label and a right-aligned
// value), never on the transcript to their left -- the pane is 200 cells wide
// and full of numbers, so "the widest line on screen" is not the sidebar's edge.
function rightmostColumn(screen, pattern) {
  const global = new RegExp(pattern.source, "g");
  let best = -1;
  for (const line of screen.split("\n").map(stripEdge)) {
    for (const match of line.matchAll(global)) best = Math.max(best, (match.index ?? 0) + match[0].length);
  }
  return best;
}

function assertPlanGrid(screen) {
  const rows = planRows(screen);
  // A layout assertion that only says "0 !== 3" is useless: the rows it looked
  // for are missing, truncated or off the edge. The sidebar's lines go in the
  // message so the next failure says which.
  const sidebar = screen
    .split("\n")
    .map((line, index) => [index, line.replace(/\s+$/, "")])
    .filter(([, line]) => /Go Plan|Session Tokens|Models|resets in|\b5h|\b7d|\b30d/.test(line))
    .map(([index, line]) => `${index}|${line}`);
  assert.equal(rows.length, 3, `the plan must render three rows\n${sidebar.join("\n")}`);

  const labels = rows.map((line) => line.indexOf(line.trim().split(/\s+/)[0]));
  assert.ok(
    labels.every((column) => column === labels[0]),
    `the plan labels must share a left edge (got ${labels.join(", ")})`,
  );
  // END columns, not start: the cell is right-aligned, so `  0%` and `100%`
  // start two columns apart and are still aligned. Asserting starts only passed
  // because the mock's percents are all two digits.
  const percentEnds = rows.map((line) => line.search(/\d+%\s*$/) + line.match(/\d+%\s*$/)[0].length);
  assert.ok(
    percentEnds.every((column) => column === percentEnds[0]),
    `the plan percents must share a right edge (got ${percentEnds.join(", ")})`,
  );
  // The percent column must end where the host's own value column ends, i.e.
  // the block is flush with the sidebar's right edge and leaves no dead space.
  const planEdge = Math.max(...rows.map((line) => line.search(/\d+%\s*$/) + line.match(/\d+%\s*$/)[0].length));
  const hostEdge = rightmostColumn(
    screen,
    new RegExp(`(?:${KILO_TOKEN_USAGE_ROWS.join("|")})\\s+\\S+\\s*$`),
  );
  assert.ok(
    planEdge >= hostEdge - 1,
    `the plan must reach the host's right edge (plan ${planEdge}, host ${hostEdge})`,
  );
}

const MODES = [
  {
    mode: "standalone",
    // The poll helper waits for `expect.sidebar` before it captures, and the
    // host panel is switched asynchronously, so the wait pattern is what makes
    // the settled state observable. It waits for a host ROW, not just the
    // panel's header: `activate` registers the panel a frame before it draws
    // its rows, so a header-only match lets the capture race it and the next
    // assertion ("kilo must still render the Input row") flakes.
    settled: /Go Usage[\s\S]*\bToken Usage\b[\s\S]*\bInput\b[\s\S]*\d/,
    // KILO_SLOT_ORDER 125: below `Context` (100), above `Token Usage` (150),
    // so both readouts stay adjacent and the host panel is untouched.
    order: { before: [/\bToken Usage\b/], after: [/\bContext\b/] },
    hostPanel: true,
  },
  {
    mode: "integrated",
    // Same reasoning: the block only reads as settled once it sits in the host
    // panel's old band, i.e. above the panels that follow it. `Session Tokens`
    // is the first thing integrated mode renders -- there is no `Go Usage`
    // heading above it any more.
    settled: /Session Tokens[\s\S]*\bLSP\b/,
    // KILO_INTEGRATED_SLOT_ORDER 150: the host panel's own band, so our block
    // is below `Context` and there is no `Token Usage` header to anchor below.
    // Integrated mode opens with `Session Tokens` -- there is no `Go Usage`
    // heading, because the plan is drawn once inside the Models table.
    order: { after: [/\bContext\b/], anchor: /Session Tokens/ },
    hostPanel: false,
  },
];

for (const { mode, order, hostPanel, settled } of MODES) {
  test(
    `kilo TUI displays the mock usage in sidebar and statusline (${mode})`,
    { skip: SKIP_NO_HOST, timeout: 600000 },
    async () => {
      const tmp = makeConfigDir();
      try {
        const env = makeTuiEnv({ root: tmp.root, live: false });
        env.KILO_OC_GO_SIDEBAR_MODE = mode;
        const { model, screen } = await runTuiDisplay({
          host: "kilo",
          binary: BINARY,
          repoDir: REPO_DIR,
          env,
          expect: { statusline: MOCK_STATUSLINE, sidebar: settled },
        });
        assertPlanGrid(screen);
        assert.match(screen, /^\s*5h\s+42%\s*$/m, "sidebar must render the rolling row");
        assert.match(screen, /^\s*7d\s+15%\s*$/m, "sidebar must render the weekly row");
        assert.match(screen, /^\s*30d\s+61%\s*$/m, "sidebar must render the monthly row");
        if (mode === "integrated") {
          // Integrated mode draws the plan ONCE, as the `Go Plan` meters inside
          // the OpenCode Go group. A separate `Go Usage` block above it said the
          // same three numbers twice on one screen.
          assert.match(screen, /\bGo Plan\b/, "the plan must be drawn inside the Models table");
          assert.doesNotMatch(screen, /\bGo Usage\b/, "integrated mode must not repeat the plan as its own block");
        } else {
          assert.match(screen, MOCK_SIDEBAR, "standalone mode renders the Go Usage block");
          // The header line the integrated view has no room for: there the plan
          // lives in a table, and only a capped window carries a countdown.
          assert.match(screen, /5h resets in 2h5m/, "the block must print the next reset under its header");
        }
        assertSidebarOrder(screen, order);

        if (hostPanel) {
          // The rows the integrated mode mirrors. Asserted here because this
          // screen already has Kilo's panel rendered: one boot proves both that
          // the labels exist upstream and that our block lands among them.
          for (const label of KILO_TOKEN_USAGE_ROWS) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(screen, new RegExp(escaped), `kilo must still render the "${label}" row we mirror`);
          }
        } else {
          // Integrated mode must have retired the host panel, not merely
          // rendered beside it: two competing usage blocks is the failure mode.
          assert.doesNotMatch(
            screen,
            /\bToken Usage\b/,
            "integrated mode must retire Kilo's own Token Usage panel",
          );
        }
        console.log(`[e2e] kilo TUI mock usage rendered (model ${model}, ${mode})`);
      } finally {
        tmp.cleanup();
      }
    },
  );
}
