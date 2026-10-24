# PLAN: opencode v2 support as a third target

> **Status**: DRAFT (awaiting adversarial review) · **Date**: 2026-10-15 · **Scope**: add `opencode-v2` as a third install target beside `opencode` (v1) and `kilo`, with its own plugin entrypoints, install layout, bundles and container test tier.

---

## 0. Deviation from the brief, stated up front

The brief asks for a plan whose every created/changed file is shown in full. **This plan does not do that for Phases 1–4**, and deliberately: three questions below are unresolved, and each one changes the shape of the files. Writing full bodies now would produce text that Phase 0 invalidates, which is worse than an honest gap — a reviewer would approve file contents that cannot exist.

So: **Phase 0 is a spike whose output is the missing facts**, and Phases 1–4 are specified to the level that survives any of Phase 0's answers (file paths, target wiring, test tiers, acceptance criteria). Section 7 lists exactly which file bodies Phase 0 must produce before Phases 1–4 are written out in full.

The four unresolved questions, each of which a full-body plan would silently guess at (the first was added by review round 1, which correctly called it the most fundamental one):

1. **Does v2 auto-discover a plugin file with no config entry at all?** The docs say it does ("Local plugins under `.opencode/plugins/` are loaded automatically without a config entry"), and the global equivalent is `<config>/plugins/`. If so, the v2 install writes **no** plugin entry and the whole config-writer design changes shape.
2. **What loads the TUI/CLI half?** Auto-discovery, a `cli.json` `plugins` entry, or a plugin *package directory* with a `./tui` export — the docs describe all three mechanisms without saying which one applies to a bare local file. Our install writes bare local files.
3. **`@opentui/*` version conflict.** `@opencode/plugin@2.0.29` declares `@opentui/core >=0.5.17` and `@opentui/solid >=0.5.17` as peers. Our repo pins `@opentui/solid` to **exactly `0.5.11`**, on purpose ("pinned to the version the hosts ship"). One top-level devDependency cannot satisfy both. Which way this resolves changes `package.json`, `check-peer-ranges.mjs`, the lockfile, and possibly the build.
4. **Does the v2 TUI drive under tmux the way v1's does?** Our entire e2e tier is "boot the real TUI in a detached tmux session, `capture-pane`, assert on plain text". v2 introduces a background service and `--standalone`, and its TUI is a different client. If the pane does not render our slot in a capturable way, the e2e tier needs a different harness.

---

## 1. Current State Audit

### 1.1 What opencode v2 is

- **v2.0.29** is the current release. Installed locally via `brew install anomalyco/tap/opencode-v2` at `/home/linuxbrew/.linuxbrew/bin/opencode` (`opencode v2.0.29`).
- Published as a Docker image: `ghcr.io/anomalyco/opencode:2.0.29` — **verified available** (`docker manifest inspect`), as are `2.0.0` and `latest`. Versioned tags mean the container tier can pin v2 exactly like `OPENCODE_VERSION`/`KILO_VERSION` today.
- Upstream: `github.com/anomalyco/opencode`, default branch **`dev`** (not `main`), ~214k stars.
- The same `opencode` command serves v1 and v2; they are **not installed side by side by default**.

### 1.2 What it is NOT

- **It is not a superset of v1's plugin API.** The migration guide is unambiguous:

  > *"V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough."*

  This is a **rewrite of the entrypoints against a new API**, not a port. The reusable part is our pure library layer, not our entry modules.

- **It is not a different config directory.** v2 reads the *same* locations as v1 (`~/.config/opencode/opencode.json(c)`, `<project>/opencode.json(c)`, `<project>/.opencode/opencode.json(c)`), normalizing v1 fields in memory. So the v2 target and the v1 target **share one config directory** — this is the single most consequential fact in this plan (§2.3).

### 1.3 Eligible targets

| Target | Host | Config dir | Status |
|---|---|---|---|
| `opencode` | opencode 1.x | `~/.config/opencode` | exists |
| `kilo` | Kilo Code 7.x | `$KILO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kilo` | exists |
| **`opencode-v2`** | **opencode 2.x** | **`~/.config/opencode` (shared with `opencode`)** | **this plan** |

### 1.4 Current state (the port surface)

Pure libraries to **reuse unchanged** (they contain no host API):

| File | Lines | Role |
|---|---|---|
| `src/shared.ts` | 863 | snapshot shaping, display-mode, provider resolution, countdown |
| `src/helpers.ts` | 323 | shared predicates, band decisions, display-mode parsing |
| `src/tui-helpers.ts` | 473 | plan meters, model weights, display formatters, token rows |
| `src/server-helpers.ts` | 178 | server line formatting, auth/cookie boundary, redirect policy |

Entry modules to **replace with v2 equivalents**:

