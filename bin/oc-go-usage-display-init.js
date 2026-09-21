#!/usr/bin/env node
// Install (or re-install) the plugin from this repo into ~/.config/opencode:
// copies dist/plugins/* (bundled, self-contained) -> plugins/* by default
// (--symlink is dev-only: edits apply after restart but dangle if the source
// tree moves). Then registers the opencode.jsonc + tui.json entries (toggles
// preserved). Run `bun run build` first so dist/plugins/* exists
// (`bun run test` and publish build it automatically).
// Supported flows:
//   npm install oc-go-usage-display@1.2.0 && npx oc-go-usage-display-init --copy
//   (or declare "plugin": ["oc-go-usage-display@1.2.0"] in config instead).
//   npx -p oc-go-usage-display@1.2.0 oc-go-usage-display-init --copy  (one-shot from the package cache)
//   bunx -p oc-go-usage-display@1.2.0 oc-go-usage-display-init --copy  (same, via Bun)
// Copy-first needs the published 1.2.0+: 1.1.0 symlinks and ignores --copy.
// Any source path is accepted; --repo only overrides the default repo root.

import {
  ensureServerEntry,
  ensureTuiEntry,
  exitWithError,
  linkModeFromArgv,
  linkPluginFiles,
  openCodeDirFromArgv,
  parseOptionalToggle,
  repoDirFromArgv,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  const configDir = openCodeDirFromArgv(argv);
  const mode = linkModeFromArgv(argv);
  const sidebar = parseOptionalToggle(argv, "--sidebar");
  const statusline = parseOptionalToggle(argv, "--statusline");

  linkPluginFiles(repoDir, configDir, mode);
  const server = ensureServerEntry(configDir);
  const tui = ensureTuiEntry(configDir, { sidebar, statusline });

  console.log(`installed from ${repoDir} (${mode})`);
  console.log(`server entry: ${server.present ? "present" : "missing"}`);
  console.log(`tui toggles: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
} catch (error) {
  exitWithError(error);
}
