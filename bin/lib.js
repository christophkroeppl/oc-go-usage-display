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

export function fail(message) {
  throw new Error(`oc-go-usage-display: ${message}`);
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
  return path.join(os.homedir(), ".config", "opencode");
}

export function linkModeFromArgv(argv) {
  if (argv.includes("--copy")) return "copy";
  if (argv.includes("--symlink")) return "symlink";
  return "symlink";
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

export function linkPluginFiles(repoDir, configDir, mode) {
  const pluginsDir = path.join(configDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pairs = [
    [path.join(repoDir, "src", "index.ts"), path.join(pluginsDir, SERVER_FILE_NAME)],
    [path.join(repoDir, "src", "tui.tsx"), path.join(pluginsDir, TUI_FILE_NAME)],
  ];
  for (const [source, target] of pairs) {
    if (!fs.existsSync(source)) fail(`repo source missing: ${source}`);
    if (mode === "copy") {
      const stat = safeLstat(target);
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

export function ensureServerEntry(configDir, { create = true } = {}) {
  const filePath = path.join(configDir, "opencode.jsonc");
  const { found, value } = readJsonFile(filePath);
  if (!found) {
    if (!create) return { changed: false, present: false };
    writeJsonFile(filePath, { plugin: [SERVER_PLUGIN_REL] });
    return { changed: true, present: true };
  }
  if (!isRecord(value)) fail(`opencode.jsonc is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  if (plugins.includes(SERVER_PLUGIN_REL)) {
    return { changed: false, present: true };
  }
  value.plugin = [...plugins, SERVER_PLUGIN_REL];
  writeJsonFile(filePath, value);
  return { changed: true, present: true };
}

export function readTuiSelection(configDir) {
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  if (!found) return { found: false, entry: false, sidebar: null, statusline: null };
  const plugins = isRecord(value) && Array.isArray(value.plugin) ? value.plugin : [];
  for (const entry of plugins) {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) continue;
    if (normalized.spec !== TUI_PLUGIN_REL) continue;
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

export function ensureTuiEntry(configDir, { sidebar = null, statusline = null, create = true } = {}) {
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  const sidebarNext = sidebar ?? true;
  const statuslineNext = statusline ?? true;
  if (!found) {
    if (!create) return { changed: false, sidebar: null, statusline: null };
    writeJsonFile(filePath, { plugin: [[TUI_PLUGIN_REL, { sidebar: sidebarNext, statusline: statuslineNext }]] });
    return { changed: true, sidebar: sidebarNext, statusline: statuslineNext };
  }
  if (!isRecord(value)) fail(`tui.json is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  let changed = false;
  let seen = false;
  const next = plugins.map((entry) => {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) return entry;
    if (normalized.spec !== TUI_PLUGIN_REL) return entry;
    seen = true;
    const sidebarFinal = sidebar ?? normalized.sidebar ?? true;
    const statuslineFinal = statusline ?? normalized.statusline ?? true;
    if (
      normalized.spec === TUI_PLUGIN_REL &&
      Array.isArray(entry) &&
      isRecord(entry[1]) &&
      entry[1].sidebar === sidebarFinal &&
      entry[1].statusline === statuslineFinal
    ) {
      return entry;
    }
    changed = true;
    return [TUI_PLUGIN_REL, { sidebar: sidebarFinal, statusline: statuslineFinal }];
  });
  if (!seen) {
    next.push([TUI_PLUGIN_REL, { sidebar: sidebarNext, statusline: statuslineNext }]);
    changed = true;
  }
  if (changed) {
    value.plugin = next;
    writeJsonFile(filePath, value);
  }
  const selection = readTuiSelection(configDir);
  return { changed, sidebar: selection.sidebar, statusline: selection.statusline };
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

export function removePluginFiles(configDir) {
  const removed = [];
  const kept = [];
  for (const fileName of [SERVER_FILE_NAME, TUI_FILE_NAME]) {
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

export function removeServerEntry(configDir) {
  const filePath = path.join(configDir, "opencode.jsonc");
  const { found, value } = readJsonFile(filePath);
  if (!found) return { changed: false, present: false };
  if (!isRecord(value)) fail(`opencode.jsonc is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  if (!plugins.includes(SERVER_PLUGIN_REL)) return { changed: false, present: false };
  value.plugin = plugins.filter((entry) => entry !== SERVER_PLUGIN_REL);
  writeJsonFile(filePath, value);
  return { changed: true, present: false };
}

export function removeTuiEntry(configDir) {
  const filePath = path.join(configDir, "tui.json");
  const { found, value } = readJsonFile(filePath);
  if (!found) return { changed: false, present: false };
  if (!isRecord(value)) fail(`tui.json is not an object: ${filePath}`);
  const plugins = Array.isArray(value.plugin) ? value.plugin : [];
  const next = plugins.filter((entry) => {
    const normalized = normalizeTuiEntry(entry);
    if (normalized === null) return true;
    return normalized.spec !== TUI_PLUGIN_REL;
  });
  if (next.length === plugins.length) return { changed: false, present: false };
  value.plugin = next;
  writeJsonFile(filePath, value);
  return { changed: true, present: false };
}
