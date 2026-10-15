// Pure helpers shared by the plugin entry modules.
//
// IMPORTANT: these live OUTSIDE `src/index.ts` / `src/tui.tsx`. OpenCode's
// loader enumerates every export of a plugin entry module and (when the
// default is not a `{ id, server }` module) invokes each one as a plugin
// factory. An entry module must therefore export ONLY its default module;
// keeping the helper surface here makes that contract structural instead of
// accidental (a stray `export function` returning null used to crash
// `Provider.list`).
//
// Unit-tested via `dist/helpers.js` (see test/unit/server.test.js and
// test/unit/tui.test.js).

import { formatResetDuration, GO_PROVIDER_ID } from "./shared.js";
import type { UsageSnapshot, UsageWindow } from "./shared.js";
import { buildPlanRows } from "./tui-helpers.js";

// ---------------------------------------------------------------------------
// Shared: display-mode + snapshot shaping (used by both server and TUI)
// ---------------------------------------------------------------------------

export type DisplayMode = "sidebar" | "statusline" | "both";

export type SurfaceSelection = {
  sidebar: boolean;
  statusline: boolean;
};

// One label/value row, the grammar the host's own panels use.
export type UsageRow = {
  label: string;
  value: string;
};

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "sidebar" || value === "statusline" || value === "both";
}

// What the Go block shows while it is showing:
//   - `integrated`  — retires the host's own token-usage panel and draws a fork
//     of it, so both usage readouts are one block instead of two.
//   - `standalone` — our own block, host panel untouched.
// Both register in the same free band (KILO_SLOT_ORDER), so the mode is a
// rendering decision rather than a position: switching it live cannot disturb
// the host's slot entry.
export type SidebarMode = "integrated" | "standalone";

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "integrated";

// Tolerant like `parseBooleanFlag`, because the same value reaches us from a
// hand-written env var and from typed JSON: null means "unset or unrecognized",
// and the caller keeps falling through to the next source.
export function parseSidebarMode(value: unknown): SidebarMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "integrated" || normalized === "standalone" ? normalized : null;
}

// Which provider a session is actually running, for the Go-only display gate.
// Pure so the precedence is unit-testable: the TUI entry reads this on every
// render rather than latching a value at init.
export type ProviderSource = {
  config?: { model?: unknown } | undefined;
  session?: { get?: ((sessionID: string) => { model?: { providerID?: unknown } | undefined } | undefined) | undefined } | undefined;
};

// One host message, reduced to the field that says which provider it ran on.
// Structural on purpose: the two hosts disagree about the field name —
// Kilo's `AssistantMessage` flattens `providerID` while its `UserMessage` nests
// it under `model.providerID` — and this layer must not depend on either SDK's
// types to read both.
export type ProviderBearingMessage = {
  providerID?: unknown;
  model?: { providerID?: unknown } | undefined;
};

// The provider a session is really running, taken from the NEWEST message that
// carries one.
//
// The message store is the PRIMARY source on every Kilo version we support, and
// the reason is what the band needs rather than what the host happens to expose:
// the models table is a fold over what ran in this session, so a provider that
// appears in the store has rows to weight and a `Go share` to hang off, while a
// provider only named by `Session.model` has neither. It is also the source that
// re-reads -- it is a live Solid store, and unlike `Session.model` it reflects
// the model a step actually ran under, including a `kilo-auto/…` model that the
// host routed to a different provider.
//
// Version history, because the choice looks arbitrary otherwise:
//   Kilo <= 7.8.1  `Session` had no `model` field and the SDK had no model-switch
//                  event, so the store was the only reactive answer available.
//   Kilo 7.8.3     `Session.model` and a `session.next.model.switched` event
//                  appeared. Both are kept as fallbacks (see `resolveProviderId`),
//                  but neither outranks the store: a model picked but not yet run
//                  would claim the band for a table with no rows in it.
//
// Walking backwards means a trailing message on the newly picked provider wins
// over older ones, which is what makes a model switch follow through once the
// user has actually used it.
//
// A store that throws or returns a non-array is not a reason to hide anything:
// the caller falls through to the configured model.
export function providerIdFromMessages(
  messages: readonly ProviderBearingMessage[] | undefined,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (message === null || typeof message !== "object") continue;
    const row = message as ProviderBearingMessage;
    const flat = toNonEmptyString(row.providerID);
    if (flat !== null) return flat;
    const nested = toNonEmptyString(row.model?.providerID);
    if (nested !== null) return nested;
  }
  return undefined;
}

