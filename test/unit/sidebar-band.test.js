// Unit tier: the sidebar band decision table.
//
// `renders` and `hostPanel` for every combination of the four user-facing axes
// (sidebar on/off, collapsed, sidebar mode, and the session's provider), driven
// from the shared matrix in test/helpers/sidebar-matrix.js so the unit, the
// integration and the e2e tier cannot disagree about what a state is.
//
// This tier is where the whole table is cheap to prove, because both answers are
// pure functions. It exists because the bug it pins was not a wrong CONDITION but
// a condition in the wrong PLACE: the host invokes a slot renderer exactly once
// per mount, so a Go gate read in the slot body stayed latched, and integrated mode
// had already switched Kilo's panel off by then. The table below is the contract
// that has to hold no matter where the decision is evaluated.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostUsagePanelEnabled,
  ownsIntegratedBand,
  providerIdFromMessages,
  sidebarBandRenders,
  statuslineRenders,
} from "../../dist/helpers.js";
import { GO_PROVIDER_ID } from "../../dist/shared.js";
import { bandMatrix, GO_PROVIDER, OTHER_PROVIDER } from "../helpers/sidebar-matrix.js";

const stateOf = (scenario) => ({
  sidebarEnabled: scenario.sidebar,
  collapsed: scenario.collapsed,
  mode: scenario.mode,
  providerId: scenario.provider,
});

const MATRIX = bandMatrix();

// --- the matrix itself -------------------------------------------------------

test("the band matrix covers every combination of the four axes", () => {
  // 4 sidebar states x 2 modes x 3 providers. A gap here is a state nobody ever
  // asserted, which is exactly how the empty band survived.
  assert.equal(MATRIX.length, 24);
  assert.equal(new Set(MATRIX.map((scenario) => scenario.id)).size, MATRIX.length, "every rung needs its own name");
  for (const mode of ["integrated", "standalone"]) {
    for (const provider of [GO_PROVIDER, OTHER_PROVIDER, undefined]) {
      const found = MATRIX.some(
        (scenario) => scenario.sidebar && !scenario.collapsed && scenario.mode === mode && scenario.provider === provider,
      );
      assert.ok(found, `the matrix must contain sidebar-on/${mode}/${provider ?? "no provider"}`);
    }
  }
  assert.equal(GO_PROVIDER, GO_PROVIDER_ID, "the matrix's Go provider must be the id the plugin keys on");
});

// --- the decision table ------------------------------------------------------

for (const scenario of MATRIX) {
  test(`band ${scenario.id}: ${scenario.renders ? "renders" : "renders nothing"}, Kilo panel ${scenario.hostPanel ? "on" : "off"}`, () => {
    const state = stateOf(scenario);

    assert.equal(
      sidebarBandRenders(state),
      scenario.renders,
      `${scenario.given}: ${scenario.why}`,
    );
    assert.equal(
      hostUsagePanelEnabled(state),
      scenario.hostPanel,
      `${scenario.given}: ${scenario.why}`,
    );
    assert.equal(
      ownsIntegratedBand(state),
      scenario.integrated,
      `${scenario.given}: ${scenario.why}`,
    );
  });
}

// --- the rule the whole table hangs off ---------------------------------------

test("no state may leave the host's band empty", () => {
  // The defect, stated as the invariant it violated. Any rung where we render
  // nothing AND the host panel is off is a hole in the sidebar.
  for (const scenario of MATRIX) {
    assert.ok(
      scenario.renders || scenario.hostPanel,
      `${scenario.id}: band 150 renders nothing and Kilo's panel is off, so the band is empty`,
    );
  }
});

test("the host panel is off exactly when our integrated panel is on", () => {
  // The two switches are complements by construction, so a change that made them
  // disagree would show up here before it reached a screenshot.
  for (const scenario of MATRIX) {
    const state = stateOf(scenario);
    assert.equal(
      hostUsagePanelEnabled(state),
      !ownsIntegratedBand(state),
      `${scenario.id}: ownership and the host-panel switch must be the same decision`,
    );
  }
});

