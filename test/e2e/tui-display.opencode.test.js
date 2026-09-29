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
// The usage itself is always mocked (OPENCODE_OC_GO_MOCK=1): this tier asserts
// LAYOUT, and the live payload's shape is the unit tier's single API call
// (test/unit/live-usage.test.js). Nothing here needs a key, so the container
// gate needs no secret at all. The `opencode-go` model is picked dynamically
// from the host's own catalog (see test/helpers/tui.js) so renamed/retired
// models cannot cause false negatives. Requires the opencode binary and tmux
// (the container image has both); skips cleanly on a host without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpencodeBinary } from "../helpers/opencode.js";
// Namespace import on purpose: with a named one, bun 1.4.2's test runner fails to
// LINK this module from this file ("Export named 'runFakeChatProvider' not
// found") -- a narrower import list in a file this size links fine, `bun -e` and
// `node --test` load it fine, and a namespace import links everywhere. The
// failure is content-dependent and reproducible, so this is the one shape that
// survives it. Do not "tidy" it into named imports without re-running this file.
import * as fakeProvider from "../helpers/fake-provider.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  assertSidebarOrder,
  hasTmux,
  hostVersionSkipReason,
  makeTuiEnv,
  runTuiDisplay,
  writeTuiHostConfig,
} from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findOpencodeBinary();
const SKIP_NO_HOST =
  hostVersionSkipReason({ host: "opencode", binary: BINARY, repoDir: REPO_DIR }) ||
  (hasTmux() ? false : "tmux not available (run inside the container image)");

const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61%/;
// The whole sidebar block, so the capture cannot land between the header and
// the rows: the model section is what proves the block finished rendering.
const MOCK_SIDEBAR_SETTLED = /Go Usage[\s\S]*Top Go models/;
const METER_CELL = "\u2588";
// Column of the first meter glyph on each plan row, and the column its percent
// ends in. Derived from the captured pane, so they are the host's real layout.
const PLAN_ROW = /^\s*(?:5h|7d|30d)\s+[\u2588\u2591]+\s+\d+%\s*$/;
const meterColumns = (screen) => planRows(screen).map((line) => line.search(/[\u2588\u2591]/));
const percentColumns = (screen) => planRows(screen).map((line) => line.search(/\d+%\s*$/));
const planRows = (screen) => screen.split("\n").filter((line) => PLAN_ROW.test(line));

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
      assert.match(screen, /5h\s+[\u2588\u2591]+\s+42%/, "sidebar must render the rolling meter");
      assert.match(screen, /7d\s+[\u2588\u2591]+\s+15%/, "sidebar must render the weekly meter");
      assert.match(screen, /30d\s+[\u2588\u2591]+\s+61%/, "sidebar must render the monthly meter");
      assert.ok(screen.includes(METER_CELL), "the plan must render as a block meter, not a bare percent");
      // The three meters stack: same left edge, one percent column. Pinning the
      // column is what stops a regression back to a label-sized offset, which is
      // what a screenshot complaint like "they do not line up" actually is.
      const bars = meterColumns(screen);
      const percents = percentColumns(screen);
      assert.equal(bars.length, 3, "the plan must render three stacked meters");
      assert.ok(
        bars.every((column) => column === bars[0]),
        `all three plan meters must start in the same column (got ${bars.join(", ")})`,
      );
      assert.ok(
        percents.every((column) => column === percents[0]),
        `all three plan percents must end in the same column (got ${percents.join(", ")})`,
      );
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

