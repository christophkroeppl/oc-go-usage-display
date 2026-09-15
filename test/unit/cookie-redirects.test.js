// Unit tier: `dist/index.js` cookie-scrape fetch wiring.
//
// The redirect helpers are covered by redirect.test.js; this suite proves the
// compiled server actually uses them: the scrape fetch must request
// `redirect: "manual"` and re-issue the request (Cookie included) only for
// allowlisted HTTPS hosts, stop after MAX_REDIRECT_HOPS, and never contact a
// cross-origin Location at all. It also pins the fetch-timeout scope: the 10s
// abort must cover the body read, not just the response headers.
//
// Hermeticity mirrors fail-safe.test.js: HOME/XDG roots are redirected into a
// tmp dir and a stubbed global fetch replaces the network. The auth cookie
// used here is a literal dummy value.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

// Captured before any test enables mock timers so test-side waits stay real.
const REAL_SET_TIMEOUT = globalThis.setTimeout;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-cookie-"));
process.env.HOME = path.join(ROOT, "home");
process.env.XDG_CONFIG_HOME = path.join(ROOT, "xdg-config");
process.env.XDG_DATA_HOME = path.join(ROOT, "xdg-data");
process.env.XDG_STATE_HOME = path.join(ROOT, "xdg-state");
process.env.XDG_CACHE_HOME = path.join(ROOT, "xdg-cache");
process.env.OPENCODE_CONFIG_DIR = path.join(ROOT, "config");
process.env.OPENCODE_GO_WORKSPACE_ID = "ws_test";
process.env.OPENCODE_GO_AUTH_COOKIE = "test-cookie";
delete process.env.OPENCODE_GO_MOCK;
delete process.env.OPENCODE_GO_API_KEY;

for (const dir of ["home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache", "config"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const WORKSPACE_URL = "https://opencode.ai/workspace/ws_test/go";

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function htmlResponse(html) {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

function parseSnapshot(output) {
  return JSON.parse(String(output).split("\n").slice(1).join("\n"));
}

// Await `promise`, failing the test (instead of hanging CI) after 3s. `null`
// is the timeout sentinel; no tool output or readiness signal is ever null.
async function settleWithin(promise, label) {
  const output = await Promise.race([
    promise,
    new Promise((resolve) => REAL_SET_TIMEOUT(() => resolve(null), 3000)),
  ]);
  assert.notEqual(output, null, label);
  return output;
}

// Drive the real `go_usage` tool with a scripted fetch, returning the recorded
// requests (url/redirect mode/cookie) and the parsed snapshot.
//
// Every scenario below ends in an unavailable snapshot on purpose: successful
// snapshots are cached for 60s (memory + disk), which would make later
// scenarios observe a cached result instead of exercising the fetch loop.
async function runTool(handler) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      redirect: init.redirect,
      cookie: new Headers(init.headers).get("cookie"),
    });
    return handler(String(url), calls.length);
  };
  try {
    const { default: serverModule } = await import("../../dist/index.js");
    const hooks = await serverModule.server({}, undefined);
    const output = await hooks.tool.go_usage.execute({}, undefined);
    return { calls, snapshot: parseSnapshot(output) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("cookie scrape requests manual redirects and follows a relative Location", async () => {
  const { calls, snapshot } = await runTool((url, call) => {
    if (call === 1) return redirectResponse("/workspace/ws_test/go/usage");
    assert.equal(url, "https://opencode.ai/workspace/ws_test/go/usage");
    return htmlResponse("<html>no usage markup here</html>");
  });

  assert.equal(snapshot.source, "unavailable");
  assert.equal(snapshot.apiError, "usage markup not recognized");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.redirect, "manual");
    assert.equal(call.cookie, "auth=test-cookie");
  }
  assert.equal(calls[1].url, "https://opencode.ai/workspace/ws_test/go/usage");
});

test("cookie scrape stops before contacting a cross-origin Location", async () => {
  const { calls, snapshot } = await runTool(() =>
    redirectResponse("https://evil.example/steal"),
  );

  assert.equal(calls.length, 1, "the blocked host must never be contacted");
  assert.equal(calls[0].url, WORKSPACE_URL);
  assert.equal(snapshot.source, "unavailable");
  assert.match(snapshot.apiError, /redirect blocked/);
  assert.match(snapshot.apiError, /evil\.example/);
});

