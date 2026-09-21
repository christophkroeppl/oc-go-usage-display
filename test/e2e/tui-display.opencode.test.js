// E2E tier: the REAL opencode TUI must display Go usage.
//
// Boots opencode in a detached tmux session against a hermetic tmp root and
// asserts the rendered pane carries both additive surfaces:
//   - sidebar_content      -> `Go Usage` + `5h 42% · resets 2h5m` rows
//   - session_prompt_right -> `Go 5h 42% | 7d 15% | 30d 61%`
//
// The deterministic variant uses OPENCODE_GO_MOCK=1; the live variant renders
// the real API snapshot when OPENCODE_GO_API_KEY is present and skips
// neutrally otherwise. Both pick an available `opencode-go` model dynamically
// (see test/helpers/tui.js) so renamed/retired models cannot cause false
// negatives. Requires the opencode binary and tmux (the container image has
// both); skips cleanly on a host without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpencodeBinary } from "../helpers/opencode.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
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
const MOCK_SIDEBAR = /Go Usage/;
const LIVE_STATUSLINE = /Go 5h \d+% \| 7d (?:\d+%|n\/a) \| 30d (?:\d+%|n\/a)/;

test(
  "opencode TUI displays the mock usage in sidebar and statusline",
  { skip: SKIP_NO_HOST, timeout: 600000 },
  async () => {
    const tmp = makeConfigDir();
    try {
      const env = makeTuiEnv({ root: tmp.root, live: false });
      const { model, screen } = await runTuiDisplay({
        host: "opencode",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: MOCK_STATUSLINE, sidebar: MOCK_SIDEBAR },
      });
      assert.match(screen, /5h 42% · resets 2h5m/, "sidebar must render the rolling row");
      assert.match(screen, /7d 15%/, "sidebar must render the weekly row");
      assert.match(screen, /30d 61%/, "sidebar must render the monthly row");
      console.log(`[e2e] opencode TUI mock usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);

test(
  "opencode TUI displays live usage from the API",
  {
    skip: SKIP_NO_HOST || (process.env.OPENCODE_GO_API_KEY ? false : "OPENCODE_GO_API_KEY not set"),
    timeout: 600000,
  },
  async (t) => {
    const snapshot = await fetchLiveUsage(process.env.OPENCODE_GO_API_KEY, {
      extractSnapshotFromApiPayload,
    });
    if (snapshot === null) {
      skipWithNotice(t, "live usage API returned no usable windows (no Go subscription)");
      return;
    }

    const tmp = makeConfigDir();
    try {
      const env = makeTuiEnv({ root: tmp.root, live: true });
      const { model, screen } = await runTuiDisplay({
        host: "opencode",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: LIVE_STATUSLINE, sidebar: MOCK_SIDEBAR },
      });
      console.log(`[e2e] opencode TUI live usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);
