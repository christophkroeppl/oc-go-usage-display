#!/usr/bin/env node
// Install (or re-install) the plugin into the detected coding agent(s):
// copies dist/plugins/* (bundled, self-contained) -> plugins/* by default
// (--symlink is dev-only: edits apply after restart but dangle if the source
// tree moves), then registers the server + TUI config entries (toggles
// preserved for opencode).
//
// Targets: --target opencode|kilo|all, or --config-dir / --kilo-config-dir.
// Without an explicit target the hosts are detected (binary on PATH or config
// dir present; brew/npm/curl/source installs all count): one host installs
// silently, two or more offer a numbered multiselect, zero defaults to all —
// detection never fails the install.
//
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
  fail,
  hostDirFromArgv,
  linkModeFromArgv,
  linkPluginFiles,
  parseOptionalToggle,
  repoDirFromArgv,
  selectTargets,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  const mode = linkModeFromArgv(argv);
  const sidebar = parseOptionalToggle(argv, "--sidebar");
  const statusline = parseOptionalToggle(argv, "--statusline");
  const targets = selectTargets(argv);
  if (targets.includes("kilo") && (sidebar !== null || statusline !== null)) {
    fail("--sidebar/--statusline do not apply to kilo (its tui.json rejects those options)");
  }

  console.log(`installed from ${repoDir} (${mode})`);
  for (const host of targets) {
    const configDir = hostDirFromArgv(host, argv);
    linkPluginFiles(repoDir, configDir, mode, host);
    const server = ensureServerEntry(configDir, { host });
    const tui = ensureTuiEntry(configDir, { sidebar, statusline, host });

    console.log(`${host}: ${configDir}`);
    console.log(`${host} server entry: ${server.present ? "present" : "missing"}`);
    if (host === "kilo") {
      console.log(`kilo tui entry: ${tui.entry ? "present" : "missing"} (no toggles: kilo rejects sidebar/statusline)`);
    } else {
      console.log(`tui toggles: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
    }
  }
  console.log("restart the host(s) to pick up the plugin");
} catch (error) {
  exitWithError(error);
}
