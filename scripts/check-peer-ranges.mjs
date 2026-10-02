#!/usr/bin/env node
// peerDependencies range guard.
//
//   node scripts/check-peer-ranges.mjs
//
// npm auto-installs REQUIRED peers. @opencode-ai/plugin is required and pulls
// @opentui/keymap, which pulls its own @opentui/solid. An exact pin on our
// optional UI peers therefore made a plain `npm install oc-go-usage-display`
// fail with ERESOLVE on npm 10.8.2 (keymap wants @opentui/solid 0.5.14, we
// pinned 0.5.11). Ranges keep the resolver satisfiable while still declaring
// the floors we build and test against.
//
// So: the two optional UI peers must never be exact pins again, and the two
// host SDK peers must keep caret ranges. scripts/verify-tarball-install.mjs
// covers the same regression end to end; this is the cheap static half.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Exact pin = a bare x.y.z with no range operator. Anything else (^, ~, >=, x,
// *) is a range and satisfies the resolver.
const EXACT_PIN = /^\d+\.\d+\.\d+$/;

// These must stay ranges: an exact pin collides with the @opentui/solid that
// @opentui/keymap (a transitive dep of the required @opencode-ai/plugin) brings.
const OPTIONAL_UI_PEERS = ["@opentui/solid", "solid-js"];
// These must stay caret ranges: a narrower or pinned SDK range breaks installs
// against a host newer than the one we were built on.
const CARET_PEERS = ["@opencode-ai/plugin", "@kilocode/plugin"];

const ERESOLVE_NOTE =
  "an exact pin on these optional UI peers re-creates the npm ERESOLVE failure " +
  "(npm auto-installs the required @opencode-ai/plugin, which pulls " +
  "@opentui/keymap -> @opentui/solid, incompatible with a bare x.y.z pin); " +
  "declare a range such as ^0.5.11 / ^1.9.12";

function fail(message) {
  console.error(`check-peer-ranges: ${message}`);
  process.exit(1);
}

const pkgPath = path.join(REPO_DIR, "package.json");
if (!fs.existsSync(pkgPath)) fail(`no package.json at ${pkgPath}`);

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (error) {
  fail(`cannot parse package.json: ${error.message}`);
}

const peers = pkg.peerDependencies;
if (peers === undefined || peers === null || typeof peers !== "object") {
  fail("package.json has no peerDependencies object");
}

for (const name of [...OPTIONAL_UI_PEERS, ...CARET_PEERS]) {
  if (typeof peers[name] !== "string") fail(`peerDependencies.${name} is missing or not a string`);
}

for (const name of OPTIONAL_UI_PEERS) {
  if (EXACT_PIN.test(peers[name])) fail(`peerDependencies.${name} is pinned to "${peers[name]}" — ${ERESOLVE_NOTE}`);
}

for (const name of CARET_PEERS) {
  if (!peers[name].startsWith("^")) {
    fail(`peerDependencies.${name} is "${peers[name]}", expected a caret range such as "^1.18.0"`);
  }
}

const summary = [...OPTIONAL_UI_PEERS, ...CARET_PEERS].map((name) => `${name} ${peers[name]}`).join(", ");
console.log(`check-peer-ranges: OK (${summary})`);