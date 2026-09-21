#!/usr/bin/env node
// Tarball contract check: a packed tarball must ship both hosts' bundles.
//
//   node scripts/verify-tarball.mjs <tarball.tgz> [more.tgz ...]
//
// Used by dev-build.yml (dev artifact) and publish.yml (npm pack + the
// registry tarball after publish). The integration pack-contents test covers
// the same filenames plus self-containedness inside the Docker gate.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const REQUIRED = [
  "package/dist/plugins/oc-go-usage-display.ts",
  "package/dist/plugins/oc-go-usage-display.kilo.ts",
  "package/dist/plugins/oc-go-usage-display.tsx",
  "package/dist/plugins/oc-go-usage-display.kilo.tsx",
  "package/dist/index.js",
  "package/dist/tui.js",
  "package/dist/tui.kilo.js",
  "package/bin/oc-go-usage-display-init.js",
];

function fail(message) {
  console.error(`verify-tarball: ${message}`);
  process.exit(1);
}

const tarballs = process.argv.slice(2);
if (tarballs.length === 0) {
  fail("usage: node scripts/verify-tarball.mjs <tarball.tgz> [more.tgz ...]");
}

for (const tarball of tarballs) {
  if (!fs.existsSync(tarball)) fail(`no such tarball: ${tarball}`);
  const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (listing.status !== 0) {
    fail(`tar -tzf failed for ${tarball}: ${(listing.stderr ?? "").trim()}`);
  }
  const entries = new Set((listing.stdout ?? "").split("\n"));
  for (const required of REQUIRED) {
    if (!entries.has(required)) fail(`${tarball}: missing ${required}`);
  }
  console.log(`verify-tarball: OK ${tarball} (opencode + kilo bundles present)`);
}
