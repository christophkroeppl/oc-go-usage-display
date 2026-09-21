// Shared helpers for the oc-go-usage-display bin commands.
// Dependency-free (node:fs/os/path only). Secrets are never printed;
// only their presence is reported.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_PLUGIN_REL = "./plugins/oc-go-usage-display.ts";
export const TUI_PLUGIN_REL = "./plugins/oc-go-usage-display.tsx";
export const SERVER_FILE_NAME = "oc-go-usage-display.ts";
export const TUI_FILE_NAME = "oc-go-usage-display.tsx";

// Supported coding-agent hosts. Both ship the same source; the Kilo bundles are
// separate build outputs (host-specific auth roots) with `.kilo` filenames.
export const HOSTS = ["opencode", "kilo"];

// Per-host install layout. Kilo is a fork with its own config root
// ($KILO_CONFIG_DIR / $XDG_CONFIG_HOME/kilo), its own bundle filenames, and a
// tui.json schema that rejects `sidebar`/`statusline` (it would skip the whole
// file), so its TUI entry is registered without options.
const HOST_LAYOUTS = {
  opencode: {
    serverFile: "oc-go-usage-display.ts",
    tuiFile: "oc-go-usage-display.tsx",
    serverRel: "./plugins/oc-go-usage-display.ts",
    tuiRel: "./plugins/oc-go-usage-display.tsx",
    serverConfigFile: "opencode.jsonc",
    tuiOptions: true,
  },
  kilo: {
    serverFile: "oc-go-usage-display.kilo.ts",
    tuiFile: "oc-go-usage-display.kilo.tsx",
    serverRel: "./plugins/oc-go-usage-display.kilo.ts",
    tuiRel: "./plugins/oc-go-usage-display.kilo.tsx",
    serverConfigFile: "kilo.json",
    tuiOptions: false,
  },
};

export function hostLayout(host) {
  const layout = HOST_LAYOUTS[host];
  if (layout === undefined) fail(`unknown target: ${host} (expected ${HOSTS.join("/")})`);
  return layout;
}

// Plugin spec written into the host config. opencode resolves `./...` against
// its config dir (verified); Kilo does NOT (relative specs resolve against the
// project dir), so Kilo entries are absolute paths to the installed copy.
export function pluginSpec(host, configDir, kind) {
  const layout = hostLayout(host);
  const fileName = kind === "server" ? layout.serverFile : layout.tuiFile;
  if (host === "kilo") return path.join(configDir, "plugins", fileName);
  return kind === "server" ? layout.serverRel : layout.tuiRel;
}

export function fail(message) {
  if (message.startsWith("oc-go-usage-display: ")) throw new Error(message);
  throw new Error(`oc-go-usage-display: ${message}`);
}

// Format any thrown value as the single line the bin commands report, with the
// `oc-go-usage-display: ` prefix applied exactly once. Newlines and other
// whitespace runs collapse to single spaces so the one-line contract holds for
// multi-line messages (e.g. a wrapped npm error). Pure and never throws.
export function cliErrorMessage(error) {
  let raw;
  if (error instanceof Error) {
    raw = error.message;
  } else {
    try {
      raw = String(error);
    } catch {
      return "oc-go-usage-display: unknown error";
    }
  }
  const message = raw.replace(/\s+/g, " ").trim();
  if (message.length === 0) return "oc-go-usage-display: unknown error";
  if (message.startsWith("oc-go-usage-display: ")) return message;
  return `oc-go-usage-display: ${message}`;
}

// Top-level error boundary shared by every bin: one clean line on stderr (no
// stack trace, no rethrow) and exit 1. The synchronous fd write keeps the
// message from being truncated by `process.exit` when stderr is a pipe (npx).
export function exitWithError(error) {
  try {
    fs.writeSync(process.stderr.fd, `${cliErrorMessage(error)}\n`);
  } catch {
    // No writable stderr: the exit code still carries the failure.
  }
  process.exit(1);
}

