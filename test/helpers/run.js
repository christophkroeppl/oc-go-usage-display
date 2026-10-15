// Isolated child-process harness for the integration tier.
//
// Every spawned node bin receives an env whose HOME and every XDG root point
// inside the caller's tmp directory, plus `OPENCODE_OC_GO_MOCK=1` (deterministic
// snapshot, no network). The real `~/.config/opencode` and `~/.opencode` are
// never reachable: the home/config/data/state/cache paths are explicit and
// guarded to live under `root`, credential plus behavior-toggle env vars are
// stripped, and opencode config-override vars are removed unconditionally.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Marker set by compose.yml. Container-only tests (the load checks) skip
// elsewhere: inside the image the container's own HOME is disposable, so they
// exercise the real config paths instead of a tmp root.
export const CONTAINER_MARKER = "OC_GO_TEST_CONTAINER";

export function inTestContainer() {
  return process.env[CONTAINER_MARKER] === "1";
}

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
// credentials into (or be observed by) a test child. Only an explicit
// `allowSecrets` opt-in re-admits a key for the live usage/TUI tests.
// Every spelling the plugin can resolve. The unscoped `OPENCODE_GO_*` is dead
// as of the 2.0 host scoping but is still stripped: a developer shell may
// carry one, and a test child must not see a variable no build reads.
const HOST_ENV_PREFIXES = ["OPENCODE_OC_GO_", "KILO_OC_GO_", "OPENCODE_GO_"];

// The Go key a live test should use, whichever host prefix carries it. A shell
// may reasonably export either name, and the live checks are host-agnostic.
export function goApiKeyFromEnv(env = process.env) {
  for (const key of ["OPENCODE_OC_GO_API_KEY", "KILO_OC_GO_API_KEY"]) {
    const value = (env[key] ?? "").trim();
    if (value.length > 0) return { key, value };
  }
  return { key: null, value: "" };
}

const hostScopedKeys = (suffixes) =>
  HOST_ENV_PREFIXES.flatMap((prefix) => suffixes.map((suffix) => `${prefix}${suffix}`));

const SECRET_KEYS = [
  "OPENCODE_API_KEY",
  ...hostScopedKeys(["API_KEY", "AUTH_COOKIE", "WORKSPACE_ID"]),
];

// Non-secret vars that silently change plugin behavior (surface selection).
// Stripped from the inherited env so a TUI integration test gets the defaults
// unless it opts in via an explicit `overrides` value.
const BEHAVIOR_KEYS = hostScopedKeys([
  "DISPLAY",
  "SIDEBAR",
  "STATUSLINE",
  "SIDEBAR_MODE",
]);

// Vars that override opencode's own config/database/permission resolution.
// An inherited value can redirect a child at the real host config, disable the
// plugin under test, or point at a shared DB, so these are removed even when
// an `overrides` object tries to reintroduce them.
export const CONFIG_OVERRIDE_KEYS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PERMISSION",
  "OPENCODE_DB",
  "OPENCODE_PLUGIN_META_FILE",
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
// `allowSecrets` names SECRET_KEYS that may survive (from `overrides` or the
// ambient env) — reserved for the READONLY live usage/TUI tests. Default: none.
export function isolatedEnv(root, overrides = {}, { allowSecrets = [] } = {}) {
  const env = { ...process.env };
  // Strip inherited behavior toggles before appending explicit overrides: a
  // caller that wants to exercise a toggle passes it in `overrides`.
  for (const key of BEHAVIOR_KEYS) delete env[key];
  Object.assign(env, {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    // Both hosts are mocked: a child may be either binary, and each entry only
    // reads its own prefix.
    OPENCODE_OC_GO_MOCK: "1",
    KILO_OC_GO_MOCK: "1",
  }, overrides);
  for (const key of SECRET_KEYS) {
    if (!allowSecrets.includes(key)) delete env[key];
  }
  for (const key of CONFIG_OVERRIDE_KEYS) delete env[key];
  for (const key of HERMETIC_KEYS) {
    assertUnderRoot(root, key, env[key]);
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

// Run a node script to completion and capture stdout/stderr/exit code.
// `root` is required so every child is hermetic by construction.
// `timeout` (ms) turns a hang into a signal instead of a stuck suite: the
// non-interactive no-hang assertions rely on it.
export function runNode(args, { root, cwd, env = {}, input, allowSecrets = [], timeout } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("runNode requires an explicit { root } tmp directory");
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: isolatedEnv(root, env, { allowSecrets }),
    encoding: "utf8",
    input,
    timeout,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// A pty is the only way to make `isTTY` true for a child, which is what the
// interactive init prompt keys off. `script` (util-linux) allocates one; without
// it the caller must skip rather than assert the prompt path.
export function scriptBinary() {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  const found = (which.stdout ?? "").trim();
  return which.status === 0 && found.length > 0 ? found : null;
}

// Single-quote one argument for /bin/sh.
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Run a command under a pty so its stdin and stdout are both TTYs. Returns the
// pty transcript (with \r normalised) plus the child's exit code, and honours
// `timeout` so a prompt that never answers fails the test instead of hanging.
export function runOnPty(command, args, { root, cwd, env = {}, input = "", timeout = 30000 } = {}) {
  const script = scriptBinary();
  if (script === null) return null;
  const shellCommand = [command, ...args].map(shQuote).join(" ");
  const result = spawnSync(script, ["-qec", shellCommand, "/dev/null"], {
    cwd,
    env: isolatedEnv(root, env),
    encoding: "utf8",
    input,
    timeout,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? "").replace(/\r\n/g, "\n"),
    stderr: (result.stderr ?? "").replace(/\r\n/g, "\n"),
  };
}

