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

const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61%/;
const MOCK_SIDEBAR = /Go Usage/;

// Both sidebar modes are driven explicitly rather than inherited from the
// default. The mode decides whether Kilo's own `Token Usage` panel is on screen
// at all -- integrated mode retires it -- so the ordering anchors differ per
// mode and an unpinned test would assert one of them against the other.
const MODES = [
  {
    mode: "standalone",
    // The poll helper waits for `expect.sidebar` before it captures, and the
    // host panel is switched asynchronously, so the wait pattern is what makes
    // the settled state observable: only a screen showing BOTH panels means
    // `activate` has landed. Matching `Go Usage` alone would let the capture
    // race the switch and flake.
    settled: /Go Usage[\s\S]*\bToken Usage\b/,
    // KILO_SLOT_ORDER 125: below `Context` (100), above `Token Usage` (150),
    // so both readouts stay adjacent and the host panel is untouched.
    order: { before: [/\bToken Usage\b/], after: [/\bContext\b/] },
    hostPanel: true,
  },
  {
    mode: "integrated",
    // Same reasoning: the block only reads as settled once it sits in the host
    // panel's old band, i.e. above the panels that follow it.
    settled: /Go Usage[\s\S]*\bLSP\b/,
    // KILO_INTEGRATED_SLOT_ORDER 150: the host panel's own band, so our block
    // is below `Context` and there is no `Token Usage` header to anchor below.
    order: { after: [/\bContext\b/] },
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
        assert.match(screen, MOCK_SIDEBAR, "sidebar must render the Go Usage block");
        assert.match(screen, /5h 42% · resets 2h5m/, "sidebar must render the rolling row");
        // The `Go Plan` meters are fixed-width columns: they must stack on one
        // left edge, whatever the labels are.
        if (mode === "integrated") {
          const rows = screen
            .split("\n")
            .filter((line) => /^\s*(?:5h|7d|30d)\s+[\u2588\u2591]+\s+\d+%\s*$/.test(line));
          assert.equal(rows.length, 3, "the plan must render three stacked meters");
          const columns = rows.map((line) => line.search(/[\u2588\u2591]/));
          assert.ok(
            columns.every((column) => column === columns[0]),
            `meters must share a left edge (got ${columns.join(", ")})`,
          );
          const percents = rows.map((line) => line.search(/\d+%\s*$/));
          assert.ok(
            percents.every((column) => column === percents[0]),
            `percents must share a right edge (got ${percents.join(", ")})`,
          );
        }
        assert.match(screen, /7d 15%/, "sidebar must render the weekly row");
        assert.match(screen, /30d 61%/, "sidebar must render the monthly row");
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