export function repoDirFromArgv(argv) {
  const flagValue = readFlag(argv, "--repo");
  if (flagValue !== null) return path.resolve(flagValue);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function openCodeDirFromArgv(argv) {
  const flagValue = readFlag(argv, "--config-dir");
  if (flagValue !== null) return path.resolve(flagValue);
  const envValue = toNonEmptyString(process.env.OPENCODE_CONFIG_DIR);
  if (envValue !== null) return path.resolve(envValue);
  return path.join(process.env.HOME || os.homedir(), ".config", "opencode");
}

export function kiloDirFromArgv(argv) {
  const flagValue = readFlag(argv, "--kilo-config-dir");
  if (flagValue !== null) return path.resolve(flagValue);
  const envValue = toNonEmptyString(process.env.KILO_CONFIG_DIR);
  if (envValue !== null) return path.resolve(envValue);
  return path.join(xdgHome("XDG_CONFIG_HOME", [".config"]), "kilo");
}

export function hostDirFromArgv(host, argv) {
  return host === "kilo" ? kiloDirFromArgv(argv) : openCodeDirFromArgv(argv);
}

function xdgHome(key, fallbackSegments) {
  const envValue = toNonEmptyString(process.env[key]);
  if (envValue !== null) return envValue;
  return path.join(process.env.HOME || os.homedir(), ...fallbackSegments);
}

// Data dir the host stores auth.json in (never written here, detection only).
function hostDataDir(host) {
  return path.join(xdgHome("XDG_DATA_HOME", [".local", "share"]), host);
}

// PATH lookup without spawning: covers brew/npm/curl/source installs that put
// the binary on PATH. Never throws.
function executableOnPath(name) {
  const pathValue = toNonEmptyString(process.env.PATH);
  if (pathValue === null) return false;
  const names = process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const candidate of names) {
      try {
        if (fs.statSync(path.join(dir, candidate)).isFile()) return true;
      } catch {
        // Missing entries are the normal case while scanning PATH.
      }
    }
  }
  return false;
}

// Best-effort host detection; never fails an install. A host counts as
// installed when its binary is on PATH or its config/data dir exists, which
// covers every install flavor (brew, npm, curl, source checkout, portable).
export function detectHosts() {
  try {
    return {
      opencode:
        executableOnPath("opencode") ||
        fs.existsSync(openCodeDirFromArgv([])) ||
        fs.existsSync(hostDataDir("opencode")),
      kilo:
        executableOnPath("kilo") ||
        fs.existsSync(kiloDirFromArgv([])) ||
        fs.existsSync(hostDataDir("kilo")),
    };
  } catch {
    return { opencode: false, kilo: false };
  }
}

export function parseTargetList(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "both") return [...HOSTS];
  const targets = normalized.split(/[\s,]+/).filter((entry) => entry.length > 0);
  if (targets.length === 0) fail("--target requires opencode, kilo, or all");
  for (const target of targets) {
    if (target !== "opencode" && target !== "kilo") fail(`unknown target: ${target} (expected opencode/kilo/all)`);
  }
  return [...new Set(targets)];
}

// Parse a numbered multiselect answer ("1,2", "all", "" for the default).
export function parseTargetChoice(input, choices) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === "all" || trimmed === "both") return [...choices];
  const selected = [];
  for (const token of trimmed.split(/[\s,]+/).filter((entry) => entry.length > 0)) {
    const index = Number.parseInt(token, 10);
    if (!Number.isInteger(index) || index < 1 || index > choices.length || String(index) !== token) {
      fail(`invalid selection "${token}" (expected ${choices.map((_, i) => i + 1).join("/")} or Enter)`);
    }
    selected.push(choices[index - 1]);
  }
  return selected.length > 0 ? [...new Set(selected)] : [...choices];
}

// Targets for init/update. Explicit --target or a per-host --config-dir wins;
// otherwise one detected host installs silently, two or more offer the
// multiselect, and zero (or a non-interactive shell) defaults to all — a
// missing binary must never fail the install.
export function selectTargets(
  argv,
  { interactive = process.stdin.isTTY === true && process.stdout.isTTY === true } = {},
) {
  const targets = explicitTargets(argv);
  if (targets !== null) return targets;
  const detected = detectHosts();
  const installed = HOSTS.filter((host) => detected[host]);
  if (installed.length === 1) return installed;
  if (installed.length > 1 && interactive) return promptTargets(installed);
  return [...HOSTS];
}

// Removal never prompts: explicit flags pick hosts, otherwise both are visited
// (removing from a host without an install is a no-op).
export function resolveRemoveTargets(argv) {
  return explicitTargets(argv) ?? [...HOSTS];
}

// Status checks only the hosts that have something installed unless the caller
// asked for specific ones.
export function resolveStatusTargets(argv) {
  return explicitTargets(argv);
}

