// Plugin-loader contract regression test (no host required).
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

import { test } from "node:test";
import assert from "node:assert/strict";

const serverModule = await import("../dist/index.js");
const tuiModule = await import("../dist/tui.js");

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
