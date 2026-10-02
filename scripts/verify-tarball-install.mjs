#!/usr/bin/env node
// End-to-end install guard: a packed tarball must install into a clean project
// with a plain `npm install <tarball>`.
//
//   node scripts/verify-tarball-install.mjs
//
// This is the regression gate for the npm ERESOLVE failure: npm auto-installs
// the required peer @opencode-ai/plugin, which pulls @opentui/keymap ->
// @opentui/solid, so an exact pin on our optional UI peer
// (@opentui/solid "0.5.11") made a plain install unresolvable (npm 10.8.2).
// Deliberately no --legacy-peer-deps and no other flags: the install has to work
// for the users we document `npm install oc-go-usage-display@latest` to.
//
// Skips (exit 0) when npm is not on PATH, e.g. the bun-only Docker gate; the
// static range check (scripts/check-peer-ranges.mjs) still runs there.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RESOLVE_ERRORS = ["ERESOLVE", "unable to resolve dependency tree"];

// Registered before use and removed on every exit path -- fail() exits the
// process directly, which skips a surrounding finally block.
const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fail(message) {
  console.error(`verify-tarball-install: ${message}`);
  process.exit(1);
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function npm(args, cwd) {
  return spawnSync("npm", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function tail(text, lines = 20) {
  return text.split("\n").filter((line) => line.trim() !== "").slice(-lines).join("\n");
}

const version = npm(["--version"], REPO_DIR);
if (version.error?.code === "ENOENT") {
  console.log(`verify-tarball-install: skipped (npm not on PATH; the install guard needs a real npm)`);
  process.exit(0);
}

const packDir = tempDir("oc-go-usage-pack-");
const packed = npm(["pack", "--pack-destination", packDir], REPO_DIR);
if (packed.status !== 0) fail(`npm pack failed:\n${tail(combinedOutput(packed))}`);

const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== 1) {
  fail(`npm pack produced ${tarballs.length} tarball(s) in ${packDir}: ${tarballs.join(", ") || "(none)"}`);
}
const tarball = path.join(packDir, tarballs[0]);

const projectDir = tempDir("oc-go-usage-install-");
fs.writeFileSync(
  path.join(projectDir, "package.json"),
  `${JSON.stringify({ name: "oc-go-usage-install-check", version: "0.0.0", private: true }, null, 2)}\n`,
);

const installed = npm(["install", tarball], projectDir);
const output = combinedOutput(installed);
const resolveErrors = RESOLVE_ERRORS.filter((marker) => output.includes(marker));
if (installed.status !== 0 || resolveErrors.length > 0) {
  const reason =
    installed.status !== 0 ? `npm install exited ${installed.status}` : `output mentions ${resolveErrors.join(" / ")}`;
  fail(
    `plain \`npm install ${tarballs[0]}\` in a clean project did not succeed (${reason}). ` +
      "A plain install must work; do not document --legacy-peer-deps.\n" +
      `${tail(output)}`,
  );
}

console.log(`verify-tarball-install: OK ${tarballs[0]} installs clean with npm ${(version.stdout ?? "").trim()}`);