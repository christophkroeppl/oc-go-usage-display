/** @jsxImportSource @opentui/solid */
// OpenCode Go usage plugin for opencode v2 (TUI half).
//
// Registers the same sidebar block + statusline the v1 entry does, plus the
// per-model (Top Go models) fold. Data sources are v2-native: the per-model
// mix is folded from `ctx.data.session.message.list(sessionID)` via the shared
// `aggregateModelUsageFromMessages`, and the Go quota snapshot is fetched by
// the shared `createUsageStore` (which only needs a `UsagePanelApi` adapter).
//
// Slot claims follow cockpit's v2 mapping: `sidebar.content` and
// `prompt.footer.status`.

import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  createCollapseState,
  createUsageStore,
  GoStatusline,
  GoUsageBlock,
  CollapsibleSection,
  MeterBar,
  reactiveChild,
  readModelDisplayName,
} from "../tui-shared.js";
import {
  aggregateModelUsageFromMessages,
} from "../shared.js";
import {
  modelDisplayName,
  shortModelName,
  weightGoModels,
  buildModelMixSummary,
  buildGoModelFooters,
  relevantReset,
  formatPercentCell,
  meterSeverityForPercent,
} from "../tui-helpers.js";
import type { UsagePanelApi } from "../tui-shared.js";
import type { TuiTheme } from "@opencode-ai/plugin/tui";
import { makeProviderResolver } from "../tui-shared.js";
import {
  MODELS_EMPTY_LABEL,
  OPENCODE_MODEL_NAME_MAX_CHARS,
  TOP_GO_MODELS_LABEL,
} from "../shared.js";
import type { SessionModelUsage } from "../shared.js";
import { providerIdFromMessages } from "../helpers.js";
import { isGoUsageProvider } from "../tui-helpers.js";

const HOST = "opencode" as const;