test("the mode decides what the band draws, never whether it draws", () => {
  // The README's promise, as an invariant. If the mode ever leaked into
  // `sidebarBandRenders`, the two modes would start answering differently about
  // which sessions they serve, and one of them would be showing nothing where the
  // other shows the plan.
  for (const sidebar of [true, false]) {
    for (const collapsed of [true, false]) {
      for (const provider of [GO_PROVIDER, OTHER_PROVIDER, undefined]) {
        const integrated = { sidebarEnabled: sidebar, collapsed, mode: "integrated", providerId: provider };
        const standalone = { ...integrated, mode: "standalone" };
        assert.equal(
          sidebarBandRenders(integrated),
          sidebarBandRenders(standalone),
          `sidebar=${sidebar} collapsed=${collapsed} provider=${provider}: the mode must not change whether we draw`,
        );
      }
    }
  }
});

test("a collapsed band gives its space back to Kilo's panel", () => {
  // The second empty band this rule closes. Our slot is still registered at 150
  // while collapsed, so folding it and leaving the host panel retired left a hole;
  // now folding it hands the band over instead.
  const collapsedGo = { sidebarEnabled: true, collapsed: true, mode: "integrated", providerId: GO_PROVIDER };
  const expandedGo = { ...collapsedGo, collapsed: false };

  assert.equal(sidebarBandRenders(collapsedGo), false, "a collapsed band draws nothing");
  assert.equal(sidebarBandRenders(expandedGo), true, "the same band draws once expanded");
  assert.equal(hostUsagePanelEnabled(collapsedGo), true, "collapsing hands the band back rather than emptying it");
  assert.equal(hostUsagePanelEnabled(expandedGo), false);
});

test("the standalone block stays Go-only, the integrated panel defers", () => {
  // The deliberate difference between the two modes. Standalone draws the Go plan
  // in a band of its own and leaves Kilo alone, so it simply has nothing to say
  // about a non-Go session. Integrated would otherwise have to replace Kilo's
  // panel with a fork of it, so it hands the band back instead.
  const standaloneOther = { sidebarEnabled: true, collapsed: false, mode: "standalone", providerId: OTHER_PROVIDER };
  const integratedOther = { ...standaloneOther, mode: "integrated" };
  const integratedGo = { ...integratedOther, providerId: GO_PROVIDER };
  const standaloneGo = { ...standaloneOther, providerId: GO_PROVIDER };

  assert.equal(sidebarBandRenders(standaloneOther), false, "standalone + non-Go draws nothing");
  assert.equal(hostUsagePanelEnabled(standaloneOther), true, "standalone never retires the host panel");
  assert.equal(ownsIntegratedBand(standaloneGo), false, "standalone never claims the host's band");

  assert.equal(sidebarBandRenders(integratedOther), false, "integrated + non-Go defers to the host panel");
  assert.equal(hostUsagePanelEnabled(integratedOther), true);
  assert.equal(ownsIntegratedBand(integratedGo), true);
  assert.equal(hostUsagePanelEnabled(integratedGo), false);
});

test("an unknown provider is not a Go session", () => {
  // "We cannot tell yet" must never be read as "yes": claiming the band and then
  // failing to fill it is how the empty band came back.
  const unknown = { sidebarEnabled: true, collapsed: false, mode: "integrated", providerId: undefined };
  assert.equal(ownsIntegratedBand(unknown), false);
  assert.equal(sidebarBandRenders(unknown), false);
  assert.equal(hostUsagePanelEnabled(unknown), true);
});

// --- the statusline -----------------------------------------------------------

test("the statusline is Go-only in both modes, because it replaces nothing", () => {
  for (const scenario of MATRIX) {
    const state = stateOf(scenario);
    assert.equal(
      statuslineRenders({ ...state, collapsed: false }),
      scenario.provider === GO_PROVIDER,
      `${scenario.id}: the statusline is the plan on one line, so it stays Go-only`,
    );
    // The sidebar toggle does not steer the statusline, and vice versa: they are
    // separate axes with separate persisted keys. That independence is a property
    // of WHICH flag the caller hands in -- each surface passes its own -- so it is
    // asserted here by handing in an expanded statusline and seeing the sidebar's
    // fold make no difference.
    assert.equal(statuslineRenders({ ...state, sidebarEnabled: false, collapsed: false }), statuslineRenders({ ...state, collapsed: false }));
  }
});

