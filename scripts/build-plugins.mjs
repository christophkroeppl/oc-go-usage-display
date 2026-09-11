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

import * as esbuild from "esbuild";

const base = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  legalComments: "none",
};

await esbuild.build({
  ...base,
  entryPoints: ["src/index.ts"],
  outfile: "dist/plugins/oc-go-usage-display.ts",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*"],
});

await esbuild.build({
  ...base,
  entryPoints: ["src/tui.tsx"],
  outfile: "dist/plugins/oc-go-usage-display.tsx",
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/*", "solid-js", "@opentui/*"],
});

console.log("bundled dist/plugins/oc-go-usage-display.ts + .tsx (self-contained, no ./shared import)");
