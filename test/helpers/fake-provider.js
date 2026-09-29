// A host-level mock provider for the display tests: real assistant messages,
// zero tokens spent.
//
// The plan readout is already mocked (`OPENCODE_OC_GO_MOCK=1`), so the display
// tests cost nothing. The per-model MIX is not: it is a fold over the host's own
// message store, so a row can only be asserted if the session actually holds
// assistant messages -- and a session gets those only by talking to a provider.
// A real provider means a real key, so a test points the REAL `opencode-go`
// provider id at a local endpoint instead.
//
// The host selects it exactly as it would the real one (verified against the
// pinned binary: `llm.runtime=ai-sdk llm.provider=opencode-go`), asks it for
// `stream_options: {include_usage: true}`, and writes the assistant message --
// tokens, cost and model id -- into its own store. Nothing leaves the container.
//
// The endpoint speaks the OpenAI chat-completions SSE dialect, because that is
// what the host's AI SDK speaks. Usage is keyed by the requested model, so one
// session can hold several models with different weights; a request the fake
// does not know about answers with a hard failure rather than a silent zero,
// since a zero-token session would render a row that proves nothing.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const FAKE_CHAT_PATH = "/v1/chat/completions";

export async function startFakeChatProvider({ usageByModel, host = "127.0.0.1" }) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        // Handled below as an unknown model.
      }
      const model = typeof payload.model === "string" ? payload.model : null;
      const usage = model === null ? undefined : usageByModel[model];
      requests.push({ url: req.url, model, stream: payload.stream === true });
      if (req.url !== FAKE_CHAT_PATH || usage === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: `fake provider: no usage configured for ${req.url} ${model}` } }),
        );
        return;
      }
      const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        chunk({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        }),
      );
      res.write(
        chunk({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  if (port === null) throw new Error("fake chat provider did not report a port");
  return {
    port,
    requests,
    // The `provider` block the host config needs, already keyed by provider id
    // (the wrapper is part of the config shape, and a flattened entry is
    // rejected as "Expected ProviderConfig, got ... provider.npm"). The id
    // stays `opencode-go` because that is what the plugin's Go gate keys on;
    // only the endpoint is ours.
    configFor: (providerID) => ({
      [providerID]: {
        npm: "@ai-sdk/openai-compatible",
        name: providerID,
        options: { baseURL: `http://${host}:${port}/v1`, apiKey: "fake-key" },
        models: Object.fromEntries(Object.keys(usageByModel).map((model) => [model, { name: model }])),
      },
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// One headless turn against the fake provider. The host resolves the provider,
// streams the reply and persists the assistant message, which is the only way to
// give a session real token accounting. Returns the session id (from the
// `--format json` event stream) so a caller can continue the same session with a
// second model.
//
// Spawned, not spawnedSync: `<host> run` with a piped stdin hangs in bun's
// synchronous spawn (it produced no output at all and had to be killed), while
// the same call under `spawn` with an ignored stdin returns normally. This
// mirrors `startHostServer`, which drives the other host process the same way.
export function runHeadlessPrompt({ binary, env, cwd, message, model, sessionId, timeoutMs = 180000 }) {
  const args = ["run", message, "--model", model, "--format", "json"];
  if (sessionId !== undefined) args.push("--session", sessionId);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} run did not finish within ${timeoutMs}ms\n${output.slice(-2000)}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${binary} run failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const id = /"sessionID":"([^"]+)"/.exec(output)?.[1];
      if (id === undefined) {
        reject(new Error(`${binary} run produced no session id (exit ${code})\n${output.slice(-2000)}`));
        return;
      }
      resolve({ sessionId: id, exit: code, output });
    });
  });
}