export default Plugin.define({
  id: "oc-go-usage-display",
  setup(ctx: any) {
    try {
      // --- adapter: v1 UsagePanelApi over the v2 context ---------------------
      const kvStore = ctx.storage.memory("oc-go-usage-display", { initial: {} as Record<string, unknown> });
      const kv = {
        get<Value = unknown>(key: string, fallback?: Value): Value {
          try {
            const v = (kvStore[0] as any)?.()[key];
            return v === undefined ? (fallback as Value) : (v as Value);
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
            // best-effort
          }
        },
      };
      const api: UsagePanelApi = {
        kv,
        client: { app: { log: async () => undefined } },
      };

      const surfaces = { sidebar: true, statusline: true };
      const usageStore = createUsageStore(api, HOST);
      const collapse = createCollapseState(api);

      const [activeProviderId, setActiveProviderId] = createSignal<string | undefined>(undefined);
      try {
        const modelString = ctx.options?.model;
        if (typeof modelString === "string" && modelString.length > 0) {
          const providerPart = modelString.split("/")[0];
          if (providerPart && providerPart.length > 0) setActiveProviderId(providerPart);
        }
      } catch {
        // fall through
      }
      const resolveActiveProviderId = makeProviderResolver(
        { config: { model: ctx.options?.model }, session: { get: (id: string) => ctx.data.session.get(id) } },
        activeProviderId,
      );

      const [stateToken, setStateToken] = createSignal(0);

      function readSessionMessages(sessionId: string): readonly unknown[] {
        if (sessionId.length === 0) return [];
        try {
          return ctx.data.session.message.list(sessionId) ?? [];
        } catch {
          return [];
        }
      }

      function resolveRenderedProviderId(sessionId: string): string | undefined {
        if (sessionId.length === 0) return undefined;
        try {
          const fromMessages = providerIdFromMessages(readSessionMessages(sessionId) as any);
          if (fromMessages !== undefined) return fromMessages;
        } catch {
          // fall through
        }
        return resolveActiveProviderId(sessionId);
      }

      function WeightedModelRow(props: { theme: TuiTheme; model: any }) {
        const rounded = createMemo(() => Math.round(props.model.share));
        const name = createMemo(() =>
          modelDisplayName(
            readModelDisplayName(
              { state: { provider: [] } } as any,
              props.model.providerID,
              props.model.modelID,
            ),
            props.model.modelID,
            OPENCODE_MODEL_NAME_MAX_CHARS,
          ),
        );
        return (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={props.theme.current.text} wrapMode="none" flexShrink={0}>
              {name()}
            </text>
            <MeterBar
              theme={props.theme}
              percent={props.model.share}
              severity={meterSeverityForPercent(rounded())}
            />
            <text fg={props.theme.current.textMuted} wrapMode="none" flexShrink={0}>
              {formatPercentCell(rounded())}
            </text>
          </box>
        );
      }

      function TopGoModelsSection(props: { theme: TuiTheme; usage: () => SessionModelUsage | null }) {
        const [isExpanded, setIsExpanded] = createSignal<boolean>(false);
        const weights = createMemo(() => weightGoModels(props.usage()?.models ?? []));
        const rows = (): any[] => weights().models;
        const mix = createMemo(() =>
          buildModelMixSummary(
            rows().map((model: any) => ({
              name: shortModelName(
                modelDisplayName(null, model.modelID, OPENCODE_MODEL_NAME_MAX_CHARS),
              ),
              share: model.share,
            })),
          ),
        );

        const body = () => (
          <box flexDirection="column" paddingTop={1} paddingLeft={2}>
            <For each={rows()}>{(model: any) => <WeightedModelRow theme={props.theme} model={model} />}</For>
            <For each={buildGoModelFooters(weights())}>
              {(line: string) => (
                <text fg={props.theme.current.textMuted} wrapMode="none">
                  {line}
                </text>
              )}
            </For>
          </box>
        );

        const section = createMemo(() => {
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
                onToggle={() => setIsExpanded((c: boolean) => !c)}
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
          return relevantReset(snapshot);
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
              resetLine={planResetLine}
            />
            <TopGoModelsSection theme={props.theme} usage={sessionUsage} />
          </box>
        );
      }

      function OpencodeSidebarSlot(props: { sessionId: string }) {
        return reactiveChild(() => {
          if (props.sessionId.length === 0) return null;
          if (collapse.isSidebarCollapsed()) return null;
          if (!isGoUsageProvider(resolveRenderedProviderId(props.sessionId))) return null;
          const rawTheme = typeof ctx.theme === "function" ? (ctx.theme as () => any)() : ctx.theme;
          const theme = (rawTheme ?? { current: { text: "white", textMuted: "gray", error: "red", warning: "yellow" } }) as unknown as TuiTheme;
          return <GoSidebarPanel theme={theme} sessionId={props.sessionId} />;
        });
      }

      function OpencodeStatuslineSlot(props: { sessionId: string }) {
        return reactiveChild(() => {
          if (props.sessionId.length === 0) return null;
          if (collapse.isStatuslineCollapsed()) return null;
          if (!isGoUsageProvider(resolveRenderedProviderId(props.sessionId))) return null;
          return <GoStatusline snapshot={usageStore.snapshot} />;
        });
      }

      // --- event wiring -----------------------------------------------------
      try {
        ctx.data.listen((e: any) => {
          const ev = e?.details;
          if (!ev) return;
          if (ev.type === "session.message.updated" || ev.type === "message.updated" || ev.type === "session.updated") {
            setStateToken((n: number) => n + 1);
            usageStore.refreshSafely(15_000);
          }
        });
      } catch {
        // additive
      }

      // --- slot registration ------------------------------------------------
      if (surfaces.sidebar) {
        try {
          ctx.ui.slot({
            append: "sidebar.content",
            render: (p: any) => <OpencodeSidebarSlot sessionId={p?.sessionID ?? ""} />,
          });
        } catch {
          // additive
        }
      }
      if (surfaces.statusline) {
        try {
          ctx.ui.slot({
            append: "prompt.footer.status",
            render: (p: any) => <OpencodeStatuslineSlot sessionId={p?.sessionID ?? ""} />,
          });
        } catch {
          // additive
        }
      }

      // initial fetch
      void usageStore.refresh().catch(() => {});

      // toast on startup
      try {
        ctx.ui.toast.show({ message: "OC Go usage loaded", variant: "info", duration: 2000 });
      } catch {
        // additive
      }

      return () => {};
    } catch (e) {
      try {
        ctx?.ui?.toast?.show?.({ message: `oc-go-usage-display init failed: ${String(e)}`, variant: "error" });
      } catch {
        // swallow
      }
      return () => {};
    }
  },
});
