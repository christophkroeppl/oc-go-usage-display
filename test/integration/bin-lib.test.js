// Integration tier: `bin/lib.js` — dependency-free install helpers (flag parsing,
// tui entry normalization, config-entry round-trips, plugin file removal).
// Temp dirs come from `test/helpers/tmp.js`; the real config dir is never used.
//
// Requires a prior `bun run build`: the plugin-file tests read dist/plugins/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkHostInstall,
  cliErrorMessage,
  ensureServerEntry,
  ensureTuiEntry,
  linkPluginFiles,
  normalizeTuiEntry,
  parseOptionalToggle,
  parseTargetChoice,
  parseTargetList,
  readTuiSelection,
  removePluginFiles,
  removeServerEntry,
  removeTuiEntry,
} from "../../bin/lib.js";
import { makeTempDir } from "../helpers/tmp.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Run `fn(dir)` against a fresh mkdtemp dir and always clean it up.
function withTempDir(fn) {
  const tmp = makeTempDir();
  try {
    fn(tmp.dir);
  } finally {
    tmp.cleanup();
  }
}

// Deployed plugin files are bundled self-contained: shared.ts is inlined,
// so no relative `./shared` import may remain and the entry markers must be
// present (proves the shared helpers resolved into the bundle).
function assertDeployedSelfContained(pluginsDir, fileName, marker) {
  const content = fs.readFileSync(path.join(pluginsDir, fileName), "utf8");
  assert.ok(!content.includes('from "./shared'), `${fileName} must not import from "./shared"`);
  assert.ok(!content.includes("from './shared"), `${fileName} must not import from './shared'`);
  assert.ok(!content.includes('from "./'), `${fileName} must have no relative imports`);
  assert.ok(!content.includes("from './"), `${fileName} must have no relative imports`);
  assert.ok(content.includes(marker), `${fileName} must contain ${marker}`);
}

// --- flag parsing and tui entry normalization ---

test("parseOptionalToggle parses flags and rejects invalid values", () => {
  assert.equal(parseOptionalToggle(["--sidebar", "1"], "--sidebar"), true);
  assert.equal(parseOptionalToggle(["--sidebar=false"], "--sidebar"), false);
  assert.equal(parseOptionalToggle([], "--sidebar"), null);
  assert.throws(() => parseOptionalToggle(["--sidebar", "yes"], "--sidebar"), /invalid value for --sidebar/);
});

test("cliErrorMessage prefixes exactly once and never includes a stack", () => {
  assert.equal(cliErrorMessage(new Error("boom")), "oc-go-usage-display: boom");
  assert.equal(
    cliErrorMessage(new Error("oc-go-usage-display: repo bundle missing")),
    "oc-go-usage-display: repo bundle missing",
  );
  assert.equal(cliErrorMessage("plain failure"), "oc-go-usage-display: plain failure");
  assert.equal(cliErrorMessage(new Error("")), "oc-go-usage-display: unknown error");
  const stack = cliErrorMessage(new Error("boom"));
  assert.ok(!stack.includes("\n"), "message must be a single line");
});

test("cliErrorMessage collapses multi-line input to a single line", () => {
  assert.equal(
    cliErrorMessage(new Error("npm ERR! code E404\nnpm ERR! 404 Not Found\t(npm)")),
    "oc-go-usage-display: npm ERR! code E404 npm ERR! 404 Not Found (npm)",
  );
  // An already-prefixed multi-line message keeps the prefix exactly once.
  assert.equal(
    cliErrorMessage(new Error("oc-go-usage-display: first\n  second")),
    "oc-go-usage-display: first second",
  );
  const collapsed = cliErrorMessage(new Error("line one\r\nline two"));
  assert.ok(!collapsed.includes("\n"), "multi-line input must collapse to one line");
  assert.ok(!collapsed.includes("\r"), "carriage returns must collapse as well");
});

