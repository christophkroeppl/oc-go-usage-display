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
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedEnv } from "./run.js";
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
// `live` removes the mock and admits OPENCODE_GO_API_KEY when the caller has it.
export function makeTuiEnv({ root, live = false }) {
  const overrides = {
    ...OPENCODE_LOAD_ENV,
    TMPDIR: path.join(root, "tmp"),
    TMUX_TMPDIR: path.join(root, "tmux"),
    TERM: "xterm-256color",
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || DUMMY_PROVIDER_KEY,
  };
  if (live) {
    delete overrides.OPENCODE_GO_MOCK;
    if (process.env.OPENCODE_GO_API_KEY) overrides.OPENCODE_GO_API_KEY = process.env.OPENCODE_GO_API_KEY;
  }
  const env = isolatedEnv(root, overrides, {
    allowSecrets: live ? ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"] : ["OPENCODE_API_KEY"],
  });
  if (live) delete env.OPENCODE_GO_MOCK;
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
export async function startHostServer({ binary, env, cwd, timeoutMs = 30000 }) {
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
//   kilo:     $XDG_CONFIG_HOME/kilo/{opencode.json,tui.json}
// Kilo rejects `sidebar`/`statusline` keys in tui.json (invalidates the whole
// file, so the plugin never loads), and the surface defaults are both on.
export function writeTuiHostConfig({ host, repoDir, env, model }) {
  const configDir = host === "kilo" ? path.join(env.XDG_CONFIG_HOME, "kilo") : env.OPENCODE_CONFIG_DIR;
  fs.mkdirSync(configDir, { recursive: true });
  const serverSpec = pathToFileURL(path.join(repoDir, "dist", "index.js")).href;
  const tuiEntry =
    host === "kilo" ? path.join(repoDir, "dist", "plugins", "oc-go-usage-display.kilo.tsx") : path.join(repoDir, "dist", "tui.js");
  const tuiSpec = pathToFileURL(tuiEntry).href;
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model, plugin: [serverSpec] }, null, 2)}\n`,
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
  { statusline, sidebar, timeoutMs = 90000, intervalMs = 500, toggleGraceMs = 10000, maxToggleAttempts = 8 },
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

// Readonly live-usage preflight for the live e2e variant: returns the parsed
// snapshot (null when the account has no usable windows) and throws on
// transport/HTTP/shape failures so a broken key fails loudly.
export async function fetchLiveUsage(apiKey, { extractSnapshotFromApiPayload, timeoutMs = 20000 }) {
  const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("usage endpoint did not return valid JSON");
  }
  return extractSnapshotFromApiPayload(payload);
}

// End-to-end display flow against one host. Returns the model used and the
// final captured screen; throws with the last screen when the surfaces never
// render. The caller owns the tmp root and env.
export async function runTuiDisplay({ host, binary, repoDir, env, expect, timeoutMs = 90000 }) {
  const models = listProviderModels(binary, "opencode-go", { env, cwd: repoDir });
  const model = pickProviderModel(models);
  if (model === null) {
    throw new Error(
      `no opencode-go model reported by "${binary} models opencode-go" (models: ${JSON.stringify(models)}); ` +
        "the provider catalog or provider key is missing in this environment",
    );
  }
  writeTuiHostConfig({ host, repoDir, env, model });

  const server = await startHostServer({ binary, env, cwd: repoDir });
  let sessionId;
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
