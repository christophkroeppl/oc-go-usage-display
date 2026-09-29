// Integration tier: `dist/tui.js` (opencode, order 50) and `dist/tui.kilo.js`
// (Kilo, order 125 standalone / 150 integrated) registration contracts, proven
// with a dependency-free stub `TuiPluginApi` (no PTY, no opencode/kilo binary,
// no network).
//
// These assert the registered `order` value; the *rendered* consequence of that
// order is pinned separately by the e2e tier (assertSidebarOrder in
// test/helpers/tui.js), which is what actually guards the constant.
//
// The stub also models `api.plugins` so the Kilo sidebar-mode switch can be
// observed: `pluginStates` seeds the host's panel state and `pluginTransitions`
// records every activate/deactivate. Without it, "integrated mode retires the
// host panel" would be an untested claim.
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
// `pluginStates` seeds which plugin ids the host reports as on/off so the
// integrated-mode panel switch can be observed instead of guessed at.
//
// `modelUsageCalls` records every `client.kilocode.sessionModelUsage` request so
// the integrated panel's data source is observable: the endpoint is host-owned,
// so "which call does the panel make, and for which session" has to be pinned
// here rather than inferred from a rendered pane. `modelUsage` is the payload
// it answers with; setting it to `null` makes the call reject, which is the
// failure the panel has to survive.
function makeStubApi({
  pluginStates = { "internal:kilo-sidebar-usage": true },
  modelUsage = {
    sessionIDs: ["ses_stub"],
    totals: { steps: 2, cost: 0.5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } },
    models: [
      {
        providerID: "opencode-go",
        modelID: "mimo-v2.6-pro",
        steps: 2,
        cost: 0.5,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
      },
    ],
  },
} = {}) {
  const kv = new Map();
  const slotRegistrations = [];
  const commandRegistrations = [];
  const eventRegistrations = [];
  const disposers = [];
  const pluginTransitions = [];
  const logs = [];
  const modelUsageCalls = [];

  const pluginEntry = (id, enabled) => ({
    id,
    source: "internal",
    spec: id,
    target: "tui",
    enabled,
    active: enabled,
  });

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
    plugins: {
      list() {
        return Object.entries(pluginStates).map(([id, enabled]) => pluginEntry(id, enabled));
      },
      async activate(id) {
        if (!(id in pluginStates)) return false;
        pluginStates[id] = true;
        pluginTransitions.push({ id, enabled: true });
        return true;
      },
      async deactivate(id) {
        if (!(id in pluginStates)) return false;
        pluginStates[id] = false;
        pluginTransitions.push({ id, enabled: false });
        return true;
      },
    },
    route: { current: { name: "session" } },
    client: {
      app: { async log(entry) { logs.push(entry); } },
      kilocode: {
        async sessionModelUsage(parameters) {
          modelUsageCalls.push(parameters);
          if (modelUsage === null) throw new Error("model-usage unavailable");
          return { data: modelUsage, error: undefined };
        },
      },
    },
    state: {
      // The sidebar's provider gate reads this at init; without it the slot
      // renders null and nothing below it is reachable.
      config: { model: "opencode-go/mimo-v2.6-pro" },
      provider: [{ id: "opencode-go", name: "OpenCode Go", models: { "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro" } } }],
      session: { get: () => undefined },
    },
  };

  return { api, kv, logs, slotRegistrations, commandRegistrations, eventRegistrations, disposers, pluginStates, pluginTransitions, modelUsageCalls };
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

// Kilo registers the sidebar block in the band the resolved `sidebar_mode`
// selects: 125 (standalone) or 150 (integrated, Kilo's own token-usage band).
// The option path is how the tests reach both — Kilo's real tui.json cannot
// carry it, the same way it cannot carry `sidebar`/`statusline` above.
const STANDALONE = { sidebar: true, statusline: true, sidebar_mode: "standalone" };

