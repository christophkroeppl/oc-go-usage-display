#!/usr/bin/env node
// Post-build contract check for the deployed plugin bundles.
//
// `bun run build` compiles src/*.ts(x) with tsc and bundles the four deployed
// entries with esbuild (scripts/build-plugins.mjs). This script re-verifies the
// result on disk so a partial/renamed/mis-wired bundle can never be packed or
// published:
//   - all four bundles exist and are non-empty
//   - each carries its host banner (opencode/kilo + server/tui)
//   - each has exactly one export and it is the default export
//   - none has a relative import left (shared helpers are inlined)
//   - the tsc entries referenced by package.json exports exist
//
// Both host bundles ship in the same npm tarball; a missing Kilo bundle would
// otherwise only surface as a silently missing feature for Kilo users.

import * as fs from "node:fs";
import * as path from "node:path";

const BUNDLES = [
  {
    file: "dist/plugins/oc-go-usage-display.ts",
    banner: "oc-go-usage-display: opencode server plugin bundle",
    marker: "go_usage",
  },
  {
    file: "dist/plugins/oc-go-usage-display.kilo.ts",
    banner: "oc-go-usage-display: kilo server plugin bundle",
    marker: "go_usage",
  },
  {
    file: "dist/plugins/oc-go-usage-display.tsx",
    banner: "oc-go-usage-display: opencode tui plugin bundle",
    marker: "sidebar_content",
  },
  {
    file: "dist/plugins/oc-go-usage-display.kilo.tsx",
    banner: "oc-go-usage-display: kilo tui plugin bundle",
    marker: "sidebar_content",
  },
];

const TSC_ENTRIES = ["dist/index.js", "dist/tui.js", "dist/tui.kilo.js"];

function fail(message) {
  console.error(`verify-bundles: ${message}`);
  process.exit(1);
}

for (const { file, banner, marker } of BUNDLES) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    fail(`missing bundle: ${file} (run bun run build)`);
  }
  if (source.trim().length === 0) fail(`empty bundle: ${file}`);
  if (!source.includes(banner)) fail(`${file}: missing host banner "${banner}"`);
  if (!source.includes(marker)) fail(`${file}: missing entry marker "${marker}"`);
  const exportLines = source.match(/^export\b/gm) ?? [];
  const hasDefaultExport =
    /^export default\b/m.test(source) || /^export\s*\{[^}]*\bas\s+default\b[^}]*\}\s*;?/m.test(source);
  if (exportLines.length !== 1 || !hasDefaultExport) {
    fail(
      `${file}: expected exactly one default export, found ${exportLines.length} export statement(s)` +
        (hasDefaultExport ? "" : " (none of them default)"),
    );
  }
  if (/from\s*["']\.\.?\//.test(source)) {
    fail(`${file}: contains a relative import (shared helpers must be inlined)`);
  }
}

for (const file of TSC_ENTRIES) {
  if (!fs.existsSync(path.join(file))) fail(`missing compiled entry: ${file} (referenced by package.json exports)`);
}

console.log(`verify-bundles: OK (${BUNDLES.length} bundles, both hosts)`);
