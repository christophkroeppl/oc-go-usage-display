# AGENTS.md

Every commit must use Conventional Commits: `type(scope): subject` (imperative,
lowercase, no trailing period). `scope` is required for `sidebar`, `statusline`,
`server`, `ci`, `docs`; `release` is reserved for release-please. See
[Versioning](#versioning-release-please) for what actually releases.

## Architecture

- **server** — `src/index.ts` -> `dist/index.js` / bundles `dist/plugins/oc-go-usage-display.ts` (opencode) and `dist/plugins/oc-go-usage-display.kilo.ts` (Kilo; same source, host baked in with an esbuild define). Registers only the `go_usage` tool.
- **tui** — `src/tui.tsx` -> `dist/tui.js` / bundle `dist/plugins/oc-go-usage-display.tsx` (opencode). `src/tui.kilo.tsx` -> `dist/tui.kilo.js` / bundle `dist/plugins/oc-go-usage-display.kilo.tsx` (Kilo). Additive `sidebar_content` + `session_prompt_right` slots only, never `single_winner`.
- **host roots** — every entry reads only its own host's stores: opencode `~/.config/opencode` + `$XDG_DATA_HOME/opencode`; Kilo `$KILO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kilo` + `$XDG_DATA_HOME/kilo`. Kilo's `tui.json` rejects `sidebar`/`statusline` options, and Kilo does not resolve `./...` against its config dir, so kilo install entries are absolute paths (opencode keeps `./plugins/...`).
- **shared** — `src/shared.ts` + `src/helpers.ts` are inlined into the bundles; `dist/plugins/*` have no relative imports. `bun run build` fails unless all four bundles are present, self-contained and default-export-only (`scripts/verify-bundles.mjs`); `scripts/verify-tarball.mjs` checks packed tarballs.
- Each entry module exports exactly one thing: the default `{ id, server | tui }` module. Extra exports are invoked by the loader as plugin factories and can crash startup. Importing never throws; factories and renders are fail-safe.
- Secrets are never logged; tests never touch the real `~/.config/opencode` or credentials. Details: `.agents/skills/plugin-contract`, `.agents/skills/testing-and-dev-install`.
- Install surfaces: `bin/` CLIs, package `exports` (`./server`, `./tui`, `./kilo-tui`), `install.sh`, `install-dev.sh`.

## Versioning (release-please)

- `feat` -> minor; `fix` (and visible `deps`/`revert`) -> patch; `BREAKING CHANGE`/`!` -> major.
- `chore`, `docs`, `ci`, `test`, `refactor`, `style`, `build`, `perf` -> no release on their own.
- `main` pushes maintain a `chore(main): release X.Y.Z` PR; merging it creates the tag + GitHub release, and then `publish` runs the gate and publishes to npm (OIDC, no token).
- Force a version with a `Release-As: X.Y.Z` footer on a commit merged to `main`. Never add `[skip ci]` to a release commit.
- `release-please-config.json` + `.release-please-manifest.json` drive it; `CHANGELOG.md` is generated. Remove `last-release-sha` after the first Release PR merges.

## CI

- `test.yml`: `unit` (typecheck + build + readonly tests) on push/PR/schedule; `container-e2e` (Docker: integration + e2e, real opencode/kilo TUI in tmux) on `main` pushes, the weekly schedule, and non-draft PRs — never on `develop` pushes or draft PRs.
- `dev-build.yml`: `develop` push -> `dev-tgz` artifact (90 days), consumed by `install-dev.sh`.
- `publish.yml`: `main` push -> `test` gate -> `release-please` -> OIDC npm publish when a Release PR just merged; release assets carry the tarball, the four plugin bundles and `SHA256SUMS`, and the registry tarball is re-verified after publish.

## Testing

- **unit** (host/CI, readonly): `bun run test:unit`, purity-checked — no fs writes, not even tmp, no child processes, no sockets. `bun run test` = build + unit.
- **integration + e2e** (Docker only): `bun run test:docker` (`docker compose run --rm --build test`). Never point these at the host config.
- Host-runnable tests redirect HOME/XDG/`OPENCODE_CONFIG_DIR` into temp dirs and force `OPENCODE_GO_MOCK=1`; container-only tests use the disposable container HOME (`OC_GO_TEST_CONTAINER=1`).
