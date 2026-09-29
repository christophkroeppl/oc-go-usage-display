/** @jsxImportSource @opentui/solid */
//
// OpenCode Go usage TUI plugin (dual-surface display) for Kilo Code.
//
// Everything the two hosts share -- the refresh policy, the settings ladder,
// the plan meters, the row grammar, the foldable sections, the failure
// boundaries -- lives in `./tui-shared.jsx` and is inlined into this bundle.
// What is left here is what is genuinely Kilo-specific:
//
// 1. the host it reads (`KILO_OC_GO_*`, Kilo's own auth store) and the band it
//    registers in. `SLOT_ORDER` (KILO_SLOT_ORDER) is a free band in Kilo's own
//    `sidebar_content` ladder, so the block is placed deterministically instead
//    of tied with a host panel:
//      50 kilo-sidebar-pr | 100 sidebar-context | 150 kilo-sidebar-usage
//      | 200 sidebar-mcp | 225 kilo-sidebar-indexing
//      | 250 kilo-sidebar-background-processes | 300 sidebar-lsp
//      | 400 sidebar-todo | 500 sidebar-files | 1000 kilo-sidebar-memory
//    100 < 125 < 150 therefore renders directly below Kilo's `Context` panel and
//    above its `Token Usage` block, keeping both usage readouts adjacent at the
//    top of the sidebar; worktrunk renders elsewhere so multi-render stacking is
//    unaffected. Kilo's own `session_prompt_right` panels sit at 50/51, so the
//    same order puts this statusline rightmost.
// 2. the `sidebar_mode` axis (default `integrated`), resolved exactly like the
//    surface toggles -- TUI plugin option in tui.json -> `KILO_OC_GO_SIDEBAR_MODE`
//    -> `api.kv` `sidebar_mode` -> default. (Kilo's tui.json schema rejects the
//    option, so on this host the option path is only reachable in-process, the
//    same situation the `sidebar`/`statusline` options are in.)
//      - `standalone` -> register at KILO_SLOT_ORDER (125), Kilo's own
//        `Token Usage` panel stays where it is.
//      - `integrated` -> register at 150 and switch `internal:kilo-sidebar-usage`
//        off, so one band carries the Go readout instead of two competing ones.
//        Kilo's panel cannot be extended (the real slot registry is unreachable
//        from a plugin), so integrated mode retires it through
//        `api.plugins.deactivate` -- the runtime form of the `plugin_enabled`
//        map in tui.json, and reversible via `activate`. Retiring it also means
//        replacing what it drew, so the 150 band in integrated mode renders
//        three sections instead of one block:
//          Go Usage         the compact plan readout, as in standalone
//          Session Tokens   Kilo's `Token Usage` rows, from the host endpoint.
//                           Deliberately not titled `Token Usage`: that is the
//                           name of the panel integrated mode retired, and a
//                           second header with it would be indistinguishable
//                           from the panel that was supposed to go.
//          Models (N)      Kilo's per-model table, models grouped by provider.
//                           Inside the `OpenCode Go` group the `Go Plan` meters
//                           sit between the provider header and the model rows,
//                           and each Go model row carries a `Go share` line --
//                           its share of the Go tokens in this session tree,
//                           never of the plan, and never a price.
//        The two sections collapse like Kilo's own (local state, both expanded
//        by default), and model rows fold per model.
//      The mode is switched live by `oc-go-usage-display.toggle-sidebar-mode`
//      (title `Go usage: toggle sidebar mode`); the host panel follows
//      immediately, the slot ORDER is bound at registration and moves on the
//      next TUI start (the SDK exposes no slot unregister).
// 3. where the per-session model split comes from: the host's own
//    `client.kilocode.sessionModelUsage` (GET /session/{sessionID}/model-usage),
//    refreshed on the same events Kilo's panel uses and never on a timer. The
//    opencode bundle reads the opencode stores and opencode's own message store
//    instead; each host reads only its own. Failures keep stale data and never
//    break the host; errors go to api.client.app.log (never console). Secrets
//    are never logged.
//
// Coexistence: the server plugin `src/index.ts` (`go_usage` tool only)
// stays as the headless/Desktop fallback. This module exports
// only `tui` (never `server`) under id `oc-go-usage-display`.

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
  METER_WIDTH,
  buildModelTokenRows,
  buildPlanRows,
  buildTokenUsageRows,
  formatUsageCost,
  formatUsageCount,
  goSharePercent,
  groupModelsByProvider,
  modelDisplayName,
  parseSidebarMode,
  totalGoTokens,
  usageTokenCount,
  DEFAULT_SIDEBAR_MODE,
} from "./helpers.js";
import type { ModelProviderGroup, PlanRow, SidebarMode } from "./helpers.js";
import {
  hostEnv,
  parseSessionModelUsage,
  errorMessage,
  GO_PROVIDER_ID,
  MODELS_EMPTY_LABEL,
  INTEGRATED_LOADING_LABEL,
  INTEGRATED_MODELS_SECTION_LABEL,
  INTEGRATED_TOKENS_SECTION_LABEL,
  INTEGRATED_UNAVAILABLE_LABEL,
  SIDEBAR_COLLAPSED_GLYPH,
  KILO_COST_COLUMN_WIDTH,
  SIDEBAR_EXPANDED_GLYPH,
  KILO_INTEGRATED_SLOT_ORDER,
  KILO_SLOT_ORDER,
  KILO_STEPS_COLUMN_WIDTH,
  KILO_USAGE_PANEL_PLUGIN_ID,
} from "./shared.js";
import type { ModelUsage, SessionModelUsage } from "./shared.js";
import {
  CollapsibleSection,
  GoPlanSection,
  GoShareRow,
  GoStatusline,
  GoUsageBlock,
  LabeledValueRow,
  createCollapseState,
  createUsageStore,
  isGoUsageProvider,
  logUsageError,
  makeProviderResolver,
  readModelDisplayName,
  readProviderDisplayNames,
  reactiveChild,
  resolveSurfaceSelection,
  EVENT_TTL_MS,
  POLL_INTERVAL_MS,
} from "./tui-shared.js";
import type { DisplayOptions } from "./tui-shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The endpoint reports the whole top-level session tree, so a change in a child
// session still changes our numbers. The walk is bounded because a cycle in the
// host's parent chain must not hang a render.
const SESSION_TREE_WALK_LIMIT = 32;

