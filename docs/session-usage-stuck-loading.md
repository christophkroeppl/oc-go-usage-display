# Known issue: the sidebar can get stuck on "Loading usage..."

Status: **open, not fixed.** Recorded 2026-09-30 while fixing the meter layout
(see `src/tui-shared.tsx`, `MeterBar` and `GoShareRow`). Deliberately left
alone for now; this file is the note so it is not rediscovered from scratch.

## What it looks like

Kilo's integrated sidebar renders the session band as:

```
Session Tokens
Loading usage...
```

and the Models table below it as:

```
Models (0)
No model usage yet
```

It never resolves, even though the session really does hold assistant messages
with tokens -- the transcript and the Context block both show them (for example
`1,024,000 tokens`), and the footer shows `1.0M`. Only the plugin's own
per-session read is missing.

Consequence: every Go model row loses its `Go share` meter, because the share is
a fold over exactly that data. The plan meters above it are unaffected, so the
block looks half-populated rather than broken.

## Why it happens

`fetchSessionModelUsage` in `src/tui.kilo.tsx` is called once during
`initializeTui` and then only from host event handlers:

```ts
// No timer: the panel refreshes on host events instead.
async function fetchSessionModelUsage(api, sessionId) {
  if (sessionId.length === 0) return null;
  try {
    const result = await api.client.kilocode.sessionModelUsage({ sessionID: sessionId });
    return parseSessionModelUsage(result.data);
  } catch {
    return null;
  }
}
```

Two things follow from that shape:

1. **A failure is indistinguishable from "not loaded yet."** The catch returns
   `null`, which the panel renders as the loading state rather than as an error
   or an empty result.
2. **There is no retry.** Once that single call has failed, nothing re-issues it
   until a host event happens to arrive. If the session was still being written
   when the panel mounted -- the common case for a session the plugin was opened
   against -- the miss is permanent for the life of the process.

So the window is small but real: the panel mounts, asks once, loses the race
against the session's first write, and then never asks again.

## How it was hit

Not by reasoning about the code -- by a test. `test/e2e/tui-meters.test.js` boots
the host nine times against one session and needs the share row on screen every
time. Roughly half the boots came up with `Models (0)` and no share row, with no
error anywhere. The first version of the test mistook that for a rendering bug;
it is the fetch failing.

The harness works around it rather than fixing it, which is worth knowing when
reading that test:

- `SETTLED_POLLS` -- three consecutive clean captures are required, because the
  host paints the sidebar and then goes back to `Loading usage...` while it
  finishes starting up, so a single matching frame is one that is about to be
  replaced.
- `BOOT_ATTEMPTS` -- a rung whose share row never appears is re-booted up to three
  times before the test fails.

Both exist because of this issue. Neither is a fix.

## Fixing it

The smallest correct change is to stop conflating "failed" with "loading", and to
retry a failed first read:

- keep the last successful payload and an explicit "unavailable" state, so a
  failure after a success does not blank a working panel, and a first-load failure
  stops claiming to be in progress;
- retry the initial read a bounded number of times with a short backoff, since the
  cause is a race against the session's first write rather than a dead endpoint;
- keep "no timer" for the steady state -- events are still the right trigger, and
  a poll would cost a request per interval for a number that changes rarely.

Worth deciding explicitly: whether a first-load failure should surface as an
error rather than an empty state. `INTEGRATED_UNAVAILABLE_LABEL` already exists
for the plan's own failures, so there is a precedent, but the session usage has
always degraded to empty, and changing that is a visible behaviour change rather
than a bug fix.

## Where it is not

- opencode's sidebar folds its own message store instead of calling an endpoint
  (`src/tui.tsx`), so it does not have this failure mode.
- The plan meters come from `loadUsageSnapshot`, which has its own refresh policy
  and its own cache, and are unaffected.