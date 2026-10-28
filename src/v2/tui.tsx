/** @jsxImportSource @opentui/solid */
// OpenCode Go usage plugin for opencode v2 (TUI half).
//
// v2 slot claims are painted exactly once: the host builds the claim's element
// at mount and never repaints on a plugin signal write (the plugin and the host
// run separate reactive graphs). A claim that returned `null` before a session
// existed therefore stays `null` for the life of the TUI. Everything here is
// built from plain values captured at paint time, and the panel repaints by
// disposing its claim and registering a new one -- a fresh mount is a fresh
// initial paint, which always lands.
//
// The mounted slot input is the only trustworthy source of the active session:
// `ui.router.current()` reports `home` while a session is on screen.
//
// Theme: `ctx.theme` is a `ResolvedTheme` (`text.base`, `text.muted`,
// `text.feedback.error.base`, ...) holding `Color` objects rather than the v1
// flat `TuiThemeCurrent` strings. It is adapted once into the shape the shared
// renderers already take; OpenTUI accepts those `Color` objects directly.

import { Plugin } from "@opencode/plugin/tui";
import { For } from "solid-js";
import {
  createCollapseState,
  createUsageStore,
  GoStatusline,
  GoUsageBlock,
  MeterBar,
  SectionHeader,
} from "../tui-shared.js";
import type { UsagePanelApi, UsageStore } from "../tui-shared.js";
import type { TuiTheme, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import {
  modelDisplayName,
  shortModelName,
  weightGoModels,
  buildModelMixSummary,
  buildGoModelFooters,
  formatPercentCell,
  meterSeverityForPercent,
  isGoUsageProvider,
} from "../tui-helpers.js";
import type { GoModelWeights } from "../tui-helpers.js";
import { relevantReset, providerIdFromMessages } from "../helpers.js";
import {
  MODELS_EMPTY_LABEL,
  OPENCODE_MODEL_NAME_MAX_CHARS,
  TOP_GO_MODELS_LABEL,
  aggregateModelUsageFromMessages,
  pickHostApiKey,
} from "../shared.js";
import type { UsageSnapshot } from "../shared.js";

const HOST = "opencode" as const;
const TICK_MS = 30_000;
const REPAINT_DEBOUNCE_MS = 400;

function adaptTheme(source: any): TuiTheme {
  const text = source?.text ?? {};
  const current = {
    text: text.base,
    textMuted: text.muted,
    error: text.feedback?.error?.base,
    warning: text.feedback?.warning?.base,
    success: text.feedback?.success?.base,
    backgroundElement: source?.background?.raised?.base ?? source?.background?.base,
  } as unknown as TuiThemeCurrent;
  return {
    current,
    selected: "",
    has: () => false,
    set: () => false,
    install: async () => {},
    mode: () => "dark",
    ready: true,
  };
}

function WeightedModelRow(props: { theme: TuiTheme; model: GoModelWeights["models"][number] }) {
  const rounded = Math.round(props.model.share);
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
        {modelDisplayName(null, props.model.modelID, OPENCODE_MODEL_NAME_MAX_CHARS)}
      </text>
      <MeterBar
        theme={props.theme}
        percent={props.model.share}
        severity={meterSeverityForPercent(rounded)}
      />
      <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0}>
        {formatPercentCell(rounded)}
      </text>
    </box>
  );
}