// This entry is the Kilo build, so it resolves `KILO_OC_GO_*` and never reads
// an opencode-prefixed name.
const HOST = "kilo" as const;
const SLOT_ORDER = KILO_SLOT_ORDER;
const INTEGRATED_SLOT_ORDER = KILO_INTEGRATED_SLOT_ORDER;
const KV_SIDEBAR_MODE_KEY = "sidebar_mode";

// ---------------------------------------------------------------------------
// Settings: sidebar placement
// ---------------------------------------------------------------------------

// Sidebar placement uses the same precedence ladder as the surface selection,
// including the Kilo-hostile case of an option its tui.json schema cannot
// carry: the plugin cannot fix the host's schema, and it must not skip the
// option because of it (that would silently diverge from the surface ladder
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

// ---------------------------------------------------------------------------
// Session model usage (the integrated panel's replacement for Kilo's own
// token-usage band)
// ---------------------------------------------------------------------------

// This is the same typed call Kilo's own panel makes
// (`client.kilocode.sessionModelUsage`), which the SDK resolves to
// `GET /session/{sessionID}/model-usage`; that path is a PATH param and is
// pinned against the real host by test/e2e/kilo-contract.test.js, because
// `/kilocode/sessionModelUsage` 404s and `/session/model-usage` collides with
// `/session/:id`. No timer: the panel refreshes on host events instead.
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

