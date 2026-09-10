#!/usr/bin/env node
// Update the installation: re-link plugin files, re-register config entries,
// then fast-forward the repo (only when it has a remote; otherwise re-link is
// the update). Restart opencode afterwards to pick up changes.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
  const configDir = openCodeDirFromArgv(argv);
  const mode = linkModeFromArgv(argv);
  const sidebar = parseOptionalToggle(argv, "--sidebar");
  const statusline = parseOptionalToggle(argv, "--statusline");

  if (!fs.existsSync(path.join(repoDir, ".git"))) fail(`not a git repo: ${repoDir}`);

  if (hasRemote(repoDir)) {
    if (!isClean(repoDir)) fail(`repo has local changes; commit or stash before updating: ${repoDir}`);
    execFileSync("git", ["-C", repoDir, "pull", "--ff-only"], { stdio: "inherit" });
  } else {
    console.log("no remote configured; re-linking local files (no fetch)");
  }

  linkPluginFiles(repoDir, configDir, mode);
  const server = ensureServerEntry(configDir);
  const tui = ensureTuiEntry(configDir, { sidebar, statusline });

  console.log(`updated from ${repoDir} (${mode})`);
  console.log(`server entry: ${server.present ? "present" : "missing"}`);
  console.log(`tui toggles: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
  console.log("restart opencode to pick up plugin changes");
} catch (error) {
  if (error instanceof Error) fail(error.message);
  throw error;
}