function explicitTargets(argv) {
  const explicit = readFlag(argv, "--target");
  if (explicit !== null) return parseTargetList(explicit);
  const dirTargets = [];
  if (readFlag(argv, "--config-dir") !== null) dirTargets.push("opencode");
  if (readFlag(argv, "--kilo-config-dir") !== null) dirTargets.push("kilo");
  return dirTargets.length > 0 ? dirTargets : null;
}

function promptTargets(installed) {
  process.stdout.write(
    `Detected coding agents: ${installed.map((host, index) => `${index + 1}) ${host}`).join("  ")}\n`,
  );
  process.stdout.write(`Install for [${installed.map((_, index) => index + 1).join(",")}] (Enter = all): `);
  let input = "";
  try {
    const buffer = Buffer.alloc(256);
    const bytes = fs.readSync(process.stdin.fd, buffer, 0, buffer.length, null);
    input = buffer.toString("utf8", 0, bytes);
  } catch {
    return [...installed];
  }
  return parseTargetChoice(input, installed);
}

export function linkModeFromArgv(argv) {
  if (argv.includes("--symlink")) return "symlink";
  if (argv.includes("--copy")) return "copy";
  return "copy";
}

export function readFlag(argv, name) {
  const prefix = `${name}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = argv.indexOf(name);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return null;
}

export function parseOptionalToggle(argv, name) {
  const raw = readFlag(argv, name);
  if (raw === null) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  fail(`invalid value for ${name}: expected 0/1/true/false, got ${JSON.stringify(raw)}`);
}

function toNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsonTolerant(text, filePath) {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to comment-stripped parse (JSONC).
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    fail(`cannot parse ${filePath} as JSON/JSONC`);
  }
}

export function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { found: false, value: null };
  }
  return { found: true, value: parseJsonTolerant(raw, filePath) };
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function linkPluginFiles(repoDir, configDir, mode, host = "opencode") {
  const layout = hostLayout(host);
  const pluginsDir = path.join(configDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  // Bundled self-contained outputs (no `./shared` import, no shared file):
  // `bun run build` produces dist/plugins/*, which is what gets installed.
  const pairs = [
    [path.join(repoDir, "dist", "plugins", layout.serverFile), path.join(pluginsDir, layout.serverFile)],
    [path.join(repoDir, "dist", "plugins", layout.tuiFile), path.join(pluginsDir, layout.tuiFile)],
  ];
  for (const [source, target] of pairs) {
    if (!fs.existsSync(source)) fail(`repo bundle missing: ${source} (run bun run build)`);
    if (mode === "copy") {
      const stat = safeLstat(target);
      if (stat?.isDirectory()) {
        // copyFileSync would fail with a raw EISDIR; fail fast with the fix.
        fail(`cannot replace a directory with the plugin file: ${target} (remove it, then re-run)`);
      }
      if (stat?.isSymbolicLink() || stat?.isFile()) fs.rmSync(target, { force: true });
      fs.copyFileSync(source, target);
      continue;
    }
    const existing = safeReadlink(target);
    if (existing !== null && path.resolve(path.dirname(target), existing) === source) continue;
    fs.rmSync(target, { force: true });
    fs.symlinkSync(source, target);
  }
}

function safeLstat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function safeReadlink(target) {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
}

export function describeLink(target) {
  const stat = safeLstat(target);
  if (stat === null) return { state: "missing", detail: null };
  if (stat.isSymbolicLink()) return { state: "symlink", detail: safeReadlink(target) };
  if (stat.isFile()) return { state: "file", detail: null };
  return { state: "other", detail: null };
}

export function isDanglingSymlink(target) {
  const stat = safeLstat(target);
  if (stat === null || !stat.isSymbolicLink()) return false;
  try {
    fs.statSync(target);
    return false;
  } catch {
    return true;
  }
}

export function ensureServerEntry(configDir, { create = true, host = "opencode" } = {}) {
  const layout = hostLayout(host);
  const spec = pluginSpec(host, configDir, "server");
  const filePath = path.join(configDir, layout.serverConfigFile);
  const { found, value } = readJsonFile(filePath);
  if (!found) {
    if (!create) return { changed: false, present: false };
    writeJsonFile(filePath, { plugin: [spec] });
    return { changed: true, present: true };
  }
  if (!isRecord(value)) fail(`${layout.serverConfigFile} is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  if (plugins.includes(spec)) {
    return { changed: false, present: true };
  }
  value.plugin = [...plugins, spec];
  writeJsonFile(filePath, value);
  return { changed: true, present: true };
}

