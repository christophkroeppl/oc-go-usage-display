---
name: plugin-contract
description: OpenCode plugin-loader contract for oc-go-usage-display — single default export, target-exclusive server/tui entries, fail-safe factories, and how to verify a change against a real opencode. Use before editing src/index.ts, src/tui.tsx, dist/plugins/*, or the package exports, and when opencode fails to start or the plugin is not registered.
---

# Plugin contract (oc-go-usage-display)

OpenCode loads plugin packages by enumerating module exports. This repo ships
entry modules for opencode v1, opencode v2 and Kilo, and the rules below are
structural, not stylistic (they prevent a hard crash of host startup).

## Entry modules

| Module | Export | Built outputs |
| ------ | ------ | ------------- |
| `src/index.ts` | `default { id: "oc-go-usage-display", server }` | `dist/index.js` + `dist/plugins/oc-go-usage-display.ts` + `.kilo.ts` |
| `src/tui.tsx` | `default { id: "oc-go-usage-display", tui }` | `dist/tui.js` + `dist/plugins/oc-go-usage-display.tsx` |
| `src/tui.kilo.tsx` | `default { id: "oc-go-usage-display", tui }` | `dist/tui.kilo.js` + `dist/plugins/oc-go-usage-display.kilo.tsx` |
| `src/v2/index.ts` | `default Plugin.define({ id, setup })` | `dist/plugins/oc-go-usage-display.v2.ts` |
| `src/v2/tui.tsx` | `default Plugin.define({ id, setup })` | `dist/plugins/oc-go-usage-display.v2.tui.ts` |

- **Exactly one export per entry: the default module.** The v1 loader invokes
  every other runtime export as a plugin factory when the default is not a
  `{ id, server | tui }` module; a factory returning a non-Hooks value used to
  crash `Provider.list`. The v2 loader has the same default-only expectation,
  and `scripts/verify-bundles.mjs` enforces it for all six bundles. Do not add
  `export` statements to the entry files — put helpers in `src/helpers.ts` /
  `src/shared.ts` / `src/tui-shared.tsx` (all are inlined into the deployed
  bundles). `src/tui-shared.tsx` is the layer every TUI entry shares; add
  host-specific code to the entry, not a second copy of a component.
- **Target-exclusive:** `dist/index.js` exposes only `server`, `dist/tui.js`
  only `tui`. The package `exports` map (`./server`, `./tui`, `./kilo-tui`) is
  how opencode v1 and Kilo resolve the targets. v2 is not resolved through
  package `exports`: its install is one directory,
  `<config>/plugins/oc-go-usage-display/{index.ts,tui.ts}`, which the host
  resolves as a package with `server`/`tui` entrypoints. Keep the map intact
  when changing packaging.
- **Engine floor:** `engines.node >= 22`, `engines.opencode ^1.19.0`; the
  container pins opencode v1, opencode v2 (`OPENCODE_V2_VERSION`) and Kilo for
  tests.
- **v1 vs v2:** v1 uses `@opencode-ai/plugin` hooks plus `package.json` exports;
  v2 uses `@opencode/plugin`'s `Plugin.define({ id, setup })`, claims slots with
  `ctx.ui.slot({ append, render })`, and registers the tool through
  `ctx.tool.transform`. They are separate entrypoints and separate bundles; do
  not port one API's shape into the other.
- **v2 paint semantics:** a v2 slot claim is built once at mount. Writing a
  signal does not repaint it, and a claim that returns `null` before a session
  exists stays `null`. The v2 entry therefore builds from plain values captured
  at paint time and repaints by disposing the claim and registering a fresh
  one. See `src/v2/tui.tsx`; `AGENTS.md` carries the short version.

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

For v2, use `opencode-v2` (never the host's `.config/opencode`):

- `opencode-v2 serve --port 0 --hostname 127.0.0.1 --print-logs` prints the URL
  and an HTTP Basic password. `GET /api/plugin` returns `{ location, data }`;
  assert the entry under test is present with `state.status === "active"`.
- That route does **not** wait for activation, so a cold location answers
  `{ data: [] }` for the first seconds. Poll it (the e2e helper is
  `waitForPluginInventory`), do not sample once.
- `opencode-v2 plugin list` lists package plugins only; it is not a valid check
  for a locally installed bundle.
- The TUI needs a session before `sidebar.content` paints. The e2e flow boots
  the TUI in tmux, waits for `Ask anything`, sends a prompt, and only then
  captures the pane.
- A relative path in `plugins` is resolved as a package name; the install entry
  must be absolute. A `.tsx` file in `<config>/plugins/` is skipped silently.
