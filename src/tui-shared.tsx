/** @jsxImportSource @opentui/solid */
//
// The host-agnostic TUI layer, inlined into BOTH TUI bundles (esbuild bundles
// every relative import, so the deployed `dist/plugins/*` files stay
// self-contained and default-export-only).
//
// `src/tui.tsx` (opencode) and `src/tui.kilo.tsx` (Kilo) differ in three places
// and nowhere else:
//
//   1. the host they read — `OPENCODE_OC_GO_*` vs `KILO_OC_GO_*`, and each
//      host's own auth store (see `hostEnv` / `readAuthJsonApiKey`);
//   2. the sidebar band they register in, and whether they retire a host panel
//      to take it (only Kilo has a token-usage panel to retire);
//   3. where per-session model usage comes from — opencode's own message store
//      vs Kilo's `client.kilocode.sessionModelUsage`.
//
// Everything else is shared verbatim from here: the plan meters, the row
// grammar, the foldable sections, the refresh policy, the settings ladder and
// every failure boundary. The two hosts therefore cannot drift on the parts a
// user actually reads, and a fix in one is the fix in both.
//
// HOST BOUNDARY
// -------------
// The types below are structural on purpose. `TuiTheme` is imported from
// `@opencode-ai/plugin/tui` even though this file is inlined into the Kilo
// bundle too: it is an `import type`, so it is erased at build time and the
// Kilo bundle never requires the opencode package, and both hosts' `TuiTheme`
// is the same declaration (both re-export `RGBA` from the same `@opentui/core`),
// so the assignment is structural. `UsagePanelApi` is the smallest surface the
// shared layer needs; a host `TuiPluginApi` satisfies it structurally, which is
// what lets one implementation serve both without a cast or an `any`.
//
// REACTIVITY
// ----------
// Reactivity in this layer is hand-rolled on purpose. The deployed bundle is
// compiled by esbuild's automatic JSX rather than Solid's compiler, so a child
// written as a plain value is an ordinary evaluated expression: the host is
// free to reuse the element it was handed instead of re-invoking this subtree
// when something changes. A FUNCTION child is the one form the renderer is
// documented to re-evaluate (`insertExpression` wraps it in a render effect),
// so every region whose contents can change after mount is written as a
// function child and every prop carrying a changing value is passed as an
// accessor. Wrapping a region that happens to be static costs nothing and
// removes the question.
//
// THE SLOT BODY IS NOT ONE OF THOSE REGIONS. `@opentui/solid` invokes
// `entry.renderer(ctx, props)` exactly once per mount, inside `AppendEntry`'s
// one-shot body (`renderEntry` in @opentui/solid@0.5.11). A condition read
// there -- a provider gate, a collapse flag, a mode -- is therefore evaluated
// once and latched for the life of the band. Anything that has to react belongs
// in a memo or a `<Show>` inside the returned tree, never in the slot function
// body. `KiloSidebarBand` in `tui.kilo.tsx` is the worked example: it exists
// only to move four conditions out of the body and behind memos.
//
// This was verified against the real host in both directions rather than
// assumed: the collapse toggle and an async snapshot arriving after mount both
// re-render correctly, which is the property this pattern exists to guarantee.

import type { JSX } from "@opentui/solid/jsx-runtime";
import type { TuiTheme } from "@opencode-ai/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import {
  GO_SHARE_LABEL_WIDTH,
  PLAN_LABEL_WIDTH,
  buildPlanRows,
  formatPercentCell,
  formatStatusline,
  isDisplayMode,
  isSnapshotEmpty,
  meterFillPercent,
  meterSeverityForPercent,
  parseBooleanFlag,
  resolveProviderId,
  surfaceSelectionFromDisplayMode,
} from "./tui-helpers.js";
import type {
  PlanRow,
  ProviderSource,
  ResetCountdown,
  SurfaceSelection,
  UsageMeterSeverity,
  UsageRow,
} from "./tui-helpers.js";
import {
  extractSnapshotFromApiPayload,
  hostEnv,
  isRecord,
  mockSnapshot,
  parseMockLimited,
  parseMockPercents,
  parseMockResets,
  readAuthJsonApiKey,
  toNonEmptyString,
  unavailableSnapshot,
  GO_PLAN_HEADING,
  GO_PROVIDER_ID,
  INTEGRATED_GO_SHARE_LABEL,
  SIDEBAR_COLLAPSED_GLYPH,
  SIDEBAR_EXPANDED_GLYPH,
} from "./shared.js";
import type { MockSnapshotOverrides, UsageHost, UsageSnapshot } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// One refresh policy for both hosts, so the numbers on a host's sidebar and its
// statusline can never come from two different cadences: the background poll,
// the event TTL and the debounce below are the same numbers as the ones each
// entry passes to `refreshSafely`.
export const POLL_INTERVAL_MS = 60_000;
export const EVENT_TTL_MS = 15_000;
const DEBOUNCE_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const LOG_SERVICE = "oc-go-usage-display";