| File | Lines | v1 shape | v2 shape |
|---|---|---|---|
| `src/index.ts` | 593 | `export default { id, server }`; `tool({ args, execute })` | `Plugin.define({ id, setup })`; `ctx.tool.transform(ed => ed.add(...))` |
| `src/tui.tsx` | 483 | `{ id, tui }`; `api.slots.register({ slots: { sidebar_content, session_prompt_right } })` | `Plugin.define({ id, setup })`; `context.ui.slot({ append: "sidebar.content" })` |
| `src/tui.kilo.tsx` | 962 | Kilo fork of the above | — (kilo has no v2) |
| `src/tui-shared.tsx` | 1049 | shared rendering, typed against v1's `TuiSlotContext`/`UsagePanelApi` | needs a v2 adapter or a v2-side copy (§2.4) |

Target wiring:

| File | What it holds today |
|---|---|
| `bin/cli-core.js` | `HOSTS = ["opencode", "kilo"]`; `--target opencode\|kilo\|all`; the init prompt, the flag table, `parseTargetList`, `planTargets` |
| `bin/lib.js` | `HOST_LAYOUTS` per host (server/tui file names, relative specs, `serverConfigFile`, `tuiOptions`); `hostDirFromArgv`; `pluginSpec`; `linkPluginFiles` |
| `scripts/build-plugins.mjs` | 4 esbuild bundles; host baked in via a define; `assertSingleDefaultExport` |
| `scripts/verify-bundles.mjs` | asserts 4 bundles exist, are self-contained, default-export-only |
| `scripts/check-peer-ranges.mjs` | `OPTIONAL_UI_PEERS`, `CARET_PEERS` — the static npm-resolvability guard |
| `Dockerfile` | `ARG OPENCODE_VERSION=1.19.0`, `ARG KILO_VERSION=7.8.12`; installs both CLIs |
| `compose.yml` | the authoritative gate command |

### 1.5 The v2 API surface we will build against (source-verified)

All of the following is quoted from `anomalyco/opencode@dev` and the official v2 docs; full quotes live in `v2-recon-upstream.md` / `v2-recon-docs.md`.

**Plugin definition — server** (`packages/plugin/src/promise/plugin.ts`):

```ts
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export function define(plugin: Plugin) { return plugin }
```

**Plugin definition — CLI/TUI** (`packages/plugin/src/tui/plugin.ts`): same `{ id, setup }` shape, different `Context`.

**Imports:** `@opencode/plugin` (server) and `@opencode/plugin/tui` (CLI). Confirmed from `packages/plugin/package.json` `exports` (`"." → ./src/promise/index.ts`, `"./tui" → ./src/tui/index.ts`).

**The slot tree — the complete union** (`packages/plugin/src/tui/context.ts`):

```ts
export interface SlotMap {
  readonly app: Readonly<Record<string, never>>
  readonly "home.footer": Readonly<Record<string, never>>
  readonly "home.footer.status": Readonly<Record<string, never>>
  readonly "prompt.footer": PromptFooterInput
  readonly "prompt.footer.status": PromptFooterInput
  readonly "prompt.footer.file": PromptFooterInput
  readonly "session.composer.top": { readonly sessionID: string }
  readonly "session.panel": PanelInput
  readonly "sidebar.content": { readonly sessionID: string }
  readonly "sidebar.footer": { readonly sessionID: string }
}
export type SlotPath = keyof SlotMap
```

```ts
  /** Claims a place in the slot tree; see SlotClaim. */
  readonly slot: (claim: SlotClaim) => () => void
```

Mapping onto what we render today:

| v1 (ours) | v2 | Input we receive |
|---|---|---|
| `slots.sidebar_content` (`props.session_id`) | `context.ui.slot({ append: "sidebar.content", render })` | `{ sessionID }` |
| `slots.session_prompt_right` (`props.session_id`) | `context.ui.slot({ append: "prompt.footer.status", render })` | `{ sessionID?, mode, showDetails }` |

Two v2 behaviours we must design around, both quoted verbatim from the source:

> *"At the same target the last-enabled claim wins; an ancestor replacement beats a descendant one regardless of enable order."*

> *"A claim aimed at a path the host no longer publishes degrades: additive claims append to the nearest surviving ancestor, replacements are suppressed."*

**Tool registration** (`packages/plugin/src/promise/tool.ts`): `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, execute }))`. The migration guide's before/after:

```ts
// V1
tool: { greeting: tool({ description, args: { name: tool.schema.string() }, async execute(args) { ... } }) }

// V2
await ctx.tool.transform((editor) => {
  editor.add({
    name: "greeting", description,
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    async execute(input) { return { content: `Hello ${(input as { name: string }).name}!` } },
  })
})
```

**Data available to the TUI plugin** (`packages/plugin/src/tui/context.ts`): `data.session.get(sessionID)` → `SessionInfo` (carries `cost: MoneyUSD`, `tokens: TokenUsageInfo`, `model?: ModelRef`); `data.session.cost(sessionID): number`; `data.session.message.list(sessionID)` → `SessionMessageInfo[]`, whose `SessionMessageAssistant` variant carries `model: ModelRef`, `cost?: MoneyUSD`, `tokens?: TokenUsageInfo`.

**Critical for the Models table:** there is **no per-model breakdown API**. The upstream researcher's finding, and it matches v1's situation exactly:

> *"No direct per-model breakdown API exists in the TUI data layer; per-model accounting must be derived from message.list() filtering by model field"*

