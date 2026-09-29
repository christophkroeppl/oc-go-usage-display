#!/usr/bin/env node
// Run each test file in its own bun process.
//
// `bun test <dir>/*.test.js` loads every file into one process, so modules are
// shared: an env-mutating suite (e.g. test/integration/cookie-redirects) that
// imports `dist/*` freezes module-level paths like CONFIG_DIR for every other
// file, making results order-dependent. One process per file matches the
// isolation `node --test` used to provide and keeps the hermeticity guarantees.
//
// Usage: node scripts/run-test-files.mjs <dir>

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2];
if (typeof dir !== "string" || dir.length === 0) {
  console.error("usage: node scripts/run-test-files.mjs <dir>");
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.error(`test directory not found: ${dir}`);
  process.exit(2);
}

const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error(`no *.test.js files in ${dir}`);
  process.exit(2);
}

const failed = [];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync("bun", ["test", file], { stdio: "inherit" });
  if (result.status !== 0) failed.push(file);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} test file(s) failed:`);
  for (const file of failed) console.error(`  - ${file}`);
  process.exit(1);
}
console.log(`\nall ${files.length} test file(s) passed`);
