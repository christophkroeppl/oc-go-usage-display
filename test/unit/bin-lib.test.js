// Unit tier: `bin/lib.js` — dependency-free install helpers (flag parsing,
// tui entry normalization, config-entry round-trips, plugin file removal).
// Temp dirs come from `test/helpers/tmp.js`; the real config dir is never used.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureServerEntry,
  ensureTuiEntry,
  linkPluginFiles,
  normalizeTuiEntry,
  parseOptionalToggle,
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
