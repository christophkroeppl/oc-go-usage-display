// Shared opencode v2 harness for the e2e tier.
//
// v2 differs from v1 in three ways that affect the harness:
// 1. The binary is `opencode-v2` (not `opencode`), installed from the ghcr image.
// 2. The server requires auth: HTTP Basic with username "opencode" and the
//    password that `serve` prints on stderr (packages/server/src/auth.ts).
// 3. There is no tool-list route; the plugin inventory route is GET /api/plugin
//    (packages/protocol/src/groups/plugin.ts).

import { spawn, spawnSync } from "node:child_process";
import { CONFIG_OVERRIDE_KEYS } from "./run.js";

export const OPENCODE_V2_LOAD_ENV = {
  CI: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_OC_GO_MOCK: "1",
};

const SENTINEL_PATTERN = /server listening on (http:\/\/[0-9.]+:[0-9]+)/;
const PASSWORD_PATTERN = /server password (\S+)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripConfigOverrides(env) {
  const clean = { ...env };
  for (const key of CONFIG_OVERRIDE_KEYS) delete clean[key];
  return clean;
}

export function findOpencodeV2Binary() {
  const found = spawnSync("which", ["opencode-v2"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const binary = (found.stdout ?? "").trim();
  return binary.length > 0 ? binary : null;
}

// Starts `opencode-v2 serve` and resolves once it reports a listening URL and
// a password. Both are read from the combined stdout+stderr stream, so the
// caller must wait for both before treating the server as ready.
export async function startOpencodeV2Server({ binary, cwd, env, timeoutMs = 15000 }) {
  const child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--print-logs"], {
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
    if (match) {
      const pwMatch = PASSWORD_PATTERN.exec(output);
      if (pwMatch) {
        return { child, url: match[1], password: pwMatch[1], output: () => output, stop };
      }
    }
    if (child.exitCode !== null) {
      stop();
      throw new Error(`opencode-v2 serve exited early (code ${child.exitCode}):\n${output}`);
    }
    await sleep(250);
  }
  stop();
  throw new Error(`opencode-v2 serve did not report a listening URL within ${timeoutMs}ms:\n${output}`);
}

// `GET /api/plugin` reads the location's inventory without waiting for plugin
// activation (packages/server/src/handlers/plugin.ts). A cold location is
// therefore empty for the first seconds even though its plugins are loading, so
// callers poll until the plugin under test appears -- failed plugins are in the
// inventory too, which is what makes `state.status` assertable.
export async function waitForPluginInventory({ url, password, match, attempts = 45, intervalMs = 1000 }) {
  const basic = Buffer.from(`opencode:${password}`, "utf8").toString("base64");
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${url}/api/plugin`, { headers: { Authorization: `Basic ${basic}` } });
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`GET /api/plugin failed with HTTP ${response.status}: ${text}`);
    }
    const body = JSON.parse(text);
    last = Array.isArray(body?.data) ? body.data : [];
    const found = last.filter(match);
    if (found.length > 0) return { plugins: last, matches: found, attempts: attempt };
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { plugins: last, matches: [], attempts };
}
