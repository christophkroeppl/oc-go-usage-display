#!/usr/bin/env node
// Install (or re-install) the plugin into the coding agent(s) you pick:
// copies dist/plugins/* (bundled, self-contained) -> plugins/* by default
// (--symlink is dev-only: edits apply after restart but dangle if the source
// tree moves), then registers the server + TUI config entries (toggles
// preserved for opencode).
//
// Targets: --target opencode|kilo|all, or --config-dir / --kilo-config-dir.
// Without an explicit target:
//   - stdin+stdout are TTYs: ALWAYS ask, even when only one host is detected.
//     Both hosts are listed; a host whose binary is not on PATH is struck
//     through and left out of the default, but stays selectable by number (you
//     may be pre-installing config for an app you have not installed yet).
//   - otherwise (piped, CI, agent): every host, no prompt, no stdin read.
// So a human never has their config rewritten without a question, and an
// automated run never blocks on one. Unrecognized arguments are rejected
// instead of treated as "install" — `init status` is an error, not an install.
//
// Supported flows:
//   bun add oc-go-usage-display@latest && bunx oc-go-usage-display-init --copy
//   (or declare "plugin": ["oc-go-usage-display@latest"] in config instead).
//   bunx -p oc-go-usage-display@latest oc-go-usage-display-init --copy  (one-shot from the package cache)
// Copy-first needs the published latest+: 1.1.0 symlinks and ignores --copy.
// Any source path is accepted; --repo only overrides the default repo root.

import {
  ensureServerEntry,
  ensureTuiEntry,
  exitWithError,
  fail,
  guardArgs,
  hostDirFromArgv,
  linkModeFromArgv,
  linkPluginFiles,
  parseOptionalToggle,
  repoDirFromArgv,
  selectTargets,
} from "./lib.js";

try {
  const argv = guardArgs("init");
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
