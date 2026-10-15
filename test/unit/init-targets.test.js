// Unit tier: `bin/cli-core.js` — the pure decision logic behind `init`'s host
// prompt and every bin's argument guard. `bin/lib.js` wraps it with the
// PATH/filesystem/stdin I/O, so everything tested here is a function of plain
// data only.
//
// The behaviour these pin is a safety contract, not cosmetics:
//   - a human on a TTY is ALWAYS asked, including when one host is available;
//   - `--target` / `--config-dir` short-circuit and never prompt;
//   - a non-interactive run takes every host and never reads stdin (no hang);
//   - a host whose binary is not on PATH is struck through and unselected;
//   - an unrecognized argument is an error, never a silent full install.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANSI_RESET,
  ANSI_STRIKE,
  chooseTargets,
  COMMAND_ARGS,
  assertKnownArgs,
  defaultTargets,
  hostLabel,
  parseTargetChoice,
  parseTargetList,
  planTargets,
  renderTargetPrompt,
  usageFor,
} from "../../bin/cli-core.js";

const BOTH_ON_PATH = [
  { host: "opencode", onPath: true, configured: true },
  { host: "kilo", onPath: true, configured: true },
];
const ONLY_OPENCODE = [
  { host: "opencode", onPath: true, configured: true },
  { host: "kilo", onPath: false, configured: true },
];
const NEITHER_ON_PATH = [
  { host: "opencode", onPath: false, configured: false },
  { host: "kilo", onPath: false, configured: true },
];

// --- the prompt: a human is always asked ---

test("an interactive human is prompted even when only one host is available", () => {
  const plan = planTargets({ rows: ONLY_OPENCODE, interactive: true });
  assert.equal(plan.kind, "prompt");
  assert.match(plan.prompt, /1\) opencode/);
  assert.match(plan.prompt, /2\) kilo/);
});

test("a host with only a config dir is still offered, and not preselected", () => {
  const plan = planTargets({ rows: NEITHER_ON_PATH, interactive: true, color: false });
  assert.equal(plan.kind, "prompt");
  assert.match(plan.prompt, /1\) opencode {2}\(binary not on PATH\)/);
  // Kilo has a config dir but no binary: offered, struck through, unselected.
  assert.match(plan.prompt, /2\) kilo {2}\(binary not on PATH\)/);
  // Nothing detected on PATH: the default falls back to both hosts rather than
  // selecting nothing and installing nothing.
  assert.deepStrictEqual(defaultTargets(NEITHER_ON_PATH), ["opencode", "kilo"]);
  assert.match(plan.prompt, /Install for \[1,2\]/);
});

test("the default is the hosts whose binary is on PATH", () => {
  assert.deepStrictEqual(defaultTargets(ONLY_OPENCODE), ["opencode"]);
  assert.deepStrictEqual(defaultTargets(BOTH_ON_PATH), ["opencode", "kilo"]);
  assert.match(renderTargetPrompt(ONLY_OPENCODE), /Install for \[1\]/);
});

test("a struck-through host is de-emphasised but stays selectable by number", () => {
  assert.deepStrictEqual(chooseTargets(ONLY_OPENCODE, "2"), ["kilo"]);
  assert.deepStrictEqual(chooseTargets(ONLY_OPENCODE, "1,2"), ["opencode", "kilo"]);
  assert.deepStrictEqual(chooseTargets(ONLY_OPENCODE, "all"), ["opencode", "kilo"]);
  // Enter takes the default, which excludes the struck-through host.
  assert.deepStrictEqual(chooseTargets(ONLY_OPENCODE, ""), ["opencode"]);
  assert.deepStrictEqual(chooseTargets(ONLY_OPENCODE, undefined), ["opencode"]);
});

test("ANSI strike-through is emitted only when color is on", () => {
  const plain = hostLabel({ host: "kilo", onPath: false }, false);
  const colored = hostLabel({ host: "kilo", onPath: false }, true);
  assert.equal(plain.includes("\u001B["), false, `plain label must carry no ANSI: ${JSON.stringify(plain)}`);
  assert.equal(colored, `${ANSI_STRIKE}kilo${ANSI_RESET}  (binary not on PATH)`);
  assert.equal(ANSI_STRIKE, "\u001B[9m");
  // A host on PATH is never struck, colored or not.
  assert.equal(hostLabel({ host: "opencode", onPath: true }, true), "opencode");
  assert.ok(!renderTargetPrompt(ONLY_OPENCODE, { color: false }).includes("\u001B"));
  assert.ok(renderTargetPrompt(ONLY_OPENCODE, { color: true }).includes(ANSI_STRIKE));
});

test("the rendered prompt is plain text without a TTY and marked with one", () => {
  const plain = renderTargetPrompt(ONLY_OPENCODE, { color: false });
  assert.equal(plain, [
    "Install the plugin into which host(s)?",
    "  1) opencode",
    "  2) kilo  (binary not on PATH)",
    "Install for [1] (Enter = default, or list numbers e.g. 1,2): ",
  ].join("\n"));
  assert.ok(!renderTargetPrompt(ONLY_OPENCODE, { color: true }).includes("  2) kilo  (binary"), "color must mark the host only");
});

// --- the non-interactive path: safe default, no hang ---

test("a non-interactive run takes every host and renders no prompt", () => {
  for (const rows of [BOTH_ON_PATH, ONLY_OPENCODE, NEITHER_ON_PATH]) {
    const plan = planTargets({ rows, interactive: false });
    assert.equal(plan.kind, "auto");
    assert.deepStrictEqual(plan.targets, ["opencode", "kilo"]);
    assert.equal("prompt" in plan, false, "a non-interactive plan must carry no prompt to print");
  }
});

