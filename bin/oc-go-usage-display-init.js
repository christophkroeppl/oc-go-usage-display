#!/usr/bin/env node
// Install (or re-install) the plugin from this repo into ~/.config/opencode:
// symlinks src/* -> plugins/* by default (--copy to copy instead),
// then registers the opencode.jsonc + tui.json entries (toggles preserved).

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