That is the same fold-over-the-message-store shape `src/tui.kilo.tsx` already implements, so `tui-helpers.ts`'s weighting logic is reusable.

---

## 2. Architecture Decision

### 2.1 Target identity

`opencode-v2` becomes a third host in `HOSTS`, selectable as `--target opencode-v2`, with its own bundles and its own install layout. This is what the brief asks for and it matches the existing per-host pattern (kilo is already a second target with distinct filenames).

### 2.2 Distinct bundle filenames, mandatory

The v2 bundles get their own names so a v1 install and a v2 install in the shared config dir cannot clobber each other:

| Kind | v1 | Kilo | **v2** |
|---|---|---|---|
| server | `oc-go-usage-display.ts` | `oc-go-usage-display.kilo.ts` | **`oc-go-usage-display.v2.ts`** |
| tui | `oc-go-usage-display.tsx` | `oc-go-usage-display.kilo.tsx` | **`oc-go-usage-display.v2.tui.ts`** |

**The v2 TUI bundle is `.ts`, not `.tsx`, and that is measured, not stylistic.** v2's discovery covers *"direct .ts and .js files"*; a `.tsx` file in the discovery directory is **not loaded and reports no error at all** (§9-0h) — a silent failure. It needs its own name rather than `.v2.tsx` because both halves live in the same auto-discovered directory and would otherwise collide.

**A consequence to resolve in Phase 0.4:** both files sit in one auto-discovered directory, so the CLI reconciler will also see the server bundle and the server may see the TUI bundle. Whether that is tolerated or needs mitigation is unmeasured — and it is the same class of hazard that review round 2 raised about the v1 bundles.

### 2.3 The shared-config-dir problem — revised after review round 1

`opencode` and `opencode-v2` resolve to the **same directory** (`~/.config/opencode`). The first review round caught that the original decision here — making the two targets wholly mutually exclusive — was over-engineered, and pointed at the docs, which say it twice:

> *"Local plugins under `.opencode/plugins/` are loaded automatically without a config entry."*

> *"OpenCode also loads direct .ts and .js files and immediate plugin package directories from every discovered `.opencode/plugins/` directory. … Global plugins use the same discovery layout under the OpenCode config directory: `~/.config/opencode/plugins/`"*

So v2 **auto-discovers** a plugin file placed in `<config>/plugins/` with **no config entry at all**. If that holds for our bundles (Phase 0.0), the install strategy inverts: the v2 target writes **no** `plugins` entry, and the only remaining problem is a **stale v1 `plugin` entry pointing at a v1 bundle**, which v2 would load and fail.

**Decision (narrowed): the v2 install must leave no config entry referencing a bundle the host cannot run.** Concretely:

1. If Phase 0.0 confirms auto-discovery, the v2 target installs by **file placement alone** and writes no plugin entry.
2. The v1 `plugin` entry for our plugin is **removed** when the v2 target installs into that directory, and restored by the v1 target. That is the removal of *our own stale entry*, not a wholesale mutual exclusion of two hosts.
3. Whatever entry the TUI/CLI half turns out to need (Phase 0.2) is subject to the same rule.

This is narrower than the original decision and strictly better: a user with both hosts installed keeps a working v1 config unless they install *our plugin* for v2 into the same directory.

**Residual question for the next round:** if v2 auto-loads everything in `<config>/plugins/`, does a **v1** opencode reading the same directory also try to load our `.v2.ts` bundle? v1 loads only what its config names, so the expectation is no — but that is an assumption, not a measurement, and it belongs in Phase 0.


### 2.4 Reuse boundary

- **Reused unchanged:** `src/shared.ts`, `src/helpers.ts`, `src/tui-helpers.ts`, `src/server-helpers.ts`.
- **New, thin:** `src/v2/index.ts` (server: register the `go_usage` tool, reuse `getUsageSnapshot`/`formatServerLine`), `src/v2/tui.tsx` (CLI: claim the two slots, render).
- **`src/tui-shared.tsx` is the open question.** It is typed against v1's `TuiSlotContext`/`UsagePanelApi`. Phase 0.8 decides between (a) a thin v2 adapter that satisfies the existing props, or (b) extracting the presentational parts into a host-neutral module both entries consume.

**Decision rule, so the spike cannot dodge the question** (added after review round 1 pointed out that "decide it by experiment" is not a plan):

- Take **(a)** if the adapter needs **at most 2 shims** and **no cast at the host-type boundary**.
- Take **(b)** otherwise. Its scope is bounded and known: extract the sidebar block, the statusline line and the meter rendering into a host-neutral module taking plain props, leaving `src/tui.tsx`, `src/tui.kilo.tsx` and `src/v2/tui.tsx` as thin adapters. That touches one 1049-line file plus three entries, and it is the correct shape regardless — v2 is the third consumer of this rendering, which is the point at which an abstraction earns itself.
- **Contingency if both stall:** ship v2 with a reduced surface (statusline only) and record it as a known gap in §7, rather than blocking the target on a refactor. Do not silently drop the sidebar.