test("cookie scrape re-sends the cookie to an allowlisted auth host", async () => {
  const { calls, snapshot } = await runTool((_url, call) => {
    if (call === 1) return redirectResponse("https://auth.opencode.ai/login");
    return htmlResponse("<title>OpenAuth</title>");
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://auth.opencode.ai/login");
  assert.equal(calls[1].cookie, "auth=test-cookie");
  assert.equal(snapshot.source, "unavailable");
  assert.equal(snapshot.apiError, "login expired (refresh auth cookie)");
});

test("cookie scrape stops after the hop limit without leaking the cookie", async () => {
  const { calls, snapshot } = await runTool(() =>
    redirectResponse("https://opencode.ai/workspace/ws_test/next"),
  );

  // Initial request + 3 approved hops, then the 4th redirect is refused.
  assert.equal(calls.length, 4);
  assert.equal(snapshot.source, "unavailable");
  assert.match(snapshot.apiError, /too many redirects/);
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, "opencode.ai");
    assert.equal(call.cookie, "auth=test-cookie");
  }
});

// 303/307/308 must go through the same manual-redirect policy as 301/302.
for (const status of [303, 307, 308]) {
  test(`cookie scrape blocks a cross-origin ${status} Location`, async () => {
    const { calls, snapshot } = await runTool(() =>
      redirectResponse("https://evil.example/steal", status),
    );

    assert.equal(calls.length, 1, "the blocked host must never be contacted");
    assert.equal(calls[0].url, WORKSPACE_URL);
    assert.equal(snapshot.source, "unavailable");
    assert.match(snapshot.apiError, /redirect blocked/);
    assert.match(snapshot.apiError, /evil\.example/);
  });
}

test("cookie scrape reports a redirect without a Location header", async () => {
  const { calls, snapshot } = await runTool(() => new Response(null, { status: 302 }));

  assert.equal(calls.length, 1, "no hop may be attempted without a Location");
  assert.equal(calls[0].url, WORKSPACE_URL);
  assert.equal(snapshot.source, "unavailable");
  assert.equal(snapshot.apiError, "redirect without a Location header");
});

test("cookie scrape treats a whitespace-only Location header as missing", async () => {
  const { calls, snapshot } = await runTool(
    () => new Response(null, { status: 307, headers: { location: "  " } }),
  );

  assert.equal(calls.length, 1);
  assert.equal(snapshot.source, "unavailable");
  assert.equal(snapshot.apiError, "redirect without a Location header");
});

// Start a local server that sends a 200 head plus a partial body and then
// stalls forever. `run(requestSeen)` drives the tool against it; the stub fetch
// forwards to the server and hands over the real abort signal, so
// `mock.timers.tick(10_000)` tears down the stalled connection mid-body.
async function withStalledBody(run) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<html>partial body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const originalFetch = globalThis.fetch;
  // Resolves once the server saw the request; the real 100ms delay lets the
  // client receive the head and begin the body read before the mocked timer is
  // advanced, so the abort lands mid-body rather than mid-handshake.
  const requestSeen = new Promise((resolve) => {
    server.once("request", () => REAL_SET_TIMEOUT(resolve, 100));
  });
  globalThis.fetch = (url, init = {}) => originalFetch(`http://127.0.0.1:${port}/stall`, init);
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    await run(requestSeen);
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runStalledScrape() {
  const { default: serverModule } = await import("../../dist/index.js");
  const hooks = await serverModule.server({}, undefined);
  return hooks.tool.go_usage.execute({}, undefined);
}

async function assertStalledBodyAborts(requestSeen) {
  const pending = runStalledScrape();
  await settleWithin(requestSeen, "the scrape must reach the local stub server");
  mock.timers.tick(10_000);
  const output = await settleWithin(pending, "the stalled body must be aborted, not left hanging");
  const snapshot = parseSnapshot(output);
  assert.equal(snapshot.source, "unavailable");
  assert.equal(snapshot.apiError, "request failed");
}

test("cookie scrape aborts a body that stalls after the headers", async () => {
  await withStalledBody(assertStalledBodyAborts);
});

test("API-key fetch aborts a body that stalls after the headers", async () => {
  process.env.OPENCODE_GO_API_KEY = "test-key";
  try {
    await withStalledBody(assertStalledBodyAborts);
  } finally {
    delete process.env.OPENCODE_GO_API_KEY;
  }
});
