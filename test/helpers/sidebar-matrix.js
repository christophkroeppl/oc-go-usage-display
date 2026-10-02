// The band matrix: every sidebar state a Kilo user can be in, and what the
// sidebar owes the host in each one.
//
// One list, three tiers, exactly like the usage ladder (test/helpers/ladder.js).
// The unit tier pins the decision table; the integration tier asserts the
// observable consequences at the plugin boundary (which band was registered, what
// happened to Kilo's own panel); the e2e tier boots the real host on the rungs
// where the rendered result is the only thing that counts. They cannot disagree
// about what "a state" is, which is the whole point of keeping it here.
//
// THE STATES
// ----------
// Four axes, all independent, all of which a user can change while Kilo runs:
//
//   sidebar    the `sidebar` surface toggle -- are we registered in a band at all?
//   collapsed  the fold toggle -- our band still occupies the space it registered
//              for, it is just drawing nothing
//   mode       `sidebar_mode`: `integrated` (Kilo's token-usage band, which we
//              take over) or `standalone` (a free band of our own)
//   provider   which provider the session is really running, read from the host's
//              own message store. `undefined` is the "we cannot tell yet" case and
//              is not a synonym for Go: a plugin that cannot name a provider must
//              not claim a Go session.
//
// THE DECISION
// ------------
// `renders` is whether our band draws anything. `hostPanel` is whether Kilo's own
// `Token Usage` panel must be on screen. They are different questions, and the
// difference is the bug this matrix exists to pin: integrated mode had switched
// Kilo's panel off unconditionally and then declined to draw, which left band 150
// empty on every non-Go session.
//
// One rule generates the whole table: we are the only usage block in the band
// exactly while we are drawing in it. So the host panel goes away only when we
// draw in integrated mode, and every way of not drawing -- no sidebar, collapsed,
// standalone mode, or a non-Go session -- leaves Kilo's own widget on screen.
//
// The mode never changes WHETHER we draw, only what we draw and whose panel is
// retired. That is the README's promise ("the mode decides what it draws, not
// whether it is there") written as a test.
//
// Collapsing is one of the ways of not drawing, and it used to be a second empty
// band: our slot is still registered there, the fold just made it draw nothing,
// and integrated mode had already retired the host panel.

export const GO_PROVIDER = "opencode-go";
export const OTHER_PROVIDER = "anthropic";

/**
 * @typedef {{
 *   id: string,
 *   given: string,
 *   sidebar: boolean,
 *   collapsed: boolean,
 *   mode: "integrated" | "standalone",
 *   provider: string | undefined,
 *   renders: boolean,
 *   hostPanel: boolean,
 *   integrated: boolean,
 *   why: string,
 * }} BandScenario
 */

const SIDEBAR_AXES = [
  { sidebar: true, collapsed: false, name: "sidebar-on" },
  { sidebar: true, collapsed: true, name: "sidebar-on-collapsed" },
  { sidebar: false, collapsed: false, name: "sidebar-off" },
  { sidebar: false, collapsed: true, name: "sidebar-off-collapsed" },
];

const MODE_AXES = ["integrated", "standalone"];

const PROVIDER_AXES = [
  { provider: GO_PROVIDER, name: "go-model" },
  { provider: OTHER_PROVIDER, name: "other-model" },
  { provider: undefined, name: "unknown-model" },
];

/**
 * The expectations, written out rather than computed. A matrix that derives its
 * own answers from the implementation proves nothing; this is the one rule above,
 * spelled out per rung.
 *
 * @param {{ sidebar: boolean, collapsed: boolean, name: string }} sidebarAxis
 * @param {"integrated" | "standalone"} mode
 * @param {{ provider: string | undefined, name: string }} providerAxis
 * @returns {{ renders: boolean, hostPanel: boolean, why: string }}
 */
function expected({ sidebar, collapsed, name }, mode, { provider, name: providerName }) {
  const isGo = provider === GO_PROVIDER;
  const drawing = sidebar && !collapsed && isGo;
  if (!drawing) {
    return {
      renders: false,
      hostPanel: true,
      why: `${name}: nothing of ours is in the band, so Kilo's own panel is on screen`,
    };
  }
  if (mode === "standalone") {
    return {
      renders: true,
      hostPanel: true,
      why: `${name}: our own band beside Kilo's panel, which stays where it is`,
    };
  }
  return {
    renders: true,
    hostPanel: false,
    why: `${name}: our integrated panel is the only usage block in the band`,
  };
}

/**
 * Every rung, in a stable order.
 *
 * @returns {BandScenario[]}
 */
export function bandMatrix() {
  const scenarios = [];
  for (const sidebarAxis of SIDEBAR_AXES) {
    for (const mode of MODE_AXES) {
      for (const providerAxis of PROVIDER_AXES) {
        const { renders, hostPanel, why } = expected(sidebarAxis, mode, providerAxis);
        const id = `${sidebarAxis.name}/${mode}/${providerAxis.name}`;
        scenarios.push({
          id,
          given: `the ${sidebarAxis.name} sidebar, ${mode} mode, and a session on a ${providerAxis.name}`,
          sidebar: sidebarAxis.sidebar,
          collapsed: sidebarAxis.collapsed,
          mode,
          provider: providerAxis.provider,
          renders,
          hostPanel,
          integrated: renders && mode === "integrated" && !hostPanel,
          why,
        });
      }
    }
  }
  return scenarios;
}

/**
 * One rung by id. Throws rather than returning undefined so a renamed rung fails
 * loudly in the tier that asks for it instead of silently skipping.
 *
 * @param {string} id
 * @returns {BandScenario}
 */
export function bandScenario(id) {
  const found = bandMatrix().find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`no band scenario named ${id}`);
  return found;
}