// The model MIX, end to end, with real token accounting and no tokens spent.
//
// The plan is mocked, but a model's weight is a fold over the host's own message
// store: a row cannot be asserted unless the session holds assistant messages,
// and a session gets those only by talking to a provider. So this test points
// the real `opencode-go` provider at a local SSE endpoint
// (test/helpers/fake-provider.js) and lets the host write the assistant messages
// itself. The host's pipeline then produces the tokens, the cost and the model
// ids the panel reads; the plugin's arithmetic is the only thing left unstubbed,
// and that is the readonly unit tier's job.
//
// Asserted on the COLLAPSED section: the expanded rows sit behind a disclosure
// click, and a tmux key stream is not a mouse. The collapsed line still carries
// the whole ranking -- order, shares, short names, budget -- so this is the
// assertion that fails if the fold, the weights or the names are wrong.
test(
  "opencode TUI weights the session models by their share of Go tokens",
  { skip: SKIP_NO_HOST, timeout: 600000 },
  async () => {
    // 1.51M against 651k, so the expected split is far from even and an ordering
    // mistake could not produce the right numbers by accident. The host also
    // runs a cheap title turn per model, which lands in the same session and the
    // same weight -- hence relations, not exact percentages.
    //
    // The ids are invented on purpose (and their first segments differ, because
    // that is what the collapsed mix line shows): a real `opencode-go` model id also exists
    // in the host's own catalog, and the host would then resolve THAT entry --
    // real endpoint, dummy key, no request to the fake -- which fails quietly as
    // a session with an error in it. An id only this config declares can only go
    // where the config points it.
    const usageByModel = {
      "alpha-heavy": { prompt_tokens: 1_420_000, completion_tokens: 88_000, total_tokens: 1_508_000 },
      "beta-light": { prompt_tokens: 610_000, completion_tokens: 41_000, total_tokens: 651_000 },
    };
    const tmp = makeConfigDir();
    // Called off the namespace, never destructured: bun 1.4.2 elides a
    // `const { x } = ns` statement in this file shape and the reference then
    // fails at run time (a bare "x is not defined", which reads like a typo).
    const fake = await fakeProvider.startFakeChatProvider({ usageByModel });
    try {
      const env = makeTuiEnv({ root: tmp.root, live: false, host: "opencode" });
      // The load env turns off the host's built-in plugins and its model fetch
      // to keep the plugin load checks fast and hermetic. A custom provider
      // needs both: the built-ins resolve and install its AI SDK package, and a
      // provider is registered through the model catalog. Without them the model
      // call fails as a bare "Unexpected server error" with nothing arriving at
      // the fake endpoint -- so the headless turns get them back. The TUI boot
      // below does not need either: it only reads an existing session.
      const promptEnv = { ...env };
      delete promptEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      delete promptEnv.OPENCODE_DISABLE_MODELS_FETCH;
      const heavy = "opencode-go/alpha-heavy";
      const light = "opencode-go/beta-light";
      // The host config has to exist BEFORE the headless turns, not just before
      // the TUI boot: it is the config that points the provider at the fake
      // endpoint, and a model it does not know fails as a server error with
      // nothing ever reaching the fake. `runTuiDisplay` writes the same config
      // again below; identical input, so the rewrite is a no-op.
      writeTuiHostConfig({
        host: "opencode",
        repoDir: REPO_DIR,
        env,
        model: heavy,
        provider: fake.configFor("opencode-go"),
      });
      const first = await fakeProvider.runHeadlessPrompt({
        binary: BINARY,
        env: promptEnv,
        cwd: REPO_DIR,
        message: "usage display probe",
        model: heavy,
      });
      const second = await fakeProvider.runHeadlessPrompt({
        binary: BINARY,
        env: promptEnv,
        cwd: REPO_DIR,
        message: "and once more",
        model: light,
        sessionId: first.sessionId,
      });
      assert.equal(second.sessionId, first.sessionId, "both turns must land in one session");
      for (const model of ["alpha-heavy", "beta-light"]) {
        const calls = fake.requests.filter((request) => request.model === model).length;
        // The host's own output is the diagnostic when this fails: a model it
        // could not resolve, or a config it rejected, looks exactly like silence.
        assert.ok(
          calls > 0,
          `the host must have called the fake provider for ${model} (requests: ${JSON.stringify(fake.requests)})\n` +
            `--- opencode run output ---\n${first.output.slice(-1200)}`,
        );
      }

      const { screen } = await runTuiDisplay({
        host: "opencode",
        binary: BINARY,
        repoDir: REPO_DIR,
        env,
        model: heavy,
        provider: fake.configFor("opencode-go"),
        sessionId: first.sessionId,
        expect: { statusline: MOCK_STATUSLINE, sidebar: /Top Go models \(2\)/ },
      });

      const mix = /alpha[^\n]*?(\d+)%[^\n]*?beta[^\n]*?(\d+)%/.exec(screen);
      assert.ok(mix, `the collapsed mix line must name both models with their share (screen had none)`);
      const heavyShare = Number(mix[1]);
      const lightShare = Number(mix[2]);
      assert.ok(heavyShare > lightShare, `the heavier model must rank first (${heavyShare}% vs ${lightShare}%)`);
      assert.ok(lightShare > 0, "a model with tokens must not read as 0%");
      assert.ok(heavyShare < 100, "the other model's tokens must be counted too");
      console.log(`[e2e] opencode TUI model mix rendered (${heavyShare}% / ${lightShare}%)`);
    } finally {
      await fake.stop();
      tmp.cleanup();
    }
  },
);
