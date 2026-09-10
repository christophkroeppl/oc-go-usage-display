#!/usr/bin/env node
// Check the installation. Exit 0 when healthy, 1 with reasons otherwise.
// Verifies: plugin files point at this repo (symlinks verified by target,
// plain-file copy installs accepted with a note), config entries exist,
// toggles set.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SERVER_FILE_NAME,
  TUI_FILE_NAME,
  describeLink,
  fail,
  openCodeDirFromArgv,
  readJsonFile,
  SERVER_PLUGIN_REL,
  readTuiSelection,
  repoDirFromArgv,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  const configDir = openCodeDirFromArgv(argv);
  const problems = [];

  const expectedServer = path.join(repoDir, "src", "index.ts");
  const expectedTui = path.join(repoDir, "src", "tui.tsx");
  const serverLink = describeLink(path.join(configDir, "plugins", SERVER_FILE_NAME));
  const tuiLink = describeLink(path.join(configDir, "plugins", TUI_FILE_NAME));
  const notes = [];

  // Copy installs intentionally diverge, so a stale copy stays NOTE + exit 0
  // (never FAIL): users who pin a copy must not break on every repo update.
  function copyMatchesRepo(installedPath, repoPath) {
    let installed;
    let source;
    try {
      installed = fs.readFileSync(installedPath, "utf8");
      source = fs.readFileSync(repoPath, "utf8");
    } catch {
      return false;
    }
    return installed === source;
  }

  if (serverLink.state === "symlink") {
    if (path.resolve(configDir, "plugins", serverLink.detail ?? "") !== expectedServer) {
      problems.push(`server symlink points at ${serverLink.detail}, expected ${expectedServer}`);
    }
  } else if (serverLink.state === "file") {
    if (copyMatchesRepo(path.join(configDir, "plugins", SERVER_FILE_NAME), expectedServer)) {
      notes.push("server plugin is a copy install (file, matches repo)");
    } else {
      notes.push(`server copy install differs from repo ${expectedServer}`);
    }
  } else {
    problems.push(`server plugin is ${serverLink.state}, expected symlink -> ${expectedServer}`);
  }
  if (tuiLink.state === "symlink") {
    if (path.resolve(configDir, "plugins", tuiLink.detail ?? "") !== expectedTui) {
      problems.push(`tui symlink points at ${tuiLink.detail}, expected ${expectedTui}`);
    }
  } else if (tuiLink.state === "file") {
    if (copyMatchesRepo(path.join(configDir, "plugins", TUI_FILE_NAME), expectedTui)) {
      notes.push("tui plugin is a copy install (file, matches repo)");
    } else {
      notes.push(`tui copy install differs from repo ${expectedTui}`);
    }
  } else {
    problems.push(`tui plugin is ${tuiLink.state}, expected symlink -> ${expectedTui}`);
  }

  const opencodeJson = readJsonFile(path.join(configDir, "opencode.jsonc"));
  const serverEntry =
    opencodeJson.found &&
    typeof opencodeJson.value === "object" &&
    opencodeJson.value !== null &&
    Array.isArray(opencodeJson.value.plugin) &&
    opencodeJson.value.plugin.includes(SERVER_PLUGIN_REL);
  if (!serverEntry) problems.push("opencode.jsonc is missing the server plugin entry");

  const tui = readTuiSelection(configDir);
  if (!tui.entry) problems.push("tui.json is missing the tui plugin entry");
  if (tui.sidebar === null || tui.statusline === null) {
    problems.push(`tui toggles incomplete: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exitCode = 1;
  } else {
    for (const note of notes) console.log(`NOTE: ${note}`);
    console.log(`OK: installed from ${repoDir} (sidebar=${tui.sidebar} statusline=${tui.statusline})`);
  }
} catch (error) {
  if (error instanceof Error) fail(error.message);
  throw error;
}
