// Shared tmux/TUI harness for the e2e display tests.
//
// Boots the real opencode/kilo TUI inside a detached tmux session, captures
// the rendered pane as plain text, and waits for the usage surfaces to appear.
// The flow validated against both hosts:
//
//   1. pick an available `opencode-go` model from the host's own catalog
//      (`<binary> models opencode-go`) — model names change, so nothing is
//      hardcoded;
//   2. create a session through the host's HTTP API with a `noReply` message
//      carrying that model (no LLM call is made);
//   3. boot the TUI with `--session <id>` and a config-file `model`, which
//      satisfies the plugin's provider gate without any session event;
//   4. poll `tmux capture-pane -p` for the statusline and sidebar text.
//
// Every caller passes an env produced by test/helpers/run.js, so HOME/XDG and
// the tmux socket all live inside a tmp root.

import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { goApiKeyFromEnv, isolatedEnv } from "./run.js";
import { OPENCODE_LOAD_ENV } from "./opencode.js";

export const TUI_COLS = 200;
export const TUI_ROWS = 50;

// Fake provider key: models.dev providers only appear in `<binary> models`
// when their env key is present, and the real provider is never called (the
// session's only message is `noReply`).
const DUMMY_PROVIDER_KEY = "dummy-opencode-provider-key";

const SERVE_SENTINEL = /server listening on (http:\/\/[0-9.]+:[0-9]+)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Neutral skip that works under both `node --test` and `bun test`.
export function skipWithNotice(t, message) {
  if (typeof t.skip === "function") {
    t.skip(message);
    return;
  }
  console.log(`skipped: ${message}`);
}

// Hermetic TUI env: HOME/XDG/config/tmp/tmux all under `root`, deterministic
// mock by default, provider catalog key present (dummy), credentials stripped.
// `live` removes the mock and admits OPENCODE_OC_GO_API_KEY when the caller has it.
export function makeTuiEnv({ root, live = false, host = "opencode" }) {
  const overrides = {
    ...OPENCODE_LOAD_ENV,
    TMPDIR: path.join(root, "tmp"),
    TMUX_TMPDIR: path.join(root, "tmux"),
    TERM: "xterm-256color",
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || DUMMY_PROVIDER_KEY,
  };
  if (live) {
    delete overrides.OPENCODE_OC_GO_MOCK;
    delete overrides.KILO_OC_GO_MOCK;
    // Re-admit the key under the prefix the child host actually reads.
    const goKey = goApiKeyFromEnv();
    if (goKey.value) overrides[`${host === "kilo" ? "KILO" : "OPENCODE"}_OC_GO_API_KEY`] = goKey.value;
  }
  const env = isolatedEnv(root, overrides, {
    allowSecrets: live
      ? ["OPENCODE_API_KEY", "OPENCODE_OC_GO_API_KEY", "KILO_OC_GO_API_KEY", "OPENCODE_GO_API_KEY"]
      : ["OPENCODE_API_KEY"],
  });
  if (live) {
    delete env.OPENCODE_OC_GO_MOCK;
    delete env.KILO_OC_GO_MOCK;
  }
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  fs.mkdirSync(env.TMUX_TMPDIR, { recursive: true });
  return env;
}

export function hasTmux() {
  return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}

