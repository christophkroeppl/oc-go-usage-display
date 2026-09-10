#!/usr/bin/env node
// Remove the plugin installation from ~/.config/opencode: deletes the
// plugins/oc-go-usage-display.{ts,tsx} files (symlink or copy install) and
// removes the opencode.jsonc (server) + tui.json (TUI) entries.
// Secrets are never touched: env vars, auth.json, and
// oc-go-usage-display.json stay in place (delete them by hand if desired).
// Restart opencode afterwards to pick up the change.

import {
  fail,
  openCodeDirFromArgv,
  removePluginFiles,
  removeServerEntry,
  removeTuiEntry,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const configDir = openCodeDirFromArgv(argv);

  const files = removePluginFiles(configDir);
  const server = removeServerEntry(configDir);
  const tui = removeTuiEntry(configDir);

  for (const fileName of files.removed) console.log(`removed plugin file: ${fileName}`);
  for (const fileName of files.kept) console.log(`kept non-file entry (left alone): ${fileName}`);
  console.log(`server entry: ${server.changed ? "removed" : "already absent"}`);
  console.log(`tui entry: ${tui.changed ? "removed" : "already absent"}`);
  console.log(`uninstalled from ${configDir} (restart opencode to pick up the change)`);
} catch (error) {
  if (error instanceof Error) fail(error.message);
  throw error;
}
