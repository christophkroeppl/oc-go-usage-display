// E2E tier: the settings menu must be able to take the statusline away, and must
// say which way it will go before it is pressed.
//
// Two things are only true of a real host, so they can only be pinned here:
//
//   1. SELECTING the entry actually removes the statusline from a running TUI.
//      The unit and integration tiers can prove the flag is read and persisted,
//      but the regression they were written for was that the flag governed
//      nothing: `statuslineRenders` dropped the `collapsed` field it was handed,
//      so `collapsed_statusline` was persisted and the statusline stayed on screen
//      forever. Nothing but a pane settles whether a slot stopped drawing.
//   2. THE LABEL the palette prints. The label is a getter, and a getter is only
//      worth having if the host reads `title` when it draws -- so the host's own
//      palette is what has to be looked at, not our arithmetic.
//
// Both hosts are driven, and Kilo is driven in both sidebar modes, because the
// statusline is registered independently of the band and must therefore behave the
// same in each. Standalone is also the mode where the sidebar fold has no host
// panel to hand back, so the label check there is not entangled with the known
// live-handover defect (docs/integrated-band-live-handover.md).
//
// Requires the host binary and tmux (the container image has both); skips cleanly
// on a host without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findKiloBinary } from "../helpers/kilo.js";
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
  startHostServer,
  waitForUsageSurfaces,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only the statusline carries this whole line: the sidebar's plan rows are the
// same three numbers in a different layout, so a fold assertion written against
// "5h 42%" would pass against a sidebar that never went anywhere.
const STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61% · resets in 2h5m/;
// Only the statusline carries this whole line: the sidebar's plan rows are the
// same three numbers in a different layout, so a fold assertion written against
// "5h 42%" would pass against a sidebar that never went anywhere.
//
// The sidebar's own marker is per-mode, because integrated mode draws the plan
// once inside the Models table and so has no `Go Usage` heading at all -- it
// opens with `Session Tokens`. Standingalone keeps the heading.
const SIDEBAR_STANDALONE = /Go Usage/;
const SIDEBAR_INTEGRATED = /Session Tokens/;

const SHOW_STATUSLINE = "Go usage: show statusline";
const HIDE_STATUSLINE = "Go usage: hide statusline";
const SHOW_SIDEBAR = "Go usage: show sidebar";
const HIDE_SIDEBAR = "Go usage: hide sidebar";