export function providerIdFromModel(model: unknown): string | undefined {
  if (typeof model !== "string" || model.length === 0) return undefined;
  const provider = model.split("/")[0];
  return provider !== undefined && provider.length > 0 ? provider : undefined;
}

export function resolveProviderId(
  state: ProviderSource | undefined,
  sessionId: string,
  fallback: string | undefined,
): string | undefined {
  // The session's own model is the one in use, so it outranks the config default.
  try {
    const fromSession = state?.session?.get?.(sessionId)?.model?.providerID;
    if (typeof fromSession === "string" && fromSession.length > 0) return fromSession;
  } catch {
    // Fall through: a throwing store is not a reason to hide the panel.
  }
  try {
    const fromConfig = providerIdFromModel(state?.config?.model);
    if (fromConfig !== undefined) return fromConfig;
  } catch {
    // Fall through to the event-signal fallback.
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Which block our sidebar shows
// ---------------------------------------------------------------------------
//
// One decision, split in two, because Kilo's sidebar has a panel we may retire:
// integrated mode switches the host's token-usage panel off and draws a fork of
// it instead, so "do we draw?" and "must the host panel be on?" are different
// questions with different answers.
//
// The two answers come from one rule: we are the only usage block in the sidebar
// exactly while we are drawing. So the host panel goes away only when
// `ownsIntegratedBand`, and every way of not drawing -- no sidebar, collapsed,
// standalone mode, or a session on a non-Go model -- leaves Kilo's own widget on
// screen. Collapsing is in that list because a collapsed band still occupies the
// space it registered for; it is also the one case that would otherwise have been
// an empty band before this rule existed.
//
// The mode decides WHAT the band draws and WHOSE panel is retired, never WHETHER
// we draw: `sidebarBandRenders` does not read it. That is the README's promise
// ("the mode decides what it draws, not whether it is there") as an invariant, and
// it is why the two modes cannot drift apart in which sessions they answer to.
//
//   integrated + Go provider     -> our panel draws, Kilo's does not.
//   integrated + any other model -> Kilo's panel draws. Ours is not a lossless
//                                   fork of it (it has no `Terminal Bench 2.0`
//                                   section and no `Generation speed` row), so
//                                   the honest thing when we have no Go model to
//                                   meter is to hand the band back rather than
//                                   replace a panel we cannot fully reproduce.
//   standalone + Go provider     -> our own band above Kilo's panel, both on screen.
//   standalone + any other model -> Kilo's panel alone; the standalone block IS
//                                   the Go plan, so a non-Go session has no use
//                                   for it.
//
// `sidebarEnabled` is the `sidebar` surface toggle: are we registered in a band
// at all? `collapsed` is the user's fold toggle.
//
// Pure and exhaustive, so the whole matrix is testable without a host. The TUI
// entry reads these inside memos, never once at slot-mount: the host invokes a
// slot renderer exactly once per mount, so a condition read in the slot body is
// latched for the life of the band.
export type SidebarBandState = {
  sidebarEnabled: boolean;
  collapsed: boolean;
  mode: SidebarMode;
  providerId: string | undefined;
};

/**
 * Whether the Models column-header row should render. The header is only
 * meaningful when at least one model row exists beneath it; an empty group
 * (e.g. a session with no model usage yet) must not show a bare header.
 */
export function shouldRenderModelsHeader(models: readonly unknown[]): boolean {
  return models.length > 0;
}

export function ownsIntegratedBand(state: SidebarBandState): boolean {
  return (
    state.sidebarEnabled &&
    !state.collapsed &&
    state.mode === "integrated" &&
    state.providerId === GO_PROVIDER_ID
  );
}

// The host's panel is on unless we are filling the space it would have used.
// This is the single writer of that switch, which is what keeps the empty band
// from coming back: no sidebar, standalone mode, a collapsed band or a non-Go
// session all mean Kilo's own widget is on screen.
export function hostUsagePanelEnabled(state: SidebarBandState): boolean {
  return !ownsIntegratedBand(state);
}

// The band draws for a Go session and not otherwise, in either mode. Note what is
// NOT here: `mode`. The standalone block is the Go plan, and the integrated panel
// stands in for Kilo's own token usage, but both are only about Go usage -- so
// they answer the same question about which sessions they serve, and a session
// that gets neither is one where Kilo's own widget is on screen instead.
export function sidebarBandRenders(state: SidebarBandState): boolean {
  return state.sidebarEnabled && !state.collapsed && state.providerId === GO_PROVIDER_ID;
}

// The statusline is the plan on one line, so it stays Go-only in both modes --
// unlike the sidebar, it replaces nothing and hands nothing back. It is here so
// the two surfaces cannot disagree about which sessions are Go.
//
// The statusline is the plan on one line, so it stays Go-only in both modes --
// unlike the sidebar, it replaces nothing and hands nothing back. It is here so
// the two surfaces cannot disagree about which sessions are Go.
//
// `collapsed` is the fold flag OF THE STATUSLINE, and that is the whole reason the
// two surfaces stay independent: each caller hands this function its OWN surface's
// flag, so folding the sidebar cannot hide the statusline and folding the
// statusline cannot unmake the sidebar. Two persisted keys, two axes.
//
// It used to be dropped here, which is why the statusline could not be turned off:
// the Kilo entry passed `isStatuslineCollapsed()` in and this ignored it, so the
// flag was persisted (`collapsed_statusline`) and had no effect on anything. The
// sidebar toggle is still not allowed to steer the statusline -- that independence
// lives in WHICH flag the caller passes, not in ignoring the one it was given.
export function statuslineRenders(state: Pick<SidebarBandState, "collapsed" | "providerId">): boolean {
  return !state.collapsed && state.providerId === GO_PROVIDER_ID;
}

export function surfaceSelectionFromDisplayMode(mode: DisplayMode): SurfaceSelection {
  return { sidebar: mode !== "statusline", statusline: mode !== "sidebar" };
}

export function parseBooleanFlag(value: unknown): boolean | null {
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

export function isSnapshotEmpty(snapshot: UsageSnapshot): boolean {
  return snapshot.rolling === null && snapshot.weekly === null && snapshot.monthly === null;
}

// The countdown the plan is currently waiting on, as the label of the window it
// belongs to plus the text to print. `null` when the plan has no usable reset
// at all, and every surface then prints nothing rather than a placeholder.
export type ResetCountdown = { label: string; text: string };

// Which window's countdown the plan is waiting on. One decision, read by the
// sidebar's reset line, by the per-row suffixes under a capped meter and by the
// statusline, so no two of them can name different windows.
//
// A capped window outranks a nearer one, and the longest cap outranks the
// shorter ones: an exhausted `30d` is what actually stops work, so a `5h` that
// rolls over in two hours is not the fact worth the cells. With nothing capped
// the soonest reset is the answer, because that is the first moment the
// percentages printed beside it will move.
//
// The capped case is read back out of `buildPlanRows` instead of re-deriving
// what "capped" means, so the statusline cannot drift from the sidebar. Only
// `resetInSec` is ever compared; a window that carries nothing but the host's
// free text can be printed once it has been chosen, never compared as a string.
export function relevantReset(snapshot: UsageSnapshot): ResetCountdown | null {
  const rows = buildPlanRows(snapshot);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.reset != null) return { label: row.label, text: row.reset };
  }
  return soonestReset(snapshot);
}

// The soonest reset across the windows, capped or not. A stale payload, clock
// skew or a reset that fired mid-flight can all send a negative span, and an
// elapsed countdown is as unusable as an unreadable one.
function soonestReset(snapshot: UsageSnapshot): ResetCountdown | null {
  const windows: ReadonlyArray<readonly [string, UsageWindow | null]> = [
    ["5h", snapshot.rolling],
    ["7d", snapshot.weekly],
    ["30d", snapshot.monthly],
  ];
  let soonest: { label: string; seconds: number } | null = null;
  for (const [name, window] of windows) {
    if (window === null) continue;
    const seconds = window.resetInSec;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) continue;
    if (soonest !== null && seconds >= soonest.seconds) continue;
    soonest = { label: name, seconds };
  }
  if (soonest === null) return null;
  const text = formatResetDuration(soonest.seconds);
  return text === null ? null : { label: soonest.label, text };
}

// Need to import toNonEmptyString for providerIdFromMessages
import { toNonEmptyString } from "./shared.js";