// Shared kilo harness for the e2e tier.
//
// One implementation of: locating the kilo binary, writing a hermetic plugin
// config, booting `kilo serve`, waiting for its listening sentinel, querying
// the registered tool ids, and checking for a usable PTY. The e2e test
// (test/e2e/kilo-load.test.js) consumes this so the flow is not duplicated.
//
// Every caller must pass an env produced by test/helpers/run.js (or the shell
// equivalent), so HOME/XDG paths resolve inside a tmp dir. Kilo resolves its
// config from $XDG_CONFIG_HOME/kilo/ (NOT OPENCODE_CONFIG_DIR, which Kilo
// ignores).

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Import the host-agnostic pieces shared with the opencode harness so they are
// available locally (startKiloServer uses stripConfigOverrides). These do not
// depend on which host spawns the server.
import {
  assertGoUsageRegistered,
  assertHermeticPaths,
  fetchToolIds,
  hasPty,
  stripConfigOverrides,
} from "./opencode.js";

// Re-export for kilo.js consumers.
export {
  assertGoUsageRegistered,
  assertHermeticPaths,
  fetchToolIds,
  hasPty,
  stripConfigOverrides,
};

import { CONFIG_OVERRIDE_KEYS } from "./run.js";

// Behavior toggles the load check needs. Deliberately omits OPENCODE_PURE /
// `--pure`: that would skip the very plugin under test. Same env set as
// opencode (Kilo is forked from OpenCode and respects the same vars).
export const KILO_LOAD_ENV = {
  CI: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_GO_MOCK: "1",
};

const SENTINEL_PATTERN = /server listening on (http:\/\/[0-9.]+:[0-9]+)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findKiloBinary() {
  const found = spawnSync("which", ["kilo"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const binary = (found.stdout ?? "").trim();
  return binary.length > 0 ? binary : null;
}

// Write the two config files kilo reads from $XDG_CONFIG_HOME/kilo/:
// opencode.json points the server at dist/index.js; tui.json points the TUI
// at dist/plugins/oc-go-usage-display.kilo.tsx (the @kilocode/plugin external
// build). `pathToFileURL` percent-encodes the spec so a repo path containing
// spaces still resolves. Plain `file://` specs deliberately exercise the
// post-build entry modules.
export function writeKiloPluginConfig(configDir, repoDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const serverPlugin = pathToFileURL(path.join(repoDir, "dist", "index.js")).href;
  const kiloTuiPlugin = pathToFileURL(
    path.join(repoDir, "dist", "plugins", "oc-go-usage-display.kilo.tsx"),
  ).href;
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [serverPlugin] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(configDir, "tui.json"),
    `${JSON.stringify(
      { $schema: "https://opencode.ai/tui.json", plugin: [kiloTuiPlugin], sidebar: true, statusline: true },
      null,
      2,
    )}\n`,
  );
}

// Spawn `kilo serve` and resolve once the listening sentinel is seen.
// Rejects (after killing the child) when it exits early or the wait times out.
export async function startKiloServer({ binary, cwd, env, timeoutMs = 15000 }) {
  const child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd,
    env: stripConfigOverrides(env),
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
    // Escalate if it does not exit promptly.
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
    const match = SENTINEL_PATTERN.exec(output);
    if (match) return { child, url: match[1], output: () => output, stop };
    if (child.exitCode !== null) {
      stop();
      throw new Error(`kilo serve exited early (code ${child.exitCode}):\n${output}`);
    }
    await sleep(250);
  }
  stop();
  throw new Error(`kilo serve did not report a listening URL within ${timeoutMs}ms:\n${output}`);
}