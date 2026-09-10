# AGENTS.md

AI and human contributors: every commit must use Conventional Commits.

Format: `type(scope?): subject` — see https://www.conventionalcommits.org/

## 1. Project commits

Format: `type(scope): subject`

- `type` is required — never commit without a `type` (never empty type).
- `scope` is required for `sidebar`, `statusline`, `server`, `ci`, `docs` changes. `release` scope is reserved for the pipeline (see Versioning).
- Known scopes: `sidebar`, `statusline`, `server`, `ci`, `docs`, `release`.
- Keep subject imperative, lowercase, no trailing period.

Examples for this repo:

- `feat(sidebar): add weekly usage row`
- `fix(statusline): handle missing percent`
- `feat!: drop node 18 support`
- `fix(server): redact api key in show output`
- `chore(ci): tighten test gate`
- `docs: clarify tui toggles`

A non-conventional message defaults to patch and may mistrigger versioning — so format correctly.

## 2. Versioning

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

## 3. CI

Two workflows:

- `test.yml` (`test`): runs on `push` + `pull_request` + weekly schedule (Mondays 06:00 UTC).
  - `unit`: always runs (no secrets needed) — `npm ci`, `npm run check`, `npm run build`, `npm test` on Node 22.
  - `format-check`: validates the live usage JSON shape (`rolling` / `weekly` / `monthly` with numeric `percent` + optional string `status`). Skips neutral (exit 0) when `OPENCODE_GO_API_KEY` is absent or when the API returns no usable windows (no subscription); still fails on malformed JSON or a missing percent within a present window.
  - `tui-screenshot`: best-effort headless check — installs deps, builds (`npm run check` + `npm run build`), installs the plugin in an isolated config, compares `show --json` output to a direct API fetch. Pixel/TUI steps are `continue-on-error` with redacted output; the authoritative signal is health check + percent match.
- `publish.yml` test gate (`test` job inside `publish.yml`): rebuilds + retests the exact ref being released (`npm ci`, `npm run check`, `npm run build`, `npm test --if-present`).

What must pass:

- `test` must pass before `version-bump`; `publish` runs only after bump (tag push re-enters workflow).
- A force-pushed tag can never publish broken code because the gate rebuilds the release ref.

## 4. Action publishing

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
