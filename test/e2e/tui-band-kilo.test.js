// E2E tier: integrated mode must never leave Kilo's sidebar band empty.
//
// The bug this pins: integrated mode retires Kilo's own `Token Usage` panel at
// load, and its replacement panel declined to draw whenever the session was not
// on an `opencode-go` model. The usage region of the sidebar -- the host's own
// token-usage band, which our slot sits in -- rendered nothing at all. There is no
// screenshot of that state in the README, because there was nothing to
// screenshot: the user got a hole where their token readout used to be.
//
// Only the real host can settle this, so every rung boots or drives the actual
// Kilo TUI in integrated mode and looks at the rendered pane:
//
//   1. a session that only ever ran a NON-Go model -> Kilo's own `Token Usage`
//      panel is on screen. Ours is a fork of that panel, not an extension of it
//      (no `Terminal Bench 2.0` section, no `Generation speed` row), so with no
//      Go model to meter the honest result is to hand the band back, not to
//      replace a panel we cannot fully reproduce;
//   2. a session whose ONLY model is a Go model -> OUR panel is on screen. This
//      is the shape most sessions have, and the one where there is nothing to
//      defer to;
//   3. one session holding models from BOTH providers -> OUR panel is on screen,
//      Kilo's is not, and both provider groups render with the `Go Plan` meters
//      inside the `OpenCode Go` one. This is the case the whole design exists
//      for, and it is the one that would regress silently if the gate were simply
//      deleted;
//   4. both handovers, live, on ONE running session with no restart -- the
//      direction that used to empty the band (docs/integrated-band-live-handover.md).
//
// The provider is a local fake (test/helpers/fake-provider.js) registered under a
// real provider id, so the host writes real assistant messages with real token
// accounting and the models table has something to group. Nothing leaves the
// machine, the plan comes from the mock, and no Go subscription is touched.

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
  pickModel,
  sendTurn,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findKiloBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "kilo", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

// The real provider id our gate keys on, and a second one that is NOT it. Both are
// pointed at the local fake, so the host resolves them exactly as it would a real
// provider and records the messages with the right provider on them.
const GO_PROVIDER = "opencode-go";
const OTHER_PROVIDER = "probe-provider";
const GO_MODEL = `${GO_PROVIDER}/go-probe`;
const OTHER_MODEL = `${OTHER_PROVIDER}/other-probe`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Booting a pinned host in a fresh container takes tens of seconds, so a slow
// first boot must cost time rather than a flaky red.
const BOOT_TIMEOUT_MS = 120000;
// Consecutive settled captures before a pane is trusted. The host paints the
// sidebar and then goes back to a loading state while it finishes starting up
// (see docs/session-usage-stuck-loading.md), so one matching frame is often one
// about to be replaced.
const SETTLED_POLLS = 3;
const POLL_INTERVAL_MS = 500;

// Either usage panel loading, or the models table not yet filled in: while any of
// these is on screen the pane is not the resting state we want to assert.
const SETTLING = /Finishing startup|Loading usage\.\.\.|Usage unavailable|No model usage yet/;

