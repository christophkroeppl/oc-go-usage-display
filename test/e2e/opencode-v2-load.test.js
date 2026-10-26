// E2E tier (container-only): prove the real opencode v2 host loads the
// installed plugin and registers it as an active server plugin.
//
// Three v2 facts this test is built on (all measured, see PLAN-opencode-v2.md):
//   * Auth is HTTP Basic with username "opencode" and the server password
//     that `serve` prints on stderr (packages/server/src/auth.ts). A wrong
//     username or missing password is 401; anything else is 401 too.
//   * There is no tool-list route. The plugin inventory route is
//     GET /api/plugin (packages/protocol/src/groups/plugin.ts), which returns
//     { location, data: Plugin.Info[] }. Each entry carries `source`,
//     `features` and `state` — `state.status` is "active" or "failed" (with
//     the error), so a plugin that throws in setup() is visible here.
//   * `/api/plugin` reads the location inventory without awaiting activation
//     (packages/server/src/handlers/plugin.ts), so a cold location answers
//     `{data: []}` for the first seconds. The inventory has to be polled;
//     `awaitPlugins` is only wired into the handlers that need plugins.
//
// The display half lives in test/e2e/tui-display.opencode-v2.test.js, which
// boots the real v2 TUI in tmux and asserts the painted slot text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inTestContainer } from "../helpers/run.js";
import {
  findOpencodeV2Binary,
  OPENCODE_V2_LOAD_ENV,
  startOpencodeV2Server,
  waitForPluginInventory,
} from "../helpers/opencode-v2.js";

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

  const { plugins, matches } = await waitForPluginInventory({
    url: server.url,
    password: server.password,
    match: (plugin) =>
      plugin?.source?.type === "local" &&
      String(plugin.source.path ?? "").includes("oc-go-usage-display"),
  });

  assert.ok(
    matches.length > 0,
    `plugin never entered the v2 inventory.\n` +
      `plugins: ${JSON.stringify(plugins, null, 2)}\n` +
      `config dir: ${configDir}\n` +
      `server output (last 800 chars):\n${server.output()?.slice(-800)}`,
  );
  assert.equal(matches.length, 1, `plugin registered ${matches.length} times: ${JSON.stringify(matches, null, 2)}`);
  const ours = matches[0];
  assert.equal(
    ours.state?.status,
    "active",
    `plugin is present but failed to load: ${JSON.stringify(ours.state)}\nserver output:\n${server.output()?.slice(-800)}`,
  );
  console.log(`[e2e] v2 plugin active: ${ours.source.path}`);
});