test("normalizeTuiEntry handles string, tuple, and invalid entries", () => {
  assert.deepStrictEqual(normalizeTuiEntry("./plugins/oc-go-usage-display.tsx"), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
  assert.deepStrictEqual(
    normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", { sidebar: true, statusline: false }]),
    { spec: "./plugins/oc-go-usage-display.tsx", sidebar: true, statusline: false },
  );
  assert.equal(normalizeTuiEntry(42), null);
  assert.deepStrictEqual(normalizeTuiEntry(["./plugins/oc-go-usage-display.tsx", "nope"]), {
    spec: "./plugins/oc-go-usage-display.tsx",
    sidebar: null,
    statusline: null,
  });
});

test("ensureTuiEntry round-trips through readTuiSelection in a temp dir", () => {
  withTempDir((dir) => {
    const written = ensureTuiEntry(dir, { sidebar: true, statusline: false });
    assert.equal(written.changed, true);
    assert.deepStrictEqual(readTuiSelection(dir), {
      found: true,
      entry: true,
      sidebar: true,
      statusline: false,
    });
    const repeated = ensureTuiEntry(dir, { sidebar: true, statusline: false });
    assert.equal(repeated.changed, false);
  });
});

// --- remove* round-trips (mkdtemp config dirs) ---

test("removePluginFiles removes a symlink install and reruns idempotently", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins", "oc-go-usage-display-v1");
    linkPluginFiles(REPO_DIR, dir, "symlink");
    assert.equal(fs.lstatSync(path.join(pluginsDir, "oc-go-usage-display.ts")).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(pluginsDir, "oc-go-usage-display.tsx")).isSymbolicLink(), true);
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.ts", "go_usage");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.tsx", "sidebar_content");
    const first = removePluginFiles(dir);
    assert.deepStrictEqual([...first.removed].sort(), [
      "oc-go-usage-display.ts",
      "oc-go-usage-display.tsx",
    ]);
    assert.deepStrictEqual(first.kept, []);
    const second = removePluginFiles(dir);
    assert.deepStrictEqual(second.removed, []);
    assert.deepStrictEqual(second.kept, []);
  });
});

test("removePluginFiles removes a copy (file) install and reruns idempotently", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins", "oc-go-usage-display-v1");
    linkPluginFiles(REPO_DIR, dir, "copy");
    assert.equal(fs.lstatSync(path.join(pluginsDir, "oc-go-usage-display.ts")).isFile(), true);
    assert.equal(fs.lstatSync(path.join(pluginsDir, "oc-go-usage-display.tsx")).isFile(), true);
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.ts", "go_usage");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.tsx", "sidebar_content");
    const first = removePluginFiles(dir);
    assert.deepStrictEqual([...first.removed].sort(), [
      "oc-go-usage-display.ts",
      "oc-go-usage-display.tsx",
    ]);
    const second = removePluginFiles(dir);
    assert.deepStrictEqual(second.removed, []);
    assert.deepStrictEqual(second.kept, []);
  });
});

test("linkPluginFiles copy mode refuses a directory target with an actionable error", () => {
  withTempDir((dir) => {
    const directoryTarget = path.join(dir, "plugins", "oc-go-usage-display-v1", "oc-go-usage-display.ts");
    fs.mkdirSync(directoryTarget, { recursive: true });
    assert.throws(
      () => linkPluginFiles(REPO_DIR, dir, "copy"),
      /cannot replace a directory with the plugin file/,
    );
    // The directory survives (nothing destructive happened before the check).
    assert.equal(fs.statSync(directoryTarget).isDirectory(), true);
  });
});

test("removePluginFiles keeps directories and removes only files", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins", "oc-go-usage-display-v1");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "oc-go-usage-display.ts"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "oc-go-usage-display.tsx"), "copy\n", "utf8");
    const result = removePluginFiles(dir);
    assert.deepStrictEqual(result.removed, ["oc-go-usage-display.tsx"]);
    assert.deepStrictEqual(result.kept, ["oc-go-usage-display.ts"]);
    assert.equal(fs.statSync(path.join(pluginsDir, "oc-go-usage-display.ts")).isDirectory(), true);
  });
});

test("opencode install migrates a flat v1 layout into its own subdirectory", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.ts", "oc-go-usage-display.tsx"]) {
      fs.writeFileSync(path.join(pluginsDir, fileName), "stale", "utf8");
    }
    fs.writeFileSync(
      path.join(dir, "opencode.jsonc"),
      JSON.stringify({ plugin: ["./plugins/oc-go-usage-display.ts", "other"] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "tui.json"),
      JSON.stringify({ plugin: [["./plugins/oc-go-usage-display.tsx", { sidebar: false, statusline: true }], "other"] }),
      "utf8",
    );

    linkPluginFiles(REPO_DIR, dir, "copy");

    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.ts")), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.tsx")), false);
    assertDeployedSelfContained(
      path.join(pluginsDir, "oc-go-usage-display-v1"),
      "oc-go-usage-display.ts",
      "go_usage",
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugin, [
      "./plugins/oc-go-usage-display-v1/oc-go-usage-display.ts",
      "other",
    ]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "tui.json"), "utf8")).plugin, [
      ["./plugins/oc-go-usage-display-v1/oc-go-usage-display.tsx", { sidebar: false, statusline: true }],
      "other",
    ]);
  });
});

