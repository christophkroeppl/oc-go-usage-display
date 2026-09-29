#!/usr/bin/env node
// Update the installation: re-link plugin files, re-register config entries
// for the selected host(s), then fast-forward the repo (only when it has a
// remote; otherwise re-link is the update). Target selection matches init.
// Restart the host(s) afterwards to pick up changes.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

function hasRemote(repoDir) {
  try {
    const out = execFileSync("git", ["-C", repoDir, "remote"], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function isClean(repoDir) {
  try {
    const out = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

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

  if (!fs.existsSync(path.join(repoDir, ".git"))) fail(`not a git repo: ${repoDir}`);

  if (hasRemote(repoDir)) {
    if (!isClean(repoDir)) fail(`repo has local changes; commit or stash before updating: ${repoDir}`);
    execFileSync("git", ["-C", repoDir, "pull", "--ff-only"], { stdio: "inherit" });
  } else {
    console.log("no remote configured; re-linking local files (no fetch)");
  }

  console.log(`updated from ${repoDir} (${mode})`);
  for (const host of targets) {
    const configDir = hostDirFromArgv(host, argv);
    linkPluginFiles(repoDir, configDir, mode, host);
    const server = ensureServerEntry(configDir, { host });
    const tui = ensureTuiEntry(configDir, { sidebar, statusline, host });

    console.log(`${host}: ${configDir}`);
    console.log(`${host} server entry: ${server.present ? "present" : "missing"}`);
    if (host === "kilo") {
      console.log(`kilo tui entry: ${tui.entry ? "present" : "missing"}`);
    } else {
      console.log(`tui toggles: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
    }
  }
  console.log("restart the host(s) to pick up plugin changes");
} catch (error) {
  exitWithError(error);
}
