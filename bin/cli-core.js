// Pure CLI core for the bin commands: host list, error formatting, argument
// validation and target selection. This module imports NOTHING on purpose --
// `scripts/check-unit-purity.mjs` holds it to the same rule as the pure test
// helpers, so every function below takes plain data and returns plain data.
// Everything that touches the filesystem, PATH or stdin lives in `lib.js` and
// in the bins.

// Supported coding-agent hosts. Both ship the same source; the Kilo bundles are
// separate build outputs (host-specific auth roots) with `.kilo` filenames.
export const HOSTS = ["opencode", "kilo"];

// SGR 9 (strike-through) marks a host whose binary is not on PATH in the init
// prompt. Emitted only for a TTY, so redirected output and test fixtures stay
// plain text.
export const ANSI_STRIKE = "\u001B[9m";
export const ANSI_RESET = "\u001B[0m";

// Every bin this package installs. `init <other-bin>` is the argument mistake
// that used to install instead of erroring, so a positional naming one of these
// gets the sibling command suggested back.
export const COMMANDS = ["init", "remove", "show", "status", "update"];

// Accepted argv per command: `values` take an argument (either `--flag value`
// or `--flag=value`), `switches` take none. Anything else is rejected, which is
// what keeps an unrecognized positional from being read as "install".
export const COMMAND_ARGS = {
  init: {
    values: {
      "--target": "opencode|kilo|all",
      "--config-dir": "path",
      "--kilo-config-dir": "path",
      "--repo": "path",
      "--sidebar": "0|1",
      "--statusline": "0|1",
    },
    switches: ["--copy", "--symlink", "--help", "-h"],
  },
  remove: {
    values: { "--target": "opencode|kilo|all", "--config-dir": "path", "--kilo-config-dir": "path" },
    switches: ["--help", "-h"],
  },
  show: {
    values: { "--config-dir": "path", "--kilo-config-dir": "path", "--repo": "path" },
    switches: ["--json", "--help", "-h"],
  },
  status: {
    values: { "--target": "opencode|kilo|all", "--config-dir": "path", "--kilo-config-dir": "path", "--repo": "path" },
    switches: ["--help", "-h"],
  },
  update: {
    values: {
      "--target": "opencode|kilo|all",
      "--config-dir": "path",
      "--kilo-config-dir": "path",
      "--repo": "path",
      "--sidebar": "0|1",
      "--statusline": "0|1",
    },
    switches: ["--copy", "--symlink", "--help", "-h"],
  },
};

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

// Parse a numbered multiselect answer ("1,2", "all", "" for `defaults`).
export function parseTargetChoice(input, choices, defaults = choices) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return [...defaults];
  if (trimmed === "all" || trimmed === "both") return [...choices];
  const selected = [];
  for (const token of trimmed.split(/[\s,]+/).filter((entry) => entry.length > 0)) {
    const index = Number.parseInt(token, 10);
    if (!Number.isInteger(index) || index < 1 || index > choices.length || String(index) !== token) {
      fail(`invalid selection "${token}" (expected ${choices.map((_, i) => i + 1).join("/")} or Enter)`);
    }
    selected.push(choices[index - 1]);
  }
  return selected.length > 0 ? [...new Set(selected)] : [...defaults];
}

// The exact text init prints before reading stdin: both hosts, a struck-through
// host whose binary is not on PATH, and the default marked in the question.
export function renderTargetPrompt(rows, { color = false } = {}) {
  const choices = rows.map((row) => row.host);
  const defaults = defaultTargets(rows);
  const numbers = defaults.map((host) => choices.indexOf(host) + 1).join(",");
  const lines = rows.map((row, index) => `  ${index + 1}) ${hostLabel(row, color)}`);
  return [
    "Install the plugin into which host(s)?",
    ...lines,
    `Install for [${numbers}] (Enter = default, or list numbers e.g. 1,2): `,
  ].join("\n");
}

// Hosts the prompt preselects: the ones with a binary on PATH, or every host
// when nothing was found (a portable install must still be installable).
export function defaultTargets(rows) {
  const onPath = rows.filter((row) => row.onPath).map((row) => row.host);
  return onPath.length > 0 ? onPath : rows.map((row) => row.host);
}

export function hostLabel(row, color = false) {
  if (row.onPath) return row.host;
  const note = "  (binary not on PATH)";
  return color ? `${ANSI_STRIKE}${row.host}${ANSI_RESET}${note}` : `${row.host}${note}`;
}

// Answer the numbered prompt. A struck-through host stays selectable by number:
// a user may be pre-installing config for an app they have not installed yet.
export function chooseTargets(rows, answer) {
  const choices = rows.map((row) => row.host);
  return parseTargetChoice(typeof answer === "string" ? answer : "", choices, defaultTargets(rows));
}

// What init does before it may touch a config: return the targets outright, or
// hand back the prompt to print and the answer to resolve. A non-interactive run
// takes every host and never prompts, so a piped/CI invocation cannot hang.
export function planTargets({ rows, interactive, color = false }) {
  if (!interactive) return { kind: "auto", targets: rows.map((row) => row.host) };
  return { kind: "prompt", prompt: renderTargetPrompt(rows, { color }) };
}

export function wantsHelp(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

// Reject unknown flags and unknown positionals. Fail closed: a typo or a
// mistaken subcommand must never fall through to "install".
export function assertKnownArgs(command, argv) {
  const spec = COMMAND_ARGS[command];
  if (spec === undefined) fail(`unknown command: ${command}`);
  const accepted = flagList(spec);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-")) {
      const sibling = COMMANDS.includes(arg) ? `; run "oc-go-usage-display-${arg}" instead` : "";
      fail(`unexpected argument "${arg}" (oc-go-usage-display-${command} takes flags only: ${accepted})${sibling}`);
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (spec.switches.includes(name)) {
      if (equals !== -1) fail(`unexpected argument "${arg}" (${name} takes no value)`);
      continue;
    }
    const hint = spec.values[name];
    if (hint === undefined) {
      fail(`unexpected argument "${name}" (oc-go-usage-display-${command} takes: ${accepted})`);
    }
    if (equals !== -1) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for ${name} (expected ${hint})`);
    }
    index += 1;
  }
  return { help: wantsHelp(argv) };
}

// `--help` text, generated from the accepted-argument table so it can never
// drift from what the parser actually takes.
export function usageFor(command) {
  const spec = COMMAND_ARGS[command];
  if (spec === undefined) fail(`unknown command: ${command}`);
  const values = Object.entries(spec.values).map(([name, hint]) => `  ${name} <${hint}>`);
  const switches = spec.switches.map((name) => `  ${name}`);
  return [
    `usage: oc-go-usage-display-${command} [flags]`,
    "",
    "flags with a value:",
    ...values,
    "flags without a value:",
    ...switches,
  ].join("\n");
}

function flagList(spec) {
  const values = Object.entries(spec.values).map(([name, hint]) => `${name} <${hint}>`);
  return [...values, ...spec.switches].join(" ");
}
