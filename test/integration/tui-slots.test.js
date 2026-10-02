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
// A LIMIT worth stating up front: the stub has no renderer, so the JSX factory
// throws and the sidebar slot can only ever return null here. Anything decided
// INSIDE a rendered component -- the mode, the collapse state, and the Go gate --
// is therefore invisible to this tier, which is exactly why those live in memos
// and pure predicates (test/unit/sidebar-band.test.js) instead of being read in
// the slot body. What this tier CAN observe is everything around them: which band
// was registered, in what order, and -- through the exported `applyHostPanelEnabled`
// -- what the host-panel switch does for each ownership state.
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
const { applyHostPanelEnabled, currentHostPanelEnabled } = await import("../../dist/tui-shared.js");
const { hostUsagePanelEnabled, ownsIntegratedBand, sidebarBandRenders } = await import(
  "../../dist/helpers.js"
);
const { bandMatrix, GO_PROVIDER, OTHER_PROVIDER } = await import("../helpers/sidebar-matrix.js");

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
const SESSION_MESSAGES = [
  { id: "m1", sessionID: "ses_stub", role: "user" },
  {
    id: "m2",
    sessionID: "ses_stub",
    role: "assistant",
    providerID: "opencode-go",
    modelID: "mimo-v2.6-pro",
    cost: 0.5,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
  },
  {
    id: "m3",
    sessionID: "ses_stub",
    role: "assistant",
    providerID: "opencode-go",
    modelID: "mimo-v2.6-pro",
    cost: 0.25,
    tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 100, write: 5 } },
  },
  {
    id: "m4",
    sessionID: "ses_stub",
    role: "assistant",
    providerID: "opencode-go",
    modelID: "qwen3-max",
    cost: 0.1,
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
];

function makeStubApi({
  messages = SESSION_MESSAGES,
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
  const commandDisposals = [];
  const eventRegistrations = [];
  const disposers = [];
  const pluginTransitions = [];
  const logs = [];
  const modelUsageCalls = [];
  const messageReads = [];

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
        // The plugin hands its entries back after every fold (a host that copies
        // `title` on registration would otherwise keep advertising the old
        // label), so a registration is disposable and its disposal has to be
        // observable -- otherwise duplicated entries would be invisible here.
        return () => {
          commandDisposals.push(callback);
        };
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
      session: {
        get: () => undefined,
        // The opencode panel's model mix is a fold over this, so the stub models
        // it and records which session the panel asked about: the numbers come
        // from the rendered session's own messages, and a panel that read
        // another session's would be a silent, wrong readout.
        messages(sessionID) {
          messageReads.push(sessionID);
          return messages;
        },
      },
    },
  };

  return { api, kv, logs, slotRegistrations, commandRegistrations, commandDisposals, eventRegistrations, disposers, pluginStates, pluginTransitions, modelUsageCalls, messageReads };
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

// --- the opencode model mix ---

