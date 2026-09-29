#!/usr/bin/env node
// Check the installation. Exit 0 when healthy, 1 with reasons otherwise.
// Verifies: bundled plugin files (dist/plugins/*) point at this repo
// (symlinks verified by target, dangling symlinks reported unhealthy,
// plain-file copy installs accepted with a note), config entries exist,
// toggles set (opencode only; Kilo's tui.json rejects them).
// Without an explicit target it checks the hosts that have an installation and
// falls back to opencode.

import {
  HOSTS,
  checkHostInstall,
  describeHostInstall,
  exitWithError,
  hostDirFromArgv,
  repoDirFromArgv,
  resolveStatusTargets,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  let targets = resolveStatusTargets(argv);

  if (targets === null) {
    targets = HOSTS.filter((host) => {
      const report = describeHostInstall(host, hostDirFromArgv(host, argv));
      return (
        report.server.state !== "missing" ||
        report.tui.state !== "missing" ||
        report.server.entry ||
        report.tui.entry
      );
    });
    if (targets.length === 0) targets = ["opencode"];
  }

  const problems = [];
  const notes = [];
  for (const host of targets) {
    const report = checkHostInstall(host, hostDirFromArgv(host, argv), repoDir);
    for (const problem of report.problems) problems.push(`${host}: ${problem}`);
    for (const note of report.notes) notes.push(`${host}: ${note}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exitCode = 1;
  } else {
    for (const note of notes) console.log(`NOTE: ${note}`);
    console.log(`OK: installed from ${repoDir} (targets: ${targets.join(", ")})`);
  }
} catch (error) {
  exitWithError(error);
}
