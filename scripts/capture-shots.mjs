// Capture the real Go usage block from BOTH hosts, for the README screenshots.
//
//   docker compose run --rm -v "$PWD/tmp:/out" test bun scripts/capture-shots.mjs
//
// Writes `<out>/<host>.ansi` (the tmux pane with SGR colors intact) and
// `<out>/<host>.txt` (plain text) per host. Render them with any ANSI-to-image
// tool; the `.txt` one is only there to read what was on screen.
//
// The point is that these are not mockups: this boots the pinned opencode and
// kilo binaries in a real tmux session with the built plugin bundle, exactly like
// the display e2e does. Nothing leaves the container and no Go subscription is
// touched -- the plan comes from `OPENCODE_OC_GO_MOCK=1`.
//
// The session carries a `noReply` message, so it has no assistant messages and
// the model section shows its empty state. A session with real usage would need
// a real provider call (or a fake one driving a real session), which is why the
// screenshots show the plan, not a ranking.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findKiloBinary } from "../test/helpers/kilo.js";
import { findOpencodeBinary } from "../test/helpers/opencode.js";
import { makeConfigDir } from "../test/helpers/tmp.js";
import {
  TuiSession,
  listProviderModels,
  makeTuiEnv,
  pickProviderModel,
  startHostServer,
  writeTuiHostConfig,
} from "../test/helpers/tui.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.SHOT_DIR ?? "/out";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Two models with a deliberately lopsided split, so a screenshot shows a ranking
// rather than three equal bars.
const USAGE_BY_MODEL = {
  "mimo-v2.6-pro": { prompt_tokens: 1_420_000, completion_tokens: 88_000, total_tokens: 1_508_000 },
  "qwen3-max": { prompt_tokens: 610_000, completion_tokens: 41_000, total_tokens: 651_000 },
  "gpt-5.1": { prompt_tokens: 280_000, completion_tokens: 19_000, total_tokens: 299_000 },
};

async function capture({ host, binary, sidebarMode }) {
  const tmp = makeConfigDir();
  try {
    const env = makeTuiEnv({ root: tmp.root, live: false, host });
    if (sidebarMode !== undefined) env.KILO_OC_GO_SIDEBAR_MODE = sidebarMode;
    const models = listProviderModels(binary, "opencode-go", { env, cwd: REPO_DIR });
    const model = pickProviderModel(models);
    if (model === null) throw new Error(`no opencode-go model in the catalog: ${JSON.stringify(models)}`);

    writeTuiHostConfig({ host, repoDir: REPO_DIR, env, model });
    const server = await startHostServer({ binary, env, cwd: REPO_DIR });
    let sessionId;
    try {
      const created = await fetch(`${server.url}/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": REPO_DIR },
        body: JSON.stringify({ title: `shot-${host}` }),
      });
      const createdSession = await created.json();
      sessionId = createdSession.id;
      await fetch(`${server.url}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": REPO_DIR },
        body: JSON.stringify({
          model: { providerID: "opencode-go", modelID: String(model).split("/").slice(1).join("/") },
          noReply: true,
          parts: [{ type: "text", text: "usage display probe" }],
        }),
      });
    } finally {
      server.stop();
    }

    const tui = new TuiSession({
      binary,
      args: ["--session", sessionId],
      env,
      cwd: REPO_DIR,
      label: `shot-${host}-${process.pid}`,
    });
    try {
      tui.start();
      // Wait for the block to settle rather than sleeping a fixed amount: the
      // sidebar renders asynchronously and a shot of a loading block is useless.
      const deadline = Date.now() + 150000;
      let screen = "";
      while (Date.now() < deadline) {
        screen = tui.capture();
        if (/Go Usage[\s\S]*Go \d/.test(screen) && !/Go loading/.test(screen)) break;
        await sleep(1000);
      }
      const ansi = tui.captureAnsi();
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${host}.ansi`), ansi);
      fs.writeFileSync(path.join(OUT_DIR, `${host}.txt`), screen);
      console.log(`[shots] ${host}: captured (model ${model}, session ${sessionId})`);
    } finally {
      tui.stop();
    }
  } finally {
    tmp.cleanup();
  }
}

await capture({
  host: "opencode",
  binary: findOpencodeBinary(),
});

await capture({
  host: "kilo",
  binary: findKiloBinary(),
  // Integrated mode is Kilo's richest view: it retires the host's own token
  // panel and renders Go Usage / Session Tokens / Models in its place.
  sidebarMode: "integrated",
});

console.log(`[shots] wrote ${OUT_DIR}/<host>.{ansi,txt}`);
