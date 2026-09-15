// Unit tier: `dist/tui.js` registration contract, proven with a
// dependency-free stub `TuiPluginApi` (no PTY, no opencode binary, no network).
//
// `OPENCODE_GO_MOCK=1` makes the plugin's refresh path return the mock snapshot
// synchronously, so the factory resolves without touching auth.json or fetch.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENCODE_GO_MOCK = "1";

const tuiModule = await import("../../dist/tui.js");
const tui = tuiModule.default.tui;

// A stub host that records registrations and disposes like the real one, but
// depends on nothing. Only the surface the plugin actually uses is provided.
function makeStubApi() {
  const kv = new Map();
  const slotRegistrations = [];
  const commandRegistrations = [];
  const eventRegistrations = [];
  const disposers = [];

  const api = {
    kv: {
      ready: true,
      get(key, fallback) {
        return kv.has(key) ? kv.get(key) : fallback;
      },
      set(key, value) {
        kv.set(key, value);
      },
    },
    slots: {
      register(registration) {
        slotRegistrations.push(registration);
        return `slot-${slotRegistrations.length}`;
      },
    },
    command: {
      register(callback) {
        commandRegistrations.push(callback);
        return () => {};
      },
    },
    event: {
      on(type, handler) {
        eventRegistrations.push({ type, handler });
        return () => {};
      },
    },
    lifecycle: {
      onDispose(fn) {
        disposers.push(fn);
        return () => {};
      },
    },
    route: { current: { name: "session" } },
    client: { app: { async log() {} } },
  };

  return { api, slotRegistrations, commandRegistrations, eventRegistrations, disposers };
}

// Slot names captured by one `slots.register` call.
function registeredSlotNames(registration) {
  return Object.keys(registration.slots);
}

test("tui factory registers both surfaces at order 50 and wires dispose", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  await tui(api, { sidebar: true, statusline: true });

  assert.equal(tuiModule.default.id, "oc-go-usage-display");
  assert.equal(slotRegistrations.length, 2);
  for (const registration of slotRegistrations) {
    assert.equal(registration.order, 50);
  }
  const names = slotRegistrations.flatMap(registeredSlotNames).sort();
  assert.deepStrictEqual(names, ["session_prompt_right", "sidebar_content"]);

  assert.equal(disposers.length, 1);
  assert.equal(typeof disposers[0], "function");
  disposers[0](); // clears the poll interval so the runner exits cleanly
});

test("tui factory registers only sidebar_content when statusline is off", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  await tui(api, { sidebar: true, statusline: false });

  assert.equal(slotRegistrations.length, 1);
  assert.equal(slotRegistrations[0].order, 50);
  assert.deepStrictEqual(registeredSlotNames(slotRegistrations[0]), ["sidebar_content"]);
  disposers[0]();
});
