// Integration tier: host credential isolation.
//
// The opencode and Kilo bundles read different auth stores: an OC Go login in
// Kilo must never be shadowed by (or leak into) opencode's store, and vice
// versa. This suite writes fixture auth.json files with distinct fake keys into
// a hermetic tmp root and asserts readAuthJsonApiKey(host) resolves only that
// host's file, including the KILO_CONFIG_DIR config fallback.
//
// Requires a prior `bun run build`: this tier imports dist/shared.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAuthJsonApiKey } from "../../dist/shared.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-hosts-"));
const ENV = {
  HOME: path.join(ROOT, "home"),
  XDG_CONFIG_HOME: path.join(ROOT, "xdg-config"),
  XDG_DATA_HOME: path.join(ROOT, "xdg-data"),
};
for (const dir of [ENV.XDG_CONFIG_HOME, ENV.XDG_DATA_HOME]) {
  fs.mkdirSync(dir, { recursive: true });
}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const homedir = () => ENV.HOME;

function writeAuthJson(filePath, key) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ "opencode-go": { type: "api", key } })}\n`, "utf8");
}

writeAuthJson(path.join(ENV.XDG_DATA_HOME, "opencode", "auth.json"), "fake-opencode-key");
writeAuthJson(path.join(ENV.XDG_DATA_HOME, "kilo", "auth.json"), "fake-kilo-key");

test("each host reads only its own auth.json", () => {
  assert.equal(readAuthJsonApiKey("opencode", ENV, homedir), "fake-opencode-key");
  assert.equal(readAuthJsonApiKey("kilo", ENV, homedir), "fake-kilo-key");
});

test("a legacy config-dir auth.json only counts for its own host", () => {
  writeAuthJson(path.join(ENV.XDG_CONFIG_HOME, "kilo", "auth.json"), "fake-kilo-config-key");
  // opencode's data store still wins for opencode; Kilo keeps its data store.
  assert.equal(readAuthJsonApiKey("opencode", ENV, homedir), "fake-opencode-key");
  assert.equal(readAuthJsonApiKey("kilo", ENV, homedir), "fake-kilo-key");
});

test("KILO_CONFIG_DIR auth.json is read as the Kilo config fallback", () => {
  // No data store for this env, so the config-dir fallback is what resolves.
  const env = {
    ...ENV,
    XDG_DATA_HOME: path.join(ROOT, "custom-data"),
    KILO_CONFIG_DIR: path.join(ROOT, "custom-kilo"),
  };
  writeAuthJson(path.join(env.KILO_CONFIG_DIR, "auth.json"), "fake-kilo-custom-key");
  assert.equal(readAuthJsonApiKey("kilo", env, homedir), "fake-kilo-custom-key");
});

test("opencode keeps the opencode-go then opencode key order in its config fallback", () => {
  const env = { ...ENV, XDG_DATA_HOME: path.join(ROOT, "empty-data") };
  const configDir = path.join(env.XDG_CONFIG_HOME, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "auth.json"),
    `${JSON.stringify({ opencode: { key: "fake-opencode-provider-key" } })}\n`,
    "utf8",
  );
  assert.equal(readAuthJsonApiKey("opencode", env, homedir), "fake-opencode-provider-key");
});
