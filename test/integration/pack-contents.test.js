// Integration tier: `bun pm pack` contents contract.
//
// Proves the published tarball ships the runtime bundles, the bin entry, and
// the sources, and that the deployed plugin bundles are self-contained (no
// relative `from "./..."` imports left) while still carrying the entry markers.
//
// Requires a prior `bun run build`: `bun pm pack` bundles dist/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

// The deployed bundles inline src/shared.ts, so no relative import may remain
// and the entry markers must be present (proves the shared helpers resolved in).
// The host banner is the same marker scripts/verify-bundles.mjs checks, so the
// tarball proves both hosts shipped, not just one.
function assertDeployedSelfContained(pluginsDir, fileName, marker, banner) {
  const content = fs.readFileSync(path.join(pluginsDir, fileName), "utf8");
  assert.ok(!content.includes('from "./shared'), `${fileName} must not import from "./shared"`);
  assert.ok(!content.includes("from './shared"), `${fileName} must not import from './shared'`);
  assert.ok(!content.includes('from "./'), `${fileName} must have no relative imports`);
  assert.ok(!content.includes("from './"), `${fileName} must have no relative imports`);
  assert.ok(content.includes(marker), `${fileName} must contain ${marker}`);
  assert.ok(content.includes(banner), `${fileName} must carry the banner "${banner}"`);
}

test("bun pm pack ships runtime bundles, bins, and sources; bundles are self-contained", () => {
  const tmp = makeTempDir();
  try {
    const packDir = path.join(tmp.dir, "pack");
    fs.mkdirSync(packDir, { recursive: true });
    run("bun", ["pm", "pack", "--destination", packDir], { cwd: REPO_DIR });

    const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, `expected exactly one tarball, saw ${tarballs.join(", ")}`);
    const tarball = path.join(packDir, tarballs[0]);

    const listing = new Set(run("tar", ["-tzf", tarball]).stdout.split("\n"));
    for (const entry of [
      "package/dist/shared.js",
      "package/dist/index.js",
      "package/dist/tui.js",
      "package/dist/tui.kilo.js",
      "package/dist/helpers.js",
      "package/dist/plugins/oc-go-usage-display.ts",
      "package/dist/plugins/oc-go-usage-display.kilo.ts",
      "package/dist/plugins/oc-go-usage-display.tsx",
      "package/dist/plugins/oc-go-usage-display.kilo.tsx",
      "package/bin/oc-go-usage-display-init.js",
      "package/src/shared.ts",
    ]) {
      assert.ok(listing.has(entry), `tarball missing ${entry}`);
    }

    const extractDir = path.join(tmp.dir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", extractDir]);

    const pluginsDir = path.join(extractDir, "package", "dist", "plugins");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.ts", "go_usage", "opencode server plugin bundle");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.kilo.ts", "go_usage", "kilo server plugin bundle");
    assertDeployedSelfContained(pluginsDir, "oc-go-usage-display.tsx", "sidebar_content", "opencode tui plugin bundle");
    assertDeployedSelfContained(
      pluginsDir,
      "oc-go-usage-display.kilo.tsx",
      "sidebar_content",
      "kilo tui plugin bundle",
    );
  } finally {
    tmp.cleanup();
  }
});