// --- parseTargetList semantics are unchanged ---

test("parseTargetList keeps its documented semantics", () => {
  assert.deepStrictEqual(parseTargetList("kilo"), ["kilo"]);
  assert.deepStrictEqual(parseTargetList("all"), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetList("both"), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetList("kilo,opencode"), ["kilo", "opencode"]);
  assert.deepStrictEqual(parseTargetList(" kilo  opencode "), ["kilo", "opencode"]);
  assert.deepStrictEqual(parseTargetList("kilo,kilo"), ["kilo"]);
  assert.throws(() => parseTargetList("vim"), /unknown target/);
  assert.throws(() => parseTargetList("   "), /--target requires opencode, kilo, or all/);
});

test("parseTargetChoice still rejects non-canonical and out-of-range answers", () => {
  assert.deepStrictEqual(parseTargetChoice("", ["opencode", "kilo"]), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetChoice("2", ["opencode", "kilo"]), ["kilo"]);
  assert.deepStrictEqual(parseTargetChoice("1,2", ["opencode", "kilo"]), ["opencode", "kilo"]);
  assert.deepStrictEqual(parseTargetChoice("2,1", ["opencode", "kilo"]), ["kilo", "opencode"]);
  assert.throws(() => parseTargetChoice("01", ["opencode", "kilo"]), /invalid selection/);
  assert.throws(() => parseTargetChoice("3", ["opencode", "kilo"]), /invalid selection/);
  assert.throws(() => parseTargetChoice("nope", ["opencode", "kilo"]), /invalid selection/);
  assert.throws(() => parseTargetChoice("1.5", ["opencode", "kilo"]), /invalid selection/);
  // A third argument changes only what Enter means.
  assert.deepStrictEqual(parseTargetChoice("", ["opencode", "kilo"], ["kilo"]), ["kilo"]);
  assert.deepStrictEqual(parseTargetChoice("all", ["opencode", "kilo"], ["kilo"]), ["opencode", "kilo"]);
});

// --- fail closed on unrecognized arguments ---

test("an unrecognized positional is rejected, naming the sibling command", () => {
  for (const command of ["init", "update", "remove", "status", "show"]) {
    assert.throws(
      () => assertKnownArgs(command, ["status"]),
      (error) => {
        assert.match(error.message, /^oc-go-usage-display: unexpected argument "status"/);
        assert.match(error.message, /oc-go-usage-display-init takes flags only|oc-go-usage-display-update takes flags only|oc-go-usage-display-remove takes flags only|oc-go-usage-display-status takes flags only|oc-go-usage-display-show takes flags only/);
        return true;
      },
      `${command} must reject a positional`,
    );
  }
  assert.throws(() => assertKnownArgs("init", ["status"]), /run "oc-go-usage-display-status" instead/);
  assert.throws(() => assertKnownArgs("init", ["--help-me"]), /run "oc-go-usage-display-help-me" instead|unexpected argument "--help-me"/);
  assert.throws(() => assertKnownArgs("init", ["bogus"]), /unexpected argument "bogus"/);
  assert.throws(() => assertKnownArgs("init", ["--", "status"]), /unexpected argument "--"/);
});

test("an unknown flag is rejected and lists the accepted flags", () => {
  assert.throws(() => assertKnownArgs("init", ["--targt", "kilo"]), /unexpected argument "--targt"/);
  assert.throws(() => assertKnownArgs("init", ["--targt", "kilo"]), /--target <opencode\|kilo\|all>/);
  assert.throws(() => assertKnownArgs("init", ["--copy=yes"]), /--copy takes no value/);
  assert.throws(() => assertKnownArgs("init", ["--target"]), /missing value for --target \(expected opencode\|kilo\|all\)/);
  assert.throws(() => assertKnownArgs("init", ["--target", "--copy"]), /missing value for --target/);
});

test("the flags the install flows use are all accepted", () => {
  assert.equal(assertKnownArgs("init", ["--repo", "/x", "--config-dir", "/y", "--kilo-config-dir", "/z"]).help, false);
  assert.equal(assertKnownArgs("init", ["--target", "all", "--copy"]).help, false);
  assert.equal(assertKnownArgs("init", ["--target=kilo"]).help, false);
  assert.equal(assertKnownArgs("init", ["--sidebar=0", "--statusline=1", "--symlink"]).help, false);
  assert.equal(assertKnownArgs("init", []).help, false);
  assert.equal(assertKnownArgs("init", ["--help"]).help, true);
  assert.equal(assertKnownArgs("init", ["-h"]).help, true);
  assert.equal(assertKnownArgs("show", ["--json", "--config-dir", "/y"]).help, false);
  assert.equal(assertKnownArgs("status", ["--repo", "/x"]).help, false);
  assert.equal(assertKnownArgs("remove", ["--target", "all"]).help, false);
  assert.throws(() => assertKnownArgs("show", ["--target", "kilo"]), /unexpected argument "--target"/);
  assert.throws(() => assertKnownArgs("remove", ["--json"]), /unexpected argument "--json"/);
});

test("usage text is generated from the accepted-argument table", () => {
  const usage = usageFor("init");
  for (const name of [...Object.keys(COMMAND_ARGS.init.values), ...COMMAND_ARGS.init.switches]) {
    assert.ok(usage.includes(name), `usage must mention ${name}`);
  }
  assert.match(usage, /^usage: oc-go-usage-display-init \[flags\]/);
  assert.match(usage, /--target <opencode\|kilo\|all>/);
  assert.ok(!usageFor("show").includes("--target"), "show does not accept --target");
});