// The menu labels are held as plain text, because that is what they are and what
// a failure message should quote, and escaped only where a pattern is needed.
function asPattern(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

// Open the command palette, filter it, and return what it is showing. The key is
// the one both hosts print in their own footer ("ctrl+p commands"), so the pane
// documents the binding this test depends on.
async function readPalette(session, filter) {
  session.sendKeys("C-p");
  await sleep(2500);
  session.sendKeys(filter);
  await sleep(2500);
  return session.capture();
}

async function closePalette(session) {
  session.sendKeys("Escape");
  await sleep(1500);
}

// Poll a RUNNING pane until `wanted` holds for several consecutive captures. The
// stability requirement is the same one the display tests use: a host paints and
// then goes back to a loading state, so one matching frame is often one about to
// be replaced.
async function settle(session, wanted, { timeoutMs = 60000, polls = 4 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let screen = "";
  let stable = 0;
  while (Date.now() < deadline) {
    screen = session.capture();
    stable = wanted.test(screen) ? stable + 1 : 0;
    if (stable >= polls) return screen;
    await sleep(500);
  }
  throw new Error(`never settled into ${wanted}\n--- last captured pane ---\n${screen}`);
}

// The mirror of `settle`, and the one this regression actually needs: the statusline
// has to STAY gone. A single frame without it proves nothing, because the host
// repaints after a fold and would put it straight back, so absence has to hold
// across several consecutive captures before it is believed.
async function settleAbsent(session, unwanted, { timeoutMs = 60000, polls = 4 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let screen = "";
  let stable = 0;
  while (Date.now() < deadline) {
    screen = session.capture();
    stable = !unwanted.test(screen) ? stable + 1 : 0;
    if (stable >= polls) return screen;
    await sleep(500);
  }
  throw new Error(`${unwanted} never went away\n--- last captured pane ---\n${screen}`);
}

// Fold, assert the surface is gone, unfold, assert it is back. Driven entirely
// through the palette, because that is the route a user has.
async function exerciseToggle({ session, filter, hidden, shown, gone, back }) {
  const beforeToggle = await readPalette(session, filter);
  assert.match(beforeToggle, asPattern(hidden), `the menu must offer "${hidden}" while the surface is up`);
  await closePalette(session);

  session.sendKeys("C-p");
  await sleep(2500);
  session.sendKeys(filter);
  await sleep(2000);
  session.sendKeys("Enter");
  await sleep(3000);
  await closePalette(session);

  const afterHide = await settleAbsent(session, gone);
  assert.doesNotMatch(afterHide, gone, `"${hidden}" must actually take the surface away`);

  const afterHidePalette = await readPalette(session, filter);
  assert.match(afterHidePalette, asPattern(shown), `the menu must then offer "${shown}"`);
  await closePalette(session);

  session.sendKeys("C-p");
  await sleep(2500);
  session.sendKeys(filter);
  await sleep(2000);
  session.sendKeys("Enter");
  await sleep(3000);
  await closePalette(session);

  const afterShow = await settle(session, back);
  assert.match(afterShow, back, `"${shown}" must bring the surface back`);
}

// One host, one mode: boot the real TUI on a real Go session and drive the menu.
async function runToggleMenu({ host, binary, mode, sidebar }) {
  const tmp = makeConfigDir();
  try {
    const env = makeTuiEnv({ root: tmp.root, live: false, host });
    if (host === "kilo" && mode !== undefined) env.KILO_OC_GO_SIDEBAR_MODE = mode;

    const models = listProviderModels(binary, "opencode-go", { env, cwd: REPO_DIR });
    const model = pickProviderModel(models);
    assert.ok(model !== null, `the ${host} host must report an opencode-go model (models: ${JSON.stringify(models)})`);
    writeTuiHostConfig({ host, repoDir: REPO_DIR, env, model });

    const server = await startHostServer({ binary, env, cwd: REPO_DIR });
    let sessionId;
    try {
      sessionId = await createSessionWithModel({
        url: server.url,
        directory: REPO_DIR,
        model,
        title: `toggle-menu-${host}${mode === undefined ? "" : `-${mode}`}`,
      });
    } finally {
      server.stop();
    }
    await sleep(750);

    const session = new TuiSession({
      binary,
      args: ["--session", sessionId],
      env,
      cwd: REPO_DIR,
      label: `toggle-${host}-${mode ?? "default"}-${process.pid}-${Date.now()}`,
    });
    try {
      session.start();
      const screen = await waitForUsageSurfaces(session, {
        statusline: STATUSLINE,
        sidebar,
        timeoutMs: 150000,
      });
      assert.match(screen, STATUSLINE, "the statusline must be up before anything is folded");

      // Both labels are checked up front, because a label that is merely
      // well-formed proves nothing about the host printing it.
      const palette = await readPalette(session, "Go usage");
      assert.match(palette, asPattern(HIDE_STATUSLINE), "the menu must say it will hide the statusline");
      assert.match(palette, asPattern(HIDE_SIDEBAR), "and the same for the sidebar");
      await closePalette(session);

      await exerciseToggle({
        session,
        filter: "statusline",
        hidden: HIDE_STATUSLINE,
        shown: SHOW_STATUSLINE,
        gone: STATUSLINE,
        back: STATUSLINE,
      });
    } finally {
      session.stop();
    }
  } finally {
    tmp.cleanup();
  }
}

const OPENCODE_BINARY = findOpencodeBinary();
const OPENCODE_SKIP =
  hostVersionSkipReason({ host: "opencode", binary: OPENCODE_BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");
const KILO_BINARY = findKiloBinary();
const KILO_SKIP = hostVersionSkipReason({ host: "kilo", binary: KILO_BINARY, repoDir: REPO_DIR }) || OPENCODE_SKIP;

test(
  "opencode: the menu takes the statusline away and brings it back",
  { skip: OPENCODE_SKIP, timeout: 900000 },
  async () => {
    await runToggleMenu({ host: "opencode", binary: OPENCODE_BINARY, mode: undefined, sidebar: SIDEBAR_STANDALONE });
  },
);

for (const mode of ["standalone", "integrated"]) {
  test(
    `kilo (${mode}): the menu takes the statusline away and brings it back`,
    { skip: KILO_SKIP, timeout: 900000 },
    async () => {
      await runToggleMenu({
        host: "kilo",
        binary: KILO_BINARY,
        mode,
        sidebar: mode === "integrated" ? SIDEBAR_INTEGRATED : SIDEBAR_STANDALONE,
      });
    },
  );
}