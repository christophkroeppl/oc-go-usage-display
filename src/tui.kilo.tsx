/** @jsxImportSource @opentui/solid */
//
// OpenCode Go usage TUI plugin (dual-surface display).
//
// Renders subscription usage in two additive multi-render slots. `SLOT_ORDER`
// (KILO_SLOT_ORDER) is a free band in Kilo's own `sidebar_content` ladder, so
// the block is placed deterministically instead of tied with a host panel:
//   50 kilo-sidebar-pr | 100 sidebar-context | 150 kilo-sidebar-usage
//   | 200 sidebar-mcp | 225 kilo-sidebar-indexing
//   | 250 kilo-sidebar-background-processes | 300 sidebar-lsp
//   | 400 sidebar-todo | 500 sidebar-files | 1000 kilo-sidebar-memory
// 100 < 125 < 150 therefore renders directly below Kilo's `Context` panel and
// above its `Token Usage` block, keeping both usage readouts adjacent at the
// top of the sidebar; worktrunk renders elsewhere so multi-render stacking is
// unaffected. Kilo's own `session_prompt_right` panels sit at 50/51, so the
// same order puts this statusline rightmost:
//   - `sidebar_content`      -> titled block, e.g. `Go Usage` header plus one
//     muted row per window (`5h 42%`, `7d 15%`, `30d 61%`). The header box
//     carries no paddingLeft/gap so `Go Usage` aligns flush left like the
//     `Context` header. A `Go Plan` section follows it: a bold heading with the
//     three plan windows indented one level, each a muted label plus a 16-cell
//     meter whose whole bar is colored by threshold (muted < 75% <= warning <
//     90% <= error, and error for a capped window regardless of percent), with
//     a `resets in <duration>` line under a capped row.
//   - `session_prompt_right` -> compact single line next to the context status
//     info (e.g. `Go 5h 42% | 7d 15% | 30d 61%`), where the `80.6K (8%) · $0.09` readout
//     lives. Additive multi-render only; `sidebar_footer` (single_winner,
//     replaces name/version) is never used.
//
// Display surface is user-configurable (default both on; static selection
// still requires restart):
//   1. TUI plugin options in tui.json: `[..., {"sidebar": true, "statusline": true}]`
//   2. `OPENCODE_GO_SIDEBAR` / `OPENCODE_GO_STATUSLINE` env vars (0/1/false/true)
//   3. Legacy `display` option (`"sidebar"|"statusline"|"both"`) in tui.json,
//      `OPENCODE_GO_DISPLAY` env var, or persisted `api.kv` key `display`
//      (checked in that order when the new toggles are absent)
// Only the selected surface(s) register a slot. Both slots are additive
// multi-render (`sidebar_content` + `session_prompt_right`), so no
// `single_winner` slot is ever used; each slot returns null when its own
// collapse flag is set or when empty so it collapses instead of reserving
// space.
// (`session_prompt_right` is the primary statusline slot; if a future host
// drops it, the additive fallbacks would be `home_footer` / `home_bottom`.)
//
// Collapse is independent per surface and persisted in `api.kv`:
//   - `collapsed_sidebar` toggled by `oc-go-usage-display.toggle-sidebar`
//     (title `Go usage: toggle sidebar`), checked only by `sidebar_content`.
//   - `collapsed_statusline` toggled by `oc-go-usage-display.toggle-statusline`
//     (title `Go usage: toggle statusline`), checked only by
//     `session_prompt_right`.
// The legacy single `collapsed` key is migrated once on startup (when true,
// both new keys are set true, then the legacy key is cleared) and ignored
// afterwards.
//
// Sidebar placement is a third axis, alongside the two surface booleans
// (`sidebar_mode`, default `integrated`), resolved exactly like them — TUI
// plugin option in tui.json -> `KILO_OC_GO_SIDEBAR_MODE` -> `api.kv`
// `sidebar_mode` -> default. (Kilo's tui.json schema rejects the option, so on
// this host the option path is only reachable in-process, the same situation
// the `sidebar`/`statusline` options are in.)
//   - `standalone` -> register at KILO_SLOT_ORDER (125), Kilo's own
//     `Token Usage` panel stays where it is.
//   - `integrated` -> register at KILO_INTEGRATED_SLOT_ORDER (150) and switch
//     `internal:kilo-sidebar-usage` off, so one band carries the Go readout
//     instead of two competing ones. Kilo's panel cannot be extended (the real
//     slot registry is unreachable from a plugin), so integrated mode retires
//     it through `api.plugins.deactivate` — the runtime form of the
//     `plugin_enabled` map in tui.json, and reversible via `activate`.
//     Retiring it also means replacing what it drew, so the 150 band in
//     integrated mode renders three sections instead of one block:
//       Go Usage         the compact plan readout, as in standalone
//       Session Tokens   Kilo's `Token Usage` rows, from the host endpoint.
//                        Deliberately not titled `Token Usage`: that is the
//                        name of the panel integrated mode retired, and a
//                        second header with it would be indistinguishable
//                        from the panel that was supposed to go.
//       Models (N)      Kilo's per-model table, models grouped by provider.
//                        Inside the `OpenCode Go` group the `Go Plan` meters
//                        sit between the provider header and the model rows,
//                        and each Go model row carries a `Go share` line —
//                        its share of the Go tokens in this session tree,
//                        never of the plan, and never a price.
//     The two sections collapse like Kilo's own (local state, both expanded
//     by default), and model rows fold per model.
//   The mode is switched live by `oc-go-usage-display.toggle-sidebar-mode`
//   (title `Go usage: toggle sidebar mode`); the host panel follows
//   immediately, the slot ORDER is bound at registration and moves on the next
//   TUI start (the SDK exposes no slot unregister).
//
// Data: Kilo's own auth.json (dataShare ~/.local/share/kilo/auth.json or
// $XDG_DATA_HOME/kilo/auth.json, then $KILO_CONFIG_DIR / ~/.config/kilo,
// `opencode-go` key else `opencode` key) as Bearer for
// GET https://opencode.ai/zen/go/v1/usage, refreshed on a 60s poll plus
// `session.updated` / `message.updated` events. Integrated mode's per-session
// split comes from the host's own `client.kilocode.sessionModelUsage`
// (GET /session/{sessionID}/model-usage), refreshed on the same events Kilo's
// panel uses and never on a timer. The opencode bundle reads the opencode
// stores instead; each host reads only its own. Failures keep stale data and
// never break the host; errors go to api.client.app.log (never console).
// Secrets are never logged.
//
// Coexistence: the server plugin `src/index.ts` (`go_usage` tool only)
// stays as the headless/Desktop fallback. This module exports
// only `tui` (never `server`) under id `oc-go-usage-display`.

