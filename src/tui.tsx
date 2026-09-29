/** @jsxImportSource @opentui/solid */
//
// OpenCode Go usage TUI plugin (dual-surface display).
//
// Everything shared with the Kilo entry -- the refresh policy, the settings
// ladder, the plan meters, the row grammar, the failure boundaries -- lives in
// `./tui-shared.jsx` and is inlined into this bundle. What is left here is what
// is genuinely opencode-specific:
//
//   - `SLOT_ORDER` (50) sits in the free band above every host panel, so the
//     block renders at the top of the sidebar. OpenCode's own `sidebar_content`
//     ladder starts at 100 (`sidebar-context`) and continues 200 mcp / 300 lsp /
//     400 todo / 500 files, and it registers no `session_prompt_right` panel at
//     all, so the statusline has nothing to stack against. Worktrunk renders
//     elsewhere so multi-render stacking is unaffected.
//   - both surfaces are additive multi-render (`sidebar_content` +
//     `session_prompt_right`); no `single_winner` slot is ever used.
//   - this host has no usage panel of its own to retire, so there is no
//     sidebar_mode axis: the block is one thing, at one order.
//
// WHAT THE BLOCK RENDERS
// ---------------------
// The sidebar is ~30 cells wide here (Kilo's is ~40), which decides the whole
// layout: the plan is the meters themselves rather than label/value lines, and
// the per-model section is a foldable block that starts collapsed.
//
//   Go Usage
//     5h resets in 2h5m        the next plan window, labelled, one line
//     5h   [#######.....] 42%  the three windows, 10-cell meters
//     7d   [#...........] 15%
//     30d  [#########..] 61%
//   > Top Go models (7)        one line: the mix, cheapest thing to keep
//     mimo 59% · qwen 25% ...
//                            (expanded: one row per model with a 6-cell
//                             weight bar, then what the rows cover and the
//                             session's Go totals)
//
// The weight of a model is its share of the Go tokens spent in THIS session --
// measured the way the host's own Context panel measures the number next to it,
// i.e. over the rendered session's assistant messages, not the session tree.
// See `aggregateModelUsageFromMessages` for why opencode needs no endpoint for
// this and what "the same shape as Kilo's" buys.
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
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  buildGoModelFooters,
  buildModelMixSummary,
  formatNextResetLine,
  meterSeverityForPercent,
  modelDisplayName,
  shortModelName,
  weightGoModels,
} from "./helpers.js";
import type { GoModelWeight } from "./helpers.js";
import {
  aggregateModelUsageFromMessages,
  errorMessage,
  MODELS_EMPTY_LABEL,
  OPENCODE_METER_WIDTH,
  OPENCODE_MODEL_NAME_MAX_CHARS,
  TOP_GO_MODELS_LABEL,
} from "./shared.js";
import type { SessionModelUsage } from "./shared.js";
import {
  CollapsibleSection,
  GoStatusline,
  GoUsageBlock,
  createCollapseState,
  createUsageStore,
  isGoUsageProvider,
  logUsageError,
  makeProviderResolver,
  meterColor,
  readModelDisplayName,
  reactiveChild,
  resolveSurfaceSelection,
} from "./tui-shared.js";
import { EVENT_TTL_MS, POLL_INTERVAL_MS } from "./tui-shared.js";
import type { DisplayOptions } from "./tui-shared.js";

// This entry is the opencode build, so it resolves `OPENCODE_OC_GO_*` and never
// reads a Kilo-prefixed name.
const HOST = "opencode" as const;
const SLOT_ORDER = 50;

