// E2E tier (container-only): prove the real opencode v2 host loads the
// installed plugin and registers it as an active server plugin.
//
// Two v2 facts this test is built on (both measured, see PLAN-opencode-v2.md):
//   * Auth is HTTP Basic with username "opencode" and the server password
//     that `serve` prints on stderr (packages/server/src/auth.ts). A wrong
//     username or missing password is 401; anything else is 401 too.
//   * There is no tool-list route. The plugin inventory route is
//     GET /api/plugin (packages/protocol/src/groups/plugin.ts), which returns
//     { location, data: Plugin.Info[] }. Each entry carries `source`,
//     `features` and `state` — `state.status` is "active" or "failed" (with
//     the error), so a plugin that throws in setup() is visible here.
//
// The TUI slot surface is architecturally blocked for third-party plugins
// (the host provides only `effect` and `@opencode/plugin` as runtime modules),
// so there is no v2 TUI display test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inTestContainer } from "../helpers/run.js";
import { findOpencodeV2Binary, OPENCODE_V2_LOAD_ENV, startOpencodeV2Server } from "../helpers/opencode-v2.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const V2_BINARY = findOpencodeV2Binary();
const SKIP = !inTestContainer()
  ? "container-only: run `bun run test:docker`"
  : V2_BINARY
    ? false
    : "opencode-v2 binary not found on PATH (broken container image)";

test("opencode-v2 serve loads the installed plugin as an active server plugin", { skip: SKIP, timeout: 180000 }, async (t) => {
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");
  const install = spawnSync(
    process.execPath,
    [
      path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js"),
      "--target", "opencode-v2",
      "--repo", REPO_DIR,
      "--config-dir", configDir,
      "--copy",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(install.status, 0, `init failed: ${install.stderr}`);

  const env = { ...process.env, ...OPENCODE_V2_LOAD_ENV, OPENCODE_CONFIG_DIR: configDir };
  const server = await startOpencodeV2Server({ binary: V2_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

                                                                            
  const basic = Buffer.from(`opencode:${server.password}`, "utf8").toString("base64");
  const response = await fetch(`${server.url}/api/plugin`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const text = await response.text();
  assert.equal(response.status, 200, `GET /api/plugin failed with HTTP ${response.status}: ${text}`);
  const body = JSON.parse(text);
  const plugins = Array.isArray(body?.data) ? body.data : [];

  const ours = plugins.find(
    (plugin) => plugin?.source?.type === "local" && String(plugin.source.path ?? "").includes("oc-go-usage-display.v2"),
  );
  assert.ok(
    ours,
    `plugin is not in the v2 inventory.\n` +
      `plugins: ${JSON.stringify(plugins, null, 2)}\n` +
      `config dir: ${configDir}\n` +
      `server output (last 800 chars):\n${server.output()?.slice(-800)}`,
  );
  assert.equal(
    ours.state?.status,
    "active",
    `plugin is present but failed to load: ${JSON.stringify(ours.state)}\nserver output:\n${server.output()?.slice(-800)}`,
  );
  console.log(`[e2e] v2 plugin active: ${ours.source.path}`);
});