import type { JSX } from "@opentui/solid/jsx-runtime";
import type { PluginOptions } from "@kilocode/plugin";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiTheme,
} from "@kilocode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  buildModelTokenRows,
  buildPlanRows,
  buildTokenUsageRows,
  buildUsageRows,
  formatStatusline,
  formatUsageCost,
  formatUsageCount,
  goSharePercent,
  groupModelsByProvider,
  isDisplayMode,
  isSnapshotEmpty,
  meterSeverityForPercent,
  modelDisplayName,
  parseBooleanFlag,
  parseSidebarMode,
  resolveProviderId,
  surfaceSelectionFromDisplayMode,
  totalGoTokens,
  usageMeterBar,
  usageTokenCount,
  DEFAULT_SIDEBAR_MODE,
} from "./helpers.js";
import type {
  ModelProviderGroup,
  PlanRow,
  SidebarMode,
  SurfaceSelection,
  UsageMeterSeverity,
  UsageRow,
} from "./helpers.js";
import {
  errorMessage,
  extractSnapshotFromApiPayload,
  isRecord,
  mockSnapshot,
  parseSessionModelUsage,
  readAuthJsonApiKey,
  toNonEmptyString,
  unavailableSnapshot,
  hostEnv,
  GO_PROVIDER_ID,
  GO_PLAN_HEADING,
  INTEGRATED_EMPTY_LABEL,
  INTEGRATED_GO_SHARE_LABEL,
  INTEGRATED_LOADING_LABEL,
  INTEGRATED_MODELS_SECTION_LABEL,
  INTEGRATED_TOKENS_SECTION_LABEL,
  INTEGRATED_UNAVAILABLE_LABEL,
  KILO_COLLAPSED_GLYPH,
  KILO_COST_COLUMN_WIDTH,
  KILO_EXPANDED_GLYPH,
  KILO_INTEGRATED_SLOT_ORDER,
  KILO_SLOT_ORDER,
  KILO_STEPS_COLUMN_WIDTH,
  KILO_USAGE_PANEL_PLUGIN_ID,
} from "./shared.js";
import type { ModelUsage, SessionModelUsage, UsageHost, UsageSnapshot } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const POLL_INTERVAL_MS = 60_000;
const EVENT_TTL_MS = 15_000;
const DEBOUNCE_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

// The endpoint reports the whole top-level session tree, so a change in a child
// session still changes our numbers. The walk is bounded because a cycle in the
// host's parent chain must not hang a render.
const SESSION_TREE_WALK_LIMIT = 32;

// This entry is the Kilo build, so it resolves `KILO_OC_GO_*` and never reads
// an opencode-prefixed name.
const HOST: UsageHost = "kilo";
const SLOT_ORDER = KILO_SLOT_ORDER;
const INTEGRATED_SLOT_ORDER = KILO_INTEGRATED_SLOT_ORDER;
const KV_DISPLAY_KEY = "display";
const KV_SIDEBAR_MODE_KEY = "sidebar_mode";
const KV_COLLAPSED_SIDEBAR_KEY = "collapsed_sidebar";
const KV_COLLAPSED_STATUSLINE_KEY = "collapsed_statusline";
const KV_COLLAPSED_LEGACY_KEY = "collapsed";
const LOG_SERVICE = "oc-go-usage-display";

// ---------------------------------------------------------------------------
// Trusted types (parsed at the boundary, trusted internally; usage shapes
// live in `./shared.js` so server and TUI parse identically; display-mode
// helpers live in `./helpers.js` to keep this entry module export-free)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings boundary (new toggles > legacy display; tui.json options > env >
// api.kv > default both on)
// ---------------------------------------------------------------------------

