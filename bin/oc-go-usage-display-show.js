#!/usr/bin/env node
// Show the effective installation: link targets, config entries, toggles.
// Secrets are never printed; only presence (env/file) is reported.

import * as path from "node:path";
import {
  SERVER_FILE_NAME,
  TUI_FILE_NAME,
  TUI_PLUGIN_REL,
  SERVER_PLUGIN_REL,
  describeLink,
  fail,
  openCodeDirFromArgv,
  readJsonFile,
  readTuiSelection,
  repoDirFromArgv,
  secretPresence,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  const configDir = openCodeDirFromArgv(argv);
  const asJson = argv.includes("--json");

  const serverLink = describeLink(path.join(configDir, "plugins", SERVER_FILE_NAME));
  const tuiLink = describeLink(path.join(configDir, "plugins", TUI_FILE_NAME));
  const tui = readTuiSelection(configDir);
  const opencodeJson = readJsonFile(path.join(configDir, "opencode.jsonc"));
  const serverEntry =
    opencodeJson.found &&
    typeof opencodeJson.value === "object" &&
    opencodeJson.value !== null &&
    Array.isArray(opencodeJson.value.plugin) &&
    opencodeJson.value.plugin.includes(SERVER_PLUGIN_REL);
  const secrets = secretPresence(configDir);

  const report = {
    repoDir,
    configDir,
    server: { expected: SERVER_PLUGIN_REL, entry: serverEntry, ...serverLink },
    tui: {
      expected: TUI_PLUGIN_REL,
      entry: tui.entry,
      sidebar: tui.sidebar,
      statusline: tui.statusline,
      ...tuiLink,
    },
    secrets: { envPresent: secrets.envPresent, filePresent: secrets.filePresent },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`repo: ${repoDir}`);
    console.log(`config: ${configDir}`);
    console.log(`server: ${serverLink.state}${serverLink.detail ? ` -> ${serverLink.detail}` : ""} (entry: ${serverEntry ? "present" : "missing"})`);
    console.log(`tui: ${tuiLink.state}${tuiLink.detail ? ` -> ${tuiLink.detail}` : ""} (entry: ${tui.entry ? "present" : "missing"})`);
    console.log(`toggles: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
    console.log(`secrets: env=${secrets.envPresent ? "set" : "unset"} file=${secrets.filePresent ? "present" : "absent"} (values never shown)`);
  }
} catch (error) {
  if (error instanceof Error) fail(error.message);
  throw error;
}
