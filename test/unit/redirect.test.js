// Unit tier: `dist/helpers.js` redirect policy for the cookie scrape.
//
// Automatic redirect following may re-send caller headers (including the auth
// Cookie) to a cross-origin Location, and runtime header stripping cannot be
// relied on, so the cookie path follows redirects manually and delegates each
// hop decision to these pure helpers. The tests pin the allowlist,
// relative-resolution, and hop-limit behavior.
//
// Requires a prior `npm run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REDIRECT_HOPS,
  isAllowedRedirect,
  resolveAllowedRedirect,
} from "../../dist/helpers.js";

const WORKSPACE_URL = "https://opencode.ai/workspace/ws_123/go";

// --- isAllowedRedirect ---

test("isAllowedRedirect accepts same-host relative and absolute targets", () => {
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "/auth"), true);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "login?next=%2Fgo"), true);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://opencode.ai/workspace/other/go"), true);
  // Protocol-relative Locations inherit the https scheme and stay same-origin.
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "//opencode.ai/workspace/other/go"), true);
  assert.equal(
    isAllowedRedirect(WORKSPACE_URL, "https://auth.opencode.ai/login?return=opencode.ai"),
    true,
  );
  assert.equal(isAllowedRedirect("https://auth.opencode.ai/login", "https://opencode.ai/"), true);
});

test("isAllowedRedirect rejects cross-origin and lookalike hosts", () => {
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://evil.example/steal"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "//evil.example/steal"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://opencode.ai.evil.example/"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://evilopencode.ai/"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://auth.opencode.ai.evil.example/"), false);
});

test("isAllowedRedirect rejects non-https targets and non-https origins", () => {
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "http://opencode.ai/workspace/x/go"), false);
  assert.equal(isAllowedRedirect("http://opencode.ai/workspace/ws_123/go", "/auth"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "javascript:alert(1)"), false);
  assert.equal(isAllowedRedirect("not a url", "/auth"), false);
});

test("isAllowedRedirect rejects explicit ports and userinfo", () => {
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://opencode.ai:8443/"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://user:pass@opencode.ai/"), false);
  assert.equal(isAllowedRedirect(WORKSPACE_URL, "https://user@auth.opencode.ai/"), false);
});

// --- resolveAllowedRedirect ---

test("resolveAllowedRedirect follows an allowed hop with the absolute URL", () => {
  const relative = resolveAllowedRedirect(WORKSPACE_URL, "/login", 0);
  assert.deepStrictEqual(relative, { follow: true, url: "https://opencode.ai/login" });

  const crossHost = resolveAllowedRedirect(WORKSPACE_URL, "https://auth.opencode.ai/login", 1);
  assert.deepStrictEqual(crossHost, { follow: true, url: "https://auth.opencode.ai/login" });
});

test("resolveAllowedRedirect stops on a cross-origin target with a clear reason", () => {
  const decision = resolveAllowedRedirect(WORKSPACE_URL, "https://evil.example/steal", 0);
  assert.equal(decision.follow, false);
  assert.match(decision.reason, /redirect blocked/);
  assert.match(decision.reason, /evil\.example/);
});

test("resolveAllowedRedirect stops on a missing Location header", () => {
  const decision = resolveAllowedRedirect(WORKSPACE_URL, null, 0);
  assert.equal(decision.follow, false);
  assert.match(decision.reason, /Location/);
});

test("resolveAllowedRedirect follows at most MAX_REDIRECT_HOPS hops", () => {
  for (let hops = 0; hops < MAX_REDIRECT_HOPS; hops += 1) {
    const decision = resolveAllowedRedirect(WORKSPACE_URL, "/next", hops);
    assert.equal(decision.follow, true, `hop ${hops} should follow`);
  }
  const exhausted = resolveAllowedRedirect(WORKSPACE_URL, "/next", MAX_REDIRECT_HOPS);
  assert.equal(exhausted.follow, false);
  assert.match(exhausted.reason, /too many redirects/);
});

test("resolveAllowedRedirect never throws on hostile-looking input", () => {
  const blocked = [
    "", // no header value
    "  ", // whitespace-only
    "https://", // unparseable
    "http://opencode.ai/workspace/x/go", // non-https
    "//evil.example/steal", // protocol-relative cross-origin
    "javascript:alert(1)", // non-https scheme
    "data:text/html,<script>", // non-https scheme
    "https://opencode.ai\n.evil", // newline-smuggled lookalike host
  ];
  for (const location of blocked) {
    const decision = resolveAllowedRedirect(WORKSPACE_URL, location, 0);
    assert.equal(decision.follow, false, `location ${JSON.stringify(location)} must not follow`);
    assert.equal(typeof decision.reason, "string");
  }
  assert.equal(resolveAllowedRedirect("", "/auth", 0).follow, false);
});
