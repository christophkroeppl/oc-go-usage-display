// E2E tier: the REAL opencode TUI must display Go usage.
//
// Boots opencode in a detached tmux session against a hermetic tmp root and
// asserts the rendered pane carries both additive surfaces:
//   - sidebar_content      -> the `Go Usage` block: the next reset under the
//     header, one meter per plan window, and the model section
//   - session_prompt_right -> `Go 5h 42% | 7d 15% | 30d 61%`
//
// The probe session carries a `noReply` message, so it has no assistant
// messages and therefore no model usage: the section renders its empty state.
// That is the honest assertion for this harness — the per-model NUMBERS are
// pure helpers covered by the readonly unit tier, and a session with real usage
// would need a real model call (a real Go key), which this gate has none of.
//
// The deterministic variant uses OPENCODE_OC_GO_MOCK=1; the live variant renders
// the real API snapshot when a GO API key is present and skips
// neutrally otherwise. Both pick an available `opencode-go` model dynamically
// (see test/helpers/tui.js) so renamed/retired models cannot cause false
// negatives. Requires the opencode binary and tmux (the container image has
// both); skips cleanly on a host without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpencodeBinary } from "../helpers/opencode.js";
import { goApiKeyFromEnv } from "../helpers/run.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  assertSidebarOrder,
  fetchLiveUsage,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  runTuiDisplay,
  skipWithNotice,
} from "../helpers/tui.js";
import { extractSnapshotFromApiPayload } from "../../dist/shared.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findOpencodeBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "opencode", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61%/;
// The whole sidebar block, so the capture cannot land between the header and
// the rows: the model section is what proves the block finished rendering.
const MOCK_SIDEBAR_SETTLED = /Go Usage[\s\S]*Top Go models/;
const LIVE_STATUSLINE = /Go 5h \d+% \| 7d (?:\d+%|n\/a) \| 30d (?:\d+%|n\/a)/;
const METER_CELL = "\u2588";

test(
  "opencode TUI displays the mock usage in sidebar and statusline",
  { skip: SKIP_NO_HOST, timeout: 600000 },
  async () => {
    const tmp = makeConfigDir();
    try {
      const env = makeTuiEnv({ root: tmp.root, live: false, host: "opencode" });
      const { model, screen } = await runTuiDisplay({
        host: "opencode",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: MOCK_STATUSLINE, sidebar: MOCK_SIDEBAR_SETTLED },
      });
      // The plan is the meters themselves in this host's narrow sidebar, and
      // the soonest reset is its own line under the header.
      assert.match(screen, /5h resets in 2h5m/, "sidebar must render the next reset");
      assert.match(screen, /5h\s+[\u2588\u2591]+ 42%/, "sidebar must render the rolling meter");
      assert.match(screen, /7d\s+[\u2588\u2591]+ 15%/, "sidebar must render the weekly meter");
      assert.match(screen, /30d\s+[\u2588\u2591]+ 61%/, "sidebar must render the monthly meter");
      assert.ok(screen.includes(METER_CELL), "the plan must render as a block meter, not a bare percent");
      // No assistant messages means no weights, and the section says so
      // instead of printing an empty ranking or a zero.
      assert.match(screen, /Top Go models/, "the model section must render");
      assert.match(screen, /No model usage yet/, "a session with no assistant messages says so");
      // SLOT_ORDER 50: above every host panel, so the block leads the sidebar
      // and `Context` (the first host panel, at 100) follows it.
      assertSidebarOrder(screen, { before: [/\bContext\b/] });
      console.log(`[e2e] opencode TUI mock usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);

test(
  "opencode TUI displays live usage from the API",
  {
    skip: SKIP_NO_HOST || (goApiKeyFromEnv().value ? false : "GO API key not set (OPENCODE_OC_GO_API_KEY)"),
    timeout: 600000,
  },
  async (t) => {
    const snapshot = await fetchLiveUsage(goApiKeyFromEnv().value, {
      extractSnapshotFromApiPayload,
    });
    if (snapshot === null) {
      skipWithNotice(t, "live usage API returned no usable windows (no Go subscription)");
      return;
    }

    const tmp = makeConfigDir();
    try {
      const env = makeTuiEnv({ root: tmp.root, live: true, host: "opencode" });
      const { model, screen } = await runTuiDisplay({
        host: "opencode",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: LIVE_STATUSLINE, sidebar: MOCK_SIDEBAR_SETTLED },
      });
      assert.match(screen, /5h\s+[\u2588\u2591]+ \d+%/, "sidebar must render the live rolling meter");
      console.log(`[e2e] opencode TUI live usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);