// Persisted `api.kv` keys. Each host keeps its own store, so the same names
// never collide across hosts.
export const KV_DISPLAY_KEY = "display";
export const KV_COLLAPSED_SIDEBAR_KEY = "collapsed_sidebar";
export const KV_COLLAPSED_STATUSLINE_KEY = "collapsed_statusline";
const KV_COLLAPSED_LEGACY_KEY = "collapsed";

// ---------------------------------------------------------------------------
// Host surface
// ---------------------------------------------------------------------------

// The smallest `TuiPluginApi` the shared layer touches. Declared with method
// syntax so TypeScript compares these members bivariantly: a host whose
// `client.app.log` types `level` as a union still satisfies it.
export type UsagePanelApi = {
  kv: {
    get<Value = unknown>(key: string, fallback?: Value): Value;
    set(key: string, value: unknown): void;
  };
  client: {
    app: {
      log(entry: { service: string; level: "error"; message: string }): Promise<unknown>;
    };
  };
};

export function reactiveChild(accessor: () => unknown): JSX.Element {
  return accessor as unknown as JSX.Element;
}

export function meterColor(theme: TuiTheme, severity: UsageMeterSeverity) {
  if (severity === "error") return theme.current.error;
  if (severity === "warning") return theme.current.warning;
  return theme.current.textMuted;
}

// ---------------------------------------------------------------------------
// Failure boundary (api.client.app.log, never console; secrets never logged)
// ---------------------------------------------------------------------------

export async function logUsageError(api: UsagePanelApi, message: string): Promise<void> {
  try {
    await api.client.app.log({ service: LOG_SERVICE, level: "error", message });
  } catch {
    // Logging is best-effort; the usage display must never break the host.
  }
}

// ---------------------------------------------------------------------------
// Data boundary (auth.json -> Bearer usage fetch; throws nothing)
// ---------------------------------------------------------------------------

async function fetchJsonWithTimeout(url: string, apiKey: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) return { __rejected: true };
    if (!response.ok) return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadUsageSnapshot(host: UsageHost): Promise<UsageSnapshot | null> {
  if (hostEnv(host, "MOCK") === "1") {
    const overrides: MockSnapshotOverrides = {};
    const percents = parseMockPercents(hostEnv(host, "MOCK_PERCENTS"));
    if (percents !== null) overrides.percents = percents;
    const resets = parseMockResets(hostEnv(host, "MOCK_RESETS"));
    if (resets !== null) overrides.resets = resets;
    const limited = parseMockLimited(hostEnv(host, "MOCK_LIMITED"));
    if (limited !== null) overrides.limited = limited;
    return mockSnapshot(overrides);
  }

  const apiKey = toNonEmptyString(hostEnv(host, "API_KEY")) ?? readAuthJsonApiKey(host);
  if (apiKey === null) return null;

  const payload = await fetchJsonWithTimeout(API_USAGE_URL, apiKey);
  if (payload === null) return null;
  // Mirror the server: a rejected key is a distinct unavailable snapshot
  // (surfaced via `apiError`) rather than a silent null.
  if (isRecord(payload) && payload.__rejected === true) {
    return unavailableSnapshot("API key rejected (401/403)");
  }
  return extractSnapshotFromApiPayload(payload);
}

// ---------------------------------------------------------------------------
// Usage store: the one refresh policy both hosts run
// ---------------------------------------------------------------------------

export type UsageStore = {
  snapshot: () => UsageSnapshot | null;
  // Awaited once at the end of initialization so the first render has data.
  refresh: () => Promise<void>;
  // Fire-and-forget and cannot surface an unhandled rejection. The background
  // poll (no argument) keeps the 60s TTL guard; `session.updated` passes 0 to
  // bypass the TTL entirely (debounce only); `message.updated` passes
  // EVENT_TTL_MS for a 15s effective window.
  refreshSafely: (ttlOverride?: number) => void;
};

