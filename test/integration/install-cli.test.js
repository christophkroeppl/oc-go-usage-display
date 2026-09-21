// Integration tier: end-to-end bin CLI flow in a hermetic env.
//
// For both install modes the suite drives the real bins through
// `init -> show --json -> status -> remove` and asserts the config entries,
// exit codes, and link semantics. `test/helpers/run.js` forces HOME/XDG/...
// inside a mkdtemp root and `OPENCODE_GO_MOCK=1`, so the real
// `~/.config/opencode` is never touched and no network call is made.
//
// Requires a prior `bun run build`: the bins serve dist/plugins/*.

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

function runCli(name, args, root, env = {}) {
  return runNode([path.join(REPO_DIR, "bin", name), ...args], { root, cwd: REPO_DIR, env });
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

test("install-cli init fails cleanly when the plugin bundle is missing", () => {
  const tmp = makeConfigDir();
  try {
    // A repo-shaped tree (bins, no dist/plugins) reproduces the missing-bundle
    // path without touching the real repo's build output.
    const fakeRepo = path.join(tmp.root, "repo");
    fs.mkdirSync(path.join(fakeRepo, "bin"), { recursive: true });
    for (const entry of fs.readdirSync(path.join(REPO_DIR, "bin"))) {
      fs.copyFileSync(path.join(REPO_DIR, "bin", entry), path.join(fakeRepo, "bin", entry));
    }

    const result = runNode(
      [
        path.join(fakeRepo, "bin", "oc-go-usage-display-init.js"),
        "--repo",
        fakeRepo,
        "--config-dir",
        tmp.configDir,
      ],
      { root: tmp.root, cwd: REPO_DIR },
    );

    assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /^oc-go-usage-display: /m);
    assert.ok(!result.stderr.includes("Error:"), `stderr must not contain a stack: ${result.stderr}`);
    assert.ok(!/\n\s+at /.test(result.stderr), `stderr must not contain frames: ${result.stderr}`);
    // Fail-fast: nothing was registered before the bundle check.
    assert.equal(fs.existsSync(path.join(tmp.configDir, "opencode.jsonc")), false);
  } finally {
    tmp.cleanup();
  }
});

test("install-cli kilo target installs only the kilo layout", () => {
  const tmp = makeConfigDir();
  try {
    const { root } = tmp;
    const kiloConfigDir = path.join(root, "kilo-config");
    const installedServer = path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.ts");
    const installedTui = path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.tsx");

    const init = runCli(
      "oc-go-usage-display-init.js",
      ["--repo", REPO_DIR, "--kilo-config-dir", kiloConfigDir, "--copy"],
      root,
    );
    assert.equal(init.code, 0, init.stderr);
    assert.equal(fs.lstatSync(installedServer).isFile(), true);
    assert.equal(fs.lstatSync(installedTui).isFile(), true);
    // The kilo target never touches the opencode config, and registers
    // absolute plugin paths (Kilo ignores `./...` relative specs).
    assert.equal(fs.existsSync(path.join(tmp.configDir, "opencode.jsonc")), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(kiloConfigDir, "kilo.json"), "utf8")).plugin,
      [path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.ts")],
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(kiloConfigDir, "tui.json"), "utf8")).plugin,
      [path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.tsx")],
    );

    const status = runCli(
      "oc-go-usage-display-status.js",
      ["--repo", REPO_DIR, "--kilo-config-dir", kiloConfigDir],
      root,
    );
    assert.equal(status.code, 0, status.stderr || status.stdout);

    const remove = runCli("oc-go-usage-display-remove.js", ["--kilo-config-dir", kiloConfigDir], root);
    assert.equal(remove.code, 0, remove.stderr);
    assert.equal(fs.existsSync(installedServer), false);
    assert.equal(fs.existsSync(installedTui), false);
  } finally {
    tmp.cleanup();
  }
});

test("install-cli --target all installs both hosts, remove clears both", () => {
  const tmp = makeConfigDir();
  try {
    const { root, configDir } = tmp;
    const kiloConfigDir = path.join(root, "kilo-config");
    const init = runCli(
      "oc-go-usage-display-init.js",
      ["--repo", REPO_DIR, "--target", "all", "--copy"],
      root,
      { KILO_CONFIG_DIR: kiloConfigDir },
    );
    assert.equal(init.code, 0, init.stderr);

    for (const file of [
      path.join(configDir, "plugins", "oc-go-usage-display.ts"),
      path.join(configDir, "plugins", "oc-go-usage-display.tsx"),
      path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.ts"),
      path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.tsx"),
    ]) {
      assert.equal(fs.existsSync(file), true, `missing ${file}`);
    }

    const remove = runCli("oc-go-usage-display-remove.js", ["--target", "all"], root, {
      KILO_CONFIG_DIR: kiloConfigDir,
    });
    assert.equal(remove.code, 0, remove.stderr);
    assert.equal(fs.existsSync(path.join(kiloConfigDir, "plugins", "oc-go-usage-display.kilo.ts")), false);
    assert.equal(fs.existsSync(path.join(configDir, "plugins", "oc-go-usage-display.ts")), false);
  } finally {
    tmp.cleanup();
  }
});

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