// First semantic version printed by `<binary> --version` (e.g. "7.7.5").
export function binaryVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout ?? ""} ${result.stderr ?? ""}`);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function versionAtLeast(actual, minimum) {
  if (typeof actual !== "string" || typeof minimum !== "string") return false;
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = [parse(actual), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// Host versions the container image is pinned to (Dockerfile ARGs). The TUI
// e2e tier is authoritative inside that image; an older host binary may not
// support TUI plugins at all, so the tests skip instead of failing.
export function pinnedHostVersions(repoDir) {
  const dockerfile = fs.readFileSync(path.join(repoDir, "Dockerfile"), "utf8");
  const read = (name) => new RegExp(`^ARG\\s+${name}=(.+)$`, "m").exec(dockerfile)?.[1]?.trim() ?? null;
  return { opencode: read("OPENCODE_VERSION"), kilo: read("KILO_VERSION") };
}

// Shared skip reason for a host whose binary is older than the image pin.
export function hostVersionSkipReason({ host, binary, repoDir }) {
  if (binary === null) return `${host} binary not found on PATH (run inside the container image)`;
  const pinned = pinnedHostVersions(repoDir)[host];
  const actual = binaryVersion(binary);
  if (pinned !== null && !versionAtLeast(actual, pinned)) {
    return `${host} ${actual ?? "unknown"} is older than the pinned ${pinned}; run inside the container image`;
  }
  return false;
}

// List the models the host itself reports for `provider` (e.g. "opencode-go").
// An empty list usually means the provider is not configured in this env; the
// tests surface that loudly instead of guessing a model name.
export function listProviderModels(binary, provider, { env, cwd }) {
  const result = spawnSync(binary, ["models", provider], { encoding: "utf8", env, cwd });
  const lines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${provider}/`) && !/\s/.test(line));
  if (result.status !== 0 && lines.length === 0) {
    throw new Error(`${binary} models ${provider} exited ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return [...new Set(lines)];
}

// Free models first (they are the credential-free path); never hardcode a name.
export function pickProviderModel(models, { preferFree = true } = {}) {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (preferFree) {
    const free = models.find((model) => /free/i.test(model));
    if (free !== undefined) return free;
  }
  return models[0];
}

// Spawn `<binary> serve`, wait for the listening sentinel, and return the URL
// plus a stop handle. The caller creates the session, then must stop it.
// 60s for the same reason as the Kilo helper: the first boot of a pinned host in
// a fresh container does real work before it listens, and a slow boot must cost
// seconds rather than a flaky red.
export async function startHostServer({ binary, env, cwd, timeoutMs = 60000 }) {
  const child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError = null;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("error", (error) => (spawnError = error));

  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      stop();
      throw spawnError;
    }
    const match = SERVE_SENTINEL.exec(output);
    if (match) return { url: match[1], stop };
    if (child.exitCode !== null) {
      stop();
      throw new Error(`${binary} serve exited early (code ${child.exitCode}):\n${output}`);
    }
    await sleep(250);
  }
  stop();
  throw new Error(`${binary} serve did not report a listening URL within ${timeoutMs}ms:\n${output}`);
}

// Create a session and pin its model via a `noReply` user message: the session
// carries the provider/model for the TUI without ever calling the model.
export async function createSessionWithModel({ url, directory, model, title }) {
  const headers = { "content-type": "application/json", "x-opencode-directory": directory };
  const created = await fetch(`${url}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title }),
  });
  if (!created.ok) throw new Error(`session create failed: HTTP ${created.status}`);
  const session = await created.json();
  const [providerID, ...rest] = String(model).split("/");
  const modelID = rest.join("/");
  const prompted = await fetch(`${url}/session/${session.id}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: { providerID, modelID },
      noReply: true,
      parts: [{ type: "text", text: "usage display probe" }],
    }),
  });
  if (!prompted.ok) throw new Error(`noReply message failed: HTTP ${prompted.status}`);
  return session.id;
}

// Write the host's two config files:
//   opencode: $OPENCODE_CONFIG_DIR/{opencode.json,tui.json}
//   kilo:     $XDG_CONFIG_HOME/kilo/{kilo.json,tui.json}
// Kilo rejects `sidebar`/`statusline` keys in tui.json (invalidates the whole
// file, so the plugin never loads), and the surface defaults are both on.
//
// For kilo the bundles are copied into `<configDir>/plugins/` and referenced by
// absolute path, exactly like `oc-go-usage-display-init --target kilo` (Kilo
// does not resolve `./...` against its config dir), so the e2e proves the
// deployed copy resolves the host-provided solid-js/@opentui modules.
export function writeTuiHostConfig({ host, repoDir, env, model, provider }) {
  const configDir = host === "kilo" ? path.join(env.XDG_CONFIG_HOME, "kilo") : env.OPENCODE_CONFIG_DIR;
  fs.mkdirSync(configDir, { recursive: true });
  let serverSpec;
  let tuiSpec;
  if (host === "kilo") {
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.kilo.ts", "oc-go-usage-display.kilo.tsx"]) {
      fs.copyFileSync(path.join(repoDir, "dist", "plugins", fileName), path.join(pluginsDir, fileName));
    }
    serverSpec = path.join(pluginsDir, "oc-go-usage-display.kilo.ts");
    tuiSpec = path.join(pluginsDir, "oc-go-usage-display.kilo.tsx");
  } else {
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.ts", "oc-go-usage-display.tsx"]) {
      fs.copyFileSync(path.join(repoDir, "dist", "plugins", fileName), path.join(pluginsDir, fileName));
    }
    serverSpec = "./plugins/oc-go-usage-display.ts";
    tuiSpec = "./plugins/oc-go-usage-display.tsx";
  }
  // `provider` replaces one entry of the host's own catalog, which is how a test
  // points a REAL provider id at a local endpoint (test/helpers/fake-provider.js).
  // The id has to stay `opencode-go`: that is what the plugin's Go gate keys on.
  const hostConfig = { $schema: "https://opencode.ai/config.json", model, plugin: [serverSpec] };
  if (provider !== undefined) hostConfig.provider = provider;
  fs.writeFileSync(
    path.join(configDir, host === "kilo" ? "kilo.json" : "opencode.json"),
    `${JSON.stringify(hostConfig, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(configDir, "tui.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "opencode", plugin: [tuiSpec] }, null, 2)}\n`,
  );
  return configDir;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// A detached tmux session running one TUI, with plain-text pane capture.
export class TuiSession {
  constructor({ binary, args, env, cwd, label, cols = TUI_COLS, rows = TUI_ROWS }) {
    this.binary = binary;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.label = label;
    this.cols = cols;
    this.rows = rows;
    this.name = "tui";
    this.started = false;
  }

  tmux(...args) {
    return spawnSync("tmux", ["-L", this.label, ...args], { encoding: "utf8", env: this.env, cwd: this.cwd });
  }

  start() {
    this.tmux("kill-server");
    const command = `${[this.binary, ...this.args].map(shellQuote).join(" ")}; echo "[tui exited code $?]"; sleep 6000`;
    const result = this.tmux(
      "new-session",
      "-d",
      "-s",
      this.name,
      "-x",
      String(this.cols),
      "-y",
      String(this.rows),
      command,
    );
    if (result.status !== 0) {
      throw new Error(`tmux new-session failed: ${result.stderr || result.stdout}`);
    }
    this.started = true;
  }

  capture() {
    return this.tmux("capture-pane", "-p", "-t", this.name).stdout ?? "";
  }

  // The same pane with SGR color escapes intact, for rendering a real screenshot
  // instead of guessing the theme's colors (scripts/capture-shots.mjs).
  captureAnsi() {
    return this.tmux("capture-pane", "-e", "-p", "-t", this.name).stdout ?? "";
  }

  sendKeys(...keys) {
    this.tmux("send-keys", "-t", this.name, ...keys);
  }

  stop() {
    if (!this.started) return;
    this.tmux("kill-server");
    this.started = false;
  }
}

// Poll the pane until the statusline and sidebar patterns both match. If the
// host sidebar is not visible, toggle it (ctrl+x b) and retry: the key can be
// swallowed while the TUI is still settling, so toggling is attempted
// repeatedly until the sidebar appears (or the deadline passes). On timeout,
// throw with the last captured screen.
export async function waitForUsageSurfaces(
  session,
  { statusline, sidebar, timeoutMs = 150000, intervalMs = 500, toggleGraceMs = 10000, maxToggleAttempts = 8 },
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const hostSidebar = /Context|Token Usage/;
  let toggleAttempts = 0;
  let screen = "";
  while (Date.now() < deadline) {
    screen = session.capture();
    if (statusline.test(screen) && sidebar.test(screen)) return screen;
    const sidebarVisible = hostSidebar.test(screen) || sidebar.test(screen);
    if (!sidebarVisible && Date.now() - startedAt > toggleGraceMs && toggleAttempts < maxToggleAttempts) {
      session.sendKeys("C-x", "b");
      toggleAttempts += 1;
      await sleep(2500);
      continue;
    }
    await sleep(intervalMs);
  }
  const missing = [];
  if (!statusline.test(screen)) missing.push(`statusline ${statusline}`);
  if (!sidebar.test(screen)) missing.push(`sidebar ${sidebar}`);
  throw new Error(
    `TUI did not render expected usage surfaces within ${timeoutMs}ms (missing: ${missing.join(", ")})` +
      `\n--- last captured pane ---\n${screen}`,
  );
}

// First rendered line index (0-based) matching `pattern`, or -1. The e2e
// sessions use a fixed title, so the host sidebar headers are unique in the
// captured pane and their line order is the order the host actually rendered.
// ---------------------------------------------------------------------------
// Driving a LIVE TUI (dynamic tier)
// ---------------------------------------------------------------------------
//
// Everything above asserts how a pane looks after boot. These drive the pane
// while it runs -- invoke a command, fold a surface, switch a mode -- because a
// control can persist its new state and still repaint nothing, and only a real
// renderer can tell those two apart. The e2e display tier cannot: it reads a
// frame the host produced on its own.
//
// Commands are invoked as SLASH COMMANDS rather than through the command palette,
// because on the pinned hosts the palette never lists a plugin command (measured:
// `api.command.register` and `api.keymap.registerLayer` are both accepted and
// neither throws, and neither entry appears in ctrl+P; the same command with a
// `slashName` appears in the prompt's `/` list).

// A predicate or a RegExp, and `stable` consecutive agreeing frames before we
// believe it. Both hosts repaint in passes, so one matching frame is often one
// about to be replaced -- and a surface that has just been folded needs to be
// ABSENT, which only a predicate can say.
export async function settleScreen(session, match, { timeoutMs = 60000, stable = 2, intervalMs = 500 } = {}) {
  const hit =
    typeof match === "function"
      ? (screen) => match(screen) === true
      : typeof match === "string"
        ? (screen) => screen.includes(match)
        : (screen) => match.test(screen);
  const deadline = Date.now() + timeoutMs;
  let agreeing = 0;
  let screen = "";
  while (Date.now() < deadline) {
    screen = session.capture();
    if (hit(screen)) {
      agreeing += 1;
      if (agreeing >= stable) return screen;
    } else {
      agreeing = 0;
    }
    await sleep(intervalMs);
  }
  // Accept a correct FINAL frame: a pane that settled late is not a failure, and
  // requiring N consecutive hits turns a slow repaint into a false red.
  return hit(screen) ? screen : null;
}

// Kilo swallows ctrl+P (and the prompt) while a turn is running, so every
// interaction waits for idle. Kilo shows "esc interrupt" while working; a host
// that shows nothing here passes on the first clean frame.
export async function waitForIdle(session, { timeoutMs = 90000, stable = 3, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let agreeing = 0;
  while (Date.now() < deadline) {
    agreeing = /esc interrupt/i.test(session.capture()) ? 0 : agreeing + 1;
    if (agreeing >= stable) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Type `/<name>` and read the autocomplete, then clear the line. Answers "is this
// command offered, and what does it say it will do" without running anything.
export async function readSlashCommand(session, name, { timeoutMs = 20000 } = {}) {
  await waitForIdle(session);
  session.sendKeys(`/${name}`);
  const screen = await settleScreen(session, `/${name}`, { timeoutMs, stable: 1 });
  session.sendKeys("C-u");
  session.sendKeys("Escape");
  await sleep(800);
  return screen ?? session.capture();
}

// Type `/<name>` and press Enter, then settle on whatever the caller expects.
// `expect` is what makes this a behavioural assertion rather than a keystroke:
// the caller says what the pane should look like AFTER the command ran.
export async function runSlashCommand(session, name, expect, { timeoutMs = 60000 } = {}) {
  const offered = await readSlashCommand(session, name, { timeoutMs: 20000 });
  if (!offered.includes(`/${name}`)) {
    throw new Error(`/${name} was never offered by the host\n--- pane ---\n${offered}`);
  }
  await waitForIdle(session);
  session.sendKeys(`/${name}`);
  await settleScreen(session, `/${name}`, { timeoutMs: 20000, stable: 1 });
  session.sendKeys("Enter");
  await sleep(1200);
  return settleScreen(session, expect, { timeoutMs });
}

// Type a prompt into the TUI and submit it, then wait for idle. This is the
// IN-PROCESS path: the turn is created by the same host the TUI is running, which
// is the only way a running TUI can observe a model change (see the live band
// rung). Typing needs the prompt to have focus, so we wait for the home screen or
// a settled pane first rather than firing keystrokes at a booting TUI.
export async function sendTurn(session, message, { timeoutMs = 120000 } = {}) {
  await waitForIdle(session);
  // Keystrokes sent while the TUI is still booting are swallowed, which looks
  // exactly like "the model was never asked anything". The typed text appears in
  // the prompt box, so waiting for IT to appear is what proves the prompt had
  // focus -- sending it and hoping is how this test silently stops testing.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    session.sendKeys(message);
    if (await settleScreen(session, message, { timeoutMs: 10000, stable: 1 })) break;
    await waitForIdle(session);
    await sleep(1000);
    if (attempt === 2) {
      throw new Error(`the prompt never received "${message}"\n--- pane ---\n${session.capture()}`);
    }
  }
  session.sendKeys("Enter");
  await sleep(1500);
  await waitForIdle(session, { timeoutMs });
  return session.capture();
}

// Switch model through the host's OWN picker (ctrl+x m), which is how a user does
// it. The list is filtered by typing, so we type the model id and press Enter.
// Returns the pane after selection so the caller can assert which model is live --
// picking the wrong row silently would make every later assertion meaningless.
export async function pickModel(session, modelId, { provider, timeoutMs = 60000 } = {}) {
  // Filter by the bare MODEL NAME: the picker rejects a provider-qualified filter
  // ("/" finds nothing). Uniqueness is the caller's job -- give each provider its
  // own single-model catalog -- and `provider` is asserted afterwards so a filter
  // that quietly matched the wrong row cannot pass.
  const modelName = modelId.split("/").pop();
  const providerName = provider ?? modelId.split("/")[0];
  await waitForIdle(session);
  session.sendKeys("C-x", "m");
  const picker = await settleScreen(session, /model/i, { timeoutMs, stable: 1 });
  if (picker === null) throw new Error(`the model picker never opened\n--- pane ---\n${session.capture()}`);
  session.sendKeys(modelName);
  await settleScreen(session, new RegExp(modelName), { timeoutMs: 20000, stable: 1 });
  session.sendKeys("Enter");
  await sleep(1500);
  await waitForIdle(session);
  const after = session.capture();
  if (!after.includes(modelName)) {
    throw new Error(`picked "${modelId}" but the pane does not name it\n--- pane ---\n${after}`);
  }
  if (!after.includes(providerName)) {
    throw new Error(
      `picked "${modelName}" but the pane reports provider "${providerName === provider ? providerName : providerName}" as absent\n--- pane ---\n${after}`,
    );
  }
  return after;
}

export function renderedLine(screen, pattern) {
  const lines = screen.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

// Pin the *rendered* position of the `Go Usage` block in the host sidebar
// ladder. `SLOT_ORDER` only means something through where the host ends up
// drawing it, so this is what actually guards the constant: the contract tests
// can only echo it back. `before`/`after` are host sidebar headers that must
// render below/above `Go Usage`; a host that stops rendering one of them is a
// real layout change and fails loudly.
export function assertSidebarOrder(screen, { before = [], after = [], anchor = /Go Usage/ } = {}) {
  const goUsage = renderedLine(screen, anchor);
  assert.ok(goUsage >= 0, `${anchor} must be rendered in the sidebar`);
  for (const header of after) {
    const line = renderedLine(screen, header);
    assert.ok(line >= 0, `host sidebar header ${header} must be rendered`);
    assert.ok(goUsage > line, `Go Usage (line ${goUsage + 1}) must render below ${header} (line ${line + 1})`);
  }
  for (const header of before) {
    const line = renderedLine(screen, header);
    assert.ok(line >= 0, `host sidebar header ${header} must be rendered`);
    assert.ok(goUsage < line, `Go Usage (line ${goUsage + 1}) must render above ${header} (line ${line + 1})`);
  }
}

// End-to-end display flow against one host. Returns the model used and the
// final captured screen; throws with the last screen when the surfaces never
// render. The caller owns the tmp root and env.
//
// `sessionId` (with `model`) boots a session the caller already drove -- one
// with real assistant messages, say -- instead of the `noReply` probe session,
// and `provider` routes the model at a local endpoint.
export async function runTuiDisplay({
  host,
  binary,
  repoDir,
  env,
  expect,
  timeoutMs = 150000,
  sessionId: presetSessionId,
  model: presetModel,
  provider,
}) {
  let model = presetModel;
  if (model === undefined) {
    const models = listProviderModels(binary, "opencode-go", { env, cwd: repoDir });
    model = pickProviderModel(models);
    if (model === null) {
      throw new Error(
        `no opencode-go model reported by "${binary} models opencode-go" (models: ${JSON.stringify(models)}); ` +
          "the provider catalog or provider key is missing in this environment",
      );
    }
  }
  writeTuiHostConfig({ host, repoDir, env, model, provider });

  let sessionId = presetSessionId;
  if (sessionId === undefined) {
    const server = await startHostServer({ binary, env, cwd: repoDir });
    try {
      sessionId = await createSessionWithModel({
        url: server.url,
        directory: repoDir,
        model,
        title: `tui-display-${host}`,
      });
    } finally {
      server.stop();
    }
  }
  await sleep(750);

  const session = new TuiSession({
    binary,
    args: ["--session", sessionId],
    env,
    cwd: repoDir,
    label: `oc-tui-${host}-${process.pid}-${Date.now()}`,
  });
  try {
    session.start();
    const screen = await waitForUsageSurfaces(session, { ...expect, timeoutMs });
    return { model, sessionId, screen };
  } finally {
    session.stop();
  }
}

// ---------------------------------------------------------------------------
// Reading a plan row out of a captured pane
// ---------------------------------------------------------------------------

// Every line in a host's sidebar ends with the host's own edge glyph -- a right
// border, a scrollbar thumb -- and it is NOT part of our content. It is also not
// there on every host, or in every panel state, or at every width: opencode draws
// one inside the container and not on some hosts, which is why an assertion
// written against the raw line can pass in one place and fail in another with the
// pane showing exactly what was asked for.
//
// So: strip the trailing edge run and the trailing whitespace before matching.
// Anything anchored to `$` has to go through this, or it is asserting on the
// host's chrome.
export function stripSidebarEdge(line) {
  return line.replace(/[\u2500-\u259f\u25a0-\u25ff]+\s*$/, "").replace(/\s+$/, "");
}

// One plan window's row: label, then a percent. The meter between them is drawn
// as boxes, which plain text cannot see, so the grid around them is all there is
// to assert -- see the meters suite for the geometry that does need colors.
const PLAN_ROW = /^\s*(?:5h|7d|30d)\s+\d+%\s*$/;

// The plan rows on screen, edge-stripped.
export function sidebarPlanRows(screen) {
  return screen.split("\n").map(stripSidebarEdge).filter((line) => PLAN_ROW.test(line));
}

// Assert one plan row per window with the expected percent, matched on the
// stripped lines. Takes `[["5h", "42%"], ...]` so a failure names the window
// rather than reporting three identical regex misses.
export function assertPlanRows(screen, expected) {
  const rows = sidebarPlanRows(screen);
  for (const [label, percent] of expected) {
    assert.ok(
      rows.some((line) => new RegExp(`^\\s*${label}\\s+${percent}\\s*$`).test(line)),
      `the plan must render ${label} at ${percent}%\n` +
        `--- sidebar plan rows ---\n${rows.join("\n")}\n--- pane ---\n${screen}`,
    );
  }
}
