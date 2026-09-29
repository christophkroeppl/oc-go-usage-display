// E2E tier (container-only): prove the real kilo host loads the installed
// plugin and registers the `go_usage` tool.
//
// Runs only inside the test image (`bun run test:docker`). There the
// container's HOME is disposable, so the install goes through the real
// `oc-go-usage-display-init` CLI into the disposable `~/.config/kilo` and the
// host boots with the ambient environment plus the deterministic mock/disable
// flags — no tmp-root redirection, no hermeticity tripwire. This is the install
// surface proof: kilo.json entry, `./plugins/...` resolution and the
// oc-go-usage-display.kilo.ts server bundle (which reads Kilo's own auth store).
// Host runs skip with a clear reason.
//
// The real TUI surfaces are covered by tui-display.kilo.test.js.

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
  findKiloBinary,
  KILO_LOAD_ENV,
  startKiloServer,
} from "../helpers/kilo.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KILO_BINARY = findKiloBinary();
const SKIP = !inTestContainer()
  ? "container-only: run `bun run test:docker`"
  : KILO_BINARY
    ? false
    : "kilo binary not found on PATH (broken container image)";

test("kilo serve loads the CLI-installed plugin and registers go_usage", { skip: SKIP, timeout: 180000 }, async (t) => {
  // Kilo resolves its config from $XDG_CONFIG_HOME/kilo/ (not
  // OPENCODE_CONFIG_DIR); the container has no XDG override, so the real
  // disposable `~/.config/kilo` is used.
  const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const configDir = path.join(configRoot, "kilo");
  const install = spawnSync(
    process.execPath,
    [
      path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js"),
      "--repo",
      REPO_DIR,
      "--kilo-config-dir",
      configDir,
      "--copy",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(install.status, 0, `init failed: ${install.stderr}`);

  const env = { ...process.env, ...KILO_LOAD_ENV };
  const server = await startKiloServer({ binary: KILO_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

  const ids = await fetchToolIds(server.url, REPO_DIR);
  assertGoUsageRegistered(ids);
  console.log(`[e2e] registered tools: ${ids.join(", ")}`);
});
