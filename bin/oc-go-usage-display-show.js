#!/usr/bin/env node
// Show the effective installation for every host: link targets, config
// entries, toggles, and detection. The top-level fields stay the opencode
// report (back-compat); `kilo` and `opencodeV2` carry their own reports.
// Secrets are never printed; only presence (env/file) is reported.

import {
  HOSTS,
  describeHostInstall,
  detectHosts,
  exitWithError,
  guardArgs,
  hostDirFromArgv,
  repoDirFromArgv,
  secretPresence,
} from "./lib.js";

try {
  const argv = guardArgs("show");
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
  const v2 = hosts["opencode-v2"];
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
    opencodeV2: {
      configDir: v2.configDir,
      server: v2.server,
      tui: v2.tui,
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
    console.log(`opencode-v2: ${v2.configDir} (detected: ${detected["opencode-v2"] ? "yes" : "no"})`);
    console.log(describeLinkLine("  server", v2.server, v2.server.entry));
    console.log(describeLinkLine("  tui", v2.tui, v2.tui.entry));
  }
} catch (error) {
  exitWithError(error);
}
