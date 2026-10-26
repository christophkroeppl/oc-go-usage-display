// E2E tier: the REAL opencode v2 TUI must display Go usage.
//
// v2 differs from v1 in every input to this test:
//   * the binary is `opencode-v2`;
//   * plugins are discovered as a package directory under
//     `<OPENCODE_CONFIG_DIR>/plugins/<name>/` (`index.ts` + `tui.ts`), not
//     named from `tui.json`/`opencode.jsonc`;
//   * the slot surface paints once at mount and never repaints on a signal,
//     so the panel paints by remounting (see src/v2/tui.tsx);
//   * a session exists only after the first prompt, and the slot input carries
//     that session id -- the sidebar is deliberately absent on the home screen;
//   * the TUI runs `--standalone` (a private server), because the shared
//     background service binds one fixed port per config root and a second TUI
//     in the same container would find it taken.
//
// The plugin is installed through the real `oc-go-usage-display-init` CLI, so
// this exercises the discovery layout the installer writes, not a hand-built
// fixture. Usage is mocked (`OPENCODE_OC_GO_MOCK=1`); the `opencode-go`
// provider points at a closed local port, so the probe message fails fast and
// never reaches a network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpencodeV2Binary } from "../helpers/opencode-v2.js";
import { makeConfigDir } from "../helpers/tmp.js";
import { hasTmux, makeTuiEnv, settleScreen, TuiSession } from "../helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = findOpencodeV2Binary();
const SKIP =
  BINARY === null
    ? "opencode-v2 binary not found on PATH (run inside the container image)"
    : hasTmux()
      ? false
      : "tmux not available (run inside the container image)";

const MOCK_STATUSLINE = /Go 5h 42% \| 7d 15% \| 30d 61% · resets in 2h5m/;
const MOCK_SIDEBAR = /Go Usage[\s\S]*5h resets in 2h5m[\s\S]*\b5h\b[\s\S]*42%[\s\S]*\b7d\b[\s\S]*15%[\s\S]*\b30d\b[\s\S]*61%[\s\S]*Top Go models/;
const PROMPT_READY = /Ask anything/;
const CONNECT_DIALOG = /Connect an integration/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The probe's only job is to create a session, and v2 creates one before it
// asks the provider for an answer. The provider points at a closed port, so
// that request fails and v2 raises a modal "Connect an integration" panel that
// covers both slots. It can land before or after the plugin's first paint, so
// Escape cancels the request and the wait keeps polling; a paint that only
// counts before the modal opens would be a race, not a display.
async function waitForPainted(session, matcher, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastEscape = 0;
  while (Date.now() < deadline) {
    const pane = session.capture();
    if (matcher(pane)) {
      await sleep(500);
      const confirm = session.capture();
      if (matcher(confirm)) return confirm;
      continue;
    }
    if (CONNECT_DIALOG.test(pane) && Date.now() - lastEscape > 2000) {
      session.sendKeys("Escape");
      lastEscape = Date.now();
    }
    await sleep(500);
  }
  return null;
}

function writeHostConfig(configDir) {
  const filePath = path.join(configDir, "opencode.jsonc");
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  const config = {
    ...existing,
    provider: {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCode Go",
        options: { baseURL: "http://127.0.0.1:9/v1" },
        models: { test: { name: "Go Test" } },
      },
    },
    model: "opencode-go/test",
  };
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

test("opencode-v2 TUI displays the mock usage in sidebar and statusline", { skip: SKIP, timeout: 420000 }, async (t) => {
  const tmp = makeConfigDir();
  t.after(() => tmp.cleanup());

  const env = makeTuiEnv({ root: tmp.root, live: false, host: "opencode" });
  const install = spawnSync(
    process.execPath,
    [
      path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js"),
      "--target", "opencode-v2",
      "--repo", REPO_DIR,
      "--config-dir", tmp.configDir,
      "--copy",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(install.status, 0, `init failed:\n${install.stderr}`);
  assert.equal(
    fs.existsSync(path.join(tmp.configDir, "plugins", "oc-go-usage-display", "index.ts")),
    true,
    "init must deploy the discovered server half",
  );
  assert.equal(
    fs.existsSync(path.join(tmp.configDir, "plugins", "oc-go-usage-display", "tui.ts")),
    true,
    "init must deploy the discovered TUI half",
  );
  writeHostConfig(tmp.configDir);

  // A private server, not the shared background service: two TUIs in one
  // container would otherwise race for the service's fixed port, and the first
  // test's daemon would still hold it when the second boots.
  const session = new TuiSession({ binary: BINARY, args: ["--standalone"], env, cwd: REPO_DIR, label: "tui-v2" });
  t.after(() => session.stop());
  session.start();

  const ready = await settleScreen(session, PROMPT_READY, { timeoutMs: 180000 });
  assert.ok(ready, `v2 TUI did not reach the prompt\n--- last pane ---\n${session.capture()}`);

  // The first submitted prompt is what creates the session whose id the slot
  // input carries; without it the plugin correctly paints nothing.
  session.sendKeys("usage-display-probe", "Enter");

  const screen = await waitForPainted(
    session,
    (pane) => MOCK_STATUSLINE.test(pane) && MOCK_SIDEBAR.test(pane),
  );
  assert.ok(
    screen,
    `v2 TUI did not render both usage surfaces\n--- last pane ---\n${session.capture()}`,
  );

  assert.match(screen, MOCK_SIDEBAR, "sidebar must render the plan rows and model section");
  assert.match(screen, /No model usage yet/, "the probe session has no assistant messages");
  assert.match(screen, MOCK_STATUSLINE, "statusline must render the mock usage line");
});

test("opencode-v2 TUI paints the sidebar again after the usage tick remounts it", { skip: SKIP, timeout: 420000 }, async (t) => {
  const tmp = makeConfigDir();
  t.after(() => tmp.cleanup());

  const env = makeTuiEnv({ root: tmp.root, live: false, host: "opencode" });
  const install = spawnSync(
    process.execPath,
    [
      path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js"),
      "--target", "opencode-v2",
      "--repo", REPO_DIR,
      "--config-dir", tmp.configDir,
      "--copy",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(install.status, 0, `init failed:\n${install.stderr}`);
  writeHostConfig(tmp.configDir);

  const session = new TuiSession({
    binary: BINARY,
    args: ["--standalone"],
    env,
    cwd: REPO_DIR,
    label: "tui-v2-tick",
  });
  t.after(() => session.stop());
  session.start();

  const ready = await settleScreen(session, PROMPT_READY, { timeoutMs: 180000 });
  assert.ok(ready, `v2 TUI did not reach the prompt\n--- last pane ---\n${session.capture()}`);
  session.sendKeys("usage-display-probe", "Enter");

  const first = await waitForPainted(
    session,
    (pane) => MOCK_STATUSLINE.test(pane) && /Go Usage/.test(pane),
  );
  assert.ok(first, `first paint did not land\n--- last pane ---\n${session.capture()}`);

  // TICK_MS is 30s: a remount happens on the first tick after mount. Wait one
  // whole tick and require the block to still be there, once (not twice).
  await sleep(35000);
  const after = await waitForPainted(session, (pane) => /Go Usage/.test(pane), { timeoutMs: 30000 });
  assert.ok(after, `sidebar disappeared after a usage tick\n--- last pane ---\n${session.capture()}`);
  assert.equal((after.match(/Go Usage/g) ?? []).length, 1, "the remount must leave exactly one sidebar block");
  assert.match(after, MOCK_STATUSLINE, "statusline must survive the remount");
});