export function readTuiSelection(configDir, host = "opencode") {
  const spec = pluginSpec(host, configDir, "tui");
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  if (!found) return { found: false, entry: false, sidebar: null, statusline: null };
  const plugins = isRecord(value) && Array.isArray(value.plugin) ? value.plugin : [];
  for (const entry of plugins) {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) continue;
    if (normalized.spec !== spec) continue;
    return { found: true, entry: true, sidebar: normalized.sidebar, statusline: normalized.statusline };
  }
  return { found: true, entry: false, sidebar: null, statusline: null };
}

export function normalizeTuiEntry(entry) {
  if (typeof entry === "string") return { spec: entry, sidebar: null, statusline: null };
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const options = entry.length > 1 && isRecord(entry[1]) ? entry[1] : {};
  return {
    spec: entry[0],
    sidebar: typeof options.sidebar === "boolean" ? options.sidebar : null,
    statusline: typeof options.statusline === "boolean" ? options.statusline : null,
  };
}

export function ensureTuiEntry(
  configDir,
  { sidebar = null, statusline = null, create = true, host = "opencode" } = {},
) {
  const layout = hostLayout(host);
  if (!layout.tuiOptions && (sidebar !== null || statusline !== null)) {
    fail(`--sidebar/--statusline do not apply to ${host} (its tui.json rejects those options)`);
  }
  const spec = pluginSpec(host, configDir, "tui");
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  const sidebarNext = sidebar ?? true;
  const statuslineNext = statusline ?? true;
  // Kilo rejects `sidebar`/`statusline` and skips the whole file, so its entry
  // stays a plain plugin spec without options.
  const desiredEntry = layout.tuiOptions
    ? [spec, { sidebar: sidebarNext, statusline: statuslineNext }]
    : spec;
  if (!found) {
    if (!create) return { changed: false, entry: false, sidebar: null, statusline: null };
    writeJsonFile(filePath, { plugin: [desiredEntry] });
    return {
      changed: true,
      entry: true,
      sidebar: layout.tuiOptions ? sidebarNext : null,
      statusline: layout.tuiOptions ? statuslineNext : null,
    };
  }
  if (!isRecord(value)) fail(`tui.json is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  let changed = false;
  let seen = false;
  const next = plugins.map((entry) => {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) return entry;
    if (normalized.spec !== spec) return entry;
    seen = true;
    if (!layout.tuiOptions) {
      if (typeof entry === "string") return entry;
      changed = true;
      return spec;
    }
    const sidebarFinal = sidebar ?? normalized.sidebar ?? true;
    const statuslineFinal = statusline ?? normalized.statusline ?? true;
    if (
      Array.isArray(entry) &&
      isRecord(entry[1]) &&
      entry[1].sidebar === sidebarFinal &&
      entry[1].statusline === statuslineFinal
    ) {
      return entry;
    }
    changed = true;
    return [spec, { sidebar: sidebarFinal, statusline: statuslineFinal }];
  });
  if (!seen) {
    next.push(desiredEntry);
    changed = true;
  }
  if (changed) {
    value.plugin = next;
    writeJsonFile(filePath, value);
  }
  const selection = readTuiSelection(configDir, host);
  return { changed, entry: selection.entry, sidebar: selection.sidebar, statusline: selection.statusline };
}

export function secretPresence(configDir) {
  const candidates = [
    process.env.OPENCODE_GO_API_KEY,
    process.env.OPENCODE_GO_AUTH_COOKIE,
    process.env.OPENCODE_GO_WORKSPACE_ID,
  ];
  const envPresent = candidates.some((value) => toNonEmptyString(value) !== null);
  const fileConfig = path.join(configDir, "oc-go-usage-display.json");
  return {
    envPresent,
    filePresent: fs.existsSync(fileConfig),
  };
}

export function removePluginFiles(configDir, host = "opencode") {
  const layout = hostLayout(host);
  const removed = [];
  const kept = [];
  for (const fileName of [layout.serverFile, layout.tuiFile]) {
    const target = path.join(configDir, "plugins", fileName);
    const stat = safeLstat(target);
    if (stat === null) continue;
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.rmSync(target, { force: true });
      removed.push(fileName);
    } else {
      kept.push(fileName);
    }
  }
  return { removed, kept };
}

export function removeServerEntry(configDir, { host = "opencode" } = {}) {
  const layout = hostLayout(host);
  const spec = pluginSpec(host, configDir, "server");
  const filePath = path.join(configDir, layout.serverConfigFile);
  const { found, value } = readJsonFile(filePath);
  if (!found) return { changed: false, present: false };
  if (!isRecord(value)) fail(`${layout.serverConfigFile} is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  if (!plugins.includes(spec)) return { changed: false, present: false };
  value.plugin = plugins.filter((entry) => entry !== spec);
  writeJsonFile(filePath, value);
  return { changed: true, present: false };
}

export function removeTuiEntry(configDir, host = "opencode") {
  const spec = pluginSpec(host, configDir, "tui");
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  if (!found) return { changed: false, present: false };
  if (!isRecord(value)) fail(`tui.json is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  const next = plugins.filter((entry) => {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) return true;
    return normalized.spec !== spec;
  });
  if (next.length === plugins.length) return { changed: false, present: false };
  value.plugin = next;
  writeJsonFile(filePath, value);
  return { changed: true, present: false };
}

// Effective install report for one host (show/status share this so the two
// commands can never disagree about what "installed" means).
export function describeHostInstall(host, configDir) {
  const layout = hostLayout(host);
  const serverSpec = pluginSpec(host, configDir, "server");
  const tuiSpec = pluginSpec(host, configDir, "tui");
  const pluginsDir = path.join(configDir, "plugins");
  const serverLink = describeLink(path.join(pluginsDir, layout.serverFile));
  const tuiLink = describeLink(path.join(pluginsDir, layout.tuiFile));
  const serverConfig = readJsonFile(path.join(configDir, layout.serverConfigFile));
  const serverEntry =
    serverConfig.found &&
    isRecord(serverConfig.value) &&
    Array.isArray(serverConfig.value.plugin) &&
    serverConfig.value.plugin.includes(serverSpec);
  const tui = readTuiSelection(configDir, host);
  return {
    configDir,
    server: { expected: serverSpec, entry: serverEntry, ...serverLink },
    tui: {
      expected: tuiSpec,
      entry: tui.entry,
      sidebar: tui.sidebar,
      statusline: tui.statusline,
      ...tuiLink,
    },
  };
}

// Health check for one host: symlinks must point at this repo, copy installs
// are accepted with a note, config entries must exist (toggles only where the
// host supports them).
export function checkHostInstall(host, configDir, repoDir) {
  const layout = hostLayout(host);
  const problems = [];
  const notes = [];
  const expectedServer = path.join(repoDir, "dist", "plugins", layout.serverFile);
  const expectedTui = path.join(repoDir, "dist", "plugins", layout.tuiFile);
  const serverPath = path.join(configDir, "plugins", layout.serverFile);
  const tuiPath = path.join(configDir, "plugins", layout.tuiFile);

  // Copy installs intentionally diverge, so a stale copy stays NOTE (never
  // FAIL): users who pin a copy must not break on every repo update.
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

  function checkPlugin(label, link, installedPath, expected) {
    if (link.state === "symlink") {
      if (isDanglingSymlink(installedPath)) {
        problems.push(`${label} symlink target missing (dangling): ${link.detail ?? ""} (re-run install or build)`);
      } else if (path.resolve(configDir, "plugins", link.detail ?? "") !== expected) {
        problems.push(`${label} symlink points at ${link.detail ?? ""}, expected ${expected}`);
      }
    } else if (link.state === "file") {
      if (copyMatchesRepo(installedPath, expected)) {
        notes.push(`${label} plugin is a copy install (file, matches repo)`);
      } else {
        notes.push(`${label} copy install differs from repo ${expected}`);
      }
    } else {
      problems.push(`${label} plugin is ${link.state}, expected symlink -> ${expected}`);
    }
  }

  checkPlugin("server", describeLink(serverPath), serverPath, expectedServer);
  checkPlugin("tui", describeLink(tuiPath), tuiPath, expectedTui);

  const serverConfig = readJsonFile(path.join(configDir, layout.serverConfigFile));
  const serverEntry =
    serverConfig.found &&
    isRecord(serverConfig.value) &&
    Array.isArray(serverConfig.value.plugin) &&
    serverConfig.value.plugin.includes(pluginSpec(host, configDir, "server"));
  if (!serverEntry) problems.push(`${layout.serverConfigFile} is missing the server plugin entry`);

  const tui = readTuiSelection(configDir, host);
  if (!tui.entry) problems.push("tui.json is missing the tui plugin entry");
  if (layout.tuiOptions && (tui.sidebar === null || tui.statusline === null)) {
    problems.push(`tui toggles incomplete: sidebar=${tui.sidebar} statusline=${tui.statusline}`);
  }
  return { problems, notes };
}