export function createUsageStore(api: UsagePanelApi, host: UsageHost): UsageStore {
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | null>(null);
  let cachedAt = 0;
  let lastFetchAt = 0;
  let refreshInFlight = false;

  async function refresh(ttlOverride?: number): Promise<void> {
    if (refreshInFlight) return;
    const effectiveTtl = ttlOverride ?? POLL_INTERVAL_MS;
    if (ttlOverride !== undefined) {
      if (Date.now() - lastFetchAt < DEBOUNCE_MS) return;
      if (Date.now() - cachedAt < effectiveTtl && snapshot() !== null) return;
    } else if (Date.now() - cachedAt < POLL_INTERVAL_MS && snapshot() !== null) {
      return;
    }
    refreshInFlight = true;
    try {
      const next = await loadUsageSnapshot(host);
      if (next === null) {
        if (snapshot() === null) {
          await logUsageError(api, "Go usage unavailable (not configured or request failed)");
        }
        return;
      }
      cachedAt = Date.now();
      setSnapshot(next);
    } catch {
      // Keep stale data; the panel simply shows the last known snapshot.
    } finally {
      lastFetchAt = Date.now();
      refreshInFlight = false;
    }
  }

  return {
    snapshot,
    refresh: () => refresh(),
    refreshSafely: (ttlOverride?: number) => {
      void refresh(ttlOverride).catch(() => {
        // refresh already swallows failures; this guards a regression.
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Settings boundary (new toggles > legacy display; tui.json options > env >
// api.kv > default both on)
// ---------------------------------------------------------------------------

// Structurally the host's `PluginOptions` (`Record<string, unknown>`) on both
// hosts; named so the shared ladder is not typed against either package.
export type DisplayOptions = {
  sidebar?: unknown;
  statusline?: unknown;
  display?: unknown;
};

export function resolveSurfaceSelection(
  options: DisplayOptions | undefined,
  api: UsagePanelApi,
  host: UsageHost,
): SurfaceSelection {
  if (options !== undefined) {
    const sidebarOption = parseBooleanFlag(options.sidebar);
    const statuslineOption = parseBooleanFlag(options.statusline);
    if (sidebarOption !== null || statuslineOption !== null) {
      return { sidebar: sidebarOption ?? true, statusline: statuslineOption ?? true };
    }
    if (isDisplayMode(options.display)) return surfaceSelectionFromDisplayMode(options.display);
  }

  const sidebarEnv = parseBooleanFlag(hostEnv(host, "SIDEBAR"));
  const statuslineEnv = parseBooleanFlag(hostEnv(host, "STATUSLINE"));
  if (sidebarEnv !== null || statuslineEnv !== null) {
    return { sidebar: sidebarEnv ?? true, statusline: statuslineEnv ?? true };
  }

  const displayEnv = toNonEmptyString(hostEnv(host, "DISPLAY"));
  if (displayEnv !== null && isDisplayMode(displayEnv)) {
    return surfaceSelectionFromDisplayMode(displayEnv);
  }

  try {
    const stored = api.kv.get(KV_DISPLAY_KEY, "both");
    if (isDisplayMode(stored)) return surfaceSelectionFromDisplayMode(stored);
  } catch {
    // Persisted settings are best-effort; fall through to the default.
  }
  return { sidebar: true, statusline: true };
}

// ---------------------------------------------------------------------------
// Commands (host keymap, palette-namespace)
// ---------------------------------------------------------------------------
//
// Commands are registered on BOTH host surfaces, because they are two different
// surfaces and neither substitutes for the other:
//
//   - `api.command.register`  -> the ctrl+P palette. Verified on Kilo 7.8.3 and
//     opencode 1.18.33: this is what puts a command in the palette.
//   - `api.keymap.registerLayer` + `slashName` -> the prompt's `/` autocomplete.
//
// Registering only the keymap leaves the palette empty, and registering only the
// legacy shim leaves no slash command. Both are best-effort: either may be absent,
// and a host that offers neither still gets a working plugin.
export type DisplayCommand = {
  name: string;
  title: string;
  desc?: string;
  category?: string;
  slashName?: string;
  run: () => void;
};

export type CommandLayerApi = {
  keymap?: {
    registerLayer?: (layer: {
      commands: ReadonlyArray<DisplayCommand>;
      bindings?: ReadonlyArray<unknown>;
      priority?: number;
    }) => (() => void) | void;
  };
  // Kept for hosts that predate the keymap surface; the shim forwards to it.
  command?: {
    register?: (build: () => LegacyDisplayCommand[]) => (() => void) | void;
  };
};

// The legacy shape, declared exactly as we emit it so a host's own
// `api.command` type stays assignable to `CommandLayerApi`.
type LegacyDisplayCommand = {
  title: string;
  value: string;
  description?: string;
  category?: string;
  slash?: { name: string; aliases?: string[] };
  onSelect: () => void;
};

// `PALETTE_NAMESPACE` is what puts a command in the command palette at all: a
// command without it is bound but unlisted. Both hosts' own plugins set it.
const PALETTE_NAMESPACE = "palette";

// `build` is called on every read rather than snapshotted, so a title always
// describes the state as it is NOW. Two different hosts read it differently: the
// palette copies labels when it lists them, and the slash list when it builds, so
// one of the two would otherwise show a label the other has already moved past.
export function registerDisplayCommands(
  api: CommandLayerApi,
  build: () => ReadonlyArray<DisplayCommand>,
): () => void {
  const disposers: Array<() => void> = [];

  try {
    if (typeof api.keymap?.registerLayer === "function") {
      const dispose = api.keymap.registerLayer({
        commands: build().map((command) => ({ namespace: PALETTE_NAMESPACE, ...command })),
      });
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch {
    // The slash list is a bonus surface; losing it must not cost us the palette.
  }

  try {
    if (typeof api.command?.register === "function") {
      const dispose = api.command.register(() =>
        build().map((command) => {
          const find = (): DisplayCommand =>
            build().find((candidate) => candidate.name === command.name) ?? command;
          // `exactOptionalPropertyTypes`: an absent `desc` must stay absent, not
          // become an explicit `undefined` the host's schema rejects.
          const legacy = {
            get title(): string {
              return find().title;
            },
            value: command.name,
            onSelect: command.run,
          } as LegacyDisplayCommand;
          const current = find();
          if (current.desc !== undefined) legacy.description = current.desc;
          if (current.category !== undefined) legacy.category = current.category;
          if (current.slashName !== undefined) legacy.slash = { name: current.slashName };
          return legacy;
        }),
      );
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch {
    // A host with neither surface gets no commands; never throw over it.
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}

// ---------------------------------------------------------------------------
// Collapse (independent per surface, persisted in `api.kv`)
// ---------------------------------------------------------------------------

// The legacy single `collapsed` key is migrated once (when true, both new keys
// are set true, then the legacy key is cleared) and ignored afterwards.
export type CollapseState = {
  isSidebarCollapsed: () => boolean;
  isStatuslineCollapsed: () => boolean;
  toggleSidebar: () => void;
  toggleStatusline: () => void;
};

function readCollapsedFlag(api: UsagePanelApi, key: string): boolean {
  try {
    return api.kv.get<boolean>(key, false) === true;
  } catch {
    return false;
  }
}

function migrateLegacyCollapsedFlag(api: UsagePanelApi): void {
  let legacyCollapsed = false;
  try {
    legacyCollapsed = api.kv.get<boolean>(KV_COLLAPSED_LEGACY_KEY, false) === true;
  } catch {
    return;
  }
  if (!legacyCollapsed) return;
  try {
    api.kv.set(KV_COLLAPSED_SIDEBAR_KEY, true);
    api.kv.set(KV_COLLAPSED_STATUSLINE_KEY, true);
    api.kv.set(KV_COLLAPSED_LEGACY_KEY, false);
  } catch {
    // Collapse state is best-effort persistence only.
  }
}

export function createCollapseState(api: UsagePanelApi): CollapseState {
  migrateLegacyCollapsedFlag(api);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = createSignal<boolean>(
    readCollapsedFlag(api, KV_COLLAPSED_SIDEBAR_KEY),
  );
  const [isStatuslineCollapsed, setIsStatuslineCollapsed] = createSignal<boolean>(
    readCollapsedFlag(api, KV_COLLAPSED_STATUSLINE_KEY),
  );
  return {
    isSidebarCollapsed,
    isStatuslineCollapsed,
    toggleSidebar() {
      try {
        const next = !isSidebarCollapsed();
        setIsSidebarCollapsed(next);
        api.kv.set(KV_COLLAPSED_SIDEBAR_KEY, next);
      } catch {
        // Collapse state is best-effort persistence only.
      }
    },
    toggleStatusline() {
      try {
        const next = !isStatuslineCollapsed();
        setIsStatuslineCollapsed(next);
        api.kv.set(KV_COLLAPSED_STATUSLINE_KEY, next);
      } catch {
        // Collapse state is best-effort persistence only.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Settings-menu entries
// ---------------------------------------------------------------------------

// The two surfaces a user folds independently, named the way the menu names them.
export type ToggleSurface = "sidebar" | "statusline";

// The label an entry carries RIGHT NOW. An entry that always reads "toggle
// statusline" makes the user remember what state they are in; naming the effect
// ("Go usage: hide statusline" / "Go usage: show statusline") states what pressing
// it will do, so the menu is readable without remembering anything. Pure and
// exported so the exact strings are pinned rather than only visible in a
// screenshot.
export function toggleCommandTitle(surface: ToggleSurface, collapsed: boolean): string {
  return `Go usage: ${collapsed ? "show" : "hide"} ${surface}`;
}

export const TOGGLE_COMMAND_PREFIX = "oc-go-usage-display.toggle-";

export function toggleCommandValue(surface: ToggleSurface): string {
  return `${TOGGLE_COMMAND_PREFIX}${surface}`;
}

export const TOGGLE_COMMAND_CATEGORY = "Go";

// The structural shape of a host command entry, so this layer does not have to
// import either host's SDK to describe one. A getter satisfies a plain `string`
// property, which is why this stays assignable to both `TuiCommand` shapes.
export type SurfaceToggleCommand = {
  readonly title: string;
  readonly value: string;
  readonly category: string;
  onSelect: () => void;
};

// One entry per foldable surface, labelled with what selecting it will do.
//
// `title` is a getter, so the label is computed when the host reads it rather than
// when the factory ran. That is necessary but NOT sufficient on its own: Kilo's
// palette takes a copy of each entry's title as it registers it, so a folded
// surface kept advertising "hide". `registerSurfaceToggleCommands` therefore hands
// the entries back after every fold, which is what makes the label follow the
// state on a host that snapshots.
export function surfaceToggleCommands(
  collapse: CollapseState,
  afterToggle?: () => void,
): SurfaceToggleCommand[] {
  return (["sidebar", "statusline"] as const).map((surface) => {
    const toggle = surface === "sidebar" ? collapse.toggleSidebar : collapse.toggleStatusline;
    return {
      get title(): string {
        return toggleCommandTitle(
          surface,
          surface === "sidebar" ? collapse.isSidebarCollapsed() : collapse.isStatuslineCollapsed(),
        );
      },
      value: toggleCommandValue(surface),
      category: TOGGLE_COMMAND_CATEGORY,
      onSelect: () => {
        toggle();
        afterToggle?.();
      },
    };
  });
}

// The smallest `api.command` this needs. Optional on the host too: it is a
// deprecated shim and a host may omit it entirely, in which case there is no menu
// to keep honest and every step here degrades to a no-op.
export type ToggleCommandHost = {
  command?: {
    register: (callback: () => SurfaceToggleCommand[]) => () => void;
  };
};

// Register the menu entries, and keep their labels true.
//
// Two mechanisms, because a host may do either: `title` is a getter (cheap, and
// correct if the host reads the property when it draws) and the entries are
// re-registered after every fold (correct if the host copied the title when it
// took the entry, which is what Kilo's palette does). Re-registering is the belt to
// the getter's braces, and it costs one call per user-initiated fold.
//
// Returns the disposer for the CURRENT registration, which is what the host's
// `onDispose` should call.
export function registerSurfaceToggleCommands(
  host: ToggleCommandHost,
  collapse: CollapseState,
  extra?: () => SurfaceToggleCommand[],
): () => void {
  let disposeCurrent: () => void = () => {};

  const register = (): void => {
    // Drop the previous entries first: the host accumulates registrations, and
    // leaving them behind would show the same command twice.
    disposeCurrent();
    try {
      const unregister = host.command?.register(() => [
        ...surfaceToggleCommands(collapse, register),
        ...(extra?.() ?? []),
      ]);
      disposeCurrent = typeof unregister === "function" ? unregister : () => {};
    } catch {
      // Legacy command registration is optional; ignore failures.
    }
  };

  register();
  return () => disposeCurrent();
}

// ---------------------------------------------------------------------------
// Provider gate
// ---------------------------------------------------------------------------

export function isGoUsageProvider(providerId: string | undefined): boolean {
  return providerId === GO_PROVIDER_ID;
}

// ---------------------------------------------------------------------------
// Retiring a host panel we take a band from
// ---------------------------------------------------------------------------

// The smallest `api.plugins` a panel switch touches. Structural, like the rest of
// this layer: a host whose status entries narrow `active`/`enabled` still fits.
export type HostPanelSwitchApi = UsagePanelApi & {
  plugins: {
    list: () => ReadonlyArray<{ id?: unknown; active?: unknown; enabled?: unknown }>;
    activate: (id: string) => Promise<unknown>;
    deactivate: (id: string) => Promise<unknown>;
  };
};

// Whether a host panel is currently switched on, or null when the host does not
// report it. Reading the state first keeps every launch from writing an unchanged
// enable/disable entry.
export function currentHostPanelEnabled(api: HostPanelSwitchApi, pluginId: string): boolean | null {
  try {
    const entry = api.plugins.list().find((status) => status.id === pluginId);
    if (entry === undefined) return null;
    return entry.active === true || entry.enabled === true;
  } catch {
    return null;
  }
}

// Put a host panel into `wantEnabled`, which is the runtime form of the
// `plugin_enabled` map in a `tui.json` and is what makes the switch survive a
// restart. Returns whether the panel is now in the requested state.
//
// This exists only because a slot renderer runs once per mount, so the decision
// has to be re-applied from a reactive region rather than once at load. It is here,
// and not in the Kilo entry, for one reason: the band that owns it cannot be
// mounted without a renderer, so a test could otherwise only reach this code by
// booting the host. Exported, the whole ownership matrix is drivable against a stub.
//
// Every step is best-effort. A failure leaves both panels on screen and is logged
// through the host, never thrown: a sidebar is not worth destabilising a session.
export async function applyHostPanelEnabled(
  api: HostPanelSwitchApi,
  pluginId: string,
  wantEnabled: boolean,
): Promise<boolean> {
  try {
    const current = currentHostPanelEnabled(api, pluginId);
    if (current === wantEnabled) return true;
    const applied = await (wantEnabled
      ? api.plugins.activate(pluginId)
      : api.plugins.deactivate(pluginId));
    if (applied === true) return true;
    await logUsageError(
      api,
      `Could not ${wantEnabled ? "enable" : "disable"} the host's ${pluginId} panel`,
    );
    return false;
  } catch (error) {
    await logUsageError(
      api,
      `Host ${pluginId} panel switch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// Which provider is in use, read live on every render rather than latched at
// init. Latching left the gate closed for anyone without a config-level model,
// and `session.updated` only fires on a server-side change, so opening a
// session or switching model in the picker never re-armed it -- the plugin
// loaded, showed as `active` in the Plugins menu, and rendered nothing.
export function makeProviderResolver(
  state: ProviderSource | undefined,
  fallback: () => string | undefined,
): (sessionId: string) => string | undefined {
  return (sessionId: string) => resolveProviderId(state, sessionId, fallback());
}

// ---------------------------------------------------------------------------
// Provider / model display names
// ---------------------------------------------------------------------------

// The provider catalog as far as the panels need it. Both hosts expose the same
// shape (`state.provider[].id|name|models[modelID].name`); the fields are read
// through `toNonEmptyString`, so a host that renames or drops one degrades to
// the raw id rather than rendering `undefined`.
export type ProviderCatalogSource = {
  state?: {
    provider?: ReadonlyArray<{
      id?: unknown;
      name?: unknown;
      models?: Readonly<Record<string, { name?: unknown } | undefined>>;
    }>;
  };
};

export function readProviderDisplayNames(source: ProviderCatalogSource): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  try {
    for (const provider of source.state?.provider ?? []) {
      const id = toNonEmptyString(provider.id);
      if (id === null) continue;
      names.set(id, toNonEmptyString(provider.name) ?? id);
    }
  } catch {
    // The catalog is optional: a group falls back to its raw provider id.
  }
  return names;
}

export function readModelDisplayName(
  source: ProviderCatalogSource,
  providerID: string,
  modelID: string,
): string | null {
  try {
    const provider = source.state?.provider?.find((entry) => entry.id === providerID);
    return toNonEmptyString(provider?.models?.[modelID]?.name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row grammar
// ---------------------------------------------------------------------------

// A `space-between` label/value row, the grammar the hosts' own panels use.
export function LabeledValueRow(props: { theme: TuiTheme; row: UsageRow }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.theme.current.textMuted} wrapMode="none">
        {props.row.label}
      </text>
      <text fg={props.theme.current.textMuted} wrapMode="none">
        {props.row.value}
      </text>
    </box>
  );
}

// The narrowest a meter may become before it stops being a meter: enough to read
// a filled-vs-empty split at a glance.
export const MIN_METER_WIDTH = 6;

// The meter's two parts, as a SPLIT rather than as two flexible boxes.
//
// The FILL and the TRACK are flex WEIGHTS that sum to 100, on a zero basis, and a
// part that comes out at zero is not rendered at all. That is the whole point, and
// each of the two obvious alternatives moved the block:
//
//   - two `flexGrow` parts on their default basis: the track keeps a one-cell
//     basis that flex will not shrink away, so at 100% the fill wants the whole
//     meter and the track still claims a cell. It paints itself into the padding
//     beside the percent -- the cell of the wrong color to the right of a full bar
//     -- and makes the meter a cell wider at 100% than anywhere else.
//   - both parts as `width: "<n>%"`: no overflow, but two independent
//     percentage-to-cell roundings that need not agree. At 50% of a 27-cell meter
//     the fill took 13 and the track 13, so the pair was 26 and the bar sat a cell
//     short. A percentage cannot express "the rest of this box".
//
// A zero basis makes each part's width purely its share of the space the row gave
// the meter, so the two add up to the meter at every reading.
//
// The meter is two BOXES rather than a string of block glyphs. A glyph string has a
// fixed cell count, and a plugin cannot measure the sidebar it renders into
// (opentui resolves a text node's `width` as a wrapping bound, and no layout
// callback reaches a plugin), so a glyph meter is either too short for a wide
// sidebar or clipped by a narrow one. Boxes fill whatever the row gives them,
// which is why the meter reaches the sidebar's right edge on any host at any width.
//
// The track is a surface tone rather than the severity colour, so an empty meter
// reads as an empty track instead of blank space.
export function MeterBar(props: { theme: TuiTheme; percent: number; severity: UsageMeterSeverity }) {
  const fill = createMemo(() => meterFillPercent(props.percent));
  const track = createMemo(() => 100 - fill());
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={MIN_METER_WIDTH}>
      <Show when={fill() > 0}>
        <box
          flexGrow={fill()}
          flexBasis={0}
          flexShrink={0}
          backgroundColor={meterColor(props.theme, props.severity)}
        />
      </Show>
      <Show when={track() > 0}>
        <box
          flexGrow={track()}
          flexBasis={0}
          flexShrink={0}
          backgroundColor={props.theme.current.backgroundElement}
        />
      </Show>
    </box>
  );
}

// One plan window as a row of three FIXED-WIDTH columns: label, bar, percent.
//
// Not `justifyContent="space-between"` on a label plus a bar: that lets the bar
// start wherever the label happened to end, so the three meters only look
// stacked when every label is the same width -- and a terminal font that draws
// the empty meter glyph narrower than the full one shifts the bar of a 0% row
// against a 100% one (seen at 30d 100% next to 5h 0%). Fixed columns make the
// meters stack whatever the font does, and the percentages right-align on one
// edge.
export function GoPlanRow(props: { theme: TuiTheme; row: PlanRow }) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        {/* The label sits in a fixed-width BOX, not a fixed-width text: opentui
            treats a text node's `width` as a wrapping bound, so the box after it
            still starts wherever the label ended -- "5h" and "30d" then draw
            their meters a cell apart. A box is a real layout box, which is why
            Kilo's Steps/Cost columns (boxes) line up and these did not. */}
        {/* The label cell is exactly `30d` wide and carries a one-cell margin:
            without it the longest label butts straight into the meter, while the
            shorter `5h`/`7d` happen to leave one behind -- the meter has to start
            the same column on every row, so the separation is a layout fact and
            not something the label's own length may decide. */}
        <box width={PLAN_LABEL_WIDTH} marginRight={1} flexShrink={0} flexDirection="row">
          <text fg={props.theme.current.textMuted} wrapMode="none">
            {props.row.label}
          </text>
        </box>
        <MeterBar theme={props.theme} percent={props.row.percent} severity={props.row.severity} />
        <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0}>
          {formatPercentCell(props.row.percent)}
        </text>
      </box>
      <Show when={props.row.reset}>
        {(reset) => (
          <text fg={props.theme.current.textMuted} wrapMode="none">
            resets in {reset()}
          </text>
        )}
      </Show>
    </box>
  );
}

export function GoPlanSection(props: { theme: TuiTheme; rows: PlanRow[] }) {
  return (
    <box flexDirection="column">
      <text fg={props.theme.current.text} wrapMode="none">
        <b>{GO_PLAN_HEADING}</b>
      </text>
      <box flexDirection="column" paddingLeft={1}>
        <For each={props.rows}>
          {(row) => <GoPlanRow theme={props.theme} row={row} />}
        </For>
      </box>
    </box>
  );
}

export function SectionHeader(props: {
  theme: TuiTheme;
  label: string;
  expanded: () => boolean;
  count: () => number | null;
  onToggle: () => void;
}) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0} onMouseDown={props.onToggle}>
      <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
        {reactiveChild(() => (props.expanded() ? SIDEBAR_EXPANDED_GLYPH : SIDEBAR_COLLAPSED_GLYPH))}
      </text>
      <text fg={props.theme.current.text} wrapMode="none">
        <b>
          {reactiveChild(() => {
            const count = props.count();
            return count === null ? props.label : `${props.label} (${count})`;
          })}
        </b>
      </text>
    </box>
  );
}

// A collapsible region: the header reacts to its own state, and the body is a
// memo so an unchanged subtree keeps the very same element instead of being
// rebuilt on every unrelated signal write.
export function CollapsibleSection(props: {
  theme: TuiTheme;
  label: string;
  count: () => number | null;
  expanded: () => boolean;
  onToggle: () => void;
  body: () => JSX.Element;
}) {
  const content = createMemo(() => (props.expanded() ? props.body() : null));
  return (
    <box flexDirection="column">
      <SectionHeader
        theme={props.theme}
        label={props.label}
        count={props.count}
        expanded={props.expanded}
        onToggle={props.onToggle}
      />
      <box flexDirection="column" gap={1}>
        {reactiveChild(content)}
      </box>
    </box>
  );
}

// A model's Go share: the bar and the percent pinned to the RIGHT edge of the row,
// so they line up with the Steps/Cost columns of the table above instead of
// trailing the label wherever it happens to end.
//
// The label sits in a FIXED-width cell and only the meter grows -- the same shape
// as `GoPlanRow`, and deliberately not a `flexGrow` label with a `gap`. Two
// flexible children divide the slack between them, and the share meter was doing
// exactly that: 18 cells wide at 50% and 20 at 100%, with its percent sliding a
// column each time. This row's number is a share of tokens, not of the plan, so
// its bar is not comparable with the plan meters' -- but its own geometry must
// still not depend on its own value.
export function GoShareRow(props: { theme: TuiTheme; percent: number }) {
  const rounded = Math.round(props.percent);
  return (
    <box flexDirection="row">
      <box width={GO_SHARE_LABEL_WIDTH} marginRight={1} flexShrink={0} flexDirection="row">
        <text fg={props.theme.current.textMuted} wrapMode="none">
          {INTEGRATED_GO_SHARE_LABEL}
        </text>
      </box>
      <MeterBar theme={props.theme} percent={rounded} severity={meterSeverityForPercent(rounded)} />
      <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0}>
        {formatPercentCell(rounded)}
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// The compact `Go Usage` block both hosts lead the sidebar with
// ---------------------------------------------------------------------------

// The `Go Usage` block both hosts lead their sidebar with: the next reset on one
// line, then the plan as the meters themselves, one row per window, stacked in
// fixed-width columns.
//
// One shape for both hosts, on purpose. Kilo's standalone band and opencode's
// whole sidebar used to be different layouts (label/value rows with a separate
// `Go Plan` heading, versus meters inline), which meant the plan looked like a
// different feature depending on where it was drawn. Kilo's integrated mode does
// not use this block at all -- the plan is drawn once, inside its Models table
// where it belongs to the provider it meters.
//
// There is no meter width in here to tune: `MeterBar` fills the row.
export function GoUsageBlock(props: {
  api: UsagePanelApi;
  theme: TuiTheme;
  snapshot: () => UsageSnapshot | null;
  resetLine?: () => ResetCountdown | null;
}) {
  createEffect(() => {
    const snapshot = props.snapshot();
    if (snapshot !== null && snapshot.source === "unavailable") {
      void logUsageError(
        props.api,
        snapshot.apiError ? `Go usage unavailable (${snapshot.apiError})` : "Go usage snapshot unavailable",
      );
    }
  });

  const body = createMemo(() => {
    const snapshot = props.snapshot();
    if (snapshot === null) {
      return (
        <text fg={props.theme.current.textMuted} wrapMode="none">
          Go loading…
        </text>
      );
    }
    // Rejected keys (and other unavailable snapshots) must surface a row
    // instead of a bare header with zero rows. The statusline stays hidden for
    // unavailable (isSnapshotEmpty -> null).
    if (snapshot.source === "unavailable") {
      return (
        <text fg={props.theme.current.textMuted} wrapMode="none">
          Go n/a ({snapshot.apiError ?? "unavailable"})
        </text>
      );
    }
    // The per-row `resets in` suffix is dropped here: `resetLine` already prints
    // the plan's countdown under the header, and printing one countdown twice in
    // a single block is noise rather than emphasis. Both that line and the
    // statusline read `relevantReset`, so the block and the statusline can only
    // ever be counting down to the same window.
    const planRows = buildPlanRows(snapshot).map((row) => ({ ...row, reset: null }));
    return (
      <box flexDirection="column">
        <Show when={props.resetLine === undefined ? null : props.resetLine()}>
          {(reset) => (
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {reset().label} resets in {reset().text}
            </text>
          )}
        </Show>
        <For each={planRows}>{(row) => <GoPlanRow theme={props.theme} row={row} />}</For>
      </box>
    );
  });

  return (
    <box flexDirection="column">
      <text fg={props.theme.current.text}>
        <b>Go Usage</b>
      </text>
      {reactiveChild(body)}
    </box>
  );
}

// The compact statusline: one muted line next to the host's context readout.
export function GoStatusline(props: { snapshot: () => UsageSnapshot | null }) {
  return (
    <Show when={props.snapshot()} fallback={null}>
      {(snapshot) => {
        if (isSnapshotEmpty(snapshot())) return null;
        return <text>{formatStatusline(snapshot())}</text>;
      }}
    </Show>
  );
}
