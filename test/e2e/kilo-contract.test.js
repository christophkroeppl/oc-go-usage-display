// E2E tier (container-only): pin the Kilo host contract this plugin depends on.
//
// `kilocode.sessionModelUsage` is a host-owned endpoint we cannot influence, and
// its response can change in a Kilo release without breaking our build: a
// renamed field yields `undefined` rather than an error, so a per-model column
// empties itself silently.
//
// So assert it against the pinned Kilo in the image. This runs on the weekly
// schedule as well as every `main` push, so drift lands in CI naming the
// endpoint instead of surfacing as a column of `undefined`.
//
// The other two host-owned assumptions are covered where they are cheapest: the
// `sidebar_content` order ladder needs no host and is asserted in the readonly
// unit tier (every push, not just the schedule), and the `Token Usage` row
// labels are asserted on the screen tui-display.kilo already captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inTestContainer } from "../helpers/run.js";
import { findKiloBinary, KILO_LOAD_ENV, startKiloServer } from "../helpers/kilo.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KILO_BINARY = findKiloBinary();
const SKIP = !inTestContainer()
  ? "container-only: run `bun run test:docker`"
  : KILO_BINARY
    ? false
    : "kilo binary not found on PATH (broken container image)";

test("kilo sessionModelUsage keeps the fields the per-model panel reads", { skip: SKIP, timeout: 180000 }, async (t) => {
  const env = { ...process.env, ...KILO_LOAD_ENV };
  const server = await startKiloServer({ binary: KILO_BINARY, cwd: REPO_DIR, env });
  t.after(() => server.stop());

  const headers = { "content-type": "application/json", "x-opencode-directory": REPO_DIR };
  const created = await fetch(`${server.url}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "kilo-contract" }),
  });
  assert.ok(created.ok, `session create failed: HTTP ${created.status}`);
  const { id: sessionId } = await created.json();

  // The route is `/session/:sessionID/model-usage` -- a PATH param, not a query
  // one. `@kilocode/sdk`'s generated types advertise
  // `/kilocode/sessionModelUsage`, which 404s, so the runtime path is asserted
  // here rather than trusted from the SDK. Note `/session/model-usage` also
  // looks right but collides with `/session/:id` and 500s in the id validator.
  const response = await fetch(`${server.url}/session/${encodeURIComponent(sessionId)}/model-usage`, {
    headers,
  });
  assert.equal(response.status, 200, `model-usage must stay routable (got HTTP ${response.status})`);
  const payload = await response.json();

  assert.ok(Array.isArray(payload.sessionIDs), "sessionIDs must stay an array");
  assert.ok(payload.sessionIDs.includes(sessionId), "sessionIDs must include the queried session");
  assert.ok(payload.totals && typeof payload.totals === "object", "totals must stay an object");
  assert.ok(Array.isArray(payload.models), "models must stay an array");
  for (const field of ["steps", "cost", "tokens"]) {
    assert.ok(field in payload.totals, `totals lost "${field}"`);
  }
  for (const field of ["input", "output", "reasoning", "cache"]) {
    assert.ok(field in payload.totals.tokens, `totals.tokens lost "${field}"`);
  }
  for (const field of ["read", "write"]) {
    assert.ok(field in payload.totals.tokens.cache, `totals.tokens.cache lost "${field}"`);
  }
  // The per-model split is the entire reason we call this endpoint; assert the
  // entry shape whenever the session happens to have produced a model row.
  for (const model of payload.models) {
    for (const field of ["providerID", "modelID", "steps", "cost", "tokens"]) {
      assert.ok(field in model, `models[] lost "${field}"`);
    }
  }
  // Only the consumed subset is asserted. This endpoint already drifts between
  // host versions -- `sessionCost` exists in kilo 7.8.x and is absent in the
  // 7.7.5 the image pins -- and the panel reads `totals` and `models` only, so a
  // field we do not consume must not be able to fail this gate.
  console.log(`[e2e] kilo sessionModelUsage shape ok (models: ${payload.models.length})`);
});
