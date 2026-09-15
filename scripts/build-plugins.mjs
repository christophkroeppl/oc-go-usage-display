// Bundle the deployed plugin entries as self-contained single files.
//
// src/index.ts -> dist/plugins/oc-go-usage-display.ts (server, ESM, node)
// src/tui.tsx  -> dist/plugins/oc-go-usage-display.tsx (TUI, ESM, solid JSX)
//
// Both bundles inline src/shared.ts, so the deployed output contains NO
// `from "./shared` import and exactly two files are installed (no shared
// file). Host-provided modules stay external:
//   - server: @opencode-ai/plugin (+ node builtins via platform node)
//   - tui:    @opencode-ai/plugin(+/tui), solid-js, @opentui/solid (+ node builtins)
// Output keeps the .ts/.tsx filenames so SERVER_PLUGIN_REL/TUI_PLUGIN_REL
// (./plugins/oc-go-usage-display.{ts,tsx}) keep working; the content is
// plain ESM JavaScript, which is valid TypeScript and loads as before.
//
// The emitted bundle MUST have exactly one export and it MUST be the default
// `{ id, server | tui }` module. OpenCode's loader enumerates every export of
// a plugin entry and invokes each as a plugin factory when the default is not
// a module object; a stray named export (a helper returning null) crashed
// `Provider.list`. This check fails the build before that can ship.

import * as fs from "node:fs";
import * as esbuild from "esbuild";

const base = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  legalComments: "none",
};

// Parse the trailing `export { ... }` / `export default ...` block(s) and
// require the single export to alias `default`. Bare `export function|const|
// class|let|var` declarations are rejected outright: the loader would invoke
// them as plugin factories even though they never appear in an export block.
function assertSingleDefaultExport(outfile) {
  const source = fs.readFileSync(outfile, "utf8");

  const bareDeclarations = [
    ...source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|class|let|var)\b/gm),
  ];
  if (bareDeclarations.length > 0) {
    const names = bareDeclarations.map((match) => match[0].trim()).join(", ");
    throw new Error(`${outfile}: bare export declaration(s) not allowed (${names}); only the default export is allowed`);
  }

  const exportBlocks = [...source.matchAll(/export\s*\{([^}]*)\}\s*;?/g)];
  const entries = exportBlocks.flatMap((match) =>
    match[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  const defaultStatements = [...source.matchAll(/export\s+default\b/g)];
  const total = entries.length + defaultStatements.length;

  if (total !== 1) {
    throw new Error(`${outfile}: expected exactly one export, found ${total}`);
  }
  const singleIsDefault =
    defaultStatements.length === 1 || /(?:^|\s)as\s+default$/.test(entries[0] ?? "");
  if (!singleIsDefault) {
    throw new Error(`${outfile}: the single export must be the default export (found "${entries[0]}")`);
  }
}

const serverOut = "dist/plugins/oc-go-usage-display.ts";
const tuiOut = "dist/plugins/oc-go-usage-display.tsx";

await esbuild.build({
  ...base,
  entryPoints: ["src/index.ts"],
  outfile: serverOut,
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*"],
});
assertSingleDefaultExport(serverOut);

await esbuild.build({
  ...base,
  entryPoints: ["src/tui.tsx"],
  outfile: tuiOut,
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*", "solid-js", "@opentui/*"],
});
assertSingleDefaultExport(tuiOut);

console.log(
  "bundled dist/plugins/oc-go-usage-display.ts + .tsx (self-contained, default-only export)",
);
