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
// This was verified against the real host in both directions rather than
// assumed: the collapse toggle and an async snapshot arriving after mount both
// re-render correctly, which is the property this pattern exists to guarantee.

import type { JSX } from "@opentui/solid/jsx-runtime";
import type { TuiTheme } from "@opencode-ai/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import {
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
} from "./helpers.js";
import type {
  PlanRow,
  ProviderSource,
  SurfaceSelection,
  UsageMeterSeverity,
  UsageRow,
} from "./helpers.js";
import {
  extractSnapshotFromApiPayload,
  hostEnv,
  isRecord,
  mockSnapshot,
  readAuthJsonApiKey,
  toNonEmptyString,
  unavailableSnapshot,
  GO_PLAN_HEADING,
  GO_PROVIDER_ID,
  INTEGRATED_GO_SHARE_LABEL,
  SIDEBAR_COLLAPSED_GLYPH,
  SIDEBAR_EXPANDED_GLYPH,
} from "./shared.js";
import type { UsageHost, UsageSnapshot } from "./shared.js";

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
  if (hostEnv(host, "MOCK") === "1") return mockSnapshot();

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
// Provider gate
// ---------------------------------------------------------------------------

export function isGoUsageProvider(providerId: string | undefined): boolean {
  return providerId === GO_PROVIDER_ID;
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

// A meter as two boxes: the filled part at the window's percentage, the track for
// the rest. Both fill whatever the row has, so the bar reaches the sidebar's
// right edge on any host, at any sidebar width, with nothing to measure and
// nothing to guess -- the failure modes a fixed-width glyph string has (too short
// on a wide sidebar, clipped on a narrow one) cannot happen.
//
// The track is a surface tone rather than the severity colour, so an empty meter
// reads as an empty track instead of blank space.
export function MeterBar(props: { theme: TuiTheme; percent: number; severity: UsageMeterSeverity }) {
  const fill = createMemo(() => meterFillPercent(props.percent));
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={MIN_METER_WIDTH}>
      <box width={`${fill()}%`} backgroundColor={meterColor(props.theme, props.severity)} />
      <box flexGrow={1} backgroundColor={props.theme.current.backgroundElement} />
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
        <box width={PLAN_LABEL_WIDTH} flexShrink={0} flexDirection="row">
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
        {reactiveChild(() => (props.expanded() ? props.body() : null))}
      </box>
    </box>
  );
}

// A model's share of the Go tokens spent in this session tree, drawn with the
// same block bar and the same threshold coloring as the plan meters. It is a
// share of tokens and nothing else: not of the plan, not a quota, not a price.
// A model's Go share: the bar and the percent pinned to the RIGHT edge of the
// row, so they line up with the Steps/Cost columns of the table above instead of
// trailing the label wherever it happens to end. The label takes the slack
// (`flexGrow`), the meter group never shrinks.
export function GoShareRow(props: { theme: TuiTheme; percent: number }) {
  const rounded = Math.round(props.percent);
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0} flexGrow={1}>
        {INTEGRATED_GO_SHARE_LABEL}
      </text>
      <MeterBar
        theme={props.theme}
        percent={rounded}
        severity={meterSeverityForPercent(rounded)}
      />
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
  resetLine?: () => string | null;
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
    // the soonest countdown under the header, and printing the same countdown
    // twice in one block is noise rather than emphasis.
    const planRows = buildPlanRows(snapshot).map((row) => ({ ...row, reset: null }));
    return (
      <box flexDirection="column">
        <Show when={props.resetLine === undefined ? null : props.resetLine()}>
          {(line) => (
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {line()}
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
