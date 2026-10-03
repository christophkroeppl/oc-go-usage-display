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
//        from a plugin and Kilo's `View` exposes no nested sub-slots), so
//        integrated mode retires it through `api.plugins.deactivate` -- the
//        runtime form of the `plugin_enabled` map in tui.json, and reversible
//        via `activate`. Retiring it also means replacing what it drew, so the
//        150 band in integrated mode renders three sections instead of one block:
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
//
//        OWNERSHIP IS CONDITIONAL. Integrated mode fills the band only while a
//        Go model is the session's model. On any other model it hands the band
//        back: `applyHostUsagePanel` runs off `ownsIntegratedBand`, so Kilo's
//        `Token Usage` panel goes back on and our slot renders nothing. That is
//        deliberate, for two reasons. The band was taken to make one block out
//        of two competing readouts, and there is nothing to compete with when we
//        have no Go model to meter; and our replacement is a fork of Kilo's, not
//        an extension of it -- it has no `Terminal Bench 2.0` section and no
//        `Generation speed` row, so on a non-Go session replacing it would
//        quietly drop whatever a newer Kilo added. `standalone` remains the
//        escape hatch (our own band, host panel untouched), and on a non-Go
//        session Kilo's own panel is exactly what the user gets.
//
//        The mode is switched live by `oc-go-usage-display.toggle-sidebar-mode`
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
  buildModelTokenRows,
  buildPlanRows,
  buildTokenUsageRows,
  relevantReset,
  formatUsageCost,
  formatUsageCount,
  goSharePercent,
  groupModelsByProvider,
  hostUsagePanelEnabled,
  modelDisplayName,
  parseSidebarMode,
  providerIdFromMessages,
  sidebarBandRenders,
  statuslineRenders,
  totalGoTokens,
  usageTokenCount,
  DEFAULT_SIDEBAR_MODE,
} from "./helpers.js";
import type { ModelProviderGroup, PlanRow, ResetCountdown, SidebarBandState, SidebarMode } from "./helpers.js";
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
  SIDEBAR_EXPANDED_GLYPH,
  KILO_COST_COLUMN_WIDTH,
  KILO_INTEGRATED_SLOT_ORDER,
  KILO_SLOT_ORDER,
  KILO_STEPS_COLUMN_WIDTH,
  KILO_USAGE_PANEL_PLUGIN_ID,
  mockGoShare,
} from "./shared.js";
import type { ModelUsage, SessionModelUsage } from "./shared.js";
import {
  CollapsibleSection,
  GoPlanSection,
  GoShareRow,
  GoStatusline,
  GoUsageBlock,
  LabeledValueRow,
  applyHostPanelEnabled,
  createCollapseState,
  createUsageStore,
  logUsageError,
  makeProviderResolver,
  readModelDisplayName,
  readProviderDisplayNames,
  reactiveChild,
  registerSurfaceToggleCommands,
  resolveSurfaceSelection,
  TOGGLE_COMMAND_CATEGORY,
  TOGGLE_COMMAND_PREFIX,
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

// Integrated mode fills the host's token-usage band instead of drawing beside it,
// so that panel has to go -- and come back when we stop filling it. Standalone
// mode never touches it. The switch itself lives in `./tui-shared.jsx`
// (`applyHostPanelEnabled`), which is where the e2e-free tests reach it: the band
// that decides ownership cannot be mounted without a renderer, so a test could
// otherwise only exercise this by booting the host.
//
// The argument is the desired end state, not the mode, and it comes from
// `hostUsagePanelEnabled` -- so every path into the switch agrees by construction,
// and none of them can retire a panel they are not filling.
function applyHostUsagePanel(api: TuiPluginApi, wantEnabled: boolean): Promise<boolean> {
  return applyHostPanelEnabled(api, KILO_USAGE_PANEL_PLUGIN_ID, wantEnabled);
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
  // A signal, not a `let`: the host invokes a slot renderer exactly once per
  // mount, so a mode read inside the slot body would stay latched for the life of
  // the band and the toggle command would only take effect on the next start. The
  // host panel follows it immediately (the ownership effect below reads this),
  // while the slot's ORDER is still bound at registration, because the SDK
  // exposes no slot unregister.
  const [sidebarMode, setSidebarMode] = createSignal<SidebarMode>(resolveSidebarMode(options, api));

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

  // Which provider the session being rendered is really on. The host's own
  // message store answers first -- it is the source that re-reads, and the one
  // that knows which provider actually ran (see `providerIdFromMessages` for why
  // it outranks `Session.model`, which only exists from Kilo 7.8.3). The session
  // object and the configured model are fallbacks for a session with no messages
  // yet; `message.updated` keeps the last of those current.
  function resolveRenderedProviderId(sessionId: string): string | undefined {
    if (sessionId.length === 0) return undefined;
    try {
      const fromMessages = providerIdFromMessages(api.state?.session?.messages?.(sessionId));
      if (fromMessages !== undefined) return fromMessages;
    } catch {
      // A throwing store is not a reason to hide the panel; fall through.
    }
    return resolveActiveProviderId(sessionId);
  }

  // The band state every display decision is read from. One object, one memo, so
  // the sidebar, the statusline and the host-panel switch can never disagree about
  // which state they are in.
  function bandState(sessionId: string, collapsed: boolean): SidebarBandState {
    return {
      sidebarEnabled: surfaces.sidebar,
      collapsed,
      mode: sidebarMode(),
      providerId: resolveRenderedProviderId(sessionId),
    };
  }

  function toggleSidebarMode(): void {
    const next: SidebarMode = sidebarMode() === "integrated" ? "standalone" : "integrated";
    // The signal is the switch: the band re-renders and the ownership effect
    // re-applies the host panel from it. Setting it before persisting keeps the
    // screen and the switch in step even if the KV write is refused.
    setSidebarMode(next);
    try {
      api.kv.set(KV_SIDEBAR_MODE_KEY, next);
    } catch {
      // Mode persistence is best-effort; the display already followed.
    }
  }

  // The countdown the plan is waiting on, on one line under the block header.
  function planResetLine(): ResetCountdown | null {
    const snapshot = usageStore.snapshot();
    if (snapshot === null || snapshot.source === "unavailable") return null;
    return relevantReset(snapshot);
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
                goShare={() => mockGoShare(HOST) ?? goSharePercent(usageTokenCount(model.tokens), props.goTotal)}
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
            <GoShareRow theme={props.theme} percent={props.goShare()} />
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
      // Integrated mode draws the plan ONCE, as the `Go Plan` meters inside the
      // OpenCode Go group of the Models table. A `Go Usage` block above it (as
      // there was) said the same three numbers twice, in two different
      // layouts, on the same screen.
      <box flexDirection="column" gap={1}>
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

  // The `Go Usage` block: the plan as meters, the next reset on one line --
  // the same block opencode's sidebar leads with, so the plan looks identical
  // whichever host draws it. Kilo's sidebar is wider, so its meters keep the
  // full 16 cells.
  function GoSidebarPanel(props: { theme: TuiTheme }) {
    return (
      <GoUsageBlock
        api={api}
        theme={props.theme}
        snapshot={usageStore.snapshot}
        resetLine={planResetLine}
      />
    );
  }

  // The sidebar band.
  //
  // Every condition below the slot function's own guard lives in here, not in the
  // slot body, because the host calls a slot renderer exactly once per mount
  // (`renderEntry` in @opentui/solid): a condition read in the body is evaluated
  // once and latched for the life of the band. That single fact is what produced
  // the empty band this component fixes -- the Go gate was decided when the band
  // mounted and never again, so a session on a non-Go model either rendered
  // nothing at all in integrated mode (our panel null, Kilo's panel retired) or,
  // after a model switch, kept the wrong answer on screen.
  function KiloSidebarBand(props: { theme: TuiTheme; sessionId: string }) {
    const state = createMemo<SidebarBandState>(() =>
      bandState(props.sessionId, collapse.isSidebarCollapsed()),
    );
    const renders = createMemo(() => sidebarBandRenders(state()));

    // The only writer of the host-panel switch, and it reads the ownership
    // decision rather than the mode: no sidebar, standalone mode, a collapsed
    // band or a non-Go session all mean Kilo's own panel belongs on screen. It
    // runs here rather than at init because there is no session at init to judge
    // by, and because deferring it also removes the one-frame flash of the host
    // panel that an init-time switch causes (internal plugins paint first).
    createEffect(() => {
      void applyHostUsagePanel(api, hostUsagePanelEnabled(state()));
    });

    return (
      // `api.route.current` is a getter over a Solid store, so reading it inside
      // `Show`'s condition subscribes to it.
      <Show when={api.route.current.name === "session"}>
        <Show when={renders()} fallback={null}>
          <Show when={sidebarMode() === "integrated"} fallback={<GoSidebarPanel theme={props.theme} />}>
            <GoIntegratedPanel theme={props.theme} sessionId={props.sessionId} />
          </Show>
        </Show>
      </Show>
    );
  }

  // The statusline: the plan on one line, next to the host's own context readout.
  // Go-only in both modes (see `statuslineRenders`), and reactive for the same
  // reason as the band -- a gate read in the slot body would never re-arm.
  //
  // The gate is returned as a FUNCTION CHILD, not as `<Show when={...}>`: this
  // bundle is compiled by esbuild's automatic JSX rather than Solid's compiler, so
  // `when={visible()}` is an ordinary value evaluated once, and folding the
  // statusline would persist the flag and keep the line on screen -- which is
  // exactly the regression. A function child is the one form the renderer
  // re-evaluates (`insertExpression`), so the fold takes effect immediately.
  function KiloStatuslineSlot(props: { sessionId: string }) {
    const visible = createMemo(
      () => statuslineRenders(bandState(props.sessionId, collapse.isStatuslineCollapsed())),
    );
    return reactiveChild(() => (visible() ? <GoStatusline snapshot={usageStore.snapshot} /> : null));
  }

  if (surfaces.sidebar) {
    // Host-owned slot: `register` returns an id but the SDK exposes no
    // unregister API, so there is nothing to dispose here (the slot dies
    // with the host). Interval/event/command teardown below is the full
    // dispose path.
    try {
      api.slots.register({
        order: sidebarMode() === "integrated" ? INTEGRATED_SLOT_ORDER : SLOT_ORDER,
        slots: {
          sidebar_content(ctx: TuiSlotContext, props: { session_id: string }) {
            // Individually guarded: a later render must never throw into the host.
            // Only the guards that cannot change go here; everything that can is a
            // reactive region inside `KiloSidebarBand`.
            try {
              if (props.session_id.length === 0) return null;
              return <KiloSidebarBand theme={ctx.theme} sessionId={props.session_id} />;
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
              return <KiloStatuslineSlot sessionId={props.session_id} />;
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
  //
  // The two surface entries are built by the shared layer so both hosts label them
  // identically, and each label names the effect it will have. The sidebar mode
  // entry is Kilo's alone and stays an action: it swaps one drawing for another
  // rather than showing or hiding anything.
  let unregisterToggleCommand: () => void = () => {};
  try {
    unregisterToggleCommand = registerSurfaceToggleCommands(api, collapse, () => [
      {
        title: "Go usage: toggle sidebar mode",
        value: `${TOGGLE_COMMAND_PREFIX}sidebar-mode`,
        category: TOGGLE_COMMAND_CATEGORY,
        onSelect: () => toggleSidebarMode(),
      },
    ]);
  } catch {
    // Legacy command registration is optional; ignore failures.
  }

  let unsubscribeSession: () => void = () => {};
  let unsubscribeMessage: () => void = () => {};
  try {
    const unsubscribe = api.event.on("session.updated", (event) => {
      // Kilo 7.8.1's `Session` carried no `model` field, so on that host this read
      // found nothing and the configured model was the only source. From 7.8.3 it
      // is real data, and worth keeping: it answers "which model is this session
      // set to" for a session too new to have any messages, which is exactly the
      // case the store cannot cover. It stays a fallback -- see
      // `resolveRenderedProviderId`.
      const providerId = event?.properties?.info?.model?.providerID;
      if (providerId !== undefined) setActiveProviderId(providerId);
      usageStore.refreshSafely(0);
    });
    if (typeof unsubscribe === "function") unsubscribeSession = unsubscribe;
  } catch {
    // Event subscription is additive; a failure must not abort the plugin.
  }
  try {
    // Also the one event on the pinned host that actually names a provider: an
    // assistant message carries a flat `providerID`, where `session.updated`
    // carries none. This is the belt to the message-store braces -- the band
    // re-reads the store reactively on its own, so this only keeps the fallback
    // signal current for a session whose store read has not caught up.
    const unsubscribe = api.event.on("message.updated", (event) => {
      const providerId = providerIdFromMessages([event?.properties?.info]);
      if (providerId !== undefined) setActiveProviderId(providerId);
      usageStore.refreshSafely(EVENT_TTL_MS);
    });
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
