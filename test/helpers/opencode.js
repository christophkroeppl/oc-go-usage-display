// Shared opencode harness for the e2e tier.
//
// One implementation of: locating the opencode binary, writing a plugin
// config, booting `opencode serve`, waiting for its listening sentinel, and
// querying the registered tool ids. The e2e test
// (test/e2e/opencode-load.test.js) consumes this so the flow is not duplicated.
// TUI display coverage lives in test/helpers/tui.js.
//
// The load check runs container-only against the container's disposable HOME
// (`~/.config/opencode`). The TUI tests pass an env from test/helpers/run.js
// instead, which redirects HOME/XDG into a tmp root.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_OVERRIDE_KEYS } from "./run.js";

// Behavior toggles the load check needs. Deliberately omits OPENCODE_PURE /
// `--pure`: that would skip the very plugin under test.
export const OPENCODE_LOAD_ENV = {
  CI: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_GO_MOCK: "1",
};

const SENTINEL_PATTERN = /server listening on (http:\/\/[0-9.]+:[0-9]+)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Defense in depth over `isolatedEnv`: never hand an opencode child a
// config-override var, even if a caller built the env some other way.
export function stripConfigOverrides(env) {
  const clean = { ...env };
  for (const key of CONFIG_OVERRIDE_KEYS) delete clean[key];
  return clean;
}

export function findOpencodeBinary() {
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const binary = (found.stdout ?? "").trim();
  return binary.length > 0 ? binary : null;
}

// Write the two config files opencode reads: opencode.json points the server
// at dist/index.js; tui.json points the TUI at dist/tui.js and enables both
// surfaces. `pathToFileURL` percent-encodes the spec so a repo path containing
// spaces still resolves. Plain `file://` specs deliberately exercise the
// post-build entry modules (the bundled dist/plugins/* copies are validated
// elsewhere).
export function writePluginConfig(configDir, repoDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const serverPlugin = pathToFileURL(path.join(repoDir, "dist", "index.js")).href;
  const tuiPlugin = pathToFileURL(path.join(repoDir, "dist", "tui.js")).href;
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [serverPlugin] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(configDir, "tui.json"),
    `${JSON.stringify(
      { $schema: "https://opencode.ai/tui.json", plugin: [tuiPlugin], sidebar: true, statusline: true },
      null,
      2,
    )}\n`,
  );
}

// Spawn `opencode serve` and resolve once the listening sentinel is seen.
// Rejects (after killing the child) when it exits early or the wait times out.
export async function startOpencodeServer({ binary, cwd, env, timeoutMs = 15000 }) {
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
      throw new Error(`opencode serve exited early (code ${child.exitCode}):\n${output}`);
    }
    await sleep(250);
  }
  stop();
  throw new Error(`opencode serve did not report a listening URL within ${timeoutMs}ms:\n${output}`);
}

// Query the experimental tool-id endpoint until it responds. The first request
// can block while opencode bootstraps the config-dir plugin, hence the retries.
// `directory` is sent as `x-opencode-directory`, matching the smoke script.
export async function fetchToolIds(
  url,
  directory,
  { attempts = 30, intervalMs = 1000, requestTimeoutMs = 10000 } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(`${url}/experimental/tool/ids`, {
        headers: { "x-opencode-directory": directory },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `tool ids unavailable after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

export function assertGoUsageRegistered(ids) {
  if (!Array.isArray(ids) || !ids.includes("go_usage")) {
    throw new Error(`go_usage not registered; tool ids: ${JSON.stringify(ids)}`);
  }
}