### 2.5 What NOT to install or add

- **No `@opencode/plugin` dependency in the published package's runtime deps** — it is a peer the host provides, exactly as `@opencode-ai/plugin` is today.
- **No bundling of `@opentui/*` or `solid-js` into the v2 bundle** — they stay external so the host's own copies resolve.
- **No v2 support in the Kilo bundles** — Kilo has no v2.
- **No `effect`-flavoured plugin API** — the Promise API is the documented primary one; the Effect entrypoint is out of scope.

---

## 3. Step-by-Step Plan

### Phase 0 — Spike: resolve the three unknowns (BLOCKING)

Every step here runs against **`ghcr.io/anomalyco/opencode:2.0.29` in Docker**, never the host binary. Output: facts, recorded in this plan, plus the file bodies §7 lists.

| # | Experiment | Pass condition | If it fails |
|---|---|---|---|
| **0.0** | **Auto-discovery, first because it decides the install strategy.** Drop a trivial plugin file into `<config>/plugins/` with **no config entry** and see whether v2 loads it | it loads | fall back to explicit `plugins` entries |
| 0.1 | Boot the v2 image; `opencode --version`; `opencode plugin list` | reports 2.0.29 and runs | pin a different tag |
| 0.2 | **The TUI/CLI half's loading mechanism** — the one part 0.0 may not cover. Try, in order: (i) auto-discovery of the file, (ii) a `cli.json` `plugins` entry pointing at it, (iii) a plugin **package directory** with a `package.json` exposing `./tui` | the slot renders | adopt the first mechanism that works; §4-R2 |
| 0.3 | Claim `sidebar.content` with a `<text>HELLO</text>` and boot the TUI **in tmux**, `capture-pane` | `HELLO` appears in the captured pane | the e2e harness needs a different capture path → §4-R3 |
| 0.4 | Register `go_usage` via `ctx.tool.transform` and invoke it | tool returns our line + JSON | the tool contract differs from the docs |
| 0.5 | Log the **resolved runtime versions** of `@opentui/solid`, `@opentui/core`, `solid-js` from inside the plugin, and record the emitted external import specifiers our bundle needs | we learn what the host actually provides, and whether our import specifiers exist in it | §4-R1 |
| 0.6 | **Data layer** (review round 1): call `data.session.get(id)`, `data.session.cost(id)` and `data.session.message.list(id)` from inside the plugin against a real session, and confirm the shapes the plan assumes (`cost`, `tokens`, `model` on the assistant variant) | shapes match `SessionInfo`/`SessionMessageAssistant` as quoted | the per-model table needs a different source |
| 0.7 | **Slot inputs and cleanup** (review round 1): log the actual input object each slot receives, and confirm the unsubscribe returned by `context.ui.slot(...)` really removes the claim | inputs match `SlotMap`; the claim disappears on unload | our render props are wrong, or slots leak on unload |
| 0.8 | Try approach (a) from §2.4: render the real sidebar block from `tui-shared.tsx` through a thin adapter | it typechecks and renders | adopt (b) — see §2.4's decision rule |

**0.0 and 0.2 decide the install strategy, 0.5 resolves the dependency conflict, and 0.3 decides whether the display tier is real.** Nothing else starts until these are answered.

### Phase 1 — Target wiring (survives any Phase 0 answer)

1. `bin/cli-core.js`: `HOSTS = ["opencode", "kilo", "opencode-v2"]`; extend `parseTargetList` and the `--target` help text to `opencode|opencode-v2|kilo|all`; extend the init prompt's host list.
2. `bin/lib.js`: add the `opencode-v2` entry to `HOST_LAYOUTS` (file names from §2.2, `serverConfigFile: "opencode.jsonc"`, and a `tuiConfigFile: "cli.json"` — v1 uses `tui.json`); route `hostDirFromArgv("opencode-v2")` to the opencode resolver; teach `pluginSpec` the v2 spec shape (`plugins: [...]`, object form for options).
3. Implement §2.3's mutual exclusion in the install path, with a unit test that pins it.
4. `scripts/build-plugins.mjs`: two new esbuild entries (`src/v2/index.ts` → `dist/plugins/oc-go-usage-display.v2.ts`, `src/v2/tui.tsx` → `dist/plugins/oc-go-usage-display.v2.tsx`), keeping `@opencode/plugin`, `@opencode/plugin/tui`, `solid-js`, `@opentui/*` external.
5. `scripts/verify-bundles.mjs`: 4 bundles → **6**, with the v2 banners.

### Phase 2 — Dependencies

1. Resolve §4-R1 per Phase 0.5 (peer range + devDependency strategy for `@opentui/*`).
2. Add the `@opencode/plugin` peer (optional, caret) and extend `check-peer-ranges.mjs`'s tables so the new peer is statically guarded — the exact gap the last adversarial review caught for `@opentui/keymap`.
3. Regenerate `bun.lock`; `verify-tarball-install` must still pass (the npm path is what broke `main` last time).

### Phase 3 — Container test tier

