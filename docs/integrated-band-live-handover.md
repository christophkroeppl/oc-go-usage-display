# Resolved: the band could not be handed back to our own panel

Status: **fixed**, 2026-10-02, in `fix/sidebar-band-live-handover`. Kept as the
record of why the band registers where it does — the fix is a one-line constant,
and without this the next person will "tidy" it back into a tie.

## What it looked like

Integrated mode, session starts on a non-Go model, Kilo's own panel is on screen.
The user picks a Go model and sends a turn. The transcript updates, the context
grows, the statusline follows — and the usage region of the sidebar goes
**empty**:

```
▼ Context
  1,230,000 tokens
  Code Indexing
  • Disabled
  LSP
```

No `Session Tokens`, no `Token Usage`, nothing between `Context` and `Code
Indexing`. The host panel was retired and ours did not take its place. Once in
this state no command could recover it: the sidebar toggle only flips a fold
flag, and the mode toggle had nothing to move.

## Why it happened

The handover is one decision (`hostUsagePanelEnabled` off `ownsIntegratedBand`),
but taking the band is not symmetric with giving it back, and the asymmetry is in
the host:

- **Giving it back** worked. `api.plugins.activate("internal:kilo-sidebar-usage")`
  adds an entry to the slot list we are already contributing to, and both draw.
- **Taking it** emptied the band. `api.plugins.deactivate(...)` disposes the host
  panel's scope, which disposes its `api.slots.register` result — and therefore
  **removes an entry from the same `sidebar_content` list our band lives in**.

`@opentui/solid` renders that list with a keyed `<For>` over the registry's entry
ids (`packages/solid/src/plugins/slot.tsx`, `appendEntryIds`). Integrated mode
registered at order 150 *on purpose*, tying with `internal:kilo-sidebar-usage`, so
both entries sat at the same index. Removing one shifted every later entry down an
index, and Solid's `mapArray` reconciles by index: the entry that used to sit
beside ours was disposed when the array shrank, and a fresh one was built for the
id that moved up — but our component's render subtree did not come back. The
plugin log carried no error, consistent with the subtree being disposed rather
than throwing.

The tie was load-bearing for the old design — it is what put the Go readout
exactly where Kilo draws usage — and that is precisely what made it unsafe.

## The fix

Stop tying. Both modes now register at `KILO_SLOT_ORDER` (125), the free band
between `internal:sidebar-context` (100) and `internal:kilo-sidebar-usage` (150).

Because our entry no longer shares an index with the host's, the host entry can
be added and removed at 150 without ours ever shifting index, so **both**
directions of the handover are safe. The cost is one row of vertical position:
our panel now sits directly above Kilo's `Token Usage` block rather than exactly
on it. Integrated mode still retires that panel, so there is only ever one usage
block in the sidebar.

This also removes the reason the mode toggle needed a restart. The slot `order`
used to be chosen by `sidebar_mode` at registration, and the SDK exposes no
unregister, so a mode change could not move the band until the next TUI start.
The mode is now a *rendering* decision inside the band, so it applies
immediately.

`KILO_INTEGRATED_SLOT_ORDER` is gone. `test/unit/shared.test.js` now asserts the
*absence* of a tie — our order must not equal any host panel's order — so a Kilo
release cannot reintroduce this by moving a panel onto 125.

## What is pinned, and how

| direction | covered by | state |
| --- | --- | --- |
| our panel → Kilo's panel | e2e, boot-time, non-Go session | passing |
| our panel, Go-only session | e2e, boot-time | passing |
| Kilo's panel → our panel, boot-time | e2e, mixed-provider session | passing |
| both directions, live, one session, no restart | e2e, model switched through the host's own picker | passing |

The live rung moves the band **twice** — Go → non-Go → Go — because the first
handover was never the one that broke; taking the band *back* is what used to
empty it, and a test that only ever deferred would not have caught that.

## Two things that are not ours to fix

### A plugin cannot see another process's turn

The live rung originally drove the model change from a **separate `kilo run`**.
That cannot work, and it is worth writing down why, because the failure looks
exactly like a plugin bug:

```
boot:      STORE providers = ["user:other-provider", "assistant:other-provider"]
+ a Go turn written by another `kilo run` into the same session
after 15s: STORE providers = ["user:other-provider", "assistant:other-provider"]
           message.updated events fired: 0
```

No event, and the store frozen. A Kilo 7.8.3 TUI plugin has no channel at all to
a foreign process's turn, so there is nothing for `resolveRenderedProviderId` to
prefer over the store — preferring the newer event would have been a no-op. This
was measured rather than inferred, precisely because the two candidate fixes
("rank by recency" and "re-read the store") behave identically when no event ever
arrives.

`resolveRenderedProviderId` therefore still prefers the session message store over
`Session.model`, which remains the right order for the cases that do work. If a
host ever delivers foreign-process messages, ranking the two by recency instead of
by kind is the change to make, and this rung is the spec for it — switch it back to
`runHeadlessPrompt` and it will tell you.

### The model switch has to happen in the TUI

A user switching models uses the host's picker, which is in-process. That is the
workflow the band is actually held to, so the live rung drives it: `ctrl+x m`,
filter by model name, Enter.

Two traps, both of which make the test pass while testing nothing:

- **The picker rejects a provider-qualified filter.** `other-provider/other-probe`
  finds nothing; the filter matches on the model name alone. So each provider gets
  its own single-model fake catalog — `fake.configFor(id)` registers *every* model
  it knows under whichever id you ask for, so one fake serving both models lists
  `other-probe` under `opencode-go` too, and the filter then selects the Go model.
- **The picker must be verified, not trusted.** `pickModel` asserts the pane names
  both the model *and* the provider afterwards, so a filter that matched the wrong
  row fails loudly instead of quietly producing "the band never moved".

## Where it is not

- opencode has no equivalent: its sidebar block is not a takeover, so there is no
  host entry to remove.
- The boot-time behaviour of both modes is unaffected and covered.