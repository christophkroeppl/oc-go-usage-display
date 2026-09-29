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
import { createSignal } from "solid-js";
import { errorMessage } from "./shared.js";
import {
  GoStatusline,
  GoUsageBlock,
  createCollapseState,
  createUsageStore,
  isGoUsageProvider,
  logUsageError,
  makeProviderResolver,
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

  function GoSidebarPanel(props: { theme: TuiTheme }) {
    return <GoUsageBlock api={api} theme={props.theme} snapshot={usageStore.snapshot} withPlan={true} />;
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