test("kilo tui factory registers both surfaces at order 125 in standalone mode", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    await kiloTui(api, STANDALONE);

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
    await kiloTui(api, { ...STANDALONE, statusline: false });

    assert.equal(slotRegistrations.length, 1);
    assert.equal(slotRegistrations[0].order, 125);
    assert.deepStrictEqual(registeredSlotNames(slotRegistrations[0]), ["sidebar_content"]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

// --- sidebar_mode ---

test("kilo tui factory defaults to the integrated band at order 150", async () => {
  const { api, slotRegistrations, disposers, pluginStates } = makeStubApi();

  try {
    // No option, no env, no kv: the default must be the integrated band.
    await kiloTui(api, undefined);

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 150);
    // Integrated mode takes over the host's band, so its panel has to go.
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], false);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo tui factory registers the sidebar at 150 in integrated mode", async () => {
  const { api, slotRegistrations, disposers, pluginTransitions } = makeStubApi();

  try {
    await kiloTui(api, { sidebar: true, statusline: true, sidebar_mode: "integrated" });

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 150);
    // The statusline band is independent of the sidebar mode.
    const statusline = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("session_prompt_right"),
    );
    assert.equal(statusline?.order, 125);
    assert.deepStrictEqual(pluginTransitions, [{ id: "internal:kilo-sidebar-usage", enabled: false }]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo tui factory leaves the host panel alone in standalone mode", async () => {
  const { api, disposers, pluginTransitions, pluginStates } = makeStubApi();

  try {
    await kiloTui(api, STANDALONE);

    assert.deepStrictEqual(pluginTransitions, [], "standalone must not touch the host panel");
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], true);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo tui factory re-enables a host panel that a previous run disabled", async () => {
  const { api, disposers, pluginTransitions, pluginStates } = makeStubApi({
    pluginStates: { "internal:kilo-sidebar-usage": false },
  });

  try {
    await kiloTui(api, STANDALONE);

    assert.deepStrictEqual(pluginTransitions, [{ id: "internal:kilo-sidebar-usage", enabled: true }]);
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], true);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo sidebar_mode reads env before the persisted kv value", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    process.env.KILO_OC_GO_SIDEBAR_MODE = "standalone";
    api.kv.set("sidebar_mode", "integrated");
    try {
      await kiloTui(api, undefined);
    } finally {
      delete process.env.KILO_OC_GO_SIDEBAR_MODE;
    }

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 125, "the env var must win over the persisted value");
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo sidebar_mode falls back to the persisted kv value", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    api.kv.set("sidebar_mode", "standalone");
    await kiloTui(api, undefined);

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 125);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo sidebar_mode ignores an unrecognized persisted value", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    api.kv.set("sidebar_mode", "sideways");
    await kiloTui(api, undefined);

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 150, "an unknown value must fall through to the default");
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo sidebar_mode option beats env and kv", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

  try {
    process.env.KILO_OC_GO_SIDEBAR_MODE = "integrated";
    api.kv.set("sidebar_mode", "integrated");
    try {
      await kiloTui(api, { sidebar_mode: "standalone" });
    } finally {
      delete process.env.KILO_OC_GO_SIDEBAR_MODE;
    }

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 125);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("the sidebar-mode command flips the persisted value in both directions", async () => {
  const { api, kv, commandRegistrations, disposers, pluginStates, pluginTransitions } = makeStubApi();

  try {
    await kiloTui(api, { sidebar: true, statusline: true, sidebar_mode: "integrated" });

    const commands = commandRegistrations.flatMap((register) => register());
    const toggle = commands.find((command) => command.value === "oc-go-usage-display.toggle-sidebar-mode");
    assert.ok(toggle, "the sidebar-mode toggle must be registered");
    assert.equal(toggle.title, "Go usage: toggle sidebar mode");
    assert.equal(kv.get("sidebar_mode"), undefined, "the mode is only persisted once toggled");

    toggle.onSelect();
    assert.equal(kv.get("sidebar_mode"), "standalone");
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], true, "switching back re-enables the host panel");

    toggle.onSelect();
    assert.equal(kv.get("sidebar_mode"), "integrated");
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], false);

    assert.deepStrictEqual(pluginTransitions, [
      { id: "internal:kilo-sidebar-usage", enabled: false },
      { id: "internal:kilo-sidebar-usage", enabled: true },
      { id: "internal:kilo-sidebar-usage", enabled: false },
    ]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("a host that cannot switch its own panel still initializes", async () => {
  // Best-effort by contract: the plugin must never reject because Kilo refused
  // the panel switch, and it must not retry on a state it cannot read.
  const { api, slotRegistrations, disposers, logs } = makeStubApi();
  api.plugins.list = () => {
    throw new Error("no plugin registry");
  };
  api.plugins.deactivate = async () => {
    throw new Error("deactivate refused");
  };
  api.client.app.log = async (entry) => {
    logs.push(entry);
  };

  try {
    await kiloTui(api, { sidebar_mode: "integrated" });

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 150, "the plugin still registers its block");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      logs.some((entry) => /deactivate refused/.test(entry.message)),
      "a failed panel switch must be reported through the host log, not thrown",
    );
  } finally {
    for (const dispose of disposers) dispose();
  }
});

