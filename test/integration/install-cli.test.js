// Integration tier: end-to-end bin CLI flow in a hermetic env.
//
// For both install modes the suite drives the real bins through
// `init -> show --json -> status -> remove` and asserts the config entries,
// exit codes, and link semantics. `test/helpers/run.js` forces HOME/XDG/...
// inside a mkdtemp root and `OPENCODE_OC_GO_MOCK=1`, so the real
// `~/.config/opencode` is never touched and no network call is made.
//
// The second half pins the CLI contract: an unrecognized positional errors out
// instead of installing, a piped run neither prompts nor hangs, and a TTY run
// asks before it writes (once even when only one host is available).
//
// Requires a prior `bun run build`: the bins serve dist/plugins/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfigDir } from "../helpers/tmp.js";
import { runNode, runOnPty, scriptBinary } from "../helpers/run.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVED_SERVER = path.join(REPO_DIR, "dist", "plugins", "oc-go-usage-display.ts");
const SERVED_TUI = path.join(REPO_DIR, "dist", "plugins", "oc-go-usage-display.tsx");
const INIT_BIN = path.join(REPO_DIR, "bin", "oc-go-usage-display-init.js");

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

// --- CLI contract: fail closed, never hang, always ask a human ---

const NO_PTY = scriptBinary() === null ? "script (util-linux) is unavailable; cannot allocate a pty" : false;

// Every host config the isolated env can resolve, so "nothing was installed"
// can be asserted without listing five paths per test.
function installedConfigs(root) {
  return [
    path.join(root, "config", "opencode.jsonc"),
    path.join(root, "config", "tui.json"),
    path.join(root, "xdg-config", "kilo", "kilo.json"),
    path.join(root, "xdg-config", "kilo", "tui.json"),
  ];
}

function assertNothingInstalled(root, label) {
  for (const file of installedConfigs(root)) {
    assert.equal(fs.existsSync(file), false, `${label}: must not have written ${file}`);
  }
}

// A TTY prompt carries SGR codes, so structural assertions read the same
// transcript with them removed.
function plain(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

test("install-cli rejects an unrecognized positional instead of installing", () => {
  const tmp = makeConfigDir();
  try {
    // `init status` used to be read as "install": a full --copy install into
    // the real config of whichever host happened to be detected.
    const result = runNode([INIT_BIN, "--repo", REPO_DIR, "status", "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      timeout: 60000,
    });
    assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /oc-go-usage-display: unexpected argument "status"/);
    assert.match(result.stderr, /run "oc-go-usage-display-status" instead/);
    assert.ok(!result.stderr.includes("installed from"), `must not have installed: ${result.stdout}`);
    assertNothingInstalled(tmp.root, "init status");
  } finally {
    tmp.cleanup();
  }
});

test("install-cli rejects a positional on every bin and installs nothing", () => {
  const tmp = makeConfigDir();
  try {
    // A copy install first, so "nothing was removed" is a real assertion.
    const seed = runNode([INIT_BIN, "--repo", REPO_DIR, "--target", "all", "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      timeout: 60000,
    });
    assert.equal(seed.code, 0, seed.stderr);
    const before = fs.readFileSync(path.join(tmp.root, "config", "opencode.jsonc"), "utf8");

    for (const name of ["init", "remove", "show", "status", "update"]) {
      const result = runNode([path.join(REPO_DIR, "bin", `oc-go-usage-display-${name}.js`), "bogus"], {
        root: tmp.root,
        cwd: REPO_DIR,
        timeout: 60000,
      });
      assert.equal(result.code, 1, `${name} bogus must exit 1, got ${result.code}: ${result.stderr}`);
      assert.match(result.stderr, /oc-go-usage-display: unexpected argument "bogus"/);
      assert.match(result.stderr, /takes flags only|takes:/);
      assert.equal(
        fs.readFileSync(path.join(tmp.root, "config", "opencode.jsonc"), "utf8"),
        before,
        `${name} bogus must not have changed the config`,
      );
    }
  } finally {
    tmp.cleanup();
  }
});

test("install-cli --help prints usage, installs nothing, and exits 0", () => {
  const tmp = makeConfigDir();
  try {
    // `--help` used to be swallowed as an unrecognized flag and fall through to
    // a full install, which is how a curious invocation overwrote a config.
    for (const name of ["init", "remove", "show", "status", "update"]) {
      const result = runNode([path.join(REPO_DIR, "bin", `oc-go-usage-display-${name}.js`), "--help"], {
        root: tmp.root,
        cwd: REPO_DIR,
        timeout: 60000,
      });
      assert.equal(result.code, 0, `${name} --help: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^usage: oc-go-usage-display-${name} \\[flags\\]`));
      assert.match(result.stdout, /flags with a value:/);
    }
    assertNothingInstalled(tmp.root, "--help");
  } finally {
    tmp.cleanup();
  }
});

