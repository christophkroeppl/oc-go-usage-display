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
//     info (e.g. `Go 5h 42% | 7d 15%`), where the `80.6K (8%) · $0.09` readout
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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const SLOT_ORDER = 50;
const KV_DISPLAY_KEY = "display";
const KV_COLLAPSED_SIDEBAR_KEY = "collapsed_sidebar";
const KV_COLLAPSED_STATUSLINE_KEY = "collapsed_statusline";
const KV_COLLAPSED_LEGACY_KEY = "collapsed";
const LOG_SERVICE = "oc-go-usage-display";

const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");

function dataShareAuthPath(): string {
  const xdgDataHome = toNonEmptyString(process.env.XDG_DATA_HOME);
  if (xdgDataHome) return path.join(xdgDataHome, "opencode", "auth.json");
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function authJsonPaths(): string[] {
  return [dataShareAuthPath(), path.join(CONFIG_DIR, "auth.json")];
}

// ---------------------------------------------------------------------------
// Trusted types (parsed at the boundary, trusted internally)
// ---------------------------------------------------------------------------

type DisplayMode = "sidebar" | "statusline" | "both";

type SurfaceSelection = {
  sidebar: boolean;
  statusline: boolean;
};

type UsageWindow = {
  percent: number;
  resetInSec: number | null;
  resetText: string | null;
};

type UsageSnapshot = {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
  source: "api" | "mock" | "unavailable";
  fetchedAt: number;
  apiError?: string;
};

type UsageRow = {
  label: string;
  value: string;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "sidebar" || value === "statusline" || value === "both";
}

function surfaceSelectionFromDisplayMode(mode: DisplayMode): SurfaceSelection {
  return { sidebar: mode !== "statusline", statusline: mode !== "sidebar" };
}

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

function formatResetDuration(totalSec: number | null): string | null {
  if (totalSec === null || !Number.isFinite(totalSec) || totalSec < 0) return null;
  const sec = Math.floor(totalSec);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${sec}s`;
}

function isSnapshotEmpty(snapshot: UsageSnapshot): boolean {
  return snapshot.rolling === null && snapshot.weekly === null && snapshot.monthly === null;
}

function formatCompactLine(snapshot: UsageSnapshot): string {
  const rolling = snapshot.rolling === null ? "5h n/a" : `5h ${snapshot.rolling.percent}%`;
  const weekly = snapshot.weekly === null ? "7d n/a" : `7d ${snapshot.weekly.percent}%`;
  return `Go ${rolling} | ${weekly}`;
}

function buildUsageRows(snapshot: UsageSnapshot): UsageRow[] {
  const rows: UsageRow[] = [];
  if (snapshot.rolling !== null) {
    const reset = formatResetDuration(snapshot.rolling.resetInSec) ?? snapshot.rolling.resetText;
    rows.push({ label: "5h", value: `${snapshot.rolling.percent}%${reset ? ` · resets ${reset}` : ""}` });
  }
  if (snapshot.weekly !== null) rows.push({ label: "7d", value: `${snapshot.weekly.percent}%` });
  if (snapshot.monthly !== null) rows.push({ label: "30d", value: `${snapshot.monthly.percent}%` });
  return rows;
}

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

// ---------------------------------------------------------------------------
// Data boundary (auth.json -> Bearer usage fetch; throws nothing)
// ---------------------------------------------------------------------------

function readAuthJsonApiKey(): string | null {
  for (const authPath of authJsonPaths()) {
    let raw: string;
    try {
      raw = fs.readFileSync(authPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const goEntry = parsed["opencode-go"];
    const fallbackEntry = parsed["opencode"];
    const goKey = isRecord(goEntry) ? toNonEmptyString(goEntry.key) : null;
    if (goKey) return goKey;
    const fallbackKey = isRecord(fallbackEntry) ? toNonEmptyString(fallbackEntry.key) : null;
    if (fallbackKey) return fallbackKey;
  }
  return null;
}

function extractWindow(candidate: unknown): UsageWindow | null {
  if (!isRecord(candidate)) return null;
  const percent = toFiniteNumber(
    candidate.percent ??
      candidate.usagePercent ??
      candidate.usedPercent ??
      candidate.value ??
      candidate.usage,
  );
  if (percent === null) return null;
  return {
    percent: Math.round(percent),
    resetInSec: toFiniteNumber(candidate.resetInSec ?? candidate.resetInSeconds ?? null),
    resetText: toNonEmptyString(candidate.resetText ?? candidate.reset ?? null),
  };
}

function extractSnapshotFromApiPayload(payload: unknown): UsageSnapshot | null {
  if (!isRecord(payload)) return null;
  const containers: unknown[] = [payload];
  for (const key of ["usage", "data", "go"]) {
    if (isRecord(payload[key])) containers.push(payload[key]);
  }
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const rolling = extractWindow(container.rolling ?? container.rollingUsage ?? container["5h"]);
    const weekly = extractWindow(container.weekly ?? container.weeklyUsage ?? container["7d"]);
    const monthly = extractWindow(container.monthly ?? container.monthlyUsage ?? container["30d"]);
    if (rolling !== null || weekly !== null || monthly !== null) {
      return { rolling, weekly, monthly, source: "api", fetchedAt: Date.now() };
    }
  }
  return null;
}

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

function mockSnapshot(): UsageSnapshot {
  return {
    rolling: { percent: 42, resetInSec: 7543, resetText: null },
    weekly: { percent: 15, resetInSec: null, resetText: null },
    monthly: { percent: 61, resetInSec: null, resetText: null },
    source: "mock",
    fetchedAt: Date.now(),
  };
}

async function loadUsageSnapshot(): Promise<UsageSnapshot | null> {
  if (process.env.OPENCODE_GO_MOCK === "1") return mockSnapshot();

  const apiKey = toNonEmptyString(process.env.OPENCODE_GO_API_KEY) ?? readAuthJsonApiKey();
  if (apiKey === null) return null;

  const payload = await fetchJsonWithTimeout(API_USAGE_URL, apiKey);
  if (payload === null) return null;
  if (isRecord(payload) && payload.__rejected === true) return null;
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

const goUsageTui: TuiPlugin = async (api, options) => {
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
  let refreshInFlight = false;

  async function refreshUsage(): Promise<void> {
    if (refreshInFlight) return;
    if (Date.now() - cachedAt < POLL_INTERVAL_MS && usageSnapshot() !== null) return;
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
      refreshInFlight = false;
    }
  }

  function toggleSidebarCollapsed(): void {
    const next = !isSidebarCollapsed();
    setIsSidebarCollapsed(next);
    try {
      api.kv.set(KV_COLLAPSED_SIDEBAR_KEY, next);
    } catch {
      // Collapse state is best-effort persistence only.
    }
  }

  function toggleStatuslineCollapsed(): void {
    const next = !isStatuslineCollapsed();
    setIsStatuslineCollapsed(next);
    try {
      api.kv.set(KV_COLLAPSED_STATUSLINE_KEY, next);
    } catch {
      // Collapse state is best-effort persistence only.
    }
  }

  function GoSidebarPanel(props: { theme: TuiTheme }) {
    createEffect(() => {
      const snapshot = usageSnapshot();
      if (snapshot !== null && snapshot.source === "unavailable") {
        void logUsageError(api, "Go usage snapshot unavailable");
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
          {(snapshot) => (
            <For each={buildUsageRows(snapshot())}>
              {(row) => (
                <text fg={props.theme.current.textMuted} wrapMode="none">
                  {row.label} {row.value}
                </text>
              )}
            </For>
          )}
        </Show>
      </box>
    );
  }

  function GoStatusline() {
    return (
      <Show when={usageSnapshot()} fallback={null}>
        {(snapshot) => {
          if (isSnapshotEmpty(snapshot())) return null;
          return <text>{formatCompactLine(snapshot())}</text>;
        }}
      </Show>
    );
  }

  if (surfaces.sidebar) {
    api.slots.register({
      order: SLOT_ORDER,
      slots: {
        sidebar_content(ctx: TuiSlotContext, props: { session_id: string }) {
          if (props.session_id.length === 0) return null;
          if (api.route.current.name !== "session") return null;
          if (isSidebarCollapsed()) return null;
          return <GoSidebarPanel theme={ctx.theme} />;
        },
      },
    });
  }

  if (surfaces.statusline) {
    api.slots.register({
      order: SLOT_ORDER,
      slots: {
        session_prompt_right(_ctx: TuiSlotContext, props: { session_id: string }) {
          if (props.session_id.length === 0) return null;
          if (isStatuslineCollapsed()) return null;
          return <GoStatusline />;
        },
      },
    });
  }

  const unregisterToggleCommand = api.command.register(() => [
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

  const unsubscribeSession = api.event.on("session.updated", () => {
    void refreshUsage();
  });
  const unsubscribeMessage = api.event.on("message.updated", () => {
    void refreshUsage();
  });
  const pollTimer = setInterval(() => {
    void refreshUsage();
  }, POLL_INTERVAL_MS);

  api.lifecycle.onDispose(() => {
    clearInterval(pollTimer);
    unsubscribeSession();
    unsubscribeMessage();
    unregisterToggleCommand();
  });

  await refreshUsage();
};

export default { id: "oc-go-usage-display", tui: goUsageTui } satisfies TuiPluginModule;
