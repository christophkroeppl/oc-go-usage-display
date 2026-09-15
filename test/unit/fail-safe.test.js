// Unit tier: fail-safe guarantees for the compiled plugin entry modules.
//
// OpenCode's loader collects plugin hook objects and later dereferences
// `hook.config` / `hook.provider`; a null/undefined/non-object entry (or a
// throwing import/factory) crashes startup. These tests pin the invariants
// that keep OpenCode bootable even when this plugin's initialization, host API
// surface, or inputs are hostile.
//
// Requires a prior `npm run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Hermeticity: dist entries resolve auth/cache/config paths at import time.
// Redirect HOME + every XDG root, force the deterministic mock, and drop
// credential vars BEFORE importing them so this suite can never read the
// developer's real auth.json or hit the network.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-failsafe-"));
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
// Surface selection must come from this suite, never from the ambient shell.
delete process.env.OPENCODE_GO_SIDEBAR;
delete process.env.OPENCODE_GO_STATUSLINE;
delete process.env.OPENCODE_GO_DISPLAY;

for (const dir of ["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "config"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

// A value the loader may dereference (`hooks.config` / `hooks.provider`) must
// be a plain object; null, undefined, arrays and primitives all crash it.
function isHooks(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every enumerable hook entry must be present and non-nullish, and any nested
// `tool` map must not smuggle a null/undefined tool definition.
function assertCleanHookEntries(hooks, label) {
  assert.ok(isHooks(hooks), `${label} must be a hooks object`);
  for (const [key, value] of Object.entries(hooks)) {
    assert.notEqual(value, undefined, `${label}.${key} must not be undefined`);
    assert.notEqual(value, null, `${label}.${key} must not be null`);
  }
  if (hooks.tool !== undefined) {
    assert.ok(isHooks(hooks.tool), `${label}.tool must be an object`);
    for (const [name, definition] of Object.entries(hooks.tool)) {
      assert.notEqual(definition, undefined, `${label}.tool.${name} must not be undefined`);
      assert.notEqual(definition, null, `${label}.tool.${name} must not be null`);
    }
  }
}

// A host that explodes on every method the factory touches. `onDispose` stays
// functional so the created poll timer can be torn down by the test.
function makeThrowingTuiApi(disposers) {
  const boom = () => {
    throw new Error("host api unavailable");
  };
  return {
    kv: { ready: true, get: boom, set: boom },
    slots: { register: boom },
    command: { register: boom, trigger: boom, show: boom },
    event: { on: boom },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn) {
        disposers.push(fn);
        return () => {};
      },
    },
    route: { current: { name: "session" } },
    client: { app: { async log() { throw new Error("log unavailable"); } } },
  };
}

test("dist entry modules import without throwing", async () => {
  await assert.doesNotReject(async () => {
    await import("../../dist/index.js");
  });
  await assert.doesNotReject(async () => {
    await import("../../dist/tui.js");
  });
});

test("server factory resolves to a clean hooks object for malformed inputs", async () => {
  const { default: serverModule } = await import("../../dist/index.js");
  const inputs = [{}, undefined, { directory: "/nonexistent" }];
  for (const input of inputs) {
    const hooks = await serverModule.server(input, undefined);
    assertCleanHookEntries(hooks, `server(${JSON.stringify(input)})`);
  }
});

test("server tool execution returns a line plus a JSON snapshot line", async () => {
  const { default: serverModule } = await import("../../dist/index.js");
  const hooks = await serverModule.server({}, undefined);
  const definition = hooks.tool?.go_usage;
  assert.equal(typeof definition?.execute, "function");
  const output = await definition.execute({}, undefined);
  assert.equal(typeof output, "string");
  const [line, ...jsonLines] = output.split("\n");
  assert.match(line, /^Go /);
  const snapshot = JSON.parse(jsonLines.join("\n"));
  assert.equal(snapshot.source, "mock");
  assert.equal(snapshot.rolling?.percent, 42);
});

test("server factory resolves cleanly with a throwing host log client", async () => {
  const { default: serverModule } = await import("../../dist/index.js");
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  try {
    const hooks = await serverModule.server(
      {
        client: {
          app: {
            log() {
              throw new Error("host log unavailable");
            },
          },
        },
      },
      undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertCleanHookEntries(hooks, "server(throwing host log)");
    assert.equal(typeof hooks.tool?.go_usage?.execute, "function");
    assert.deepStrictEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("tui factory resolves when host API methods throw", async () => {
  const { default: tuiModule } = await import("../../dist/tui.js");
  const disposers = [];
  const api = makeThrowingTuiApi(disposers);

  try {
    await assert.doesNotReject(() => tuiModule.tui(api, undefined, undefined));
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("tui factory leaves no unhandled rejection under a throwing host", async () => {
  const { default: tuiModule } = await import("../../dist/tui.js");
  const disposers = [];
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  try {
    await tuiModule.tui(makeThrowingTuiApi(disposers), undefined, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    for (const dispose of disposers) dispose();
  }
});

test("tui dispose isolates a throwing teardown", async () => {
  const { default: tuiModule } = await import("../../dist/tui.js");
  const disposers = [];
  const api = {
    kv: { ready: true, get: (_key, fallback) => fallback, set: () => {} },
    slots: { register: () => "slot" },
    command: { register: () => () => {} },
    event: {
      on: () => () => {
        throw new Error("unsubscribe failed");
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn) {
        disposers.push(fn);
        return () => {};
      },
    },
    route: { current: { name: "session" } },
    client: { app: { async log() {} } },
  };

  try {
    await tuiModule.tui(api, { sidebar: true, statusline: false }, undefined);
    assert.equal(disposers.length, 1);
    assert.doesNotThrow(() => disposers[0]());
  } finally {
    for (const dispose of disposers) dispose();
  }
});
