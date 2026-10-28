// Integration tier: TUI credential resolution.
//
// opencode v2 keeps credentials in the host database instead of auth.json and
// hands them to the plugin through `UsagePanelApi.credential.read`. This suite
// pins the resulting order -- env, host store, auth.json -- and the rejection
// reason the panel prints when the API answers 401/403.
//
// No network: `fetch` is stubbed, so the assertions are about which key the
// store sends and what it renders from the answer.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-usage-display-cred-"));
const ENV = {
  HOME: path.join(ROOT, "home"),
  XDG_CONFIG_HOME: path.join(ROOT, "xdg-config"),
  XDG_DATA_HOME: path.join(ROOT, "xdg-data"),
};
for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
for (const prefix of ["OPENCODE_OC_GO_", "KILO_OC_GO_", "OPENCODE_GO_"]) {
  for (const suffix of ["API_KEY", "MOCK", "MOCK_PERCENTS", "MOCK_RESETS", "MOCK_LIMITED"]) {
    delete process.env[`${prefix}${suffix}`];
  }
}
for (const dir of Object.values(ENV)) fs.mkdirSync(dir, { recursive: true });
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const authPath = path.join(ENV.XDG_DATA_HOME, "opencode", "auth.json");
fs.mkdirSync(path.dirname(authPath), { recursive: true });
fs.writeFileSync(
  authPath,
  `${JSON.stringify({ "opencode-go": { type: "api", key: "stale-auth-json-key" } })}\n`,
  "utf8",
);

const { createUsageStore } = await import("../../dist/tui-shared.js");

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

function usagePayload() {
  return {
    usage: {
      rolling: { status: "ok", percent: 42, resetsAt: "2026-10-27T16:35:08.000Z" },
      weekly: { status: "ok", percent: 15, resetsAt: "2026-11-02T00:00:00.000Z" },
      monthly: { status: "ok", percent: 61, resetsAt: "2026-11-08T17:25:34.000Z" },
    },
  };
}

function panelApi(credential) {
  const api = {
    kv: {
      get: (_key, fallback) => fallback,
      set: () => {},
    },
    client: { app: { log: async () => undefined } },
  };
  if (credential !== undefined) api.credential = credential;
  return api;
}

async function requestWith(fetchImpl, api) {
  const seen = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, authorization: init?.headers?.Authorization });
    return fetchImpl();
  };
  try {
    const store = createUsageStore(api, "opencode");
    await store.refresh();
    return { snapshot: store.snapshot(), seen };
  } finally {
    globalThis.fetch = saved;
  }
}

const okResponse = () => new Response(JSON.stringify(usagePayload()), { status: 200 });

test("the host credential wins over a stale auth.json", async () => {
  const { snapshot, seen } = await requestWith(okResponse, panelApi({ read: async () => "live-host-key" }));
  assert.deepEqual(seen, [{ url: USAGE_URL, authorization: "Bearer live-host-key" }]);
  assert.equal(snapshot?.rolling?.percent, 42);
  assert.equal(snapshot?.weekly?.percent, 15);
  assert.equal(snapshot?.monthly?.percent, 61);
});

test("a null, blank, or throwing host resolver falls back to auth.json", async () => {
  const cases = [
    { read: async () => null },
    { read: async () => "   " },
    {
      read: async () => {
        throw new Error("host store unavailable");
      },
    },
  ];
  for (const credential of cases) {
    const { seen } = await requestWith(okResponse, panelApi(credential));
    assert.deepEqual(seen, [{ url: USAGE_URL, authorization: "Bearer stale-auth-json-key" }]);
  }
});

test("a host without the credential surface still reads auth.json", async () => {
  const { seen } = await requestWith(okResponse, panelApi(undefined));
  assert.deepEqual(seen, [{ url: USAGE_URL, authorization: "Bearer stale-auth-json-key" }]);
});

test("an expired key surfaces the API's reason instead of a bare 401", async () => {
  const body = { error: { type: "authentication_error", code: "api_key_expired" } };
  const { snapshot } = await requestWith(
    () => new Response(JSON.stringify(body), { status: 401 }),
    panelApi({ read: async () => "expired-key" }),
  );
  assert.equal(snapshot?.source, "unavailable");
  assert.equal(snapshot?.apiUnavailable, true);
  assert.equal(snapshot?.apiError, "API key expired (create a new key in OpenCode Console)");
});

test("a rejection without a recognizable code keeps the generic reason", async () => {
  const { snapshot } = await requestWith(
    () => new Response("<html>forbidden</html>", { status: 403 }),
    panelApi({ read: async () => "rejected-key" }),
  );
  assert.equal(snapshot?.apiError, "API key rejected (401/403)");
});