// Boot the TUI once and return the settled pane, or null if the wanted state never
// appeared. null lets the caller re-boot rather than fail on a host-timing miss.
async function bootSettledPane({ env, sessionId, settled, label }) {
  const tui = new TuiSession({
    binary: BINARY,
    args: ["--session", sessionId],
    env,
    cwd: REPO_DIR,
    label: `band-${label}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  });
  try {
    tui.start();
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let screen = "";
    let stable = 0;
    while (Date.now() < deadline) {
      screen = tui.capture();
      stable = settled.test(screen) && !SETTLING.test(screen) ? stable + 1 : 0;
      if (stable >= SETTLED_POLLS) return tui.capture();
      await sleep(POLL_INTERVAL_MS);
    }
    // The pane goes in the error, not just the pattern: "the sidebar never settled"
    // is useless when the pane on screen is the answer.
    throw new Error(
      `${label}: the sidebar never settled (wanted ${settled})\n--- last captured pane ---\n${screen}`,
    );
  } finally {
    tui.stop();
  }
}

async function bootOrRetry({ env, sessionId, settled, label }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const screen = await bootSettledPane({ env, sessionId, settled, label });
    if (screen !== null) return screen;
    console.log(`[e2e] ${label}: settled state not reached on boot ${attempt}/3, retrying`);
  }
  throw new Error(`${label}: the sidebar never reached its settled state after 3 boots`);
}

// Poll an ALREADY RUNNING session until it settles into `wanted`, and return that
// pane. This is the difference between "the sidebar is right at start" and "the
// sidebar follows": nothing is restarted here, so a pane that changes is proof the
// running TUI reacted rather than that a fresh boot happened to agree.
async function waitForPane(tui, wanted, label) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let screen = "";
  let stable = 0;
  while (Date.now() < deadline) {
    screen = tui.capture();
    stable = wanted.test(screen) && !SETTLING.test(screen) ? stable + 1 : 0;
    if (stable >= SETTLED_POLLS) return screen;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${label}: the running sidebar never settled into ${wanted}\n--- last captured pane ---\n${screen}`,
  );
}

// Drive one headless turn per model, in one session, so the models table has both
// providers to group. Each turn has to reach the local fake, which means the host's
// default plugins and model fetch have to be back on for that process only.
async function runTurns({ base, fake, models, sessionId }) {
  const promptEnv = { ...base };
  delete promptEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS;
  delete promptEnv.OPENCODE_DISABLE_MODELS_FETCH;

  let id = sessionId;
  for (const model of models) {
    const turn = await fakeProvider.runHeadlessPrompt({
      binary: BINARY,
      env: promptEnv,
      cwd: REPO_DIR,
      message: "usage display probe",
      model,
      sessionId: id,
    });
    assert.ok(
      fake.requests.some((request) => request.model === model.split("/")[1]),
      `the host must have called the fake provider for ${model} (requests: ${JSON.stringify(fake.requests)})`,
    );
    id = turn.sessionId;
  }
  return id;
}

test(
  "integrated mode hands Kilo's own panel back on a session with no Go model",
  { skip: SKIP_NO_HOST, timeout: 900000 },
  async () => {
    const tmp = makeConfigDir();
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: { "other-probe": { prompt_tokens: 900_000, completion_tokens: 18_000, total_tokens: 918_000 } },
    });
    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      // Integrated on purpose: this is the mode that retires Kilo's panel, and
      // therefore the only mode in which an empty band is possible.
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";
      writeTuiHostConfig({
        host: "kilo",
        repoDir: REPO_DIR,
        env: base,
        model: OTHER_MODEL,
        provider: fake.configFor(OTHER_PROVIDER),
      });

      const sessionId = await runTurns({ base, fake, models: [OTHER_MODEL] });
      await sleep(750);

      // Wait for Kilo's OWN panel to be settled: its header plus a body row. If the
      // band were empty this would never appear, which is the whole point -- the
      // test cannot pass by finding our panel instead.
      const screen = await bootOrRetry({
        env: base,
        sessionId,
        settled: /Token Usage[\s\S]*\bInput\b[\s\S]*\d/,
        label: "other-model-only",
      });

      assert.match(
        screen,
        /\bToken Usage\b/,
        "a session with no Go model must show Kilo's own token-usage panel, not a hole",
      );
      assert.match(screen, /\bCache rate\b/, "and it must be the real panel, with its rows");
      assert.doesNotMatch(
        screen,
        /\bSession Tokens\b/,
        "our replacement panel must step aside: it is a fork of Kilo's, not an extension of it",
      );
      // Kilo's panel has a `Models (N)` section of its own, so that header alone
      // identifies nothing -- `Session Tokens` is the marker that is unambiguously
      // ours, because integrated mode deliberately does not reuse Kilo's name.
      assert.match(
        screen,
        /\bModels \(1\)/,
        "Kilo's own panel also carries the models table, and it must still be filled in",
      );
      assert.match(screen, /\bprobe-provider\b/, "grouped under the provider that actually ran it");
      console.log(`[e2e] integrated mode deferred to Kilo's own panel (session ${sessionId})`);
    } finally {
      await fake.stop();
      tmp.cleanup();
    }
  },
);