function resolveSurfaceSelection(options: PluginOptions | undefined, api: TuiPluginApi): SurfaceSelection {
  if (options !== undefined) {
    const sidebarOption = parseBooleanFlag(options.sidebar);
    const statuslineOption = parseBooleanFlag(options.statusline);
    if (sidebarOption !== null || statuslineOption !== null) {
      return { sidebar: sidebarOption ?? true, statusline: statuslineOption ?? true };
    }
    if (isDisplayMode(options.display)) return surfaceSelectionFromDisplayMode(options.display);
  }

  const sidebarEnv = parseBooleanFlag(hostEnv(HOST, "SIDEBAR"));
  const statuslineEnv = parseBooleanFlag(hostEnv(HOST, "STATUSLINE"));
  if (sidebarEnv !== null || statuslineEnv !== null) {
    return { sidebar: sidebarEnv ?? true, statusline: statuslineEnv ?? true };
  }

  const displayEnv = toNonEmptyString(hostEnv(HOST, "DISPLAY"));
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

// Sidebar placement uses the same precedence ladder as the surface selection,
// including the Kilo-hostile case of an option its tui.json schema cannot
// carry: the plugin cannot fix the host's schema, and it must not skip the
// option because of it (that would silently diverge from `resolveSurfaceSelection`
// and make the two axes disagree about which source won).
function resolveSidebarMode(options: PluginOptions | undefined, api: TuiPluginApi): SidebarMode {
  if (options !== undefined) {
    const option = parseSidebarMode(options.sidebar_mode);
    if (option !== null) return option;
  }

  const env = parseSidebarMode(hostEnv(HOST, "SIDEBAR_MODE"));
  if (env !== null) return env;

  try {
    const stored = parseSidebarMode(api.kv.get<unknown>(KV_SIDEBAR_MODE_KEY, null));
    if (stored !== null) return stored;
  } catch {
    // Persisted settings are best-effort; fall through to the default.
  }
  return DEFAULT_SIDEBAR_MODE;
}

// Whether the host's own token-usage panel is currently switched on, or null
// when the host does not report it. Reading the state first keeps every launch
// from writing an unchanged `plugin_enabled` entry.
function hostUsagePanelEnabled(api: TuiPluginApi): boolean | null {
  try {
    const entry = api.plugins?.list?.().find((status) => status.id === KILO_USAGE_PANEL_PLUGIN_ID);
    if (entry === undefined) return null;
    return entry.active || entry.enabled;
  } catch {
    return null;
  }
}

// Integrated mode replaces Kilo's `Token Usage` band, so the host panel has to
// go; standalone mode puts it back. The SDK's `deactivate`/`activate` are the
// runtime form of the `plugin_enabled` map in tui.json and persist to KV, which
// is what makes the switch survive a restart. Kilo's panel is not reachable
// through `api.slots` (that facade only exposes `register`), so this is the
// only supported way to take its band. Every step is best-effort: a failure
// leaves both panels on screen and is logged, never thrown.
async function applyHostUsagePanel(api: TuiPluginApi, mode: SidebarMode): Promise<void> {
  const wantEnabled = mode === "standalone";
  try {
    const current = hostUsagePanelEnabled(api);
    if (current === wantEnabled) return;
    const applied = await (wantEnabled
      ? api.plugins.activate(KILO_USAGE_PANEL_PLUGIN_ID)
      : api.plugins.deactivate(KILO_USAGE_PANEL_PLUGIN_ID));
    if (applied === true) return;
    await logUsageError(
      api,
      `Could not ${wantEnabled ? "enable" : "disable"} Kilo's ${KILO_USAGE_PANEL_PLUGIN_ID} panel`,
    );
  } catch (error) {
    await logUsageError(
      api,
      `Kilo ${KILO_USAGE_PANEL_PLUGIN_ID} panel switch failed: ${errorMessage(error)}`,
    );
  }
}

function readCollapsedFlag(api: TuiPluginApi, key: string): boolean {
  try {
    return api.kv.get<boolean>(key, false) === true;
  } catch {
    return false;
  }
}

function migrateLegacyCollapsedFlag(api: TuiPluginApi): void {
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

function isGoUsageProvider(providerId: string | undefined): boolean {
  return providerId === GO_PROVIDER_ID;
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

async function loadUsageSnapshot(): Promise<UsageSnapshot | null> {
  if (hostEnv(HOST, "MOCK") === "1") return mockSnapshot();

  const apiKey = toNonEmptyString(hostEnv(HOST, "API_KEY")) ?? readAuthJsonApiKey(HOST);
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

async function logUsageError(api: TuiPluginApi, message: string): Promise<void> {
  try {
    await api.client.app.log({ service: LOG_SERVICE, level: "error", message });
  } catch {
    // Logging is best-effort; the usage display must never break the host.
  }
}

// The only data source for the integrated panel. This is the same typed call
// Kilo's own panel makes (`client.kilocode.sessionModelUsage`), which the SDK
// resolves to `GET /session/{sessionID}/model-usage`; that path is a PATH param
// and is pinned against the real host by test/e2e/kilo-contract.test.js,
// because `/kilocode/sessionModelUsage` 404s and `/session/model-usage` collides
// with `/session/:id`. No timer: the panel refreshes on host events instead.
async function fetchSessionModelUsage(
  api: TuiPluginApi,
  sessionId: string,
): Promise<SessionModelUsage | null> {
  if (sessionId.length === 0) return null;
  try {
    const result = await api.client.kilocode.sessionModelUsage({ sessionID: sessionId });
    return parseSessionModelUsage(result.data);
  } catch {
    return null;
  }
}

function readProviderDisplayNames(api: TuiPluginApi): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  try {
    for (const provider of api.state?.provider ?? []) {
      const id = toNonEmptyString(provider.id);
      if (id === null) continue;
      names.set(id, toNonEmptyString(provider.name) ?? id);
    }
  } catch {
    // The catalog is optional: a group falls back to its raw provider id.
  }
  return names;
}

function readModelCatalogName(api: TuiPluginApi, model: ModelUsage): string | null {
  try {
    const provider = api.state?.provider?.find((entry) => entry.id === model.providerID);
    return toNonEmptyString(provider?.models?.[model.modelID]?.name);
  } catch {
    return null;
  }
}

// Whether `sessionId` is the rendered session or one of its descendants: the
// endpoint sums the tree, so a step finished in a child session moves our
// numbers too. Mirrors the check Kilo makes before it refetches.
function isInSessionTree(api: TuiPluginApi, sessionId: string, rootId: string): boolean {
  if (sessionId === rootId) return true;
  let current = sessionId;
  for (let depth = 0; depth < SESSION_TREE_WALK_LIMIT; depth += 1) {
    let parent: string | undefined;
    try {
      parent = api.state?.session.get(current)?.parentID;
    } catch {
      return false;
    }
    if (parent === undefined || parent.length === 0) return false;
    if (parent === rootId) return true;
    current = parent;
  }
  return false;
}

function trackSubscription(unsubscribes: Array<() => void>, subscribe: () => (() => void) | undefined): void {
  try {
    const unsubscribe = subscribe();
    if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
  } catch {
    // Event subscription is additive; a failure must not abort the panel.
  }
}

// ---------------------------------------------------------------------------
// TUI plugin
// ---------------------------------------------------------------------------
//
// Reactivity in this entry is hand-rolled on purpose. The deployed bundle is
// compiled by esbuild's automatic JSX rather than Solid's compiler, so a child
// written as a plain value is an ordinary evaluated expression: the host is free
// to reuse the element it was handed instead of re-invoking this subtree when
// something changes. A FUNCTION child is the one form the renderer is documented
// to re-evaluate (`insertExpression` wraps it in a render effect), so every
// region whose contents can change after mount is written as a function child
// and every prop carrying a changing value is passed as an accessor. Wrapping a
// region that happens to be static costs nothing and removes the question.
//
// This was verified against the real host in both directions rather than
// assumed: the collapse toggle and an async snapshot arriving after mount both
// re-render correctly, which is the property this pattern exists to guarantee.
function reactiveChild(accessor: () => unknown): JSX.Element {
  return accessor as unknown as JSX.Element;
}

// The factory body lives here so the exported `goUsageTui` can wrap the whole
// initialization in a single fail-safe boundary. A throwing factory would
// destabilize the host's plugin load, so it must never reject.
async function initializeTui(api: TuiPluginApi, options: PluginOptions | undefined): Promise<void> {
  const surfaces = resolveSurfaceSelection(options, api);
  // Live mode: the host panel below follows it immediately. The sidebar slot's
  // ORDER is read once at registration, because the SDK exposes no slot
  // unregister — so a toggle moves the block on the next TUI start.
  let sidebarMode = resolveSidebarMode(options, api);
  migrateLegacyCollapsedFlag(api);
  void applyHostUsagePanel(api, sidebarMode);

  const [usageSnapshot, setUsageSnapshot] = createSignal<UsageSnapshot | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = createSignal<boolean>(
    readCollapsedFlag(api, KV_COLLAPSED_SIDEBAR_KEY),
  );
  const [isStatuslineCollapsed, setIsStatuslineCollapsed] = createSignal<boolean>(
    readCollapsedFlag(api, KV_COLLAPSED_STATUSLINE_KEY),
  );

  let cachedAt = 0;
  let lastFetchAt = 0;
  let refreshInFlight = false;

  const [activeProviderId, setActiveProviderId] = createSignal<string | undefined>(undefined);
  try {
    const modelString = api.state?.config?.model;
    if (typeof modelString === "string" && modelString.length > 0) {
      const providerPart = modelString.split("/")[0];
      if (providerPart !== undefined && providerPart.length > 0) setActiveProviderId(providerPart);
    }
  } catch {
    // State may not be ready; fall back to the event signal.
  }

  // Which provider is in use, read live on every render rather than latched at
  // init. Latching left the gate closed for anyone without a config-level model,
  // and the `session.updated` event only fires on a server-side change, so
  // opening a session or switching model in the picker never re-armed it --
  // the plugin looked installed and did nothing.
  function resolveActiveProviderId(sessionId: string): string | undefined {
    return resolveProviderId(api.state, sessionId, activeProviderId());
  }

  async function refreshUsage(ttlOverride?: number): Promise<void> {
    if (refreshInFlight) return;
    const effectiveTtl = ttlOverride ?? POLL_INTERVAL_MS;
    if (ttlOverride !== undefined) {
      if (Date.now() - lastFetchAt < DEBOUNCE_MS) return;
      if (Date.now() - cachedAt < effectiveTtl && usageSnapshot() !== null) return;
    } else if (Date.now() - cachedAt < POLL_INTERVAL_MS && usageSnapshot() !== null) {
      return;
    }
    refreshInFlight = true;
    try {
      const snapshot = await loadUsageSnapshot();
      if (snapshot === null) {
        if (usageSnapshot() === null) {
          await logUsageError(api, "Go usage unavailable (not configured or request failed)");
        }
        return;
      }
      cachedAt = Date.now();
      setUsageSnapshot(snapshot);
    } catch {
      // Keep stale data; the panel simply shows the last known snapshot.
    } finally {
      lastFetchAt = Date.now();
      refreshInFlight = false;
    }
  }

  // Fire-and-forget refresh that cannot surface an unhandled rejection.
  // The background poll (ttlOverride undefined) keeps the 60s TTL guard;
  // session.updated passes 0 to bypass the TTL entirely (debounce-only);
  // message.updated passes EVENT_TTL_MS for a 15s effective window.
  function refreshSafely(ttlOverride?: number): void {
    void refreshUsage(ttlOverride).catch(() => {
      // refreshUsage already swallows failures; this guards a regression.
    });
  }

  function toggleSidebarCollapsed(): void {
    try {
      const next = !isSidebarCollapsed();
      setIsSidebarCollapsed(next);
      api.kv.set(KV_COLLAPSED_SIDEBAR_KEY, next);
    } catch {
      // Collapse state is best-effort persistence only.
    }
  }

  function toggleStatuslineCollapsed(): void {
    try {
      const next = !isStatuslineCollapsed();
      setIsStatuslineCollapsed(next);
      api.kv.set(KV_COLLAPSED_STATUSLINE_KEY, next);
    } catch {
      // Collapse state is best-effort persistence only.
    }
  }

  function toggleSidebarMode(): void {
    const next: SidebarMode = sidebarMode === "integrated" ? "standalone" : "integrated";
    sidebarMode = next;
    // Fire-and-forget: the host panel switch is async and may fail, and the
    // command must return either way.
    void applyHostUsagePanel(api, next);
    try {
      api.kv.set(KV_SIDEBAR_MODE_KEY, next);
    } catch {
      // Mode persistence is best-effort; the panel switch above still happened.
    }
  }

  function meterColor(theme: TuiTheme, severity: UsageMeterSeverity) {
    if (severity === "error") return theme.current.error;
    if (severity === "warning") return theme.current.warning;
    return theme.current.textMuted;
  }

  // The plan meters, or nothing at all: an unavailable snapshot has no windows,
  // and a missing one is still loading.
  function currentPlanRows(): PlanRow[] {
    const snapshot = usageSnapshot();
    if (snapshot === null || snapshot.source === "unavailable") return [];
    return buildPlanRows(snapshot);
  }

  // Kilo's own row grammar: a row box with the label muted and pushed away
  // from the value, which here is the meter plus its percent.
  function GoPlanRow(props: { theme: TuiTheme; row: PlanRow }) {
    return (
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={props.theme.current.textMuted} wrapMode="none">
            {props.row.label}
          </text>
          <box flexDirection="row">
            <text fg={meterColor(props.theme, props.row.severity)} wrapMode="none">
              {props.row.bar}
            </text>
            <text fg={props.theme.current.textMuted} wrapMode="none" marginLeft={1}>
              {props.row.percent}%
            </text>
          </box>
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

  function GoPlanSection(props: { theme: TuiTheme; rows: PlanRow[] }) {
    return (
      <box flexDirection="column">
        <text fg={props.theme.current.text}>
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

  // The compact `Go Usage` block. Integrated mode renders it without the plan
  // section, because there the plan lives inside the OpenCode Go model group
  // where it reads as part of that provider's usage.
  function GoUsageBlock(props: { theme: TuiTheme; withPlan: boolean }) {
    createEffect(() => {
      const snapshot = usageSnapshot();
      if (snapshot !== null && snapshot.source === "unavailable") {
        void logUsageError(
          api,
          snapshot.apiError ? `Go usage unavailable (${snapshot.apiError})` : "Go usage snapshot unavailable",
        );
      }
    });
    const body = createMemo(() => {
      const snapshot = usageSnapshot();
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
      const planRows = buildPlanRows(snapshot);
      return (
        <box flexDirection="column">
          <For each={buildUsageRows(snapshot)}>
            {(row) => (
              <text fg={props.theme.current.textMuted} wrapMode="none">
                {row.label} {row.value}
              </text>
            )}
          </For>
          <Show when={props.withPlan && planRows.length > 0}>
            <GoPlanSection theme={props.theme} rows={planRows} />
          </Show>
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

  function GoSidebarPanel(props: { theme: TuiTheme }) {
    return <GoUsageBlock theme={props.theme} withPlan={true} />;
  }

  // Kilo's `space-between` label/value row, the grammar both the totals block
  // and every per-model breakdown use.
  function LabeledValueRow(props: { theme: TuiTheme; row: UsageRow }) {
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

  function SectionHeader(props: {
    theme: TuiTheme;
    label: string;
    expanded: () => boolean;
    count: () => number | null;
    onToggle: () => void;
  }) {
    return (
      <box flexDirection="row" gap={1} flexShrink={0} onMouseDown={props.onToggle}>
        <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
          {reactiveChild(() => (props.expanded() ? KILO_EXPANDED_GLYPH : KILO_COLLAPSED_GLYPH))}
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
  function CollapsibleSection(props: {
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

  function GoShareRow(props: { theme: TuiTheme; percent: number }) {
    const rounded = Math.round(props.percent);
    return (
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0}>
          {INTEGRATED_GO_SHARE_LABEL}
        </text>
        <box flexDirection="row" flexShrink={0}>
          <text fg={meterColor(props.theme, meterSeverityForPercent(rounded))} wrapMode="none">
            {usageMeterBar(rounded)}
          </text>
          <text fg={props.theme.current.textMuted} wrapMode="none" marginLeft={1}>
            {rounded}%
          </text>
        </box>
      </box>
    );
  }

  function ModelUsageRow(props: {
    theme: TuiTheme;
    model: ModelUsage;
    isGo: boolean;
    expanded: () => boolean;
    goShare: () => number;
    onToggle: () => void;
  }) {
    const detail = createMemo(() =>
      props.expanded() ? (
        <box flexDirection="column" paddingLeft={2}>
          <For each={buildModelTokenRows(props.model.tokens)}>
            {(row) => <LabeledValueRow theme={props.theme} row={row} />}
          </For>
        </box>
      ) : null,
    );
    return (
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1} flexShrink={0} onMouseDown={props.onToggle}>
          <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
            {reactiveChild(() => (props.expanded() ? KILO_EXPANDED_GLYPH : KILO_COLLAPSED_GLYPH))}
          </text>
          <box flexGrow={1} minWidth={0} overflow="hidden">
            <text fg={props.theme.current.text} wrapMode="none">
              <b>{modelDisplayName(readModelCatalogName(api, props.model), props.model.modelID)}</b>
            </text>
          </box>
          <box
            width={KILO_STEPS_COLUMN_WIDTH}
            flexDirection="row"
            flexShrink={0}
            justifyContent="flex-end"
          >
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {formatUsageCount(props.model.steps)}
            </text>
          </box>
          <box
            width={KILO_COST_COLUMN_WIDTH}
            flexDirection="row"
            flexShrink={0}
            justifyContent="flex-end"
          >
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {formatUsageCost(props.model.cost)}
            </text>
          </box>
        </box>
        <Show when={props.isGo}>
          <box paddingLeft={2}>
            <GoShareRow theme={props.theme} percent={props.goShare()} />
          </box>
        </Show>
        {reactiveChild(detail)}
      </box>
    );
  }

  function ProviderUsageGroup(props: {
    theme: TuiTheme;
    group: ModelProviderGroup;
    planRows: PlanRow[];
    goTotal: number;
    expandedModels: () => ReadonlySet<string>;
    onToggleModel: (key: string) => void;
  }) {
    const isGo = props.group.providerID === GO_PROVIDER_ID;
    return (
      <box flexDirection="column" gap={1}>
        <text fg={props.theme.current.text} wrapMode="none">
          {props.group.providerName}
        </text>
        <Show when={isGo && props.planRows.length > 0}>
          <GoPlanSection theme={props.theme} rows={props.planRows} />
        </Show>
        <box flexDirection="row" gap={1}>
          <box width={1} flexShrink={0} />
          <text flexGrow={1} minWidth={0} fg={props.theme.current.textMuted} wrapMode="none">
            Model
          </text>
          <box
            width={KILO_STEPS_COLUMN_WIDTH}
            flexDirection="row"
            flexShrink={0}
            justifyContent="flex-end"
          >
            <text fg={props.theme.current.textMuted} wrapMode="none">
              Steps
            </text>
          </box>
          <box
            width={KILO_COST_COLUMN_WIDTH}
            flexDirection="row"
            flexShrink={0}
            justifyContent="flex-end"
          >
            <text fg={props.theme.current.textMuted} wrapMode="none">
              Cost
            </text>
          </box>
        </box>
        <For each={props.group.models}>
          {(model) => {
            const key = `${model.providerID}/${model.modelID}`;
            return (
              <ModelUsageRow
                theme={props.theme}
                model={model}
                isGo={isGo}
                expanded={() => props.expandedModels().has(key)}
                goShare={() => goSharePercent(usageTokenCount(model.tokens), props.goTotal)}
                onToggle={() => props.onToggleModel(key)}
              />
            );
          }}
        </For>
      </box>
    );
  }

  function ModelsSection(props: {
    theme: TuiTheme;
    usage: () => SessionModelUsage | null;
    planRows: () => PlanRow[];
  }) {
    const [isExpanded, setIsExpanded] = createSignal<boolean>(true);
    const [expandedModels, setExpandedModels] = createSignal<ReadonlySet<string>>(new Set());

    // Fold state is local, like Kilo's: it resets on remount rather than
    // outliving the session it described.
    function toggleModel(key: string): void {
      setExpandedModels((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    }

    const modelCount = createMemo(() => props.usage()?.models.length ?? 0);

    const body = createMemo(() => {
      const usage = props.usage();
      const models = usage?.models ?? [];
      const providerNames = readProviderDisplayNames(api);
      const grouped = groupModelsByProvider(models, providerNames);
      // A failed or still-loading request leaves no model list, and the Go plan
      // would disappear with it. A model-less Go group keeps the plan on screen:
      // it comes from a different endpoint, and those numbers stay ours to show
      // regardless of what the host's per-model request did.
      // A failed or still-loading request leaves no model list, and the Go plan
      // would disappear with it. A model-less Go group keeps the plan on screen:
      // it comes from a different endpoint, and those numbers stay ours to show
      // regardless of what the host's per-model request did.
      const groups =
        grouped.length === 0 && props.planRows().length > 0
          ? [
              {
                providerID: GO_PROVIDER_ID,
                providerName: providerNames.get(GO_PROVIDER_ID) ?? GO_PROVIDER_ID,
                models: [],
              },
            ]
          : grouped;
      const goTotal = totalGoTokens(models);
      return (
        <box flexDirection="column" gap={1} paddingTop={1}>
          <Show when={models.length === 0}>
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {INTEGRATED_EMPTY_LABEL}
            </text>
          </Show>
          <For each={groups}>
            {(group) => (
              <ProviderUsageGroup
                theme={props.theme}
                group={group}
                planRows={props.planRows()}
                goTotal={goTotal}
                expandedModels={expandedModels}
                onToggleModel={toggleModel}
              />
            )}
          </For>
        </box>
      );
    });

    return (
      <CollapsibleSection
        theme={props.theme}
        label={INTEGRATED_MODELS_SECTION_LABEL}
        count={modelCount}
        expanded={isExpanded}
        onToggle={() => setIsExpanded((current) => !current)}
        body={body}
      />
    );
  }

  // Integrated mode's replacement for Kilo's own 150 band: the compact Go
  // readout, Kilo's session token totals, and Kilo's per-model table with the
  // plan nested inside the OpenCode Go group.
  function GoIntegratedPanel(props: { theme: TuiTheme; sessionId: string }) {
    const [usage, setUsage] = createSignal<SessionModelUsage | null>(null);
    const [loadFailed, setLoadFailed] = createSignal<boolean>(false);
    const [refetchToken, setRefetchToken] = createSignal<number>(0);
    const [isTokensExpanded, setIsTokensExpanded] = createSignal<boolean>(true);

    createEffect(() => {
      const sessionId = props.sessionId;
      refetchToken();
      if (sessionId.length === 0) return;
      let cancelled = false;
      void fetchSessionModelUsage(api, sessionId).then((result) => {
        if (cancelled) return;
        setUsage(result);
        // Log the transition, not every event: a step-finish storm must not
        // fill the host log with the same line.
        if (result === null && !loadFailed()) {
          void logUsageError(api, "Session model usage unavailable (request failed)");
        }
        setLoadFailed(result === null);
      });
      onCleanup(() => {
        cancelled = true;
      });
    });

    createEffect(() => {
      const sessionId = props.sessionId;
      const unsubscribes: Array<() => void> = [];
      const inTree = (id: string): boolean => isInSessionTree(api, id, sessionId);
      const refetch = (): void => {
        setRefetchToken((current) => current + 1);
      };

      trackSubscription(unsubscribes, () =>
        api.event.on("message.part.updated", (event) => {
          if (event.properties.part.type !== "step-finish") return;
          if (inTree(event.properties.sessionID)) refetch();
        }),
      );
      trackSubscription(unsubscribes, () =>
        api.event.on("message.part.removed", (event) => {
          if (inTree(event.properties.sessionID)) refetch();
        }),
      );
      trackSubscription(unsubscribes, () =>
        api.event.on("message.removed", (event) => {
          if (inTree(event.properties.sessionID)) refetch();
        }),
      );
      trackSubscription(unsubscribes, () =>
        api.event.on("session.created", (event) => {
          if (inTree(event.properties.sessionID)) refetch();
        }),
      );
      trackSubscription(unsubscribes, () =>
        api.event.on("session.deleted", (event) => {
          if (inTree(event.properties.sessionID)) refetch();
        }),
      );
      trackSubscription(unsubscribes, () => api.event.on("server.connected", refetch));

      onCleanup(() => {
        for (const unsubscribe of unsubscribes) {
          try {
            unsubscribe();
          } catch {
            // A throwing unsubscribe must not stop the rest of the teardown.
          }
        }
      });
    });

    const tokenBody = createMemo(() => {
      const data = usage();
      if (data === null) {
        return (
          <text fg={props.theme.current.textMuted} wrapMode="none">
            {loadFailed() ? INTEGRATED_UNAVAILABLE_LABEL : INTEGRATED_LOADING_LABEL}
          </text>
        );
      }
      return (
        <box flexDirection="column">
          <For each={buildTokenUsageRows(data.totals)}>
            {(row) => <LabeledValueRow theme={props.theme} row={row} />}
          </For>
        </box>
      );
    });

    return (
      <box flexDirection="column" gap={1}>
        <GoUsageBlock theme={props.theme} withPlan={false} />
        <CollapsibleSection
          theme={props.theme}
          label={INTEGRATED_TOKENS_SECTION_LABEL}
          count={() => null}
          expanded={isTokensExpanded}
          onToggle={() => setIsTokensExpanded((current) => !current)}
          body={tokenBody}
        />
        <ModelsSection theme={props.theme} usage={usage} planRows={currentPlanRows} />
      </box>
    );
  }

  function GoStatusline() {
    return (
      <Show when={usageSnapshot()} fallback={null}>
        {(snapshot) => {
          if (isSnapshotEmpty(snapshot())) return null;
          return <text>{formatStatusline(snapshot())}</text>;
        }}
      </Show>
    );
  }

  if (surfaces.sidebar) {
    // Host-owned slot: `register` returns an id but the SDK exposes no
    // unregister API, so there is nothing to dispose here (the slot dies
    // with the host). Interval/event/command teardown below is the full
    // dispose path.
    try {
      api.slots.register({
        order: sidebarMode === "integrated" ? INTEGRATED_SLOT_ORDER : SLOT_ORDER,
        slots: {
          sidebar_content(ctx: TuiSlotContext, props: { session_id: string }) {
            // Individually guarded: a later render must never throw into the host.
            try {
              if (props.session_id.length === 0) return null;
              if (!isGoUsageProvider(resolveActiveProviderId(props.session_id))) return null;
              if (api.route.current.name !== "session") return null;
              if (isSidebarCollapsed()) return null;
              // Read live so the mode command takes effect at once, the same way
              // the host panel follows it; only the ORDER stays bound to
              // registration.
              if (sidebarMode === "integrated") {
                return <GoIntegratedPanel theme={ctx.theme} sessionId={props.session_id} />;
              }
              return <GoSidebarPanel theme={ctx.theme} />;
            } catch {
              return null;
            }
          },
        },
      });
    } catch {
      // Additive slot: a registration failure must not abort the plugin.
    }
  }

  if (surfaces.statusline) {
    // Host-owned slot (see sidebar note above): no unregister API exists,
    // so disposal is a no-op for slots.
    try {
      api.slots.register({
        order: SLOT_ORDER,
        slots: {
          session_prompt_right(_ctx: TuiSlotContext, props: { session_id: string }) {
            // Individually guarded: a later render must never throw into the host.
            try {
              if (props.session_id.length === 0) return null;
              if (!isGoUsageProvider(resolveActiveProviderId(props.session_id))) return null;
              if (isStatuslineCollapsed()) return null;
              return <GoStatusline />;
            } catch {
              return null;
            }
          },
        },
      });
    } catch {
      // Additive slot: a registration failure must not abort the plugin.
    }
  }

  // `api.command` is a deprecated legacy shim that hosts may omit; guard so
  // the plugin still initializes and disposes safely without it.
  let unregisterToggleCommand: () => void = () => {};
  try {
    const unregister = api.command?.register(() => [
      {
        title: "Go usage: toggle sidebar",
        value: "oc-go-usage-display.toggle-sidebar",
        category: "Go",
        onSelect: () => toggleSidebarCollapsed(),
      },
      {
        title: "Go usage: toggle statusline",
        value: "oc-go-usage-display.toggle-statusline",
        category: "Go",
        onSelect: () => toggleStatuslineCollapsed(),
      },
      {
        title: "Go usage: toggle sidebar mode",
        value: "oc-go-usage-display.toggle-sidebar-mode",
        category: "Go",
        onSelect: () => toggleSidebarMode(),
      },
    ]);
    if (typeof unregister === "function") unregisterToggleCommand = unregister;
  } catch {
    // Legacy command registration is optional; ignore failures.
  }

  let unsubscribeSession: () => void = () => {};
  let unsubscribeMessage: () => void = () => {};
  try {
    const unsubscribe = api.event.on("session.updated", (event) => {
      const providerId = event?.properties?.info?.model?.providerID;
      if (providerId !== undefined) setActiveProviderId(providerId);
      refreshSafely(0);
    });
    if (typeof unsubscribe === "function") unsubscribeSession = unsubscribe;
  } catch {
    // Event subscription is additive; a failure must not abort the plugin.
  }
  try {
    const unsubscribe = api.event.on("message.updated", () => refreshSafely(EVENT_TTL_MS));
    if (typeof unsubscribe === "function") unsubscribeMessage = unsubscribe;
  } catch {
    // Event subscription is additive; a failure must not abort the plugin.
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  try {
    pollTimer = setInterval(() => refreshSafely(), POLL_INTERVAL_MS);
  } catch {
    // No poll timer: the on-demand refresh below still runs.
  }

  try {
    api.lifecycle.onDispose(() => {
      // Each teardown step is isolated: one throwing unsubscribe must not
      // prevent the rest (or leak into the host's dispose pass).
      if (pollTimer !== null) {
        try {
          clearInterval(pollTimer);
        } catch {
          // noop
        }
      }
      for (const teardown of [unsubscribeSession, unsubscribeMessage, unregisterToggleCommand]) {
        try {
          teardown();
        } catch {
          // noop
        }
      }
    });
  } catch {
    // Lifecycle registration is best-effort; never leak a timer into the host.
    if (pollTimer !== null) {
      try {
        clearInterval(pollTimer);
      } catch {
        // noop
      }
    }
  }

  await refreshUsage();
}

const goUsageTui: TuiPlugin = async (api, options) => {
  try {
    await initializeTui(api, options);
  } catch (error) {
    // Best-effort and non-blocking: never delay plugin resolution on the host
    // log and never let an initialization error reject into the host.
    void logUsageError(
      api,
      `Go usage TUI failed to initialize: ${errorMessage(error)}; continuing without display`,
    );
  }
};

export default { id: "oc-go-usage-display", tui: goUsageTui } satisfies TuiPluginModule;
