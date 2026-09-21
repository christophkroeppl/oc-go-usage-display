// E2E tier: the REAL Kilo Code TUI must display Go usage.
//
// Same flow and assertions as tui-display.opencode.test.js, but against the
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
  fetchLiveUsage,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  runTuiDisplay,
  skipWithNotice,
} from "../helpers/tui.js";
import { extractSnapshotFromApiPayload } from "../../dist/shared.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61%/;
const MOCK_SIDEBAR = /Go Usage/;
const LIVE_STATUSLINE = /Go 5h \d+% \| 7d (?:\d+%|n\/a) \| 30d (?:\d+%|n\/a)/;

test(
  "kilo TUI displays the mock usage in sidebar and statusline",
  { skip: SKIP_NO_HOST, timeout: 300000 },
  async () => {
    const tmp = makeConfigDir();
    try {
      const env = makeTuiEnv({ root: tmp.root, live: false });
      const { model, screen } = await runTuiDisplay({
        host: "kilo",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: MOCK_STATUSLINE, sidebar: MOCK_SIDEBAR },
      });
      assert.match(screen, /5h 42% · resets 2h5m/, "sidebar must render the rolling row");
      assert.match(screen, /7d 15%/, "sidebar must render the weekly row");
      assert.match(screen, /30d 61%/, "sidebar must render the monthly row");
      console.log(`[e2e] kilo TUI mock usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);

test(
  "kilo TUI displays live usage from the API",
  {
    skip: SKIP_NO_HOST || (process.env.OPENCODE_GO_API_KEY ? false : "OPENCODE_GO_API_KEY not set"),
    timeout: 300000,
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
        host: "kilo",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        expect: { statusline: LIVE_STATUSLINE, sidebar: MOCK_SIDEBAR },
      });
      console.log(`[e2e] kilo TUI live usage rendered (model ${model})`);
    } finally {
      tmp.cleanup();
    }
  },
);
