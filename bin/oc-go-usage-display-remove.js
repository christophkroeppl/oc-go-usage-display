#!/usr/bin/env node
// Remove the plugin installation: deletes the installed plugin files (symlink
// or copy install) and removes the server + TUI config entries for each
// selected host. Default: every host (removing where nothing is installed is a
// no-op); --target or --config-dir / --kilo-config-dir narrows it.
// Secrets are never touched: env vars, auth.json, and
// oc-go-usage-display.json stay in place (delete them by hand if desired).
// Restart the host(s) afterwards to pick up the change.

import {
  exitWithError,
  hostDirFromArgv,
  removePluginFiles,
  removeServerEntry,
  removeTuiEntry,
  resolveRemoveTargets,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const targets = resolveRemoveTargets(argv);

  for (const host of targets) {
    const configDir = hostDirFromArgv(host, argv);
    const files = removePluginFiles(configDir, host);
    const server = removeServerEntry(configDir, { host });
    const tui = removeTuiEntry(configDir, host);

    console.log(`${host}: ${configDir}`);
    for (const fileName of files.removed) console.log(`removed plugin file: ${fileName}`);
    for (const fileName of files.kept) console.log(`kept non-file entry (left alone): ${fileName}`);
    console.log(`${host} server entry: ${server.changed ? "removed" : "already absent"}`);
    console.log(`${host} tui entry: ${tui.changed ? "removed" : "already absent"}`);
  }
  console.log("uninstalled (restart the host(s) to pick up the change)");
} catch (error) {
  exitWithError(error);
}
