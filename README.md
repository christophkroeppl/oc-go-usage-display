# oc-go-usage-display

[![npm version](https://img.shields.io/npm/v/oc-go-usage-display.svg)](https://www.npmjs.com/package/oc-go-usage-display)

OpenCode Go subscription usage for [opencode](https://opencode.ai) and Kilo:

| Target | Bundled entry | Surface |
| ------ | ------------- | ------- |
| server | `dist/plugins/oc-go-usage-display.ts` | `go_usage` tool (`Go 5h 42% (reset 3h12m) \| 7d 15% \| 30d 61%`) |
| tui | `dist/plugins/oc-go-usage-display.tsx` | `Go Usage` sidebar + `session_prompt_right` statusline (opencode) |
| tui (kilo) | `dist/plugins/oc-go-usage-display.kilo.tsx` | same TUI surfaces for Kilo |

`shared.ts` is inlined at build time. Requires Node >= 22 and opencode >= 1.18.

![Go Usage sidebar and statusline](docs/screenshot.png)

## Install (npm)

| Mode | Command |
| ---- | ------- |
| Persistent (recommended) | `npm install oc-go-usage-display@1.2.0 && npx oc-go-usage-display-init --copy` |
| One-shot (npx) | `npx -p oc-go-usage-display@1.2.0 oc-go-usage-display-init --copy` |
| Project scope | `npx -p oc-go-usage-display@1.2.0 oc-go-usage-display-init --copy --config-dir .opencode` |

`--copy` is the default and self-contained; `--symlink` is dev-only (rebuild +
restart). Restart opencode afterwards. Pin the version (`@1.2.0`, not
`@latest`) so installs stay reproducible; copy-first requires >= 1.2.0.

Alternative — no files copied: declare the versioned package and let opencode
resolve it at startup:

```jsonc
// opencode.jsonc — server target (go_usage tool)
{ "plugin": ["oc-go-usage-display@1.2.0"] }
// tui.json — TUI target (sidebar + statusline)
{ "plugin": [["oc-go-usage-display@1.2.0", { "sidebar": true, "statusline": true }]] }
```

From a checkout: `./install.sh` (copy install), `./install.sh --symlink`
(dev-only), `./install-dev.sh` (latest `develop` dev-tgz + config snapshot;
there is no auto-restore — it prints the restore command).

## Commands

After `npm install` the names below are on PATH; from a checkout use
`node ./bin/<bin>.js`.

| Command | What it does |
| ------- | ------------ |
| `oc-go-usage-display-init` | install (copy) + register entries; `--symlink` for dev |
| `oc-go-usage-display-remove` | uninstall files + config entries (secrets untouched) |
| `oc-go-usage-display-show` | print effective install; `--json` for machine output |
| `oc-go-usage-display-status` | health check; exit 0 healthy, 1 with reasons |
| `oc-go-usage-display-update` | re-install + `git pull --ff-only` when a remote exists |

Flags: `--config-dir <path>` (all; default `$OPENCODE_CONFIG_DIR` or
`~/.config/opencode`), `--repo <path>`, `--copy`/`--symlink`,
`--sidebar=0/1`, `--statusline=0/1`, `--json` (show).

## Display toggles

Both surfaces default on:

```json
{ "plugin": ["./plugins/oc-go-usage-display.tsx", { "sidebar": true, "statusline": true }] }
```

Toggle them from the command palette (`Go usage: toggle sidebar` /
`Go usage: toggle statusline`); the collapsed state persists per surface.
Environment variables and the legacy `display` option apply only when the
`tui.json` toggles are absent. Restart opencode after changing static config.

## Auth and config

First match wins (secrets are never logged):

| # | Source | Behavior |
| - | ------ | -------- |
| 1 | `OPENCODE_GO_MOCK=1` | deterministic mock snapshot (never cached) |
| 2 | `OPENCODE_GO_API_KEY` | `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>` |
| 3 | `auth.json` | same Bearer path; `opencode-go` key, else `opencode` |
| 4 | workspace + cookie | scrape `GET https://opencode.ai/workspace/{workspaceId}/go` with the `auth` cookie |
| 5 | none | unavailable snapshot (`not configured (set OPENCODE_GO_API_KEY)`) |

File config (`~/.config/opencode/oc-go-usage-display.json`):

```jsonc
{ "workspaceId": "...", "authCookie": "..." }
```

Successful snapshots cache 60s (memory + `oc-go-usage-display-cache.json`);
failures are never cached. Key env vars: `OPENCODE_GO_API_KEY`,
`OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_AUTH_COOKIE`, `OPENCODE_GO_MOCK`,
`OPENCODE_GO_SIDEBAR` / `OPENCODE_GO_STATUSLINE` (`0/1`),
`OPENCODE_GO_DISPLAY` (legacy), `OPENCODE_CONFIG_DIR` (install CLIs).

## Development

```sh
bun install
bun run build     # tsc -> dist/ + esbuild -> dist/plugins/* (self-contained)
bun run check     # typecheck only
```

| Test command | Tier |
| ------------ | ---- |
| `bun run test` | build + READONLY unit tier (host/CI) |
| `bun run test:unit` | helper tests + live usage shape check (skips without `OPENCODE_GO_API_KEY`) |
| `bun run test:docker` | authoritative gate: integration + e2e, incl. the real opencode/kilo TUI display checks |
| `bun run test:integration` / `bun run test:e2e` | container-only tiers |

Unit tests are readonly by construction (`scripts/check-unit-purity.mjs` rejects
fs writes, tmp usage, child processes and sockets). Integration and e2e run only
inside the container image; host-runnable tests redirect HOME/XDG and force
`OPENCODE_GO_MOCK=1`, so they never touch the real `~/.config/opencode`.

## CI

| Workflow | Trigger | Jobs |
| -------- | ------- | ---- |
| `test.yml` | push, PR, weekly (Mon 06:00 UTC) | `unit` always; `container-e2e` (Docker gate) only on `main` pushes, the schedule, and non-draft PRs |
| `dev-build.yml` | push to `develop` | `dev-tgz` artifact (90 days), used by `install-dev.sh` |
| `publish.yml` | push to `main` | gate -> release-please Release PR -> OIDC provenance publish |

Releases are cut by [release-please](https://github.com/googleapis/release-please):
merging `develop` into `main` opens/updates a `chore(main): release X.Y.Z` PR
(`feat` -> minor, `fix` -> patch, breaking change -> major; `chore`/`docs`/`ci`/
`test`/`refactor`/`style`/`build`/`perf` never cut a release on their own).
Merging that PR tags `vX.Y.Z`, creates the GitHub release, and publishes to npm
after the containerized gate. To force a version, add a `Release-As: X.Y.Z`
footer to a commit merged to `main`.

## Troubleshooting

- **Plugin didn't load**: check `npx oc-go-usage-display-show` / `status`, then
  restart opencode (`opencode debug config` shows the resolved plugin list;
  `opencode --pure` skips plugins, so it is not a valid check).
- **No API key or subscription**: surfaces show `Go n/a (…)`; set
  `OPENCODE_GO_API_KEY`, sign in through the `opencode-go` provider, or
  configure workspace + cookie.
- **Stale copy install**: copy installs never auto-update; re-run
  `npx oc-go-usage-display-init --copy` and restart.

## Uninstall

```sh
npx oc-go-usage-display-remove
npm uninstall oc-go-usage-display
```

Removes the plugin files and the `opencode.jsonc` (server) + `tui.json` (TUI)
entries. Secrets are never touched: env vars, `auth.json`, and
`oc-go-usage-display.json` stay in place.
