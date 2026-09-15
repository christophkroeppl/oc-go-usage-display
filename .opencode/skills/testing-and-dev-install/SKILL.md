---
name: testing-and-dev-install
description: Test tiers, hermeticity rules, and the dev-tgz install plus config snapshot/restore flow for oc-go-usage-display. Use when running or adding tests, debugging CI-only failures, or installing a develop build with install-dev.sh.
---

# Testing and dev install

## Test tiers

| Command | Runs | Needs |
| ------- | ---- | ----- |
| `npm test` | `npm run build` + unit + integration | nothing else |
| `npm run test:unit` | `node --test test/unit/*.test.js` | prior `npm run build` |
| `npm run test:integration` | `node --test test/integration/*.test.js` | prior `npm run build` |
| `npm run test:e2e` | real `opencode serve` load check (skips without the binary) | `opencode` on PATH + prior build |
| `docker compose run --rm --build test` | full gate in the built image: `opencode --version && npm ci && npm run check && npm test && npm run test:e2e` | Docker |

There is no `test:container` script — the container command is
`docker compose run --rm --build test`. The devcontainer (`.devcontainer/`)
uses the same Dockerfile with a bind-mounted workspace; `docker compose` bakes
the checkout into the image (no bind mount) and is the authoritative CI gate.

Guidance: use `npm test` for local changes; run the container command before
pushing loader/packaging/CI changes; remember `test:e2e` silently skips on a
host without the `opencode` binary, so a green host-only run is not e2e
coverage.

## Hermeticity

Tests must never read or write the developer's real config:

- `test/helpers/run.js` builds child envs rooted in a `mkdtemp` dir: HOME, all
  XDG roots, and `OPENCODE_CONFIG_DIR` point inside the root,
  `OPENCODE_GO_MOCK=1`, credentials are stripped, inherited behavior toggles
  (`OPENCODE_GO_DISPLAY/SIDEBAR/STATUSLINE`) and opencode override vars
  (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_TUI_CONFIG`,
  `OPENCODE_PERMISSION`, `OPENCODE_DB`, `OPENCODE_PLUGIN_META_FILE`) are
  removed, and hermetic keys are re-checked against the root.
- `test/helpers/tmp.js` owns disposable fixtures; callers clean up.
- The plugin-contract suite redirects HOME/XDG before importing `dist/*` and
  fails loudly if `CONFIG_DIR` / auth paths escape the tmp root.
- The e2e harness (`test/helpers/opencode.js`) runs `opencode debug paths`
  first and fails if any path escapes the tmp root.
- Hand checks must do the same (tmp HOME/XDG or the container). Never run
  `bin/*` against the default `~/.config/opencode`.

## Dev install (`install-dev.sh`)

`./install-dev.sh` installs the latest successful `develop` dev tarball.
Requires an authenticated `gh`, plus `node` and `npm`.

Flow:

1. resolve a run (`gh run list --branch develop --status success --limit 1`;
   refine with `--workflow dev-build.yml`, `--branch`, or `--run-id`),
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
`npx -y -p oc-go-usage-display@latest oc-go-usage-display-init --copy`.

Flags: `--dry-run` (download + sanity check only), `--force` / `--clean`
(replace a non-empty download dir), `--sidebar=0/1`, `--statusline=0/1`,
`--config-dir`, `--backup-dir`.
