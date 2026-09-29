#!/usr/bin/env node
// Unit-tier purity guard.
//
// The unit tier runs on the host and must be strictly readonly: no filesystem
// writes (not even tmp), no child processes, no sockets. Only the pure helper
// modules and a small set of node builtins are allowed. Everything that needs
// real files/processes/network state belongs to the Dockerized integration and
// e2e tiers.
//
// The check is intentionally static and dependency-free: it parses import
// specifiers and flags write-ish/process-ish identifiers. `fetch` is allowed
// (the live usage test reads the API without persisting anything).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIT_DIR = path.join(REPO_DIR, "test", "unit");

const ALLOWED_IMPORTS = new Set([
  "node:test",
  "node:assert",
  "node:assert/strict",
  "node:path",
  "../../dist/helpers.js",
  "../../dist/shared.js",
]);

const FORBIDDEN_PATTERNS = [
  [/\brequire\s*\(/, "CommonJS require"],
  [/\bmkdtemp(Sync)?\b/, "tmp directory creation"],
  [/\b(writeFile|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|chmod|chown|symlink|rename|copyFile|truncate)(Sync|Promise)?\s*\(/, "filesystem mutation"],
  [/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/, "child process"],
  [/\b(createServer|listen)\s*\(/, "socket"],
  [/\bprocess\.env\.\w+\s*=|delete\s+process\.env\./, "process environment mutation"],
];

function importsOf(source) {
  const specifiers = [];
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const files = fs.existsSync(UNIT_DIR)
  ? fs.readdirSync(UNIT_DIR).filter((name) => name.endsWith(".test.js")).sort()
  : [];
const violations = [];

for (const name of files) {
  const file = path.join(UNIT_DIR, name);
  const source = fs.readFileSync(file, "utf8");
  for (const specifier of importsOf(source)) {
    if (!ALLOWED_IMPORTS.has(specifier)) {
      violations.push(`${name}: import "${specifier}" is not allowed in the unit tier`);
    }
  }
  for (const [pattern, label] of FORBIDDEN_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of source.matchAll(global)) {
      violations.push(`${name}:${lineOf(source, match.index)} forbidden ${label}: ${match[0].trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error("unit purity check failed:");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nThe unit tier must be readonly (no fs writes, no tmp, no child processes). " +
      "Move stateful tests into test/integration (Docker tier).",
  );
  process.exit(1);
}

console.log(`unit purity check passed (${files.length} file(s), readonly)`);