// The factory body lives here so the exported `goUsageTui` can wrap the whole
// initialization in a single fail-safe boundary. A throwing factory would
// destabilize the host's plugin load, so it must never reject.
async function initializeTui(api: TuiPluginApi, options: PluginOptions | undefined): Promise<void> {
  const surfaces = resolveSurfaceSelection(options as DisplayOptions | undefined, api, HOST);
  const usageStore = createUsageStore(api, HOST);
  const collapse = createCollapseState(api);
  // Live mode: the host panel below follows it immediately. The sidebar slot's
  // ORDER is read once at registration, because the SDK exposes no slot
  // unregister -- so a toggle moves the block on the next TUI start.
  let sidebarMode = resolveSidebarMode(options, api);
  void applyHostUsagePanel(api, sidebarMode);

  const [activeProviderId, setActiveProviderId] = createSignal<string | undefined>(undefined);
  try {
    const modelString = api.state?.config?.model;
    if (typeof modelString === "string" && modelString.length > 0) {
      const providerPart = modelString.split("/")[0];
      if (providerPart !== undefined && providerPart.length > 0) setActiveProviderId(providerPart);
    }
  } catch {
    // State may not be ready; fall through to the event signal.
  }
  const resolveActiveProviderId = makeProviderResolver(api.state, activeProviderId);

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

  // The plan meters, or nothing at all: an unavailable snapshot has no windows,
  // and a missing one is still loading.
  function currentPlanRows(): PlanRow[] {
    const snapshot = usageStore.snapshot();
    if (snapshot === null || snapshot.source === "unavailable") return [];
    return buildPlanRows(snapshot);
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
          <GoPlanSection theme={props.theme} rows={props.planRows} barWidth={METER_WIDTH} />
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
            {reactiveChild(() => (props.expanded() ? SIDEBAR_EXPANDED_GLYPH : SIDEBAR_COLLAPSED_GLYPH))}
          </text>
          <box flexGrow={1} minWidth={0} overflow="hidden">
            <text fg={props.theme.current.text} wrapMode="none">
              <b>
                {modelDisplayName(
                  readModelDisplayName(api, props.model.providerID, props.model.modelID),
                  props.model.modelID,
                )}
              </b>
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
            <GoShareRow theme={props.theme} percent={props.goShare()} width={METER_WIDTH} />
          </box>
        </Show>
        {reactiveChild(detail)}
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
              {MODELS_EMPTY_LABEL}
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
        <GoUsageBlock
          api={api}
          theme={props.theme}
          snapshot={usageStore.snapshot}
          withPlan={false}
        />
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

  function GoSidebarPanel(props: { theme: TuiTheme }) {
    return (
      <GoUsageBlock api={api} theme={props.theme} snapshot={usageStore.snapshot} withPlan={true} />
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
              if (collapse.isSidebarCollapsed()) return null;
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
              if (collapse.isStatuslineCollapsed()) return null;
              return <GoStatusline snapshot={usageStore.snapshot} />;
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
        onSelect: () => collapse.toggleSidebar(),
      },
      {
        title: "Go usage: toggle statusline",
        value: "oc-go-usage-display.toggle-statusline",
        category: "Go",
        onSelect: () => collapse.toggleStatusline(),
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
      usageStore.refreshSafely(0);
    });
    if (typeof unsubscribe === "function") unsubscribeSession = unsubscribe;
  } catch {
    // Event subscription is additive; a failure must not abort the plugin.
  }
  try {
    const unsubscribe = api.event.on("message.updated", () => usageStore.refreshSafely(EVENT_TTL_MS));
    if (typeof unsubscribe === "function") unsubscribeMessage = unsubscribe;
  } catch {
    // Event subscription is additive; a failure must not abort the plugin.
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  try {
    pollTimer = setInterval(() => usageStore.refreshSafely(), POLL_INTERVAL_MS);
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

  await usageStore.refresh();
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
