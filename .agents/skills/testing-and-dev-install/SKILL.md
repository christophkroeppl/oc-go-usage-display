---
name: testing-and-dev-install
description: Test tiers, hermeticity rules, and the dev-tgz install plus config snapshot/restore flow for oc-go-usage-display. Use when running or adding tests, debugging CI-only failures, or installing a develop build with install-dev.sh.
---

# Testing and dev install

## Test tiers

Two kinds of tests:

- **unit** (host + CI): readonly — no fs writes (not even tmp), no child
  processes, no sockets. Enforced by `scripts/check-unit-purity.mjs`.
- **integration + e2e** (Docker image only): everything that touches real
  files, processes or hosts, including the tmux-driven TUI display checks.

| Command | Runs | Needs |
| ------- | ---- | ----- |
| `bun run test` | `bun run build` + `test:unit` (readonly) | nothing else |
| `bun run test:unit` | purity check + pure helper tests + live usage shape test (skips without `OPENCODE_GO_API_KEY`) | prior `bun run build` |
| `bun run test:docker` | `docker compose run --rm --build test` — the authoritative gate | Docker |
| `bun run test:integration` | bin CLI, snapshot, `pack` contract, fail-safe, redirect wiring | container only |
| `bun run test:e2e` | real `opencode`/`kilo` load checks + TUI usage-display assertions in tmux | container only |

Inside the container the gate runs `opencode --version && kilo --version &&
bun install && bun run build && bun run test:integration && bun run test:e2e`.
The devcontainer (`.devcontainer/`) uses the same Dockerfile with a bind-mounted
workspace; `docker compose` bakes the checkout into the image (no bind mount)
and is the authoritative CI gate.

Guidance: `bun run test` is safe to run anywhere. Run `bun run test:docker` before
pushing loader/packaging/TUI/CI changes — the e2e TUI tests are the ones that
prove usage actually renders, and they need the image's pinned binaries
(opencode + kilo + tmux). Hosts with older opencode/kilo versions skip the TUI
tests with an explicit reason.

## Hermeticity

Tests must never read or write the developer's real config:

- `test/helpers/run.js` builds child envs rooted in a `mkdtemp` dir: HOME, all
  XDG roots, and `OPENCODE_CONFIG_DIR` point inside the root,
  `OPENCODE_GO_MOCK=1`, credentials are stripped, inherited behavior toggles
  (`OPENCODE_GO_DISPLAY/SIDEBAR/STATUSLINE`) and opencode override vars
  (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_TUI_CONFIG`,
  `OPENCODE_PERMISSION`, `OPENCODE_DB`, `OPENCODE_PLUGIN_META_FILE`) are
  removed, and hermetic keys are re-checked against the root. The live tests
  opt keys back in via `allowSecrets` (never a default).
- `test/helpers/tmp.js` owns disposable fixtures; callers clean up.
- `test/helpers/tui.js` drives the real TUI with a private tmux socket under
  the tmp root (`TMUX_TMPDIR`), 200x50, and captures plain text with
  `capture-pane -p`; models come from `<binary> models opencode-go` at runtime.
- The plugin-contract suite redirects HOME/XDG before importing `dist/*` and
  fails loudly if `CONFIG_DIR` / auth paths escape the tmp root.
- The container-only load checks (`test/e2e/{opencode,kilo}-load.test.js`) are
  the exception: they run only when compose sets `OC_GO_TEST_CONTAINER=1`,
  install through the real `oc-go-usage-display-init` CLI, and use the
  disposable container HOME (`~/.config/{opencode,kilo}`) on purpose — the
  container is the isolation boundary there.
- Hand checks must do the same (tmp HOME/XDG or the container). Never run
  `bin/*` against the default `~/.config/opencode` or `~/.config/kilo`.

## Dev install (`install-dev.sh`)

`./install-dev.sh` installs the latest successful `develop` dev tarball.
Requires an authenticated `gh`, plus `node` and `npm`.

Flow:

1. resolve the latest successful `dev-build.yml` run on `develop`
   (`gh run list --branch develop --workflow dev-build.yml --status success
   --limit 1`; override with `--branch`, `--workflow`, or `--run-id`),
2. download the `dev-tgz` artifact into `./tmp-dev` (override with `--dir`),
3. sanity-check the tarball (`dist/index.js` and the init bin are present),
4. fail closed: `scripts/dev-config-snapshot.sh save` snapshots the 6 config
   paths before any mutation,
5. `npm install --no-save file:<tgz>` then `oc-go-usage-display-init --copy`
   (plus best-effort `show --json` and `status`),
6. print the restore command and the published fallback.

Snapshot paths (relative to the config dir): `opencode.jsonc`, `tui.json`,
`plugins/oc-go-usage-display.ts`, `plugins/oc-go-usage-display.tsx`,
`oc-go-usage-display.json`, `oc-go-usage-display-cache.json`.

There is **no auto-restore** — run it yourself when done:

```sh
scripts/dev-config-snapshot.sh restore --backup-dir <snapshot path>
# add --config-dir <path> for a project-scoped install
```

`restore` copies `present` entries back with their original type/mode and
deletes `absent` entries only if they were created since the snapshot; unsafe
paths are refused. Backups default to
`${TMPDIR:-/tmp}/oc-go-usage-display-backup/<timestamp>-<pid>`
(`--backup-dir` overrides; `--snapshot` aliases it). Fall back to the published
package with
`npx -y -p oc-go-usage-display@latest oc-go-usage-display-init --copy --config-dir <path>`
(`--config-dir` only for project-scoped installs; `--copy` needs a published
version >= 1.2.0 — 1.1.0 symlinks and ignores it).

Flags: `--dry-run` (download + sanity check only), `--branch` (default
`develop`), `--workflow` (default `dev-build.yml`), `--run-id`, `--dir`,
`--force` / `--clean` (replace a non-empty download dir), `--sidebar=0/1`,
`--statusline=0/1`, `--config-dir`, `--backup-dir`. The npm-init surface also
takes `--target opencode|kilo|all` and `--kilo-config-dir` (Kilo entries are
absolute paths: Kilo does not resolve `./...` against its config dir).
