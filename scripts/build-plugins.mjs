// Bundle the deployed plugin entries as self-contained single files.
//
// src/index.ts      -> dist/plugins/oc-go-usage-display.ts       (server, ESM, node)
// src/index.ts      -> dist/plugins/oc-go-usage-display.kilo.ts  (server for Kilo:
//                      same source, host baked in so it reads Kilo's auth store)
// src/tui.tsx       -> dist/plugins/oc-go-usage-display.tsx      (TUI, ESM, solid JSX)
// src/tui.kilo.tsx  -> dist/plugins/oc-go-usage-display.kilo.tsx (TUI for Kilo Code, ESM, solid JSX)
// src/v2/index.ts   -> dist/plugins/oc-go-usage-display.v2.ts    (opencode v2 server)
// src/v2/tui.tsx    -> dist/plugins/oc-go-usage-display.v2.tui.ts (opencode v2 TUI)
//
// Both TUI bundles inline src/shared.ts, so the deployed output contains NO
// `from "./shared` import and no shared file needs to be installed. Host
// provided modules stay external:
//   - server: @opencode-ai/plugin (+ node builtins via platform node). Kilo
//             accepts the same module (the load e2e proves it), so the kilo
//             server bundle only differs by its baked host define.
//   - tui:    @opencode-ai/plugin(+/tui), solid-js, @opentui/solid (+ node builtins)
//   - kilo:   @kilocode/plugin(+/tui), solid-js, @opentui/solid (+ node builtins)
//   - v2:     @opencode/plugin(+/tui), solid-js, @opentui/solid (+ node builtins)
// Output keeps the .ts/.tsx filenames so the install layouts keep working; v2
// renames them to index.ts/tui.ts inside its discovered package directory. The
// content is plain ESM JavaScript, which is valid TypeScript and loads as before.
//
// The emitted bundle MUST have exactly one export and it MUST be the default
// `{ id, server | tui }` module. OpenCode's loader enumerates every export of
// a plugin entry and invokes each as a plugin factory when the default is not
// a module object; a stray named export (a helper returning null) crashed
// `Provider.list`. This check fails the build before that can ship.
//
// Each bundle carries a banner naming host + kind; scripts/verify-bundles.mjs
// checks that banner after the build.

import * as fs from "node:fs";
import * as esbuild from "esbuild";

const base = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  legalComments: "none",
};

// The banner is the deployed marker `scripts/verify-bundles.mjs` checks, so a
// missing/renamed output cannot slip through the build.
function bannerFor(host, kind) {
  return { js: `// oc-go-usage-display: ${host} ${kind} plugin bundle (self-contained)` };
}

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
const kiloTuiOut = "dist/plugins/oc-go-usage-display.kilo.tsx";
const tuiOut = "dist/plugins/oc-go-usage-display.tsx";
const kiloServerOut = "dist/plugins/oc-go-usage-display.kilo.ts";
const v2ServerOut = "dist/plugins/oc-go-usage-display.v2.ts";

await esbuild.build({
  ...base,
  banner: bannerFor("opencode", "server"),
  entryPoints: ["src/index.ts"],
  outfile: serverOut,
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*"],
  define: { "process.env.OC_GO_USAGE_HOST": JSON.stringify("opencode") },
});
assertSingleDefaultExport(serverOut);

await esbuild.build({
  ...base,
  banner: bannerFor("kilo", "server"),
  entryPoints: ["src/index.ts"],
  outfile: kiloServerOut,
  // Kilo provides its own `@kilocode/plugin` to plugins (it does NOT provide
  // `@opencode-ai/plugin`), so the server source's import is aliased to the
  // Kilo package and stays external. Verified by the kilo load e2e.
  alias: { "@opencode-ai/plugin": "@kilocode/plugin" },
  external: ["@kilocode/plugin", "@kilocode/plugin/*"],
  define: { "process.env.OC_GO_USAGE_HOST": JSON.stringify("kilo") },
});
assertSingleDefaultExport(kiloServerOut);

await esbuild.build({
  ...base,
  banner: bannerFor("opencode", "tui"),
  entryPoints: ["src/tui.tsx"],
  outfile: tuiOut,
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*", "solid-js", "@opentui/*"],
});
assertSingleDefaultExport(tuiOut);

await esbuild.build({
  ...base,
  banner: bannerFor("kilo", "tui"),
  entryPoints: ["src/tui.kilo.tsx"],
  outfile: kiloTuiOut,
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  external: ["@kilocode/plugin", "@kilocode/plugin/*", "solid-js", "@opentui/*"],
});
assertSingleDefaultExport(kiloTuiOut);

await esbuild.build({
  ...base,
  banner: bannerFor("opencode-v2", "server"),
  entryPoints: ["src/v2/index.ts"],
  outfile: v2ServerOut,
  external: ["@opencode/plugin", "@opencode/plugin/*"],
});
assertSingleDefaultExport(v2ServerOut);

const v2TuiOut = "dist/plugins/oc-go-usage-display.v2.tui.ts";
await esbuild.build({
  ...base,
  banner: bannerFor("opencode-v2", "tui"),
  entryPoints: ["src/v2/tui.tsx"],
  outfile: v2TuiOut,
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  external: ["@opencode/plugin", "@opencode/plugin/*", "solid-js", "@opentui/*"],
});
assertSingleDefaultExport(v2TuiOut);

console.log(
  "bundled dist/plugins/oc-go-usage-display.ts + .kilo.ts + .tsx + .kilo.tsx + .v2.ts + .v2.tui.ts (self-contained, default-only export)",
);
