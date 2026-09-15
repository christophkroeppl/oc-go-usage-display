// Integration tier: plugin-loader contract regression test (no host required).
//
// OpenCode's server loader enumerates every runtime export of a plugin entry
// module and, when the default is not a `{ id, server }` module object,
// invokes each export as a plugin factory. A stray named export
// (`formatResetDuration(input)` -> null) previously pushed null into the hooks
// array and crashed `Provider.list`.
//
// This suite dynamically imports the compiled entry modules and asserts the
// structural contract that prevents it: exactly one export, it is the default
// module, and no other function export can be mistaken for a plugin factory.
//
// The deployed bundles (dist/plugins/*.ts[x]) are validated by
// scripts/build-plugins.mjs, which fails the build on the same contract.
//
// Requires a prior `npm run build`: this tier imports the compiled dist/*.js
// output below.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Hermeticity: the compiled entries resolve auth/cache/config paths at import
// time (CONFIG_DIR is derived from os.homedir()). Redirect HOME and every XDG
// root, force the deterministic mock, and drop credential vars BEFORE the
// dynamic imports so this suite can never read the developer's real
// ~/.local/share/opencode/auth.json or hit the network.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-contract-"));
process.env.OPENCODE_GO_MOCK = "1";
process.env.HOME = path.join(ROOT, "home");
process.env.XDG_CONFIG_HOME = path.join(ROOT, "xdg-config");
process.env.XDG_DATA_HOME = path.join(ROOT, "xdg-data");
process.env.XDG_STATE_HOME = path.join(ROOT, "xdg-state");
process.env.XDG_CACHE_HOME = path.join(ROOT, "xdg-cache");
process.env.OPENCODE_CONFIG_DIR = path.join(ROOT, "config");
delete process.env.OPENCODE_GO_API_KEY;
delete process.env.OPENCODE_GO_AUTH_COOKIE;
delete process.env.OPENCODE_GO_WORKSPACE_ID;

for (const dir of ["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "config"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const serverModule = await import("../../dist/index.js");
const tuiModule = await import("../../dist/tui.js");

const ENTRY_MODULES = [
  { name: "dist/index.js", mod: serverModule, key: "server" },
  { name: "dist/tui.js", mod: tuiModule, key: "tui" },
];

// A Hooks value is a plain object (the loader reads properties off it, e.g.
// `hooks.provider`). null/undefined/primitives are non-Hooks.
function isHooks(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("server entry exports only the default plugin module", () => {
  assert.deepStrictEqual(Object.keys(serverModule), ["default"]);
  assert.equal(serverModule.default.id, "oc-go-usage-display");
  assert.equal(typeof serverModule.default.server, "function");
  assert.equal(serverModule.default.tui, undefined);
});

test("tui entry exports only the default plugin module", () => {
  assert.deepStrictEqual(Object.keys(tuiModule), ["default"]);
  assert.equal(tuiModule.default.id, "oc-go-usage-display");
  assert.equal(typeof tuiModule.default.tui, "function");
  assert.equal(tuiModule.default.server, undefined);
});

test("legacy export enumeration finds no export that is not a plugin module", async () => {
  for (const { name, mod, key } of ENTRY_MODULES) {
    // The loader only treats the default as a module when it carries the
    // expected factory key; otherwise it falls back to invoking every export.
    assert.equal(typeof mod.default[key], "function", `${name} default must expose ${key}`);

    for (const [exportName, value] of Object.entries(mod)) {
      if (exportName === "default") continue;
      // Only function exports are invoked as plugin factories by the loader.
      if (typeof value !== "function") continue;
      const hooks = await value({}, undefined);
      assert.ok(
        isHooks(hooks),
        `${name} export "${exportName}" returned a non-Hooks value and would crash the loader`,
      );
    }
  }
});

// Guards the module-top redirect: if it regresses, config/auth resolution
// escapes to the real home and this fails loudly instead of silently touching
// it (CONFIG_DIR and authJsonPaths are the paths dist/* actually reads).
test("config and auth path resolution stay inside the hermetic tmp root", async () => {
  const { CONFIG_DIR, authJsonPaths } = await import("../../dist/shared.js");
  for (const candidate of [CONFIG_DIR, ...authJsonPaths()]) {
    const relative = path.relative(ROOT, candidate);
    assert.ok(
      relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative),
      `path escaped the hermetic root: ${candidate}`,
    );
  }
});
