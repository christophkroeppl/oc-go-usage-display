// Unit tier: `bin/lib.js` — dependency-free install helpers (flag parsing,
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
    linkPluginFiles(REPO_DIR, dir, "symlink");
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.ts")).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.tsx")).isSymbolicLink(), true);
    assertDeployedSelfContained(path.join(dir, "plugins"), "oc-go-usage-display.ts", "go_usage");
    assertDeployedSelfContained(path.join(dir, "plugins"), "oc-go-usage-display.tsx", "sidebar_content");
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
    linkPluginFiles(REPO_DIR, dir, "copy");
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.ts")).isFile(), true);
    assert.equal(fs.lstatSync(path.join(dir, "plugins", "oc-go-usage-display.tsx")).isFile(), true);
    assertDeployedSelfContained(path.join(dir, "plugins"), "oc-go-usage-display.ts", "go_usage");
    assertDeployedSelfContained(path.join(dir, "plugins"), "oc-go-usage-display.tsx", "sidebar_content");
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
    const directoryTarget = path.join(dir, "plugins", "oc-go-usage-display.ts");
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
    const pluginsDir = path.join(dir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "oc-go-usage-display.ts"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "oc-go-usage-display.tsx"), "copy\n", "utf8");
    const result = removePluginFiles(dir);
    assert.deepStrictEqual(result.removed, ["oc-go-usage-display.tsx"]);
    assert.deepStrictEqual(result.kept, ["oc-go-usage-display.ts"]);
    assert.equal(fs.statSync(path.join(pluginsDir, "oc-go-usage-display.ts")).isDirectory(), true);
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

test("parseTargetList and parseTargetChoice resolve target selections", () => {
  assert.deepStrictEqual(parseTargetList("kilo"), ["kilo"]);
  assert.deepStrictEqual(parseTargetList("all"), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetList("kilo,opencode"), ["kilo", "opencode"]);
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