1. `Dockerfile`: `ARG OPENCODE_V2_VERSION=2.0.29`, installing v2 **from the ghcr image** rather than `bun add -g` (v2 is distributed as a binary/image, not just an npm wrapper — verify in Phase 0.1 which mechanism works in our image).
2. `compose.yml`: keep the authoritative command; add the v2 binary to the loud version check so the v2 tier can never silently skip.
3. e2e: a `test/e2e/tui-display.v2.test.js` mirroring the v1 display assertions (sidebar block present, statusline present, plan rows, model section), on the tmux harness Phase 0.3 validates.
4. Load check: `opencode serve` + assert `go_usage` is registered (mirrors `test/e2e/opencode-load.test.js`).
5. Integration: the v2 config writer (plugins key, cli.json) and the mutual-exclusion rule.

### Phase 4 — Out of scope (recorded, not built)

- Effect-flavoured plugin entrypoint.
- v2 `session.panel` (a full session panel view) — a natural follow-up, not needed for parity.
- v2 `keymap.layer` slash/palette commands — v1 registers toggles; v2 parity can follow, but the toggle surfaces are the acceptance bar.
- Migrating the Kilo target to anything.

---

## 4. Risk & Mitigation

Every mitigation below states whether it has been **exercised** or is **untested**, because an untested mitigation is an open question wearing a resolved one's clothes.

| # | Risk | Mitigation | Exercised? |
|---|---|---|---|
| **R1** | **`@opentui/*` conflict.** v2 peers need `>=0.5.17`; we pin exactly `0.5.11` on purpose. One top-level devDependency cannot satisfy both. The real hazard is **not the types but the emitted external import specifier**: esbuild resolves the JSX runtime at build time, so bumping the build-time version can change what the v1 bundle emits, and that specifier must exist in the host's `0.5.11` at runtime. | Phase 0.5 records what each host actually provides **and** the specifiers our bundle emits. Then widen the peer to a range covering both and build against the newer version — the **v1 and Kilo e2e display tests boot the real hosts and assert the rendered sidebar and statusline**, so a specifier that does not resolve on 0.5.11 fails the container gate. If the emitted specifier does change, the fallback is a second devDependency alias for the v2 sources only. | **Untested.** Exercised by running the existing container gate unchanged after the bump. Note the limit honestly: the gate covers the API surface **our renderers actually call** — it cannot prove the absence of a mismatch in a code path we never execute. |
| **R2** | **`cli.json` may not accept local paths** — the docs configure CLI plugins as packages. Our whole install model is local files. | Fallback path exists in the v2 docs and is quoted in §1.5: v2 "loads direct .ts and .js files and **immediate plugin package directories** from every discovered `.opencode/plugins/` directory", and a package's `./tui` export is loaded automatically. So the fallback is to install a small package directory (`<config>/plugins/oc-go-usage-display-v2/` with its own `package.json` exposing `./tui`) instead of a bare file. | **Untested** — this is exactly what Phase 0.2 measures. The fallback changes the install layout, not the plugin code. |
| **R3** | **The v2 TUI may not render a capturable pane** under our tmux harness, which would gut the e2e tier. | Phase 0.3 boots the TUI in tmux and greps `capture-pane` for a literal marker. If it fails: try `--standalone`; if it still fails, the v2 tier ships **load-level** assertions only (plugin registers, tool registers, config accepted) and the plan says so out loud rather than implying display coverage we do not have. | **Untested** — Phase 0.3. |
| **R4** | **Shared config dir.** `opencode` and `opencode-v2` write the same directory; a stray v1 `plugin` entry makes v2 load a v1 bundle that cannot run. | §2.3 (narrowed after review round 1): the v2 install removes **our own** stale v1 `plugin` entry for that directory, and writes no v2 entry at all if Phase 0.0 confirms auto-discovery. Pinned by a unit test. | **Untested** — Phase 1.3. Also carries §2.3's residual question: whether a **v1** host reading the same `plugins/` directory would try to load our `.v2.ts` bundle (expected no, because v1 loads only what its config names — but unmeasured). |
| **R5** | **v2's client/server split** (background service, `--standalone`) differs from v1's `opencode serve`. Our harness's session-creation flow may not carry over. | Phase 0.1/0.3 establish the invocation that works; the harness change is confined to `test/helpers/`. | **Untested** — Phase 0. |
| **R6** | **v2 moves fast** (2.0.29 today). An unpinned v2 breaks the gate without a commit. | Pin `OPENCODE_V2_VERSION` in the Dockerfile, exactly as v1 and Kilo are pinned, and move it in lockstep with the `@opencode/plugin` peer via the existing `bump-deps` mechanism. | **Pattern already exercised** for v1/Kilo; new only in that v2 installs from an image. |

**Two risks carry an untested mitigation and both are Phase 0's job.** If Phase 0 answers them, R1 and R2/R3 collapse; if it does not, this plan is not implementable as written and Phase 0's findings become the new plan.

---

## 5. API Reference (v2, source-verified)

**Definition**

```ts
// server — @opencode/plugin
export interface Plugin { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void }
// CLI — @opencode/plugin/tui
export interface Definition { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void }
```

