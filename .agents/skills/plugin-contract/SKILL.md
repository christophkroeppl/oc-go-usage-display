---
name: plugin-contract
description: OpenCode plugin-loader contract for oc-go-usage-display — single default export, target-exclusive server/tui entries, fail-safe factories, and how to verify a change against a real opencode. Use before editing src/index.ts, src/tui.tsx, dist/plugins/*, or the package exports, and when opencode fails to start or the plugin is not registered.
---

# Plugin contract (oc-go-usage-display)

OpenCode loads plugin packages by enumerating module exports. This repo ships
two target-exclusive entry modules, and the rules below are structural, not
stylistic (they prevent a hard crash of `opencode` startup).

## Entry modules

| Module | Export | Built outputs |
| ------ | ------ | ------------- |
| `src/index.ts` | `default { id: "oc-go-usage-display", server }` | `dist/index.js` + `dist/plugins/oc-go-usage-display.ts` |
| `src/tui.tsx` | `default { id: "oc-go-usage-display", tui }` | `dist/tui.js` + `dist/plugins/oc-go-usage-display.tsx` |

- **Exactly one export per entry: the default module.** The loader invokes
  every other runtime export as a plugin factory when the default is not a
  `{ id, server | tui }` module; a factory returning a non-Hooks value used to
  crash `Provider.list`. Do not add `export` statements to the entry files —
  put helpers in `src/helpers.ts` / `src/shared.ts` (both are inlined into the
  deployed bundles).
- **Target-exclusive:** `dist/index.js` exposes only `server`, `dist/tui.js`
  only `tui`. The package `exports` map (`./server`, `./tui`) is how opencode
  1.18 resolves the targets (server falls back to `main`; TUI themes come from
  `oc-themes`). Keep the map intact when changing packaging.
- **Engine floor:** `engines.node >= 22`, `engines.opencode ^1.18.0`; the
  container pins opencode 1.18.31 for tests.
- **v1 vs v2:** this repo targets the v1 plugin API (`@opencode-ai/plugin`
  modules plus `package.json` `exports` targets). opencode 1.18.31 ships an
  experimental `opencode debug v2`, but it only dumps a provider catalog — do
  not assume v2 plugin semantics.

Enforcement: `scripts/build-plugins.mjs` fails the build on a bare/stray
export; `test/integration/plugin-contract.test.js` asserts one default export
and target exclusivity; `test/unit/fail-safe.test.js` pins the never-throw
behavior.

## Fail-safe requirements

The plugin must never keep opencode from starting:

- Module import (including top-level path construction) must not throw. Use
  `safeJoinPath` / `resolveConfigDir` from `src/shared.ts` for module-level
  paths.
- The server factory catches every failure and resolves to `{}` (or sanitized
  hooks); the TUI factory swallows initialization errors and logs best-effort.
- Slot render functions are individually guarded; slot registration, commands,
  events, polling, and lifecycle teardown are all best-effort.
- Errors go through `api.client.app.log` (server: `logServerError`), never
  `console`; secrets (API keys, auth cookies) are never logged.

## Verify against a real opencode

```sh
docker compose run --rm --build test   # hermetic: builds the image, boots the real server, asserts go_usage
```

Manual checks must be hermetic (tmp HOME/XDG/`OPENCODE_CONFIG_DIR`, or the
container) — never point them at the real `~/.config/opencode`:

- `opencode debug config` shows the resolved `plugin` list plus
  `plugin_origins`. With `--pure` the plugin stays listed but is never loaded,
  so `debug config` is not proof of a successful load.
- `opencode serve --port 0` + `GET /experimental/tool/ids` (header
  `x-opencode-directory`) is the authoritative server check: the server target
  must register `go_usage`.
- `--pure` / `OPENCODE_PURE=1` skip external plugins; keep
  `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` (skips only built-ins, used by the e2e
  harness) instead.
- There is no `opencode plugin list`: `opencode plugin <module>` installs a
  plugin, so a bare `opencode plugin list` tries to install an npm package
  named `list`. Inspect config with `debug config` instead.