test("opencode-v2 install moves a legacy flat v1 install out of discovery", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.ts", "oc-go-usage-display.tsx"]) {
      fs.writeFileSync(path.join(pluginsDir, fileName), "stale", "utf8");
    }
    fs.writeFileSync(
      path.join(dir, "opencode.jsonc"),
      JSON.stringify({ plugin: ["./plugins/oc-go-usage-display.ts"] }),
      "utf8",
    );

    linkPluginFiles(REPO_DIR, dir, "copy", "opencode-v2");

    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.ts")), false);
    assert.equal(
      fs.readFileSync(path.join(pluginsDir, "oc-go-usage-display-v1", "oc-go-usage-display.ts"), "utf8"),
      "stale",
      "the v1 install is moved out of v2 discovery, not deleted",
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugin, [
      "./plugins/oc-go-usage-display-v1/oc-go-usage-display.ts",
    ]);
    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display", "index.ts")), true);
  });
});

// --- host-aware install helpers (Kilo layout) ---

test("kilo install round-trips through its own bundles and plain tui entry", () => {
  withTempDir((dir) => {
    linkPluginFiles(REPO_DIR, dir, "copy", "kilo");
    const pluginsDir = path.join(dir, "plugins");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.kilo.ts", "go_usage");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.kilo.tsx", "sidebar_content");
    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.ts")), false);

    const server = ensureServerEntry(dir, { host: "kilo" });
    assert.equal(server.present, true);
    assert.equal(fs.existsSync(path.join(dir, "kilo.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "opencode.jsonc")), false);
    const kiloConfig = JSON.parse(fs.readFileSync(path.join(dir, "kilo.json"), "utf8"));
    // Kilo does not resolve `./...` against its config dir, so the entry is the
    // absolute installed path.
    assert.deepStrictEqual(kiloConfig.plugin, [path.join(dir, "plugins", "oc-go-usage-display.kilo.ts")]);

    const tui = ensureTuiEntry(dir, { host: "kilo" });
    assert.equal(tui.entry, true);
    assert.equal(tui.sidebar, null);
    const tuiConfig = JSON.parse(fs.readFileSync(path.join(dir, "tui.json"), "utf8"));
    assert.deepStrictEqual(tuiConfig.plugin, [path.join(dir, "plugins", "oc-go-usage-display.kilo.tsx")]);

    const report = checkHostInstall("kilo", dir, REPO_DIR);
    assert.deepStrictEqual(report.problems, []);

    const removed = removePluginFiles(dir, "kilo");
    assert.deepStrictEqual([...removed.removed].sort(), [
      "oc-go-usage-display.kilo.ts",
      "oc-go-usage-display.kilo.tsx",
    ]);
    assert.equal(removeServerEntry(dir, { host: "kilo" }).changed, true);
    assert.equal(removeTuiEntry(dir, "kilo").changed, true);
  });
});

test("kilo tui.json rejects sidebar/statusline options with a clear error", () => {
  withTempDir((dir) => {
    assert.throws(() => ensureTuiEntry(dir, { host: "kilo", sidebar: true }), /do not apply to kilo/);
    assert.throws(() => ensureTuiEntry(dir, { host: "kilo", statusline: false }), /do not apply to kilo/);
  });
});

test("opencode-v2 install deploys a discovered package and registers its server entry", () => {
  withTempDir((dir) => {
    linkPluginFiles(REPO_DIR, dir, "copy", "opencode-v2");
    const packageDir = path.join(dir, "plugins", "oc-go-usage-display");
    assertDeployedSelfContained(packageDir, "index.ts", "go_usage");
    assertDeployedSelfContained(packageDir, "tui.ts", "sidebar.content");

    const server = ensureServerEntry(dir, { host: "opencode-v2" });
    assert.equal(server.present, true);
    assert.equal(server.discovered, true);
    // A headless `serve` only loads what the config names, so discovery alone
    // is not enough: the package directory is the server entry as well.
    const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"));
    assert.equal("plugin" in config, false, "v2 config must not use the v1 `plugin` key");
    assert.deepStrictEqual(config.plugins, [packageDir]);
    // v2 has no TUI config file; the CLI half comes from discovery.
    assert.equal(fs.existsSync(path.join(dir, "cli.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "tui.json")), false);

    const tui = ensureTuiEntry(dir, { host: "opencode-v2" });
    assert.equal(tui.entry, true);
    assert.equal(tui.sidebar, null);
    assert.throws(() => ensureTuiEntry(dir, { host: "opencode-v2", sidebar: true }), /do not apply to opencode-v2/);

    const report = checkHostInstall("opencode-v2", dir, REPO_DIR);
    assert.deepStrictEqual(report.problems, []);

    assert.equal(removeServerEntry(dir, { host: "opencode-v2" }).changed, true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"));
    assert.deepStrictEqual(after.plugins, []);

    const removed = removePluginFiles(dir, "opencode-v2");
    assert.deepStrictEqual(removed.removed.sort(), ["index.ts", "tui.ts"]);
    assert.equal(fs.existsSync(packageDir), false);
  });
});

test("opencode-v2 install migrates flat v2 bundles and their config entries", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.v2.ts", "oc-go-usage-display.v2.tui.ts"]) {
      fs.writeFileSync(path.join(pluginsDir, fileName), "stale", "utf8");
    }
    const serverSpec = path.join(pluginsDir, "oc-go-usage-display.v2.ts");
    const tuiSpec = path.join(pluginsDir, "oc-go-usage-display.v2.tui.ts");
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify({ plugins: [serverSpec, "other"] }), "utf8");
    fs.writeFileSync(path.join(dir, "cli.json"), JSON.stringify({ plugins: [{ package: tuiSpec }, "other"] }), "utf8");

    linkPluginFiles(REPO_DIR, dir, "copy", "opencode-v2");

    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.v2.ts")), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display.v2.tui.ts")), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, "oc-go-usage-display", "index.ts")), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugins, ["other"]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "cli.json"), "utf8")).plugins, ["other"]);

    ensureServerEntry(dir, { host: "opencode-v2" });
    const migrated = JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugins;
    assert.deepStrictEqual(migrated, ["other", path.join(pluginsDir, "oc-go-usage-display")]);
  });
});

