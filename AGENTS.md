# AGENTS.md

AI and human contributors: every commit must use Conventional Commits.

Format: `type(scope?): subject` — see https://www.conventionalcommits.org/

## 1. Project commits

Format: `type(scope): subject`

- `type` is required — never commit without a `type` (never empty type).
- `scope` is required for `sidebar`, `statusline`, `server`, `ci`, `docs` changes. `release` scope is reserved for the pipeline (see Versioning).
- Scopes in use (non-exhaustive): `server`, `tui`, `sidebar`, `statusline`, `plugin`, `bin`, `test`, `ci`, `docs`, `release`.
- Keep subject imperative, lowercase, no trailing period.

Examples for this repo:

- `feat(sidebar): add weekly usage row`
- `fix(statusline): handle missing percent`
- `feat!: drop node 18 support`
- `fix(plugin): keep the loader contract on stray exports`
- `fix(bin): report stale copy installs as note without failing`
- `chore(ci): tighten test gate`
- `docs: clarify tui toggles`

A non-conventional message is ignored by the release tool: it never cuts a version and never appears in the changelog — so format correctly.

## 2. Architecture

Two targets, both derived from `src/`, both deployed as self-contained bundles:

- **server** — `src/index.ts` -> `dist/index.js` / bundle `dist/plugins/oc-go-usage-display.ts`. Registers only the `go_usage` tool (manual query, JSON + one-line summary); no TUI surface.
- **tui** — `src/tui.tsx` -> `dist/tui.js` / bundle `dist/plugins/oc-go-usage-display.tsx`. Registers additive `sidebar_content` + `session_prompt_right` multi-render slots, toggles, and 60s polling; never a `single_winner` slot.
- **shared** — `src/shared.ts` (auth.json, tolerant API payload parsing, snapshot builders) and `src/helpers.ts` (formatting, display-mode parsing, file config) are inlined into both bundles, so `dist/plugins/*` have no relative imports.

Install surfaces: the `bin/` CLIs (`oc-go-usage-display-{init,remove,show,status,update}`), the package `exports` (`./server`, `./tui`), `install.sh` (checkout install), and `install-dev.sh` (CI dev-tarball install). See README for the user-facing flows.

Data flow: `OPENCODE_GO_MOCK=1` -> `OPENCODE_GO_API_KEY` -> `auth.json` -> workspaceId + authCookie (env or `oc-go-usage-display.json`) -> unavailable snapshot. API-key path uses `GET https://opencode.ai/zen/go/v1/usage` as Bearer; cookie path scrapes the workspace page. Snapshots cache 60s (memory + `oc-go-usage-display-cache.json`); failures never poison the cache and secrets are never logged.

Invariants (see `.opencode/skills/plugin-contract`):

- Each entry module exports exactly one thing: the default `{ id, server | tui }` module. Extra function exports are invoked by the loader as plugin factories and can crash startup.
- Importing an entry never throws; factories and slot renders are fail-safe, so OpenCode always starts.
- Tests never touch the developer's real `~/.config/opencode` or credentials (see `.opencode/skills/testing-and-dev-install`).

## 3. Versioning

Bump mapping (release-please parses Conventional Commits merged to `main`):

- `feat` -> minor
- `fix`, visible `deps`/`revert` -> patch
- `BREAKING CHANGE` in body or `!` after type/scope (e.g. `feat!:`) -> major
- `chore`, `docs`, `ci`, `test`, `refactor`, `style`, `build`, `perf` -> no release on their own; they ride along in the next release

How it works:

- `release-please-config.json` + `.release-please-manifest.json` drive release-please on every `main` push. It maintains a Release PR titled `chore(main): release X.Y.Z` containing the generated `CHANGELOG.md` entry and the `package.json` bump.
- Merging the Release PR is the only way the version increases: release-please creates the `vX.Y.Z` tag + GitHub release, and the `publish` job in the same workflow run (after the gate) publishes to npm.
- A `main` push containing only hidden types leaves everything untouched: no Release PR, no version, no publish. That is how docs/chore/CI changes land without a release — no skip trailer needed.
- Forcing a version: add a `Release-As: X.Y.Z` footer to a commit body merged to `main` (an empty `chore: release X.Y.Z` commit works). release-please pins the next Release PR to exactly that version. There is deliberately no manual bump/release dispatch path.
- `last-release-sha` in the config bounds the first scan to the `v1.1.0` commit; remove it once the first Release PR has merged.
- Release PRs contain only bot-generated `CHANGELOG.md` + `package.json` changes. They do not run `test.yml` (PRs created with the default `GITHUB_TOKEN` do not trigger workflows), but the `publish` run's gate rebuilds and retests the released SHA before npm.

## 4. CI

Three workflows:

