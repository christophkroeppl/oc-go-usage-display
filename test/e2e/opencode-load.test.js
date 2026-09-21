// E2E tier: prove the real opencode host loads the built entry modules and
// registers the `go_usage` tool.
//
// Requires the opencode binary on PATH (the container image installs it) and a
// prior `bun run build`. When the binary is absent the suite skips cleanly, so
// host-only runs without opencode stay green. test/helpers/run.js redirects
// HOME/XDG/opencode paths into a tmp dir and strips credentials, so the real
// ~/.config/opencode is never read and no network call is made.
//
// The real TUI surfaces are covered by tui-display.opencode.test.js, which
// drives a tmux session and asserts the rendered usage text.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../helpers/run.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  assertGoUsageRegistered,
  assertHermeticPaths,
  fetchToolIds,
  findOpencodeBinary,
  OPENCODE_LOAD_ENV,
  startOpencodeServer,
  writePluginConfig,
} from "../helpers/opencode.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCODE_BINARY = findOpencodeBinary();
const SKIP_NO_BINARY = OPENCODE_BINARY
  ? false
  : "opencode binary not found on PATH (run inside the container image)";

// A hermetic tmp root: isolated HOME/XDG/opencode dirs plus the plugin config.
// TMPDIR is redirected too so `opencode debug paths` stays inside the root.
function makeHermeticRoot() {
  const tmp = makeConfigDir();
  const env = isolatedEnv(tmp.root, {
    ...OPENCODE_LOAD_ENV,
    TMPDIR: path.join(tmp.root, "tmp"),
  });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  writePluginConfig(tmp.configDir, REPO_DIR);
  return { tmp, env };
}

test("opencode serve loads the plugin and registers go_usage", { skip: SKIP_NO_BINARY, timeout: 120000 }, async (t) => {
  const { tmp, env } = makeHermeticRoot();
  let server = null;
  // One teardown hook: the server is always stopped before the tmp root is
  // removed, regardless of how the test exits (a pair of t.after hooks would
  // run FIFO, i.e. cleanup would race ahead of stop).
  t.after(() => {
    server?.stop();
    tmp.cleanup();
  });

  // Fail before booting if opencode resolves any path outside the tmp root.
  assertHermeticPaths({ binary: OPENCODE_BINARY, cwd: REPO_DIR, env, root: tmp.root });

  server = await startOpencodeServer({ binary: OPENCODE_BINARY, cwd: REPO_DIR, env });

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});