test("opencode-v2 remove clears a legacy flat v2 install", () => {
  withTempDir((dir) => {
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const fileName of ["oc-go-usage-display.v2.ts", "oc-go-usage-display.v2.tui.ts"]) {
      fs.writeFileSync(path.join(pluginsDir, fileName), "stale", "utf8");
    }
    const serverSpec = path.join(pluginsDir, "oc-go-usage-display.v2.ts");
    const tuiSpec = path.join(pluginsDir, "oc-go-usage-display.v2.tui.ts");
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify({ plugins: [serverSpec] }), "utf8");
    fs.writeFileSync(path.join(dir, "cli.json"), JSON.stringify({ plugins: [tuiSpec] }), "utf8");
    fs.writeFileSync(path.join(dir, "tui.json"), JSON.stringify({ plugin: [tuiSpec] }), "utf8");

    removePluginFiles(dir, "opencode-v2");
    removeServerEntry(dir, { host: "opencode-v2" });
    removeTuiEntry(dir, "opencode-v2");

    assert.equal(fs.existsSync(serverSpec), false);
    assert.equal(fs.existsSync(tuiSpec), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugins, []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "cli.json"), "utf8")).plugins, []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "tui.json"), "utf8")).plugin, []);
  });
});

test("parseTargetList and parseTargetChoice resolve target selections", () => {
  assert.deepStrictEqual(parseTargetList("kilo"), ["kilo"]);
  assert.deepStrictEqual(parseTargetList("all"), ["opencode", "kilo", "opencode-v2"]);
  assert.deepStrictEqual(parseTargetList("kilo,opencode"), ["kilo", "opencode"]);
  assert.deepStrictEqual(parseTargetList("opencode-v2"), ["opencode-v2"]);
  assert.throws(() => parseTargetList("vim"), /unknown target/);
  assert.deepStrictEqual(parseTargetChoice("", ["opencode", "kilo"]), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetChoice("2", ["opencode", "kilo"]), ["kilo"]);
  assert.deepStrictEqual(parseTargetChoice("1,2", ["opencode", "kilo"]), ["opencode", "kilo"]);
  assert.throws(() => parseTargetChoice("3", ["opencode", "kilo"]), /invalid selection/);
  assert.throws(() => parseTargetChoice("nope", ["opencode", "kilo"]), /invalid selection/);
});

test("removeServerEntry removes the entry and preserves comments on no-op rerun", () => {
  withTempDir((dir) => {
    const ensured = ensureServerEntry(dir);
    assert.equal(ensured.changed, true);
    const first = removeServerEntry(dir);
    assert.equal(first.changed, true);
    assert.equal(first.present, false);
    // No-op rerun must skip the write: seed comments and confirm untouched.
    const filePath = path.join(dir, "opencode.jsonc");
    const withComments = `{\n  // keep me\n  "plugin": []\n}\n`;
    fs.writeFileSync(filePath, withComments, "utf8");
    const second = removeServerEntry(dir);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), withComments);
  });
});

test("removeTuiEntry removes the entry and preserves comments on no-op rerun", () => {
  withTempDir((dir) => {
    const ensured = ensureTuiEntry(dir, { sidebar: true, statusline: true });
    assert.equal(ensured.changed, true);
    const first = removeTuiEntry(dir);
    assert.equal(first.changed, true);
    assert.equal(first.present, false);
    const filePath = path.join(dir, "tui.json");
    const withComments = `{\n  // keep me\n  "plugin": []\n}\n`;
    fs.writeFileSync(filePath, withComments, "utf8");
    const second = removeTuiEntry(dir);
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), withComments);
  });
});
