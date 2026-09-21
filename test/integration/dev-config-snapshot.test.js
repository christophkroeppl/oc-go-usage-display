// Integration tier: `scripts/dev-config-snapshot.sh` save/restore round-trip.
//
// Every case drives the real script with explicit tmp `--config-dir` and
// `--backup-dir` flags plus an isolated HOME, so the real
// `~/.config/opencode` is never part of a command. Case (d) additionally
// proves the explicit flags win over HOME/`OPENCODE_CONFIG_DIR` by asserting
// both fake defaults stay empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT_SCRIPT = path.join(REPO_DIR, "scripts", "dev-config-snapshot.sh");
const RELS = [
  "opencode.jsonc",
  "tui.json",
  "plugins/oc-go-usage-display.ts",
  "plugins/oc-go-usage-display.tsx",
  "oc-go-usage-display.json",
  "oc-go-usage-display-cache.json",
];

function runSnapshot(args, { env = {} } = {}) {
  const base = { ...process.env };
  // Never inherit an ambient config pointer: each case passes explicit flags.
  delete base.OPENCODE_CONFIG_DIR;
  const result = spawnSync("bash", [SNAPSHOT_SCRIPT, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Save always passes explicit tmp flags and returns the printed snapshot dir.
function save(tmp, configDir, env = {}) {
  const backupDir = path.join(tmp.dir, "snapshots");
  const result = runSnapshot(["save", "--config-dir", configDir, "--backup-dir", backupDir], { env });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = result.stdout.trim().split("\n").at(-1);
  assert.ok(snapshot.startsWith(`${backupDir}/`), `absolute snapshot path expected, got '${snapshot}'`);
  return snapshot;
}

function restore(snapshot, configDir, env = {}) {
  return runSnapshot(["restore", "--backup-dir", snapshot, "--config-dir", configDir], { env });
}

function manifest(snapshot) {
  return fs.readFileSync(path.join(snapshot, "manifest"), "utf8").trim().split("\n");
}

test("dev-config-snapshot: fresh config round-trips back to fresh", () => {
  const tmp = makeTempDir();
  try {
    const configDir = path.join(tmp.dir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    const snapshot = save(tmp, configDir, { HOME: path.join(tmp.dir, "home") });

    const lines = manifest(snapshot);
    assert.equal(lines.length, RELS.length, lines.join("\n"));
    assert.deepEqual(lines.filter((line) => !line.startsWith("absent\t")), [], "fresh config has no present entries");

    // Simulate the dev install creating config files after the snapshot.
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "plugins", "oc-go-usage-display.ts"), "// dev server\n");
    fs.writeFileSync(path.join(configDir, "plugins", "oc-go-usage-display.tsx"), "// dev tui\n");
    fs.writeFileSync(path.join(configDir, "oc-go-usage-display.json"), "{}\n");
    fs.writeFileSync(path.join(configDir, "tui.json"), "{}\n");

    const result = restore(snapshot, configDir);
    assert.equal(result.code, 0, result.stderr);
    for (const rel of RELS) {
      assert.equal(fs.existsSync(path.join(configDir, rel)), false, `${rel} must be removed again`);
    }
    assert.equal(fs.existsSync(path.join(configDir, "plugins")), false, "empty plugins/ must be removed");
  } finally {
    tmp.cleanup();
  }
});

test("dev-config-snapshot: file, symlink, and 0600 secret are restored intact", () => {
  const tmp = makeTempDir();
  try {
    const configDir = path.join(tmp.dir, "config");
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });

    const jsonc = path.join(configDir, "opencode.jsonc");
    fs.writeFileSync(jsonc, '{ "plugin": ["original"] }\n');
    fs.chmodSync(jsonc, 0o640);
    const secret = path.join(configDir, "oc-go-usage-display.json");
    fs.writeFileSync(secret, '{"token":"s3cret"}\n');
    fs.chmodSync(secret, 0o600);
    const linkTarget = path.join(tmp.dir, "served.ts");
    fs.writeFileSync(linkTarget, "export {};\n");
    const tsLink = path.join(pluginsDir, "oc-go-usage-display.ts");
    fs.symlinkSync(linkTarget, tsLink);
    fs.writeFileSync(path.join(pluginsDir, "oc-go-usage-display.tsx"), "// tui\n");

    const snapshot = save(tmp, configDir, { HOME: path.join(tmp.dir, "home") });
    const present = manifest(snapshot).filter((line) => line.startsWith("present\t"));
    assert.equal(present.length, 4, manifest(snapshot).join("\n"));

    // Mutate: overwrite a file, delete the secret, replace the symlink by a file.
    fs.writeFileSync(jsonc, "// mutated\n");
    fs.chmodSync(jsonc, 0o644);
    fs.rmSync(secret);
    fs.rmSync(tsLink);
    fs.writeFileSync(tsLink, "// replaced\n");

    const result = restore(snapshot, configDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(jsonc, "utf8"), '{ "plugin": ["original"] }\n');
    assert.equal(fs.statSync(jsonc).mode & 0o777, 0o640, "jsonc mode must be restored");
    assert.equal(fs.readFileSync(secret, "utf8"), '{"token":"s3cret"}\n');
    assert.equal(fs.statSync(secret).mode & 0o777, 0o600, "secret mode must never widen");
    assert.equal(fs.lstatSync(tsLink).isSymbolicLink(), true, "restored as symlink, not a copy");
    assert.equal(fs.readlinkSync(tsLink), linkTarget);
  } finally {
    tmp.cleanup();
  }
});

test("dev-config-snapshot: absent entries stay absent and restore is a no-op", () => {
  const tmp = makeTempDir();
  try {
    const configDir = path.join(tmp.dir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    const snapshot = save(tmp, configDir, { HOME: path.join(tmp.dir, "home") });

    const result = restore(snapshot, configDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readdirSync(configDir).length, 0, "restore must not create absent paths");

    // A second restore over an untouched config is still a clean no-op.
    const again = restore(snapshot, configDir);
    assert.equal(again.code, 0, again.stderr);
  } finally {
    tmp.cleanup();
  }
});

test("dev-config-snapshot: explicit tmp flags never touch the default config dirs", () => {
  const tmp = makeTempDir();
  try {
    const home = path.join(tmp.dir, "home");
    const homeConfig = path.join(home, ".config", "opencode");
    const envConfig = path.join(tmp.dir, "env-config");
    const configDir = path.join(tmp.dir, "config");
    fs.mkdirSync(homeConfig, { recursive: true });
    fs.mkdirSync(envConfig, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.jsonc"), "{}\n");

    const env = { HOME: home, OPENCODE_CONFIG_DIR: envConfig };
    const snapshot = save(tmp, configDir, env);
    assert.ok(
      manifest(snapshot).includes("present\topencode.jsonc"),
      "explicit --config-dir must win over HOME/OPENCODE_CONFIG_DIR",
    );

    fs.rmSync(path.join(configDir, "opencode.jsonc"));
    const result = restore(snapshot, configDir, env);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(fs.existsSync(path.join(configDir, "opencode.jsonc")), true, "explicit dir restored");
    assert.deepEqual(fs.readdirSync(homeConfig), [], "~/.config/opencode must stay untouched");
    assert.deepEqual(fs.readdirSync(envConfig), [], "$OPENCODE_CONFIG_DIR must stay untouched");
  } finally {
    tmp.cleanup();
  }
});
