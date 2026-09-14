#!/usr/bin/env node
// Install (or re-install) the plugin from this repo into ~/.config/opencode:
// copies dist/plugins/* (bundled, self-contained) -> plugins/* by default
// (--symlink is dev-only: edits apply after restart but dangle if the repo
// moves; never used from ephemeral /tmp sources). Then registers the
// opencode.jsonc + tui.json entries (toggles preserved). Run `npm run build`
// first so dist/plugins/* exists (pretest/publish build it automatically).
// Durable flows:
//   npm install oc-go-usage-display@1.1.0 && npx oc-go-usage-display-init --copy
//   (or declare "plugin": ["oc-go-usage-display@1.1.0"] in config instead).
// When run via bunx/npx without an install, --repo <durable-path> is
// required (ephemeral /tmp/bunx-*/_npx sources are rejected).

import {
  ensureServerEntry,
  ensureTuiEntry,
  fail,
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
  if (error instanceof Error) fail(error.message);
  throw error;
}