test(
  "integrated mode draws our panel for a session holding Go and other models together",
  { skip: SKIP_NO_HOST, timeout: 900000 },
  async () => {
    const tmp = makeConfigDir();
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: {
        "go-probe": { prompt_tokens: 1_200_000, completion_tokens: 30_000, total_tokens: 1_230_000 },
        "other-probe": { prompt_tokens: 400_000, completion_tokens: 9_000, total_tokens: 409_000 },
      },
    });
    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";
      writeTuiHostConfig({
        host: "kilo",
        repoDir: REPO_DIR,
        env: base,
        model: GO_MODEL,
        provider: { ...fake.configFor(GO_PROVIDER), ...fake.configFor(OTHER_PROVIDER) },
      });

      const sessionId = await runTurns({ base, fake, models: [OTHER_MODEL, GO_MODEL] });
      await sleep(750);

      // Settled on OUR panel, in the order it draws: the `Session Tokens` section,
      // then the `Models (N)` section, then the per-provider groups with the plan
      // meters inside the OpenCode Go one.
      const screen = await bootOrRetry({
        env: base,
        sessionId,
        settled: /Session Tokens[\s\S]*\bModels \(\d+\)[\s\S]*\bGo Plan\b/,
        label: "mixed-providers",
      });

      assert.match(screen, /\bSession Tokens\b/, "a session with a Go model is ours to draw");
      assert.match(screen, /\bGo Plan\b/, "with the plan inside the Models table, where it belongs to its provider");
      assert.match(
        screen,
        /\bModels \(2\)/,
        "both models must be counted, whichever provider they came from",
      );
      assert.match(
        screen,
        /\bgo-probe\b/,
        "the Go model's row must render, carrying its Go share",
      );
      assert.match(
        screen,
        /\bother-probe\b/,
        "and the non-Go model's row must render too: one Go model does not license dropping the rest",
      );
      assert.match(screen, /Go share/, "the Go share belongs to the Go model row only");
      assert.doesNotMatch(
        screen,
        /\bToken Usage\b/,
        "we own this band, so Kilo's own panel must be retired",
      );
      console.log(`[e2e] integrated mode drew our panel for a mixed-provider session (session ${sessionId})`);
    } finally {
      await fake.stop();
      tmp.cleanup();
    }
  },
);

test(
  "integrated mode draws our panel for a session whose only model is a Go model",
  { skip: SKIP_NO_HOST, timeout: 900000 },
  async () => {
    // The rung between the two above: no non-Go model to defer to, and no second
    // provider to group alongside the Go one. It is the shape most sessions
    // actually have -- someone who only ever runs one Go model -- so it belongs
    // here rather than being inferred from the mixed case.
    const tmp = makeConfigDir();
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: {
        "go-probe": { prompt_tokens: 1_200_000, completion_tokens: 30_000, total_tokens: 1_230_000 },
      },
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

      const sessionId = await runTurns({ base, fake, models: [GO_MODEL] });
      await sleep(750);

      const screen = await bootOrRetry({
        env: base,
        sessionId,
        settled: /Session Tokens[\s\S]*\bModels \(\d+\)[\s\S]*\bGo Plan\b/,
        label: "go-model-only",
      });

      assert.match(screen, /\bSession Tokens\b/, "a Go-only session is ours to draw, with nothing to defer to");
      assert.match(screen, /\bGo Plan\b/, "with the plan inside the Models table");
      assert.match(screen, /\bModels \(1\)/, "and the one model it ran");
      assert.match(screen, /Go share/, "carrying its Go share");
      assert.doesNotMatch(screen, /\bToken Usage\b/, "we own this band, so Kilo's own panel must be retired");
      console.log(`[e2e] integrated mode drew our panel for a Go-only session (session ${sessionId})`);
    } finally {
      await fake.stop();
      tmp.cleanup();
    }
  },
);

