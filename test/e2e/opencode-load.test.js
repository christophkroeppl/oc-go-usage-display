// E2E tier (container-only): prove the real opencode host loads the installed
// plugin and registers the `go_usage` tool.
//
// Runs only inside the test image (`bun run test:docker`). There the
// container's HOME is disposable, so the install goes through the real
// `oc-go-usage-display-init` CLI into the disposable `~/.config/opencode` and
// the host boots with the ambient environment plus the deterministic
// mock/disable flags — no tmp-root redirection, no hermeticity tripwire. This
// is the install surface proof: opencode.jsonc entry, `./plugins/...`
// resolution and the oc-go-usage-display.ts server bundle.
// Host runs skip with a clear reason.
//
// The real TUI surfaces are covered by tui-display.opencode.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
} from "../helpers/opencode.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCODE_BINARY = findOpencodeBinary();
const SKIP = !inTestContainer()
  ? "container-only: run `bun run test:docker`"
  : OPENCODE_BINARY
    ? false
    : "opencode binary not found on PATH (broken container image)";

test("opencode serve loads the CLI-installed plugin and registers go_usage", { skip: SKIP, timeout: 180000 }, async (t) => {
  // Containers run as root with no XDG overrides, so opencode's real config
  // dir is the disposable `~/.config/opencode`.
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");
  const install = spawnSync(
    process.execPath,
    [
      path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js"),
      "--repo",
      REPO_DIR,
      "--config-dir",
      configDir,
      "--copy",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(install.status, 0, `init failed: ${install.stderr}`);

  const env = { ...process.env, ...OPENCODE_LOAD_ENV };
  const server = await startOpencodeServer({ binary: OPENCODE_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});
