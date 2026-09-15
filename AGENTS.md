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
  - `unit`: always runs (no secrets needed) — `npm ci`, `npm run check`, `npm test` on Node 22.
  - `container-e2e`: authoritative end-to-end gate — `docker compose run --rm --build test` builds the root Dockerfile and runs `opencode --version && npm ci && npm run check && npm test && npm run test:e2e` against the baked-in checkout (no bind mount, hermetic tmp HOME/XDG).
  - `format-check`: secret-gated live usage-shape check (`OPENCODE_GO_API_KEY`). Skips neutral (exit 0) when the key is absent or when the API returns no usable windows (no subscription); still fails on malformed JSON or a missing percent within a present window.
- `dev-build.yml` (`dev-build`): runs on `push` to `develop` + manual dispatch. `npm ci`, `npm run check`, `npm test`, then `npm pack` uploads the `dev-tgz` artifact (90-day retention). `install-dev.sh` consumes it.
- `publish.yml` (`publish`): `test` gate -> `version-bump` -> `publish` (OIDC provenance). Rebuilds + retests the exact ref being released.

What must pass:

- `test` must pass before `version-bump`; `publish` runs only after bump (tag push re-enters workflow).
- A force-pushed tag can never publish broken code because the gate rebuilds the release ref.

## 5. Testing

- `npm test` builds, then runs unit + integration (`node:test`).
- `npm run test:unit` / `npm run test:integration` skip the build — run `npm run build` first (or use `npm test`).
- `npm run test:e2e` needs the `opencode` binary and a prior build; it skips cleanly without the binary. It boots a real `opencode serve` in an isolated tmp root and asserts `go_usage` is registered.
- `docker compose run --rm --build test` is the isolation boundary and the authoritative gate; the devcontainer (`.devcontainer/`) uses the same image with a bind mount.
- Hermeticity is mandatory: never point a plugin test at the real config. `test/helpers/run.js` redirects HOME/XDG/`OPENCODE_CONFIG_DIR` into a tmp root, forces `OPENCODE_GO_MOCK=1`, and strips credentials; the e2e tier additionally fails if `opencode debug paths` escapes the tmp root.

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
