// E2E tier (container-only): prove the real opencode host loads the built
// entry modules and registers the `go_usage` tool.
//
// Runs only inside the test image (`bun run test:docker`). There the
// container's HOME is disposable, so this test writes the plugin config to the
// real `~/.config/opencode` and boots the host with the ambient environment
// plus the deterministic mock/disable flags — no tmp-root redirection, no
// hermeticity tripwire. Host runs skip with a clear reason.
//
// The real TUI surfaces are covered by tui-display.opencode.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inTestContainer } from "../helpers/run.js";
import {
  assertGoUsageRegistered,
  fetchToolIds,
  findOpencodeBinary,
  OPENCODE_LOAD_ENV,
  startOpencodeServer,
  writePluginConfig,
} from "../helpers/opencode.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCODE_BINARY = findOpencodeBinary();
const SKIP = !inTestContainer()
  ? "container-only: run `bun run test:docker`"
  : OPENCODE_BINARY
    ? false
    : "opencode binary not found on PATH (broken container image)";

test("opencode serve loads the plugin and registers go_usage", { skip: SKIP, timeout: 120000 }, async (t) => {
  // Containers run as root with no XDG overrides, so opencode's real config
  // dir is the disposable `~/.config/opencode`.
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");
  writePluginConfig(configDir, REPO_DIR);

  const env = { ...process.env, ...OPENCODE_LOAD_ENV };
  const server = await startOpencodeServer({ binary: OPENCODE_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});