// --- integrated panel: the host endpoint the panel depends on ---

// The integrated sidebar reads Kilo's per-session model usage through
// `client.kilocode.sessionModelUsage`. That call happens while the host renders
// the slot, which needs the host's own renderer, so the stub can only prove the
// part that is observable here: the factory initializes against a host that has
// the endpoint, survives one that does not, and never throws into the host's
// render pass. The route and the response shape are pinned against the real
// host by test/e2e/kilo-contract.test.js.
function sidebarRender(slotRegistrations) {
  const sidebar = slotRegistrations.find((registration) =>
    registeredSlotNames(registration).includes("sidebar_content"),
  );
  assert.ok(sidebar, "the plugin must register sidebar_content");
  return sidebar.slots.sidebar_content;
}

test("integrated mode initializes against a host that serves model usage", async () => {
  const stub = makeStubApi();

  try {
    await assert.doesNotReject(() => kiloTui(stub.api, { sidebar_mode: "integrated" }));
    assert.equal(typeof sidebarRender(stub.slotRegistrations), "function");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("integrated mode initializes against a host with no model-usage endpoint", async () => {
  // An older Kilo whose SDK has no `kilocode.sessionModelUsage`: the panel has to
  // degrade to its unavailable state, never take the host down with it.
  const stub = makeStubApi();
  delete stub.api.client.kilocode;

  try {
    await assert.doesNotReject(() => kiloTui(stub.api, { sidebar_mode: "integrated" }));
    assert.equal(typeof sidebarRender(stub.slotRegistrations), "function");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("integrated mode initializes when the model-usage endpoint always fails", async () => {
  const stub = makeStubApi();
  stub.api.client.kilocode.sessionModelUsage = async () => {
    throw new Error("model-usage unavailable");
  };

  try {
    await assert.doesNotReject(() => kiloTui(stub.api, { sidebar_mode: "integrated" }));
    assert.equal(typeof sidebarRender(stub.slotRegistrations), "function");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("the sidebar render function never throws into the host", async () => {
  for (const mode of ["integrated", "standalone"]) {
    const stub = makeStubApi();
    stub.api.state = undefined;
    stub.api.client.kilocode = undefined;

    try {
      await kiloTui(stub.api, { sidebar_mode: mode });
      const render = sidebarRender(stub.slotRegistrations);
      // A render that returns null is fine (the stub has no renderer, and the
      // panel's own provider gate may decline); one that throws is not.
      assert.doesNotThrow(() => render({ theme: { current: {} } }, { session_id: "ses_probe" }), mode);
      assert.doesNotThrow(() => render({ theme: { current: {} } }, { session_id: "" }), mode);
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  }
});