// The README promises the sidebar "follows the model live: pick a different
// provider and the sidebar follows, with no restart". That promise is only
// falsifiable on a running TUI, so this rung boots ONE session and then changes
// what ran in it from outside the host process:
//
//   start   the session holds only non-Go messages  -> Kilo's panel is on screen
//   + turn  a Go model runs in the same session      -> OUR panel takes the band
//   + turn  a non-Go model runs again                -> Kilo's panel comes back
//
// No restart, no reload, and no tmux keystrokes: the model change is driven from a
// separate `kilo run`, which is also the more honest version of the scenario --
// this is what happens when one host process (a subagent, a background turn, a
// second window) runs a model the sidebar was not expecting.
//
// The assertion that matters is the direction of each handover. Deferring is the
// fix; taking the band BACK is what stops a session from being stuck showing
// Kilo's panel after a Go model has run in it. Both directions mutate the host's
// `sidebar_content` entry list, and both used to cost us our own subtree: the
// band now registers in a free order, so neither can re-key it.
//
// The switch is driven FROM INSIDE the TUI, through the host's own model picker.
// That is not a convenience. Measured on Kilo 7.8.3: when a SEPARATE process
// writes a turn into the session a running TUI is showing, the plugin observes
// nothing at all -- no `message.updated` fires, and `api.state.session.messages`
// keeps returning the pre-existing messages. A plugin has no channel to a foreign
// process's turn, so a test that drives one is testing host behaviour that does
// not exist, and any "fix" aimed at it would be fixing the test. A user switching
// model in the picker is in-process, which is both the real workflow and the only
// one the band can honestly be held to.
test(
  "integrated mode hands the band over and takes it back as the session's models change, live",
  { skip: SKIP_NO_HOST, timeout: 1500000 },
  async () => {
    const tmp = makeConfigDir();
    // TWO fakes, one model each. `configFor` registers every model it knows under
    // whichever provider id you ask for, so one fake serving both models would also
    // list `other-probe` under `opencode-go` -- and a picker filter matching that
    // name would select the GO model, quietly turning this into "the band never
    // moved" while every assertion still passed.
    const fake = await fakeProvider.startFakeChatProvider({
      usageByModel: { "go-probe": { prompt_tokens: 1_200_000, completion_tokens: 30_000, total_tokens: 1_230_000 } },
    });
    const fakeOther = await fakeProvider.startFakeChatProvider({
      usageByModel: { "other-probe": { prompt_tokens: 400_000, completion_tokens: 9_000, total_tokens: 409_000 } },
    });
    try {
      const base = makeTuiEnv({ root: tmp.root, live: false, host: "kilo" });
      base.KILO_OC_GO_SIDEBAR_MODE = "integrated";
      writeTuiHostConfig({
        host: "kilo",
        repoDir: REPO_DIR,
        env: base,
        model: GO_MODEL,
        provider: { ...fake.configFor(GO_PROVIDER), ...fakeOther.configFor(OTHER_PROVIDER) },
      });

      // The session is pre-created with a Go turn so the TUI boots already holding
      // the band; typing a first prompt into the HOME screen is swallowed often
      // enough to be useless as a test step. What must happen IN-PROCESS is the
      // model switch, which is what the picker does.
      const promptEnv = { ...base };
      delete promptEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      delete promptEnv.OPENCODE_DISABLE_MODELS_FETCH;
      const first = await fakeProvider.runHeadlessPrompt({
        binary: BINARY,
        env: promptEnv,
        cwd: REPO_DIR,
        message: "usage probe",
        model: GO_MODEL,
      });
      await sleep(750);

      const tui = new TuiSession({
        binary: BINARY,
        args: ["--session", first.sessionId],
        env: base,
        cwd: REPO_DIR,
        label: `band-live-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
      });
      try {
        tui.start();

        const KILO_PANEL = /Token Usage[\s\S]*\bInput\b[\s\S]*\d/;
        const OUR_PANEL = /Session Tokens[\s\S]*\bModels \(\d+\)[\s\S]*\bGo Plan\b/;

        // 1. The session has run a Go model, so the band is ours from boot.
        const taken = await waitForPane(tui, OUR_PANEL, "live/boot-on-go");
        assert.doesNotMatch(taken, /\bToken Usage\b/, "while we hold the band the host panel must be gone");

        // 2. Switch to a non-Go model IN THE TUI and run a turn. The newest message
        //    is then not a Go one, so the band has to go back to Kilo.
        await pickModel(tui, OTHER_MODEL, { provider: OTHER_PROVIDER });
        await sendTurn(tui, "usage probe");
        const handedBack = await waitForPane(tui, KILO_PANEL, "live/after-other-turn");
        assert.doesNotMatch(
          handedBack,
          /\bSession Tokens\b/,
          "the band must be handed back, not left holding a session we no longer serve",
        );

        // 3. And back to Go again, still without a restart: the direction that used
        //    to empty the band is the one that has to keep working.
        await pickModel(tui, GO_MODEL, { provider: GO_PROVIDER });
        await sendTurn(tui, "usage probe");
        const retaken = await waitForPane(tui, OUR_PANEL, "live/after-second-go-turn");
        assert.doesNotMatch(retaken, /\bToken Usage\b/, "and we must be able to take it back");

        console.log("[e2e] the band changed hands twice in one session, with no restart");
      } finally {
        tui.stop();
      }
    } finally {
      await fake.stop();
      await fakeOther.stop();
      tmp.cleanup();
    }
  },
);
