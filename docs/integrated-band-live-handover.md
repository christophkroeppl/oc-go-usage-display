# Known issue: integrated mode cannot hand band 150 *back* to our own panel

Status: **open, not fixed.** Found 2026-10-02 on Kilo 7.8.3, immediately after
the fix that made a non-Go session show Kilo's own `Token Usage` panel instead of
an empty band (see `fix/integrated-sidebar-non-go-model`, and
`ownsIntegratedBand` in `src/helpers.ts`). This is the other direction of the same
handover, and it is what the live-switch e2e was written to find.

## What it looks like

Integrated mode, session starts on a non-Go model, Kilo's own panel is on screen.
The user picks a Go model in the picker and sends a turn. The transcript updates,
the context grows, the statusline follows — and band 150 goes **empty**:

```
▼ Context
  1,230,000 tokens
  Code Indexing
  • Disabled
  LSP
```

No `Session Tokens`, no `Token Usage`, nothing between `Context` and `Code
Indexing`. The host panel was retired and ours did not take its place.

## Why it happens

The handover is one decision (`hostUsagePanelEnabled` off `ownsIntegratedBand`),
but taking the band is not symmetric with giving it back, and the asymmetry is in
the host:

- **Giving it back** works. `api.plugins.activate("internal:kilo-sidebar-usage")`
  adds an entry to the slot list we are already contributing to, and both draw.
  This is the fix's whole point and `test/e2e/tui-band-kilo.test.js` pins it.
- **Taking it** empties the band. `api.plugins.deactivate(...)` disposes the host
  panel's scope, which disposes its `api.slots.register` result — and therefore
  **removes an entry from the same `sidebar_content` list our band lives in**.

`@opentui/solid` renders that list with a keyed `<For>` over the registry's entry
ids (`packages/solid/src/plugins/slot.tsx`, `appendEntryIds`). Both entries sit at
order 150, so removing one shifts every later entry down an index. Solid's
`mapArray` reconciles by index: the entry that used to be at index 1 is disposed
when the array shrinks, and a fresh `AppendEntry` is built at index 0 for the id
that moved up — but our component's render subtree does not come back. The plugin
log carries no error (`api.client.app.log` was empty, and no slot error was
reported), which is consistent with the subtree being disposed rather than
throwing.

So the sequence is: our panel decides it owns the band → the effect deactivates
the host panel → that disposal takes our own slot subtree with it → the band is
empty and nothing retries.

Notably this is **only reachable after start-up**. Before the fix, the panel was
deactivated during initialization, before the sidebar had settled, so the
reconciliation never ran against a live tree. The fix made the ownership decision
reactive, which is what exposed the host interaction underneath it.

## What is pinned, and what is not

| direction | covered by | state |
| --- | --- | --- |
| our panel → Kilo's panel | e2e, boot-time, non-Go session | passing |
| Kilo's panel → our panel, boot-time | e2e, mixed-provider session | passing |
| Kilo's panel → our panel, live | e2e, `live` rung | **skipped, this file** |

The unit matrix (`test/unit/sidebar-band.test.js`) pins the decision table for all
24 states, so the *decision* is known to be right; what is missing is the host
re-rendering after the switch.

## Fixing it

None of these has been tried; they are ordered by how much they assume.

1. **Do not remove the host's entry.** Keep the host panel registered and stop it
   drawing, rather than unregistering it. There is no API for that, so this needs
   an entry point that does not exist yet — worth asking upstream.
2. **Register at a different order.** If our entry and the host's never share an
   index range, a removal on one side cannot re-key the other. Cheap to try
   (149 or 151 instead of 150), but it moves the band relative to the host's, and
   the rendered position is pinned by `assertSidebarOrder`.
3. **Re-assert the slot after the switch.** If the subtree is dropped rather than
   unmounted, re-registering the slot would rebuild it — except the SDK returns an
   id and no disposer, so a second `register` adds a second entry instead of
   replacing one, which would put two copies of our panel on screen. Would need
   the host's registry, which is not reachable.
4. **Give up the band instead of taking it.** Render nothing whenever we cannot
   guarantee we own it, i.e. integrated mode shows Kilo's panel and ours only ever
   appears in standalone mode. This is option 1 in spirit — never deactivate —
   and it costs the integrated mode entirely. It is the fallback if the upstream
   question comes back "no".

## Where it is not

- opencode has no equivalent: its sidebar block is not a takeover, so there is no
  host entry to remove.
- standalone mode is untouched — it never touches the host panel.
- The boot-time behaviour of both modes is unaffected and covered.
