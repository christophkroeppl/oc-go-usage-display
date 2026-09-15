// E2E tier: prove the real opencode host loads the built entry modules and
// registers the `go_usage` tool.
//
// Requires the opencode binary on PATH (the container image installs it) and a
// prior `npm run build`. When the binary is absent the suite skips cleanly, so
// host-only runs without opencode stay green. test/helpers/run.js redirects
// HOME/XDG/opencode paths into a tmp dir and strips credentials, so the real
// ~/.config/opencode is never read and no network call is made.
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
  fetchToolIds,
  findOpencodeBinary,
  hasPty,
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

test("opencode serve loads the plugin and registers go_usage", { skip: SKIP_NO_BINARY }, async (t) => {
  const { tmp, env } = makeHermeticRoot();
  t.after(() => tmp.cleanup());

  const server = await startOpencodeServer({ binary: OPENCODE_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});

test(
  "TUI starts under a PTY (non-fatal smoke)",
  { skip: SKIP_NO_BINARY || (hasPty() ? false : "no PTY available (script/timeout missing)") },
  () => {
    const { tmp, env } = makeHermeticRoot();
    try {
      const result = spawnSync("timeout", ["30", "script", "-qec", "opencode", "/dev/null"], {
        cwd: REPO_DIR,
        env,
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
