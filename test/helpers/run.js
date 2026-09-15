// Isolated child-process harness for the integration tier.
//
// Every spawned node bin receives an env whose HOME and every XDG root point
// inside the caller's tmp directory, plus `OPENCODE_GO_MOCK=1` (deterministic
// snapshot, no network). The real `~/.config/opencode` and `~/.opencode` are
// never reachable: the home/config/data/state/cache paths are explicit and
// guarded to live under `root`, and credential env vars are stripped.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Vars that must resolve inside the tmp root, never to the real user home.
const HERMETIC_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG_DIR",
];

// Secret-bearing vars are removed so an ambient developer shell can never leak
// credentials into (or be observed by) a test child.
const SECRET_KEYS = [
  "OPENCODE_GO_API_KEY",
  "OPENCODE_GO_AUTH_COOKIE",
  "OPENCODE_GO_WORKSPACE_ID",
];

function assertUnderRoot(root, key, value) {
  const relative = path.relative(root, value);
  const inside = relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside) {
    throw new Error(`isolated env ${key} must live inside ${root}, got ${value}`);
  }
}

// Build (and create) a hermetic child env rooted at `root`. `overrides` may
// adjust non-hermetic values; any hermetic key is re-checked to fail fast.
export function isolatedEnv(root, overrides = {}) {
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_GO_MOCK: "1",
    ...overrides,
  };
  for (const key of SECRET_KEYS) delete env[key];
  for (const key of HERMETIC_KEYS) {
    assertUnderRoot(root, key, env[key]);
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

// Run a node script to completion and capture stdout/stderr/exit code.
// `root` is required so every child is hermetic by construction.
export function runNode(args, { root, cwd, env = {}, input } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("runNode requires an explicit { root } tmp directory");
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: isolatedEnv(root, env),
    encoding: "utf8",
    input,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