// The opencode panel has no `model-usage` endpoint to call: it folds the host's
// own message store for the session it is rendering. What is worth pinning here
// is which store it reaches for and that a store which fails cannot take the
// sidebar down -- the weights themselves are pure helpers (readonly unit tier),
// and their rendering is the e2e's job, against a session with real usage.
//
// The stub has no renderer, so the slot returns null here (opentui's element
// factory needs one) and a null return is the only thing an assertion can look
// at. That is the fail-safe path, and it is why these tests read the store
// instead of the output.
test("the opencode sidebar reads the message store of the session it renders", async () => {
  const stub = makeStubApi();

  try {
    await tui(stub.api, { sidebar: true, statusline: true });
    const render = sidebarRender(stub.slotRegistrations);
    assert.doesNotThrow(() => render({ theme: { current: {} } }, { session_id: "ses_stub" }));
    assert.deepStrictEqual(stub.messageReads, ["ses_stub"], "the mix must be measured on the rendered session");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("the opencode sidebar survives a message store that throws", async () => {
  const stub = makeStubApi();
  stub.api.state.session.messages = () => {
    throw new Error("message store unavailable");
  };

  try {
    await tui(stub.api, { sidebar: true, statusline: true });
    const render = sidebarRender(stub.slotRegistrations);
    // The mix is an optional readout: a store that fails must leave the plan
    // rendering, not blank the block or throw into the host's render pass.
    assert.doesNotThrow(() => render({ theme: { current: {} } }, { session_id: "ses_stub" }));
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("a collapsed opencode sidebar reads no session store at all", async () => {
  const stub = makeStubApi();

  try {
    await tui(stub.api, { sidebar: true, statusline: true });
    const commands = stub.commandRegistrations.flatMap((register) => register());
    const toggle = commands.find((command) => command.value === "oc-go-usage-display.toggle-sidebar");
    assert.ok(toggle, "the sidebar toggle must be registered");

    toggle.onSelect();
    const render = sidebarRender(stub.slotRegistrations);
    assert.doesNotThrow(() => render({ theme: { current: {} } }, { session_id: "ses_stub" }));
    assert.deepStrictEqual(stub.messageReads, [], "a collapsed block must not walk the session's messages");
  } finally {
    for (const dispose of stub.disposers) dispose();
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
  const { api, slotRegistrations, disposers, pluginTransitions } = makeStubApi();

  try {
    // No option, no env, no kv: the default must be the integrated band.
    await kiloTui(api, undefined);

    const sidebar = slotRegistrations.find((registration) =>
      registeredSlotNames(registration).includes("sidebar_content"),
    );
    assert.equal(sidebar?.order, 150);
    // Load-time the host panel is left alone. Ownership cannot be judged at load --
    // there is no session yet -- and switching early painted the host's panel for a
    // frame before we took the band. The band decides it, the moment it mounts.
    assert.deepStrictEqual(pluginTransitions, [], "the plugin must not retire a host panel before it can fill it");
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("kilo tui factory registers the sidebar at 150 in integrated mode", async () => {
  const { api, slotRegistrations, disposers } = makeStubApi();

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

test("kilo registers no sidebar band at all when the sidebar toggle is off", async () => {
  const { api, slotRegistrations, disposers, pluginTransitions } = makeStubApi();

  try {
    await kiloTui(api, { sidebar: false, statusline: true, sidebar_mode: "integrated" });

    const names = slotRegistrations.flatMap(registeredSlotNames).sort();
    assert.deepStrictEqual(names, ["session_prompt_right"], "an unregistered band cannot own anything");
    assert.deepStrictEqual(
      pluginTransitions,
      [],
      "no band of ours means Kilo's own panel must stay: this was the second empty band",
    );
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
  // The persisted value is the contract here; the host-panel switch that follows it
  // is driven by the band and is covered by the ownership matrix below. This command
  // writes the KV key and nothing else, so a screen that changes with it is the
  // band's reactivity, not the command's.
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

    toggle.onSelect();
    assert.equal(kv.get("sidebar_mode"), "integrated");

    assert.deepStrictEqual(
      pluginTransitions,
      [],
      "the command persists a mode; it must not switch a host panel on its own",
    );
    assert.equal(pluginStates["internal:kilo-sidebar-usage"], true, "and it must not retire one either");
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("the mode command still returns when the KV store refuses the write", async () => {
  // Persistence is best-effort: the display followed the signal before the write
  // was attempted, so a refused write must not turn a palette command into a crash.
  const { api, commandRegistrations, disposers, logs } = makeStubApi();
  const kvSet = api.kv.set;
  api.kv.set = (key, value) => {
    if (key === "sidebar_mode") throw new Error("kv refused");
    kvSet(key, value);
  };

  try {
    await kiloTui(api, { sidebar_mode: "integrated" });
    const commands = commandRegistrations.flatMap((register) => register());
    const toggle = commands.find((command) => command.value === "oc-go-usage-display.toggle-sidebar-mode");
    assert.ok(toggle);
    assert.doesNotThrow(() => toggle.onSelect());
  } finally {
    for (const dispose of disposers) dispose();
  }
});

// --- the ownership matrix, against a stub host ---
//
// The band itself cannot be mounted without a renderer, so what the band does with
// its decision is the e2e's job. What is provable here is the other half: that
// every rung of the shared matrix drives the host's panel switch to exactly the
// state the sidebar owes it, and that a host which refuses the switch degrades to
// both panels being visible rather than to a throw.
//
// `KILO_USAGE_PANEL_PLUGIN_ID` is imported from the built bundle rather than
// restated, so "the panel we retire" cannot drift from the panel the plugin retires.
const { KILO_USAGE_PANEL_PLUGIN_ID } = await import("../../dist/shared.js");

const stateOfScenario = (scenario) => ({
  sidebarEnabled: scenario.sidebar,
  collapsed: scenario.collapsed,
  mode: scenario.mode,
  providerId: scenario.provider,
});

for (const scenario of bandMatrix()) {
  test(`band ${scenario.id}: host panel ends up ${scenario.hostPanel ? "on" : "off"}`, async () => {
    const stub = makeStubApi();
    try {
      const applied = await applyHostPanelEnabled(
        stub.api,
        KILO_USAGE_PANEL_PLUGIN_ID,
        hostUsagePanelEnabled(stateOfScenario(scenario)),
      );

      assert.equal(applied, true, `${scenario.given}: the switch must be applied, not refused`);
      assert.equal(
        stub.pluginStates[KILO_USAGE_PANEL_PLUGIN_ID],
        scenario.hostPanel,
        `${scenario.given}: ${scenario.why}`,
      );
      // And the sidebar side of the same rung, so the two halves are checked in the
      // same place: the host panel is on exactly when our band is not the only
      // usage block in it.
      assert.equal(
        ownsIntegratedBand(stateOfScenario(scenario)),
        !scenario.hostPanel,
        `${scenario.id}: ownership must match what the host panel was told`,
      );
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });
}

test("the host panel is switched once, and only when it disagrees", async () => {
  // Every launch, and every settled state, calls this. A version that wrote the
  // enable/disable map unconditionally would churn the host's KV store on every
  // message event.
  const stub = makeStubApi();
  try {
    for (const _ of [1, 2, 3]) {
      await applyHostPanelEnabled(stub.api, KILO_USAGE_PANEL_PLUGIN_ID, true);
    }
    assert.deepStrictEqual(stub.pluginTransitions, [], "already on: nothing to write");

    await applyHostPanelEnabled(stub.api, KILO_USAGE_PANEL_PLUGIN_ID, false);
    assert.deepStrictEqual(stub.pluginTransitions, [
      { id: KILO_USAGE_PANEL_PLUGIN_ID, enabled: false },
    ]);
    for (const _ of [1, 2, 3]) {
      await applyHostPanelEnabled(stub.api, KILO_USAGE_PANEL_PLUGIN_ID, false);
    }
    assert.equal(stub.pluginTransitions.length, 1, "already off: nothing more to write");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("a host that refuses the panel switch leaves both panels up, and says so", async () => {
  // The failure boundary, both ways: a registry that cannot be read and a switch
  // that is rejected. Neither may throw, and neither may leave the plugin believing
  // it owns the band -- which is why the result is returned rather than implied.
  const refused = makeStubApi();
  refused.api.plugins.deactivate = async () => {
    throw new Error("deactivate refused");
  };
  refused.api.plugins.list = () => {
    throw new Error("no plugin registry");
  };

  try {
    const applied = await applyHostPanelEnabled(refused.api, KILO_USAGE_PANEL_PLUGIN_ID, false);
    assert.equal(applied, false, "a refused switch must report failure");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      refused.logs.some((entry) => /deactivate refused/.test(entry.message)),
      "the failure must reach the host log, never console",
    );
    assert.ok(
      refused.logs.every((entry) => entry.service === "oc-go-usage-display" && entry.level === "error"),
      "every log line is the plugin's own error channel",
    );
  } finally {
    for (const dispose of refused.disposers) dispose();
  }

  const rejected = makeStubApi();
  rejected.api.plugins.deactivate = async () => false;
  try {
    assert.equal(
      await applyHostPanelEnabled(rejected.api, KILO_USAGE_PANEL_PLUGIN_ID, false),
      false,
      "a host that answers false is a failure, not a success",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      rejected.logs.some((entry) => /Could not disable/.test(entry.message)),
      "and it must be reported",
    );
  } finally {
    for (const dispose of rejected.disposers) dispose();
  }
});

test("an unknown plugin id is not something we can switch", async () => {
  // A host without Kilo's token-usage panel (a future rename, or the panel absent
  // from this build) must leave the band alone rather than guess: there is nothing
  // to retire, and claiming otherwise is how a sidebar ends up fighting a panel
  // that was never there.
  const stub = makeStubApi({ pluginStates: {} });
  try {
    assert.equal(
      currentHostPanelEnabled(stub.api, KILO_USAGE_PANEL_PLUGIN_ID),
      null,
      "a host that does not report the panel must read as 'unknown', not as 'off'",
    );
    assert.equal(await applyHostPanelEnabled(stub.api, KILO_USAGE_PANEL_PLUGIN_ID, false), false);
    assert.deepStrictEqual(stub.pluginTransitions, [], "and nothing may be switched");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      stub.logs.some((entry) => /Could not disable/.test(entry.message)),
      "the band could not be taken, so the user has to be able to find out why",
    );
  } finally {
    for (const dispose of stub.disposers) dispose();
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

// --- the settings-menu entries -------------------------------------------------
//
// The two foldable surfaces are reached through the command palette, so this tier
// owns everything about those entries except the drawing itself (which needs a
// renderer, and lives in the e2e tier): that they exist on BOTH hosts, that their
// labels state the effect they will have, that the label tracks the state, and
// that selecting one folds only the surface it names.
//
// The label is a getter, so the interesting assertion is that the host may hold
// the array it was given for the whole session: these tests build the entries
// ONCE and re-read the same objects after a toggle, which is the only arrangement
// under which a stale label would actually reach a user.

const SURFACE_ENTRIES = ["oc-go-usage-display.toggle-sidebar", "oc-go-usage-display.toggle-statusline"];
const ENTRY_SURFACE = new Map([
  ["oc-go-usage-display.toggle-sidebar", "sidebar"],
  ["oc-go-usage-display.toggle-statusline", "statusline"],
]);

function registeredCommands(stub) {
  // The CURRENT registration, which is the last one: the plugin hands its entries
  // back after every fold so a host that copied `title` on registration still
  // sees the new label.
  assert.ok(stub.commandRegistrations.length >= 1, "the menu must be registered");
  return stub.commandRegistrations[stub.commandRegistrations.length - 1]();
}

function entryFor(commands, value) {
  const found = commands.find((command) => command.value === value);
  assert.ok(found, `the menu must offer ${value}`);
  return found;
}

for (const host of ["opencode", "kilo"]) {
  const start = host === "opencode" ? tui : kiloTui;
  const options = host === "opencode" ? { sidebar: true, statusline: true } : STANDALONE;

  test(`${host}: the menu entries name the effect they will have`, async () => {
    const stub = makeStubApi();
    try {
      await start(stub.api, options);
      const commands = registeredCommands(stub);

      for (const value of SURFACE_ENTRIES) {
        const surface = ENTRY_SURFACE.get(value);
        assert.equal(entryFor(commands, value).title, `Go usage: hide ${surface}`, value);
        assert.equal(entryFor(commands, value).category, "Go");
      }
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });

  test(`${host}: the labels follow the state, on entries built once`, async () => {
    const stub = makeStubApi();
    try {
      await start(stub.api, options);
      const commands = registeredCommands(stub);
      const sidebar = entryFor(commands, SURFACE_ENTRIES[0]);
      const statusline = entryFor(commands, SURFACE_ENTRIES[1]);

      sidebar.onSelect();
      assert.equal(sidebar.title, "Go usage: show sidebar", "its own entry renames");
      assert.equal(statusline.title, "Go usage: hide statusline", "the other one does not");

      statusline.onSelect();
      assert.equal(statusline.title, "Go usage: show statusline");

      sidebar.onSelect();
      assert.equal(sidebar.title, "Go usage: hide sidebar");
      assert.equal(statusline.title, "Go usage: show statusline", "unfolding one must not touch the other");
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });

  test(`${host}: folding the statusline persists under its own key only`, async () => {
    const stub = makeStubApi();
    try {
      await start(stub.api, options);
      const statusline = entryFor(registeredCommands(stub), SURFACE_ENTRIES[1]);

      assert.equal(stub.api.kv.get("collapsed_statusline", false), false);
      statusline.onSelect();
      assert.equal(stub.api.kv.get("collapsed_statusline", false), true, "the statusline fold is persisted");
      assert.equal(
        stub.api.kv.get("collapsed_sidebar", false),
        false,
        "and the sidebar's key is untouched: two axes, two keys",
      );

      statusline.onSelect();
      assert.equal(stub.api.kv.get("collapsed_statusline", false), false, "and it comes back off");
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });

  test(`${host}: a persisted fold is what the menu offers to undo`, async () => {
    const stub = makeStubApi();
    stub.kv.set("collapsed_statusline", true);
    stub.kv.set("collapsed_sidebar", true);
    try {
      await start(stub.api, options);
      const commands = registeredCommands(stub);
      assert.equal(entryFor(commands, SURFACE_ENTRIES[0]).title, "Go usage: show sidebar");
      assert.equal(entryFor(commands, SURFACE_ENTRIES[1]).title, "Go usage: show statusline");
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });

  test(`${host}: the entry ids stay stable across folds`, async () => {
    // A label may move; an id may not. The id is what a host binds a key to and
    // dispatches on, so a label that leaked into it would break every binding.
    const stub = makeStubApi();
    try {
      await start(stub.api, options);
      const before = registeredCommands(stub).map((command) => `${command.value}::${command.title}`);
      entryFor(registeredCommands(stub), SURFACE_ENTRIES[1]).onSelect();
      const after = registeredCommands(stub).map((command) => `${command.value}::${command.title}`);

      assert.deepStrictEqual(
        after.map((entry) => entry.split("::")[0]),
        before.map((entry) => entry.split("::")[0]),
      );
      assert.notDeepStrictEqual(after, before, "while the labels did move");
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });
}

test("both hosts offer the same two entries, with the same labels", async () => {
  const stub = makeStubApi();
  try {
    await tui(stub.api, { sidebar: true, statusline: true });
    const opencodeEntries = registeredCommands(stub).map((command) => `${command.value}::${command.category}`);
    for (const dispose of stub.disposers) dispose();

    const kiloStub = makeStubApi();
    await kiloTui(kiloStub.api, STANDALONE);
    const kiloEntries = registeredCommands(kiloStub)
      .filter((command) => SURFACE_ENTRIES.includes(command.value))
      .map((command) => `${command.value}::${command.category}`);

    // A shared implementation is only a shared implementation if it produces the
    // same menu on both hosts; Kilo's own mode entry is the one allowed extra.
    assert.deepStrictEqual(kiloEntries, opencodeEntries);

    for (const dispose of kiloStub.disposers) dispose();
  } catch (error) {
    for (const dispose of stub.disposers) dispose();
    throw error;
  }
});

test("kilo keeps its own mode entry, and it is not one of the surface pair", async () => {
  const stub = makeStubApi();
  try {
    await kiloTui(stub.api, STANDALONE);
    const commands = registeredCommands(stub);
    const mode = entryFor(commands, "oc-go-usage-display.toggle-sidebar-mode");

    // The mode entry swaps one drawing for another rather than showing or hiding
    // anything, so it stays an action and does not join the Show/Hide pair.
    assert.equal(mode.title, "Go usage: toggle sidebar mode");
    assert.equal(SURFACE_ENTRIES.includes(mode.value), false);
    assert.equal(commands.length, 3, "two surfaces plus the mode");
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

test("opencode registers no mode entry, because it has no sidebar_mode", async () => {
  const stub = makeStubApi();
  try {
    await tui(stub.api, { sidebar: true, statusline: true });
    const commands = registeredCommands(stub);
    assert.deepStrictEqual(
      commands.map((command) => command.value),
      SURFACE_ENTRIES,
    );
  } finally {
    for (const dispose of stub.disposers) dispose();
  }
});

for (const host of ["opencode", "kilo"]) {
  const start = host === "opencode" ? tui : kiloTui;
  const options = host === "opencode" ? { sidebar: true, statusline: true } : STANDALONE;

  test(`${host}: a fold hands the menu back, and retires the old entries`, async () => {
    // A host that copies `title` when it registers an entry would keep
    // advertising "hide statusline" forever otherwise -- which is exactly what
    // Kilo's palette does, and is why the label has to be re-registered and not
    // merely recomputed.
    const stub = makeStubApi();
    try {
      await start(stub.api, options);
      assert.equal(stub.commandRegistrations.length, 1, "one registration to begin with");

      entryFor(registeredCommands(stub), "oc-go-usage-display.toggle-statusline").onSelect();

      assert.equal(stub.commandRegistrations.length, 2, "a fold re-registers the entries");
      assert.deepStrictEqual(
        stub.commandDisposals,
        [stub.commandRegistrations[0]],
        "and disposes the previous ones, so the menu cannot show a command twice",
      );
      const after = entryFor(registeredCommands(stub), "oc-go-usage-display.toggle-statusline");
      assert.equal(after.title, "Go usage: show statusline", "and the label followed the fold");
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });

  test(`${host}: disposal tears down the current registration only`, async () => {
    const stub = makeStubApi();
    try {
      const before = stub.disposers.length;
      await start(stub.api, options);
      const last = stub.commandRegistrations[stub.commandRegistrations.length - 1];
      for (const dispose of stub.disposers.slice(before)) dispose();

      assert.deepStrictEqual(
        stub.commandDisposals,
        [last],
        "onDispose must retire the entries the host still holds",
      );
    } finally {
      for (const dispose of stub.disposers) dispose();
    }
  });
}
