// E2E tier: prove the real kilo host loads the built entry modules and
// registers the `go_usage` tool.
//
// Requires the kilo binary on PATH (the container image installs it) and a
// prior `npm run build`. When the binary is absent the suite skips cleanly, so
// host-only runs without kilo stay green. test/helpers/run.js redirects
// HOME/XDG paths into a tmp dir and strips credentials, so the real
// ~/.config/kilo is never read and no network call is made.
//
// The PTY TUI check is a non-fatal smoke: headless runners may lack a usable
// PTY and the TUI is interactive by nature, so it never fails the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../helpers/run.js";
import { makeConfigDir } from "../helpers/tmp.js";
import {
  assertGoUsageRegistered,
  assertHermeticPaths,
  fetchToolIds,
  findKiloBinary,
  hasPty,
  KILO_LOAD_ENV,
  startKiloServer,
  stripConfigOverrides,
  writeKiloPluginConfig,
} from "../helpers/kilo.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KILO_BINARY = findKiloBinary();
const SKIP_NO_BINARY = KILO_BINARY
  ? false
  : "kilo binary not found on PATH (run inside the container image)";

// A hermetic tmp root: isolated HOME/XDG dirs plus the plugin config.
// TMPDIR is redirected too so `kilo debug paths` stays inside the root.
function makeHermeticRoot() {
  const tmp = makeConfigDir();
  const env = isolatedEnv(tmp.root, {
    ...KILO_LOAD_ENV,
    TMPDIR: path.join(tmp.root, "tmp"),
  });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  // Kilo resolves its config from $XDG_CONFIG_HOME/kilo/ (not OPENCODE_CONFIG_DIR).
  writeKiloPluginConfig(path.join(env.XDG_CONFIG_HOME, "kilo"), REPO_DIR);
  return { tmp, env };
}

test("kilo serve loads the plugin and registers go_usage", { skip: SKIP_NO_BINARY, timeout: 60000 }, async (t) => {
  const { tmp, env } = makeHermeticRoot();
  let server = null;
  // One teardown hook: the server is always stopped before the tmp root is
  // removed, regardless of how the test exits (a pair of t.after hooks would
  // run FIFO, i.e. cleanup would race ahead of stop).
  t.after(() => {
    server?.stop();
    tmp.cleanup();
  });

  // Fail before booting if kilo resolves any path outside the tmp root.
  assertHermeticPaths({ binary: KILO_BINARY, cwd: REPO_DIR, env, root: tmp.root });

  server = await startKiloServer({ binary: KILO_BINARY, cwd: REPO_DIR, env });

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});

test(
  "TUI starts under a PTY (non-fatal smoke)",
  { skip: SKIP_NO_BINARY || (hasPty() ? false : "no PTY available (script/timeout missing)"), timeout: 60000 },
  () => {
    const { tmp, env } = makeHermeticRoot();
    try {
      const result = spawnSync("timeout", ["30", "script", "-qec", "kilo", "/dev/null"], {
        cwd: REPO_DIR,
        env: stripConfigOverrides(env),
        encoding: "utf8",
        timeout: 45000,
      });
      const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-5).join("\n");
      // Non-fatal: the TUI is interactive and may exit non-zero when bounded by
      // `timeout`. Record the outcome; never assert on it.
      console.log(
        `[e2e] PTY TUI smoke exit=${result.status} signal=${result.signal ?? "none"}${tail ? `\n${tail}` : ""}`,
      );
    } catch (error) {
      console.log(`[e2e] PTY TUI smoke skipped: ${error.message}`);
    } finally {
      tmp.cleanup();
    }
  },
);
