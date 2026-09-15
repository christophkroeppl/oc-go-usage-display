// Shared opencode harness for the e2e tier.
//
// One implementation of: locating the opencode binary, writing a hermetic
// plugin config, booting `opencode serve`, waiting for its listening sentinel,
// querying the registered tool ids, and checking for a usable PTY. The e2e test
// (test/e2e/opencode-load.test.js) consumes this so the flow is not duplicated.
//
// Every caller must pass an env produced by test/helpers/run.js (or the shell
// equivalent), so HOME/XDG/opencode paths resolve inside a tmp dir.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

export function findOpencodeBinary() {
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const binary = (found.stdout ?? "").trim();
  return binary.length > 0 ? binary : null;
}

export function hasPty() {
  // util-linux `script` provides the PTY; `timeout` bounds the interactive run.
  for (const command of ["timeout", "script"]) {
    if (spawnSync("which", [command], { encoding: "utf8" }).status !== 0) return false;
  }
  const probe = spawnSync("script", ["-qec", "true", "/dev/null"], { encoding: "utf8" });
  return probe.status === 0;
}

// Write the two config files opencode reads: opencode.json points the server
// at dist/index.js; tui.json points the TUI at dist/tui.js and enables both
// surfaces. Plain `file://` specs deliberately exercise the post-build entry
// modules (the bundled dist/plugins/* copies are validated elsewhere).
export function writePluginConfig(configDir, repoDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const serverPlugin = `file://${path.join(repoDir, "dist", "index.js")}`;
  const tuiPlugin = `file://${path.join(repoDir, "dist", "tui.js")}`;
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
