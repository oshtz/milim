import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const requests = [];
const server = await createServer({
  root,
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});

globalThis.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith("/v1/models")) throw new Error("provider list unavailable");
  if (url.endsWith("/codex/account")) {
    return Response.json({
      requiresOpenaiAuth: false,
      account: { type: "chatgpt" },
    });
  }
  if (url.endsWith("/codex/models")) {
    return Response.json({
      data: [{ model: "gpt-test", inputModalities: ["text"] }],
    });
  }
  if (url.endsWith("/claude/status")) {
    return Response.json({
      available: true,
      authenticated: true,
      models: ["sonnet"],
    });
  }
  return new Response("not found", { status: 404 });
};

try {
  const { listModelsDetailed } = await server.ssrLoadModule("/src/api.ts");
  const models = await listModelsDetailed();

  assert.deepEqual(
    models.map((model) => model.id),
    ["codex:gpt-test", "claude:sonnet"],
  );
  assert(requests.some((url) => url.endsWith("/v1/models")));
  assert(requests.some((url) => url.endsWith("/codex/models")));
  assert(requests.some((url) => url.endsWith("/claude/status")));
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
