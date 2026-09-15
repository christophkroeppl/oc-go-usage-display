// Integration tier: end-to-end bin CLI flow in a hermetic env.
//
// For both install modes the suite drives the real bins through
// `init -> show --json -> status -> remove` and asserts the config entries,
// exit codes, and link semantics. `test/helpers/run.js` forces HOME/XDG/...
// inside a mkdtemp root and `OPENCODE_GO_MOCK=1`, so the real
// `~/.config/opencode` is never touched and no network call is made.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfigDir } from "../helpers/tmp.js";
import { runNode } from "../helpers/run.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVED_SERVER = path.join(REPO_DIR, "dist", "plugins", "oc-go-usage-display.ts");
const SERVED_TUI = path.join(REPO_DIR, "dist", "plugins", "oc-go-usage-display.tsx");

function runCli(name, args, root) {
  return runNode([path.join(REPO_DIR, "bin", name), ...args], { root, cwd: REPO_DIR });
}

function assertNoDanglingSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      assert.doesNotThrow(() => fs.statSync(full), `dangling symlink: ${full}`);
    } else if (entry.isDirectory()) {
      assertNoDanglingSymlinks(full);
    }
  }
}

for (const mode of ["copy", "symlink"]) {
  test(`install-cli ${mode}: init -> show --json -> status -> remove`, () => {
    const tmp = makeConfigDir();
    try {
      const { root, configDir } = tmp;
      const installedServer = path.join(configDir, "plugins", "oc-go-usage-display.ts");
      const installedTui = path.join(configDir, "plugins", "oc-go-usage-display.tsx");

      const init = runCli(
        "oc-go-usage-display-init.js",
        ["--repo", REPO_DIR, "--config-dir", configDir, `--${mode}`],
        root,
      );
      assert.equal(init.code, 0, init.stderr);

      assertNoDanglingSymlinks(configDir);
      if (mode === "copy") {
        assert.equal(fs.lstatSync(installedServer).isFile(), true);
        assert.equal(fs.lstatSync(installedServer).isSymbolicLink(), false);
        assert.equal(fs.lstatSync(installedTui).isFile(), true);
        assert.equal(fs.lstatSync(installedTui).isSymbolicLink(), false);
      } else {
        assert.equal(fs.lstatSync(installedServer).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(installedServer), SERVED_SERVER);
        assert.equal(fs.lstatSync(installedTui).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(installedTui), SERVED_TUI);
      }

      const show = runCli(
        "oc-go-usage-display-show.js",
        ["--repo", REPO_DIR, "--config-dir", configDir, "--json"],
        root,
      );
      assert.equal(show.code, 0, show.stderr);
      const report = JSON.parse(show.stdout);
      assert.equal(report.server.entry, true, JSON.stringify(report.server));
      assert.equal(report.tui.entry, true, JSON.stringify(report.tui));

      const status = runCli(
        "oc-go-usage-display-status.js",
        ["--repo", REPO_DIR, "--config-dir", configDir],
        root,
      );
      assert.equal(status.code, 0, status.stderr || status.stdout);

      const remove = runCli("oc-go-usage-display-remove.js", ["--config-dir", configDir], root);
      assert.equal(remove.code, 0, remove.stderr);
      assert.equal(fs.existsSync(installedServer), false);
      assert.equal(fs.existsSync(installedTui), false);

      const after = runCli(
        "oc-go-usage-display-show.js",
        ["--repo", REPO_DIR, "--config-dir", configDir, "--json"],
        root,
      );
      assert.equal(after.code, 0, after.stderr);
      const afterReport = JSON.parse(after.stdout);
      assert.equal(afterReport.server.entry, false, JSON.stringify(afterReport.server));
      assert.equal(afterReport.tui.entry, false, JSON.stringify(afterReport.tui));
      assert.equal(afterReport.server.state, "missing");
      assert.equal(afterReport.tui.state, "missing");
    } finally {
      tmp.cleanup();
    }
  });
}