**Slots** — `readonly slot: (claim: SlotClaim) => () => void` (returns an unsubscribe; v1's had none).

Placements, exactly one per claim (mutually exclusive in the types): `prepend`, `append`, `before`, `after`, `replace`. At one target the **last-enabled claim wins**; an ancestor `replace` beats a descendant one. An unknown path **degrades** — additive claims fall back to the nearest surviving ancestor, replacements are suppressed.

Our two claims and their inputs:

| Slot | Input |
|---|---|
| `sidebar.content` | `{ readonly sessionID: string }` |
| `prompt.footer.status` | `{ readonly sessionID?: string; readonly mode: "normal" \| "shell"; readonly showDetails: boolean }` |

**Tool** — `ctx.tool.transform((editor: ToolEditor) => void)`; `editor.add(tool)`, `editor.update(id, fn)`, `editor.remove(id)`. The tool's `input` is **JSON Schema**, and `execute(input, context)` returns `Tool.Result`.

**Data** (TUI) — `data.session.get(id): SessionInfo | undefined`; `data.session.cost(id): number`; `data.session.message.list(id): SessionMessageInfo[]`. `SessionInfo` carries `cost: MoneyUSD` and `tokens: TokenUsageInfo`; the assistant message variant carries `model: ModelRef`, `cost?`, `tokens?`. **No per-model aggregate exists** — fold `message.list()`.

**Events** — `context.data.on(type, cb)` / `data.listen(cb)` (TUI); `ctx.event.subscribe({ signal })` (server, async iterable).

**Other context we may use** — `context.storage.store/memory`, `context.ui.toast`, `context.ui.dialog.*`, `context.ui.router`, `context.theme`, `context.keymap.layer`, `context.app.version`, `context.location`.

**Packaging** — `package.json` `exports: { ".": ..., "./tui": ... }`; deps `@opencode/plugin`; peers `@opentui/core >=0.5.17`, `@opentui/solid >=0.5.17`, `solid-js >=1.9.0`.

---

## 6. Anti-Patterns to Avoid

- **Do not make one bundle serve v1 and v2.** v2 documents a dual shape (`{...Plugin.define(...), async server(){...}}`), and it is a trap here: it couples two APIs in one artifact and defeats the per-host bundle model this repo is built on. Two targets, two bundles.
- **Do not write both `plugin` and `plugins` into one config file.** v2 normalizes v1 fields, so the stale entry is not inert — it is loaded and fails.
- **Do not invent a second config directory.** v2 reads v1's locations; a directory v2 does not read is a silent no-op install.
- **Do not bundle `@opentui/*` or `solid-js` into the v2 bundle.** They are host-provided peers; bundling a second copy produces two reactive runtimes.
- **Do not re-implement the usage fetch or shaping in `src/v2/`.** `getUsageSnapshot`, `formatServerLine`, the snapshot shapes and the meter math already exist; the v2 entries must be thin adapters or the two implementations will drift.
- **Do not let the v2 tier skip silently.** The repo's rule is a loud version check so a missing binary fails the gate rather than reducing coverage quietly.
- **Do not trust the docs where they are silent.** `cli.json`'s acceptance of local paths is undocumented; measure it (Phase 0.2) instead of assuming either way.
- **Do not re-derive the per-model table differently from v1.** Both fold the host's message store; `tui-helpers.ts` already owns that math.

---

## 7. Acceptance Criteria

The work is done when, **all measured in Docker against the pinned v2 image**:

1. `oc-go-usage-display-init --target opencode-v2` installs into the shared config dir, writes the v2-shaped entries (`plugins`, `cli.json`), and removes a conflicting v1 entry for the same plugin (§2.3), with a unit test pinning the exclusion.
2. The plugin is **loaded** by the v2 host and observable. `opencode plugin list` lists only *package* plugins (measured, §9-0e), so it is **not** a valid check for a locally installed bundle: the acceptance signal must be a behaviour the host visibly performs — the rendered slot, or the tool's output.
3. The **real v2 TUI**, booted in tmux in the container, renders the Go Usage **sidebar block** and the **statusline** — evidenced by a captured pane, not by an assertion that could pass vacuously.
4. The `go_usage` tool is registered and returns our formatted line plus the JSON snapshot.
5. `docker compose run --rm --build test` is green and **covers v2**; a missing v2 binary fails the gate loudly.
6. **Data layer verified, not assumed** (review round 1): `data.session.get`, `data.session.cost` and `data.session.message.list` return the shapes the per-model table needs, asserted against a real session — so the Models section is not built on a guess.
7. **Slot inputs and cleanup verified** (review round 1): each slot's input object matches `SlotMap`, and the unsubscribe returned by `context.ui.slot(...)` **actually removes the claim on unload** — a slot that cannot be disposed leaks on every plugin reload.
8. The v1 (`opencode`) and `kilo` tiers are **unchanged and green** — no regression, which is also R1's falsifier.
9. `verify-bundles` asserts **6** self-contained, default-export-only bundles; `check-peer-ranges` statically guards the new peer.
10. `verify-tarball-install` still passes — the npm install path that broke `main` before.
11. **Phase 0 has produced these file bodies, which are then written into this plan verbatim** before Phases 1–4 are implemented:
   - `src/v2/index.ts` (full body)
   - `src/v2/tui.tsx` (full body)
   - the `opencode-v2` entry in `HOST_LAYOUTS` (full body)
   - the v2 install writer — **shape depends on Phase 0.0/0.2** (file placement, or a `cli.json` entry, or a package directory)
   - the two new `build-plugins.mjs` entries (full body)
   - `test/e2e/tui-display.v2.test.js` (full body)
   - the resolved `package.json` dependency/peer block (full body)

**Gated steps (the agent cannot self-approve):** the plan's review (§ below), and any `git push` or PR — commits and pushes each need the user's explicit permission, and `main` additionally requires an approving review the ruleset will not let the author give.

---

## 9. Phase 0 log — findings as they land

Recorded so nothing here is re-derived. Every row is a **measurement**, not a reading, and the first row is a void result that must not be re-trusted.

| # | Measurement | Result | Consequence |
|---|---|---|---|
| 0a | v2 image pulls; `opencode --version` | **2.0.29**, works | Docker gate can pin `ghcr.io/anomalyco/opencode:2.0.29` |
| 0b | v2 image contents | Alpine 3.24.2; one 211 MB **musl** binary; **no tmux, node, bun, bash, python3, git** | the e2e harness must add tmux; our debian test image cannot run the binary as-is |
| 0c | musl binary copied into our debian image, after `apt-get install musl` | `Error loading shared library libstdc++.so.6: No such file or directory` | the Dockerfile needs musl **and** a C++ runtime, or a different install path — Phase 2 work, not a blocker |
| 0d | **Auto-discovery from `<config>/plugins/` with no config entry, driven through `opencode serve`** | **first run reported LOADED; every later run — including an exact re-run of the first probe — reported NOT LOADED. NOT REPRODUCIBLE.** | **the observation is void.** Against `serve`, v2 neither loads nor errors on such a file. No install strategy may rest on it; it must be re-measured against the **TUI** |
| 0e | `opencode plugin list` with a plugin file present in `<config>/plugins/` | **"No plugins found"** | `plugin list` lists *package* plugins only. It is **not** a valid acceptance check for a locally installed bundle — acceptance criterion 2 is re-based below |
| 0f | v2 TUI under tmux, spike image (`FROM ghcr.io/anomalyco/opencode:2.0.29` + `apk add tmux`) | **runs and is capturable**: logo, prompt box, model line and status line all render into `capture-pane` | **the display tier is real.** Phase 0.3's harness question is answered: tmux capture works against v2 |
| 0g | Auto-discovery from `<config>/plugins/`, driven through the **TUI** (not `serve`) | **`.js` and `.ts` bare files ARE discovered, `@opencode/plugin/tui` resolves with no `node_modules`, and `setup()` RUNS** — reproduced across two independent runs | **auto-discovery confirmed for the CLI half.** The install can place a bare file with no config entry |
| 0h | Same directory, a **`.tsx`** file | **NOT discovered, and no error is reported** — the plugin count is unchanged and nothing appears in the pane | **a silent failure mode.** The v2 TUI bundle must be **`.ts`**, never `.tsx` — which changes the bundle naming in §2.2 |
| 0i | JSX inside a discovered `.js` file | the TUI status line reports **`⊙ 1 plugin failed /plugins`** | discovered files are **not JSX-transformed**. Our v2 bundles must ship **pre-compiled JSX** — which the existing esbuild pipeline already produces |
| 0j | `opencode serve` vs the TUI, same plugin file | `serve` did not load it (0d); the TUI did (0g) | the **server** half may still need an explicit `plugins` entry; the CLI half does not. Phase 0.4 must settle the server side separately |
| 0k | **Can a v2 host plugin import `solid-js` / `@opentui/solid` at all?** Tested seven ways: bare `.ts`/`.js`, a package directory, a package declaring them as peers, side-effect imports of four specifiers, the **server** loader, and `plugin add` (npm/Git only — refuses local paths). | **NO, in every form.** `@opencode/plugin/tui` resolves; `solid-js` and `@opentui/solid/jsx-runtime` never do. The binary *contains* them (an internal module map exists) but does not expose them to plugins. | **the single biggest constraint found.** Our TUI bundles import both, so a bare-file TUI plugin cannot load |
| 0l | **Bundle them in instead** (esbuild, everything external except `@opencode/plugin/tui`) | the bundle **loads and `setup()` runs** — but the pane then reports **`⊙ 1 plugin failed /plugins`** and nothing renders. A **no-slot** bundle of the same shape loads **cleanly** (no failure message) | bundling gets the plugin *in*; the **slot claim is what fails**, not the bundling itself. The host's slot system and a second copy of `solid-js` do not coexist |
| 0m | `@opentui/solid/jsx-runtime` left **external** in a bundle | fails to load (same as 0k) | confirms 0k: it is not resolvable either way |

| 0n | **Re-research: the loader source** (`packages/plugin/src/runtime-modules.ts`, `source.bun.ts`) | `runtimePackages = ["effect", "@opencode/plugin"]` — the host provides **only** those to plugins. Every other bare import goes through `Bun.resolveSync(specifier, dirname(pluginFile))`, i.e. real node resolution from the plugin file's directory. | the mechanism is now **understood**, not guessed: a plugin gets `solid-js` only from a `node_modules` reachable from its own file |
| 0o | Package dir with `node_modules` (copied in, not mounted), bare `solid-js` import | still **fails** | `Bun.resolveSync` from the plugin dir does not find it in the container — so option (b)'s "publish as npm package" does **not** by itself fix the import |
| 0p | Re-run of the two shapes that had appeared to work, side by side | control (no external imports) → **RAN**; the "relative import" one → **not run**. The earlier apparent success was esbuild **inlining** the relative import (bundling), not a true external-relative resolution | the only shape that loads is **bundled**, and that is exactly the shape whose slot claims fail (0l) |
| 0q | **v2 server auth** — `packages/server/src/auth.ts` | `authorized()` requires `username === "opencode"` and the server password (or a signed session token). Credentials are `DecodedCredentials { username, password }` — i.e. **HTTP Basic**. | auth is **HTTP Basic**; Bearer, custom headers and cookies are all wrong |
| 0r | Basic auth against a live `serve` | `Authorization: Basic base64("opencode:PASSWORD")` → **200**; wrong username → **401**; no auth → **401** | the harness can authenticate; the password is parsed from `serve` stderr |
| 0s | **v2 plugin inventory route** — `packages/protocol/src/groups/plugin.ts` | `GET /api/plugin` → `{ location, data: Plugin.Info[] }`. There is **no tool-list route** (`/api/tool/list` is 404) | acceptance must read the **plugin inventory**, not a tool list |
| 0t | `Plugin.Info` shape — `packages/schema/src/plugin.ts` | `{ id?, source: {type:"builtin"\|"package"\|"local"\|"sdk", ...}, features: {server?,tui?,rpc?}, state: {status:"active"} \| {status:"failed", error} }` | a plugin that throws in `setup()` is **visible** as `state.status === "failed"` with its error — the real acceptance signal |
| 0w | **Does `features.server` ever get set?** — `packages/core/src/plugin/module.ts:137` | `features` is built from `entrypoints` and contains **only `tui` and `rpc`** — `server` is never added, even for a server plugin | `features.server` must **not** be asserted; `state.status === "active"` is the acceptance signal. A local server-only file yields `features: {}` |
| 0x | **Relative `./plugins/...` config spec for v2** — `packages/core/src/plugin/module.ts` | `local = path.isAbsolute(operation.target)`. A relative spec is **not** absolute, so it is resolved via `Host.resolve({directory})` looking for `server`/`tui`/`rpc` subpaths — which a single file has none of. **No entrypoint, plugin never loads.** | v2 config entries must be **absolute paths**, like Kilo's. `pluginSpec` returns an absolute path for `kilo` and `opencode-v2`; v1 keeps the relative spec (v1 resolves `./...` against its config dir) |
| 0u | **`Plugin.define` / `ctx.tool.transform`** — `packages/plugin/src/promise/plugin.ts`, `promise/tool.ts` | `Plugin.define({ id, setup })` is correct; `ToolDomain` has `transform(editor)`, `list()`, `reload()`, `hook()`. `ToolEditor.add({name, description, input, execute})` with `execute` returning a **Promise**. `Tool.Result = { output?, content?: string \| Content[], metadata? }` | the v2 entry's API usage is **correct as written** |
| 0v | **v2 config key** — `packages/schema/src/config/plugin.ts` | the key is **`plugins`** (array of `string \| { package, options? }`). There is **no `plugin` key**. | **bug found**: the installer wrote v1's `plugin` key for v2, which v2 silently ignores — the plugin never loaded. Fixed in `bin/lib.js` via a per-host `serverConfigKey` |

**Consequence — the v2 TUI slot surface is BLOCKED for a Solid-based plugin, measured rather than inferred.** The server half works (0.4): `go_usage` registers. The display half does not, and no combination of import style, packaging, or bundling makes a slot claim survive. This is a scope decision for the operator, not something to engineer around silently: the options are (a) ship v2 with the **tool only** and no sidebar/statusline, (b) publish the plugin as an npm package so `plugin add` installs a real `node_modules` and retry the slot system against that, or (c) drop the v2 target. Option (b) is the only one that could restore the display surface, and it changes the install model from file placement to registry packaging.

**Two consequences the plan already absorbs:** §0 question 1 is now the *TUI* half, not `serve`; and acceptance criterion 2 no longer leans on `plugin list`.

---

## 8. Review plan

Per the brief, the plan and the implementation each go to a rotating adversarial reviewer, using models from the standing free chains: `opencode-free`/`opencode-zen` `space-bunny-free`, `opencode-go` `step-5-preview-free`, and `kilocode` `nemotron-3-ultra-free`. Each round uses a different model from the previous round, and the reviewer is told which tree and which commit it is reviewing, with the raw evidence paths.

