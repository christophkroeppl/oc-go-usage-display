// E2E tier, DYNAMIC: the opencode sidebar and statusline must obey their own
// toggles while the TUI is running.
//
// The counterpart of `tui-controls.kilo.test.js`, and it exists for the same
// reason. opencode's slot bodies evaluated every gate once, at mount: the Go
// check, the route check and the fold check all latched for the life of the
// band, so `/go-usage-sidebar` persisted "collapsed" and repainted nothing. The
// display tier cannot catch that -- it reads a frame the host produced on its own.
//
// Commands are slash commands because the ctrl+P palette does not list plugin
// commands on the pinned opencode either. The plan is mocked and the session
// needs no model call, so nothing here touches a real key.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpencodeBinary } from "../helpers/opencode.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  TuiSession,
  createSessionWithModel,
  hasTmux,
  hostVersionSkipReason,
  listProviderModels,
  makeTuiEnv,
  pickProviderModel,
  readSlashCommand,
  runSlashCommand,
  settleScreen,
  startHostServer,
  waitForIdle,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findOpencodeBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "opencode", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const BLOCK = /Go Usage[\s\S]*\b5h\b[\s\S]*\d+%/;
const STATUSLINE = /Go 5h/;

test(
  "the opencode sidebar and statusline follow their own toggles while the TUI runs",
  { skip: SKIP_NO_HOST, timeout: 1500000 },
  async () => {
    const tmp = makeConfigDir();
    const tui = new TuiSession({
      binary: BINARY,
      args: [],
      env: {},
      cwd: REPO_DIR,
      label: `controls-opencode-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    });
    let stopServer = null;

    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "opencode" });
      // Picked from the host's own catalog so a renamed model cannot make this
      // test fail for the wrong reason.
      const model = pickProviderModel(listProviderModels(BINARY, "opencode-go", { env: base, cwd: REPO_DIR }));
      assert.ok(model, `opencode must report an opencode-go model in this env\n--- models ---\n${base.PATH}`);
      writeTuiHostConfig({ host: "opencode", repoDir: REPO_DIR, env: base, model, provider: undefined });

      const server = await startHostServer({ binary: BINARY, env: base, cwd: REPO_DIR });
      stopServer = server.stop;
      const sessionId = await createSessionWithModel({
        url: server.url,
        directory: REPO_DIR,
        model,
        title: "controls-opencode",
      });
      await new Promise((resolve) => setTimeout(resolve, 750));

      tui.env = base;
      tui.args = ["--session", sessionId];
      tui.start();

      const boot = await settleScreen(tui, BLOCK, { timeoutMs: 180000, stable: 3 });
      assert.ok(boot, `the sidebar block must render on boot\n--- pane ---\n${tui.capture()}`);
      assert.match(boot, STATUSLINE, "and so must the statusline");

      const offered = await readSlashCommand(tui, "go-usage-sidebar");
      assert.match(offered, /Hide the Go usage sidebar panel/, "an expanded block must offer to hide it");

      // Fold the sidebar. The statusline is a separate axis and must not move --
      // this is the pair that proves the two folds are independent rather than one
      // switch wearing two labels.
      const folded = await runSlashCommand(tui, "go-usage-sidebar", (screen) => !/Go Usage/.test(screen));
      assert.ok(folded, `the sidebar must fold live\n--- pane ---\n${tui.capture()}`);
      assert.match(folded, STATUSLINE, "the statusline is a separate axis and must survive");

      const unfolded = await runSlashCommand(tui, "go-usage-sidebar", BLOCK);
      assert.ok(unfolded, `and come back live\n--- pane ---\n${tui.capture()}`);

      // Statusline, both directions.
      const noStatusline = await runSlashCommand(tui, "go-usage-statusline", (screen) => !STATUSLINE.test(screen));
      assert.ok(noStatusline, `the statusline must fold live\n--- pane ---\n${tui.capture()}`);
      assert.match(noStatusline, BLOCK, "and the sidebar must not move with it");

      const statuslineBack = await runSlashCommand(tui, "go-usage-statusline", STATUSLINE);
      assert.ok(statuslineBack, `and come back live\n--- pane ---\n${tui.capture()}`);

      await waitForIdle(tui);
      console.log("[e2e] every opencode toggle followed along on one running TUI");
    } finally {
      tui.stop();
      stopServer?.();
      tmp.cleanup();
    }
  },
);