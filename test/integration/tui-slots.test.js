// Integration tier: `dist/tui.js` (opencode, order 50) and `dist/tui.kilo.js`
// (Kilo, order 125) registration contracts, proven with a dependency-free stub
// `TuiPluginApi` (no PTY, no opencode/kilo binary, no network).
//
// These assert the registered `order` value; the *rendered* consequence of that
// order is pinned separately by the e2e tier (assertSidebarOrder in
// test/helpers/tui.js), which is what actually guards the constant.
//
// `OPENCODE_OC_GO_MOCK=1` makes the plugin's refresh path return the mock snapshot
// synchronously, so the factory resolves without touching auth.json or fetch.
// HOME/XDG are redirected into a tmp root before the imports anyway, so a future
// mock regression cannot reach the developer's real `~/.local/share/{opencode,
// kilo}/auth.json` now that both host entries are loaded here.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-tui-slots-"));
process.env.OPENCODE_OC_GO_MOCK = "1";
process.env.KILO_OC_GO_MOCK = "1";
process.env.HOME = path.join(ROOT, "home");
process.env.XDG_CONFIG_HOME = path.join(ROOT, "xdg-config");
process.env.XDG_DATA_HOME = path.join(ROOT, "xdg-data");
process.env.OPENCODE_CONFIG_DIR = path.join(ROOT, "config");

// Both hosts' env spellings must be neutralized: an ambient value under either
// prefix would reach the entry we are about to import.
for (const prefix of ["OPENCODE_OC_GO_", "KILO_OC_GO_"]) {
  for (const suffix of ["API_KEY", "AUTH_COOKIE", "WORKSPACE_ID", "DISPLAY", "SIDEBAR", "STATUSLINE", "SIDEBAR_MODE"]) {
    delete process.env[`${prefix}${suffix}`];
  }
}
for (const dir of ["home", "xdg-config", "xdg-data", "config"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const tuiModule = await import("../../dist/tui.js");
const tui = tuiModule.default.tui;
const kiloTuiModule = await import("../../dist/tui.kilo.js");
const kiloTui = kiloTuiModule.default.tui;

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

test("opencode tui factory registers both surfaces at order 50 and wires dispose", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
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
  } finally {
    // Always clear the 60s poll interval, even if an assertion above failed:
    // a leaked interval keeps the test process alive.
    for (const dispose of disposers) dispose();
  }
});

test("opencode tui factory registers only sidebar_content when statusline is off", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    await tui(api, { sidebar: true, statusline: false });

    assert.equal(slotRegistrations.length, 1);
    assert.equal(slotRegistrations[0].order, 50);
    assert.deepStrictEqual(registeredSlotNames(slotRegistrations[0]), ["sidebar_content"]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

// Kilo renders the widget between its Context (100) and Token Usage (150)
// panels: 100 < 125 < 150.
test("kilo tui factory registers both surfaces at order 125 and wires dispose", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    await kiloTui(api, { sidebar: true, statusline: true });

    assert.equal(kiloTuiModule.default.id, "oc-go-usage-display");
    assert.equal(slotRegistrations.length, 2);
    for (const registration of slotRegistrations) {
      assert.equal(registration.order, 125);
    }
    const names = slotRegistrations.flatMap(registeredSlotNames).sort();
    assert.deepStrictEqual(names, ["session_prompt_right", "sidebar_content"]);

    assert.equal(disposers.length, 1);
    assert.equal(typeof disposers[0], "function");
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo tui factory registers only sidebar_content when statusline is off", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    await kiloTui(api, { sidebar: true, statusline: false });

    assert.equal(slotRegistrations.length, 1);
    assert.equal(slotRegistrations[0].order, 125);
    assert.deepStrictEqual(registeredSlotNames(slotRegistrations[0]), ["sidebar_content"]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});