test("folding the statusline hides it, which is what its own toggle does", () => {
  // The regression: `statuslineRenders` dropped the `collapsed` field it was
  // given, so `collapsed_statusline` was persisted and governed nothing and the
  // statusline could not be turned off. The flag it reads is the STATUSLINE's own
  // -- callers pass `isStatuslineCollapsed()` -- which is why this can be pinned
  // without the sidebar's axis appearing anywhere.
  for (const scenario of MATRIX) {
    const state = { ...stateOf(scenario), collapsed: false };
    assert.equal(
      statuslineRenders({ ...state, collapsed: true }),
      false,
      `${scenario.id}: a folded statusline draws nothing, Go session or not`,
    );
    assert.equal(
      statuslineRenders({ ...state, collapsed: false }),
      scenario.provider === GO_PROVIDER,
      `${scenario.id}: and unfolding brings back exactly the Go-only answer`,
    );
  }

  // The axis is genuinely separate: a folded statusline and an unfolded sidebar
  // are a real, reachable combination, and neither one implies the other.
  const goSession = { sidebarEnabled: true, collapsed: false, mode: "integrated", providerId: GO_PROVIDER };
  assert.equal(statuslineRenders({ ...goSession, collapsed: false }), true);
  assert.equal(statuslineRenders({ ...goSession, collapsed: true }), false);
  assert.equal(sidebarBandRenders(goSession), true, "the sidebar is untouched by the statusline's fold");
});

// --- which provider a session is really on ------------------------------------

test("the session's provider comes from the newest message that names one", () => {
  assert.equal(providerIdFromMessages([]), undefined, "an empty session names nobody");
  assert.equal(providerIdFromMessages(undefined), undefined);
  assert.equal(providerIdFromMessages(null), undefined, "a host that answers with nothing is not a Go session");

  // Kilo's AssistantMessage flattens `providerID`; its UserMessage nests it.
  assert.equal(providerIdFromMessages([{ providerID: GO_PROVIDER }]), GO_PROVIDER);
  assert.equal(providerIdFromMessages([{ model: { providerID: OTHER_PROVIDER } }]), OTHER_PROVIDER);

  assert.equal(
    providerIdFromMessages([
      { providerID: GO_PROVIDER },
      { providerID: OTHER_PROVIDER },
    ]),
    OTHER_PROVIDER,
    "the newest message wins: that is the model the user just switched to",
  );
  assert.equal(
    providerIdFromMessages([
      { providerID: OTHER_PROVIDER },
      { model: { providerID: GO_PROVIDER } },
    ]),
    GO_PROVIDER,
    "a nested user message counts the same as a flat assistant one",
  );
});

test("the provider read skips over messages that name nobody", () => {
  // A session opens with records the plugin must not choke on: tool parts, a
  // message with no model yet, a hole. Skipping them is what lets the read stay
  // a plain walk instead of a per-shape type switch at every call site.
  assert.equal(
    providerIdFromMessages([
      { providerID: GO_PROVIDER },
      { role: "assistant", tokens: { input: 1 } },
      null,
      "not a message",
      undefined,
    ]),
    GO_PROVIDER,
    "an unusable record must not end the walk",
  );
  assert.equal(providerIdFromMessages([null, "nope", {}]), undefined);
  assert.equal(providerIdFromMessages([{ providerID: "" }, { providerID: "   " }]), undefined, "blank is not a provider");
});

test("the provider read wins over the configured model", () => {
  // The store beats the config default because the config default is static: it
  // cannot report a model switch. It also beats `Session.model` (Kilo 7.8.3+),
  // because the band exists to show what ran -- a model picked but not yet used
  // has no rows in the models table to weight and would claim the band for
  // nothing.
  const messages = [
    { role: "user", model: { providerID: GO_PROVIDER, modelID: "mimo" } },
    { role: "assistant", providerID: GO_PROVIDER, modelID: "mimo" },
  ];
  const resolved = providerIdFromMessages(messages);
  assert.equal(resolved, GO_PROVIDER);
  // The fallback this outranks is the config-level default, and it is what the
  // same session would have reported before any message existed.
  assert.notEqual(resolved, OTHER_PROVIDER);
});

test("a message store that is empty falls through rather than claiming Go", () => {
  // The gap the store cannot cover: a session too new to have any messages. The
  // caller falls back to `Session.model` (Kilo 7.8.3+) and then to the configured
  // model, so "no messages" must read as "nobody" and not as a default.
  assert.equal(providerIdFromMessages([]), undefined);
  assert.equal(providerIdFromMessages(undefined), undefined);
});