function TopGoModelsSection(props: {
  theme: TuiTheme;
  weights: GoModelWeights;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (props.weights.goModels === 0) {
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

  const mix = buildModelMixSummary(
    props.weights.models.map((model) => ({
      name: shortModelName(modelDisplayName(null, model.modelID, OPENCODE_MODEL_NAME_MAX_CHARS)),
      share: model.share,
    })),
  );

  return (
    <box flexDirection="column">
      <SectionHeader
        theme={props.theme}
        label={TOP_GO_MODELS_LABEL}
        expanded={() => props.expanded}
        count={() => props.weights.goModels}
        onToggle={props.onToggle}
      />
      {props.expanded ? (
        <box flexDirection="column" paddingTop={1} paddingLeft={2}>
          <For each={props.weights.models}>
            {(model) => <WeightedModelRow theme={props.theme} model={model} />}
          </For>
          <For each={buildGoModelFooters(props.weights)}>
            {(line) => (
              <text fg={props.theme.current.textMuted} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
      ) : (
        <text fg={props.theme.current.textMuted} wrapMode="none" paddingLeft={2}>
          {mix}
        </text>
      )}
    </box>
  );
}

function SidebarPanel(props: {
  api: UsagePanelApi;
  theme: TuiTheme;
  snapshot: UsageSnapshot | null;
  weights: GoModelWeights;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = props.theme;
  const snapshot = props.snapshot;
  return (
    <box flexDirection="column" gap={1}>
      <GoUsageBlock
        api={props.api}
        theme={theme}
        snapshot={() => snapshot}
        resetLine={() =>
          snapshot === null || snapshot.source === "unavailable" ? null : relevantReset(snapshot)
        }
      />
      <TopGoModelsSection
        theme={theme}
        weights={props.weights}
        expanded={props.expanded}
        onToggle={props.onToggle}
      />
    </box>
  );
}

export default Plugin.define({
  id: "oc-go-usage-display",
  setup(ctx: any) {
    const disposers: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setInterval>> = [];
    let cleaned = false;

    try {
      const kvStore = ctx.storage.memory("oc-go-usage-display", {
        initial: {} as Record<string, unknown>,
      });
      const kv = {
        get<Value = unknown>(key: string, fallback?: Value): Value {
          try {
            const value = (kvStore[0] as any)?.()[key];
            return value === undefined ? (fallback as Value) : (value as Value);
          } catch {
            return fallback as Value;
          }
        },
        set(key: string, value: unknown): void {
          try {
            kvStore[1]((draft: any) => {
              draft[key] = value;
            });
          } catch {
            // Collapse state is best-effort persistence only.
          }
        },
      };
      const api: UsagePanelApi = {
        kv,
        client: { app: { log: async () => undefined } },
        credential: {
          read: async () => {
            try {
              return pickHostApiKey(await ctx.client?.credential?.list?.());
            } catch {
              return null;
            }
          },
        },
      };

      const usageStore: UsageStore = createUsageStore(api, HOST);
      const collapse = createCollapseState(api);
      const theme = adaptTheme(ctx.theme);
      const surfaces = { sidebar: true, statusline: true };

      let ready = false;
      let expanded = false;
      let mountedSessionId = "";
      let paintTimer: ReturnType<typeof setTimeout> | null = null;
      let disposeSidebar: (() => void) | null = null;
      let disposeStatusline: (() => void) | null = null;
      let lastSidebarKey = "";
      let lastStatuslineKey = "";

      function readSessionMessages(sessionId: string): readonly unknown[] {
        if (sessionId.length === 0) return [];
        try {
          return ctx.data?.session?.message?.list(sessionId) ?? [];
        } catch {
          return [];
        }
      }

      function renderedProviderId(sessionId: string): string | undefined {
        if (sessionId.length === 0) return undefined;
        try {
          const fromMessages = providerIdFromMessages(readSessionMessages(sessionId) as any);
          if (fromMessages !== undefined) return fromMessages;
        } catch {
          // Fall through to the session record.
        }
        try {
          const fromSession = ctx.data?.session?.get?.(sessionId)?.model?.providerID;
          if (typeof fromSession === "string" && fromSession.length > 0) return fromSession;
        } catch {
          // Fall through to the configured model.
        }
        try {
          const configured = ctx.options?.model;
          if (typeof configured === "string" && configured.includes("/")) {
            return configured.split("/")[0];
          }
        } catch {
          // No configured model to fall back to.
        }
        return undefined;
      }

      function noteSession(sessionId: unknown): string {
        if (typeof sessionId === "string" && sessionId.length > 0) mountedSessionId = sessionId;
        return mountedSessionId;
      }

      function sidebarVisible(sessionId: string): boolean {
        return (
          sessionId.length > 0 &&
          !collapse.isSidebarCollapsed() &&
          isGoUsageProvider(renderedProviderId(sessionId))
        );
      }

      function statuslineVisible(sessionId: string): boolean {
        return (
          sessionId.length > 0 &&
          !collapse.isStatuslineCollapsed() &&
          isGoUsageProvider(renderedProviderId(sessionId))
        );
      }

      function weightsFor(sessionId: string): GoModelWeights {
        return weightGoModels(
          aggregateModelUsageFromMessages(readSessionMessages(sessionId))?.models ?? [],
        );
      }

      function snapshotKey(snapshot: UsageSnapshot | null): unknown {
        return snapshot === null
          ? null
          : [snapshot.source, snapshot.fetchedAt, snapshot.apiError ?? null];
      }

      function toggleExpanded(): void {
        expanded = !expanded;
        paintSidebar(true);
      }

      function paintSidebar(force = false): void {
        if (cleaned || !surfaces.sidebar) return;
        const sessionId = mountedSessionId;
        const snapshot = usageStore.snapshot();
        const key = JSON.stringify([
          sessionId,
          snapshotKey(snapshot),
          expanded,
          expanded ? null : Math.floor(Date.now() / TICK_MS),
        ]);
        if (!force && key === lastSidebarKey) return;
        lastSidebarKey = key;

        try {
          disposeSidebar?.();
        } catch {
          // Host-owned claim teardown is best-effort.
        }
        disposeSidebar = null;

        try {
          disposeSidebar = ctx.ui.slot({
            append: "sidebar.content",
            render: (input: any) => {
              const sid = noteSession(input?.sessionID);
              if (!sidebarVisible(sid)) return null;
              return (
                <SidebarPanel
                  api={api}
                  theme={theme}
                  snapshot={snapshot}
                  weights={weightsFor(sid)}
                  expanded={expanded}
                  onToggle={toggleExpanded}
                />
              );
            },
          });
        } catch {
          disposeSidebar = null;
        }
      }

      function paintStatusline(force = false): void {
        if (cleaned || !surfaces.statusline) return;
        const snapshot = usageStore.snapshot();
        const key = JSON.stringify([mountedSessionId, snapshotKey(snapshot), Math.floor(Date.now() / TICK_MS)]);
        if (!force && key === lastStatuslineKey) return;
        lastStatuslineKey = key;

        try {
          disposeStatusline?.();
        } catch {
          // Host-owned claim teardown is best-effort.
        }
        disposeStatusline = null;

        try {
          disposeStatusline = ctx.ui.slot({
            append: "prompt.footer.status",
            render: (input: any) => {
              const sid = noteSession(input?.sessionID);
              if (!statuslineVisible(sid)) return null;
              return <GoStatusline snapshot={() => snapshot} />;
            },
          });
        } catch {
          disposeStatusline = null;
        }
      }

      function paint(): void {
        if (cleaned || !ready) return;
        paintSidebar();
        paintStatusline();
      }

      function schedulePaint(): void {
        if (cleaned) return;
        if (paintTimer !== null) clearTimeout(paintTimer);
        paintTimer = setTimeout(() => {
          paintTimer = null;
          paint();
        }, REPAINT_DEBOUNCE_MS);
      }

      timers.push(setInterval(schedulePaint, TICK_MS));

      try {
        const stop = ctx.data.listen(schedulePaint);
        if (typeof stop === "function") disposers.push(stop);
      } catch {
        // Additive: without data events the panel still refreshes on its timer.
      }

      timers.push(
        setInterval(() => {
          usageStore.refreshSafely();
          schedulePaint();
        }, TICK_MS),
      );

      void usageStore
        .refresh()
        .catch(() => {})
        .then(() => {
          ready = true;
          paint();
        });

      return () => {
        cleaned = true;
        if (paintTimer !== null) clearTimeout(paintTimer);
        for (const timer of timers) clearInterval(timer);
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // Teardown is best-effort.
          }
        }
        try {
          disposeSidebar?.();
          disposeStatusline?.();
        } catch {
          // Host-owned claim teardown is best-effort.
        }
      };
    } catch {
      return () => {};
    }
  },
});