// The factory body lives here so the exported `goUsageTui` can wrap the whole
// initialization in a single fail-safe boundary. A throwing factory would
// destabilize the host's plugin load, so it must never reject.
async function initializeTui(api: TuiPluginApi, options: PluginOptions | undefined): Promise<void> {
  const surfaces = resolveSurfaceSelection(options as DisplayOptions | undefined, api, HOST);
  const usageStore = createUsageStore(api, HOST);
  const collapse = createCollapseState(api);

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

  // The host's message store is where the per-model mix comes from, and it
  // changes without the plan changing. Bumping this token on the same events
  // that refresh the plan keeps the mix from going stale behind a host that
  // reuses the element it was handed instead of re-invoking this subtree (see
  // the reactivity note in `tui-shared`).
  const [stateToken, setStateToken] = createSignal(0);

  function readSessionMessages(sessionId: string): readonly unknown[] {
    if (sessionId.length === 0) return [];
    try {
      return api.state.session.messages(sessionId);
    } catch {
      return [];
    }
  }

  // One model row: the display name the catalog gives it, then its weight bar
  // and percent pushed to the right edge so the bars line up down the block.
  function WeightedModelRow(props: { theme: TuiTheme; model: GoModelWeight }) {
    const rounded = createMemo(() => Math.round(props.model.share));
    const name = createMemo(() =>
      modelDisplayName(
        readModelDisplayName(api, props.model.providerID, props.model.modelID),
        props.model.modelID,
        OPENCODE_MODEL_NAME_MAX_CHARS,
      ),
    );
    return (
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
          {name()}
        </text>
        <box flexGrow={1} minWidth={0} flexDirection="row" justifyContent="flex-end" flexShrink={0}>
          <text
            fg={meterColor(props.theme, meterSeverityForPercent(rounded()))}
            wrapMode="none"
          >
            {props.model.bar}
          </text>
          <text fg={props.theme.current.textMuted} wrapMode="none" marginLeft={1}>
            {rounded()}%
          </text>
        </box>
      </box>
    );
  }

  // The model mix. Collapsed by default: the one-line summary is the cheap
  // answer, and this block already leads a sidebar that the host's own Context
  // panel follows. The count in the header is every Go model the session used,
  // not the three rows below it, so a truncated ranking says so.
  function TopGoModelsSection(props: { theme: TuiTheme; usage: () => SessionModelUsage | null }) {
    const [isExpanded, setIsExpanded] = createSignal<boolean>(false);
    const weights = createMemo(() => weightGoModels(props.usage()?.models ?? []));
    const rows = (): GoModelWeight[] => weights().models;
    // The collapsed line names the same models the expanded rows do, in as few
    // cells as the sidebar has.
    const mix = createMemo(() =>
      buildModelMixSummary(
        rows().map((model) => ({
          name: shortModelName(
            modelDisplayName(
              readModelDisplayName(api, model.providerID, model.modelID),
              model.modelID,
              OPENCODE_MODEL_NAME_MAX_CHARS,
            ),
          ),
          share: model.share,
        })),
      ),
    );

    const body = createMemo(() => (
      <box flexDirection="column" gap={1} paddingTop={1} paddingLeft={2}>
        <For each={rows()}>{(model) => <WeightedModelRow theme={props.theme} model={model} />}</For>
        <For each={buildGoModelFooters(weights())}>
          {(line) => (
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {line}
            </text>
          )}
        </For>
      </box>
    ));

    // The whole section is one function child, because two rules apply here and
    // both are about the same thing: the host reuses the element it was handed,
    // so a plain value is read once at mount. That is why the conditions below
    // are read INSIDE this memo (re-running it is what re-reads them) and why
    // `Show` is given a value rather than an accessor -- solid's `Show` memoizes
    // `when` and never calls it, so an accessor here is a function object, and a
    // function object is always truthy. The real host caught exactly that: a
    // session with no assistant messages rendered `Top Go models (0)` with a
    // caret that opened onto nothing.
    const section = createMemo(() => {
      // No models yet is not a fold: there is nothing to fold, and a caret that
      // opens onto an empty box reads as a broken section.
      if (weights().goModels === 0) {
        return (
          <box flexDirection="column">
            <text fg={props.theme.current.text} wrapMode="none">
              <b>{TOP_GO_MODELS_LABEL}</b>
            </text>
            <text fg={props.theme.current.textMuted} wrapMode="none">
              {MODELS_EMPTY_LABEL}
            </text>
          </box>
        );
      }
      return (
        <box flexDirection="column">
          <CollapsibleSection
            theme={props.theme}
            label={TOP_GO_MODELS_LABEL}
            count={() => weights().goModels}
            expanded={isExpanded}
            onToggle={() => setIsExpanded((current) => !current)}
            body={body}
          />
          <Show when={!isExpanded()}>
            <text fg={props.theme.current.textMuted} wrapMode="none" paddingLeft={2}>
              {reactiveChild(mix)}
            </text>
          </Show>
        </box>
      );
    });

    return <box flexDirection="column">{reactiveChild(section)}</box>;
  }

  function GoSidebarPanel(props: { theme: TuiTheme; sessionId: string }) {
    const planResetLine = createMemo(() => {
      const snapshot = usageStore.snapshot();
      if (snapshot === null || snapshot.source === "unavailable") return null;
      return formatNextResetLine(snapshot);
    });
    const sessionUsage = createMemo(() => {
      stateToken();
      return aggregateModelUsageFromMessages(readSessionMessages(props.sessionId));
    });
    return (
      <box flexDirection="column" gap={1}>
        <GoUsageBlock
          api={api}
          theme={props.theme}
          snapshot={usageStore.snapshot}
          withPlan={false}
          layout="meters"
          meterWidth={OPENCODE_METER_WIDTH}
          resetLine={planResetLine}
        />
        <TopGoModelsSection theme={props.theme} usage={sessionUsage} />
      </box>
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
              if (!isGoUsageProvider(resolveActiveProviderId(props.session_id))) return null;
              if (api.route.current.name !== "session") return null;
              if (collapse.isSidebarCollapsed()) return null;
              return <GoSidebarPanel theme={ctx.theme} sessionId={props.session_id} />;
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
    const unsubscribe = api.event.on("message.updated", () => {
      usageStore.refreshSafely(EVENT_TTL_MS);
      // The model's share of the session changes with every finished message,
      // not only when the plan does.
      setStateToken((current) => current + 1);
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
