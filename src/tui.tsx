/** @jsxImportSource @opentui/solid */
//
// OpenCode Go usage TUI plugin (dual-surface display).
//
// Renders subscription usage in two additive multi-render slots (sidebar order
// 50 sits above the context panel at 100 and below model-sidebar at 20;
// worktrunk renders elsewhere so multi-render stacking is unaffected):
//   - `sidebar_content`      -> titled block, e.g. `Go Usage` header plus one
//     muted row per window (`5h 42%`, `7d 15%`, `30d 61%`). The header box
//     carries no paddingLeft/gap so `Go Usage` aligns flush left like the
//     `Context` header.
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
// Data: auth.json (dataShare ~/.local/share/opencode/auth.json, then legacy
// ~/.config/opencode/auth.json, `opencode-go` key else `opencode` key) as
// Bearer for GET https://opencode.ai/zen/go/v1/usage, refreshed on a 60s poll
// plus `session.updated` / `message.updated` events. Failures keep stale data
// and never break the host; errors go to api.client.app.log (never console).
// Secrets are never logged.
//
// Coexistence: the server plugin `src/index.ts` (`go_usage` tool only)
// stays as the headless/Desktop fallback. This module exports
// only `tui` (never `server`) under id `oc-go-usage-display`.

import type { PluginOptions } from "@opencode-ai/plugin";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiTheme,
} from "@opencode-ai/plugin/tui";
import { For, Show, createEffect, createSignal } from "solid-js";
import {
  buildUsageRows,
  formatStatusline,
  isDisplayMode,
  isSnapshotEmpty,
  parseBooleanFlag,
  surfaceSelectionFromDisplayMode,
} from "./helpers.js";
import type { SurfaceSelection } from "./helpers.js";
import {
  errorMessage,
  extractSnapshotFromApiPayload,
  isRecord,
  mockSnapshot,
  readAuthJsonApiKey,
  toNonEmptyString,
  unavailableSnapshot,
} from "./shared.js";
import type { UsageSnapshot } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const POLL_INTERVAL_MS = 60_000;
const EVENT_TTL_MS = 15_000;
const DEBOUNCE_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const GO_PROVIDER_ID = "opencode-go";
const SLOT_ORDER = 50;
const KV_DISPLAY_KEY = "display";
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

  const sidebarEnv = parseBooleanFlag(process.env.OPENCODE_GO_SIDEBAR);
  const statuslineEnv = parseBooleanFlag(process.env.OPENCODE_GO_STATUSLINE);
  if (sidebarEnv !== null || statuslineEnv !== null) {
    return { sidebar: sidebarEnv ?? true, statusline: statuslineEnv ?? true };
  }

  const displayEnv = toNonEmptyString(process.env.OPENCODE_GO_DISPLAY);
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
  if (process.env.OPENCODE_GO_MOCK === "1") return mockSnapshot();

  const apiKey = toNonEmptyString(process.env.OPENCODE_GO_API_KEY) ?? readAuthJsonApiKey();
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

// ---------------------------------------------------------------------------
// TUI plugin
// ---------------------------------------------------------------------------

// The factory body lives here so the exported `goUsageTui` can wrap the whole
// initialization in a single fail-safe boundary. A throwing factory would
// destabilize the host's plugin load, so it must never reject.
async function initializeTui(api: TuiPluginApi, options: PluginOptions | undefined): Promise<void> {
  const surfaces = resolveSurfaceSelection(options, api);
  migrateLegacyCollapsedFlag(api);

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
    // State may not be ready; fall back to session.updated events.
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

  function GoSidebarPanel(props: { theme: TuiTheme }) {
    createEffect(() => {
      const snapshot = usageSnapshot();
      if (snapshot !== null && snapshot.source === "unavailable") {
        void logUsageError(
          api,
          snapshot.apiError ? `Go usage unavailable (${snapshot.apiError})` : "Go usage snapshot unavailable",
        );
      }
    });
    return (
      <box flexDirection="column">
        <text fg={props.theme.current.text}>
          <b>Go Usage</b>
        </text>
        <Show
          when={usageSnapshot()}
          fallback={
            <text fg={props.theme.current.textMuted} wrapMode="none">
              Go loading…
            </text>
          }
        >
          {(snapshot) => {
            const snap = snapshot();
            // Rejected keys (and other unavailable snapshots) must surface a
            // row instead of a bare header with zero rows. Statusline stays
            // hidden for unavailable (isSnapshotEmpty -> null).
            if (snap.source === "unavailable") {
              return (
                <text fg={props.theme.current.textMuted} wrapMode="none">
                  Go n/a ({snap.apiError ?? "unavailable"})
                </text>
              );
            }
            return (
              <For each={buildUsageRows(snap)}>
                {(row) => (
                  <text fg={props.theme.current.textMuted} wrapMode="none">
                    {row.label} {row.value}
                  </text>
                )}
              </For>
            );
          }}
        </Show>
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
        order: SLOT_ORDER,
        slots: {
          sidebar_content(ctx: TuiSlotContext, props: { session_id: string }) {
            // Individually guarded: a later render must never throw into the host.
            try {
              if (props.session_id.length === 0) return null;
              if (!isGoUsageProvider(activeProviderId())) return null;
              if (api.route.current.name !== "session") return null;
              if (isSidebarCollapsed()) return null;
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
              if (!isGoUsageProvider(activeProviderId())) return null;
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
