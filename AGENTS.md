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

A non-conventional message defaults to patch and may mistrigger versioning — so format correctly.

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

Bump mapping (pipeline `version-bump` in `publish.yml` parses `git log <lastTag>..HEAD`):

- `feat` -> minor
- `fix`, `perf` -> patch
- `BREAKING CHANGE` in body or `!` after type/scope (e.g. `feat!:`) -> major
- `chore`, `docs`, `ci` (and anything else) -> patch

How it works:

- `LAST_TAG` is resolved via `git describe --tags --abbrev=0` (empty on first release).
- Range is `$LAST_TAG..HEAD`, or `HEAD` when no tag exists.
- The job dumps `git log "$RANGE" --pretty='%s%n%b'` and picks the highest bump: major beats minor beats patch.
- On a `main` push it then runs `npm version <bump> -m "chore(release): %s"`, which bumps `package.json` (+ lockfile) and creates the release commit + `vX.Y.Z` tag itself — no manual `git tag` needed.

Release commit format:

- `chore(release): X.Y.Z` (written by the pipeline, no skip trailer).
- Intentionally contains NO `[skip ci]` — GitHub suppresses tag-push runs for commits carrying it, so the release would be cut but never published. The loop guard matches the `chore(release):` prefix instead.

## 4. CI

Three workflows:

- `test.yml` (`test`): runs on `push` + `pull_request` + weekly schedule (Mondays 06:00 UTC).
  - `unit`: always runs on Node 22 — `bun install`, `bun run check`, `bun run test` (build + READONLY unit tier). `OPENCODE_GO_API_KEY` is mapped at job level; the live usage shape test (`test/unit/live-usage.test.js`) runs when present and skips neutrally otherwise. Unit tests must never write to the host (enforced by `scripts/check-unit-purity.mjs`).
  - `container-e2e`: authoritative gate — `docker compose run --rm --build test` builds the root Dockerfile and runs `opencode --version && kilo --version && bun install && bun run build && bun run test:integration && bun run test:e2e` against the baked-in checkout (no bind mount, hermetic tmp HOME/XDG). Includes the real opencode/kilo TUI display checks (tmux). `OPENCODE_GO_API_KEY` is forwarded; the live TUI variants skip neutrally without it.
- `dev-build.yml` (`dev-build`): runs on `push` to `develop` + manual dispatch. `bun install`, `bun run check`, `bun run test` (build + unit), then `bun pm pack` uploads the `dev-tgz` artifact (90-day retention). `install-dev.sh` consumes it.
- `publish.yml` (`publish`): `test` gate -> `version-bump` -> `publish` (OIDC provenance). The gate runs the same containerized suite as `container-e2e`, rebuilding + retesting the exact ref being released.

What must pass:

- `test` must pass before `version-bump`; `publish` runs only after bump (tag push re-enters workflow).
- A force-pushed tag can never publish broken code because the gate rebuilds the release ref.

## 5. Testing

Two tiers:

- **unit** (host + CI, readonly): `bun run test:unit` runs `scripts/check-unit-purity.mjs` (no fs writes, not even tmp, no child processes, no sockets) and then `bun test test/unit/*.test.js`. Pure helper tests plus the live usage shape test (network read, skips without `OPENCODE_GO_API_KEY`). `bun run test` builds first (`dist/*` is what the unit tests import).
- **integration + e2e** (Docker only): `bun run test:docker` (`docker compose run --rm --build test`). Never point these at the host: integration drives the real bins/snapshot/pack flows, and e2e boots real `opencode`/`kilo` servers and TUIs.
- `test/e2e/{opencode,kilo}-load.test.js` are container-only (compose sets `OC_GO_TEST_CONTAINER=1`): inside the disposable container they write the plugin config to the real `~/.config/{opencode,kilo}` and assert `go_usage` registers. Outside they skip with a reason.
- `test/e2e/tui-display.{opencode,kilo}.test.js` boot the real TUI in tmux (200x50), render `OPENCODE_GO_MOCK=1` usage, and assert the sidebar (`Go Usage`, `5h 42% · resets 2h5m`) plus the statusline (`Go 5h 42% | 7d 15% | 30d 61%`) text. Live variants use `OPENCODE_GO_API_KEY`. Models are discovered at runtime from `<binary> models opencode-go` (never hardcoded); hosts older than the Dockerfile pins skip with a clear reason. These still run against a tmp HOME/XDG, so a host run cannot touch the real config.
- `docker compose run --rm --build test` is the isolation boundary and the authoritative gate; the devcontainer (`.devcontainer/`) uses the same image with a bind mount.
- Hermeticity rule: tests that can run on the host (unit, TUI display) must never point at the real config. `test/helpers/run.js` redirects HOME/XDG/`OPENCODE_CONFIG_DIR` into a tmp root, forces `OPENCODE_GO_MOCK=1`, and strips credentials. Container-only tests rely on the disposable container HOME instead.

## 6. Action publishing

- Branch pushes never publish. Only tag pushes (`v*`) and manual dispatches reach the `publish` job — each version publishes exactly once.
- Triggers in `publish.yml`:
  - `push` to `main`: auto-bump path (`test` -> `version-bump`; the resulting tag push then flows through the release path).
  - `push` tags `v*`: release path (gate -> GitHub release -> npm).
  - `workflow_run` (`test` completed on `main`): audit-only re-validation; never cuts a release or publishes.
  - `workflow_dispatch`: manual release; optional `tag` input selects an existing tag, otherwise npm-only.
- Auth: OIDC trusted publishing (`id-token: write`, `registry-url: https://registry.npmjs.org`, `always-auth: false`). No long-lived npm token; `npm publish --provenance --access public` runs last and skips idempotently if the version is already on npm.
- GitHub release: tarball from `npm pack` is attached via `gh release create` / `upload`; dispatch without a tag publishes to npm only (no GitHub release).

Avoiding a version cut:

- On a `main` push (docs-only, CI-only, meta changes): add `[skip release]` (or `[no release]` / `skip-release:true`) anywhere in the commit subject or body. The `version-bump` job reads the full `%B` case-insensitively and passes through with no bump — the `test` gate still runs.
- On manual dispatch: `workflow_dispatch` input `release` (`true`/`false`, default `false`). `false` stays npm-publish-only; `true` lets a dispatch cut a version bump like a `main` push. Complement to the `[skip release]` trailer (pushes opt out, dispatches opt in).
- Never use `[skip ci]` for this — it suppresses ALL runs for the push, including the tag-push run that performs the publish. Never add `[skip ci]` anywhere.
