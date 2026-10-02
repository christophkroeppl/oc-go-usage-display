# AGENTS.md

Every commit must use Conventional Commits: `type(scope): subject` (imperative,
lowercase, no trailing period). `scope` is required for `sidebar`, `statusline`,
`server`, `ci`, `docs`; `release` is reserved for release-please. See
[Versioning](#versioning-release-please) for what actually releases.

## Architecture

- **server** — `src/index.ts` -> `dist/index.js` / bundles `dist/plugins/oc-go-usage-display.ts` (opencode) and `dist/plugins/oc-go-usage-display.kilo.ts` (Kilo; same source, host baked in with an esbuild define). Registers only the `go_usage` tool.
- **tui** — `src/tui.tsx` -> `dist/tui.js` / bundle `dist/plugins/oc-go-usage-display.tsx` (opencode). `src/tui.kilo.tsx` -> `dist/tui.kilo.js` / bundle `dist/plugins/oc-go-usage-display.kilo.tsx` (Kilo). Additive `sidebar_content` + `session_prompt_right` slots only, never `single_winner`. Each entry keeps only what is host-specific: the slot order, Kilo's `sidebar_mode` + host-panel switch, and where per-session model usage comes from (opencode folds its own message store, Kilo calls `client.kilocode.sessionModelUsage`; both land in the same `SessionModelUsage` shape). Everything both hosts render lives in `src/tui-shared.tsx`.
- **reactive slots** — `@opentui/solid` calls a slot renderer exactly once per mount, so any condition read in a slot *body* (a provider gate, the collapse flag, the mode) is latched for the life of the band. Function children re-evaluate (`insertExpression`), plain values do not — and **`<Show when={...}>` is a plain value here**: these bundles are compiled by esbuild's automatic JSX rather than Solid's compiler, so `when` is evaluated once and never re-read. A region that can change after mount therefore has to be a memo AND returned as a function child (`reactiveChild`), which is what `KiloStatuslineSlot` does; putting the same gate in `<Show when={visible()}>` is what made the statusline fold persist its flag and leave the line on screen.
- **band ownership** (Kilo) — integrated mode registers in the host's own token-usage band and retires that panel, so the two are one decision: we are the only usage block in that band exactly while we are drawing in it. `ownsIntegratedBand` / `hostUsagePanelEnabled` / `sidebarBandRenders` in `src/helpers.ts` are the whole table, pure and shared by all three test tiers through `test/helpers/sidebar-matrix.js`. The integrated panel is a **fork** of Kilo's, not an extension — the band has no sub-slots and the slot registry is unreachable — so a non-Go session defers to Kilo's panel rather than losing the `Terminal Bench 2.0` section and the `Generation speed` row it cannot reproduce.
- **the session's provider** comes from the host's own message store (`providerIdFromMessages`), because that is the source which re-reads *and* the one the models table is a fold over: a provider in the store has rows to weight, a provider only named by `Session.model` has none. Kilo 7.8.1 had no `Session.model` and no model-switch event (so the store was the only reactive answer); 7.8.3 added both, and they stay fallbacks. The configured model is the last resort.
- **host roots** — every entry reads only its own host's stores: opencode `~/.config/opencode` + `$XDG_DATA_HOME/opencode`; Kilo `$KILO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kilo` + `$XDG_DATA_HOME/kilo`. Kilo's `tui.json` rejects `sidebar`/`statusline` options, and Kilo does not resolve `./...` against its config dir, so kilo install entries are absolute paths (opencode keeps `./plugins/...`).
- **shared** — `src/shared.ts`, `src/helpers.ts` and `src/tui-shared.tsx` are inlined into the bundles; `dist/plugins/*` have no relative imports. `bun run build` fails unless all four bundles are present, self-contained and default-export-only (`scripts/verify-bundles.mjs`); `scripts/verify-tarball.mjs` checks packed tarballs.
- Each entry module exports exactly one thing: the default `{ id, server | tui }` module. Extra exports are invoked by the loader as plugin factories and can crash startup. Importing never throws; factories and renders are fail-safe.
- Secrets are never logged; tests never touch the real `~/.config/opencode` or credentials. Details: `.agents/skills/plugin-contract`, `.agents/skills/testing-and-dev-install`.
- Install surfaces: `bin/` CLIs, package `exports` (`./server`, `./tui`, `./kilo-tui`), `install.sh`, `install-dev.sh`.
- README screenshots come from `scripts/capture-shots.mjs` (real hosts, real tmux, `OPENCODE_OC_GO_MOCK=1`); it reuses the e2e harness, so the shots cannot drift from what the display tests drive.

## Versioning (release-please)

- `feat` -> minor; `fix` (and visible `deps`/`revert`) -> patch; `BREAKING CHANGE`/`!` -> major.
- `chore`, `docs`, `ci`, `test`, `refactor`, `style`, `build`, `perf` -> no release on their own.
- `main` pushes maintain a `chore(main): release X.Y.Z` PR; merging it creates the tag + GitHub release, and then `publish` runs the gate and publishes to npm (OIDC, no token).
- `bump-deps.yml` (weekly, Mondays 12:30 UTC) runs `bun update` within the declared ranges, moves the Dockerfile host pins (`OPENCODE_VERSION`/`KILO_VERSION`) with `@opencode-ai/plugin`/`@kilocode/plugin`, and commits `deps:` only when the container gate passes on the bumped tree. Those four versions are deliberately in lockstep, so a host SDK bump without its pin must be treated as a bug; majors are never auto-bumped.
- **A host release does not need a hand-bump.** When `opencode` or `kilo` publishes something and the repo is behind, run `gh workflow run bump-deps.yml` and let it do the work. Editing `package.json`, `bun.lock` or the Dockerfile ARGs by hand reproduces what the workflow already does, minus the container gate it runs on the bumped tree — which is the part that makes the bump trustworthy. The weekly schedule is why this comes up: a host released on Tuesday is not picked up until the following Monday, and the fix is to trigger the workflow, not to edit the pins. The one thing that is still a manual job is a bump *outside* the declared range (a minor or major), because widening `^7.8.3` to `^7.9.0` is a code change — do that by hand, then let the workflow take it from there.
- Force a version with a `Release-As: X.Y.Z` footer on a commit merged to `main`. Never add `[skip ci]` to a release commit.
- `release-please-config.json` + `.release-please-manifest.json` drive it; `CHANGELOG.md` is generated. Remove `last-release-sha` after the first Release PR merges.

## CI

- `test.yml`: `unit` (typecheck + build + readonly tests) on push/PR/schedule; `container-e2e` (Docker: integration + e2e, real opencode/kilo TUI in tmux) on `main` pushes, the weekly schedule, and non-draft PRs — never on `develop` pushes or draft PRs.
- `dev-build.yml`: `develop` push -> `dev-tgz` artifact (90 days), consumed by `install-dev.sh`.
- `publish.yml`: `main` push -> `test` gate -> `release-please` -> OIDC npm publish when a Release PR just merged; release assets carry the tarball, the four plugin bundles and `SHA256SUMS`, and the registry tarball is re-verified after publish.

## Testing

- **unit** (host/CI, readonly): `bun run test:unit`, purity-checked — no fs writes, not even tmp, no child processes, no sockets. `bun run test` = build + unit.
- **integration + e2e** (Docker only): `bun run test:docker` (`docker compose run --rm --build test`). Never point these at the host config.
- The Kilo sidebar band is one shared decision table (`test/helpers/sidebar-matrix.js`): the unit tier pins it, the integration tier drives the host-panel switch per rung against a stub, the e2e boots the real TUI on the rungs only a pane can settle.
- Host-runnable tests redirect HOME/XDG/`OPENCODE_CONFIG_DIR` into temp dirs and force `OPENCODE_GO_MOCK=1`; container-only tests use the disposable container HOME (`OC_GO_TEST_CONTAINER=1`).
