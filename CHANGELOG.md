# Changelog

All notable changes to this project are documented here.
The version bump is derived from Conventional Commits by the release pipeline.

## 2.0.0 (unreleased)

### Breaking changes

- Plugin entries export a single default module (`{ id, server }` or `{ id, tui }`); named exports are no longer supported.
- `engines.opencode: ^1.18.0` is enforced; older OpenCode 1.x hosts are rejected with a warning.
- `init` installs copies by default; `--symlink` is dev-only and requires `npm run build` after source edits.
- Ephemeral-source rejection was removed; all package-manager default paths (`npx`, `bunx`, npm cache) are accepted.
- Dev installs snapshot the OpenCode config and print a restore command instead of auto-restoring on exit.

### Added

- Containerized e2e gate (`docker compose run --rm --build test`) that boots a real OpenCode and asserts the `go_usage` tool is registered.
- Fail-safe plugin initialization: OpenCode starts even if the plugin fails.
- Unit / integration / e2e test tiers with a hermetic harness (no access to the developer's real config).
- `scripts/dev-config-snapshot.sh` for config snapshot/restore around dev installs.

### Security

- Cookie-bearing requests use `redirect: "manual"` with an explicit host allowlist.
- Response bodies are covered by the fetch timeout; CLI failures print one clean line without stack traces.

## 1.1.0

- Server `go_usage` tool plus TUI sidebar/statusline surfaces.
- Symlink-based installs from the package directory.
