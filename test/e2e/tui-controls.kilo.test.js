// E2E tier, DYNAMIC: the Kilo sidebar and statusline must obey their own toggles
// while the TUI is running.
//
// The display tier (`tui-display.kilo.test.js`) reads one frame the host produced
// on its own, from env vars chosen before boot. That cannot see the class of bug
// this file exists for: a control that accepts the command, persists its new
// value, and repaints nothing. Both of these did exactly that, because every gate
// in the slot body was evaluated once at mount and latched for the life of the
// band (see `reactiveChild` in src/tui-shared.tsx).
//
// So this file drives a running TUI through tmux: it waits for idle, invokes the
// toggles as slash commands, and asserts the pane AFTER each one. Commands are
// slash commands because the ctrl+P palette does not list plugin commands on the
// pinned host -- which is also why the toggles used to be unreachable at all.
//
// The plan is mocked (`OPENCODE_OC_GO_MOCK=1`) and the provider is a local fake
// registered under the real `opencode-go` id, so the host records real messages
// with real token accounting and nothing leaves the machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fakeProvider from "../helpers/fake-provider.js";
import { findKiloBinary } from "../helpers/kilo.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  TuiSession,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  readSlashCommand,
  runSlashCommand,
  settleScreen,
  waitForIdle,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const GO_PROVIDER = "opencode-go";
const GO_MODEL = `${GO_PROVIDER}/go-probe`;

const OUR_INTEGRATED = /Session Tokens[\s\S]*Models \(\d+\)[\s\S]*Go Plan/;
const OUR_STANDALONE_BLOCK = /Go Usage[\s\S]*\b5h\b[\s\S]*\d+%/;
const KILO_PANEL = /Token Usage[\s\S]*\bInput\b[\s\S]*\d/;
const STATUSLINE = /Go 5h/;

// One session, booted once, driven through every toggle and back again. Splitting
// these into separate tests would boot a TUI per assertion, which is minutes each
// and buys nothing: the point is that the SAME running surface follows along.
test(
  "the Kilo sidebar and statusline follow their own toggles while the TUI runs",
  { skip: SKIP_NO_HOST, timeout: 1500000 },
  async () => {
    const tmp = makeConfigDir();
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: {
        "go-probe": { prompt_tokens: 1_200_000, completion_tokens: 30_000, total_tokens: 1_230_000 },
      },
    });
    const tui = new TuiSession({
      binary: BINARY,
      args: [],
      env: {},
      cwd: REPO_DIR,
      label: `controls-kilo-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    });

    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";
      writeTuiHostConfig({
        host: "kilo",
        repoDir: REPO_DIR,
        env: base,
        model: GO_MODEL,
        provider: fake.configFor(GO_PROVIDER),
      });

      // Pre-create the session with a real turn, so the band has model usage and a
      // known provider before the TUI ever mounts it. Typing into the home screen
      // instead is racy: the first keystrokes land before the prompt has focus.
      const promptEnv = { ...base };
      delete promptEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      delete promptEnv.OPENCODE_DISABLE_MODELS_FETCH;
      const turn = await fakeProvider.runHeadlessPrompt({
        binary: BINARY,
        env: promptEnv,
        cwd: REPO_DIR,
        message: "usage probe",
        model: GO_MODEL,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));

      tui.env = base;
      tui.args = ["--session", turn.sessionId];
      tui.start();

      const boot = await settleScreen(tui, OUR_INTEGRATED, { timeoutMs: 180000, stable: 3 });
      assert.ok(boot, `the integrated panel must render on boot\n--- pane ---\n${tui.capture()}`);
      assert.doesNotMatch(boot, /\bToken Usage\b/, "and Kilo's own panel must be retired");

      // The commands must be offered at all, with a title that names the state it
      // moves to -- so the label cannot drift from what the command actually does.
      const sidebarCommand = await readSlashCommand(tui, "go-usage-sidebar");
      assert.match(
        sidebarCommand,
        /Hide the Go usage sidebar panel/,
        "an expanded band must offer to hide it",
      );
      const modeCommand = await readSlashCommand(tui, "go-usage-sidebar-mode");
      assert.match(
        modeCommand,
        /Draw the standalone Go usage panel/,
        "integrated is current, so the menu must offer standalone",
      );

      // Mode -> standalone. Kilo's panel comes BACK (we stop filling its space) and
      // our own block appears. Both on screen at once is what standalone means.
      const standalone = await runSlashCommand(tui, "go-usage-sidebar-mode", OUR_STANDALONE_BLOCK);
      assert.ok(standalone, `standalone block must appear live\n--- pane ---\n${tui.capture()}`);
      assert.match(standalone, KILO_PANEL, "standalone leaves Kilo's panel alone");
      assert.doesNotMatch(standalone, /\bSession Tokens\b/, "and our integrated panel is gone");

      // Mode -> integrated. Our fork returns and Kilo's panel retires again.
      const reintegrated = await runSlashCommand(tui, "go-usage-sidebar-mode", OUR_INTEGRATED);
      assert.ok(reintegrated, `integrated must come back live\n--- pane ---\n${tui.capture()}`);
      assert.doesNotMatch(reintegrated, /\bToken Usage\b/, "and Kilo's panel must retire again");

      // Fold the band: Kilo's panel must take the space back rather than leaving
      // a hole, which is the invariant the whole ownership matrix exists for.
      const folded = await runSlashCommand(tui, "go-usage-sidebar", KILO_PANEL);
      assert.ok(folded, `folding must hand the readout back to Kilo\n--- pane ---\n${tui.capture()}`);
      assert.doesNotMatch(folded, /\bSession Tokens\b/, "and our panel must be gone");

      // Unfold it again: the surface has to come back, or the toggle is a one-way trip.
      const unfolded = await runSlashCommand(tui, "go-usage-sidebar", OUR_INTEGRATED);
      assert.ok(unfolded, `unfolding must bring our panel back\n--- pane ---\n${tui.capture()}`);

      // Statusline, both directions. The flag was persisted and then ignored, which
      // is why the fold could not hide it (statuslineRenders used to drop `collapsed`).
      const noStatusline = await runSlashCommand(tui, "go-usage-statusline", (screen) => !STATUSLINE.test(screen));
      assert.ok(noStatusline, `the statusline must fold live\n--- pane ---\n${tui.capture()}`);
      assert.match(noStatusline, OUR_INTEGRATED, "and the sidebar is a separate axis: it must not move");

      const statuslineBack = await runSlashCommand(tui, "go-usage-statusline", STATUSLINE);
      assert.ok(statuslineBack, `and come back live\n--- pane ---\n${tui.capture()}`);

      await waitForIdle(tui);
      console.log("[e2e] every Kilo toggle followed along on one running TUI");
    } finally {
      tui.stop();
      await fake.stop();
      tmp.cleanup();
    }
  },
);