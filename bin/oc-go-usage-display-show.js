#!/usr/bin/env node
// Show the effective installation for both hosts: link targets, config
// entries, toggles, and detection. The top-level fields stay the opencode
// report (back-compat); `kilo` carries the Kilo report.
// Secrets are never printed; only presence (env/file) is reported.

import {
  HOSTS,
  describeHostInstall,
  detectHosts,
  exitWithError,
  hostDirFromArgv,
  repoDirFromArgv,
  secretPresence,
} from "./lib.js";

try {
  const argv = process.argv.slice(2);
  const repoDir = repoDirFromArgv(argv);
  const asJson = argv.includes("--json");
  const detected = detectHosts();

  const hosts = {};
  for (const host of HOSTS) {
    const configDir = hostDirFromArgv(host, argv);
    hosts[host] = { ...describeHostInstall(host, configDir), detected: detected[host] === true };
  }

  const opencode = hosts.opencode;
  const kilo = hosts.kilo;
  const secrets = secretPresence(opencode.configDir);
  const kiloSecrets = secretPresence(kilo.configDir);

  const report = {
    repoDir,
    configDir: opencode.configDir,
    detected,
    server: opencode.server,
    tui: opencode.tui,
    secrets: { envPresent: secrets.envPresent, filePresent: secrets.filePresent },
    kilo: {
      configDir: kilo.configDir,
      server: kilo.server,
      tui: kilo.tui,
      secrets: { envPresent: kiloSecrets.envPresent, filePresent: kiloSecrets.filePresent },
    },
  };

  function describeLinkLine(label, link, entry) {
    return `${label}: ${link.state}${link.detail ? ` -> ${link.detail}` : ""} (entry: ${entry ? "present" : "missing"})`;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`repo: ${repoDir}`);
    console.log(`opencode: ${opencode.configDir} (detected: ${detected.opencode ? "yes" : "no"})`);
    console.log(describeLinkLine("  server", opencode.server, opencode.server.entry));
    console.log(describeLinkLine("  tui", opencode.tui, opencode.tui.entry));
    console.log(`  toggles: sidebar=${opencode.tui.sidebar} statusline=${opencode.tui.statusline}`);
    console.log(
      `  secrets: env=${secrets.envPresent ? "set" : "unset"} file=${secrets.filePresent ? "present" : "absent"} (values never shown)`,
    );
    console.log(`kilo: ${kilo.configDir} (detected: ${detected.kilo ? "yes" : "no"})`);
    console.log(describeLinkLine("  server", kilo.server, kilo.server.entry));
    console.log(describeLinkLine("  tui", kilo.tui, kilo.tui.entry));
    console.log(
      `  secrets: env=${kiloSecrets.envPresent ? "set" : "unset"} file=${kiloSecrets.filePresent ? "present" : "absent"} (values never shown)`,
    );
  }
} catch (error) {
  exitWithError(error);
}