- `test.yml` (`test`): runs on `push` + `pull_request` + weekly schedule (Mondays 06:00 UTC).
  - `unit`: always runs on Node 22 — `bun install`, `bun run check`, `bun run test` (build + READONLY unit tier). `OPENCODE_GO_API_KEY` is mapped at job level; the live usage shape test (`test/unit/live-usage.test.js`) runs when present and skips neutrally otherwise. Unit tests must never write to the host (enforced by `scripts/check-unit-purity.mjs`).
  - `container-e2e`: authoritative gate — `docker compose run --rm --build test` builds the root Dockerfile and runs `opencode --version && kilo --version && bun install && bun run build && bun run test:integration && bun run test:e2e` against the baked-in checkout (no bind mount, hermetic tmp HOME/XDG). Includes the real opencode/kilo TUI display checks (tmux). `OPENCODE_GO_API_KEY` is forwarded; the live TUI variants skip neutrally without it.
- `dev-build.yml` (`dev-build`): runs on `push` to `develop` + manual dispatch. `bun install`, `bun run check`, `bun run test` (build + unit), then `bun pm pack` uploads the `dev-tgz` artifact (90-day retention). `install-dev.sh` consumes it.
- `publish.yml` (`publish`): runs on `push` to `main` only — `test` gate -> `release-please` (updates/opens the Release PR) -> `publish` (OIDC provenance) when a Release PR was just merged. The gate runs the same containerized suite as `container-e2e`, rebuilding + retesting the exact ref being released.

What must pass:

- `test` must pass before `release-please` runs and before `publish`; `publish` is skipped unless release-please reported `release_created=true`.
- The release tag + GitHub release are created with the default `GITHUB_TOKEN`, which does not trigger another workflow run, so npm publish happens in the same run (after the gate) on the released SHA.

## 5. Testing

Two tiers:

- **unit** (host + CI, readonly): `bun run test:unit` runs `scripts/check-unit-purity.mjs` (no fs writes, not even tmp, no child processes, no sockets) and then `bun test test/unit/*.test.js`. Pure helper tests plus the live usage shape test (network read, skips without `OPENCODE_GO_API_KEY`). `bun run test` builds first (`dist/*` is what the unit tests import).
- **integration + e2e** (Docker only): `bun run test:docker` (`docker compose run --rm --build test`). Never point these at the host: integration drives the real bins/snapshot/pack flows, and e2e boots real `opencode`/`kilo` servers and TUIs.
- `test/e2e/{opencode,kilo}-load.test.js` are container-only (compose sets `OC_GO_TEST_CONTAINER=1`): inside the disposable container they write the plugin config to the real `~/.config/{opencode,kilo}` and assert `go_usage` registers. Outside they skip with a reason.
- `test/e2e/tui-display.{opencode,kilo}.test.js` boot the real TUI in tmux (200x50), render `OPENCODE_GO_MOCK=1` usage, and assert the sidebar (`Go Usage`, `5h 42% · resets 2h5m`) plus the statusline (`Go 5h 42% | 7d 15% | 30d 61%`) text. Live variants use `OPENCODE_GO_API_KEY`. Models are discovered at runtime from `<binary> models opencode-go` (never hardcoded); hosts older than the Dockerfile pins skip with a clear reason. These still run against a tmp HOME/XDG, so a host run cannot touch the real config.
- `docker compose run --rm --build test` is the isolation boundary and the authoritative gate; the devcontainer (`.devcontainer/`) uses the same image with a bind mount.
- Hermeticity rule: tests that can run on the host (unit, TUI display) must never point at the real config. `test/helpers/run.js` redirects HOME/XDG/`OPENCODE_CONFIG_DIR` into a tmp root, forces `OPENCODE_GO_MOCK=1`, and strips credentials. Container-only tests rely on the disposable container HOME instead.

## 6. Action publishing

- Branch pushes never publish. `publish.yml` runs only on `main` pushes: `test` gate, then `release-please`, then — only when a Release PR was just merged — `publish`. Each version publishes exactly once.
- `release-please` opens/updates the Release PR (requires the repo setting "Allow GitHub Actions to create and approve pull requests"). Only `feat`/`fix`/breaking (plus visible `deps`/`revert`) commits can open one; hidden types (`chore`, `docs`, `ci`, `test`, `refactor`, `style`, `build`, `perf`) cannot trigger a release.
- Merging the Release PR creates the `vX.Y.Z` tag + GitHub release; the `publish` job then attaches the `npm pack` tarball (`gh release upload --clobber`) and runs `npm publish --provenance --access public`.
- Auth: OIDC trusted publishing (`id-token: write`, `registry-url: https://registry.npmjs.org`, `always-auth: false`). No long-lived npm token. The npm step is idempotent (skips an already-published version); recovery is GitHub's "Re-run failed jobs" on the same run.
- Forced versions use the `Release-As: X.Y.Z` footer (see Versioning). There is no `[skip release]` trailer and no manual release dispatch.
- Never use `[skip ci]`: it suppresses the `publish` run, so a release could be tagged without ever publishing.