test("install-cli non-TTY runs install every host, never prompts, and cannot hang", () => {
  const tmp = makeConfigDir();
  try {
    // stdin is a closed pipe here, so any prompt would either hang or consume
    // nothing: the timeout turns a regression into a signal, not a stuck suite.
    const result = runNode([INIT_BIN, "--repo", REPO_DIR, "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      input: "1\n",
      timeout: 60000,
    });
    assert.equal(result.signal, null, `init was killed (hung on a prompt?): ${result.stderr}`);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes("which host(s)?"), `must not prompt without a TTY: ${result.stdout}`);
    for (const file of [
      path.join(tmp.root, "config", "plugins", "oc-go-usage-display.ts"),
      path.join(tmp.root, "config", "plugins", "oc-go-usage-display.tsx"),
      path.join(tmp.root, "xdg-config", "kilo", "plugins", "oc-go-usage-display.kilo.ts"),
      path.join(tmp.root, "xdg-config", "kilo", "plugins", "oc-go-usage-display.kilo.tsx"),
    ]) {
      assert.equal(fs.existsSync(file), true, `non-TTY default must install every host, missing ${file}`);
    }
  } finally {
    tmp.cleanup();
  }
});

test("install-cli a TTY user is asked, and Enter installs only the on-PATH host", { skip: NO_PTY }, () => {
  const tmp = makeConfigDir();
  try {
    // An empty PATH plus a stub opencode leaves exactly one host available, the
    // case that used to install silently. HOME/XDG stay inside the tmp root, and
    // no --config-dir is passed so the prompt really decides.
    const stubDir = path.join(tmp.root, "stub-bin");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = runOnPty(process.execPath, [INIT_BIN, "--repo", REPO_DIR, "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      env: { PATH: stubDir },
      input: "\n",
      timeout: 60000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(plain(result.stdout), /1\) opencode/);
    assert.match(plain(result.stdout), /2\) kilo {2}\(binary not on PATH\)/);
    assert.match(plain(result.stdout), /Install for \[1\]/);
    // Enter is the default: the on-PATH host only. Kilo was offered, never
    // preselected, so nothing of kilo's was written.
    assert.equal(fs.existsSync(path.join(tmp.root, "config", "opencode.jsonc")), true);
    assert.equal(fs.existsSync(path.join(tmp.root, "xdg-config", "kilo", "kilo.json")), false);
  } finally {
    tmp.cleanup();
  }
});

test("install-cli a struck-through host is still selectable by number", { skip: NO_PTY }, () => {
  const tmp = makeConfigDir();
  try {
    const stubDir = path.join(tmp.root, "stub-bin");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = runOnPty(process.execPath, [INIT_BIN, "--repo", REPO_DIR, "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      env: { PATH: stubDir },
      input: "2\n",
      timeout: 60000,
    });
    assert.equal(result.code, 0, result.stderr);
    // A host with no binary on PATH stays choosable: pre-installing config for
    // an app you have not installed yet is a legitimate reason.
    assert.match(plain(result.stdout), /binary not on PATH/);
    assert.equal(fs.existsSync(path.join(tmp.root, "xdg-config", "kilo", "kilo.json")), true);
    assert.equal(fs.existsSync(path.join(tmp.root, "config", "opencode.jsonc")), false);
  } finally {
    tmp.cleanup();
  }
});

test("install-cli strike-through ANSI reaches a TTY and stays out of a pipe", { skip: NO_PTY }, () => {
  const tmp = makeConfigDir();
  try {
    const stubDir = path.join(tmp.root, "stub-bin");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const args = [INIT_BIN, "--repo", REPO_DIR, "--copy"];
    const ptyEnv = { PATH: stubDir };

    const onTty = runOnPty(process.execPath, args, { root: tmp.root, cwd: REPO_DIR, env: ptyEnv, input: "1\n" });
    assert.equal(onTty.code, 0, onTty.stderr);
    assert.ok(onTty.stdout.includes("\u001B[9m"), `a TTY prompt should strike the unavailable host: ${JSON.stringify(onTty.stdout)}`);

    // Same command, no pty: the prompt is not printed at all, so a captured
    // transcript can never contain escape codes.
    const piped = runNode(args, { root: tmp.root, cwd: REPO_DIR, env: ptyEnv, timeout: 60000 });
    assert.equal(piped.code, 0, piped.stderr);
    assert.ok(!piped.stdout.includes("\u001B"), `a pipe must stay plain: ${JSON.stringify(piped.stdout)}`);

    // NO_COLOR wins over the TTY, so a CI pty gets plain text too.
    const noColor = runOnPty(process.execPath, args, {
      root: tmp.root,
      cwd: REPO_DIR,
      env: { ...ptyEnv, NO_COLOR: "1" },
      input: "1\n",
    });
    assert.equal(noColor.code, 0, noColor.stderr);
    assert.ok(!noColor.stdout.includes("\u001B"), `NO_COLOR must suppress ANSI: ${JSON.stringify(noColor.stdout)}`);
  } finally {
    tmp.cleanup();
  }
});

test("install-cli --target short-circuits the prompt even on a TTY", { skip: NO_PTY }, () => {
  const tmp = makeConfigDir();
  try {
    const result = runOnPty(process.execPath, [INIT_BIN, "--repo", REPO_DIR, "--target", "kilo", "--copy"], {
      root: tmp.root,
      cwd: REPO_DIR,
      env: { PATH: path.join(tmp.root, "stub-bin") },
      input: "",
      timeout: 60000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes("which host(s)?"), `explicit --target must not prompt: ${result.stdout}`);
    assert.equal(fs.existsSync(path.join(tmp.root, "xdg-config", "kilo", "kilo.json")), true);
    assert.equal(fs.existsSync(path.join(tmp.root, "config", "opencode.jsonc")), false);
  } finally {
    tmp.cleanup();
  }
});
